// /api/create-payment-link.js
// Creates a Square payment link for an invoice

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { invoiceNumber, customerName, amount, invoiceId } = req.body
  if (!amount || !invoiceId) return res.status(400).json({ error: 'Missing required fields' })

  const accessToken = process.env.SQUARE_ACCESS_TOKEN
  const locationId = process.env.SQUARE_LOCATION_ID
  if (!accessToken || !locationId) return res.status(500).json({ error: 'Square not configured' })

  // Square API — always use production (sandbox tokens contain 'sandbox' in the application ID)
  const baseUrl = process.env.SQUARE_SANDBOX === 'true'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com'

  try {
    const idempotencyKey = `inv-${invoiceId}-${Date.now()}`
    const amountCents = Math.round(amount * 100)

    const response = await fetch(`${baseUrl}/v2/online-checkout/payment-links`, {
      method: 'POST',
      headers: {
        'Square-Version': '2025-01-23',
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        quick_pay: {
          name: `Invoice ${invoiceNumber || 'Payment'} — ${customerName || 'Stephens Advanced'}`,
          price_money: {
            amount: amountCents,
            currency: 'USD'
          },
          location_id: locationId
        },
        checkout_options: {
          allow_tipping: false,
          redirect_url: `https://stephensadvanced.com/portal`,
          accepted_payment_methods: {
            apple_pay: true,
            google_pay: true
          }
        },
        pre_populated_data: {
          buyer_email: req.body.customerEmail || undefined
        },
        payment_note: `${invoiceNumber || ''} — ${customerName || ''}`
      })
    })

    const data = await response.json()

    if (!response.ok) {
      console.error('Square error:', data)
      return res.status(500).json({ error: data.errors?.[0]?.detail || 'Payment link creation failed', detail: data })
    }

    return res.status(200).json({
      success: true,
      paymentLink: data.payment_link?.url || data.payment_link?.long_url,
      orderId: data.payment_link?.order_id
    })

  } catch (err) {
    console.error('create-payment-link error:', err)
    return res.status(500).json({ error: err.message })
  }
}
