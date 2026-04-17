// /api/claude.js
// App chat endpoint — routes through Riker core.
// The app frontend calls POST /api/claude with { messages, system, ... }
// We translate that into a riker-core processMessage call.

const { createClient } = require('@supabase/supabase-js')
const core = require('./riker-core')

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://motjasdokoxwiodwzyps.supabase.co'
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  const supabase = createClient(sbUrl, sbKey)

  const body = req.body || {}

  let context = body.context || 'app'
  let message = body.message
  let sessionId = body.session_id
  let attachments = body.attachments
  let identity = {}

  // Legacy format — extract last user message from messages array
  if (!message && body.messages && body.messages.length) {
    const lastUser = [...body.messages].reverse().find(m => m.role === 'user')
    if (lastUser) {
      message = typeof lastUser.content === 'string'
        ? lastUser.content
        : (lastUser.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
      if (Array.isArray(lastUser.content)) {
        attachments = lastUser.content.filter(b => b.type === 'image')
      }
    }
  }

  if (!message && !(attachments && attachments.length)) {
    return res.status(400).json({ error: 'No message found' })
  }

  if (body.client_context?.active_location_id) {
    identity.location_id = body.client_context.active_location_id
  }
  identity.tech_id = body.auth?.tech_id || null

  try {
    if (!sessionId) {
      const { data: session } = await supabase.from('riker_sessions').insert({
        context,
        tech_id: identity.tech_id || null,
        location_id: identity.location_id || null,
        messages: [],
        status: 'active'
      }).select().single()
      sessionId = session.id
    }

    const result = await core.processMessage({
      supabase,
      context,
      sessionKey: sessionId,
      sessionStorage: 'riker_sessions',
      identity,
      message,
      attachments,
      inboundAlreadyLogged: false
    })

    return res.status(200).json({
      content: [{ type: 'text', text: result.reply }],
      reply: result.reply,
      session_id: result.session_id,
      actions_taken: result.actions_taken,
      client_hints: result.client_hints,
      cost_usd: result.cost
    })
  } catch (e) {
    console.error('[claude/riker] error:', e)
    return res.status(500).json({
      content: [{ type: 'text', text: 'Sorry, hit a snag. Try again in a second.' }],
      error: e.message
    })
  }
}
