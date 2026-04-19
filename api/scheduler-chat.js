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

function makeSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL ||
    'https://motjasdokoxwiodwzyps.supabase.co'
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  return createClient(url, key)
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

  // ── Run through Riker core ────────────────────────────────────────────────
  try {
    const result = await core.processMessage({
      supabase,
      context: 'website',
      sessionKey: sessionId,
      sessionStorage: 'riker_sessions',
      identity: {},
      message: String(message).trim(),
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
