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

// ── Feedback detection ──────────────────────────────────────────────
// Returns {rating, note} or null. Recognizes 👍 / 👎 / "thumbs up" /
// "thumbs down" / ^(good|nice|perfect|nope|wrong|bad|missed)$ with an
// optional note trailing. Keep the grammar loose since Jon texts fast.
function detectFeedback(body) {
  if (!body) return null
  const t = String(body).trim()
  if (!t) return null
  // Emoji fast path
  if (t.startsWith('👍')) return { rating: 'up', note: t.replace(/^👍\s*/, '').trim() || null }
  if (t.startsWith('👎')) return { rating: 'down', note: t.replace(/^👎\s*/, '').trim() || null }
  // "thumbs up/down" + optional note
  const mUp = t.match(/^thumbs?\s*up\b[:.\-\s]*(.*)$/i)
  if (mUp) return { rating: 'up', note: (mUp[1] || '').trim() || null }
  const mDown = t.match(/^thumbs?\s*down\b[:.\-\s]*(.*)$/i)
  if (mDown) return { rating: 'down', note: (mDown[1] || '').trim() || null }
  // Single-word verdicts — only if the whole message is one of these
  if (/^(perfect|nice work|good call|nailed it)\.?!?$/i.test(t)) return { rating: 'up', note: null }
  if (/^(wrong|bad call|missed it|nope that's wrong|that was wrong)\.?!?$/i.test(t)) return { rating: 'down', note: null }
  return null
}

async function recordFeedback(supabase, { phone, rating, note }) {
  try {
    // Find Jon's most recent Riker interaction on any sms_jon or app session
    const { data: last } = await supabase.from('riker_interactions')
      .select('id, session_id, context, user_message, reply')
      .in('context', ['sms_jon', 'app'])
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    await supabase.from('riker_feedback').insert({
      interaction_id: last?.id || null,
      session_id: last?.session_id || null,
      context: last?.context || null,
      rating, note: note || null,
      user_message: last?.user_message || null,
      assistant_reply: last?.reply || null
    })
  } catch (e) {
    console.error('[sms-inbound] recordFeedback failed:', e.message)
  }
}

async function sendAckSMS(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_FROM_NUMBER
  if (!sid || !token || !from) return
  try {
    const auth = Buffer.from(sid + ':' + token).toString('base64')
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString()
    })
  } catch (e) { /* best effort */ }
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
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
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

    // ── Admin OTP ────────────────────────────────────────────────────
    // Jon texts the magic word → Riker generates a 6-digit OTP and SMS's
    // it back. Jon replies with the 6 digits → admin session confirmed.
    // This is the identity verification gate for elevated SMS commands.
    if (isJon) {
      const bodyLower = body.toLowerCase().trim()
      if (bodyLower === 'antidisestablishmentarianism' || /\badmin\s+access\b/i.test(body)) {
        const otp = String(Math.floor(100000 + Math.random() * 900000))
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
        await supabase.from('admin_otps').insert({ phone: from, code: otp, expires_at: expiresAt, used: false })
        await sendAckSMS(from, `Admin code: ${otp}\n(Expires in 10 min — reply with just the 6 digits)`)
        return res.status(200).send('<Response/>')
      }

      if (/^\d{6}$/.test(body.trim())) {
        const { data: otpRow } = await supabase.from('admin_otps')
          .select('id')
          .eq('phone', from)
          .eq('code', body.trim())
          .eq('used', false)
          .gt('expires_at', new Date().toISOString())
          .order('created_at', { ascending: false })
          .limit(1).maybeSingle()
        if (otpRow) {
          await supabase.from('admin_otps').update({ used: true }).eq('id', otpRow.id)
          await sendAckSMS(from, 'Admin verified. Full access active.')
          return res.status(200).send('<Response/>')
        }
        // Not a valid OTP — fall through to normal Riker processing
      }
    }

    // ── Cross-channel relay: Jon texting "RELAY: [answer]" ────────────
    // When the website bot escalated to Jon via escalate_to_jon, it texts
    // him with instructions to "Reply: RELAY: [answer]". This intercepts
    // that pattern, pushes Jon's answer into the customer's web session,
    // and marks the escalation resolved. Falls through if no open escalation.
    if (isJon) {
      const relayMatch = body.match(/^RELAY:\s*(.+)/si)
      if (relayMatch) {
        const answer = relayMatch[1].trim()
        const { data: esc } = await supabase.from('chat_escalations')
          .select('id, web_session_id')
          .eq('resolved', false)
          .order('created_at', { ascending: false })
          .limit(1).maybeSingle()
        if (esc) {
          // Push Jon's answer as an outbound assistant message in the web session
          await core.appendToRikerSession(supabase, esc.web_session_id, 'assistant', answer)
          await supabase.from('chat_escalations').update({
            resolved: true,
            jon_replied_at: new Date().toISOString(),
            jon_reply: answer
          }).eq('id', esc.id)
          await sendAckSMS(from, 'Sent — the customer will see your reply on the website.')
          return res.status(200).send('<Response/>')
        }
        // No open escalation — fall through so Riker handles it normally
      }
    }

    // ── Feedback signal ─────────────────────────────────────────────
    // Jon texting 👍 / 👎 / "thumbs up" / "thumbs down" (optionally with
    // a note) logs feedback against his most recent Riker interaction
    // rather than firing a new Claude turn. Short-circuits before the
    // normal message flow so we don't spend tokens processing the
    // reaction itself.
    if (isJon) {
      const fb = detectFeedback(body)
      if (fb) {
        await recordFeedback(supabase, { phone: from, rating: fb.rating, note: fb.note })
        await sendAckSMS(from, fb.rating === 'up' ? 'Noted — thanks.' : 'Noted. Logged the miss.')
        return res.status(200).send('<Response/>')
      }
    }

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
