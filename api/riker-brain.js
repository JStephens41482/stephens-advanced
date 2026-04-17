// /api/riker-brain.js
// Core scheduling AI for Riker. Handles:
//   - Inbound SMS from customers (conversational scheduling)
//   - Inbound SMS from Jon (YES/NO replies to pending confirmations, ad-hoc)
//   - Building context (calendar, jobs, William availability, location data)
//   - Executing actions (create customer, schedule job, etc.)
//   - The manual-confirmation gate: until RIKER_AUTO_CONFIRM=true, every
//     customer-facing action is written to pending_confirmations and Jon
//     gets texted for approval before it fires.

const william = require('./william-schedule')

const JON_PHONE = '+12149944799'
const CLAUDE_MODEL = 'claude-sonnet-4-6'

// Until Jon flips this on, everything goes through his approval first.
const AUTO_CONFIRM = process.env.RIKER_AUTO_CONFIRM === 'true'

// ═══ RECURRING EVENT EXPANSION (copied from scheduler-chat) ═══
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
    }
  }
  return results
}

// ═══ SLOT CALCULATION (William-aware) ═══
function timeToMin(t) {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}
function minToTime(m) {
  const h = Math.floor(m / 60), min = m % 60
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h
  return h12 + ':' + (min + '').padStart(2, '0') + ' ' + ampm
}

function getSlotsForDate(dateStr, calEvents, jobs) {
  const avail = william.getJonAvailability(new Date(dateStr + 'T12:00:00'))
  if (!avail.available) return []

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
    const dur = (j.estimated_duration_hours || 1.5) * 60
    busy.push({ start: h * 60 + m, end: h * 60 + m + dur })
  }
  busy.sort((a, b) => a.start - b.start)

  const workStart = timeToMin(avail.workStart)
  const workEnd = timeToMin(avail.workEnd)
  const slots = []
  let cursor = workStart
  for (const b of busy) {
    if (b.start > cursor) {
      const s = Math.max(cursor, workStart), e = Math.min(b.start, workEnd)
      if (e - s >= 30) slots.push({ start: minToTime(s), end: minToTime(e), startMin: s, endMin: e })
    }
    cursor = Math.max(cursor, b.end)
  }
  if (cursor < workEnd) slots.push({ start: minToTime(cursor), end: minToTime(workEnd), startMin: cursor, endMin: workEnd })
  return slots
}

// Does a proposed time fit into Jon's availability + no conflicts?
function slotFits(dateStr, timeHHMM, durationHours, calEvents, jobs) {
  const slots = getSlotsForDate(dateStr, calEvents, jobs)
  const startMin = timeToMin(timeHHMM)
  const endMin = startMin + Math.round(durationHours * 60)
  for (const s of slots) {
    if (startMin >= s.startMin && endMin <= s.endMin) return true
  }
  return false
}

function getNextBusinessDays(count) {
  const days = []
  const cur = new Date()
  while (days.length < count) {
    cur.setDate(cur.getDate() + 1)
    const dow = cur.getDay()
    if (dow >= 1 && dow <= 5) days.push(cur.toISOString().split('T')[0])
  }
  return days
}

const BRYCER_CITIES = ['fort worth', 'benbrook', 'burleson', 'crowley', 'edgecliff village', 'everman', 'forest hill', 'haltom city', 'kennedale', 'lake worth', 'north richland hills', 'richland hills', 'river oaks', 'saginaw', 'sansom park', 'westover hills', 'westworth village', 'white settlement', 'watauga', 'blue mound', 'haslet', 'keller', 'southlake', 'colleyville', 'grapevine', 'euless', 'bedford', 'hurst']

// ═══ SYSTEM PROMPTS ═══

const CUSTOMER_PROMPT = `You are Riker, the scheduling assistant for Stephens Advanced LLC, a fire suppression inspection company serving Dallas-Fort Worth. You're handling a conversation with a customer. Check CHANNEL in context — your response length adjusts.

VOICE:
- Friendly receptionist at a small local company. Not corporate, not robotic.
- SMS: under 30 words per message. Email: under 80 words, plain paragraphs, no markdown.
- One question at a time. Never ask two things in the same message.
- Casual: "yeah", "gotcha", "sure", "sounds good"
- No markdown, no bullet points, no emojis
- Never say "I'm an AI" or "as a virtual assistant"
- Never say "I'd be happy to help" or "Great question" or "Absolutely"
- Don't volunteer info they didn't ask for
- Our tech's name is Jon. You can say "Jon" or "our tech"
- For email: sign off with "— Riker, Stephens Advanced" on a new paragraph at the end

KNOWLEDGE:
- NFPA 10: extinguisher annual inspection, 6-year internal, 12-year hydro (ABC/BC/Purple K/Halotron), 5-year hydro (CO2/water/Class K)
- NFPA 17A: kitchen hood suppression, semi-annual. Brands: Ansul R-102, Pyro-Chem Kitchen Knight II, Buckeye, Kidde WHDR, Captive-Aire, Amerex
- NFPA 17: paint booth dry chem, semi-annual
- NFPA 2001: clean agent, annual
- Emergency lights: annual 90-min discharge test

PRICING (only if asked):
- Extinguisher inspection $22.80 each
- Kitchen suppression $285/system ($513 Captive-Aire TANK, $741 CORE, +$57/extra tank)
- Emergency lighting $22.80/fixture
- Labor $228/hr
- 10% discount for payment within 24hrs
- Large/unusual jobs: "let me have Jon put together a quote"

SCHEDULING:
- Work hours 7 AM - 6 PM weekdays (adjusted daily for Jon's son William's school)
- Available slots provided in AVAILABLE_SLOTS context
- Default durations: 1 kitchen system = 1hr, 2 = 1.5hr, 3-4 = 2.5hr, 1-10 ext = 30min, 11-30 ext = 1hr, paint booth = 1hr, clean agent = 1.5hr

BRYCER:
- Fort Worth + surrounding cities require Brycer compliance filing. We handle it automatically.

CONVERSATION FLOW:
1. Figure out what they need (type of inspection, equipment)
2. Get business name + city
3. Get contact name (if not already provided)
4. Figure out scope
5. Propose a time from AVAILABLE_SLOTS
6. When they confirm: issue schedule_job action

ACTIONS — include at end of your reply when ready to act:
\`\`\`action
{"type":"schedule_job","business_name":"...","contact_name":"...","phone":"...","address":"...","city":"...","state":"TX","zip":"...","date":"YYYY-MM-DD","time":"HH:MM","scope":["suppression","extinguishers","elights"],"duration_hours":1.5,"notes":"what the customer said they need"}
\`\`\`

Or for a quote request Jon needs to handle:
\`\`\`action
{"type":"need_quote","business_name":"...","contact":"...","phone":"...","details":"..."}
\`\`\`

Only issue the action when you have all the info AND the customer agreed to the proposed time. Never issue an action with placeholder/unknown values.

DON'T:
- Don't diagnose system problems over text
- Don't schedule weekends
- Don't argue about pricing
- If they're upset: "let me have Jon give you a call" and confirm their number
- If you don't know: "let me check with Jon and text you back"`

const JON_PROMPT = `You are Riker, Jon's scheduling assistant. Jon is the owner/tech at Stephens Advanced LLC. He just texted you.

If there's a PENDING_CONFIRMATION in your context, Jon is likely replying to it. Watch for:
- "YES", "Y", "yes", "approve", "ok", "do it", "sure", "confirm" → approve the pending action
- "NO", "N", "reject", "cancel", "don't" → reject it
- A new proposed time like "Tuesday 2pm instead" or "make it 10am Wed" → reject current pending and treat as counter-offer to relay to customer
- Anything else → ask him clarifying question

VOICE (to Jon):
- Extremely concise. He's working. Short sentences.
- No pleasantries, no "great!" / "awesome"
- Status updates: "Done. Texted Maria her 10am Tue confirmation." That kind of thing.

ACTIONS:
\`\`\`action
{"type":"approve_pending","pending_id":"..."}
\`\`\`
\`\`\`action
{"type":"reject_pending","pending_id":"...","reason":"..."}
\`\`\`
\`\`\`action
{"type":"counter_offer","pending_id":"...","new_date":"YYYY-MM-DD","new_time":"HH:MM","note":"what to tell customer"}
\`\`\`

If there's no pending confirmation and Jon is just chatting (asking about schedule, customers, etc.), keep it conversational and useful. You have access to his calendar, jobs, and William's availability in context.`

// ═══ CLAUDE CALL ═══
// History must end with an inbound (user) message. Consecutive same-role
// messages are collapsed since Claude requires strict alternation.
async function callClaude(systemPrompt, contextBlock, history) {
  const claudeKey = process.env.CLAUDE_KEY
  if (!claudeKey) throw new Error('CLAUDE_KEY not set')

  const messages = []
  for (const h of (history || [])) {
    const role = h.direction === 'inbound' ? 'user' : 'assistant'
    if (messages.length && messages[messages.length - 1].role === role) {
      messages[messages.length - 1].content += '\n' + h.body
    } else {
      messages.push({ role, content: h.body })
    }
  }
  if (!messages.length || messages[0].role !== 'user') {
    // No user turn to respond to
    return ''
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': claudeKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: systemPrompt + '\n\n' + contextBlock,
      messages
    })
  })
  const data = await res.json()
  if (!res.ok) throw new Error('Claude error: ' + JSON.stringify(data))
  return data.content?.[0]?.text || ''
}

function parseActions(text) {
  const blocks = text.match(/```action\s*([\s\S]*?)```/g) || []
  const actions = []
  for (const b of blocks) {
    try {
      const json = b.replace(/```action\s*/, '').replace(/```/, '').trim()
      actions.push(JSON.parse(json))
    } catch (e) { /* skip malformed */ }
  }
  const clean = text.replace(/```action\s*[\s\S]*?```/g, '').trim()
  return { clean, actions }
}

// ═══ CONTEXT BUILDING ═══

async function buildScheduleContext(supabase) {
  const today = new Date().toISOString().split('T')[0]
  const days = [today, ...getNextBusinessDays(7)]
  const { data: calEvents } = await supabase.from('calendar_events').select('*')
  const { data: jobs } = await supabase.from('jobs').select('*,location:locations(name,city)').in('scheduled_date', days)

  let slotsCtx = 'AVAILABLE_SLOTS (William-schedule aware):\n'
  for (const d of days) {
    const dt = new Date(d + 'T12:00:00')
    const label = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    const slots = getSlotsForDate(d, calEvents || [], jobs || [])
    const avail = william.getJonAvailability(dt)
    if (!avail.available) {
      slotsCtx += `${label} (${d}): BLOCKED — ${avail.reason}\n`
    } else {
      slotsCtx += `${label} (${d}): ${slots.length ? slots.map(s => s.start + '-' + s.end).join(', ') : 'FULL'} [${avail.reason}]\n`
    }
  }

  let jobsCtx = 'EXISTING_JOBS:\n'
  for (const d of days) {
    const dt = new Date(d + 'T12:00:00')
    const label = dt.toLocaleDateString('en-US', { weekday: 'short' })
    const dayJobs = (jobs || []).filter(j => j.scheduled_date === d && j.status !== 'cancelled')
    jobsCtx += dayJobs.length
      ? `${label} (${d}): ${dayJobs.map(j => (j.location?.name || '?') + ' ' + (j.scheduled_time || '')).join(', ')}\n`
      : `${label} (${d}): [empty]\n`
  }

  return { today, slotsCtx, jobsCtx, calEvents: calEvents || [], jobs: jobs || [] }
}

// ═══ ACTION EXECUTION ═══

async function geocode(addr) {
  if (!addr || !process.env.GOOGLE_MAPS_API_KEY) return null
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addr)}&key=${process.env.GOOGLE_MAPS_API_KEY}`
    const r = await fetch(url)
    const d = await r.json()
    return d.results?.[0]?.geometry?.location || null
  } catch { return null }
}

async function sendSMS(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_PHONE_NUMBER
  if (!sid || !token || !from) throw new Error('Twilio not configured')
  const auth = Buffer.from(sid + ':' + token).toString('base64')
  const params = new URLSearchParams({ To: to, From: from, Body: body })
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  })
  const data = await res.json()
  if (!res.ok) throw new Error('Twilio send failed: ' + (data.message || res.status))
  return data.sid
}

async function sendEmail({ to, subject, body, inReplyTo, references }) {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) throw new Error('RESEND_API_KEY not configured')
  const html = body.split('\n\n').map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')
  const headers = {}
  if (inReplyTo) headers['In-Reply-To'] = inReplyTo
  if (references) headers['References'] = references

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Stephens Advanced <jonathan@stephensadvanced.com>',
      to: [to],
      subject,
      html,
      text: body,
      ...(Object.keys(headers).length ? { headers } : {})
    })
  })
  const data = await res.json()
  if (!res.ok) throw new Error('Resend send failed: ' + (data.message || res.status))
  return data.id
}

// Send a reply on the conversation's channel and log it. Works for both SMS
// and email. For email threading, pass lastEmailMessageId + lastEmailSubject.
async function sendReply({ conversation, body, supabase, subject, inReplyTo, references }) {
  const channel = conversation.channel || 'sms'
  let externalId = null
  if (channel === 'sms') {
    externalId = await sendSMS(conversation.phone, body)
  } else {
    externalId = await sendEmail({
      to: conversation.email,
      subject: subject || 'Re: scheduling',
      body,
      inReplyTo,
      references
    })
  }
  await supabase.from('messages').insert({
    conversation_id: conversation.id,
    direction: 'outbound',
    channel,
    body,
    ...(channel === 'sms' ? { twilio_sid: externalId } : { email_message_id: externalId, email_subject: subject })
  })
  return externalId
}

// Execute an approved scheduling action (creates location if new + job + calendar event)
async function executeSchedule(action, supabase, opts = {}) {
  let locationId = action.location_id || opts.locationId || null
  let locationName = action.business_name
  let isBrycer = false

  if (!locationId) {
    isBrycer = BRYCER_CITIES.includes((action.city || '').toLowerCase())
    const { data: loc, error } = await supabase.from('locations').insert({
      name: action.business_name,
      contact_name: action.contact_name,
      contact_phone: action.phone,
      address: action.address || null,
      city: action.city || null,
      state: action.state || 'TX',
      zip: action.zip || null,
      is_brycer_jurisdiction: isBrycer,
      brycer_ahj_name: isBrycer ? (action.city || '') + ' Fire Department' : null,
      sms_opt_in: true,
      sms_opt_in_at: new Date().toISOString(),
      sms_opt_in_source: 'inbound_sms'
    }).select().single()
    if (error) throw new Error('create location: ' + error.message)
    locationId = loc.id
    if (action.address) {
      const geo = await geocode([action.address, action.city, action.state, action.zip].filter(Boolean).join(', '))
      if (geo) await supabase.from('locations').update({ lat: geo.lat, lng: geo.lng }).eq('id', locationId)
    }
  } else {
    // Existing location — pull its brycer flag + name for the queue insert below
    const { data: locCheck } = await supabase
      .from('locations')
      .select('is_brycer_jurisdiction, name')
      .eq('id', locationId)
      .single()
    isBrycer = !!locCheck?.is_brycer_jurisdiction
    locationName = locCheck?.name || locationName
  }

  const { data: job, error: jobErr } = await supabase.from('jobs').insert({
    location_id: locationId,
    scheduled_date: action.date,
    scheduled_time: action.time || '09:00',
    scope: action.scope || ['extinguishers', 'suppression'],
    status: 'scheduled',
    estimated_duration_hours: action.duration_hours || 1.5,
    notes: action.notes || 'Booked via SMS'
  }).select().single()
  if (jobErr) throw new Error('create job: ' + jobErr.message)

  const startDt = new Date(action.date + 'T' + (action.time || '09:00') + ':00')
  const endDt = new Date(startDt.getTime() + (action.duration_hours || 1.5) * 3600000)
  await supabase.from('calendar_events').insert({
    title: action.notes || 'SMS booking: ' + (locationName || ''),
    event_type: 'job',
    start_time: startDt.toISOString(),
    end_time: endDt.toISOString(),
    location_id: locationId,
    job_id: job.id,
    color: '#3b82f6'
  })

  if (isBrycer) {
    await supabase.from('brycer_queue').insert({ location_id: locationId, location_name: locationName, submitted: false })
  }

  return { locationId, jobId: job.id }
}

// ═══ PROCESS CUSTOMER MESSAGE ═══

async function processCustomer({ conversation, supabase }) {
  // Load full conversation history (webhook has already logged the current inbound message)
  const { data: history } = await supabase
    .from('messages')
    .select('direction, body, created_at')
    .eq('conversation_id', conversation.id)
    .order('created_at', { ascending: true })

  const ctx = await buildScheduleContext(supabase)
  const channel = conversation.channel || 'sms'
  const identity = channel === 'email'
    ? `CUSTOMER_EMAIL: ${conversation.email}`
    : `CUSTOMER_PHONE: ${conversation.phone}`
  const contextBlock = `TODAY: ${ctx.today}\nCHANNEL: ${channel}\n${identity}\n${conversation.location_id ? 'KNOWN_LOCATION_ID: ' + conversation.location_id + '\n' : ''}${ctx.slotsCtx}\n${ctx.jobsCtx}`

  const reply = await callClaude(CUSTOMER_PROMPT, contextBlock, history || [])
  const { clean, actions } = parseActions(reply)

  const outbound = []
  let autoConfirmed = false

  for (const action of actions) {
    if (action.type === 'schedule_job') {
      // Decide: auto-confirm or ask Jon?
      const fits = slotFits(action.date, action.time, action.duration_hours || 1.5, ctx.calEvents, ctx.jobs)
      const canAuto = AUTO_CONFIRM && fits
      const reasoning = !fits
        ? 'Proposed time conflicts with schedule or William constraints'
        : !AUTO_CONFIRM
          ? 'Manual-confirm mode (RIKER_AUTO_CONFIRM not enabled)'
          : ''

      if (canAuto) {
        try {
          await executeSchedule(action, supabase, { locationId: conversation.location_id })
          autoConfirmed = true
          // Ping Jon with a heads-up (not asking permission)
          outbound.push({ to: JON_PHONE, body: `Auto-booked: ${action.business_name} ${action.date} ${action.time} (${(action.scope || []).join(',')})` })
        } catch (e) {
          // Fall through to manual gate
          await createPendingConfirmation({ action, clean, conversation, supabase, reasoning: 'Auto-execute failed: ' + e.message })
          return { clean: "Let me double-check with Jon and text you right back.", outbound }
        }
      } else {
        await createPendingConfirmation({ action, clean, conversation, supabase, reasoning })
        // Don't send `clean` to customer yet — wait for Jon's YES
        return {
          clean: "Let me double-check with Jon and text you right back.",
          outbound,
          pendingJon: true
        }
      }
    } else if (action.type === 'need_quote') {
      const body = `QUOTE NEEDED\n${action.business_name || '?'}\n${action.contact || '?'} ${action.phone || ''}\n${action.details || ''}`
      outbound.push({ to: JON_PHONE, body })
    }
  }

  return { clean, outbound, autoConfirmed }
}

async function createPendingConfirmation({ action, clean, conversation, supabase, reasoning }) {
  const { data: pending } = await supabase.from('pending_confirmations').insert({
    source_conversation_id: conversation.id,
    source_channel: conversation.channel || 'sms',
    customer_phone: conversation.phone || null,
    customer_email: conversation.email || null,
    customer_name: conversation.customer_name || action.contact_name || null,
    location_id: conversation.location_id || null,
    proposed_action: action,
    proposed_reply: clean,
    reasoning
  }).select().single()

  // Text Jon (confirmation gate is always SMS, regardless of source channel)
  const via = conversation.channel === 'email' ? ` (via email from ${conversation.email})` : ''
  const lines = [
    `CONFIRM? ${action.business_name || conversation.customer_name || 'Unknown'}${via}`,
    `${action.date} ${action.time} (${action.duration_hours || 1.5}hr)`,
    `${(action.scope || []).join(', ')}`,
    action.city ? action.city : null,
    reasoning ? `(${reasoning})` : null,
    '',
    'Reply YES to approve, NO to reject, or suggest alt like "Tue 2pm"'
  ].filter(Boolean).join('\n')

  await sendSMS(JON_PHONE, lines)
  return pending
}

// ═══ PROCESS JON MESSAGE ═══

async function processJon({ message, supabase }) {
  // Check for an open pending confirmation
  const { data: pendings } = await supabase
    .from('pending_confirmations')
    .select('*')
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)

  const pending = pendings?.[0]
  const msg = message.trim().toLowerCase()

  if (pending) {
    // Simple keyword match for common approvals/rejections
    const yes = /^(y|yes|ok|okay|sure|do it|approve|confirm|go|send it)\b/i.test(message.trim())
    const no = /^(n|no|reject|cancel|don'?t|stop|hold)\b/i.test(message.trim())

    if (yes) {
      try {
        await executeSchedule(pending.proposed_action, supabase, { locationId: pending.location_id })
        await supabase.from('pending_confirmations').update({
          status: 'executed',
          responded_at: new Date().toISOString(),
          jon_response: message
        }).eq('id', pending.id)

        // Load the conversation so we can reply on the correct channel
        const { data: conv } = await supabase
          .from('conversations')
          .select('*')
          .eq('id', pending.source_conversation_id)
          .single()

        if (conv) {
          // For email threading, find the last inbound message for headers
          let inReplyTo = null, references = null, subject = null
          if (conv.channel === 'email') {
            const { data: lastInbound } = await supabase
              .from('messages')
              .select('email_message_id, email_subject')
              .eq('conversation_id', conv.id)
              .eq('direction', 'inbound')
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle()
            if (lastInbound) {
              inReplyTo = lastInbound.email_message_id
              references = lastInbound.email_message_id
              subject = lastInbound.email_subject
                ? (lastInbound.email_subject.startsWith('Re:') ? lastInbound.email_subject : 'Re: ' + lastInbound.email_subject)
                : 'Re: scheduling'
            }
          }
          await sendReply({ conversation: conv, body: pending.proposed_reply, supabase, subject, inReplyTo, references })
        } else {
          // Fallback: use raw phone/email from the pending row
          if (pending.customer_phone) await sendSMS(pending.customer_phone, pending.proposed_reply)
          else if (pending.customer_email) await sendEmail({ to: pending.customer_email, subject: 'Re: scheduling', body: pending.proposed_reply })
        }

        return { reply: `Done. Sent confirmation to ${pending.customer_name || pending.customer_phone || pending.customer_email}.`, outbound: [] }
      } catch (e) {
        await supabase.from('pending_confirmations').update({
          status: 'failed',
          responded_at: new Date().toISOString(),
          jon_response: message
        }).eq('id', pending.id)
        return { reply: `Failed to execute: ${e.message}`, outbound: [] }
      }
    }

    if (no) {
      await supabase.from('pending_confirmations').update({
        status: 'rejected',
        responded_at: new Date().toISOString(),
        jon_response: message
      }).eq('id', pending.id)

      // Notify the customer that we need to reschedule, on the right channel
      const { data: conv } = await supabase.from('conversations').select('*').eq('id', pending.source_conversation_id).single()
      const rejMsg = "Hey — Jon needs to adjust that time. I'll reach back out shortly with another option."
      if (conv) {
        try { await sendReply({ conversation: conv, body: rejMsg, supabase, subject: 'Re: scheduling' }) } catch (e) { console.error('reject notify:', e.message) }
      } else if (pending.customer_phone) {
        await sendSMS(pending.customer_phone, rejMsg)
      }
      return { reply: `Rejected. Told ${pending.customer_name || 'customer'} we'll follow up.`, outbound: [] }
    }

    // Anything else: treat as a counter-offer — have Claude parse it and relay
    return {
      reply: `Got it — I'll relay that to ${pending.customer_name || 'the customer'} as a counter-offer. (Parse counter-offer feature still in progress; for now reply YES to approve original or NO to reject.)`,
      outbound: []
    }
  }

  // No pending — open-ended chat with Jon
  const ctx = await buildScheduleContext(supabase)
  const contextBlock = `TODAY: ${ctx.today}\n${ctx.slotsCtx}\n${ctx.jobsCtx}\nPENDING_CONFIRMATION: none`
  const reply = await callClaude(JON_PROMPT, contextBlock, [{ direction: 'inbound', body: message }])
  const { clean } = parseActions(reply)
  return { reply: clean, outbound: [] }
}

module.exports = {
  processCustomer,
  processJon,
  sendSMS,
  sendEmail,
  sendReply,
  executeSchedule,
  JON_PHONE,
  AUTO_CONFIRM
}
