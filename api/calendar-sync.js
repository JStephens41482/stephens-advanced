// /api/calendar-sync.js — Google Calendar sync for job scheduling
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || '780674517325-ar9lod4h4phk6sdbtcljoqv7e1m41g2p.apps.googleusercontent.com'
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary'

  if (!clientSecret || !refreshToken) {
    return res.status(500).json({ error: 'Google Calendar not configured — need GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_CALENDAR_REFRESH_TOKEN in Vercel env vars' })
  }

  // Get access token from refresh token
  let accessToken
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      })
    })
    const tokenData = await tokenRes.json()
    if (!tokenRes.ok) return res.status(500).json({ error: 'Token refresh failed', detail: tokenData })
    accessToken = tokenData.access_token
  } catch (e) {
    return res.status(500).json({ error: 'Token refresh error: ' + e.message })
  }

  const { action, job_id, summary, location, start_time, end_time, description, gcal_event_id } = req.body
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  }
  const baseUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`

  try {
    if (action === 'create') {
      const event = {
        summary: summary || 'Job',
        location: location || '',
        description: description || '',
        start: { dateTime: start_time, timeZone: 'America/Chicago' },
        end: { dateTime: end_time || new Date(new Date(start_time).getTime() + 2 * 60 * 60 * 1000).toISOString(), timeZone: 'America/Chicago' },
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'popup', minutes: 840 },  // 14 hours before
            { method: 'popup', minutes: 120 }   // 2 hours before
          ]
        },
        colorId: '6' // Tangerine
      }

      const createRes = await fetch(baseUrl, { method: 'POST', headers, body: JSON.stringify(event) })
      const createData = await createRes.json()
      if (!createRes.ok) return res.status(500).json({ error: createData.error?.message || 'Create failed', detail: createData })

      return res.json({ success: true, eventId: createData.id, htmlLink: createData.htmlLink })
    }

    if (action === 'update') {
      if (!gcal_event_id) return res.status(400).json({ error: 'gcal_event_id required for update' })
      const event = {
        summary: summary || undefined,
        location: location || undefined,
        description: description || undefined,
        start: start_time ? { dateTime: start_time, timeZone: 'America/Chicago' } : undefined,
        end: end_time ? { dateTime: end_time, timeZone: 'America/Chicago' } : (start_time ? { dateTime: new Date(new Date(start_time).getTime() + 2 * 60 * 60 * 1000).toISOString(), timeZone: 'America/Chicago' } : undefined),
      }
      // Remove undefined fields
      Object.keys(event).forEach(k => event[k] === undefined && delete event[k])

      const updateRes = await fetch(`${baseUrl}/${gcal_event_id}`, { method: 'PATCH', headers, body: JSON.stringify(event) })
      const updateData = await updateRes.json()
      if (!updateRes.ok) return res.status(500).json({ error: updateData.error?.message || 'Update failed' })

      return res.json({ success: true, eventId: updateData.id })
    }

    if (action === 'delete') {
      if (!gcal_event_id) return res.status(400).json({ error: 'gcal_event_id required for delete' })
      const deleteRes = await fetch(`${baseUrl}/${gcal_event_id}`, { method: 'DELETE', headers })
      if (!deleteRes.ok && deleteRes.status !== 410) {
        const errData = await deleteRes.json().catch(() => ({}))
        return res.status(500).json({ error: errData.error?.message || 'Delete failed' })
      }
      return res.json({ success: true })
    }

    return res.status(400).json({ error: 'Unknown action. Use: create, update, delete' })
  } catch (e) {
    console.error('calendar-sync error:', e)
    return res.status(500).json({ error: e.message })
  }
}
