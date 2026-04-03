// /api/charge-card.js — Charge a saved card on file via Square Payments API
const { createClient } = require('@supabase/supabase-js')

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const accessToken = process.env.SQUARE_ACCESS_TOKEN
  const locationId = process.env.SQUARE_LOCATION_ID
  if (!accessToken || !locationId) return res.status(500).json({ error: 'Square not configured' })

  const baseUrl = process.env.SQUARE_SANDBOX === 'true'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com'

  const { customerId, cardId, amount, invoiceId, invoiceNumber } = req.body
  if (!customerId || !cardId || !amount) return res.status(400).json({ error: 'Missing customerId, cardId, or amount' })

  const amountCents = Math.round(amount * 100)

  try {
    const payRes = await fetch(`${baseUrl}/v2/payments`, {
      method: 'POST',
      headers: {
        'Square-Version': '2025-01-23',
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        idempotency_key: `charge-${invoiceId || Date.now()}-${Date.now()}`,
        source_id: cardId,
        amount_money: { amount: amountCents, currency: 'USD' },
        customer_id: customerId,
        location_id: locationId,
        note: `Invoice ${invoiceNumber || ''} — Stephens Advanced`,
        autocomplete: true
      })
    })

    const payData = await payRes.json()

    if (!payRes.ok) {
      console.error('Square charge error:', payData)
      return res.status(500).json({ error: payData.errors?.[0]?.detail || 'Charge failed' })
    }

    // Mark invoice as paid in Supabase
    if (invoiceId) {
      const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://motjasdokoxwiodwzyps.supabase.co'
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1vdGphc2Rva294d2lvZHd6eXBzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzNDI2NTcsImV4cCI6MjA4ODkxODY1N30.IMf0plnDRhVgts9LjJr219Tax4J175iuWN1u6ZKTZ-I'
      const sb = createClient(sbUrl, sbKey)
      await sb.from('invoices').update({
        status: 'paid',
        payment_method: 'card_on_file',
        payment_note: 'Square Card on File — ' + (payData.payment?.receipt_url || ''),
        paid_at: new Date().toISOString()
      }).eq('id', invoiceId)

      // audit
      try {
        await sb.from('audit_log').insert({
          action: 'paid', entity_type: 'invoice', entity_id: invoiceId,
          actor: 'system', summary: 'Charged card on file — $' + amount.toFixed(2)
        })
      } catch (e) {}
    }

    return res.json({
      success: true,
      paymentId: payData.payment?.id,
      receiptUrl: payData.payment?.receipt_url
    })
  } catch (e) {
    console.error('charge-card error:', e)
    return res.status(500).json({ error: e.message })
  }
}
