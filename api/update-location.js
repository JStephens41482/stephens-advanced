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

  // Auth — check query param, header, or body. Same-origin requests from the
  // in-app beacon (running inside our deployed appv2.html) skip the secret
  // check because the browser only sends our Origin header for our own pages.
  // External callers like the Overland iOS app still need the secret.
  const expected = process.env.LOCATION_BEACON_SECRET
  const origin = req.headers.origin || ''
  const sameOrigin = /^https:\/\/(www\.)?stephensadvanced\.com$/i.test(origin)
                  || /\.vercel\.app$/i.test(origin)
  if (expected && !sameOrigin) {
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

  // Multi-tech: resolve which tech this beacon belongs to. Three paths:
  //   1. Body / query carries explicit tech_id (preferred — native shell
  //      and the in-app beacon both know who's logged in)
  //   2. Same-origin browser request with sa_device cookie → look up the
  //      auth_devices row for that cookie and read its tech_id
  //   3. Legacy / Overland with no cookie → fall through to id=1 path
  //      (Jon's row) so existing setups don't break
  //
  // CRITICAL: if we DID attempt cookie resolution (a logged-in browser)
  // but couldn't pin the device to a tech, we REFUSE the write rather
  // than fall through to the id=1 legacy path. Otherwise an employee
  // tech on a legacy device (or one whose row predates the migration)
  // would silently overwrite Jon's location.
  let techId = null
  let cookieAttempted = false
  if (body.tech_id && typeof body.tech_id === 'string') {
    techId = body.tech_id
  } else if (sameOrigin) {
    const cookieHeader = req.headers.cookie || ''
    const m = cookieHeader.match(/(?:^|;\s*)sa_device=([^;]+)/)
    if (m) {
      cookieAttempted = true
      try {
        const crypto = require('crypto')
        const tokenHash = crypto.createHash('sha256').update(decodeURIComponent(m[1])).digest('hex')
        const { data: dev } = await supabase
          .from('auth_devices')
          .select('tech_id, revoked_at, expires_at')
          .eq('token_hash', tokenHash)
          .maybeSingle()
        if (dev?.tech_id && !dev.revoked_at && new Date(dev.expires_at) > new Date()) {
          techId = dev.tech_id
        }
      } catch (e) {
        console.error('[update-location] cookie tech lookup:', e.message)
      }
    }
  }
  if (cookieAttempted && !techId) {
    // Authenticated browser device but tech_id couldn't be resolved (likely
    // the auth_devices row predates the multi-tech migration and the phone
    // doesn't match any techs row). Refuse rather than risk clobbering
    // Jon's GPS with an unknown tech's coordinates. Caller can re-auth to
    // get a tech_id stamped on the device.
    return res.status(403).json({ error: 'Could not resolve tech_id for this device. Re-authenticate.' })
  }

  const updated_at = new Date().toISOString()
  let error
  if (techId) {
    // Per-tech upsert keyed by tech_id (the unique partial index).
    // Each tech has at most one row; their beacons can't collide.
    ;({ error } = await supabase.from('jon_location').upsert({
      tech_id: techId, lat, lng,
      accuracy: accuracy != null ? parseFloat(accuracy) : null,
      speed: speed != null ? parseFloat(speed) : null,
      heading: heading != null ? parseFloat(heading) : null,
      source,
      updated_at
    }, { onConflict: 'tech_id' }))
  } else {
    // Legacy single-row path (Overland or any caller without a tech_id).
    // Continues to write to id=1 — Jon's row.
    ;({ error } = await supabase.from('jon_location').upsert({
      id: 1, lat, lng,
      accuracy: accuracy != null ? parseFloat(accuracy) : null,
      speed: speed != null ? parseFloat(speed) : null,
      heading: heading != null ? parseFloat(heading) : null,
      source,
      updated_at
    }, { onConflict: 'id' }))
  }

  if (error) {
    console.error('[update-location]', error.message)
    return res.status(500).json({ error: error.message })
  }

  // Overland expects { result: "ok" }, everything else gets { ok: true }
  return res.status(200).json(source === 'overland' ? { result: 'ok' } : { ok: true, updated_at })
}
