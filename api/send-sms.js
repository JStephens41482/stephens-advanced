// /api/send-sms.js
// Sends SMS via Twilio — stephensadvanced.com

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { to, body } = req.body
  if (!to || !body) return res.status(400).json({ error: 'Missing to or body' })

  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_PHONE_NUMBER
  if (!sid || !token || !from) return res.status(500).json({ error: 'Twilio not configured' })

  try {
    const auth = Buffer.from(sid + ':' + token).toString('base64')
    const params = new URLSearchParams({ To: to, From: from, Body: body })

    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    })

    const data = await response.json()

    if (!response.ok) {
      console.error('Twilio error:', data)
      return res.status(500).json({ error: data.message || 'SMS failed', detail: data })
    }

    return res.status(200).json({ success: true, sid: data.sid })

  } catch (err) {
    console.error('send-sms error:', err)
    return res.status(500).json({ error: err.message })
  }
}
