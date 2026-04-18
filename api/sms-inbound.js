// /api/sms-inbound.js
// Twilio webhook — receives inbound SMS, dispatches to Riker core.
//
// Twilio Messaging -> Webhook URL: https://stephensadvanced.com/api/sms-inbound
// HTTP POST, Content-Type: application/x-www-form-urlencoded

const { createClient } = require('@supabase/supabase-js')
const crypto = require('crypto')
const core = require('./riker-core')
const { sendSMS, JON_PHONE } = require('./riker-actions')

function normalizePhone(raw) {
  if (!raw) return null
  let p = String(raw).replace(/[\s\-\(\)\.]/g, '')
  if (!p.startsWith('+')) p = '+1' + p.replace(/^1/, '')
  return p
}

function verifyTwilioSignature(req, url) {
  const authToken = process.env.TWILIO_AUTH_TOKEN
  const signature = req.headers['x-twilio-signature'] || req.headers['X-Twilio-Signature']
  if (!authToken || !signature) return false
  const params = req.body || {}
  const sortedKeys = Object.keys(params).sort()
  let data = url
  for (const k of sortedKeys) data += k + params[k]
  const expected = crypto.createHmac('sha1', authToken).update(data).digest('base64')
  try { return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) }
  catch { return false }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('POST only')

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://motjasdokoxwiodwzyps.supabase.co'
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  const supabase = createClient(sbUrl, sbKey)

  if (process.env.RIKER_SKIP_TWILIO_SIG !== 'true') {
    const proto = req.headers['x-forwarded-proto'] || 'https'
    const host = req.headers['x-forwarded-host'] || req.headers.host
    const url = `${proto}://${host}${req.url}`
    if (!verifyTwilioSignature(req, url)) {
      console.warn('[sms-inbound] signature failed')
      return res.status(403).send('Invalid signature')
    }
  }

  const from = normalizePhone(req.body.From)
  const body = (req.body.Body || '').trim()
  const messageSid = req.body.MessageSid
  if (!from || !body) return res.status(400).send('Missing From or Body')

  try {
    const isJon = from === JON_PHONE
    const context = isJon ? 'sms_jon' : 'sms_customer'
    const party = isJon ? 'jon' : 'customer'

    // Find or create conversation
    let { data: conv } = await supabase
      .from('conversations').select('*')
      .eq('channel', 'sms').eq('phone', from).eq('status', 'active')
      .order('last_message_at', { ascending: false }).limit(1).maybeSingle()

    if (!conv) {
      let locationId = null, customerName = null
      if (!isJon) {
        const { data: loc } = await supabase.from('locations').select('id, name, contact_name').eq('contact_phone', from).limit(1).maybeSingle()
        if (loc) { locationId = loc.id; customerName = loc.contact_name || loc.name }
      }
      const { data: newConv } = await supabase.from('conversations').insert({
        channel: 'sms', phone: from, party,
        location_id: locationId, customer_name: customerName,
        status: 'active'
      }).select().single()
      conv = newConv
    }

    // Log inbound in messages (append-only audit)
    await supabase.from('messages').insert({
      conversation_id: conv.id,
      direction: 'inbound', channel: 'sms',
      body, twilio_sid: messageSid
    })

    // Mirror into riker_sessions so memory extraction + continuity can run off
    // a unified session object. Keyed by (context, phone, status='active').
    const rikerSession = await core.upsertRikerSessionForChannel({
      supabase, context,
      phone: from,
      party,
      locationId: conv.location_id || null,
      customerName: conv.customer_name || null
    })
    if (rikerSession) {
      await core.appendToRikerSession(supabase, rikerSession.id, 'user', body, { channel: 'sms', twilio_sid: messageSid })
    }

    // Dispatch to core
    const result = await core.processMessage({
      supabase, context,
      sessionKey: conv.id,
      sessionStorage: 'conversations',
      identity: {
        phone: from,
        location_id: conv.location_id,
        customer_name: conv.customer_name
      },
      message: body,
      inboundAlreadyLogged: true,
      rikerSessionId: rikerSession?.id
    })

    // Mirror the outbound into riker_sessions + bump stats
    if (rikerSession && result.reply) {
      await core.appendToRikerSession(supabase, rikerSession.id, 'assistant', result.reply, { channel: 'sms' })
      await core.bumpSessionStats(supabase, rikerSession.id, {
        usage: { input_tokens: 0, output_tokens: 0 },  // token counts already in riker_interactions; skip double-counting here
        cost: result.cost || 0,
        actions: result.actions_taken || []
      })
    }

    // Core's adapter already logged the outbound to `messages`; send the actual SMS
    if (result.reply) {
      try { await sendSMS(from, result.reply) }
      catch (e) { console.error('[sms-inbound] send failed:', e.message) }
    }

    // Memory extraction — every Nth inbound turn, Claude distills durable facts
    if (rikerSession) {
      const { data: sessAfter } = await supabase.from('riker_sessions').select('messages').eq('id', rikerSession.id).maybeSingle()
      const inboundTurns = (sessAfter?.messages || []).filter(m => m.role === 'user').length
      if (inboundTurns > 0 && inboundTurns % core.MEMORY_EXTRACT_EVERY_N_INBOUND === 0) {
        // Synchronous — SMS latency gets +1-2s every Nth turn, acceptable for getting memory persisted reliably
        try { await core.extractMemoryFromSession(supabase, rikerSession.id) }
        catch (e) { console.error('[sms-inbound] memory extract failed:', e.message) }
      }
    }

    res.setHeader('Content-Type', 'text/xml')
    return res.status(200).send('<Response></Response>')

  } catch (e) {
    console.error('[sms-inbound] error:', e)
    return res.status(500).send('Internal error: ' + e.message)
  }
}
