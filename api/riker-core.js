// /api/riker-core.js
// Tool-use architecture — one cached identity prompt + Claude fetches data
// on demand via tools. Replaces the old buildLiveData prompt-stuffing loop.
//
// Entry point: processMessage({ ... }) — signature preserved so all endpoint
// handlers (riker.js, sms-inbound.js, email-inbound.js, claude.js) work
// without changes.
//
// Flow:
//   1. Resolve session (adapter pattern stays)
//   2. For riker_sessions with !inboundAlreadyLogged, append inbound to
//      session.messages
//   3. Load history (sanitized — poisoned one-word replies dropped)
//   4. Read relevant memory entries into a tiny notebook block
//   5. Build system prompt: cached identity + non-cached notebook block
//   6. Filter tools by context
//   7. Run tool-use loop (up to 10 turns)
//   8. Force non-empty reply — synthesize from tool calls if Claude went quiet
//   9. Save assistant reply via adapter
//  10. Log to riker_interactions
//  11. Return { reply, actions_taken, client_hints, session_id, cost, ... }

const memory = require('./riker-memory')
const { RIKER_IDENTITY, buildIdentity } = require('./riker-prompts')
const tools = require('./riker-tools')

const CLAUDE_MODEL = 'claude-sonnet-4-6'
const CLAUDE_PRICE_INPUT = 3.0 / 1_000_000
const CLAUDE_PRICE_OUTPUT = 15.0 / 1_000_000
const CLAUDE_PRICE_CACHE_READ = 0.30 / 1_000_000
const CLAUDE_PRICE_CACHE_WRITE = 3.75 / 1_000_000
const MAX_TOOL_TURNS = 10
const MEMORY_EXTRACT_EVERY_N_INBOUND = 4

// ═══════════════════════════════════════════════════════════════
// SESSION HELPERS — riker_sessions mirroring for SMS/email
// ═══════════════════════════════════════════════════════════════

async function upsertRikerSessionForChannel({ supabase, context, phone, email, party, locationId, billingAccountId, customerName }) {
  let q = supabase.from('riker_sessions').select('*').eq('context', context).eq('status', 'active')
  if (phone) q = q.eq('customer_phone', phone)
  else if (email) q = q.eq('customer_email', email)
  const { data: existing } = await q.order('updated_at', { ascending: false }).limit(1).maybeSingle()
  if (existing) {
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

async function appendToRikerSession(supabase, sessionId, role, content, meta = {}) {
  if (!sessionId || content == null) return
  const { data: sess } = await supabase.from('riker_sessions').select('messages').eq('id', sessionId).maybeSingle()
  const msgs = Array.isArray(sess?.messages) ? sess.messages : []
  msgs.push({ role, content, ts: new Date().toISOString(), ...meta })
  await supabase.from('riker_sessions').update({
    messages: msgs,
    updated_at: new Date().toISOString()
  }).eq('id', sessionId)
}

async function bumpSessionStats(supabase, sessionId, { usage, cost, actions }) {
  if (!sessionId) return
  const { data: sess } = await supabase.from('riker_sessions')
    .select('total_input_tokens,total_output_tokens,total_cost_usd,actions_taken')
    .eq('id', sessionId).maybeSingle()
  const prev = Array.isArray(sess?.actions_taken) ? sess.actions_taken : []
  await supabase.from('riker_sessions').update({
    total_input_tokens: (sess?.total_input_tokens || 0) + (usage?.input_tokens || 0),
    total_output_tokens: (sess?.total_output_tokens || 0) + (usage?.output_tokens || 0),
    total_cost_usd: Number(sess?.total_cost_usd || 0) + Number(cost || 0),
    actions_taken: [...prev, ...(actions || []).map(a => ({ type: a.type, ok: a.ok !== false, ts: new Date().toISOString() }))],
    updated_at: new Date().toISOString()
  }).eq('id', sessionId)
}

function countInboundTurns(session) {
  return (Array.isArray(session?.messages) ? session.messages : [])
    .filter(m => m.role === 'user').length
}

// ═══════════════════════════════════════════════════════════════
// MEMORY EXTRACTION — unchanged from previous version
// ═══════════════════════════════════════════════════════════════
async function extractMemoryFromSession(supabase, sessionId) {
  try {
    const { data: session } = await supabase.from('riker_sessions').select('*').eq('id', sessionId).maybeSingle()
    if (!session) return { skipped: 'no session' }
    const msgs = Array.isArray(session.messages) ? session.messages : []
    if (!msgs.filter(m => m.role === 'user').length) return { skipped: 'no user turns' }
    const recent = msgs.slice(-24)
    const transcript = recent.map(m => `${m.role === 'user' ? (session.context === 'sms_jon' ? 'Jon' : 'Customer') : 'Riker'}: ${m.content}`).join('\n')
    const scopeHint = session.location_id ? `location_id ${session.location_id}` : session.billing_account_id ? `billing_account_id ${session.billing_account_id}` : 'global only'

    const extractionPrompt = `Extract durable facts worth remembering from this conversation. Output ONLY a JSON array.

CONTEXT: session type ${session.context}, ${scopeHint}${session.customer_name ? ', customer ' + session.customer_name : ''}

EXTRACT:
- Customer preferences ("prefers mornings", "bilingual")
- Relationships ("daughter handles scheduling")
- Equipment notes ("tank showing corrosion")
- Scheduling constraints ("closed Mondays", "gate code 4455")
- Billing notes ("pays by check, net 30")
- Pending items ("send insurance docs by May 1")
- Standing orders Jon issued ("from now on", "that's an order") → priority 10, prefix content with "STANDING ORDER:", no expiration

SKIP filler and things already captured as jobs/invoices.

EACH ENTRY:
  { "scope": "global|location|customer|job", "category": "preference|relationship|equipment_note|scheduling|billing|compliance|action_pending|route_note|internal", "content": "...", "priority": 1-10, "expires_at": "ISO (optional)" }

For scope=location the server fills location_id automatically.

If nothing worth remembering, output [].

TRANSCRIPT:
${transcript}`

    const claudeKey = process.env.CLAUDE_KEY
    if (!claudeKey) return { skipped: 'no CLAUDE_KEY' }
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: CLAUDE_MODEL, max_tokens: 1024,
        system: 'You output JSON arrays only. No prose, no markdown fences.',
        messages: [{ role: 'user', content: extractionPrompt }]
      })
    })
    const data = await res.json()
    if (!res.ok) return { error: data }
    let text = (data.content?.[0]?.text || '[]').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
    let entries
    try { entries = JSON.parse(text) } catch { return { error: 'parse_failed' } }
    if (!Array.isArray(entries)) return { error: 'not_array' }

    let written = 0
    for (const e of entries) {
      if (!e?.scope || !e?.category || !e?.content) continue
      const row = {
        scope: e.scope, category: e.category,
        content: String(e.content).slice(0, 4000),
        priority: Math.max(1, Math.min(10, Number(e.priority) || 5)),
        expires_at: e.expires_at || null,
        auto_generated: true,
        source: 'memory_extraction:' + session.context,
        source_session_id: sessionId
      }
      if (e.scope === 'location' && session.location_id) row.location_id = session.location_id
      if (session.billing_account_id) row.billing_account_id = session.billing_account_id
      if (session.tech_id) row.tech_id = session.tech_id
      const { data: dup } = await supabase.from('riker_memory')
        .select('id, priority').eq('archived', false)
        .eq('scope', row.scope).eq('category', row.category).eq('content', row.content)
        .limit(1).maybeSingle()
      if (dup) {
        if (row.priority > dup.priority) {
          await supabase.from('riker_memory').update({ priority: row.priority, updated_at: new Date().toISOString() }).eq('id', dup.id)
        }
        continue
      }
      const { error: insErr } = await supabase.from('riker_memory').insert(row)
      if (!insErr) written++
    }
    return { written, total_proposed: entries.length }
  } catch (e) {
    console.error('[extract-memory] error:', e)
    return { error: e.message }
  }
}

// ═══════════════════════════════════════════════════════════════
// SESSION ADAPTER — bridges riker_sessions and conversations/messages
// ═══════════════════════════════════════════════════════════════

function isPoisonedAssistant(content) {
  if (!content) return true
  const t = String(content).trim()
  return t.length <= 5 && /^(done\.?|ok\.?|k\.?)$/i.test(t)
}
function sanitizeHistory(msgs) {
  return (msgs || []).filter(m => m.role === 'user' || !isPoisonedAssistant(m.content))
}

function makeSessionAdapter({ storage, supabase, sessionKey }) {
  if (storage === 'riker_sessions') {
    return {
      storage,
      async load() {
        const { data } = await supabase.from('riker_sessions').select('*').eq('id', sessionKey).maybeSingle()
        return data
      },
      async loadHistoryAsMessages(session) {
        return sanitizeHistory((session.messages || []).map(m => ({
          role: m.role === 'user' || m.role === 'assistant' ? m.role : (m.role === 'inbound' ? 'user' : 'assistant'),
          content: m.content
        })))
      },
      async appendInbound(_session, body) {
        await appendToRikerSession(supabase, sessionKey, 'user', body)
      },
      async appendOutbound(_session, body, meta = {}) {
        await appendToRikerSession(supabase, sessionKey, 'assistant', body, meta)
      }
    }
  }
  return {
    storage,
    async load() {
      const { data } = await supabase.from('conversations').select('*').eq('id', sessionKey).maybeSingle()
      return data
    },
    async loadHistoryAsMessages() {
      const { data: msgs } = await supabase.from('messages')
        .select('direction, body').eq('conversation_id', sessionKey).order('created_at', { ascending: true })
      const filtered = (msgs || []).filter(m => m.direction === 'inbound' || !isPoisonedAssistant(m.body))
      const out = []
      for (const m of filtered) {
        const role = m.direction === 'inbound' ? 'user' : 'assistant'
        if (out.length && out[out.length - 1].role === role) {
          out[out.length - 1].content += '\n' + m.body
        } else {
          out.push({ role, content: m.body })
        }
      }
      return out
    },
    async appendInbound() { /* webhook logged it */ },
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
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// NOTEBOOK BLOCK — small system-prompt addendum with relevant memories
// ═══════════════════════════════════════════════════════════════

async function buildNotebookBlock({ supabase, context, identity }) {
  const entries = await memory.readRelevantMemories({
    supabase, context,
    locationId: identity?.location_id,
    billingAccountId: identity?.billing_account_id,
    techId: identity?.tech_id
  })
  if (!entries || !entries.length) return { block: '', count: 0 }
  // Prioritize standing orders at the top, then by priority
  const sorted = [...entries].sort((a, b) => {
    const aStand = /^STANDING ORDER:/i.test(a.content || '') ? 1 : 0
    const bStand = /^STANDING ORDER:/i.test(b.content || '') ? 1 : 0
    if (aStand !== bStand) return bStand - aStand
    return (b.priority || 0) - (a.priority || 0)
  })
  // Cap the block — if somehow memory balloons, don't blow up the prompt.
  // Each entry is ~30-50 tokens. 80 entries → ~4000 tokens max.
  const capped = sorted.slice(0, 80)
  const lines = capped.map(m => {
    const flag = /^STANDING ORDER:/i.test(m.content) ? '[ORDER p' + m.priority + '] ' : '[' + m.category + ' p' + m.priority + '] '
    return '- ' + flag + String(m.content).replace(/\s+/g, ' ').trim()
  })
  return {
    block: 'NOTEBOOK (persistent memory — treat STANDING ORDERs as hard rules):\n' + lines.join('\n'),
    count: capped.length
  }
}

// ═══════════════════════════════════════════════════════════════
// CLAUDE TOOL-USE LOOP
// ═══════════════════════════════════════════════════════════════

async function callClaudeWithTools({ systemBlocks, messages, toolSchemas, toolCtx, maxTurns = MAX_TOOL_TURNS, onCost }) {
  const claudeKey = process.env.CLAUDE_KEY
  if (!claudeKey) throw new Error('CLAUDE_KEY not set')

  const convo = [...messages]
  const actionsTaken = []
  const clientHints = []
  let usageTotal = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  let finalText = ''
  let turns = 0
  let totalLatencyMs = 0

  for (let turn = 0; turn < maxTurns; turn++) {
    turns++
    const startT = Date.now()
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1500,
        system: systemBlocks,
        messages: convo,
        tools: toolSchemas
      })
    })
    totalLatencyMs += Date.now() - startT
    const data = await res.json()
    if (!res.ok) {
      throw new Error('Claude API ' + res.status + ': ' + (data.error?.message || JSON.stringify(data).slice(0, 500)))
    }

    // Accumulate usage
    const u = data.usage || {}
    usageTotal.input_tokens += u.input_tokens || 0
    usageTotal.output_tokens += u.output_tokens || 0
    usageTotal.cache_read_input_tokens += u.cache_read_input_tokens || 0
    usageTotal.cache_creation_input_tokens += u.cache_creation_input_tokens || 0

    const content = data.content || []
    const toolUses = content.filter(b => b.type === 'tool_use')
    const textParts = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()

    if (toolUses.length === 0) {
      // Claude is done
      finalText = textParts
      break
    }

    // Preserve any narrative text Claude emitted alongside tool calls — accumulate
    if (textParts) {
      finalText = finalText ? finalText + '\n' + textParts : textParts
    }

    // Add the assistant turn (with tool_use blocks) to the convo
    convo.push({ role: 'assistant', content })

    // Execute each tool call, build tool_result blocks
    const toolResults = []
    for (const tu of toolUses) {
      const result = await tools.executeToolCall(tu.name, tu.input || {}, toolCtx)
      actionsTaken.push({
        type: tu.name,
        input: tu.input,
        ok: !result?.error,
        detail: result?.error ? result.error : summarizeResult(result)
      })
      // Surface UI-intent results to the client (if any tool added clientHint)
      if (result?.clientHint) clientHints.push(result.clientHint)
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
        ...(result?.error ? { is_error: true } : {})
      })
    }
    convo.push({ role: 'user', content: toolResults })
  }

  if (!finalText) {
    // Loop exited without Claude producing final text — this is rare, happens
    // if max_turns is hit while still asking for tools. Surface diagnostic.
    finalText = actionsTaken.length
      ? 'Kept going in tool-use loop without concluding. Tools invoked: ' + actionsTaken.map(a => a.type).join(', ')
      : ''
  }

  if (onCost) {
    const cost = (usageTotal.input_tokens * CLAUDE_PRICE_INPUT)
      + (usageTotal.output_tokens * CLAUDE_PRICE_OUTPUT)
      + (usageTotal.cache_read_input_tokens * CLAUDE_PRICE_CACHE_READ)
      + (usageTotal.cache_creation_input_tokens * CLAUDE_PRICE_CACHE_WRITE)
    onCost(cost, usageTotal)
  }

  return { text: finalText, usage: usageTotal, actionsTaken, clientHints, turns, latencyMs: totalLatencyMs }
}

// Trim a tool result so the interactions log stays compact
function summarizeResult(r) {
  if (!r || typeof r !== 'object') return null
  if (r.count != null) return { count: r.count, ok: true }
  if (r.ok) return { ok: true }
  return null
}

// ═══════════════════════════════════════════════════════════════
// REPLY GUARD — never return an empty or useless single-word reply
// ═══════════════════════════════════════════════════════════════

function guardReply(text, actionsTaken) {
  const isUseless = !text || !text.trim() || /^(done\.?|ok\.?|k\.?)$/i.test(text.trim())
  if (!isUseless) return text.trim()

  const okActions = (actionsTaken || []).filter(a => a.ok).map(a => a.type)
  if (okActions.length) {
    const summary = okActions.map(t => {
      const map = {
        lookup_client: 'Pulled up the client',
        query_jobs: 'Checked jobs',
        get_invoices: 'Checked invoices',
        get_schedule_slots: 'Checked the schedule',
        get_equipment: 'Pulled equipment list',
        get_pending_confirmations: 'Checked pending',
        get_today_summary: 'Looked at today',
        read_memory: 'Checked the notebook',
        write_memory: 'Noted to memory',
        delete_memory: 'Removed from memory',
        add_client: 'Client added',
        add_todo: 'To-do added',
        schedule_job: 'Scheduled',
        approve_pending: 'Approved',
        reject_pending: 'Rejected',
        send_sms: 'Text sent',
        mark_invoice_paid: 'Marked paid',
        get_rate_card: 'Pulled rate card',
        get_todos: 'Pulled to-dos'
      }
      return map[t] || t
    })
    return summary.join('. ') + '.'
  }
  return "I'm here. What do you need — schedule something, look up a client, check an invoice?"
}

// ═══════════════════════════════════════════════════════════════
// MAIN — processMessage
// ═══════════════════════════════════════════════════════════════

async function processMessage({
  supabase,
  context,
  sessionKey,
  sessionStorage,
  identity = {},
  message,
  attachments,
  inboundAlreadyLogged = true,
  rikerSessionId
}) {
  const started = Date.now()
  const adapter = makeSessionAdapter({ storage: sessionStorage, supabase, sessionKey })
  const session = await adapter.load()
  if (!session) throw new Error(`Session not found: ${sessionKey} in ${sessionStorage}`)

  // Append inbound for riker_sessions storage if webhook hasn't already
  if (sessionStorage === 'riker_sessions' && message && !inboundAlreadyLogged) {
    await adapter.appendInbound(session, message)
  }

  // Notebook (small block, not cached)
  const { block: notebookBlock, count: memCount } = await buildNotebookBlock({ supabase, context, identity })

  // Identity (cached)
  const today = new Date().toISOString().split('T')[0]
  const identityText = buildIdentity({ context, today })

  const systemBlocks = [
    { type: 'text', text: identityText, cache_control: { type: 'ephemeral' } }
  ]
  if (notebookBlock) systemBlocks.push({ type: 'text', text: notebookBlock })

  // History for Claude
  let history = await adapter.loadHistoryAsMessages(session)

  // If Claude expects the inbound message but it isn't in history yet (edge
  // case: conversations storage where webhook did log inbound, or riker_sessions
  // where we just appended it — ensure history trails with a user turn)
  const needsUserTail = !history.length || history[history.length - 1].role !== 'user'
  if (needsUserTail && message) {
    history.push({ role: 'user', content: message })
  }
  // Claude requires the first message to be user
  if (history.length && history[0].role !== 'user') {
    history = [{ role: 'user', content: message || 'Continue.' }, ...history]
  }

  // Attach image attachments to the last user turn if provided
  if (attachments && attachments.length && history.length) {
    const last = history[history.length - 1]
    if (last.role === 'user') {
      last.content = [{ type: 'text', text: typeof last.content === 'string' ? last.content : '' }, ...attachments]
    }
  }

  // Filter tools by context
  const toolSchemas = tools.getToolsForContext(context)

  const effectiveRikerSessionId = rikerSessionId || (sessionStorage === 'riker_sessions' ? sessionKey : null)
  const toolCtx = {
    supabase, context, identity,
    sessionId: sessionKey,
    rikerSessionId: effectiveRikerSessionId,
    lastLocationId: identity.location_id || null,
    rawReply: null
  }

  // Run the tool-use loop
  let loopResult
  try {
    loopResult = await callClaudeWithTools({
      systemBlocks,
      messages: history,
      toolSchemas,
      toolCtx
    })
  } catch (e) {
    console.error('[riker-core] tool-use loop failed:', e)
    await logInteraction(supabase, {
      context, sessionKey, sessionStorage,
      userMessage: message,
      error: e.message,
      latency: Date.now() - started
    })
    return {
      reply: "I hit an error talking to the model — try again in a second.",
      actions_taken: [],
      client_hints: [],
      session_id: sessionKey,
      cost: 0,
      memories_read: memCount,
      error: e.message
    }
  }

  // Guard the reply
  const reply = guardReply(loopResult.text, loopResult.actionsTaken)

  // Save the assistant reply on the adapter
  try {
    await adapter.appendOutbound(session, reply, {
      channel: session.channel || (context === 'sms_customer' || context === 'sms_jon' ? 'sms' : context === 'email_customer' ? 'email' : 'web')
    })
  } catch (e) { console.error('[riker-core] appendOutbound failed:', e.message) }

  // Cost
  const usage = loopResult.usage
  const cost = (usage.input_tokens * CLAUDE_PRICE_INPUT)
    + (usage.output_tokens * CLAUDE_PRICE_OUTPUT)
    + (usage.cache_read_input_tokens * CLAUDE_PRICE_CACHE_READ)
    + (usage.cache_creation_input_tokens * CLAUDE_PRICE_CACHE_WRITE)

  // Log interaction
  await logInteraction(supabase, {
    context, sessionKey, sessionStorage,
    userMessage: message,
    reply,
    actions_attempted: loopResult.actionsTaken.map(a => ({ type: a.type, input: a.input })),
    actions_succeeded: loopResult.actionsTaken,
    memory_writes: loopResult.actionsTaken.filter(a => a.type === 'write_memory' && a.ok).length,
    memory_reads: memCount,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read: usage.cache_read_input_tokens,
    cache_create: usage.cache_creation_input_tokens,
    cost,
    latency: loopResult.latencyMs,
    turns: loopResult.turns
  })

  return {
    reply,
    actions_taken: loopResult.actionsTaken,
    client_hints: loopResult.clientHints,
    session_id: sessionKey,
    cost,
    memories_read: memCount,
    turns: loopResult.turns
  }
}

// ═══════════════════════════════════════════════════════════════
// PROACTIVE — cron-authored messages (morning brief etc.)
// ═══════════════════════════════════════════════════════════════

async function generateProactive({ supabase, context, identity, instruction }) {
  const { data: session } = await supabase.from('riker_sessions').insert({
    context,
    tech_id: identity?.tech_id || null,
    location_id: identity?.location_id || null,
    billing_account_id: identity?.billing_account_id || null,
    messages: [{ role: 'user', content: instruction, ts: new Date().toISOString() }],
    status: 'closed'
  }).select().single()
  return processMessage({
    supabase, context,
    sessionKey: session.id,
    sessionStorage: 'riker_sessions',
    identity,
    message: instruction,
    inboundAlreadyLogged: true
  })
}

// ═══════════════════════════════════════════════════════════════
// INTERACTION LOG
// ═══════════════════════════════════════════════════════════════

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
  } catch (e) { console.error('[riker-core] interaction log failed:', e) }
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
