const { createClient } = require('@supabase/supabase-js')

// ═══ RECURRING EVENT EXPANSION (from calendar.ics.js) ═══
const DAY_MAP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

function expandRecurring(events, rangeStart, rangeEnd) {
  const rs = new Date(rangeStart), re = new Date(rangeEnd)
  const results = []
  for (const ev of (events || [])) {
    if (!ev.recurring) {
      const st = new Date(ev.start_time)
      if (st >= rs && st <= re) results.push({ ...ev })
      continue
    }
    const rule = ev.recurrence_rule || {}
    const until = rule.until ? new Date(rule.until + 'T23:59:59') : re
    const effEnd = until < re ? until : re
    const baseStart = new Date(ev.start_time)
    const baseEnd = new Date(ev.end_time)
    const durMs = baseEnd - baseStart
    if (rule.freq === 'weekly' && rule.days) {
      const targetDays = rule.days.map(d => DAY_MAP[d]).filter(d => d !== undefined)
      let cur = new Date(rs); cur.setHours(0, 0, 0, 0)
      while (cur <= effEnd) {
        if (targetDays.includes(cur.getDay())) {
          const oStart = new Date(cur)
          oStart.setHours(baseStart.getHours(), baseStart.getMinutes(), baseStart.getSeconds())
          if (oStart >= rs && oStart <= effEnd) {
            const oEnd = new Date(oStart.getTime() + durMs)
            results.push({ ...ev, start_time: oStart.toISOString(), end_time: oEnd.toISOString() })
          }
        }
        cur.setDate(cur.getDate() + 1)
      }
    } else if (rule.freq === 'monthly' && rule.day_of_month) {
      let cur = new Date(rs.getFullYear(), rs.getMonth(), 1)
      while (cur <= effEnd) {
        const dom = rule.day_of_month
        const dim = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate()
        if (dom <= dim) {
          const oStart = new Date(cur.getFullYear(), cur.getMonth(), dom, baseStart.getHours(), baseStart.getMinutes())
          if (oStart >= rs && oStart <= effEnd) {
            const oEnd = new Date(oStart.getTime() + durMs)
            results.push({ ...ev, start_time: oStart.toISOString(), end_time: oEnd.toISOString() })
          }
        }
        cur.setMonth(cur.getMonth() + 1)
      }
    }
  }
  return results
}

// ═══ SLOT CALCULATION ═══
function getSlotsForDate(dateStr, calEvents, jobs) {
  const dayStart = new Date(dateStr + 'T00:00:00')
  const dayEnd = new Date(dateStr + 'T23:59:59')
  const dayEvts = expandRecurring(calEvents, dayStart, dayEnd).filter(e => e.event_type !== 'job')
  const dayJobs = jobs.filter(j => j.scheduled_date === dateStr && j.status !== 'cancelled' && j.status !== 'completed')

  const busy = []
  for (const ev of dayEvts) {
    const s = new Date(ev.start_time), e = new Date(ev.end_time)
    busy.push({ start: s.getHours() * 60 + s.getMinutes(), end: e.getHours() * 60 + e.getMinutes() })
  }
  for (const j of dayJobs) {
    const t = j.scheduled_time || '09:00'
    const [h, m] = t.split(':').map(Number)
    busy.push({ start: h * 60 + m, end: h * 60 + m + 90 })
  }
  busy.sort((a, b) => a.start - b.start)

  const workStart = 7 * 60, workEnd = 18 * 60
  const slots = []
  let cursor = workStart
  for (const b of busy) {
    if (b.start > cursor) {
      const s = Math.max(cursor, workStart), e = Math.min(b.start, workEnd)
      if (e - s >= 30) slots.push({ start: minToTime(s), end: minToTime(e) })
    }
    cursor = Math.max(cursor, b.end)
  }
  if (cursor < workEnd) slots.push({ start: minToTime(cursor), end: minToTime(workEnd) })
  return slots
}

function minToTime(m) {
  const h = Math.floor(m / 60), min = m % 60
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h
  return h12 + ':' + (min + '').padStart(2, '0') + ' ' + ampm
}

function getNextBusinessDays(count) {
  const days = []
  const cur = new Date()
  while (days.length < count) {
    cur.setDate(cur.getDate() + 1)
    const dow = cur.getDay()
    if (dow >= 1 && dow <= 5) {
      days.push(cur.toISOString().split('T')[0])
    }
  }
  return days
}

// ═══ BRYCER CITIES ═══
const BRYCER_CITIES = ['fort worth','benbrook','burleson','crowley','edgecliff village','everman','forest hill','haltom city','kennedale','lake worth','north richland hills','richland hills','river oaks','saginaw','sansom park','westover hills','westworth village','white settlement','watauga','blue mound','haslet','keller','southlake','colleyville','grapevine','euless','bedford','hurst']

// ═══ SYSTEM PROMPT ═══
const SYSTEM_PROMPT = `You are the scheduling assistant for Stephens Advanced LLC, a fire suppression inspection company in the Dallas-Fort Worth area. You handle incoming service inquiries from customers via the website chat.

YOUR VOICE:
- You sound like a friendly, competent receptionist at a small local company. Not corporate. Not robotic.
- Short sentences. One question at a time. Never ask two questions in the same message.
- Use casual language: "yeah", "gotcha", "sure thing", "sounds good", "let me check"
- Never use bullet points, numbered lists, dashes, or markdown formatting
- Never use exclamation points more than once per conversation
- Never say "I'm an AI" or "as an AI" or "I'm a virtual assistant" or anything like that
- Never say "I'd be happy to help" or "Great question" or "Absolutely"
- Never volunteer information the customer didn't ask for
- If you don't know something specific about their system, say "I'd need our tech to take a look at that on site" not "I don't have that information"
- Use "we" and "our" when referring to the company
- The tech's name is Jon. You can say "Jon" or "our tech" naturally
- Keep responses under 40 words unless explaining something technical the customer asked about

YOUR KNOWLEDGE — FIRE PROTECTION BASICS:

NFPA 10 — Portable Fire Extinguishers:
- Annual visual inspection required on all extinguishers
- 6-year internal examination required on stored-pressure extinguishers (ABC dry chemical, BC, Purple K, Halon, Halotron, Class D, Clean Agent)
- 12-year hydrostatic test required on: ABC dry chemical, BC, Purple K, Halon, Halotron, Class D, Clean Agent
- 5-year hydrostatic test required on: CO2, Water, Class K
- CO2 and Water and Class K do NOT get 6-year internals
- Extinguisher types: ABC Dry Chemical (most common), Class K (kitchens), CO2 (electrical/server rooms), Water, BC, Purple K, Halon, Halotron, Class D, Clean Agent
- Most restaurants need 2A10BC near exits and Class K in the kitchen

NFPA 17A — Wet Chemical Kitchen Hood Suppression:
- Semi-annual inspection required (every 6 months)
- Brands: Ansul R-102, Pyro-Chem Kitchen Knight II, Buckeye Kitchen Mister, Kidde WHDR, Captive-Aire (TANK and CORE), Amerex
- 33-point inspection including nozzles, fusible links, cylinder pressure, manual pull station, fuel shutoff, micro switch, piping
- Customer needs hood accessible, filters removable, cooking equipment in normal position

NFPA 17 — Dry Chemical Systems (Paint Booths):
- Semi-annual inspection required
- 25-point checklist including nozzles, manual pulls, detectors, agent condition, fan interlock

NFPA 2001 — Clean Agent Suppression:
- Annual inspection required
- Protects server rooms, data centers, electrical rooms
- Agent types: FM-200, Novec 1230, CO2 total flooding

Emergency Lighting (NFPA 101):
- Annual 90-minute discharge test required

SCHEDULING:
- Work hours: 7 AM to 6 PM, Monday through Friday
- Base location: Euless, TX
- Available slots are provided in your context as AVAILABLE_SLOTS
- Default durations: 1 kitchen system = 1hr, 2 systems = 1.5hr, 3-4 = 2.5hr, extinguishers 1-10 = 30min, 11-30 = 1hr, 31-100 = 2-3hr, 100+ = full day, paint booth = 1hr, clean agent = 1.5hr

PRICING (only if asked):
- Extinguisher inspection: $22.80 each
- Kitchen suppression: $285/system (standard), $513 (Captive-Aire TANK), $741 (Captive-Aire CORE), add $57/additional tank
- Emergency lighting: $22.80/fixture
- Labor: $228/hour
- Emergency: $570 (business hrs), $855 (after hrs), $1,140 (holiday/weekend)
- 10% discount for payment within 24 hours of service
- For large/unusual jobs, say "let me have Jon put together a quote for you"

BRYCER COMPLIANCE:
- Fort Worth and surrounding cities require reports filed with the fire marshal through Brycer
- We handle this automatically

YOUR ACTIONS:
When you need to do something, include an action block:
\`\`\`action
{"type":"...", ...params}
\`\`\`

Available actions:
- {"type":"create_customer","business_name":"...","contact_name":"...","phone":"...","email":"...","address":"...","city":"...","state":"TX","zip":"..."}
- {"type":"schedule_job","location_id":"...","date":"YYYY-MM-DD","time":"HH:MM","scope":["suppression","extinguishers","elights"],"notes":"...","estimated_duration_hours":1.5}
- {"type":"generate_portal","location_id":"..."}
- {"type":"sms_jon","body":"..."}
- {"type":"sms_customer","to":"phone","body":"..."}
- {"type":"need_quote","business_name":"...","contact":"...","phone":"...","details":"..."}

CONVERSATION FLOW:
1. Figure out what they need
2. Get business name and city
3. Get contact name and phone
4. Figure out scope (what equipment, how many)
5. Suggest an available date/time
6. Confirm the appointment
7. Create customer, schedule job, text Jon, text customer, give portal access
8. Ask one question at a time. Never ask for all info at once.

WHAT YOU DON'T DO:
- Don't diagnose system problems over chat
- Don't schedule weekends unless emergency
- Don't argue about pricing
- If customer is upset, say "let me have Jon give you a call directly" and get their number
- If you don't know, say "I'd want Jon to answer that one, want me to have him call you?"`

// ═══ HANDLER ═══
// DISABLED 2026-04-13 — chat widget is off the site until Twilio A2P is approved,
// the bot is connected to Google Calendar for real availability, it creates jobs
// in Supabase, and it stops making confirmations it can't fulfill. Until then we
// short-circuit with a static "coming soon" reply and burn zero Claude tokens.
// Re-enable by removing this block and restoring the original handler body.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  return res.status(200).json({
    reply: "Thanks for reaching out! Our live chat is coming soon. In the meantime, please call (214) 994-4799 or email jonathan@stephensadvanced.com and we'll get right back to you.",
    disabled: true
  })
}

// ═══ ORIGINAL HANDLER — kept as a dead function, not exported. Swap module.exports above to re-enable. ═══
// eslint-disable-next-line no-unused-vars
async function _disabledHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const claudeKey = process.env.CLAUDE_KEY
  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://motjasdokoxwiodwzyps.supabase.co'
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1vdGphc2Rva294d2lvZHd6eXBzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzNDI2NTcsImV4cCI6MjA4ODkxODY1N30.IMf0plnDRhVgts9LjJr219Tax4J175iuWN1u6ZKTZ-I'
  if (!claudeKey) return res.status(500).json({ error: 'No Claude API key' })

  const sb = createClient(sbUrl, sbKey)
  const { messages } = req.body
  if (!messages || !messages.length) return res.status(400).json({ error: 'messages required' })

  try {
    // ─── Build schedule context ───
    const today = new Date().toISOString().split('T')[0]
    const bizDays = getNextBusinessDays(5)
    const { data: calEvents } = await sb.from('calendar_events').select('*')
    const { data: jobs } = await sb.from('jobs').select('*,location:locations(name,city)').in('scheduled_date', [today, ...bizDays])

    let slotsCtx = 'AVAILABLE_SLOTS:\n'
    for (const d of [today, ...bizDays]) {
      const dt = new Date(d + 'T12:00:00')
      const label = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
      const slots = getSlotsForDate(d, calEvents || [], jobs || [])
      slotsCtx += `${label}: ${slots.length ? slots.map(s => s.start + ' - ' + s.end).join(', ') : 'FULL'}\n`
    }

    let jobsCtx = 'EXISTING_JOBS:\n'
    for (const d of [today, ...bizDays]) {
      const dt = new Date(d + 'T12:00:00')
      const label = dt.toLocaleDateString('en-US', { weekday: 'short' })
      const dayJobs = (jobs || []).filter(j => j.scheduled_date === d && j.status !== 'cancelled')
      if (dayJobs.length) {
        jobsCtx += `${label}: ${dayJobs.map(j => (j.location?.name || '?') + ' (' + (j.location?.city || '?') + ') ' + (j.scheduled_time || '')).join(', ')}\n`
      } else {
        jobsCtx += `${label}: [empty]\n`
      }
    }

    const dynamicCtx = `TODAY'S DATE: ${today}\n\n${slotsCtx}\n${jobsCtx}`

    // ─── Call Claude ───
    const apiMessages = [
      { role: 'user', content: SYSTEM_PROMPT + '\n\n' + dynamicCtx + '\n\nCustomer says: ' + messages[0].content },
      ...messages.slice(1)
    ]

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: apiMessages
      })
    })

    const claudeData = await claudeRes.json()
    if (!claudeRes.ok) return res.status(500).json({ error: 'Claude API error', detail: claudeData })

    let reply = claudeData.content?.[0]?.text || 'Sorry, I had trouble with that. Can you try again?'

    // ─── Parse and execute actions ───
    const actionsTaken = []
    const actionBlocks = reply.match(/```action\s*([\s\S]*?)```/g) || []
    let lastLocationId = null

    for (const block of actionBlocks) {
      try {
        const json = block.replace(/```action\s*/, '').replace(/```/, '').trim()
        const action = JSON.parse(json)

        if (action.type === 'create_customer') {
          const isBrycer = BRYCER_CITIES.includes((action.city || '').toLowerCase())
          const { data: loc, error } = await sb.from('locations').insert({
            name: action.business_name, contact_name: action.contact_name,
            contact_phone: action.phone, contact_email: action.email || null,
            address: action.address || null, city: action.city || null,
            state: action.state || 'TX', zip: action.zip || null,
            is_brycer_jurisdiction: isBrycer,
            brycer_ahj_name: isBrycer ? (action.city || '') + ' Fire Department' : null
          }).select().single()
          if (loc) {
            lastLocationId = loc.id
            actionsTaken.push({ type: 'create_customer', id: loc.id })
            // geocode address to store lat/lng
            if (action.address) {
              try {
                const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent([action.address, action.city, action.state, action.zip].filter(Boolean).join(', '))}&key=${process.env.GOOGLE_MAPS_API_KEY}`
                const geoRes = await fetch(geoUrl)
                const geoData = await geoRes.json()
                if (geoData.results?.[0]?.geometry?.location) {
                  const { lat, lng } = geoData.results[0].geometry.location
                  await sb.from('locations').update({ lat, lng }).eq('id', loc.id)
                }
              } catch (e) { console.error('geocode:', e) }
            }
          }
        }

        else if (action.type === 'schedule_job') {
          const locId = action.location_id || lastLocationId
          if (!locId) continue
          const { data: job } = await sb.from('jobs').insert({
            location_id: locId, scheduled_date: action.date, scheduled_time: action.time || '09:00',
            scope: action.scope || ['extinguishers', 'suppression'], status: 'scheduled',
            notes: action.notes || 'Booked via website chat'
          }).select().single()
          if (job) {
            // sync calendar event
            const startDt = new Date(action.date + 'T' + (action.time || '09:00') + ':00')
            const durHrs = action.estimated_duration_hours || 1.5
            const endDt = new Date(startDt.getTime() + durHrs * 60 * 60 * 1000)
            await sb.from('calendar_events').insert({
              title: action.notes || 'Website booking', event_type: 'job',
              start_time: startDt.toISOString(), end_time: endDt.toISOString(),
              location_id: locId, job_id: job.id, color: '#3b82f6'
            })
            // check brycer
            const { data: loc2 } = await sb.from('locations').select('is_brycer_jurisdiction,name').eq('id', locId).single()
            if (loc2?.is_brycer_jurisdiction) {
              await sb.from('brycer_queue').insert({ location_id: locId, location_name: loc2.name, submitted: false })
            }
            actionsTaken.push({ type: 'schedule_job', job_id: job.id })
          }
        }

        else if (action.type === 'generate_portal') {
          const locId = action.location_id || lastLocationId
          if (!locId) continue
          const arr = new Uint8Array(16)
          require('crypto').getRandomValues(arr)
          const token = Array.from(arr, b => b.toString(16).padStart(2, '0')).join('')
          await sb.from('portal_tokens').insert({
            token, location_id: locId, billing_account_id: null,
            expires_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString()
          })
          const portalUrl = 'https://stephensadvanced.com/portal?t=' + token
          // inject portal URL into reply text
          reply = reply.replace(/\[portal\s*(?:URL|link)?\]/gi, portalUrl)
          if (!reply.includes(portalUrl)) reply += '\n\nHere\'s your portal link: ' + portalUrl
          actionsTaken.push({ type: 'generate_portal', url: portalUrl })
        }

        else if (action.type === 'sms_jon') {
          try {
            await fetch((process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : '') + '/api/send-sms', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ to: '+12149944799', body: action.body })
            })
          } catch (e) { console.error('sms_jon:', e) }
          actionsTaken.push({ type: 'sms_jon' })
        }

        else if (action.type === 'sms_customer') {
          try {
            await fetch((process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : '') + '/api/send-sms', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ to: action.to, body: action.body })
            })
          } catch (e) { console.error('sms_customer:', e) }
          actionsTaken.push({ type: 'sms_customer' })
        }

        else if (action.type === 'need_quote') {
          const msg = `QUOTE REQUEST via website\n${action.business_name || '?'}\n${action.contact || '?'} ${action.phone || ''}\n${action.details || ''}`
          try {
            await fetch((process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : '') + '/api/send-sms', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ to: '+12149944799', body: msg })
            })
          } catch (e) { console.error('need_quote sms:', e) }
          actionsTaken.push({ type: 'need_quote' })
        }
      } catch (e) { console.error('action exec error:', e) }
    }

    // Strip action blocks from reply text
    const cleanReply = reply.replace(/```action\s*[\s\S]*?```/g, '').trim()

    res.status(200).json({ reply: cleanReply, actions_taken: actionsTaken })

  } catch (e) {
    console.error('scheduler-chat error:', e)
    res.status(500).json({ error: e.message })
  }
}
