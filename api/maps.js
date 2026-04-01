module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const { action, params } = req.body
  const key = process.env.GOOGLE_MAPS_API_KEY
  if (!key) return res.status(500).json({ error: 'Maps API key not configured' })

  try {
    if (action === 'directions') {
      const waypointStr = params.waypoints?.length
        ? '&waypoints=optimize:true|' + params.waypoints.map(w => encodeURIComponent(w)).join('|')
        : ''
      const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(params.origin)}&destination=${encodeURIComponent(params.destination)}${waypointStr}&key=${key}`
      const resp = await fetch(url)
      return res.json(await resp.json())
    }

    if (action === 'distance_matrix') {
      const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${params.origins.map(o => encodeURIComponent(o)).join('|')}&destinations=${params.destinations.map(d => encodeURIComponent(d)).join('|')}&key=${key}`
      const resp = await fetch(url)
      return res.json(await resp.json())
    }

    if (action === 'geocode') {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(params.address)}&key=${key}`
      const resp = await fetch(url)
      return res.json(await resp.json())
    }

    if (action === 'autocomplete') {
      const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(params.input)}&types=address&components=country:us&key=${key}`
      const resp = await fetch(url)
      return res.json(await resp.json())
    }

    if (action === 'place_details') {
      const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(params.place_id)}&fields=formatted_address,address_components,geometry&key=${key}`
      const resp = await fetch(url)
      return res.json(await resp.json())
    }

    return res.status(400).json({ error: 'Unknown action' })
  } catch (e) {
    console.error('Maps API error:', e)
    return res.status(500).json({ error: e.message })
  }
}
