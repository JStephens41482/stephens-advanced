// /api/send-email.js
// Sends invoices via Resend — stephensadvanced.com

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { to, subject, html, invoiceNumber, customerName, attachments } = req.body
  if (!to || !subject || !html) return res.status(400).json({ error: 'Missing required fields' })

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured' })

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Stephens Advanced <jonathan@stephensadvanced.com>',
        to: [to],
        bcc: ['jonathan@stephensadvanced.com'],
        subject,
        html,
        ...(attachments && attachments.length ? { attachments } : {})
      })
    })

    const data = await response.json()

    if (!response.ok) {
      console.error('Resend error:', data)
      return res.status(500).json({ error: data.message || 'Send failed', detail: data })
    }

    return res.status(200).json({ success: true, messageId: data.id })

  } catch (err) {
    console.error('send-email error:', err)
    return res.status(500).json({ error: err.message })
  }
}
