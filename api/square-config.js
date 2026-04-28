// /api/square-config.js — exposes the PUBLIC Square config to the client
//
// Application ID and Location ID are not secrets — Square's own docs publish
// them in client-side examples. Returning them via this endpoint avoids having
// to hardcode them in appv2.html or wire up build-time substitution.
//
// SQUARE_ACCESS_TOKEN is server-only and is NEVER returned here.

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const appId = process.env.NEXT_PUBLIC_SQUARE_APP_ID || process.env.SQUARE_APP_ID
  const locationId = process.env.NEXT_PUBLIC_SQUARE_LOCATION_ID || process.env.SQUARE_LOCATION_ID
  const sandbox = process.env.SQUARE_SANDBOX === 'true'

  if (!appId || !locationId) {
    return res.status(500).json({
      error: 'Square not configured',
      hint: 'Set NEXT_PUBLIC_SQUARE_APP_ID and NEXT_PUBLIC_SQUARE_LOCATION_ID (or SQUARE_APP_ID / SQUARE_LOCATION_ID) in Vercel env vars'
    })
  }

  // Cache briefly — config rarely changes
  res.setHeader('Cache-Control', 'public, max-age=300')
  return res.json({ appId, locationId, sandbox })
}
