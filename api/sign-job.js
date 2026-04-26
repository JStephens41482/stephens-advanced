// /api/sign-job.js
// Records a customer signature against a signature_requests row, then
// stamps the linked job's signature_data and notifies Jon.

const { createClient } = require('@supabase/supabase-js')

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()
  const { token, signed_by_name, signature_data, signed_by_role } = req.body || {}
  if (!token || !signed_by_name || !signature_data) {
    return res.status(400).json({ error: 'token, signed_by_name, and signature_data are required' })
  }
  if (signature_data.length < 200) return res.status(400).json({ error: 'Signature looks empty' })

  const supabaseKey = process.env.SUPABASE_SERVICE_KEY
  if (!supabaseKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not configured' })
  const supabase = createClient('https://motjasdokoxwiodwzyps.supabase.co', supabaseKey)

  try {
    const { data: sigReq, error: lookupErr } = await supabase
      .from('signature_requests').select('*').eq('token', token).maybeSingle()
    if (lookupErr || !sigReq) return res.status(404).json({ error: 'Token not found' })
    if (sigReq.signed_at) return res.status(409).json({ error: 'Already signed' })
    if (sigReq.expires_at && new Date(sigReq.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Link expired' })
    }

    const nowIso = new Date().toISOString()

    // 1. Mark the signature_request signed
    const { error: updErr } = await supabase
      .from('signature_requests')
      .update({
        signed_at: nowIso,
        signed_by_name,
        signed_by_role: signed_by_role || null,
        signature_data,
        status: 'signed'
      })
      .eq('id', sigReq.id)
    if (updErr) return res.status(500).json({ error: updErr.message })

    // 2. Stamp the job — gives the dashboard "Pending Signatures" widget visibility back
    if (sigReq.job_id) {
      await supabase.from('jobs').update({ signature_data }).eq('id', sigReq.job_id)
    }

    // 3. Audit
    try {
      await supabase.from('audit_log').insert({
        action: 'signed',
        entity_type: 'job',
        entity_id: sigReq.job_id,
        actor: 'customer:' + signed_by_name,
        details: { token, sigreq_id: sigReq.id, invoice_id: sigReq.invoice_id }
      })
    } catch (e) { /* don't block signing on audit */ }

    // 4. Notify Jon (#4 of the offsite-signer plan) — quick email + SMS
    try {
      const { data: loc } = sigReq.location_id ? await supabase
        .from('locations').select('name').eq('id', sigReq.location_id).maybeSingle() : { data: null }
      const { data: inv } = sigReq.invoice_id ? await supabase
        .from('invoices').select('invoice_number,total').eq('id', sigReq.invoice_id).maybeSingle() : { data: null }
      const locName = loc?.name || 'a customer'
      const invStr = inv ? `Invoice ${inv.invoice_number} ($${(+inv.total).toFixed(2)})` : 'their service'
      const subject = `✍️ ${locName} just signed`
      const html = `<p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">
        <strong>${signed_by_name}</strong> at <strong>${locName}</strong> just signed for ${invStr}.</p>
        <p style="font-family:Arial,sans-serif;font-size:13px;color:#555">Sign request: ${sigReq.id}<br>Signed at: ${nowIso}</p>`
      // Email Jon
      if (process.env.RESEND_API_KEY) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Stephens Advanced <jonathan@stephensadvanced.com>',
            to: ['jonathan@stephensadvanced.com'],
            subject, html
          })
        })
      }
      // SMS Jon
      const sid = process.env.TWILIO_ACCOUNT_SID
      const twToken = process.env.TWILIO_AUTH_TOKEN
      const from = process.env.TWILIO_PHONE_NUMBER
      if (sid && twToken && from) {
        const auth = Buffer.from(sid + ':' + twToken).toString('base64')
        const params = new URLSearchParams({
          To: '+12149944799',
          From: from,
          Body: `${signed_by_name} just signed for ${locName} (${invStr}).`
        })
        await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: 'POST',
          headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString()
        })
      }
    } catch (notifyErr) {
      console.error('notify-jon:', notifyErr)
    }

    return res.json({ success: true, signed_at: nowIso })
  } catch (e) {
    console.error('sign-job:', e)
    return res.status(500).json({ error: e.message })
  }
}
