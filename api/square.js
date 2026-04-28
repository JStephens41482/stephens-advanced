// /api/square.js — Square service-side payment endpoints
//
// Actions:
//   create_or_find       — find existing Square customer by email/phone, else create one
//   list_cards           — list saved cards for a customer
//   save_card_with_nonce — attach a card to a Square customer using a nonce from
//                          the Web Payments SDK (no charge)
//   charge_with_nonce    — one-time charge against a card nonce (no save)
//   charge_card          — charge an already-saved card (customerId + cardId)
//   checkout_and_save_card — fallback: hosted Square checkout link
//
// Required env vars (set in Vercel before this works):
//   SQUARE_ACCESS_TOKEN        — server-side only
//   SQUARE_LOCATION_ID         — your Square location ID (server-side)
//   SQUARE_SANDBOX             — 'true' to use sandbox endpoints
//   NEXT_PUBLIC_SQUARE_APP_ID  — application ID for the Web Payments SDK (client-side)
//   NEXT_PUBLIC_SQUARE_LOCATION_ID — location ID for client-side SDK init

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const accessToken = process.env.SQUARE_ACCESS_TOKEN
  if (!accessToken) return res.status(500).json({ error: 'Square not configured (SQUARE_ACCESS_TOKEN missing)' })

  const locationId = process.env.SQUARE_LOCATION_ID
  const baseUrl = process.env.SQUARE_SANDBOX === 'true'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com'

  const headers = {
    'Square-Version': '2025-01-23',
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  }

  const { createClient } = require('@supabase/supabase-js')
  const SB = createClient(
    'https://motjasdokoxwiodwzyps.supabase.co',
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )

  const { action } = req.body

  try {
    // ── create_or_find ─────────────────────────────────────────────
    if (action === 'create_or_find') {
      const { name, email, phone, billingAccountId } = req.body
      if (email) {
        const r = await fetch(`${baseUrl}/v2/customers/search`, {
          method: 'POST', headers,
          body: JSON.stringify({ query: { filter: { email_address: { exact: email } } } })
        })
        const d = await r.json()
        if (d.customers?.length) {
          const cust = d.customers[0]
          if (billingAccountId) await SB.from('billing_accounts').update({ square_customer_id: cust.id }).eq('id', billingAccountId)
          return res.json({ success: true, customerId: cust.id, cards: cust.cards || [] })
        }
      }
      if (phone) {
        const normPhone = phone.replace(/\D/g, '').replace(/^(\d{10})$/, '+1$1')
        const r = await fetch(`${baseUrl}/v2/customers/search`, {
          method: 'POST', headers,
          body: JSON.stringify({ query: { filter: { phone_number: { exact: normPhone } } } })
        })
        const d = await r.json()
        if (d.customers?.length) {
          const cust = d.customers[0]
          if (billingAccountId) await SB.from('billing_accounts').update({ square_customer_id: cust.id }).eq('id', billingAccountId)
          return res.json({ success: true, customerId: cust.id, cards: cust.cards || [] })
        }
      }
      // create
      const r = await fetch(`${baseUrl}/v2/customers`, {
        method: 'POST', headers,
        body: JSON.stringify({
          idempotency_key: `cust-${billingAccountId || Date.now()}-${Date.now()}`,
          given_name: (name || '').split(' ')[0] || '',
          family_name: (name || '').split(' ').slice(1).join(' ') || '',
          email_address: email || undefined,
          phone_number: phone ? phone.replace(/\D/g, '').replace(/^(\d{10})$/, '+1$1') : undefined,
          reference_id: billingAccountId || undefined
        })
      })
      const d = await r.json()
      if (!r.ok) return res.status(500).json({ error: d.errors?.[0]?.detail || 'Customer create failed', detail: d })
      const customerId = d.customer.id
      if (billingAccountId) await SB.from('billing_accounts').update({ square_customer_id: customerId }).eq('id', billingAccountId)
      return res.json({ success: true, customerId, cards: [] })
    }

    // ── list_cards ─────────────────────────────────────────────────
    if (action === 'list_cards') {
      const { customerId } = req.body
      const r = await fetch(`${baseUrl}/v2/customers/${customerId}`, { method: 'GET', headers })
      const d = await r.json()
      return res.json({ success: true, cards: d.customer?.cards || [] })
    }

    // ── save_card_with_nonce ───────────────────────────────────────
    // Customer entered card in the Web Payments SDK; client sends us the resulting
    // nonce. We attach it to the Square customer record so it's available for
    // future charges. Returns the saved card's id + last4 + brand.
    if (action === 'save_card_with_nonce') {
      const { customerId, nonce, billingAccountId } = req.body
      if (!customerId || !nonce) return res.status(400).json({ error: 'Missing customerId or nonce' })
      const r = await fetch(`${baseUrl}/v2/cards`, {
        method: 'POST', headers,
        body: JSON.stringify({
          idempotency_key: `card-${customerId}-${Date.now()}`,
          source_id: nonce,
          card: { customer_id: customerId }
        })
      })
      const d = await r.json()
      if (!r.ok) return res.status(500).json({ error: d.errors?.[0]?.detail || 'Save card failed', detail: d })
      const card = d.card
      // Mirror to billing_accounts so the app can show "card on file"
      if (billingAccountId) {
        await SB.from('billing_accounts').update({
          square_customer_id: customerId,
          card_on_file: true,
          card_last4: card.last_4,
          card_brand: card.card_brand
        }).eq('id', billingAccountId)
      }
      return res.json({ success: true, cardId: card.id, last4: card.last_4, brand: card.card_brand })
    }

    // ── charge_with_nonce ──────────────────────────────────────────
    // One-time charge: customer entered card via SDK, customer does NOT want it
    // saved. We just charge and walk away — no Square customer required.
    if (action === 'charge_with_nonce') {
      const { nonce, amount, invoiceId, invoiceNumber, customerName } = req.body
      if (!nonce || !amount) return res.status(400).json({ error: 'Missing nonce or amount' })
      const amountCents = Math.round(amount * 100)
      const r = await fetch(`${baseUrl}/v2/payments`, {
        method: 'POST', headers,
        body: JSON.stringify({
          idempotency_key: `charge-once-${invoiceId || Date.now()}-${Date.now()}`,
          source_id: nonce,
          amount_money: { amount: amountCents, currency: 'USD' },
          location_id: locationId,
          note: `Invoice ${invoiceNumber || ''} — ${customerName || 'Stephens Advanced'}`,
          autocomplete: true
        })
      })
      const d = await r.json()
      if (!r.ok) return res.status(500).json({ error: d.errors?.[0]?.detail || 'Charge failed', detail: d })
      if (invoiceId) {
        await SB.from('invoices').update({
          status: 'paid',
          payment_method: 'card',
          payment_note: `Square card · one-time · last4 ${d.payment?.card_details?.card?.last_4 || '????'}`,
          paid_at: new Date().toISOString(),
          stripe_payment_id: d.payment?.id  // legacy column name; just an external payment ref
        }).eq('id', invoiceId)
      }
      return res.json({ success: true, paymentId: d.payment?.id, receiptUrl: d.payment?.receipt_url, last4: d.payment?.card_details?.card?.last_4 })
    }

    // ── charge_card (saved card) ───────────────────────────────────
    if (action === 'charge_card') {
      const { customerId, cardId, amount, invoiceId, invoiceNumber } = req.body
      if (!customerId || !cardId || !amount) return res.status(400).json({ error: 'Missing customerId, cardId, or amount' })
      const amountCents = Math.round(amount * 100)
      const r = await fetch(`${baseUrl}/v2/payments`, {
        method: 'POST', headers,
        body: JSON.stringify({
          idempotency_key: `charge-saved-${invoiceId || Date.now()}-${Date.now()}`,
          source_id: cardId,
          amount_money: { amount: amountCents, currency: 'USD' },
          customer_id: customerId,
          location_id: locationId,
          note: `Invoice ${invoiceNumber || ''} — Stephens Advanced`,
          autocomplete: true
        })
      })
      const d = await r.json()
      if (!r.ok) return res.status(500).json({ error: d.errors?.[0]?.detail || 'Charge failed', detail: d })
      if (invoiceId) {
        await SB.from('invoices').update({
          status: 'paid',
          payment_method: 'card_on_file',
          payment_note: `Square card on file · last4 ${d.payment?.card_details?.card?.last_4 || '????'}`,
          paid_at: new Date().toISOString(),
          stripe_payment_id: d.payment?.id
        }).eq('id', invoiceId)
      }
      return res.json({ success: true, paymentId: d.payment?.id, receiptUrl: d.payment?.receipt_url })
    }

    // ── checkout_and_save_card (hosted page fallback) ──────────────
    if (action === 'checkout_and_save_card') {
      const { customerId, amount, invoiceNumber, customerName, invoiceId, email } = req.body
      const amountCents = Math.round(amount * 100)
      const r = await fetch(`${baseUrl}/v2/online-checkout/payment-links`, {
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
          pre_populated_data: { buyer_email: email || undefined },
          payment_note: `${invoiceNumber || ''} — ${customerName || ''}`,
          ...(customerId ? { order: { customer_id: customerId } } : {})
        })
      })
      const d = await r.json()
      if (!r.ok) return res.status(500).json({ error: d.errors?.[0]?.detail || 'Link creation failed' })
      return res.json({
        success: true,
        paymentLink: d.payment_link?.url || d.payment_link?.long_url,
        orderId: d.payment_link?.order_id
      })
    }

    return res.status(400).json({ error: 'Unknown action: ' + action })
  } catch (e) {
    console.error('square endpoint error:', e)
    return res.status(500).json({ error: e.message })
  }
}
