// /api/square-webhook.js
// Receives Square payment.completed webhooks and marks invoices as paid

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { createClient } = require('@supabase/supabase-js')
  const SB = createClient(
    'https://motjasdokoxwiodwzyps.supabase.co',
    process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1vdGphc2Rva294d2lvZHd6eXBzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzNDI2NTcsImV4cCI6MjA4ODkxODY1N30.IMf0plnDRhVgts9LjJr219Tax4J175iuWN1u6ZKTZ-I'
  )

  try {
    const event = req.body
    const type = event?.type

    // Square sends payment.completed when a payment link is paid
    if (type === 'payment.completed' || type === 'payment.updated') {
      const payment = event?.data?.object?.payment || event?.data?.object || {}
      const orderId = payment.order_id
      const amount = payment.amount_money?.amount // cents
      const status = payment.status
      const receiptUrl = payment.receipt_url

      if (status !== 'COMPLETED') {
        return res.status(200).json({ ok: true, skipped: 'not completed' })
      }

      // Try to match by payment note which contains invoice number
      const note = payment.note || payment.buyer_email_address || ''
      const invMatch = note.match(/INV-\d+/)

      if (invMatch) {
        const invNum = invMatch[0]
        const { data: inv } = await SB.from('invoices').select('id').eq('invoice_number', invNum).limit(1)
        if (inv?.length) {
          await SB.from('invoices').update({
            status: 'paid',
            paid_at: new Date().toISOString(),
            payment_method: 'card',
            stripe_payment_id: payment.id || orderId // reusing field for Square payment ID
          }).eq('id', inv[0].id)

          console.log('Invoice marked paid:', invNum)
          return res.status(200).json({ ok: true, invoice: invNum, action: 'marked_paid' })
        }
      }

      // Fallback: try to match by amount
      if (amount) {
        const totalDollars = (amount / 100).toFixed(2)
        const { data: invs } = await SB.from('invoices')
          .select('id,invoice_number,total')
          .eq('status', 'sent')
          .order('date', { ascending: false })
          .limit(20)

        const match = invs?.find(i => Math.abs(+i.total - +totalDollars) < 0.01)
        if (match) {
          await SB.from('invoices').update({
            status: 'paid',
            paid_at: new Date().toISOString(),
            payment_method: 'card',
            stripe_payment_id: payment.id || orderId
          }).eq('id', match.id)

          console.log('Invoice matched by amount:', match.invoice_number, totalDollars)
          return res.status(200).json({ ok: true, invoice: match.invoice_number, action: 'matched_by_amount' })
        }
      }

      console.log('Payment received but no invoice matched:', { orderId, amount, note })
      return res.status(200).json({ ok: true, action: 'no_match' })
    }

    // Acknowledge all other event types
    return res.status(200).json({ ok: true, type })

  } catch (err) {
    console.error('square-webhook error:', err)
    return res.status(200).json({ ok: true, error: err.message }) // always 200 to prevent retries
  }
}
