// /api/update-location.js
// Accepts GPS from two sources:
//   1. Overland app (iOS/Android) — GeoJSON locations array
//   2. In-app beacon — simple { lat, lng, accuracy, speed, heading }
//
// Auth: secret in query param (?secret=...), Authorization header, or body.secret.
// Set LOCATION_BEACON_SECRET in Vercel env. Leave unset to disable auth (dev only).
//
// Overland setup URL: https://stephensadvanced.com/api/update-location?secret=YOUR_SECRET
// Overland expects { result: "ok" } on success.

const { createClient } = require('@supabase/supabase-js')

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  // Auth — check query param, header, or body
  const expected = process.env.LOCATION_BEACON_SECRET
  if (expected) {
    const querySec = req.query?.secret || new URL(req.url, 'https://x').searchParams.get('secret') || ''
    const headerSec = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const bodySec = req.body?.secret || ''
    if (querySec !== expected && headerSec !== expected && bodySec !== expected) {
      return res.status(401).json({ error: 'unauthorized' })
    }
  }

  // Parse payload — Overland sends { locations: [GeoJSON Feature, ...] }
  // In-app beacon sends { lat, lng, accuracy, speed, heading }
  let lat, lng, accuracy, speed, heading, source

  const body = req.body || {}
  if (Array.isArray(body.locations) && body.locations.length > 0) {
    // Overland format — take the most recent location
    const feat = body.locations[body.locations.length - 1]
    const coords = feat?.geometry?.coordinates  // GeoJSON: [longitude, latitude]
    if (!coords || coords.length < 2) return res.status(400).json({ error: 'invalid GeoJSON coordinates' })
    lng = parseFloat(coords[0])
    lat = parseFloat(coords[1])
    const props = feat?.properties || {}
    accuracy = props.horizontal_accuracy ?? props.accuracy ?? null
    speed = props.speed ?? null
    heading = props.course ?? props.heading ?? null
    source = 'overland'
  } else {
    lat = parseFloat(body.lat)
    lng = parseFloat(body.lng)
    accuracy = body.accuracy != null ? parseFloat(body.accuracy) : null
    speed = body.speed != null ? parseFloat(body.speed) : null
    heading = body.heading != null ? parseFloat(body.heading) : null
    source = body.source || 'app'
  }

  if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'lat and lng are required' })
  }

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://motjasdokoxwiodwzyps.supabase.co'
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!sbKey) return res.status(500).json({ error: 'missing supabase key' })
  const supabase = createClient(sbUrl, sbKey)

  const updated_at = new Date().toISOString()
  const { error } = await supabase.from('jon_location').upsert({
    id: 1, lat, lng,
    accuracy: accuracy != null ? parseFloat(accuracy) : null,
    speed: speed != null ? parseFloat(speed) : null,
    heading: heading != null ? parseFloat(heading) : null,
    source,
    updated_at
  }, { onConflict: 'id' })

  if (error) {
    console.error('[update-location]', error.message)
    return res.status(500).json({ error: error.message })
  }

  // Overland expects { result: "ok" }, everything else gets { ok: true }
  return res.status(200).json(source === 'overland' ? { result: 'ok' } : { ok: true, updated_at })
}
