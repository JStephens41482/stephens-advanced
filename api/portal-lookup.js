const { createClient } = require('@supabase/supabase-js')

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const { phone } = req.body
  if (!phone) return res.status(400).json({ error: 'Phone required' })

  // Normalize: strip to digits, remove leading 1 if 11 digits
  let digits = phone.replace(/\D/g, '')
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1)
  if (digits.length !== 10) return res.json({ success: false, message: 'not_found' })

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!sbUrl || !sbKey) return res.status(500).json({ error: 'Server config error' })

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

  // Send SMS
  try {
    const baseUrl = process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'https://stephensadvanced.com'
    await fetch(baseUrl + '/api/send-sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: '+1' + digits,
        body: 'Here\'s your Stephens Advanced portal link:\n' + portalUrl + '\n\nThis link is active for 15 days. Bookmark it for easy access.'
      })
    })
  } catch (e) {
    console.error('SMS send error:', e)
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

  res.json({ success: true })
}
