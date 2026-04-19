// /api/scheduler-chat.js
// Website chat — powered by Riker core. Same brain as SMS, one shared notebook.
//
// POST { message, session_id? } → { reply, session_id, actions_taken }
//   Client stores session_id in localStorage and sends it back each turn.
//   New visitors get a new riker_session (context='website').
//
// GET  ?session_id=<uuid>&since=<iso-timestamp>
//   Returns new assistant messages since the given timestamp.
//   Used by the client to poll for Jon's relayed answers after an escalation.

const { createClient } = require('@supabase/supabase-js')
const core = require('./riker-core')

const JON_PHONE = '+12149944799'

// Claim patterns: "I'm Jon", "I'm the owner", "this is Jon Stephens", etc.
const OWNER_CLAIM_RE = /\b(i'?m\s+jon\b|i\s+am\s+jon\b|this\s+is\s+jon\b|i'?m\s+the\s+owner|i\s+am\s+the\s+owner|owner\s+access|admin\s+access|verify\s+(me|owner|identity|i'?m))\b/i

function makeSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL ||
    'https://motjasdokoxwiodwzyps.supabase.co'
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  return createClient(url, key)
}

async function sendOTPSMS(otp) {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_FROM_NUMBER
  if (!sid || !token || !from) return false
  try {
    const auth = Buffer.from(sid + ':' + token).toString('base64')
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        To: JON_PHONE, From: from,
        Body: `Verification code: ${otp}\n(Expires in 10 min — type it in the chat)`
      }).toString()
    })
    return r.ok
  } catch { return false }
}

module.exports = async function handler(req, res) {
  // ── Poll for new messages (Jon's relay replies, etc.) ─────────────────────
  if (req.method === 'GET') {
    const { session_id, since } = req.query || {}
    if (!session_id) return res.status(400).json({ error: 'session_id required' })

    const supabase = makeSupabase()
    const { data: sess } = await supabase.from('riker_sessions')
      .select('messages').eq('id', session_id).eq('context', 'website').maybeSingle()
    if (!sess) return res.status(404).json({ error: 'session not found' })

    const all = Array.isArray(sess.messages) ? sess.messages : []
    const assistant = all.filter(m => m.role === 'assistant')
    const fresh = since ? assistant.filter(m => m.ts && m.ts > since) : assistant
    return res.status(200).json({ messages: fresh })
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const { message, session_id } = req.body || {}
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: 'message required' })
  }

  const supabase = makeSupabase()
  const trimmed = String(message).trim()

  // ── Resolve or create website session ────────────────────────────────────
  let sessionId = null
  if (session_id) {
    const { data } = await supabase.from('riker_sessions')
      .select('id')
      .eq('id', session_id)
      .eq('context', 'website')
      .eq('status', 'active')
      .maybeSingle()
    if (data) sessionId = data.id
  }

  if (!sessionId) {
    const { data: created, error } = await supabase.from('riker_sessions').insert({
      context: 'website',
      messages: [],
      status: 'active'
    }).select('id').single()
    if (error || !created) {
      console.error('[scheduler-chat] session create failed:', error)
      return res.status(500).json({
        reply: "Something went wrong on our end. Please call (214) 994-4799 or try again.",
        session_id: null
      })
    }
    sessionId = created.id
  }

  // ── Owner claim — send OTP deterministically, don't rely on Claude ────────
  // Pattern-matched in code so it always fires regardless of Claude's mood.
  if (OWNER_CLAIM_RE.test(trimmed)) {
    const otp = String(Math.floor(100000 + Math.random() * 900000))
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
    await supabase.from('admin_otps').insert({ phone: JON_PHONE, code: otp, expires_at: expiresAt, used: false })
    const sent = await sendOTPSMS(otp)
    const reply = sent
      ? "I just texted a verification code to your registered number. Type the 6 digits here when you get it."
      : "Had trouble sending the SMS — please call (214) 994-4799 directly."
    await core.appendToRikerSession(supabase, sessionId, 'user', trimmed)
    await core.appendToRikerSession(supabase, sessionId, 'assistant', reply)
    return res.status(200).json({
      reply, session_id: sessionId,
      actions_taken: [{ type: 'request_owner_otp', ok: sent }]
    })
  }

  // ── 6-digit OTP reply — verify in code, don't rely on Claude ─────────────
  if (/^\d{6}$/.test(trimmed)) {
    const { data: row } = await supabase.from('admin_otps')
      .select('id')
      .eq('phone', JON_PHONE)
      .eq('code', trimmed)
      .eq('used', false)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1).maybeSingle()
    if (row) {
      await supabase.from('admin_otps').update({ used: true }).eq('id', row.id)
      // Write a short-lived memory so Riker knows this session is owner-verified
      await supabase.from('riker_memory').insert({
        scope: 'global',
        category: 'internal',
        content: `OWNER VERIFIED: website session ${sessionId} authenticated as Jon Stephens.`,
        priority: 10,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        auto_generated: true,
        source: 'owner_otp_verify'
      })
      const reply = "Verified — hey Jon. What do you need?"
      await core.appendToRikerSession(supabase, sessionId, 'user', trimmed)
      await core.appendToRikerSession(supabase, sessionId, 'assistant', reply)
      return res.status(200).json({
        reply, session_id: sessionId,
        actions_taken: [{ type: 'verify_owner_otp', ok: true }]
      })
    }
    // Invalid/expired OTP — fall through to Riker to handle naturally
  }

  // ── Detect owner-verified session → switch to app context ────────────────
  // After OTP verification a short-lived riker_memory entry is written.
  // If it's present, treat this session as Jon so he gets the full Riker
  // experience (terse, technical, all tools) rather than the receptionist.
  let rikerContext = 'website'
  const { data: ownerMem } = await supabase.from('riker_memory')
    .select('id')
    .eq('scope', 'global')
    .eq('category', 'internal')
    .eq('archived', false)
    .ilike('content', `%OWNER VERIFIED: website session ${sessionId}%`)
    .gt('expires_at', new Date().toISOString())
    .limit(1).maybeSingle()
  if (ownerMem) rikerContext = 'app'

  // ── Run through Riker core ────────────────────────────────────────────────
  try {
    const result = await core.processMessage({
      supabase,
      context: rikerContext,
      sessionKey: sessionId,
      sessionStorage: 'riker_sessions',
      identity: {},
      message: trimmed,
      inboundAlreadyLogged: false,
      rikerSessionId: sessionId
    })

    return res.status(200).json({
      reply: result.reply,
      session_id: sessionId,
      actions_taken: result.actions_taken || []
    })
  } catch (e) {
    console.error('[scheduler-chat] processMessage error:', e)
    return res.status(500).json({
      reply: "Something went wrong. Please call (214) 994-4799 or try again.",
      session_id: sessionId
    })
  }
}
