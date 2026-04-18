// /api/riker.js
// Unified chat endpoint for website / portal / app surfaces. All three
// call here. System prompts, context data, memory, and actions are all
// assembled server-side.
//
// Request body:
//   {
//     context: 'website' | 'portal' | 'app',
//     session_id?: string,                 // omit on first turn to create a new session
//     message: string,                     // current user turn
//     attachments?: [...Claude content blocks],  // images for app photo analysis
//     auth: {                              // per-context authentication
//       portal_token?: string,             // portal only
//       tech_id?: string                   // app only
//     },
//     client_context?: {                   // optional metadata from client
//       current_screen?: string,           // app: e.g. 'dashboard', 'clients'
//       active_location_id?: string,       // app: which client is open
//       active_job_id?: string,            // app: which job is open
//       utm?: {...}                        // website: source tracking
//     }
//   }
//
// Response body:
//   {
//     reply: string,
//     session_id: string,
//     actions_taken: [{type, ok, detail}],
//     client_hints: [{type, ...}],          // e.g. { type: 'open_screen', screen: 'jobs' }
//     cost_usd: number
//   }

const { createClient } = require('@supabase/supabase-js')
const core = require('./riker-core')

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://motjasdokoxwiodwzyps.supabase.co'
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  const supabase = createClient(sbUrl, sbKey)

  const body = req.body || {}
  const context = body.context
  if (!['website', 'portal', 'app'].includes(context)) {
    return res.status(400).json({ error: 'Invalid context; must be website | portal | app' })
  }
  const message = (body.message || '').trim()
  if (!message && !(body.attachments && body.attachments.length)) {
    return res.status(400).json({ error: 'message or attachments required' })
  }

  try {
    // Resolve identity per-context
    const identity = {}
    if (context === 'portal') {
      const token = body.auth?.portal_token
      if (!token) return res.status(401).json({ error: 'portal_token required' })
      const { data: tokenRow } = await supabase
        .from('portal_tokens')
        .select('billing_account_id, location_id, expires_at, is_active')
        .eq('token', token)
        .maybeSingle()
      if (!tokenRow || !tokenRow.is_active) return res.status(401).json({ error: 'invalid portal_token' })
      if (tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date()) {
        return res.status(401).json({ error: 'portal_token expired' })
      }
      identity.billing_account_id = tokenRow.billing_account_id
      identity.location_id = tokenRow.location_id || null
      // Touch last_accessed_at
      await supabase.from('portal_tokens').update({ last_accessed_at: new Date().toISOString() }).eq('token', token)
    } else if (context === 'app') {
      identity.tech_id = body.auth?.tech_id || null
      // Accept client_context fields as identity hints
      if (body.client_context?.active_location_id) identity.location_id = body.client_context.active_location_id
    }

    // Resolve or create session
    let sessionId = body.session_id
    if (!sessionId) {
      const insertRow = {
        context,
        tech_id: identity.tech_id || null,
        location_id: identity.location_id || null,
        billing_account_id: identity.billing_account_id || null,
        portal_token: context === 'portal' ? body.auth?.portal_token : null,
        messages: [],
        status: 'active'
      }
      const { data: session, error: insErr } = await supabase
        .from('riker_sessions')
        .insert(insertRow)
        .select()
        .single()
      if (insErr || !session) {
        console.error('[riker] session insert failed:', {
          error: insErr?.message,
          code: insErr?.code,
          details: insErr?.details,
          hint: insErr?.hint,
          context
        })
        // Return 200 with a diagnostic reply so the client shows the
        // message instead of falling through to the 'Done.' fallback.
        return res.status(200).json({
          reply: "Something blocked my session setup — check Vercel logs for `[riker] session insert failed`. Pass your existing session_id and try again.",
          session_id: null,
          actions_taken: [],
          client_hints: [],
          cost_usd: 0,
          error: 'session_insert_failed',
          error_detail: insErr?.message || 'insert returned null'
        })
      }
      sessionId = session.id
    }

    const result = await core.processMessage({
      supabase,
      context,
      sessionKey: sessionId,
      sessionStorage: 'riker_sessions',
      identity,
      message,
      attachments: body.attachments,
      inboundAlreadyLogged: false  // riker_sessions adapter will append
    })

    // DIAGNOSTIC (2026-04-18, per Data's ask #1): log the exact response
    // shape and reply length for every app-context turn so we can verify
    // the server is returning non-empty {reply,...} before the client's
    // `|| 'Done.'` fallback can fire. Remove once we've confirmed.
    const outbound = {
      reply: result.reply,
      session_id: result.session_id,
      actions_taken: result.actions_taken,
      client_hints: result.client_hints,
      cost_usd: result.cost
    }
    if (context === 'app') {
      console.log('[riker:app] response_shape', {
        reply_len: (result.reply || '').length,
        reply_preview: (result.reply || '').slice(0, 80),
        actions_count: (result.actions_taken || []).length,
        client_hints_count: (result.client_hints || []).length,
        session_id: result.session_id,
        cost_usd: result.cost,
        keys: Object.keys(outbound)
      })
    }
    return res.status(200).json(outbound)

  } catch (e) {
    console.error('[riker] error:', e)
    return res.status(500).json({ error: e.message })
  }
}
