// /api/riker-tools.js
// Native Claude tool_use definitions + handlers. Replaces the old text-block
// action system. Each tool has a schema (sent to Claude) and a handler
// (runs server-side). Context filtering gates which tools are exposed to
// which surface.
//
// Handler signature: async (input, ctx) => any
//   ctx = { supabase, context, identity, sessionId, rikerSessionId, rawReply }
// Return any JSON-serializable value; it goes back to Claude verbatim.
// On error, return { error: "..." } instead of throwing — Claude sees it
// and can surface a graceful message.

const crypto = require('crypto')
const memory = require('./riker-memory')
const william = require('./william-schedule')

const JON_PHONE = '+12149944799'
const BRYCER_CITIES = ['fort worth', 'benbrook', 'burleson', 'crowley', 'edgecliff village', 'everman', 'forest hill', 'haltom city', 'kennedale', 'lake worth', 'north richland hills', 'richland hills', 'river oaks', 'saginaw', 'sansom park', 'westover hills', 'westworth village', 'white settlement', 'watauga', 'blue mound', 'haslet', 'keller', 'southlake', 'colleyville', 'grapevine', 'euless', 'bedford', 'hurst']

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

async function sendSMSRaw(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_FROM_NUMBER
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

async function sendEmailRaw({ to, subject, body, inReplyTo, references }) {
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
      to: [to], subject, html, text: body,
      ...(Object.keys(headers).length ? { headers } : {})
    })
  })
  const data = await res.json()
  if (!res.ok) throw new Error('Resend send failed: ' + (data.message || res.status))
  return data.id
}

async function geocode(addr) {
  if (!addr || !process.env.GOOGLE_MAPS_API_KEY) return null
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addr)}&key=${process.env.GOOGLE_MAPS_API_KEY}`
    const r = await fetch(url)
    const d = await r.json()
    return d.results?.[0]?.geometry?.location || null
  } catch { return null }
}

function timeToMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m }
function minToTime(m) {
  const h = Math.floor(m / 60), min = m % 60
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h
  return h12 + ':' + String(min).padStart(2, '0') + ' ' + ampm
}

// ═══════════════════════════════════════════════════════════════
// TOOL: get_today_summary
// ═══════════════════════════════════════════════════════════════
const get_today_summary = {
  schema: {
    name: 'get_today_summary',
    description: "Quick operational snapshot for today: today's scheduled jobs count, total overdue jobs count, total outstanding unpaid invoices. Call this whenever Jon asks a general 'what's going on' question so you have a baseline. Cheap — one call, small payload.",
    input_schema: { type: 'object', properties: {} }
  },
  async handler(_input, ctx) {
    const today = new Date().toISOString().split('T')[0]
    const [todayJobs, overdueJobs, unpaidInvs] = await Promise.all([
      ctx.supabase.from('jobs')
        .select('id, scheduled_time, scope, estimated_value, location:locations(name,city)')
        .eq('scheduled_date', today).in('status', ['scheduled', 'en_route', 'active'])
        .order('scheduled_time'),
      ctx.supabase.from('jobs')
        .select('id', { count: 'exact', head: true })
        .lt('scheduled_date', today).eq('status', 'scheduled'),
      ctx.supabase.from('invoices')
        .select('total, invoice_number, location:locations(name)')
        .not('status', 'in', '(paid,void,record,factored)')
    ])
    const unpaidTotal = (unpaidInvs.data || []).reduce((s, i) => s + Number(i.total || 0), 0)
    return {
      today,
      today_jobs_count: todayJobs.data?.length || 0,
      today_jobs: (todayJobs.data || []).map(j => ({
        id: j.id,
        time: j.scheduled_time,
        customer: j.location?.name || null,
        city: j.location?.city || null,
        scope: j.scope || [],
        estimated_value: j.estimated_value
      })),
      overdue_count: overdueJobs.count || 0,
      unpaid_invoice_count: (unpaidInvs.data || []).length,
      unpaid_total_usd: Math.round(unpaidTotal * 100) / 100
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: query_jobs
// ═══════════════════════════════════════════════════════════════
const query_jobs = {
  schema: {
    name: 'query_jobs',
    description: "Search jobs by status, date range, location, or scope. Use this when Jon asks 'what's overdue', 'show me next week', 'jobs at Dragon Palace', etc.",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['scheduled', 'completed', 'cancelled', 'en_route', 'active', 'any'], description: 'Defaults to any.' },
        date_from: { type: 'string', description: 'YYYY-MM-DD inclusive. Omit for no lower bound.' },
        date_to: { type: 'string', description: 'YYYY-MM-DD inclusive. Omit for no upper bound.' },
        overdue_only: { type: 'boolean', description: 'If true, only return jobs scheduled before today with status=scheduled.' },
        location_id: { type: 'string' },
        scope: { type: 'array', items: { type: 'string' }, description: 'Filter to jobs whose scope array contains ANY of these.' },
        limit: { type: 'integer', description: 'Max rows (default 20, cap 100).' }
      }
    }
  },
  async handler(input, ctx) {
    const limit = Math.min(100, Number(input.limit) || 20)
    const today = new Date().toISOString().split('T')[0]
    let q = ctx.supabase.from('jobs')
      .select('id, job_number, scheduled_date, scheduled_time, scope, status, estimated_value, type, notes, location:locations(id,name,city,address,contact_phone)')
      .order('scheduled_date', { ascending: false })
      .limit(limit)
    if (input.overdue_only) {
      q = q.lt('scheduled_date', today).eq('status', 'scheduled')
    } else {
      if (input.status && input.status !== 'any') q = q.eq('status', input.status)
      if (input.date_from) q = q.gte('scheduled_date', input.date_from)
      if (input.date_to) q = q.lte('scheduled_date', input.date_to)
    }
    if (input.location_id) q = q.eq('location_id', input.location_id)
    if (input.scope?.length) q = q.overlaps('scope', input.scope)
    const { data, error } = await q
    if (error) return { error: error.message }
    return { count: data.length, jobs: data }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: lookup_client
// ═══════════════════════════════════════════════════════════════
const lookup_client = {
  schema: {
    name: 'lookup_client',
    description: "Search clients by business name, city, or phone. Fuzzy match. Use whenever Jon mentions a business you need to act on. Returns up to 10 matches with ids.",
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Name, city, or phone number fragment. Required.' },
        limit: { type: 'integer', description: 'Max matches (default 10, cap 25).' }
      },
      required: ['search']
    }
  },
  async handler(input, ctx) {
    const s = String(input.search || '').trim()
    if (!s) return { error: 'search required' }
    const limit = Math.min(25, Number(input.limit) || 10)
    const wildcard = '%' + s.replace(/[%_]/g, '') + '%'
    const phoneDigits = s.replace(/\D/g, '')
    let q = ctx.supabase.from('locations')
      .select('id, name, address, city, state, zip, contact_name, contact_email, contact_phone, billing_account_id, is_brycer_jurisdiction')
      .limit(limit)
    if (phoneDigits.length >= 7) {
      q = q.or(`name.ilike.${wildcard},city.ilike.${wildcard},contact_phone.ilike.%${phoneDigits}%`)
    } else {
      q = q.or(`name.ilike.${wildcard},city.ilike.${wildcard}`)
    }
    const { data, error } = await q
    if (error) return { error: error.message }
    return { count: data.length, matches: data }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: get_invoices
// ═══════════════════════════════════════════════════════════════
const get_invoices = {
  schema: {
    name: 'get_invoices',
    description: "Query invoices by status, date range, or billing account. Use for 'who owes me money', 'show me last month's revenue', 'aging invoices'.",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['paid', 'unpaid', 'void', 'overdue', 'all'], description: "Defaults to unpaid. 'unpaid' excludes paid/void/record/factored. 'overdue' means unpaid AND past due_date." },
        billing_account_id: { type: 'string' },
        location_id: { type: 'string' },
        date_from: { type: 'string', description: 'YYYY-MM-DD invoice date inclusive.' },
        date_to: { type: 'string', description: 'YYYY-MM-DD invoice date inclusive.' },
        limit: { type: 'integer', description: 'Max rows (default 20, cap 100).' }
      }
    }
  },
  async handler(input, ctx) {
    const limit = Math.min(100, Number(input.limit) || 20)
    const status = input.status || 'unpaid'
    const today = new Date().toISOString().split('T')[0]
    let q = ctx.supabase.from('invoices')
      .select('id, invoice_number, date, due_date, total, status, paid_at, payment_method, location:locations(id,name,city), billing_account_id')
      .order('date', { ascending: false })
      .limit(limit)
    if (status === 'paid') q = q.eq('status', 'paid')
    else if (status === 'void') q = q.eq('status', 'void')
    else if (status === 'overdue') q = q.not('status', 'in', '(paid,void,record,factored)').lt('due_date', today)
    else if (status === 'unpaid') q = q.not('status', 'in', '(paid,void,record,factored)')
    // 'all' → no status filter
    if (input.billing_account_id) q = q.eq('billing_account_id', input.billing_account_id)
    if (input.location_id) q = q.eq('location_id', input.location_id)
    if (input.date_from) q = q.gte('date', input.date_from)
    if (input.date_to) q = q.lte('date', input.date_to)
    const { data, error } = await q
    if (error) return { error: error.message }
    const total = (data || []).reduce((s, i) => s + Number(i.total || 0), 0)
    return { count: data.length, total_usd: Math.round(total * 100) / 100, invoices: data }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: get_schedule_slots
// ═══════════════════════════════════════════════════════════════
const get_schedule_slots = {
  schema: {
    name: 'get_schedule_slots',
    description: "Get available booking time slots for the next N days. Already accounts for Jon's custody schedule with his son William (school drop-off 8:40, pickup 4:10, mom's 1st/3rd/5th weekends). Always call this before proposing a time — never guess availability.",
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: "YYYY-MM-DD. Defaults to today." },
        num_days: { type: 'integer', description: 'How many calendar days forward to scan (default 7, cap 21). Only weekdays returned.' }
      }
    }
  },
  async handler(input, ctx) {
    const numDays = Math.min(21, Number(input.num_days) || 7)
    const start = input.date_from ? new Date(input.date_from + 'T00:00:00') : new Date()
    const days = []
    const cur = new Date(start)
    while (days.length < numDays) {
      const d = cur.toISOString().split('T')[0]
      const dow = cur.getDay()
      if (dow >= 1 && dow <= 5) days.push(d)
      cur.setDate(cur.getDate() + 1)
    }
    const { data: calEvents } = await ctx.supabase.from('calendar_events').select('*')
    const { data: jobs } = await ctx.supabase.from('jobs')
      .select('id, scheduled_date, scheduled_time, estimated_duration_hours, status, location:locations(name)')
      .in('scheduled_date', days)

    const out = []
    for (const d of days) {
      const avail = william.getJonAvailability(new Date(d + 'T12:00:00'))
      if (!avail.available) {
        out.push({ date: d, available: false, reason: avail.reason, slots: [] })
        continue
      }
      const busy = []
      const dayStart = new Date(d + 'T00:00:00')
      const dayEnd = new Date(d + 'T23:59:59')
      for (const ev of (calEvents || [])) {
        if (ev.event_type === 'job') continue
        const s = new Date(ev.start_time), e = new Date(ev.end_time)
        if (s > dayEnd || e < dayStart) continue
        busy.push({ start: s.getHours() * 60 + s.getMinutes(), end: e.getHours() * 60 + e.getMinutes(), label: ev.title || 'busy' })
      }
      const dayJobs = (jobs || []).filter(j => j.scheduled_date === d && j.status !== 'cancelled' && j.status !== 'completed')
      for (const j of dayJobs) {
        const t = j.scheduled_time || '09:00'
        const [h, m] = t.split(':').map(Number)
        const dur = (j.estimated_duration_hours || 1.5) * 60
        busy.push({ start: h * 60 + m, end: h * 60 + m + dur, label: j.location?.name || 'job' })
      }
      busy.sort((a, b) => a.start - b.start)
      const wStart = timeToMin(avail.workStart), wEnd = timeToMin(avail.workEnd)
      const slots = []
      let cursor = wStart
      for (const b of busy) {
        if (b.start > cursor) {
          const s = Math.max(cursor, wStart), e = Math.min(b.start, wEnd)
          if (e - s >= 30) slots.push({ start: minToTime(s), end: minToTime(e) })
        }
        cursor = Math.max(cursor, b.end)
      }
      if (cursor < wEnd) slots.push({ start: minToTime(cursor), end: minToTime(wEnd) })
      out.push({ date: d, available: true, work_window: `${avail.workStart}-${avail.workEnd}`, reason: avail.reason, slots, booked: dayJobs.map(j => ({ time: j.scheduled_time, customer: j.location?.name })) })
    }
    return { days: out }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: get_equipment
// ═══════════════════════════════════════════════════════════════
const get_equipment = {
  schema: {
    name: 'get_equipment',
    description: "Get all equipment at a location: extinguishers, suppression systems, emergency lights. Include next-service dates so you can flag what's due.",
    input_schema: {
      type: 'object',
      properties: { location_id: { type: 'string' } },
      required: ['location_id']
    }
  },
  async handler(input, ctx) {
    if (!input.location_id) return { error: 'location_id required' }
    const [ext, sup, emg] = await Promise.all([
      ctx.supabase.from('extinguishers').select('id, type, size, serial_number, location_in_building, next_inspection, next_hydro, status').eq('location_id', input.location_id),
      ctx.supabase.from('suppression_systems').select('id, system_type, category, tank_count, nozzle_count, fusible_link_count, location_in_building, next_inspection, next_hydro').eq('location_id', input.location_id),
      ctx.supabase.from('emergency_lights').select('id, fixture_count, next_annual_test').eq('location_id', input.location_id)
    ])
    return {
      extinguishers: ext.data || [],
      suppression_systems: sup.data || [],
      emergency_lights: emg.data || []
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: get_pending_confirmations
// ═══════════════════════════════════════════════════════════════
const get_pending_confirmations = {
  schema: {
    name: 'get_pending_confirmations',
    description: "Get Jon's unreviewed pending customer bookings. Use this immediately when Jon's message looks like a short affirmative (Y, yes, ok, confirm, do it) — if there's an open pending, he's approving it.",
    input_schema: { type: 'object', properties: {} }
  },
  async handler(_input, ctx) {
    const { data, error } = await ctx.supabase
      .from('pending_confirmations').select('*')
      .eq('status', 'pending').gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(5)
    if (error) return { error: error.message }
    return { count: data.length, pending: data }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: get_todos
// ═══════════════════════════════════════════════════════════════
const get_todos = {
  schema: {
    name: 'get_todos',
    description: "Jon's to-do list. Use when he asks 'what's on my list' or 'what do I need to do'.",
    input_schema: {
      type: 'object',
      properties: { include_completed: { type: 'boolean' } }
    }
  },
  async handler(input, ctx) {
    let q = ctx.supabase.from('todos').select('*').order('created_at', { ascending: false }).limit(50)
    if (!input.include_completed) q = q.eq('completed', false)
    const { data, error } = await q
    if (error) return { error: error.message }
    return { count: data.length, todos: data }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: read_memory
// ═══════════════════════════════════════════════════════════════
const read_memory = {
  schema: {
    name: 'read_memory',
    description: "Read Riker's notebook — standing orders, customer preferences, equipment notes, pending action items. Filter by scope or category.",
    input_schema: {
      type: 'object',
      properties: {
        location_id: { type: 'string' },
        billing_account_id: { type: 'string' },
        category: { type: 'string', description: 'preference|relationship|equipment_note|scheduling|billing|compliance|conversation|action_pending|route_note|internal' },
        standing_orders_only: { type: 'boolean', description: "Only return content starting with 'STANDING ORDER:'." }
      }
    }
  },
  async handler(input, ctx) {
    const entries = await memory.readRelevantMemories({
      supabase: ctx.supabase,
      context: ctx.context,
      locationId: input.location_id || ctx.identity?.location_id,
      billingAccountId: input.billing_account_id || ctx.identity?.billing_account_id,
      techId: ctx.identity?.tech_id
    })
    let filtered = entries
    if (input.category) filtered = filtered.filter(e => e.category === input.category)
    if (input.standing_orders_only) filtered = filtered.filter(e => /^STANDING ORDER:/i.test(e.content || ''))
    return {
      count: filtered.length,
      entries: filtered.map(e => ({
        id: e.id, scope: e.scope, category: e.category,
        content: e.content, priority: e.priority,
        location_id: e.location_id, expires_at: e.expires_at
      }))
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: get_rate_card
// ═══════════════════════════════════════════════════════════════
const get_rate_card = {
  schema: {
    name: 'get_rate_card',
    description: "Current service pricing. Use for customer quotes and when Jon asks 'what do we charge for X'.",
    input_schema: { type: 'object', properties: {} }
  },
  async handler(_input, ctx) {
    const { data, error } = await ctx.supabase.from('rate_card').select('key, description, price').order('key')
    if (error) return { error: error.message }
    return { rates: data }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: schedule_job
// ═══════════════════════════════════════════════════════════════
const schedule_job = {
  schema: {
    name: 'schedule_job',
    description: "Create a scheduled job. For customer-facing contexts (website / sms_customer / email_customer), this routes through Jon's approval gate automatically — a pending_confirmations row is created and Jon gets a text. For Jon's own contexts (app / sms_jon), the job is created directly.",
    input_schema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'Existing location id. Required unless you just added the client.' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        time: { type: 'string', description: 'HH:MM (24h)' },
        scope: { type: 'array', items: { type: 'string', enum: ['extinguishers', 'suppression', 'elights', 'hydro', 'install', 'repair'] } },
        duration_hours: { type: 'number', description: 'Default 1.5' },
        notes: { type: 'string' },
        business_name: { type: 'string', description: 'For the Jon-approval SMS when no location_id available yet.' },
        contact_name: { type: 'string' },
        proposed_reply: { type: 'string', description: 'The customer-facing message Riker will send IF approved (for customer contexts only). Include the specifics.' }
      },
      required: ['date', 'time', 'scope']
    }
  },
  async handler(input, ctx) {
    const AUTO_CONFIRM = process.env.RIKER_AUTO_CONFIRM === 'true'
    const CUSTOMER_CONTEXTS = new Set(['website', 'sms_customer', 'email_customer'])

    if (CUSTOMER_CONTEXTS.has(ctx.context)) {
      // Route through pending confirmation
      const locationId = input.location_id || ctx.lastLocationId || null
      const sourceChannel = ctx.context === 'email_customer' ? 'email' : (ctx.context === 'sms_customer' ? 'sms' : null)
      const { data: pending, error: pErr } = await ctx.supabase.from('pending_confirmations').insert({
        source_conversation_id: ctx.sessionId,
        source_channel: sourceChannel,
        customer_phone: ctx.identity?.phone || null,
        customer_email: ctx.identity?.email || null,
        customer_name: input.contact_name || ctx.identity?.customer_name || null,
        location_id: locationId,
        proposed_action: { type: 'schedule_job', ...input },
        proposed_reply: input.proposed_reply || ctx.rawReply || "We're set — I'll confirm the time shortly.",
        reasoning: AUTO_CONFIRM ? 'Auto-confirm mode off for first pass' : 'Manual confirm'
      }).select().single()
      if (pErr) return { error: 'pending insert failed: ' + pErr.message }
      // Text Jon
      try {
        const lines = [
          `CONFIRM? ${input.business_name || input.contact_name || 'Customer'} (via ${ctx.context})`,
          `${input.date} ${input.time} (${input.duration_hours || 1.5}hr)`,
          (input.scope || []).join(', '),
          '',
          'Reply YES to approve, NO to reject, or suggest alt like "Tue 2pm"'
        ].filter(Boolean).join('\n')
        await sendSMSRaw(JON_PHONE, lines)
      } catch (e) { console.warn('[schedule_job] sms_jon failed:', e.message) }
      return { ok: true, waiting_for_jon_approval: true, pending_id: pending?.id, message_to_customer: 'Let them know you\'ll confirm shortly — Jon still has to approve.' }
    }

    // Jon's own context — execute directly
    const locationId = input.location_id || ctx.lastLocationId
    if (!locationId) return { error: 'location_id required (use lookup_client or add_client first)' }
    const { data: job, error } = await ctx.supabase.from('jobs').insert({
      location_id: locationId,
      scheduled_date: input.date,
      scheduled_time: input.time,
      scope: input.scope,
      status: 'scheduled',
      estimated_duration_hours: input.duration_hours || 1.5,
      notes: input.notes || null
    }).select().single()
    if (error) return { error: error.message }

    const startDt = new Date(input.date + 'T' + input.time + ':00')
    const endDt = new Date(startDt.getTime() + (input.duration_hours || 1.5) * 3600000)
    await ctx.supabase.from('calendar_events').insert({
      title: input.notes || 'Job',
      event_type: 'job',
      start_time: startDt.toISOString(),
      end_time: endDt.toISOString(),
      location_id: locationId, job_id: job.id
    })
    const { data: locInfo } = await ctx.supabase.from('locations').select('name,is_brycer_jurisdiction').eq('id', locationId).single()
    if (locInfo?.is_brycer_jurisdiction) {
      await ctx.supabase.from('brycer_queue').insert({ location_id: locationId, location_name: locInfo.name, submitted: false })
    }
    return { ok: true, job_id: job.id, scheduled_date: input.date, scheduled_time: input.time }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: approve_pending
// ═══════════════════════════════════════════════════════════════
const approve_pending = {
  schema: {
    name: 'approve_pending',
    description: "Approve a pending customer booking. Executes the proposed action and notifies the customer on their original channel. If Jon's message looks like 'Y' / 'yes' / 'ok' / 'confirm' / 'do it' and there's an open pending (check get_pending_confirmations), this is what you call.",
    input_schema: {
      type: 'object',
      properties: {
        confirmation_id: { type: 'string', description: 'The pending_confirmations row id. If omitted, uses the most recent pending.' }
      }
    }
  },
  async handler(input, ctx) {
    let pending
    if (input.confirmation_id) {
      const { data } = await ctx.supabase.from('pending_confirmations').select('*').eq('id', input.confirmation_id).maybeSingle()
      pending = data
    } else {
      const { data } = await ctx.supabase.from('pending_confirmations').select('*')
        .eq('status', 'pending').gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false }).limit(1)
      pending = data?.[0]
    }
    if (!pending) return { error: 'no pending confirmation found' }

    // Execute the proposed action inline (typically schedule_job with Jon context)
    const sub = pending.proposed_action || {}
    if (sub.type === 'schedule_job') {
      const subCtx = { ...ctx, context: 'app', lastLocationId: pending.location_id || ctx.lastLocationId }
      const result = await schedule_job.handler(sub, subCtx)
      if (result?.error) {
        await ctx.supabase.from('pending_confirmations').update({ status: 'failed', responded_at: new Date().toISOString() }).eq('id', pending.id)
        return { error: 'execute failed: ' + result.error }
      }
    }

    await ctx.supabase.from('pending_confirmations').update({
      status: 'executed', responded_at: new Date().toISOString()
    }).eq('id', pending.id)

    // Notify the customer on their original channel
    try {
      if (pending.source_channel === 'sms' && pending.customer_phone) {
        await sendSMSRaw(pending.customer_phone, pending.proposed_reply)
        if (pending.source_conversation_id) {
          await ctx.supabase.from('messages').insert({
            conversation_id: pending.source_conversation_id,
            direction: 'outbound', channel: 'sms', body: pending.proposed_reply
          })
        }
      } else if (pending.source_channel === 'email' && pending.customer_email) {
        let inReplyTo = null, references = null, subject = 'Re: scheduling'
        if (pending.source_conversation_id) {
          const { data: last } = await ctx.supabase.from('messages')
            .select('email_message_id, email_subject')
            .eq('conversation_id', pending.source_conversation_id)
            .eq('direction', 'inbound').order('created_at', { ascending: false }).limit(1).maybeSingle()
          if (last) {
            inReplyTo = last.email_message_id; references = last.email_message_id
            subject = last.email_subject ? (last.email_subject.startsWith('Re:') ? last.email_subject : 'Re: ' + last.email_subject) : subject
          }
        }
        await sendEmailRaw({ to: pending.customer_email, subject, body: pending.proposed_reply, inReplyTo, references })
        if (pending.source_conversation_id) {
          await ctx.supabase.from('messages').insert({
            conversation_id: pending.source_conversation_id,
            direction: 'outbound', channel: 'email', body: pending.proposed_reply, email_subject: subject
          })
        }
      }
    } catch (e) { console.error('[approve_pending] notify:', e.message) }

    return { ok: true, pending_id: pending.id, customer: pending.customer_name || pending.customer_phone || pending.customer_email }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: reject_pending
// ═══════════════════════════════════════════════════════════════
const reject_pending = {
  schema: {
    name: 'reject_pending',
    description: "Reject a pending customer booking. Notifies the customer that Jon needs to adjust the time.",
    input_schema: {
      type: 'object',
      properties: {
        confirmation_id: { type: 'string', description: 'Omit to use the most recent pending.' },
        reason: { type: 'string', description: 'Optional short reason for the notification message.' }
      }
    }
  },
  async handler(input, ctx) {
    let pending
    if (input.confirmation_id) {
      const { data } = await ctx.supabase.from('pending_confirmations').select('*').eq('id', input.confirmation_id).maybeSingle()
      pending = data
    } else {
      const { data } = await ctx.supabase.from('pending_confirmations').select('*')
        .eq('status', 'pending').gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false }).limit(1)
      pending = data?.[0]
    }
    if (!pending) return { error: 'no pending confirmation found' }
    await ctx.supabase.from('pending_confirmations').update({
      status: 'rejected', responded_at: new Date().toISOString()
    }).eq('id', pending.id)
    const msg = input.reason
      ? `Hey — Jon needs to adjust that time. ${input.reason} I'll reach back out with another option.`
      : "Hey — Jon needs to adjust that time. I'll reach back out with another option."
    try {
      if (pending.source_channel === 'sms' && pending.customer_phone) await sendSMSRaw(pending.customer_phone, msg)
      else if (pending.source_channel === 'email' && pending.customer_email) await sendEmailRaw({ to: pending.customer_email, subject: 'Re: scheduling', body: msg })
    } catch (e) { console.error('[reject_pending] notify:', e.message) }
    return { ok: true, pending_id: pending.id }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: send_sms
// ═══════════════════════════════════════════════════════════════
const send_sms = {
  schema: {
    name: 'send_sms',
    description: "Send a text message. Use when Jon says 'text [customer] saying X' or when you need to notify a customer.",
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Phone number — will be normalized to E.164.' },
        body: { type: 'string', description: 'Text body, under 1000 chars.' }
      },
      required: ['to', 'body']
    }
  },
  async handler(input) {
    try {
      let to = String(input.to).replace(/[\s\-\(\)\.]/g, '')
      if (!to.startsWith('+')) to = '+1' + to.replace(/^1/, '')
      const sid = await sendSMSRaw(to, input.body)
      return { ok: true, sid }
    } catch (e) { return { error: e.message } }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: add_client
// ═══════════════════════════════════════════════════════════════
const add_client = {
  schema: {
    name: 'add_client',
    description: "Create a new client location (and billing account). Use when Jon says 'add [business]' or a customer wants service at a new location.",
    input_schema: {
      type: 'object',
      properties: {
        business_name: { type: 'string' },
        address: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string', description: 'Default TX' },
        zip: { type: 'string' },
        contact_name: { type: 'string' },
        contact_phone: { type: 'string' },
        contact_email: { type: 'string' }
      },
      required: ['business_name', 'city']
    }
  },
  async handler(input, ctx) {
    const city = (input.city || '').toLowerCase()
    const isBrycer = BRYCER_CITIES.includes(city)
    const { data: loc, error } = await ctx.supabase.from('locations').insert({
      name: input.business_name,
      contact_name: input.contact_name || null,
      contact_phone: input.contact_phone || null,
      contact_email: input.contact_email || null,
      address: input.address || null,
      city: input.city,
      state: input.state || 'TX',
      zip: input.zip || null,
      is_brycer_jurisdiction: isBrycer,
      brycer_ahj_name: isBrycer ? (input.city || '') + ' Fire Department' : null
    }).select().single()
    if (error) return { error: error.message }
    if (input.address) {
      const geo = await geocode([input.address, input.city, input.state || 'TX', input.zip].filter(Boolean).join(', '))
      if (geo) await ctx.supabase.from('locations').update({ lat: geo.lat, lng: geo.lng }).eq('id', loc.id)
    }
    ctx.lastLocationId = loc.id
    return { ok: true, location_id: loc.id, business_name: input.business_name, brycer: isBrycer }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: add_todo
// ═══════════════════════════════════════════════════════════════
const add_todo = {
  schema: {
    name: 'add_todo',
    description: "Add an item to Jon's to-do list. Use whenever Jon says 'add a to-do' or 'remind me to' or describes a task he needs to remember.",
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        priority: { type: 'integer', description: '1-10, default 5' }
      },
      required: ['text']
    }
  },
  async handler(input, ctx) {
    const { data, error } = await ctx.supabase.from('todos').insert({
      text: input.text,
      created_by: ctx.identity?.tech_id || null,
      completed: false
    }).select().single()
    if (error) return { error: error.message }
    return { ok: true, todo_id: data?.id, text: input.text }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: write_memory
// ═══════════════════════════════════════════════════════════════
const write_memory = {
  schema: {
    name: 'write_memory',
    description: "Save a durable fact to the notebook. Use aggressively when you learn a preference, relationship, gate code, or Jon issues a standing order (phrased 'from now on', 'never', 'always', 'that's an order'). Standing orders MUST be priority 10 with content prefixed 'STANDING ORDER:'.",
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['global', 'location', 'customer', 'job', 'tech'], description: "'global' for company-wide rules, 'location' for a specific client." },
        category: { type: 'string', enum: ['preference', 'relationship', 'equipment_note', 'scheduling', 'billing', 'compliance', 'conversation', 'action_pending', 'route_note', 'internal'] },
        content: { type: 'string', description: "Plain-English fact. Prefix with 'STANDING ORDER:' when Jon issues a directive." },
        priority: { type: 'integer', description: "1-10. Use 10 for standing orders, 5 for default, 1-3 for trivia." },
        location_id: { type: 'string', description: 'Required if scope=location.' },
        billing_account_id: { type: 'string', description: 'Required if scope=customer.' },
        expires_at: { type: 'string', description: "ISO datetime, optional. Use for time-sensitive action_pending items." }
      },
      required: ['scope', 'category', 'content']
    }
  },
  async handler(input, ctx) {
    const result = await memory.writeMemory(ctx.supabase, input, {
      sessionId: ctx.rikerSessionId || ctx.sessionId,
      source: 'tool:' + ctx.context
    })
    if (!result) return { error: 'memory write failed' }
    return { ok: true, memory_id: result.id, updated: result.updated }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: delete_memory
// ═══════════════════════════════════════════════════════════════
const delete_memory = {
  schema: {
    name: 'delete_memory',
    description: "Archive a memory entry (standing order revocation, obsolete note). Jon must explicitly revoke a standing order — phrases like 'cancel that rule' or 'forget that order'.",
    input_schema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string' },
        reason: { type: 'string' }
      },
      required: ['memory_id']
    }
  },
  async handler(input, ctx) {
    await memory.deleteMemory(ctx.supabase, input.memory_id, input.reason)
    return { ok: true, memory_id: input.memory_id }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: mark_invoice_paid
// ═══════════════════════════════════════════════════════════════
const mark_invoice_paid = {
  schema: {
    name: 'mark_invoice_paid',
    description: "Mark an invoice as paid. Use when Jon says 'INV-649577 paid by check' or similar.",
    input_schema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string', description: 'Invoice UUID. Use lookup by invoice_number via query_invoices first if Jon gave a number.' },
        invoice_number: { type: 'string', description: "Alternative to invoice_id — I'll look it up." },
        payment_method: { type: 'string', enum: ['check', 'cash', 'card', 'transfer', 'manual'] },
        note: { type: 'string' }
      }
    }
  },
  async handler(input, ctx) {
    let invoiceId = input.invoice_id
    if (!invoiceId && input.invoice_number) {
      const { data } = await ctx.supabase.from('invoices').select('id').eq('invoice_number', input.invoice_number).maybeSingle()
      invoiceId = data?.id
    }
    if (!invoiceId) return { error: 'invoice_id or invoice_number required and must match a row' }
    const { error } = await ctx.supabase.from('invoices').update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      payment_method: input.payment_method || 'manual',
      notes: input.note || null
    }).eq('id', invoiceId)
    if (error) return { error: error.message }
    return { ok: true, invoice_id: invoiceId }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: lookup_business — Google Places Text Search for customer addresses
// ═══════════════════════════════════════════════════════════════
// Used when a user mentions a business by name and city but hasn't given a
// full address. Returns up to 5 candidate matches with formatted_address,
// lat/lng, phone, and website (top result auto-enriched with Place Details).
// Cost per call: ~$0.05. Call before add_client whenever the user
// referenced the business by name.
const lookup_business = {
  schema: {
    name: 'lookup_business',
    description: "Search the web (Google Places) for a real business by name and city, returning verified addresses, phone numbers, and websites. ALWAYS call this before add_client when the user gave you a business name + city but not a full street address. The top result is auto-enriched with phone and website. Do not invent addresses.",
    input_schema: {
      type: 'object',
      properties: {
        business_name: { type: 'string', description: 'Name of the business to look up. Required.' },
        city: { type: 'string', description: 'City name — helps disambiguate chain matches. Strongly recommended.' },
        state: { type: 'string', description: 'State — default TX.' },
        limit: { type: 'integer', description: 'Max candidates to return (default 5, cap 10).' }
      },
      required: ['business_name']
    }
  },
  async handler(input) {
    const key = process.env.GOOGLE_MAPS_API_KEY
    if (!key) return { error: 'GOOGLE_MAPS_API_KEY not configured' }
    const name = String(input.business_name || '').trim()
    if (!name) return { error: 'business_name required' }
    const city = String(input.city || '').trim()
    const state = String(input.state || 'TX').trim()
    const limit = Math.max(1, Math.min(10, Number(input.limit) || 5))

    const query = [name, city, state].filter(Boolean).join(' ')

    // Text Search — returns candidates with formatted_address
    const searchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${key}`
    try {
      const sres = await fetch(searchUrl)
      const sdata = await sres.json()
      if (!sres.ok || sdata.status === 'REQUEST_DENIED' || sdata.status === 'INVALID_REQUEST') {
        return { error: 'Places search failed: ' + (sdata.error_message || sdata.status || sres.status) }
      }
      if (sdata.status === 'ZERO_RESULTS') return { query, count: 0, candidates: [] }
      if (sdata.status !== 'OK') return { error: 'Places status: ' + sdata.status, query }

      const raw = (sdata.results || []).slice(0, limit)
      const candidates = raw.map(r => ({
        name: r.name,
        formatted_address: r.formatted_address,
        place_id: r.place_id,
        lat: r.geometry?.location?.lat,
        lng: r.geometry?.location?.lng,
        types: r.types || [],
        rating: r.rating,
        user_ratings_total: r.user_ratings_total,
        business_status: r.business_status
      }))

      // Enrich top candidate with Place Details (phone, website, hours)
      if (candidates.length) {
        const fields = 'name,formatted_address,formatted_phone_number,international_phone_number,website,opening_hours'
        const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(candidates[0].place_id)}&fields=${fields}&key=${key}`
        try {
          const dres = await fetch(detailUrl)
          const ddata = await dres.json()
          if (dres.ok && ddata.status === 'OK' && ddata.result) {
            candidates[0].phone = ddata.result.formatted_phone_number || ddata.result.international_phone_number || null
            candidates[0].website = ddata.result.website || null
            if (ddata.result.opening_hours?.weekday_text) {
              candidates[0].hours = ddata.result.opening_hours.weekday_text
            }
          }
        } catch (e) { /* details enrichment is best-effort */ }
      }

      return { query, count: candidates.length, candidates }
    } catch (e) {
      return { error: 'Places API error: ' + e.message }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// REGISTRY + CONTEXT FILTERING
// ═══════════════════════════════════════════════════════════════

const ALL_TOOLS = {
  get_today_summary, query_jobs, lookup_client, get_invoices,
  get_schedule_slots, get_equipment, get_pending_confirmations,
  get_todos, read_memory, get_rate_card,
  schedule_job, approve_pending, reject_pending, send_sms,
  add_client, add_todo, write_memory, delete_memory, mark_invoice_paid,
  lookup_business
}

// null = all tools. Keeps Jon contexts unrestricted; trims customer contexts.
const CONTEXT_TOOLS = {
  website: ['lookup_client', 'lookup_business', 'get_schedule_slots', 'get_rate_card', 'schedule_job', 'add_client'],
  portal: ['lookup_client', 'get_invoices', 'get_equipment', 'get_schedule_slots', 'schedule_job', 'write_memory'],
  app: null,
  sms_jon: null,
  sms_customer: ['lookup_client', 'lookup_business', 'get_schedule_slots', 'get_rate_card', 'schedule_job', 'add_client'],
  email_customer: ['lookup_client', 'lookup_business', 'get_schedule_slots', 'schedule_job', 'add_client', 'send_sms']
}

function getToolsForContext(context) {
  const allowed = CONTEXT_TOOLS[context]
  const names = allowed === null || allowed === undefined ? Object.keys(ALL_TOOLS) : allowed
  return names.filter(n => ALL_TOOLS[n]).map(n => ALL_TOOLS[n].schema)
}

async function executeToolCall(name, input, ctx) {
  const tool = ALL_TOOLS[name]
  if (!tool) return { error: `Unknown tool: ${name}` }
  // Permission check
  const allowed = CONTEXT_TOOLS[ctx.context]
  if (allowed && !allowed.includes(name)) return { error: `Tool '${name}' not available in context '${ctx.context}'` }
  try {
    return await tool.handler(input, ctx)
  } catch (e) {
    console.error('[riker-tools]', name, 'error:', e)
    return { error: e.message || String(e) }
  }
}

module.exports = {
  ALL_TOOLS,
  CONTEXT_TOOLS,
  getToolsForContext,
  executeToolCall,
  sendSMSRaw,
  sendEmailRaw,
  JON_PHONE
}
