// /api/riker-desk.js
// Phase 1 of situational awareness.
//
// Riker has a DESK now. The desk holds everything he should know without
// being asked — the live state of the business, who's mid-conversation with
// him across every channel, what just happened in the field, pending items
// awaiting his eye, and any short-term notes he jotted down in the last
// two days.
//
// `buildRikersDesk(supabase, { context, identity, now })` returns a single
// uncached system-prompt text block. It is injected fresh every Claude
// turn — NEVER cached, because the whole point is that it reflects the
// present moment.
//
// Structure (in order):
//   CURRENT TIME
//   BUSINESS PULSE          (jobs/invoices/todos/Jon's location)
//   DESK NOTES              (short_term_desk memory category, last 48h)
//   LIVE TRANSCRIPT         (Phase 6c — full-text cross-channel messages,
//                            last 2h, no truncation. Makes Riker feel
//                            present — he sees the actual words that were
//                            said, not 60-char summaries.)
//   AUDIT TAIL              (Phase 6d — last ~30 audit_log events across
//                            the business. Riker narrates state changes
//                            — "Mike just marked that complete", "invoice
//                            1042 was paid 4 min ago".)
//   OPEN THREADS            (active conversations across channels, last 24h)
//   UNREAD INBOX            (emails Jon hasn't replied to)
//   DRAFTED EMAILS          (Riker's pending drafts awaiting Jon)
//
// Never throws. Any subsystem failure becomes silent omission.

const SECTION_SEP = '\n\n'

// How far back each section looks.
const ACTIVITY_WINDOW_MIN = 120      // 2 hours for the live feed
const OPEN_THREADS_WINDOW_MIN = 24 * 60  // 24 hours for still-in-play conversations
const DESK_NOTES_WINDOW_HRS = 48     // short_term_desk auto-expires at 48h anyway

async function buildRikersDesk(supabase, { context = 'app', identity = {}, now = new Date() } = {}) {
  const parts = []

  // CURRENT TIME (America/Chicago — handles CST/CDT automatically)
  const nowCST = now.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZoneName: 'short'
  })
  parts.push(`CURRENT TIME: ${nowCST}`)

  // Run every section in parallel — any failure is tolerated as empty.
  const [pulse, deskNotes, liveTranscript, auditTail, openThreads, unreadInbox, pendingDrafts] = await Promise.all([
    _buildBusinessPulse(supabase).catch(e => { console.warn('[desk] pulse:', e.message); return '' }),
    _buildDeskNotes(supabase, identity).catch(e => { console.warn('[desk] notes:', e.message); return '' }),
    _buildLiveTranscript(supabase, now).catch(e => { console.warn('[desk] transcript:', e.message); return '' }),
    _buildAuditTail(supabase, now).catch(e => { console.warn('[desk] audit:', e.message); return '' }),
    _buildOpenThreads(supabase, now).catch(e => { console.warn('[desk] threads:', e.message); return '' }),
    _buildUnreadInbox(supabase).catch(e => { console.warn('[desk] inbox:', e.message); return '' }),
    _buildPendingDrafts(supabase).catch(e => { console.warn('[desk] drafts:', e.message); return '' })
  ])

  if (pulse) parts.push(pulse)
  if (deskNotes) parts.push(deskNotes)
  if (liveTranscript) parts.push(liveTranscript)
  if (auditTail) parts.push(auditTail)
  if (openThreads) parts.push(openThreads)
  if (unreadInbox) parts.push(unreadInbox)
  if (pendingDrafts) parts.push(pendingDrafts)

  return parts.join(SECTION_SEP)
}

// ═══════════════════════════════════════════════════════════════
// BUSINESS PULSE — same shape as the old riker-core.buildBusinessPulse
// ═══════════════════════════════════════════════════════════════

async function _reverseGeocode(lat, lng) {
  const key = process.env.GOOGLE_MAPS_API_KEY
  if (!key) return null
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}`
    const r = await fetch(url)
    if (!r.ok) return null
    const d = await r.json()
    if (d.status !== 'OK' || !d.results?.[0]) return null
    const comps = d.results[0].address_components
    const city = comps.find(c => c.types.includes('locality'))?.long_name
      || comps.find(c => c.types.includes('administrative_area_level_3'))?.long_name
    const state = comps.find(c => c.types.includes('administrative_area_level_1'))?.short_name
    if (city && state) return `${city}, ${state}`
    const county = comps.find(c => c.types.includes('administrative_area_level_2'))?.long_name
    if (county && state) return `${county}, ${state}`
    return state || null
  } catch { return null }
}

async function _buildBusinessPulse(supabase) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
  const weekEnd = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]

  const safe = p => p.then(r => r.data || []).catch(() => [])
  const safeOne = p => p.then(r => r.data || null).catch(() => null)
  const safeCount = p => p.then(r => r.count || 0).catch(() => 0)

  const [
    todayJobs, overdueJobs, upcomingJobs,
    openInvoices, pendingConf, openTodos,
    jonLoc, mazonPending, brycerPending
  ] = await Promise.all([
    safe(supabase.from('jobs')
      .select('scheduled_time, scope, status, location:locations(name,city)')
      .eq('scheduled_date', today).is('deleted_at', null)
      .order('scheduled_time')),
    safe(supabase.from('jobs')
      .select('scheduled_date, scope, location:locations(name,city)')
      .lt('scheduled_date', today).eq('status', 'scheduled').is('deleted_at', null)
      .order('scheduled_date', { ascending: true }).limit(10)),
    safe(supabase.from('jobs')
      .select('scheduled_date, scheduled_time, scope, location:locations(name,city)')
      .gt('scheduled_date', today).lte('scheduled_date', weekEnd)
      .eq('status', 'scheduled').is('deleted_at', null)
      .order('scheduled_date').limit(20)),
    safe(supabase.from('invoices')
      .select('invoice_number, total, due_date, location:locations(name)')
      .not('status', 'in', '(paid,void,record,factored)')
      .is('deleted_at', null)
      .order('due_date', { ascending: true })),
    safe(supabase.from('pending_confirmations')
      .select('customer_name, proposed_action')
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())),
    safe(supabase.from('todos')
      .select('text, created_at')
      .eq('done', false).is('deleted_at', null)
      .order('created_at', { ascending: false }).limit(15)),
    safeOne(supabase.from('jon_location').select('lat, lng, source, updated_at').eq('id', 1).maybeSingle()),
    safe(supabase.from('mazon_queue').select('customer_name, amount, status').eq('status', 'pending')),
    safeCount(supabase.from('brycer_queue').select('id', { count: 'exact', head: true }).eq('submitted', false))
  ])

  const lines = []
  const todayLabel = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric' })

  if (todayJobs.length === 0) {
    lines.push(`TODAY (${todayLabel}): no jobs scheduled`)
  } else {
    lines.push(`TODAY (${todayLabel}) — ${todayJobs.length} job${todayJobs.length > 1 ? 's' : ''}:`)
    for (const j of todayJobs) {
      const t = j.scheduled_time ? j.scheduled_time.slice(0, 5) : '?'
      const loc = j.location?.name || 'Unknown'
      const city = j.location?.city ? ` (${j.location.city})` : ''
      const scope = (j.scope || []).join(', ') || 'TBD'
      const done = j.status === 'completed' ? ' ✓' : j.status === 'cancelled' ? ' ✗' : ''
      lines.push(`  • ${t}  ${loc}${city} — ${scope}${done}`)
    }
  }

  if (overdueJobs.length === 0) {
    lines.push('OVERDUE: none')
  } else {
    const oldest = overdueJobs[0]
    lines.push(`OVERDUE: ${overdueJobs.length} job${overdueJobs.length > 1 ? 's' : ''} (oldest: ${oldest.scheduled_date} — ${oldest.location?.name || '?'})`)
    for (const j of overdueJobs.slice(0, 6)) {
      const scope = (j.scope || []).join('+') || 'TBD'
      lines.push(`  • ${j.scheduled_date}  ${j.location?.name || '?'}${j.location?.city ? ' (' + j.location.city + ')' : ''} [${scope}]`)
    }
    if (overdueJobs.length > 6) lines.push(`  … and ${overdueJobs.length - 6} more`)
  }

  if (upcomingJobs.length > 0) {
    lines.push(`UPCOMING (next 7 days): ${upcomingJobs.length} job${upcomingJobs.length > 1 ? 's' : ''}`)
    for (const j of upcomingJobs.slice(0, 6)) {
      const d = new Date(j.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
      const t = j.scheduled_time ? ' ' + j.scheduled_time.slice(0, 5) : ''
      const loc = j.location?.name || '?'
      const city = j.location?.city ? ` (${j.location.city})` : ''
      lines.push(`  • ${d}${t}  ${loc}${city}`)
    }
    if (upcomingJobs.length > 6) lines.push(`  … and ${upcomingJobs.length - 6} more`)
  }

  if (openInvoices.length === 0) {
    lines.push('INVOICES: all paid up')
  } else {
    const total = openInvoices.reduce((s, i) => s + Number(i.total || 0), 0)
    const oldest = openInvoices[0]
    lines.push(`INVOICES: $${total.toFixed(2)} outstanding across ${openInvoices.length} (oldest due: ${oldest.due_date || '?'} — ${oldest.location?.name || '?'})`)
    for (const inv of openInvoices.slice(0, 5)) {
      lines.push(`  • #${inv.invoice_number}  ${inv.location?.name || '?'}  $${Number(inv.total || 0).toFixed(2)}  due ${inv.due_date || '?'}`)
    }
    if (openInvoices.length > 5) lines.push(`  … and ${openInvoices.length - 5} more`)
  }

  if (pendingConf.length > 0) {
    lines.push(`PENDING APPROVAL: ${pendingConf.length} customer booking${pendingConf.length > 1 ? 's' : ''} awaiting Jon`)
    for (const p of pendingConf.slice(0, 5)) {
      const a = p.proposed_action || {}
      const biz = a.business_name || p.customer_name || '?'
      const d = a.date || '?'
      const t = a.time ? ' ' + a.time.slice(0, 5) : ''
      const scope = (a.scope || []).join('+') || 'TBD'
      lines.push(`  • ${biz} — ${d}${t} [${scope}]`)
    }
  }

  if (openTodos.length > 0) {
    lines.push(`TODOS: ${openTodos.length} open`)
    for (const t of openTodos.slice(0, 8)) {
      lines.push(`  • ${String(t.text).trim()}`)
    }
    if (openTodos.length > 8) lines.push(`  … and ${openTodos.length - 8} more`)
  }

  if (jonLoc && jonLoc.lat) {
    const ageMins = jonLoc.updated_at
      ? Math.round((Date.now() - new Date(jonLoc.updated_at).getTime()) / 60000)
      : null
    const region = await _reverseGeocode(jonLoc.lat, jonLoc.lng).catch(() => null)
    const regionStr = region ? `${region} ` : ''
    const coords = `(${jonLoc.lat.toFixed(4)}, ${jonLoc.lng.toFixed(4)})`
    if (ageMins != null && ageMins > 30) {
      lines.push(`JON'S LOCATION: ${regionStr}${coords} — STALE: last fix ${ageMins} min ago via ${jonLoc.source || '?'}. Do NOT assume Jon is here.`)
    } else {
      const ageStr = ageMins != null ? `, ${ageMins} min ago via ${jonLoc.source || '?'}` : ''
      lines.push(`JON'S LOCATION: ${regionStr}${coords}${ageStr}`)
    }
  } else {
    lines.push('JON\'S LOCATION: unknown — no GPS fix on record. Do not guess based on schedule.')
  }

  if (mazonPending.length > 0) {
    const mazonTotal = mazonPending.reduce((s, r) => s + Number(r.amount || 0), 0)
    lines.push(`MAZON FACTORING: ${mazonPending.length} pending ($${mazonTotal.toFixed(2)})`)
  }
  if (brycerPending > 0) {
    lines.push(`BRYCER: ${brycerPending} location${brycerPending > 1 ? 's' : ''} pending compliance submission`)
  }

  return 'BUSINESS PULSE (live — fetched fresh this turn):\n' + lines.join('\n')
}

// ═══════════════════════════════════════════════════════════════
// DESK NOTES — short_term_desk memory category
// ═══════════════════════════════════════════════════════════════
//
// Riker uses these as his yellow sticky notes. The only writer is
// write_memory with category='short_term_desk'. Expires in 48h by default.

async function _buildDeskNotes(supabase, identity) {
  const since = new Date(Date.now() - DESK_NOTES_WINDOW_HRS * 3600000).toISOString()
  let q = supabase.from('riker_memory')
    .select('content, priority, created_at, updated_at, location_id')
    .eq('archived', false)
    .eq('category', 'short_term_desk')
    .gte('updated_at', since)
    .order('priority', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(20)
  const { data } = await q
  if (!data || !data.length) return ''
  const lines = data.map(n => {
    const ageHrs = Math.round((Date.now() - new Date(n.updated_at).getTime()) / 3600000)
    const ageStr = ageHrs < 1 ? 'just now' : ageHrs === 1 ? '1h ago' : `${ageHrs}h ago`
    return `  • [${ageStr}] ${String(n.content).replace(/\s+/g, ' ').trim()}`
  })
  return 'DESK NOTES (short-term, last 48h — Riker\'s own stickies):\n' + lines.join('\n')
}

// ═══════════════════════════════════════════════════════════════
// OPEN THREADS — conversations active in the last 24 hours
// ═══════════════════════════════════════════════════════════════
// Pulls conversations (SMS + email) and riker_sessions (website/portal/app)
// where something moved in the last 24h. Snippets the latest message each.

async function _buildOpenThreads(supabase, now) {
  const since = new Date(now.getTime() - OPEN_THREADS_WINDOW_MIN * 60000).toISOString()

  const [{ data: convs }, { data: sess }] = await Promise.all([
    supabase.from('conversations')
      .select('id, channel, phone, email, customer_name, location_id, last_message_at, status')
      .gte('last_message_at', since)
      .eq('status', 'active')
      .order('last_message_at', { ascending: false })
      .limit(12),
    supabase.from('riker_sessions')
      .select('id, context, customer_name, customer_phone, customer_email, location_id, messages, updated_at')
      .gte('updated_at', since)
      .in('context', ['website', 'portal', 'app'])
      .eq('status', 'active')
      .order('updated_at', { ascending: false })
      .limit(8)
  ])

  const lines = []

  if (convs && convs.length) {
    // Pull the newest message per conversation in a single query
    const convIds = convs.map(c => c.id)
    const { data: recentMsgs } = await supabase.from('messages')
      .select('conversation_id, direction, body, created_at, channel')
      .in('conversation_id', convIds)
      .order('created_at', { ascending: false })
      .limit(convIds.length * 3)
    const lastByConv = new Map()
    for (const m of (recentMsgs || [])) {
      if (!lastByConv.has(m.conversation_id)) lastByConv.set(m.conversation_id, m)
    }
    for (const c of convs) {
      const last = lastByConv.get(c.id)
      const who = c.customer_name || c.phone || c.email || 'unknown'
      const age = _ageLabel(c.last_message_at, now)
      const snippet = last ? _snippet(last.body) : ''
      const arrow = last?.direction === 'inbound' ? '→' : last?.direction === 'outbound' ? '←' : '·'
      lines.push(`  [${c.channel}] ${who} — ${age}. Last ${arrow} "${snippet}"`)
    }
  }

  if (sess && sess.length) {
    for (const s of sess) {
      const who = s.customer_name || s.customer_phone || s.customer_email || s.context
      const age = _ageLabel(s.updated_at, now)
      const msgs = Array.isArray(s.messages) ? s.messages : []
      const lastUser = [...msgs].reverse().find(m => m.role === 'user')
      const snippet = lastUser ? _snippet(lastUser.content) : '(opened session, no message yet)'
      lines.push(`  [${s.context}] ${who} — ${age}. Last → "${snippet}"`)
    }
  }

  if (!lines.length) return ''
  return 'OPEN THREADS (active conversations, last 24h):\n' + lines.join('\n')
}

// ═══════════════════════════════════════════════════════════════
// LIVE TRANSCRIPT — verbatim cross-channel messages, last 2 hours
// ═══════════════════════════════════════════════════════════════
// Phase 6c: NO summarization. Riker sees the actual words that passed
// between customers and Riker across every channel, with timestamps and
// who's talking. This is how "one single flow" shows up at the prompt
// level — when Jon asks "what did Brandon say this morning", Riker has
// the literal reply, not a paraphrase.
//
// Window: 2h. Per message cap: 600 chars (covers 95% of SMS+email without
// ballooning prompt cost). Max 25 messages — plenty for a busy morning,
// bounded for cost.

async function _buildLiveTranscript(supabase, now) {
  const since = new Date(now.getTime() - ACTIVITY_WINDOW_MIN * 60000).toISOString()
  const { data: msgs } = await supabase.from('messages')
    .select('id, direction, channel, body, created_at, email_subject, email_from, conversation:conversations(customer_name, phone, email)')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(25)
  if (!msgs || !msgs.length) return ''

  const chrono = [...msgs].reverse()  // oldest first so the transcript reads top-down
  const lines = chrono.map(m => {
    const who = m.conversation?.customer_name || m.conversation?.phone || m.conversation?.email || m.email_from || '?'
    const speaker = m.direction === 'inbound' ? who : 'Riker → ' + who
    const time = new Date(m.created_at).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true })
    const kind = m.channel === 'email' ? 'email' : 'sms'
    const subj = m.email_subject ? ` | ${_truncate(m.email_subject, 60)}` : ''
    // No aggressive truncation — keep the real words
    const body = _flatten(m.body, 600)
    return `[${time} ${kind}${subj}] ${speaker}: ${body}`
  })
  return `LIVE TRANSCRIPT (last ${ACTIVITY_WINDOW_MIN / 60}h, verbatim cross-channel):\n` + lines.join('\n')
}

// ═══════════════════════════════════════════════════════════════
// AUDIT TAIL — Phase 6d
// ═══════════════════════════════════════════════════════════════
// The ambient state-change stream. Every write through the app / portal /
// Riker goes through audit_log; we surface the last 30 rows so Riker can
// narrate "Mike marked the Wabi job complete 4 min ago, payment on
// invoice 1042 hit 30 sec ago". Also folds in new pending_confirmations
// and riker_interactions so the picture isn't limited to what's in
// audit_log.

async function _buildAuditTail(supabase, now) {
  const since = new Date(now.getTime() - ACTIVITY_WINDOW_MIN * 60000).toISOString()
  const [
    { data: auditRows },
    { data: pendingRows },
    { data: interactionRows }
  ] = await Promise.all([
    supabase.from('audit_log')
      .select('id, action, entity_type, entity_id, actor, details, created_at')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(30),
    supabase.from('pending_confirmations')
      .select('id, customer_name, status, created_at, proposed_action')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(10),
    supabase.from('riker_interactions')
      .select('id, context, created_at, actions_succeeded')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(15)
  ])

  const events = []

  for (const a of (auditRows || [])) {
    const who = a.actor || 'system'
    const entity = a.entity_type ? `${a.entity_type}${a.entity_id ? ':' + String(a.entity_id).slice(0, 8) : ''}` : ''
    const act = a.action || 'change'
    let detail = ''
    if (a.details && typeof a.details === 'object') {
      const keys = Object.keys(a.details).slice(0, 4)
      if (keys.length) {
        detail = ' (' + keys.map(k => {
          const v = a.details[k]
          const vs = typeof v === 'object' ? JSON.stringify(v) : String(v)
          return `${k}=${_truncate(vs, 60)}`
        }).join(', ') + ')'
      }
    }
    events.push({ ts: a.created_at, line: `${who} ${act} ${entity}${detail}` })
  }

  for (const p of (pendingRows || [])) {
    const a = p.proposed_action || {}
    const biz = a.business_name || p.customer_name || '?'
    events.push({ ts: p.created_at, line: `pending-confirm ${p.status}: ${biz} ${a.scope ? '[' + (Array.isArray(a.scope) ? a.scope.join(',') : a.scope) + ']' : ''} ${a.scheduled_date || a.date || ''} ${a.scheduled_time || a.time || ''}`.trim() })
  }

  for (const i of (interactionRows || [])) {
    const acts = Array.isArray(i.actions_succeeded) ? i.actions_succeeded.filter(x => x.ok !== false).map(x => x.type) : []
    if (acts.length) {
      events.push({ ts: i.created_at, line: `riker[${i.context}] ran: ${acts.slice(0, 6).join(', ')}${acts.length > 6 ? ` +${acts.length - 6}` : ''}` })
    }
  }

  if (!events.length) return ''
  events.sort((a, b) => new Date(b.ts) - new Date(a.ts))
  const lines = events.slice(0, 30).map(e => {
    const dt = new Date(e.ts)
    const timeStr = dt.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true })
    return `  ${timeStr}  · ${e.line}`
  })
  return `AUDIT TAIL (last ${ACTIVITY_WINDOW_MIN / 60}h, state changes across the business):\n` + lines.join('\n')
}

// Legacy name kept for back-compat with any external import.
async function _buildRecentActivity(supabase, now) {
  return _buildAuditTail(supabase, now)
}

// ═══════════════════════════════════════════════════════════════
// UNREAD INBOX — emails awaiting reply
// ═══════════════════════════════════════════════════════════════

async function _buildUnreadInbox(supabase) {
  const { data } = await supabase.from('email_inbox')
    .select('id, received_at, from_email, from_name, subject, preview, needs_reply, location_id')
    .is('read_at', null)
    .eq('needs_reply', true)
    .order('received_at', { ascending: false })
    .limit(8)
  if (!data || !data.length) return ''
  const lines = data.map(e => {
    const who = e.from_name ? `${e.from_name} <${e.from_email}>` : e.from_email
    const age = _ageLabel(e.received_at, new Date())
    return `  • ${age} — ${who}: ${e.subject || '(no subject)'} · "${_snippet(e.preview || '')}"`
  })
  return `UNREAD EMAIL (needs reply — ${data.length}):\n` + lines.join('\n')
}

// ═══════════════════════════════════════════════════════════════
// PENDING DRAFTS — Riker wrote an email, waiting for Jon to OK
// ═══════════════════════════════════════════════════════════════

async function _buildPendingDrafts(supabase) {
  const { data } = await supabase.from('email_drafts')
    .select('id, to_email, subject, body, created_at, reasoning')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(5)
  if (!data || !data.length) return ''
  const lines = data.map(d => {
    const age = _ageLabel(d.created_at, new Date())
    return `  • ${age} — to ${d.to_email}: ${d.subject} · "${_snippet(d.body)}" [draft_id ${d.id.slice(0, 8)}]`
  })
  return `DRAFTED EMAILS AWAITING JON (${data.length}):\n` + lines.join('\n')
}

// ─── utils ───
function _snippet(s, n = 90) {
  if (!s) return ''
  const one = String(s).replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}
function _truncate(s, n = 50) {
  if (!s) return ''
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
// Phase 6c: keep real newlines and spacing; only collapse runs of blank
// lines. This preserves the "shape" of emails and multi-line SMS without
// letting a pathological message blow the block out.
function _flatten(s, n = 600) {
  if (!s) return ''
  const cleaned = String(s).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return cleaned.length > n ? cleaned.slice(0, n - 1) + '…' : cleaned
}
function _ageLabel(ts, now = new Date()) {
  if (!ts) return '?'
  const mins = Math.round((now.getTime() - new Date(ts).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  return `${days}d ago`
}

module.exports = {
  buildRikersDesk,
  // exported for tests / targeted reuse
  _buildBusinessPulse,
  _buildDeskNotes,
  _buildOpenThreads,
  _buildLiveTranscript,
  _buildAuditTail,
  _buildRecentActivity,   // legacy alias → _buildAuditTail
  _buildUnreadInbox,
  _buildPendingDrafts
}
