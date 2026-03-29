// /api/send-email.js
// Sends invoices from jonathan@stephensadvanced.com via Gmail API

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { to, subject, html, invoiceNumber, customerName } = req.body
  if (!to || !subject || !html) return res.status(400).json({ error: 'Missing required fields' })

  const clientId     = process.env.GMAIL_CLIENT_ID
  const clientSecret = process.env.GMAIL_CLIENT_SECRET
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN

  if (!clientId || !clientSecret || !refreshToken) {
    return res.status(500).json({ error: 'Gmail credentials not configured' })
  }

  try {
    // Step 1: exchange refresh token for access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type:    'refresh_token'
      })
    })
    const tokenData = await tokenRes.json()
    if (!tokenData.access_token) {
      console.error('Token exchange failed:', tokenData)
      return res.status(500).json({ error: 'Failed to get access token', detail: tokenData })
    }
    const accessToken = tokenData.access_token

    // Step 2: build RFC 2822 message
    const boundary = 'SA_BOUNDARY_' + Date.now()
    const from = 'Stephens Advanced <jonathan@stephensadvanced.com>'
    const rawMessage = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      ``,
      `${stripHtml(html)}`,
      ``,
      `--${boundary}`,
      `Content-Type: text/html; charset="UTF-8"`,
      ``,
      html,
      ``,
      `--${boundary}--`
    ].join('\r\n')

    // Step 3: base64url encode
    const encoded = Buffer.from(rawMessage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    // Step 4: send via Gmail API
    const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ raw: encoded })
    })
    const sendData = await sendRes.json()

    if (!sendRes.ok) {
      console.error('Gmail send failed:', sendData)
      return res.status(500).json({ error: 'Gmail send failed', detail: sendData })
    }

    return res.status(200).json({ success: true, messageId: sendData.id })

  } catch (err) {
    console.error('send-email error:', err)
    return res.status(500).json({ error: err.message })
  }
}

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
