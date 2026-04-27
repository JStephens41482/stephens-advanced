const { createClient } = require('@supabase/supabase-js')

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const { phone } = req.body
  if (!phone) return res.status(400).json({ error: 'Phone required' })

  // Normalize: strip to digits, remove leading 1 if 11 digits
  let digits = phone.replace(/\D/g, '')
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1)
  if (digits.length !== 10) return res.json({ success: false, message: 'not_found' })

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://motjasdokoxwiodwzyps.supabase.co'
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1vdGphc2Rva294d2lvZHd6eXBzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzNDI2NTcsImV4cCI6MjA4ODkxODY1N30.IMf0plnDRhVgts9LjJr219Tax4J175iuWN1u6ZKTZ-I'

  const SB = createClient(sbUrl, sbKey)

  // Search locations by contact_phone (multiple formats)
  const formatted1 = digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6)
  const formatted2 = '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6)
  const { data: locs } = await SB.from('locations')
    .select('id, name, billing_account_id')
    .or(`contact_phone.ilike.%${digits}%,contact_phone.ilike.%${formatted1}%,contact_phone.ilike.%${formatted2}%`)
    .limit(5)

  // Also search contacts table
  let contactLocs = []
  const { data: contacts } = await SB.from('contacts')
    .select('id, phone')
    .or(`phone.ilike.%${digits}%,phone.ilike.%${formatted1}%`)
    .limit(5)

  if (contacts?.length) {
    const contactIds = contacts.map(c => c.id)
    const { data: links } = await SB.from('contact_links')
      .select('entity_id')
      .eq('entity_type', 'location')
      .in('contact_id', contactIds)
    if (links?.length) {
      const locIds = links.map(l => l.entity_id)
      const { data: linkedLocs } = await SB.from('locations')
        .select('id, name, billing_account_id')
        .in('id', locIds)
      contactLocs = linkedLocs || []
    }
  }

  // Combine and deduplicate
  const allLocs = [...(locs || []), ...contactLocs]
  const unique = [...new Map(allLocs.map(l => [l.id, l])).values()]

  if (!unique.length) {
    return res.json({ success: false, message: 'not_found' })
  }

  const loc = unique[0]

  // Generate portal token
  const crypto = require('crypto')
  const token = crypto.randomBytes(16).toString('hex')
  await SB.from('portal_tokens').insert({
    token,
    location_id: loc.id,
    billing_account_id: loc.billing_account_id || null,
    expires_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString()
  })

  const portalUrl = 'https://stephensadvanced.com/portal?t=' + token

  // Send SMS — call Twilio directly. The previous version fetched
  // baseUrl + '/api/send-sms' which silently failed in production
  // (Vercel deployment-protection / self-routing issues). Inlining
  // makes this a single hop, with the real error visible in the response.
  let smsSent = false
  let smsError = null
  const sid = process.env.TWILIO_ACCOUNT_SID
  const tokenTw = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_PHONE_NUMBER
  if (!sid || !tokenTw || !from) {
    smsError = 'twilio_not_configured'
  } else {
    try {
      const auth = Buffer.from(sid + ':' + tokenTw).toString('base64')
      const params = new URLSearchParams({
        To: '+1' + digits,
        From: from,
        Body: "Here's your Stephens Advanced portal link:\n" + portalUrl + '\n\nThis link is active for 15 days. Bookmark it for easy access.'
      })
      const twResp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + auth,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      })
      const twData = await twResp.json()
      if (twResp.ok) {
        smsSent = true
      } else {
        smsError = twData.message || ('twilio_status_' + twResp.status)
        console.error('portal-lookup Twilio error:', twData)
      }
    } catch (e) {
      smsError = e.message
      console.error('portal-lookup SMS exception:', e)
    }
  }

  // Audit log
  try {
    await SB.from('audit_log').insert({
      action: 'create',
      entity_type: 'portal_token',
      entity_id: loc.id,
      actor: 'customer_portal',
      summary: 'Portal link sent via phone lookup to ***' + digits.slice(-4)
    })
  } catch (e) {}

  // Report SMS status truthfully so the UI can show real errors instead
  // of silently telling the user "Check your texts" when nothing was sent.
  res.json({ success: true, sms_sent: smsSent, sms_error: smsError })
}
