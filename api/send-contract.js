// /api/send-contract.js
// Sends contract invitation email via Resend — Stephens Advanced LLC

const { createClient } = require('@supabase/supabase-js')
const { renderEmail, renderText } = require('./email-template')

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured' })

  const supabase = createClient(
    'https://motjasdokoxwiodwzyps.supabase.co',
    process.env.SUPABASE_SERVICE_KEY
  )

  const { contractId, recipientEmail, recipientName } = req.body || {}
  if (!contractId) return res.status(400).json({ error: 'Missing contractId' })

  try {
    // ── 1. Load contract + location + billing account ───────────────
    const { data: contract, error: contractErr } = await supabase
      .from('contracts')
      .select('*, location_id, billing_account_id')
      .eq('id', contractId)
      .single()

    if (contractErr || !contract) {
      console.error('Contract lookup error:', contractErr)
      return res.status(400).json({ error: 'Contract not found' })
    }

    let location = null
    if (contract.location_id) {
      const { data } = await supabase
        .from('locations')
        .select('*')
        .eq('id', contract.location_id)
        .single()
      location = data
    }

    let billingAccount = null
    if (contract.billing_account_id) {
      const { data } = await supabase
        .from('billing_accounts')
        .select('*')
        .eq('id', contract.billing_account_id)
        .single()
      billingAccount = data
    }

    // ── 2. Determine recipient info ─────────────────────────────────
    const customerName = recipientName
      || location?.contact_name
      || billingAccount?.contact_name
      || contract.customer_name
      || 'Valued Customer'

    const customerEmail = recipientEmail
      || contract.customer_email
      || location?.contact_email
      || billingAccount?.contact_email

    if (!customerEmail) {
      return res.status(400).json({ error: 'No customer email found for this contract' })
    }

    const locationName = location?.name || billingAccount?.name || ''
    const signUrl = `https://www.stephensadvanced.com/sign-contract?token=${contractId}`

    // ── 3. Build branded HTML email via shared template ─────────────
    const benefitsHtml = `
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;background:#fef7f4;border:1px solid #fde0d2;border-radius:8px">
      <tr><td style="padding:18px 22px">
        <p style="margin:0 0 10px;font-size:12px;font-weight:700;color:#d04010;text-transform:uppercase;letter-spacing:0.5px">Benefits of Your Agreement</p>
        <table cellpadding="0" cellspacing="0" style="font-size:13px;color:#444;line-height:1.8">
          <tr><td style="padding:2px 8px 2px 0;vertical-align:top;color:#f05a28;font-size:15px">&#10003;</td><td><strong>Priority Scheduling</strong> &mdash; first access to preferred service windows</td></tr>
          <tr><td style="padding:2px 8px 2px 0;vertical-align:top;color:#f05a28;font-size:15px">&#10003;</td><td><strong>Price Lock Guarantee</strong> &mdash; locked-in annual rates for the term</td></tr>
          <tr><td style="padding:2px 8px 2px 0;vertical-align:top;color:#f05a28;font-size:15px">&#10003;</td><td><strong>Prompt-Pay Discount</strong> &mdash; save with autopay or early payment</td></tr>
          <tr><td style="padding:2px 8px 2px 0;vertical-align:top;color:#f05a28;font-size:15px">&#10003;</td><td><strong>Customer Portal</strong> &mdash; view invoices, reports, and schedule service online</td></tr>
        </table>
      </td></tr>
      </table>`

    const opts = {
      headline: 'Service Agreement',
      subheadline: 'Stephens Advanced LLC &mdash; Fire Suppression Services',
      greeting: `Dear ${customerName},`,
      intro: `Thank you for choosing Stephens Advanced for your fire suppression service needs${locationName ? ' at ' + locationName : ''}. Your annual service agreement is ready for review and signature.`,
      bodyHtml: benefitsHtml,
      cta: { label: 'Review & Sign Agreement', url: signUrl },
      fineprint: 'This link is unique to your account. You can complete the signing on any device.',
      spanish: {
        greeting: `Estimado/a ${customerName},`,
        intro: 'Su acuerdo de servicio anual esta listo para revisar y firmar. Beneficios: programacion prioritaria, precio garantizado, descuento por pago rapido, portal del cliente.',
        ctaLabel: 'Revisar y Firmar Acuerdo',
      },
    }

    const html = renderEmail(opts)
    const text = renderText(opts)

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Stephens Advanced <jonathan@stephensadvanced.com>',
        to: [customerEmail],
        bcc: ['jonathan@stephensadvanced.com'],
        subject: `Your Service Agreement is Ready — Stephens Advanced${locationName ? ' | ' + locationName : ''}`,
        html,
        text
      })
    })

    const data = await response.json()
    if (!response.ok) {
      console.error('Resend error:', data)
      return res.status(500).json({ error: data.message || 'Email send failed', detail: data })
    }

    // ── 5. Update contract status ───────────────────────────────────
    const now = new Date().toISOString()
    const { error: updateErr } = await supabase
      .from('contracts')
      .update({
        status: 'sent',
        sent_at: now,
        sent_to: customerEmail
      })
      .eq('id', contractId)

    if (updateErr) console.error('Contract status update error:', updateErr)

    // Audit log
    try {
      await supabase.from('audit_log').insert({
        action: 'sent',
        entity_type: 'contract',
        entity_id: contractId,
        actor: 'system',
        summary: `Contract invitation sent to ${customerEmail}`
      })
    } catch (e) {}

    return res.status(200).json({
      success: true,
      contractId,
      messageId: data.id,
      sentTo: customerEmail,
      sentAt: now
    })

  } catch (err) {
    console.error('send-contract error:', err)
    return res.status(500).json({ error: err.message })
  }
}
