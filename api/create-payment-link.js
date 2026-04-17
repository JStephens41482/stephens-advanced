// /api/create-payment-link.js
// Creates a Square payment link for an invoice

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const accessToken = process.env.SQUARE_ACCESS_TOKEN
  const locationId = process.env.SQUARE_LOCATION_ID
  if (!accessToken || !locationId) return res.status(500).json({ error: 'Square not configured' })

  const baseUrl = process.env.SQUARE_SANDBOX === 'true'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com'

  // STORE ORDER BRANCH — buy-extinguishers.html
  if (req.body && req.body.type === 'store-order') {
    return handleStoreOrder(req, res, { accessToken, locationId, baseUrl })
  }

  const { invoiceNumber, customerName, amount, invoiceId } = req.body
  if (!amount || !invoiceId) return res.status(400).json({ error: 'Missing required fields' })

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

async function handleStoreOrder(req, res, { accessToken, locationId, baseUrl }) {
  const { customer, delivery, address, notes, items, total } = req.body || {}
  if (!customer || !customer.email || !customer.firstName || !customer.lastName) {
    return res.status(400).json({ error: 'Missing customer info' })
  }
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'No items in order' })
  }
  if (!delivery) return res.status(400).json({ error: 'Missing delivery preference' })

  const needsAddr = delivery === 'delivery-dfw' || delivery === 'ship'
  if (needsAddr && !address) return res.status(400).json({ error: 'Address required for delivery/shipping' })

  // Recompute total server-side so client can't manipulate prices
  const serverTotal = +items.reduce((s, i) => s + (Number(i.price) * Number(i.qty)), 0).toFixed(2)

  const customerName = `${customer.firstName} ${customer.lastName}`.trim()
  const deliveryLabel = delivery === 'pickup' ? 'Pickup — Euless TX'
    : delivery === 'delivery-dfw' ? 'DFW Local Delivery'
    : 'Ship Nationwide'

  try {
    // Build Square line items
    const lineItems = items.map(i => ({
      name: String(i.name || 'Extinguisher').slice(0, 512),
      quantity: String(i.qty),
      base_price_money: {
        amount: Math.round(Number(i.price) * 100),
        currency: 'USD'
      }
    }))

    const idempotencyKey = `store-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

    const sqResponse = await fetch(`${baseUrl}/v2/online-checkout/payment-links`, {
      method: 'POST',
      headers: {
        'Square-Version': '2025-01-23',
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        order: {
          location_id: locationId,
          line_items: lineItems,
          metadata: {
            order_type: 'store-extinguishers',
            delivery: delivery,
            customer_email: customer.email
          }
        },
        checkout_options: {
          allow_tipping: false,
          redirect_url: `https://stephensadvanced.com/buy-extinguishers?success=1`,
          accepted_payment_methods: {
            apple_pay: true,
            google_pay: true
          }
        },
        pre_populated_data: {
          buyer_email: customer.email,
          buyer_phone_number: customer.phone || undefined
        },
        payment_note: `Extinguisher order — ${customerName}`
      })
    })

    const sqData = await sqResponse.json()

    if (!sqResponse.ok) {
      console.error('Square store-order error:', sqData)
      return res.status(500).json({
        error: sqData.errors?.[0]?.detail || 'Could not create payment link',
        detail: sqData
      })
    }

    const paymentUrl = sqData.payment_link?.url || sqData.payment_link?.long_url
    if (!paymentUrl) {
      return res.status(500).json({ error: 'Square did not return a payment URL' })
    }

    // Email Jon with full order details via Resend — non-blocking (best-effort)
    try {
      const resendKey = process.env.RESEND_API_KEY
      if (resendKey) {
        const rowsHtml = items.map(i => `
          <tr>
            <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px">${escapeHtml(i.name)}</td>
            <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;text-align:center">${i.qty}</td>
            <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;text-align:right">$${Number(i.price).toFixed(2)}</td>
            <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;text-align:right;font-weight:700">$${Number(i.lineTotal || i.price * i.qty).toFixed(2)}</td>
          </tr>`).join('')

        const html = `
          <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#222">
            <div style="background:#f05a28;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0">
              <h2 style="margin:0;font-size:20px">🧯 New Extinguisher Order</h2>
              <div style="font-size:13px;opacity:.9;margin-top:4px">Stephens Advanced Store</div>
            </div>
            <div style="background:#fff;padding:24px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px">
              <h3 style="margin:0 0 10px;font-size:15px;color:#1a1a2e">Customer</h3>
              <div style="font-size:13px;line-height:1.7;color:#444">
                <strong>${escapeHtml(customerName)}</strong>${customer.company ? ' — ' + escapeHtml(customer.company) : ''}<br>
                <a href="mailto:${escapeHtml(customer.email)}">${escapeHtml(customer.email)}</a><br>
                <a href="tel:${escapeHtml(customer.phone || '')}">${escapeHtml(customer.phone || '')}</a>
              </div>

              <h3 style="margin:18px 0 10px;font-size:15px;color:#1a1a2e">Fulfillment</h3>
              <div style="font-size:13px;line-height:1.7;color:#444">
                <strong>${escapeHtml(deliveryLabel)}</strong>
                ${address ? '<br>' + escapeHtml(address) : ''}
                ${notes ? '<br><em style="color:#888">Notes: ' + escapeHtml(notes) + '</em>' : ''}
              </div>

              <h3 style="margin:18px 0 10px;font-size:15px;color:#1a1a2e">Items</h3>
              <table style="width:100%;border-collapse:collapse;font-size:13px">
                <thead>
                  <tr style="background:#f8f8fa">
                    <th style="padding:8px 10px;text-align:left;font-size:11px;text-transform:uppercase;color:#888">Item</th>
                    <th style="padding:8px 10px;text-align:center;font-size:11px;text-transform:uppercase;color:#888">Qty</th>
                    <th style="padding:8px 10px;text-align:right;font-size:11px;text-transform:uppercase;color:#888">Unit</th>
                    <th style="padding:8px 10px;text-align:right;font-size:11px;text-transform:uppercase;color:#888">Total</th>
                  </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
                <tfoot>
                  <tr>
                    <td colspan="3" style="padding:12px 10px;text-align:right;font-weight:700;font-size:14px">Order Total</td>
                    <td style="padding:12px 10px;text-align:right;font-weight:900;font-size:16px;color:#f05a28">$${serverTotal.toFixed(2)}</td>
                  </tr>
                </tfoot>
              </table>

              <div style="margin-top:24px;padding:14px;background:#f8f8fa;border-radius:8px;font-size:12px;color:#666">
                Customer has been redirected to Square to complete payment. You'll receive a second email via Square once paid.<br>
                <strong>Payment link:</strong> <a href="${paymentUrl}" style="color:#f05a28;word-break:break-all">${paymentUrl}</a>
              </div>
            </div>
          </div>`

        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Stephens Advanced Store <jonathan@stephensadvanced.com>',
            to: ['jonathan@stephensadvanced.com'],
            reply_to: customer.email,
            subject: `New Extinguisher Order — ${customerName} — $${serverTotal.toFixed(2)}`,
            html
          })
        })
      }
    } catch (emailErr) {
      console.error('store-order email send error:', emailErr)
      // Don't fail the order if email fails — customer can still pay
    }

    return res.status(200).json({
      success: true,
      paymentUrl,
      orderId: sqData.payment_link?.order_id
    })

  } catch (err) {
    console.error('store-order error:', err)
    return res.status(500).json({ error: err.message })
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
