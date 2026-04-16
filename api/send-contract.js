// /api/send-contract.js
// Sends contract invitation email via Resend — Stephens Advanced LLC

const { createClient } = require('@supabase/supabase-js')

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured' })

  const supabase = createClient(
    'https://motjasdokoxwiodwzyps.supabase.co',
    process.env.SUPABASE_SERVICE_KEY
  )

  const { contractId } = req.body || {}
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
    const customerName = location?.contact_name
      || billingAccount?.contact_name
      || contract.customer_name
      || 'Valued Customer'

    const customerEmail = location?.contact_email
      || billingAccount?.contact_email
      || contract.customer_email

    if (!customerEmail) {
      return res.status(400).json({ error: 'No customer email found for this contract' })
    }

    const locationName = location?.name || billingAccount?.name || ''
    const signUrl = `https://www.stephensadvanced.com/sign-contract?token=${contractId}`

    // ── 3. Build branded HTML email ─────────────────────────────────
    const html = buildContractEmail({ customerName, locationName, signUrl })

    // ── 4. Send via Resend ──────────────────────────────────────────
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
        html
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

// ── Email template ────────────────────────────────────────────────────
function buildContractEmail({ customerName, locationName, signUrl }) {
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 16px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

  <!-- Header -->
  <tr><td style="background:#f05a28;padding:28px 32px;border-radius:10px 10px 0 0;text-align:center">
    <img src="https://www.stephensadvanced.com/icon-120.png" alt="Stephens Advanced" width="60" height="60" style="display:block;margin:0 auto 12px;border-radius:12px">
    <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.3px">Service Agreement</h1>
    <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:13px">Stephens Advanced LLC &mdash; Fire Suppression Services</p>
  </td></tr>

  <!-- Body -->
  <tr><td style="background:#ffffff;padding:32px;border-left:1px solid #e8e8eb;border-right:1px solid #e8e8eb">

    <p style="margin:0 0 16px;font-size:15px;color:#222;line-height:1.6">
      Dear ${esc(customerName)},
    </p>
    <p style="margin:0 0 20px;font-size:14px;color:#444;line-height:1.7">
      Thank you for choosing Stephens Advanced for your fire suppression service needs${locationName ? ' at <strong>' + esc(locationName) + '</strong>' : ''}. Your annual service agreement is ready for review and signature.
    </p>

    <!-- Benefits box -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;background:#fef7f4;border:1px solid #fde0d2;border-radius:8px">
    <tr><td style="padding:20px 24px">
      <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#d04010;text-transform:uppercase;letter-spacing:0.5px">Benefits of Your Agreement</p>
      <table cellpadding="0" cellspacing="0" style="font-size:13px;color:#444;line-height:1.8">
        <tr><td style="padding:2px 8px 2px 0;vertical-align:top;color:#f05a28;font-size:15px">&#10003;</td><td><strong>Priority Scheduling</strong> &mdash; first access to preferred service windows</td></tr>
        <tr><td style="padding:2px 8px 2px 0;vertical-align:top;color:#f05a28;font-size:15px">&#10003;</td><td><strong>Price Lock Guarantee</strong> &mdash; locked-in annual rates for the term</td></tr>
        <tr><td style="padding:2px 8px 2px 0;vertical-align:top;color:#f05a28;font-size:15px">&#10003;</td><td><strong>Prompt-Pay Discount</strong> &mdash; save with autopay or early payment</td></tr>
        <tr><td style="padding:2px 8px 2px 0;vertical-align:top;color:#f05a28;font-size:15px">&#10003;</td><td><strong>Customer Portal</strong> &mdash; view invoices, reports, and schedule service online</td></tr>
      </table>
    </td></tr>
    </table>

    <!-- CTA Button -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px">
    <tr><td align="center">
      <a href="${esc(signUrl)}" target="_blank" style="display:inline-block;background:#f05a28;color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;padding:14px 40px;border-radius:8px;letter-spacing:0.2px">
        Review &amp; Sign Agreement
      </a>
    </td></tr>
    </table>

    <p style="margin:0 0 24px;font-size:12px;color:#888;text-align:center;line-height:1.5">
      This link is unique to your account. You can complete the signing on any device.<br>
      If the button doesn't work, copy this URL: <a href="${esc(signUrl)}" style="color:#f05a28;word-break:break-all">${esc(signUrl)}</a>
    </p>

    <!-- Divider -->
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0">

    <!-- Spanish version -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;background:#f8f8fa;border-radius:8px">
    <tr><td style="padding:20px 24px">
      <p style="margin:0 0 8px;font-size:12px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.5px">Espa&ntilde;ol</p>
      <p style="margin:0 0 12px;font-size:13px;color:#555;line-height:1.7">
        Estimado/a ${esc(customerName)}, su acuerdo de servicio anual est&aacute; listo para revisar y firmar.
      </p>
      <p style="margin:0 0 8px;font-size:13px;color:#555;line-height:1.7"><strong>Beneficios de su acuerdo:</strong></p>
      <ul style="margin:0 0 12px;padding-left:18px;font-size:13px;color:#555;line-height:1.8">
        <li><strong>Programaci&oacute;n prioritaria</strong> &mdash; acceso preferente a horarios de servicio</li>
        <li><strong>Precio garantizado</strong> &mdash; tarifas fijas durante el t&eacute;rmino del contrato</li>
        <li><strong>Descuento por pago r&aacute;pido</strong> &mdash; ahorre con pago autom&aacute;tico</li>
        <li><strong>Portal del cliente</strong> &mdash; vea facturas, reportes y programe servicio en l&iacute;nea</li>
      </ul>
      <a href="${esc(signUrl)}" target="_blank" style="display:inline-block;background:#f05a28;color:#ffffff;font-size:13px;font-weight:700;text-decoration:none;padding:10px 28px;border-radius:6px">
        Revisar y Firmar Acuerdo
      </a>
    </td></tr>
    </table>

  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#1a1a2e;padding:24px 32px;border-radius:0 0 10px 10px;text-align:center">
    <p style="margin:0 0 6px;font-size:13px;color:#ccc;font-weight:600">Stephens Advanced LLC</p>
    <p style="margin:0 0 4px;font-size:11px;color:#999;line-height:1.6">
      Fire Suppression Systems &bull; Inspections &bull; Installations &bull; Service
    </p>
    <p style="margin:0 0 4px;font-size:11px;color:#999;line-height:1.6">
      <a href="tel:+18173204911" style="color:#f05a28;text-decoration:none">(817) 320-4911</a> &bull;
      <a href="mailto:jonathan@stephensadvanced.com" style="color:#f05a28;text-decoration:none">jonathan@stephensadvanced.com</a>
    </p>
    <p style="margin:8px 0 0;font-size:10px;color:#666">
      <a href="https://www.stephensadvanced.com" style="color:#f05a28;text-decoration:none">www.stephensadvanced.com</a>
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`
}
