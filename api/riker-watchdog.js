// /api/riker-watchdog.js
// Supabase database webhook destination. Fires whenever a watched table
// (jobs, invoices, locations, messages, mazon_queue) is inserted /
// updated / deleted. Most events are silent — the endpoint asks a cheap
// Claude call "is this worth flagging Jon about?" and only texts when
// the answer is yes.
//
// Examples of what it should catch:
//   - A job scheduled on a William-pickup day
//   - An invoice whose total is an order of magnitude above Jon's avg
//   - A location contact_phone that changed unexpectedly
//   - A customer SMS that reads as an emergency / complaint
//   - A Mazon rejection
//
// What it should NOT flag:
//   - Routine inserts (new jobs on weekdays, normal invoices, acks)
//   - Changes Jon just made himself via the app (actor === 'jon')
//
// Setup (one-time, in Supabase dashboard):
//   Database → Webhooks → Create a new webhook
//   Name: riker-watchdog-jobs   Table: jobs   Events: Insert, Update
//   Type: HTTP Request
//   URL: https://stephensadvanced.com/api/riker-watchdog
//   HTTP Headers: Authorization: Bearer <RIKER_WATCHDOG_SECRET>
//   Repeat for: invoices, locations, mazon_queue, messages
//
// Rate-limit guard: if Jon got a watchdog SMS in the last 5 min for the
// same entity_id, skip (prevents spam from rapid edits).

const { createClient } = require('@supabase/supabase-js')

const JON_PHONE = '+12149944799'
const RATE_WINDOW_MS = 5 * 60 * 1000

const WATCHED_TABLES = new Set(['jobs', 'invoices', 'locations', 'messages', 'mazon_queue'])

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  // Auth: Supabase webhooks send a custom header we set up in the dashboard
  const expected = process.env.RIKER_WATCHDOG_SECRET
  if (expected) {
    const got = req.headers.authorization || ''
    if (got !== `Bearer ${expected}`) return res.status(401).json({ error: 'unauthorized' })
  }

  const { table, type, record, old_record } = req.body || {}
  if (!table || !type) return res.status(400).json({ error: 'missing table or type' })
  if (!WATCHED_TABLES.has(table)) return res.status(200).json({ ok: true, skipped: 'not-watched' })

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://motjasdokoxwiodwzyps.supabase.co'
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!sbKey) return res.status(500).json({ error: 'no service key' })
  const supabase = createClient(sbUrl, sbKey)

  try {
    const verdict = await classifyEvent({ table, type, record, old_record })
    if (!verdict.flag) return res.status(200).json({ ok: true, flagged: false })

    // Rate limit — did we already text Jon about this entity_id recently?
    const entityId = record?.id || old_record?.id
    if (entityId) {
      const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString()
      const { data: recent } = await supabase.from('riker_interactions')
        .select('id').eq('context', 'watchdog')
        .like('user_message', `%${entityId}%`)
        .gte('created_at', since).limit(1)
      if (recent && recent.length) return res.status(200).json({ ok: true, flagged: false, skipped: 'rate-limited' })
    }

    // Text Jon
    await sendToJon(verdict.message)

    // Log as a pseudo-interaction so the rate limit works + so debug tooling
    // (/api/riker-last) surfaces watchdog activity.
    await supabase.from('riker_interactions').insert({
      context: 'watchdog',
      session_source: 'watchdog',
      user_message: `${table}:${type} ${entityId || ''} ${JSON.stringify(record).slice(0, 400)}`,
      reply: verdict.message,
      model: 'claude-haiku-4-5-20251001'
    }).then(() => {}).catch(() => {})

    return res.status(200).json({ ok: true, flagged: true, message: verdict.message })
  } catch (err) {
    console.error('[riker-watchdog]', err)
    return res.status(500).json({ error: err.message })
  }
}

// Ask Haiku whether the diff is worth surfacing. Returns {flag, message}.
async function classifyEvent({ table, type, record, old_record }) {
  const key = process.env.CLAUDE_KEY
  if (!key) return { flag: false }

  // Cheap pre-filter: ignore events where actor is clearly Jon via the app
  // (those are deliberate, not surprises). We can extend this if we start
  // recording actor on more tables.
  if (record?.actor === 'jon' || record?.source === 'ai_chat') {
    return { flag: false }
  }

  // Build a compact diff summary for the prompt
  const changed = old_record && record
    ? Object.keys(record).filter(k => JSON.stringify(record[k]) !== JSON.stringify(old_record[k]))
    : null

  const prompt = `You are an anomaly-watch system for a DFW fire-suppression company. A database event just fired. Decide: is this worth an immediate SMS to the owner (Jon)?

Flag only if the event is:
- unusually large (invoice total >5x normal, unusual amount change)
- potentially misconfigured (job scheduled on a weekend, unusual city, missing fields)
- a customer emergency signal (inbound message with "fire", "emergency", "911", "broken", "leak")
- an unexpected status regression (invoice paid → unpaid, job completed → scheduled)
- a contact-data change on a client (phone/email replaced) that might be mistaken identity
- a Mazon rejection

Do NOT flag:
- routine inserts (new jobs on normal days, standard invoices)
- edits Jon clearly made deliberately (source:'ai_chat' or actor:'jon')
- draft statuses, typical amounts, expected updates

Event:
TABLE: ${table}
OP: ${type}
${changed ? 'CHANGED_FIELDS: ' + changed.join(', ') + '\n' : ''}RECORD: ${JSON.stringify(record || {}, null, 0).slice(0, 800)}
${old_record ? 'OLD: ' + JSON.stringify(old_record || {}, null, 0).slice(0, 400) : ''}

Respond with JSON only: {"flag": true|false, "message": "<under 160 chars; only when flag:true>"}`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      })
    })
    if (!res.ok) return { flag: false }
    const data = await res.json()
    const txt = (data.content?.[0]?.text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '')
    let parsed
    try { parsed = JSON.parse(txt) } catch { return { flag: false } }
    if (!parsed?.flag) return { flag: false }
    return { flag: true, message: String(parsed.message || '').slice(0, 320) }
  } catch (e) {
    return { flag: false }
  }
}

async function sendToJon(body) {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_FROM_NUMBER
  if (!sid || !token || !from) return
  const auth = Buffer.from(sid + ':' + token).toString('base64')
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: JON_PHONE, From: from, Body: '👁  ' + body }).toString()
  })
}
