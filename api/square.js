// /api/square-customer.js — Create or find a Square customer, save card on file
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const accessToken = process.env.SQUARE_ACCESS_TOKEN
  if (!accessToken) return res.status(500).json({ error: 'Square not configured' })

  const baseUrl = process.env.SQUARE_SANDBOX === 'true'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com'

  const headers = {
    'Square-Version': '2025-01-23',
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  }

  const { action } = req.body

  try {
    // Create or find customer
    if (action === 'create_or_find') {
      const { name, email, phone, locationId } = req.body

      // search by email first
      if (email) {
        const searchRes = await fetch(`${baseUrl}/v2/customers/search`, {
          method: 'POST', headers,
          body: JSON.stringify({
            query: { filter: { email_address: { exact: email } } }
          })
        })
        const searchData = await searchRes.json()
        if (searchData.customers?.length) {
          const cust = searchData.customers[0]
          return res.json({ success: true, customerId: cust.id, cards: cust.cards || [] })
        }
      }

      // search by phone
      if (phone) {
        const searchRes = await fetch(`${baseUrl}/v2/customers/search`, {
          method: 'POST', headers,
          body: JSON.stringify({
            query: { filter: { phone_number: { exact: phone.replace(/\D/g, '').replace(/^1/, '+1') } } }
          })
        })
        const searchData = await searchRes.json()
        if (searchData.customers?.length) {
          const cust = searchData.customers[0]
          return res.json({ success: true, customerId: cust.id, cards: cust.cards || [] })
        }
      }

      // create new customer
      const createRes = await fetch(`${baseUrl}/v2/customers`, {
        method: 'POST', headers,
        body: JSON.stringify({
          idempotency_key: `cust-${locationId || Date.now()}`,
          given_name: (name || '').split(' ')[0] || '',
          family_name: (name || '').split(' ').slice(1).join(' ') || '',
          email_address: email || undefined,
          phone_number: phone ? phone.replace(/\D/g, '').replace(/^(\d{10})$/, '+1$1') : undefined,
          reference_id: locationId || undefined
        })
      })
      const createData = await createRes.json()
      if (!createRes.ok) return res.status(500).json({ error: createData.errors?.[0]?.detail || 'Create failed' })

      return res.json({ success: true, customerId: createData.customer.id, cards: [] })
    }

    // List saved cards for a customer
    if (action === 'list_cards') {
      const { customerId } = req.body
      const cardsRes = await fetch(`${baseUrl}/v2/customers/${customerId}/cards`, {
        method: 'GET', headers
      })
      // Square doesn't have a direct /cards endpoint on customer — cards are on the customer object
      const custRes = await fetch(`${baseUrl}/v2/customers/${customerId}`, {
        method: 'GET', headers
      })
      const custData = await custRes.json()
      return res.json({ success: true, cards: custData.customer?.cards || [] })
    }

    // Create a payment link that saves the card
    if (action === 'checkout_and_save_card') {
      const { customerId, amount, invoiceNumber, customerName, invoiceId } = req.body
      const locationId = process.env.SQUARE_LOCATION_ID
      const amountCents = Math.round(amount * 100)

      const linkRes = await fetch(`${baseUrl}/v2/online-checkout/payment-links`, {
        method: 'POST', headers,
        body: JSON.stringify({
          idempotency_key: `inv-save-${invoiceId}-${Date.now()}`,
          quick_pay: {
            name: `Invoice ${invoiceNumber || ''} — ${customerName || 'Stephens Advanced'}`,
            price_money: { amount: amountCents, currency: 'USD' },
            location_id: locationId
          },
          checkout_options: {
            allow_tipping: false,
            redirect_url: 'https://stephensadvanced.com/portal',
            accepted_payment_methods: { apple_pay: true, google_pay: true },
            ask_for_shipping_address: false
          },
          pre_populated_data: {
            buyer_email: req.body.email || undefined
          },
          payment_note: `${invoiceNumber || ''} — ${customerName || ''}`,
          // This tells Square to save the card for the customer
          ...(customerId ? { order: { customer_id: customerId } } : {})
        })
      })
      const linkData = await linkRes.json()
      if (!linkRes.ok) return res.status(500).json({ error: linkData.errors?.[0]?.detail || 'Link creation failed' })

      return res.json({
        success: true,
        paymentLink: linkData.payment_link?.url || linkData.payment_link?.long_url,
        orderId: linkData.payment_link?.order_id
      })
    }

    // Charge a saved card on file
    if (action === 'charge_card') {
      const { customerId, cardId, amount, invoiceId, invoiceNumber } = req.body
      if (!customerId || !cardId || !amount) return res.status(400).json({ error: 'Missing customerId, cardId, or amount' })
      const amountCents = Math.round(amount * 100)
      const payRes = await fetch(`${baseUrl}/v2/payments`, {
        method: 'POST', headers,
        body: JSON.stringify({
          idempotency_key: `charge-${invoiceId || Date.now()}-${Date.now()}`,
          source_id: cardId,
          amount_money: { amount: amountCents, currency: 'USD' },
          customer_id: customerId,
          location_id: process.env.SQUARE_LOCATION_ID,
          note: `Invoice ${invoiceNumber || ''} — Stephens Advanced`,
          autocomplete: true
        })
      })
      const payData = await payRes.json()
      if (!payRes.ok) return res.status(500).json({ error: payData.errors?.[0]?.detail || 'Charge failed' })
      // Mark invoice paid in Supabase
      if (invoiceId) {
        const { createClient } = require('@supabase/supabase-js')
        const sb = createClient('https://motjasdokoxwiodwzyps.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1vdGphc2Rva294d2lvZHd6eXBzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzNDI2NTcsImV4cCI6MjA4ODkxODY1N30.IMf0plnDRhVgts9LjJr219Tax4J175iuWN1u6ZKTZ-I')
        await sb.from('invoices').update({ status: 'paid', payment_method: 'card_on_file', payment_note: 'Square Card on File', paid_at: new Date().toISOString() }).eq('id', invoiceId)
        try { await sb.from('audit_log').insert({ action: 'paid', entity_type: 'invoice', entity_id: invoiceId, actor: 'system', summary: 'Charged card on file — $' + amount.toFixed(2) }) } catch (e) {}
      }
      return res.json({ success: true, paymentId: payData.payment?.id, receiptUrl: payData.payment?.receipt_url })
    }

    return res.status(400).json({ error: 'Unknown action' })
  } catch (e) {
    console.error('square error:', e)
    return res.status(500).json({ error: e.message })
  }
}
