// /api/riker-last.js
// Shows the last N Riker interactions with full detail so you can see
// exactly what Claude was sent and what it returned. For debugging only.
//
// GET /api/riker-last              — last 10 interactions, all contexts
// GET /api/riker-last?context=app  — filter to one context
// GET /api/riker-last?n=30         — more rows
// GET /api/riker-last?session=UUID — filter to one session
//
// Returns: plain HTML for browser readability.

const { createClient } = require('@supabase/supabase-js')

module.exports = async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET
  const provided = req.query?.key || req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (cronSecret && provided !== cronSecret) return res.status(401).send('Unauthorized — pass ?key=<CRON_SECRET>')

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://motjasdokoxwiodwzyps.supabase.co'
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  const sb = createClient(sbUrl, sbKey)

  const n = Math.min(100, Number(req.query?.n) || 10)
  const context = req.query?.context
  const sessionId = req.query?.session

  let q = sb.from('riker_interactions').select('*').order('created_at', { ascending: false }).limit(n)
  if (context) q = q.eq('context', context)
  if (sessionId) q = q.eq('session_id', sessionId)
  const { data: rows, error } = await q
  if (error) return res.status(500).send('DB error: ' + error.message)

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const rowHtml = rows.map(r => `
    <details style="margin-bottom:12px;border:1px solid #ccc;border-radius:6px;padding:8px 10px;background:#fafafa">
      <summary style="cursor:pointer;font-family:monospace;font-size:12px">
        <b>${esc(r.context)}</b> · ${new Date(r.created_at).toLocaleString()}
        · ${r.input_tokens || '?'}→${r.output_tokens || '?'} tok
        · $${Number(r.cost_usd || 0).toFixed(4)}
        · ${r.latency_ms || '?'}ms
        · actions: ${(r.actions_succeeded || []).map(a => a.type + (a.ok === false ? '(!)' : '')).join(', ') || 'none'}
        ${r.error ? '· <span style="color:#c00">ERR: ' + esc(r.error).slice(0, 60) + '</span>' : ''}
        · session:${String(r.session_id || '').slice(0, 8)}
      </summary>
      <div style="font-family:monospace;font-size:11.5px;margin-top:10px">
        <div style="color:#555;font-weight:bold">USER MESSAGE</div>
        <pre style="background:#fff;border:1px solid #eee;padding:8px;white-space:pre-wrap;margin:4px 0">${esc(r.user_message)}</pre>
        <div style="color:#555;font-weight:bold">REPLY</div>
        <pre style="background:#fff;border:1px solid #eee;padding:8px;white-space:pre-wrap;margin:4px 0">${esc(r.reply) || '<em style="color:#999">(empty)</em>'}</pre>
        <div style="color:#555;font-weight:bold">ACTIONS ATTEMPTED</div>
        <pre style="background:#fff;border:1px solid #eee;padding:8px;white-space:pre-wrap;margin:4px 0">${esc(JSON.stringify(r.actions_attempted, null, 2))}</pre>
        <div style="color:#555;font-weight:bold">ACTIONS SUCCEEDED</div>
        <pre style="background:#fff;border:1px solid #eee;padding:8px;white-space:pre-wrap;margin:4px 0">${esc(JSON.stringify(r.actions_succeeded, null, 2))}</pre>
        ${r.error ? `<div style="color:#c00;font-weight:bold">ERROR</div><pre style="background:#fff0f0;border:1px solid #fcc;padding:8px;white-space:pre-wrap;margin:4px 0">${esc(r.error)}</pre>` : ''}
        <div style="color:#777;font-size:10px;margin-top:6px">memory read:${r.memory_entries_read} written:${r.memory_entries_written}</div>
      </div>
    </details>
  `).join('\n')

  res.status(200).send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Riker Interactions — last ${n}</title>
<style>body{font-family:-apple-system,Segoe UI,sans-serif;background:#111;color:#eee;padding:20px;max-width:1100px;margin:0 auto}details{color:#111}summary{color:#eee}a{color:#6cf}</style>
</head><body>
<h1>Riker — last ${rows.length} interaction${rows.length === 1 ? '' : 's'}</h1>
<div style="font-size:13px;margin-bottom:16px;color:#aaa">
  Filters: <a href="?n=10">last 10</a> ·
  <a href="?n=30">last 30</a> ·
  <a href="?context=app&amp;n=20">app only</a> ·
  <a href="?context=sms_jon&amp;n=20">sms_jon only</a> ·
  <a href="?context=sms_customer&amp;n=20">sms_customer only</a>
</div>
${rowHtml || '<em>No rows.</em>'}
</body></html>`)
}
