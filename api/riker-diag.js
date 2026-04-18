// /api/riker-diag.js
// Read-only diagnostic for Riker. Reports which Supabase key Vercel is using,
// whether it can actually read the core tables, and row counts on the Riker
// tables. Hit in a browser as GET /api/riker-diag.
//
// Pass ?key=<anything> only if you set CRON_SECRET; otherwise open it directly.

const { createClient } = require('@supabase/supabase-js')

module.exports = async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET
  const provided = req.query?.key || req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (cronSecret && provided !== cronSecret) return res.status(401).json({ error: 'Unauthorized — pass ?key=<CRON_SECRET>' })

  const report = {
    env: {
      NEXT_PUBLIC_SUPABASE_URL: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_URL: !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_SERVICE_KEY: !!process.env.SUPABASE_SERVICE_KEY,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      SUPABASE_ANON_KEY: !!process.env.SUPABASE_ANON_KEY,
      CLAUDE_KEY: !!process.env.CLAUDE_KEY,
      RIKER_AUTO_CONFIRM: process.env.RIKER_AUTO_CONFIRM || '(unset)'
    },
    key_selection: null,
    reads: {},
    counts: {}
  }

  // Replicate the EXACT selection logic used by sms-inbound and core
  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://motjasdokoxwiodwzyps.supabase.co'
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  const sbKey = serviceRole || anon
  report.key_selection = serviceRole ? 'service_role' : (anon ? 'anon_fallback' : 'NONE')
  report.url = sbUrl

  if (!sbKey) {
    report.fatal = 'No Supabase key available in env'
    return res.status(500).json(report)
  }

  // Decode the JWT payload to reveal its role (without verifying — just to see)
  try {
    const [, payloadB64] = sbKey.split('.')
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf-8'))
    report.jwt_role = payload.role
    report.jwt_ref = payload.ref
    report.jwt_exp = payload.exp ? new Date(payload.exp * 1000).toISOString() : null
  } catch { report.jwt_role = 'unparseable' }

  const sb = createClient(sbUrl, sbKey)

  // Attempt a read on each of the tables Riker depends on.
  const tables = ['jobs', 'invoices', 'locations', 'billing_accounts', 'calendar_events', 'rate_card', 'conversations', 'messages', 'riker_sessions', 'riker_memory', 'riker_interactions', 'pending_confirmations']
  for (const t of tables) {
    try {
      const { data, error, count } = await sb.from(t).select('id', { count: 'exact', head: false }).limit(1)
      if (error) report.reads[t] = { ok: false, error: error.message, code: error.code, details: error.details }
      else report.reads[t] = { ok: true, count, sample_id: data?.[0]?.id?.slice(0, 8) || null }
    } catch (e) {
      report.reads[t] = { ok: false, exception: e.message }
    }
  }

  // Also try a join (the exact query shape buildLiveData uses)
  try {
    const { data, error } = await sb.from('jobs').select('id, scheduled_date, location:locations(name,city)').limit(2)
    report.join_test = error ? { ok: false, error: error.message } : { ok: true, rows: data?.length || 0 }
  } catch (e) { report.join_test = { ok: false, exception: e.message } }

  // Anon fallback check — if we're on service_role, also test what the anon key sees (to confirm the theory)
  if (serviceRole && anon) {
    const sbAnon = createClient(sbUrl, anon)
    try {
      const { data, error } = await sbAnon.from('jobs').select('id').limit(1)
      report.anon_comparison_jobs = error ? { blocked: true, error: error.message } : { blocked: false, rows: data?.length || 0 }
    } catch (e) { report.anon_comparison_jobs = { exception: e.message } }
  }

  return res.status(200).json(report)
}
