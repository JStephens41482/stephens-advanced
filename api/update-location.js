// /api/update-location.js
// Receives Jon's GPS coordinates from the iOS Shortcut automation (runs
// every 30 min even when the field app is closed) and from the in-app beacon.
// Upserts into jon_location (single row, id=1).
//
// Auth: Bearer token OR body.secret matching LOCATION_BEACON_SECRET env var.
// If env var is not set, the endpoint is open (dev mode).
//
// POST { lat, lng, accuracy?, speed?, heading?, secret? }
// → { ok: true, updated_at: <iso> }

const { createClient } = require('@supabase/supabase-js')

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const expected = process.env.LOCATION_BEACON_SECRET
  if (expected) {
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const bodySec = req.body?.secret || ''
    if (auth !== expected && bodySec !== expected) {
      return res.status(401).json({ error: 'unauthorized' })
    }
  }

  const { lat, lng, accuracy, speed, heading, source } = req.body || {}
  const latF = parseFloat(lat)
  const lngF = parseFloat(lng)
  if (!latF || !lngF || isNaN(latF) || isNaN(lngF)) {
    return res.status(400).json({ error: 'lat and lng are required' })
  }

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://motjasdokoxwiodwzyps.supabase.co'
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!sbKey) return res.status(500).json({ error: 'missing supabase key' })
  const supabase = createClient(sbUrl, sbKey)

  const updated_at = new Date().toISOString()
  const { error } = await supabase.from('jon_location').upsert({
    id: 1,
    lat: latF,
    lng: lngF,
    accuracy: accuracy != null ? parseFloat(accuracy) : null,
    speed: speed != null ? parseFloat(speed) : null,
    heading: heading != null ? parseFloat(heading) : null,
    source: source || 'shortcut',
    updated_at
  }, { onConflict: 'id' })

  if (error) {
    console.error('[update-location]', error.message)
    return res.status(500).json({ error: error.message })
  }

  return res.status(200).json({ ok: true, updated_at })
}
