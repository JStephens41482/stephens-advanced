// /api/riker-core.js
// The brain. One function — processMessage — that every surface (HTTP
// /api/riker, Twilio inbound, Gmail poller, cron proactive jobs) calls.
//
// Flow:
//   1. Resolve session (load existing or create new)
//   2. Read relevant notebook memories
//   3. Build live-data block (calendar, available slots, jobs, rate card)
//   4. Assemble system prompt
//   5. Call Claude
//   6. Parse actions, execute them (permission-checked)
//   7. Apply any reply injects (e.g. portal URLs), strip action blocks
//   8. Save assistant message, log interaction
//   9. Return { reply, actions, session_id, client_hints }

const william = require('./william-schedule')
const memory = require('./riker-memory')
const actions = require('./riker-actions')
const { assemblePrompt } = require('./riker-prompts')

const CLAUDE_MODEL = 'claude-sonnet-4-6'
const CLAUDE_PRICE_INPUT = 3.0 / 1_000_000       // $/token
const CLAUDE_PRICE_OUTPUT = 15.0 / 1_000_000
const CLAUDE_PRICE_CACHE_READ = 0.30 / 1_000_000
const CLAUDE_PRICE_CACHE_WRITE = 3.75 / 1_000_000

// ═══ SLOT CALCULATION (William-aware) — reused from earlier build ═══
const DAY_MAP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

function expandRecurring(events, rangeStart, rangeEnd) {
  const rs = new Date(rangeStart), re = new Date(rangeEnd)
  const results = []
  for (const ev of (events || [])) {
    if (!ev.recurring) {
      const st = new Date(ev.start_time)
      if (st >= rs && st <= re) results.push({ ...ev })
      continue
    }
    const rule = ev.recurrence_rule || {}
    const until = rule.until ? new Date(rule.until + 'T23:59:59') : re
    const effEnd = until < re ? until : re
    const baseStart = new Date(ev.start_time)
    const baseEnd = new Date(ev.end_time)
    const durMs = baseEnd - baseStart
    if (rule.freq === 'weekly' && rule.days) {
      const targetDays = rule.days.map(d => DAY_MAP[d]).filter(d => d !== undefined)
      let cur = new Date(rs); cur.setHours(0, 0, 0, 0)
      while (cur <= effEnd) {
        if (targetDays.includes(cur.getDay())) {
          const oStart = new Date(cur)
          oStart.setHours(baseStart.getHours(), baseStart.getMinutes(), baseStart.getSeconds())
          if (oStart >= rs && oStart <= effEnd) {
            const oEnd = new Date(oStart.getTime() + durMs)
            results.push({ ...ev, start_time: oStart.toISOString(), end_time: oEnd.toISOString() })
          }
        }
        cur.setDate(cur.getDate() + 1)
      }
    }
  }
  return results
}

function timeToMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m }
function minToTime(m) {
  const h = Math.floor(m / 60), min = m % 60
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h
  return h12 + ':' + String(min).padStart(2, '0') + ' ' + ampm
}

function getSlotsForDate(dateStr, calEvents, jobs) {
  const avail = william.getJonAvailability(new Date(dateStr + 'T12:00:00'))
  if (!avail.available) return { slots: [], avail }
  const dayStart = new Date(dateStr + 'T00:00:00')
  const dayEnd = new Date(dateStr + 'T23:59:59')
  const dayEvts = expandRecurring(calEvents, dayStart, dayEnd).filter(e => e.event_type !== 'job')
  const dayJobs = jobs.filter(j => j.scheduled_date === dateStr && j.status !== 'cancelled' && j.status !== 'completed')

  const busy = []
  for (const ev of dayEvts) {
    const s = new Date(ev.start_time), e = new Date(ev.end_time)
    busy.push({ start: s.getHours() * 60 + s.getMinutes(), end: e.getHours() * 60 + e.getMinutes() })
  }
  for (const j of dayJobs) {
    const t = j.scheduled_time || '09:00'
    const [h, m] = t.split(':').map(Number)
    const dur = (j.estimated_duration_hours || 1.5) * 60
    busy.push({ start: h * 60 + m, end: h * 60 + m + dur })
  }
  busy.sort((a, b) => a.start - b.start)

  const workStart = timeToMin(avail.workStart)
  const workEnd = timeToMin(avail.workEnd)
  const slots = []
  let cursor = workStart
  for (const b of busy) {
    if (b.start > cursor) {
      const s = Math.max(cursor, workStart), e = Math.min(b.start, workEnd)
      if (e - s >= 30) slots.push({ start: minToTime(s), end: minToTime(e), startMin: s, endMin: e })
    }
    cursor = Math.max(cursor, b.end)
  }
  if (cursor < workEnd) slots.push({ start: minToTime(cursor), end: minToTime(workEnd), startMin: cursor, endMin: workEnd })
  return { slots, avail }
}

function getNextBusinessDays(count) {
  const days = []
  const cur = new Date()
  while (days.length < count) {
    cur.setDate(cur.getDate() + 1)
    const dow = cur.getDay()
    if (dow >= 1 && dow <= 5) days.push(cur.toISOString().split('T')[0])
  }
  return days
}

// ═══ RIKER_SESSIONS MIRRORING FOR SMS/EMAIL ═══
// SMS + email primary storage is `conversations` + `messages` (keyed by
// external identity). We *also* mirror state into `riker_sessions` so
// analytics, memory extraction, and cross-channel continuity all have a
// single unified session object to work from.

const MEMORY_EXTRACT_EVERY_N_INBOUND = 4  // run extraction after every N inbound turns

// Find or create the active riker_sessions row for an external-identity channel.
async function upsertRikerSessionForChannel({ supabase, context, phone, email, party, locationId, billingAccountId, customerName }) {
  let q = supabase.from('riker_sessions').select('*').eq('context', context).eq('status', 'active')
  if (phone) q = q.eq('customer_phone', phone)
  else if (email) q = q.eq('customer_email', email)
  const { data: existing } = await q.order('updated_at', { ascending: false }).limit(1).maybeSingle()
  if (existing) {
    // Keep location/billing in sync if we've since identified the customer
    const updates = {}
    if (locationId && !existing.location_id) updates.location_id = locationId
    if (billingAccountId && !existing.billing_account_id) updates.billing_account_id = billingAccountId
    if (customerName && !existing.customer_name) updates.customer_name = customerName
    if (Object.keys(updates).length) {
      updates.updated_at = new Date().toISOString()
      await supabase.from('riker_sessions').update(updates).eq('id', existing.id)
    }
    return existing
  }
  const { data: created, error } = await supabase.from('riker_sessions').insert({
    context,
    customer_phone: phone || null,
    customer_email: email || null,
    customer_name: customerName || null,
    location_id: locationId || null,
    billing_account_id: billingAccountId || null,
    messages: [],
    status: 'active'
  }).select().single()
  if (error) { console.error('[riker-core] upsertRikerSession insert failed:', error); return null }
  return created
}

// Append a message to a riker_sessions.messages JSONB array.
async function appendToRikerSession(supabase, sessionId, role, content, meta = {}) {
  if (!sessionId || !content) return
  // Atomic-ish: fetch, append, write. Fine for single-user-per-conversation cadence.
  const { data: sess } = await supabase.from('riker_sessions').select('messages').eq('id', sessionId).maybeSingle()
  const msgs = Array.isArray(sess?.messages) ? sess.messages : []
  msgs.push({ role, content, ts: new Date().toISOString(), ...meta })
  await supabase.from('riker_sessions').update({
    messages: msgs,
    updated_at: new Date().toISOString()
  }).eq('id', sessionId)
}

// Update aggregate stats on a session (token counts, cost, last action list).
async function bumpSessionStats(supabase, sessionId, { usage, cost, actions }) {
  if (!sessionId) return
  const { data: sess } = await supabase.from('riker_sessions').select('total_input_tokens,total_output_tokens,total_cost_usd,actions_taken').eq('id', sessionId).maybeSingle()
  const prevActions = Array.isArray(sess?.actions_taken) ? sess.actions_taken : []
  await supabase.from('riker_sessions').update({
    total_input_tokens: (sess?.total_input_tokens || 0) + (usage?.input_tokens || 0),
    total_output_tokens: (sess?.total_output_tokens || 0) + (usage?.output_tokens || 0),
    total_cost_usd: Number(sess?.total_cost_usd || 0) + Number(cost || 0),
    actions_taken: [...prevActions, ...(actions || []).map(a => ({ type: a.type, ok: a.ok, ts: new Date().toISOString() }))],
    updated_at: new Date().toISOString()
  }).eq('id', sessionId)
}

// Count inbound turns in this session so we can trigger extraction every N turns.
function countInboundTurns(session) {
  return (Array.isArray(session?.messages) ? session.messages : [])
    .filter(m => m.role === 'user').length
}

// ═══ MEMORY EXTRACTION ═══
// After every N inbound turns, Claude reads the session transcript and
// extracts durable facts into riker_memory entries. Non-blocking from the
// caller's perspective (caller should fire-and-forget if latency matters).
async function extractMemoryFromSession(supabase, sessionId, { force = false } = {}) {
  try {
    const { data: session } = await supabase.from('riker_sessions').select('*').eq('id', sessionId).maybeSingle()
    if (!session) return { skipped: 'no session' }

    const msgs = Array.isArray(session.messages) ? session.messages : []
    const userTurns = msgs.filter(m => m.role === 'user').length
    if (userTurns === 0) return { skipped: 'no user turns' }

    // Transcript — last ~20 messages
    const recent = msgs.slice(-24)
    const transcript = recent.map(m => `${m.role === 'user' ? (session.context === 'sms_jon' ? 'Jon' : 'Customer') : 'Riker'}: ${m.content}`).join('\n')

    const scopeHint = session.location_id
      ? `location_id ${session.location_id}`
      : session.billing_account_id
        ? `billing_account_id ${session.billing_account_id}`
        : 'global only (no specific location/customer)'

    const extractionPrompt = `You are reviewing a conversation to extract durable facts worth remembering for future interactions. You are Riker's memory-extraction pass — your ONLY job is to output a JSON array, no prose.

CONTEXT:
- Session type: ${session.context}
- Identified location: ${scopeHint}
${session.customer_name ? '- Customer name: ' + session.customer_name : ''}

EXTRACT — things like:
- Customer preferences ("prefers morning service", "bilingual communication needed")
- Relationships ("daughter handles communication", "owner's name is Wei")
- Equipment notes ("R-102 tank showing corrosion", "extinguishers need 6-year in 2027")
- Scheduling constraints ("closed Mondays", "gate code 4455")
- Billing notes ("always pays by check, net 30")
- Pending items ("send insurance docs by May 1")
- Standing orders Jon issued (phrased "from now on", "that's an order", etc.) → priority 10, never expire

SKIP:
- Conversational filler ("hi", "thanks", "ok")
- One-off request details that are already captured as jobs/invoices
- Things Riker already knew (in the context block)

OUTPUT — JSON ARRAY, nothing else. Each item:
  {
    "scope": "global" | "location" | "customer" | "job",
    "category": "preference" | "relationship" | "equipment_note" | "scheduling" | "billing" | "compliance" | "action_pending" | "route_note" | "internal",
    "content": "natural-language fact — start with STANDING ORDER: if Jon issued a directive",
    "priority": 1-10,
    "expires_at": "YYYY-MM-DDThh:mm:ssZ (optional, only for time-sensitive action_pending)"
  }
For scope="location", the server will fill location_id from the session. Do not include it yourself.

If nothing worth remembering, output [].

CONVERSATION TRANSCRIPT:
${transcript}`

    const claudeKey = process.env.CLAUDE_KEY
    if (!claudeKey) return { skipped: 'no CLAUDE_KEY' }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: 'You extract durable facts from conversations. You output JSON arrays only. No prose, no markdown fences.',
        messages: [{ role: 'user', content: extractionPrompt }]
      })
    })
    const data = await res.json()
    if (!res.ok) { console.error('[extract-memory] claude err:', data); return { error: data } }
    let text = data.content?.[0]?.text || '[]'
    // Strip markdown fences if model wrapped despite instruction
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()

    let entries
    try { entries = JSON.parse(text) }
    catch (e) { console.warn('[extract-memory] parse failed:', text.slice(0, 200)); return { error: 'parse_failed' } }
    if (!Array.isArray(entries)) return { error: 'not_array' }

    let written = 0
    for (const e of entries) {
      if (!e || !e.scope || !e.category || !e.content) continue
      const row = {
        scope: e.scope,
        category: e.category,
        content: String(e.content).slice(0, 4000),
        priority: Math.max(1, Math.min(10, Number(e.priority) || 5)),
        expires_at: e.expires_at || null,
        auto_generated: true,
        source: 'memory_extraction:' + session.context,
        source_session_id: sessionId
      }
      // Fill scope keys from session
      if (e.scope === 'location' || (e.scope !== 'global' && !e.scope && session.location_id)) {
        row.location_id = session.location_id
      }
      if (session.billing_account_id) row.billing_account_id = session.billing_account_id
      if (session.tech_id) row.tech_id = session.tech_id

      // Dedup against same content in same scope/category
      const { data: dup } = await supabase
        .from('riker_memory')
        .select('id, priority')
        .eq('archived', false)
        .eq('scope', row.scope)
        .eq('category', row.category)
        .eq('content', row.content)
        .limit(1).maybeSingle()
      if (dup) {
        // Bump priority if new is higher
        if (row.priority > dup.priority) {
          await supabase.from('riker_memory').update({ priority: row.priority, updated_at: new Date().toISOString() }).eq('id', dup.id)
        }
        continue
      }
      const { error: insErr } = await supabase.from('riker_memory').insert(row)
      if (!insErr) written++
      else console.warn('[extract-memory] insert err:', insErr.message)
    }

    // Note on session: last extraction timestamp (avoid re-running on same turns)
    await supabase.from('riker_sessions').update({ updated_at: new Date().toISOString() }).eq('id', sessionId)
    return { written, total_proposed: entries.length }
  } catch (e) {
    console.error('[extract-memory] error:', e)
    return { error: e.message }
  }
}

// ═══ SESSION ADAPTER ═══
// Bridges two storage patterns: riker_sessions (website/portal/app) and
// conversations/messages (sms/email).

function makeSessionAdapter({ storage, supabase, sessionKey }) {
  if (storage === 'riker_sessions') {
    return {
      storage,
      async load() {
        const { data } = await supabase.from('riker_sessions').select('*').eq('id', sessionKey).maybeSingle()
        return data
      },
      async loadHistoryAsMessages(session) {
        return (session.messages || []).map(m => ({ role: m.role, content: m.content }))
      },
      async appendInbound(session, body) {
        const msgs = [...(session.messages || []), { role: 'user', content: body, ts: new Date().toISOString() }]
        await supabase.from('riker_sessions').update({
          messages: msgs,
          updated_at: new Date().toISOString()
        }).eq('id', sessionKey)
        return msgs
      },
      async appendOutbound(session, body, meta = {}) {
        const msgs = [...(session.messages || []), { role: 'assistant', content: body, ts: new Date().toISOString(), ...meta }]
        await supabase.from('riker_sessions').update({
          messages: msgs,
          updated_at: new Date().toISOString()
        }).eq('id', sessionKey)
        return msgs
      },
      async bumpStats(usage) {
        await supabase.from('riker_sessions').update({
          total_input_tokens: supabase.rpc ? undefined : undefined,  // simple update below
          updated_at: new Date().toISOString()
        }).eq('id', sessionKey)
        const { data } = await supabase.from('riker_sessions').select('total_input_tokens,total_output_tokens,total_cost_usd').eq('id', sessionKey).single()
        await supabase.from('riker_sessions').update({
          total_input_tokens: (data?.total_input_tokens || 0) + (usage.input_tokens || 0),
          total_output_tokens: (data?.total_output_tokens || 0) + (usage.output_tokens || 0),
          total_cost_usd: Number(data?.total_cost_usd || 0) + (usage.cost_usd || 0)
        }).eq('id', sessionKey)
      }
    }
  }

  // conversations/messages adapter (sms, email)
  return {
    storage,
    async load() {
      const { data } = await supabase.from('conversations').select('*').eq('id', sessionKey).maybeSingle()
      return data
    },
    async loadHistoryAsMessages() {
      const { data: msgs } = await supabase
        .from('messages')
        .select('direction, body')
        .eq('conversation_id', sessionKey)
        .order('created_at', { ascending: true })
      // Collapse consecutive same-role messages for Claude alternation
      const out = []
      for (const m of (msgs || [])) {
        const role = m.direction === 'inbound' ? 'user' : 'assistant'
        if (out.length && out[out.length - 1].role === role) {
          out[out.length - 1].content += '\n' + m.body
        } else {
          out.push({ role, content: m.body })
        }
      }
      return out
    },
    // Inbound was already logged by the webhook; no-op
    async appendInbound() {},
    async appendOutbound(_session, body, meta = {}) {
      await supabase.from('messages').insert({
        conversation_id: sessionKey,
        direction: 'outbound',
        channel: meta.channel || 'sms',
        body,
        twilio_sid: meta.twilio_sid || null,
        email_message_id: meta.email_message_id || null,
        email_subject: meta.email_subject || null
      })
      await supabase.from('conversations').update({
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq('id', sessionKey)
    },
    async bumpStats() { /* conversation table doesn't track this; interactions table does */ }
  }
}

// ═══ CONTEXT DATA BUILDER ═══

async function buildLiveData({ supabase, context, identity, rikerSessionId }) {
  const parts = []
  const today = new Date().toISOString().split('T')[0]
  parts.push(`TODAY: ${today}`)
  let calEvents = []
  let jobs = []

  // Session continuity — for SMS/email, surface turn count and recent context
  // so Riker doesn't have to reconstruct from the Claude messages array alone.
  if (rikerSessionId && ['sms_jon', 'sms_customer', 'email_customer'].includes(context)) {
    const { data: sess } = await supabase.from('riker_sessions').select('*').eq('id', rikerSessionId).maybeSingle()
    if (sess) {
      const msgs = Array.isArray(sess.messages) ? sess.messages : []
      const inboundCount = msgs.filter(m => m.role === 'user').length
      const ageMin = Math.round((Date.now() - new Date(sess.created_at).getTime()) / 60000)
      parts.push(`SESSION: ${sess.id.slice(0, 8)} · ${inboundCount} turn${inboundCount === 1 ? '' : 's'} in · ${ageMin}m old${sess.customer_name ? ' · ' + sess.customer_name : ''}`)
      if (msgs.length > 2) {
        // Surface a brief tail of the conversation for quick recall without bloating the system prompt
        const tail = msgs.slice(-6).map(m => `  ${m.role === 'user' ? '→' : '←'} ${String(m.content).slice(0, 140)}${String(m.content).length > 140 ? '…' : ''}`).join('\n')
        parts.push('SESSION_TAIL:\n' + tail)
      }
    }
  }

  // Available slots — relevant for any context that might schedule
  if (['website', 'portal', 'app', 'sms_customer', 'sms_jon', 'email_customer'].includes(context)) {
    const days = [today, ...getNextBusinessDays(7)]
    const calRes = await supabase.from('calendar_events').select('*')
    const jobRes = await supabase.from('jobs').select('id, location_id, scheduled_date, scheduled_time, scope, status, estimated_duration_hours, location:locations(name,city)').in('scheduled_date', days)
    calEvents = calRes.data || []
    jobs = jobRes.data || []

    const slotLines = ['AVAILABLE_SLOTS (William-aware):']
    for (const d of days) {
      const dt = new Date(d + 'T12:00:00')
      const label = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
      const { slots, avail } = getSlotsForDate(d, calEvents || [], jobs || [])
      slotLines.push(avail.available
        ? `${label} (${d}): ${slots.length ? slots.map(s => s.start + '-' + s.end).join(', ') : 'FULL'} [${avail.reason}]`
        : `${label} (${d}): BLOCKED — ${avail.reason}`)
    }
    parts.push(slotLines.join('\n'))

    const jobLines = ['EXISTING_JOBS:']
    for (const d of days) {
      const label = new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' })
      const dayJobs = (jobs || []).filter(j => j.scheduled_date === d && j.status !== 'cancelled')
      jobLines.push(dayJobs.length
        ? `${label} (${d}): ${dayJobs.map(j => (j.location?.name || '?') + ' ' + (j.scheduled_time || '')).join(', ')}`
        : `${label} (${d}): [empty]`)
    }
    parts.push(jobLines.join('\n'))
  }

  // Rate card — visible to app + sms_jon (Jon's contexts); website can mention standard prices but should use the system prompt values
  if (['app', 'sms_jon'].includes(context)) {
    const { data: rates } = await supabase.from('rate_card').select('key, description, price').order('key')
    if (rates?.length) {
      parts.push('RATE_CARD:\n' + rates.map(r => `- ${r.key}: $${r.price}${r.description ? ' (' + r.description + ')' : ''}`).join('\n'))
    }
  }

  // Customer-scoped data for portal
  if (context === 'portal' && identity.billing_account_id) {
    const { data: locs } = await supabase.from('locations').select('id, name, city, address').eq('billing_account_id', identity.billing_account_id)
    if (locs?.length) {
      parts.push('YOUR_LOCATIONS:\n' + locs.map(l => `- ${l.id}: ${l.name} (${l.city || ''})`).join('\n'))
    }
    const { data: recentInv } = await supabase.from('invoices').select('invoice_number, date, total, status').eq('billing_account_id', identity.billing_account_id).order('date', { ascending: false }).limit(5)
    if (recentInv?.length) {
      parts.push('RECENT_INVOICES:\n' + recentInv.map(i => `- ${i.invoice_number} ${i.date} $${i.total} ${i.status}`).join('\n'))
    }
  }

  // App + SMS-Jon: summary stats, today's jobs, overdue list, unpaid list, clients index.
  // Jon over SMS gets the same operational picture he has in the app — otherwise he
  // can't ask "what's overdue" or "who owes me money" and get a real answer.
  if (['app', 'sms_jon'].includes(context)) {
    const [overdueRows, unpaidRows, todayJobsRows, clientsRows] = await Promise.all([
      supabase.from('jobs')
        .select('id, scheduled_date, scope, location:locations(name,city)')
        .lt('scheduled_date', today).eq('status', 'scheduled')
        .order('scheduled_date', { ascending: false }).limit(20),
      supabase.from('invoices')
        .select('id, invoice_number, total, date, status, location:locations(name,city)')
        .not('status', 'in', '(paid,void,record,factored)')
        .order('date', { ascending: true }).limit(20),
      supabase.from('jobs')
        .select('id, scheduled_time, scope, estimated_value, location:locations(name,city,address)')
        .eq('scheduled_date', today).in('status', ['scheduled', 'en_route', 'active'])
        .order('scheduled_time'),
      supabase.from('locations')
        .select('id, name, city, contact_name, contact_phone')
        .order('updated_at', { ascending: false }).limit(60)
    ])
    const unpaidTotal = (unpaidRows.data || []).reduce((s, i) => s + Number(i.total || 0), 0)
    const overdueCount = (overdueRows.data || []).length

    parts.push(`TODAY_SUMMARY: ${todayJobsRows.data?.length || 0} jobs today, ${overdueCount} overdue, $${unpaidTotal.toFixed(0)} outstanding (${(unpaidRows.data || []).length} invoices)`)

    if (todayJobsRows.data?.length) {
      parts.push('TODAY_JOBS:\n' + todayJobsRows.data.map(j =>
        `- ${j.scheduled_time || ''} ${j.location?.name || '?'} (${j.location?.city || ''}) — ${(j.scope || []).join(',')}${j.estimated_value ? ' · $' + Number(j.estimated_value).toFixed(0) : ''} [id:${j.id}]`
      ).join('\n'))
    }

    if (overdueRows.data?.length) {
      parts.push('OVERDUE_JOBS:\n' + overdueRows.data.slice(0, 10).map(j =>
        `- ${j.scheduled_date} ${j.location?.name || '?'} (${j.location?.city || ''}) — ${(j.scope || []).join(',')} [id:${j.id}]`
      ).join('\n'))
    }

    if (unpaidRows.data?.length) {
      parts.push('UNPAID_INVOICES:\n' + unpaidRows.data.slice(0, 10).map(i =>
        `- ${i.invoice_number || '?'} ${i.location?.name || '?'} $${Number(i.total).toFixed(2)} dated ${String(i.date).slice(0,10)} [status:${i.status}]`
      ).join('\n'))
    }

    if (clientsRows.data?.length) {
      parts.push('CLIENTS_RECENT (most recent 60 — use lookup_client for anything not listed):\n' + clientsRows.data.map(l =>
        `- ${l.name}${l.city ? ' (' + l.city + ')' : ''}${l.contact_phone ? ' · ' + l.contact_phone : ''} [id:${l.id}]`
      ).join('\n'))
    }
  }

  // Pending confirmations (for sms_jon context)
  if (context === 'sms_jon') {
    const { data: pendings } = await supabase.from('pending_confirmations').select('*').eq('status', 'pending').gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(3)
    if (pendings?.length) {
      parts.push('OPEN_PENDING_CONFIRMATIONS:')
      for (const p of pendings) {
        const a = p.proposed_action || {}
        parts.push(`- ${p.id}: ${a.business_name || p.customer_name || '?'} ${a.date || ''} ${a.time || ''} ${(a.scope || []).join(',')}${p.reasoning ? ' (' + p.reasoning + ')' : ''}`)
      }
    } else {
      parts.push('OPEN_PENDING_CONFIRMATIONS: none')
    }
  }

  return { block: parts.join('\n\n'), calEvents, jobs }
}

// ═══ CLAUDE CALL ═══

async function callClaude({ systemPrompt, history, inboundMessage, attachments }) {
  const claudeKey = process.env.CLAUDE_KEY
  if (!claudeKey) throw new Error('CLAUDE_KEY not set')

  // Build messages — history plus current inbound (if not already in history)
  const messages = []
  for (const h of (history || [])) {
    const role = h.role || (h.direction === 'inbound' ? 'user' : 'assistant')
    if (messages.length && messages[messages.length - 1].role === role) {
      messages[messages.length - 1].content = typeof messages[messages.length - 1].content === 'string'
        ? messages[messages.length - 1].content + '\n' + h.content
        : messages[messages.length - 1].content
    } else {
      messages.push({ role, content: h.content })
    }
  }

  // Add inbound if not last
  if (inboundMessage && (!messages.length || messages[messages.length - 1].role !== 'user' || messages[messages.length - 1].content !== inboundMessage)) {
    const content = attachments && attachments.length
      ? [{ type: 'text', text: inboundMessage }, ...attachments]
      : inboundMessage
    if (messages.length && messages[messages.length - 1].role === 'user') {
      // Merge
      if (typeof messages[messages.length - 1].content === 'string') {
        messages[messages.length - 1].content = messages[messages.length - 1].content + '\n' + inboundMessage
      }
    } else {
      messages.push({ role: 'user', content })
    }
  }

  if (!messages.length || messages[0].role !== 'user') {
    return { text: '', usage: { input_tokens: 0, output_tokens: 0 } }
  }

  const start = Date.now()
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': claudeKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      messages
    })
  })
  const data = await res.json()
  const latency = Date.now() - start
  if (!res.ok) throw new Error('Claude error: ' + JSON.stringify(data))
  return {
    text: data.content?.[0]?.text || '',
    usage: data.usage || {},
    latency
  }
}

// ═══ MAIN ═══

async function processMessage({
  supabase,
  context,                     // 'website' | 'portal' | 'app' | 'sms_customer' | 'sms_jon' | 'email_customer'
  sessionKey,                  // riker_sessions.id OR conversations.id
  sessionStorage,              // 'riker_sessions' | 'conversations'
  identity = {},               // { location_id, billing_account_id, tech_id, phone, email }
  message,                     // current inbound text (may be empty when just building proactive output)
  attachments,                 // Claude content blocks (images)
  inboundAlreadyLogged = true, // webhook should log inbound before calling this
  rikerSessionId               // optional riker_sessions PK when mirroring SMS/email — feeds session continuity block
}) {
  const adapter = makeSessionAdapter({ storage: sessionStorage, supabase, sessionKey })
  const session = await adapter.load()
  if (!session) throw new Error(`Session not found: ${sessionKey} in ${sessionStorage}`)

  // For riker_sessions surfaces, append inbound to session now (SMS/email already logged by webhook)
  if (sessionStorage === 'riker_sessions' && message && !inboundAlreadyLogged) {
    await adapter.appendInbound(session, message)
    session.messages = [...(session.messages || []), { role: 'user', content: message }]
  }

  // Memory
  const memories = await memory.readRelevantMemories({
    supabase, context,
    locationId: identity.location_id,
    billingAccountId: identity.billing_account_id,
    techId: identity.tech_id
  })
  const notebook = memory.renderMemoriesForPrompt(memories)

  // For SMS/email, sessionStorage is 'conversations' but we also have a
  // mirrored riker_sessions row — use its id for the session continuity block.
  const effectiveRikerSessionId = rikerSessionId || (sessionStorage === 'riker_sessions' ? sessionKey : null)

  // Live data (returns block + raw data for action handlers)
  const { block: liveData, calEvents, jobs } = await buildLiveData({ supabase, context, identity, rikerSessionId: effectiveRikerSessionId })

  // Assemble prompt
  const systemPrompt = assemblePrompt({ context, notebook, liveData })

  // History + current message for Claude
  const history = await adapter.loadHistoryAsMessages(session)

  // Call Claude
  let claudeResp
  try {
    claudeResp = await callClaude({
      systemPrompt,
      history,
      inboundMessage: (sessionStorage === 'riker_sessions' && inboundAlreadyLogged === false) ? null : message,
      attachments
    })
  } catch (e) {
    console.error('[riker-core] claude call failed:', e)
    await logInteraction(supabase, { context, sessionKey, sessionStorage, userMessage: message, error: e.message })
    return { reply: 'Sorry, I had trouble with that. Give me a second and try again.', error: e.message }
  }

  // Parse + execute
  const { clean: rawClean, actions: parsed } = actions.parseActions(claudeResp.text)
  const execCtx = {
    supabase, context, identity,
    sessionId: sessionKey,
    lastLocationId: identity.location_id || null,
    calEvents, jobs,
    rawReply: rawClean
  }
  const { taken, clientHints, replyInject, pendingAction, replyOverride } = await actions.executeActions(parsed, execCtx)

  // Apply reply override (e.g. schedule_job routing through pending_confirmations)
  let clean = replyOverride || rawClean
  if (replyInject) {
    if (replyInject.placeholder) clean = clean.replace(replyInject.placeholder, replyInject.value)
    if (replyInject.append && !clean.includes(replyInject.value)) clean += '\n\n' + replyInject.append
  }

  // Save assistant message
  await adapter.appendOutbound(session, clean, {
    channel: session.channel || (context === 'sms_customer' || context === 'sms_jon' ? 'sms' : context === 'email_customer' ? 'email' : 'web')
  })

  // Cost + interaction log
  const usage = claudeResp.usage || {}
  const cost = ((usage.input_tokens || 0) * CLAUDE_PRICE_INPUT)
    + ((usage.output_tokens || 0) * CLAUDE_PRICE_OUTPUT)
    + ((usage.cache_read_input_tokens || 0) * CLAUDE_PRICE_CACHE_READ)
    + ((usage.cache_creation_input_tokens || 0) * CLAUDE_PRICE_CACHE_WRITE)

  await logInteraction(supabase, {
    context,
    sessionKey,
    sessionStorage,
    userMessage: message,
    reply: clean,
    actions_attempted: parsed,
    actions_succeeded: taken,
    memory_writes: taken.filter(t => t.type === 'memory_write').reduce((s, t) => s + (t.detail?.written || 0), 0),
    memory_reads: memories.length,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read: usage.cache_read_input_tokens,
    cache_create: usage.cache_creation_input_tokens,
    cost,
    latency: claudeResp.latency
  })

  return {
    reply: clean,
    actions_taken: taken,
    client_hints: clientHints,
    pending_action: pendingAction,
    session_id: sessionKey,
    cost,
    memories_read: memories.length
  }
}

// ═══ PROACTIVE ENTRY ═══
// For cron-authored messages (morning brief, aging reminder, etc.) where
// there's no inbound message — just a system-level request to generate.
async function generateProactive({ supabase, context, identity, instruction }) {
  // Create a transient session
  const { data: session } = await supabase.from('riker_sessions').insert({
    context,
    tech_id: identity.tech_id || null,
    location_id: identity.location_id || null,
    billing_account_id: identity.billing_account_id || null,
    messages: [{ role: 'user', content: instruction, ts: new Date().toISOString() }],
    status: 'closed'
  }).select().single()

  return processMessage({
    supabase,
    context,
    sessionKey: session.id,
    sessionStorage: 'riker_sessions',
    identity,
    message: instruction,
    inboundAlreadyLogged: true
  })
}

async function logInteraction(supabase, row) {
  try {
    await supabase.from('riker_interactions').insert({
      session_id: row.sessionKey,
      session_source: row.sessionStorage,
      context: row.context,
      user_message: row.userMessage || null,
      model: CLAUDE_MODEL,
      reply: row.reply || null,
      actions_attempted: row.actions_attempted || [],
      actions_succeeded: row.actions_succeeded || [],
      memory_entries_written: row.memory_writes || 0,
      memory_entries_read: row.memory_reads || 0,
      input_tokens: row.input_tokens || null,
      output_tokens: row.output_tokens || null,
      cache_read_tokens: row.cache_read || null,
      cache_creation_tokens: row.cache_create || null,
      cost_usd: row.cost || null,
      latency_ms: row.latency || null,
      error: row.error || null
    })
  } catch (e) {
    console.error('[riker-core] interaction log failed:', e)
  }
}

module.exports = {
  processMessage,
  generateProactive,
  makeSessionAdapter,
  upsertRikerSessionForChannel,
  appendToRikerSession,
  bumpSessionStats,
  countInboundTurns,
  extractMemoryFromSession,
  MEMORY_EXTRACT_EVERY_N_INBOUND,
  CLAUDE_MODEL
}
