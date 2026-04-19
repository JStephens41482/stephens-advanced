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
    description: "Search clients by business name, city, or phone. Fuzzy match. Returns up to 10 matches with location details AND last_job (date, scope, status of the most recent job). Always call this first when a customer gives you a business name — before asking for address/city info they may already have on file.",
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
    const phoneDigits = s.replace(/\D/g, '')
    let q = ctx.supabase.from('locations')
      .select('id, name, address, city, state, zip, contact_name, contact_email, contact_phone, billing_account_id, is_brycer_jurisdiction')
      .limit(limit)

    if (phoneDigits.length >= 7) {
      // phone search — dashes/parens stripped, match digits anywhere
      q = q.ilike('contact_phone', '%' + phoneDigits + '%')
    } else {
      // Tokenize so "Amigos Grocery Store Irving" matches name="Amigos
      // Grocery Store" city="Irving". Each token must appear in name OR
      // city. Strip stopwords that show up in noisy business names.
      const stopwords = new Set(['the', 'a', 'an', 'of', 'in', 'at', 'on', 'to', 'for', 'and', 'or', 'store', 'shop', 'restaurant', 'llc', 'inc', 'co', 'company'])
      const tokens = s.toLowerCase()
        .split(/\s+/)
        .map(t => t.replace(/[^a-z0-9]/gi, ''))
        .filter(t => t.length >= 2 && !stopwords.has(t))
        .slice(0, 5)
      if (tokens.length === 0) {
        const wc = '%' + s.replace(/[%_]/g, '') + '%'
        q = q.or(`name.ilike.${wc},city.ilike.${wc}`)
      } else {
        for (const tok of tokens) {
          const wc = '%' + tok + '%'
          q = q.or(`name.ilike.${wc},city.ilike.${wc}`)
        }
      }
    }

    const { data, error } = await q
    if (error) return { error: error.message }
    if (!data || !data.length) return { count: 0, matches: [] }

    // Enrich each match with last completed/scheduled job so callers know
    // when the location was last serviced without needing a separate query.
    const ids = data.map(r => r.id)
    const { data: jobs } = await ctx.supabase.from('jobs')
      .select('location_id, scheduled_date, scheduled_time, scope, status')
      .in('location_id', ids)
      .in('status', ['completed', 'scheduled'])
      .order('scheduled_date', { ascending: false })
    const lastJobByLoc = {}
    for (const j of (jobs || [])) {
      if (!lastJobByLoc[j.location_id]) lastJobByLoc[j.location_id] = j
    }

    return {
      count: data.length,
      matches: data.map(r => ({
        ...r,
        last_job: lastJobByLoc[r.id]
          ? { date: lastJobByLoc[r.id].scheduled_date, scope: lastJobByLoc[r.id].scope, status: lastJobByLoc[r.id].status }
          : null
      }))
    }
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
    // SMS/email customer channels route through Jon's approval gate.
    // Website gets direct job creation (availability already verified via get_schedule_slots).
    const CUSTOMER_CONTEXTS = new Set(['sms_customer', 'email_customer'])

    if (CUSTOMER_CONTEXTS.has(ctx.context)) {
      // Route through pending confirmation (SMS/email customer channels)
      const locationId = input.location_id || ctx.lastLocationId || null
      const sourceChannel = ctx.context === 'email_customer' ? 'email' : 'sms'
      const { data: pending, error: pErr } = await ctx.supabase.from('pending_confirmations').insert({
        source_conversation_id: ctx.sessionId,
        source_channel: sourceChannel,
        customer_phone: ctx.identity?.phone || null,
        customer_email: ctx.identity?.email || null,
        customer_name: input.contact_name || ctx.identity?.customer_name || null,
        location_id: locationId,
        proposed_action: { type: 'schedule_job', ...input },
        proposed_reply: input.proposed_reply || ctx.rawReply || "Got your request in — Jon will confirm the time shortly.",
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
      return { ok: true, waiting_for_jon_approval: true, pending_id: pending?.id, message_to_customer: "Got your request in — Jon will confirm the time shortly." }
    }

    // Website context — create job directly (availability pre-verified via get_schedule_slots)
    // + notify Jon so he knows about the booking.
    if (ctx.context === 'website') {
      const locationId = input.location_id || ctx.lastLocationId
      if (!locationId) return { error: 'location_id required (call add_client first)' }
      const { data: job, error } = await ctx.supabase.from('jobs').insert({
        location_id: locationId,
        scheduled_date: input.date,
        scheduled_time: input.time,
        scope: input.scope,
        status: 'scheduled',
        estimated_duration_hours: input.duration_hours || 1.5,
        notes: input.notes || 'Booked via website chat'
      }).select().single()
      if (error) return { error: error.message }
      // Calendar event
      const startDt = new Date(input.date + 'T' + input.time + ':00')
      const endDt = new Date(startDt.getTime() + (input.duration_hours || 1.5) * 3600000)
      await ctx.supabase.from('calendar_events').insert({
        title: input.notes || 'Website booking',
        event_type: 'job',
        start_time: startDt.toISOString(),
        end_time: endDt.toISOString(),
        location_id: locationId,
        job_id: job.id,
        color: '#3b82f6'
      })
      const { data: locInfo } = await ctx.supabase.from('locations')
        .select('name, is_brycer_jurisdiction, city').eq('id', locationId).single()
      if (locInfo?.is_brycer_jurisdiction) {
        await ctx.supabase.from('brycer_queue').insert({
          location_id: locationId, location_name: locInfo.name, submitted: false
        })
      }
      // Notify Jon
      try {
        const nameStr = input.business_name || locInfo?.name || 'Customer'
        const cityStr = locInfo?.city ? ` · ${locInfo.city}` : ''
        const brycer = locInfo?.is_brycer_jurisdiction ? ' (Brycer)' : ''
        const line1 = `New website booking: ${nameStr}${cityStr}${brycer}`
        const line2 = `${input.date} at ${input.time} · ${(input.scope || []).join(', ')}`
        await sendSMSRaw(JON_PHONE, line1 + '\n' + line2)
      } catch (e) { console.warn('[schedule_job:website] jon notification failed:', e.message) }
      return { ok: true, job_id: job.id, scheduled_date: input.date, scheduled_time: input.time }
    }

    // Jon's own context (app, sms_jon, portal) — execute directly
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
    } else if (sub.type === 'auto_schedule_batch') {
      // Daily auto-reschedule cron proposal. Each entry in sub.jobs becomes
      // a real scheduled row. If any fail we record the detail and keep going.
      const created = []
      const failed = []
      for (const j of (sub.jobs || [])) {
        const { data: newJob, error } = await ctx.supabase.from('jobs').insert({
          location_id: j.location_id,
          billing_account_id: j.billing_account_id,
          contract_id: j.contract_id,
          type: 'inspection',
          scope: j.scope,
          status: 'scheduled',
          scheduled_date: j.scheduled_date,
          technician: 'Jon Stephens',
          assigned_to: j.assigned_to,
          estimated_value: j.estimated_value,
          notes: j.notes
        }).select('id').single()
        if (error) failed.push({ location_name: j.location_name, error: error.message })
        else created.push({ job_id: newJob.id, location_name: j.location_name, scheduled_date: j.scheduled_date })
      }
      await ctx.supabase.from('pending_confirmations').update({
        status: 'executed', responded_at: new Date().toISOString()
      }).eq('id', pending.id)
      return { ok: true, pending_id: pending.id, created: created.length, failed: failed.length, details: { created, failed } }
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
// TOOL: update_client
// ═══════════════════════════════════════════════════════════════
const update_client = {
  schema: {
    name: 'update_client',
    description: "Edit an existing client location. Pass location_id and any subset of fields to change — fields omitted stay unchanged. Use when Jon says 'update ABC Corp's phone', 'change Dave's address', 'fix the zip on Look Cinemas'. Call lookup_client first if Jon gave a name.",
    input_schema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'Location UUID. Required.' },
        business_name: { type: 'string' },
        address: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string' },
        zip: { type: 'string' },
        contact_name: { type: 'string' },
        contact_phone: { type: 'string' },
        contact_email: { type: 'string' },
        notes: { type: 'string' }
      },
      required: ['location_id']
    }
  },
  async handler(input, ctx) {
    const patch = {}
    if (input.business_name !== undefined) patch.name = input.business_name
    if (input.address !== undefined) patch.address = input.address
    if (input.city !== undefined) patch.city = input.city
    if (input.state !== undefined) patch.state = input.state
    if (input.zip !== undefined) patch.zip = input.zip
    if (input.contact_name !== undefined) patch.contact_name = input.contact_name
    if (input.contact_phone !== undefined) patch.contact_phone = input.contact_phone
    if (input.contact_email !== undefined) patch.contact_email = input.contact_email
    if (input.notes !== undefined) patch.notes = input.notes
    if (Object.keys(patch).length === 0) return { error: 'Nothing to update — pass at least one field.' }
    if (patch.city) {
      const cityLc = patch.city.toLowerCase()
      patch.is_brycer_jurisdiction = BRYCER_CITIES.includes(cityLc)
      patch.brycer_ahj_name = patch.is_brycer_jurisdiction ? patch.city + ' Fire Department' : null
    }
    const reGeocode = patch.address || patch.city || patch.zip
    const { data: loc, error } = await ctx.supabase.from('locations').update(patch).eq('id', input.location_id).select().single()
    if (error) return { error: error.message }
    if (reGeocode && loc) {
      const geo = await geocode([loc.address, loc.city, loc.state || 'TX', loc.zip].filter(Boolean).join(', '))
      if (geo) await ctx.supabase.from('locations').update({ lat: geo.lat, lng: geo.lng }).eq('id', loc.id)
    }
    return { ok: true, location_id: loc?.id, name: loc?.name, updated: Object.keys(patch) }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: delete_client
// ═══════════════════════════════════════════════════════════════
const delete_client = {
  schema: {
    name: 'delete_client',
    description: "Permanently delete a client location. SAFETY: must pass confirm_name that matches the stored client name (echo back what Jon typed). By default fails if related jobs/invoices exist; pass confirm_cascade=true to also delete those. For accidental duplicates prefer merge_clients.",
    input_schema: {
      type: 'object',
      properties: {
        location_id: { type: 'string' },
        confirm_name: { type: 'string', description: "Must match the stored name (case-insensitive, partial OK). Echo back what Jon called the client. Safety gate against accidental deletes." },
        confirm_cascade: { type: 'boolean', description: 'If true, deletes all jobs/invoices/reports tied to this location first. Default false.' }
      },
      required: ['location_id', 'confirm_name']
    }
  },
  async handler(input, ctx) {
    const { data: loc } = await ctx.supabase.from('locations').select('id, name').eq('id', input.location_id).maybeSingle()
    if (!loc) return { error: 'Location not found' }
    const a = (input.confirm_name || '').toLowerCase().trim()
    const b = (loc.name || '').toLowerCase().trim()
    const match = a && b && (a.includes(b.slice(0, Math.min(4, b.length))) || b.includes(a.slice(0, Math.min(4, a.length))))
    if (!match) return { error: `Safety check failed: confirm_name "${input.confirm_name}" doesn't overlap the stored name "${loc.name}". Echo back what Jon named.` }
    if (input.confirm_cascade) {
      await ctx.supabase.from('invoices').delete().eq('location_id', loc.id)
      await ctx.supabase.from('jobs').delete().eq('location_id', loc.id)
      await ctx.supabase.from('reports').delete().eq('location_id', loc.id)
    }
    const { error } = await ctx.supabase.from('locations').delete().eq('id', loc.id)
    if (error) {
      const hint = /foreign key|constraint/i.test(error.message) ? ' — related records block the delete. Try confirm_cascade=true or merge_clients.' : ''
      return { error: 'Delete failed: ' + error.message + hint }
    }
    return { ok: true, location_id: loc.id, name: loc.name, cascaded: !!input.confirm_cascade }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: merge_clients
// ═══════════════════════════════════════════════════════════════
const merge_clients = {
  schema: {
    name: 'merge_clients',
    description: "Merge a duplicate client into another. Moves all jobs and invoices from source to target, then deletes source. Use for dedup — 'merge Dave's Hot Chicken into Daves Hot Chicken'.",
    input_schema: {
      type: 'object',
      properties: {
        source_id: { type: 'string', description: 'The duplicate to absorb (will be deleted).' },
        target_id: { type: 'string', description: 'The client to keep.' }
      },
      required: ['source_id', 'target_id']
    }
  },
  async handler(input, ctx) {
    if (input.source_id === input.target_id) return { error: 'source_id and target_id are the same' }
    const { data: src } = await ctx.supabase.from('locations').select('id, name').eq('id', input.source_id).maybeSingle()
    const { data: tgt } = await ctx.supabase.from('locations').select('id, name').eq('id', input.target_id).maybeSingle()
    if (!src) return { error: 'source location not found' }
    if (!tgt) return { error: 'target location not found' }
    const moved = {}
    for (const t of ['jobs', 'invoices']) {
      const { data, error } = await ctx.supabase.from(t).update({ location_id: tgt.id }).eq('location_id', src.id).select('id')
      if (error) return { error: `${t} move failed: ${error.message}`, moved }
      moved[t] = data?.length || 0
    }
    const { error: delErr } = await ctx.supabase.from('locations').delete().eq('id', src.id)
    if (delErr) return { error: 'source delete failed after moves: ' + delErr.message + ' — other tables may still reference source.', moved }
    return { ok: true, source: src.name, target: tgt.name, moved }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: update_invoice
// ═══════════════════════════════════════════════════════════════
const update_invoice = {
  schema: {
    name: 'update_invoice',
    description: "Edit fields on an existing invoice. Use to fix amounts, change due dates, update status, correct invoice numbers, add notes. For only marking paid, use mark_invoice_paid instead.",
    input_schema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string' },
        invoice_number: { type: 'string', description: 'Lookup alternative to invoice_id.' },
        total: { type: 'number' },
        status: { type: 'string', enum: ['draft', 'sent', 'paid', 'void', 'overdue', 'record', 'factored'] },
        due_date: { type: 'string', description: 'YYYY-MM-DD' },
        date: { type: 'string', description: 'YYYY-MM-DD invoice date' },
        notes: { type: 'string' },
        new_invoice_number: { type: 'string', description: 'Rename the invoice number itself.' }
      }
    }
  },
  async handler(input, ctx) {
    let invoiceId = input.invoice_id
    if (!invoiceId && input.invoice_number) {
      const { data } = await ctx.supabase.from('invoices').select('id').eq('invoice_number', input.invoice_number).maybeSingle()
      invoiceId = data?.id
    }
    if (!invoiceId) return { error: 'invoice_id or invoice_number required' }
    const patch = {}
    if (input.total !== undefined) patch.total = input.total
    if (input.status !== undefined) patch.status = input.status
    if (input.due_date !== undefined) patch.due_date = input.due_date
    if (input.date !== undefined) patch.date = input.date
    if (input.notes !== undefined) patch.notes = input.notes
    if (input.new_invoice_number !== undefined) patch.invoice_number = input.new_invoice_number
    if (Object.keys(patch).length === 0) return { error: 'Nothing to update — pass at least one field.' }
    const { error } = await ctx.supabase.from('invoices').update(patch).eq('id', invoiceId)
    if (error) return { error: error.message }
    return { ok: true, invoice_id: invoiceId, updated: Object.keys(patch) }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: void_invoice
// ═══════════════════════════════════════════════════════════════
const void_invoice = {
  schema: {
    name: 'void_invoice',
    description: "Mark an invoice void without deleting — preserves audit trail, sets status='void'. Preferred over delete_invoice for invoices that were sent but are legitimately wrong.",
    input_schema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string' },
        invoice_number: { type: 'string' },
        reason: { type: 'string', description: 'Short note recording why it was voided.' }
      }
    }
  },
  async handler(input, ctx) {
    let invoiceId = input.invoice_id
    if (!invoiceId && input.invoice_number) {
      const { data } = await ctx.supabase.from('invoices').select('id').eq('invoice_number', input.invoice_number).maybeSingle()
      invoiceId = data?.id
    }
    if (!invoiceId) return { error: 'invoice_id or invoice_number required' }
    const patch = { status: 'void' }
    if (input.reason) patch.notes = input.reason
    const { error } = await ctx.supabase.from('invoices').update(patch).eq('id', invoiceId)
    if (error) return { error: error.message }
    return { ok: true, invoice_id: invoiceId }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: delete_invoice
// ═══════════════════════════════════════════════════════════════
const delete_invoice = {
  schema: {
    name: 'delete_invoice',
    description: "Permanently delete an invoice. Use for test invoices or duplicates. For production invoices that were sent but are wrong, prefer void_invoice (preserves audit trail).",
    input_schema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string' },
        invoice_number: { type: 'string' }
      }
    }
  },
  async handler(input, ctx) {
    let invoiceId = input.invoice_id
    let invNum = input.invoice_number
    if (!invoiceId && invNum) {
      const { data } = await ctx.supabase.from('invoices').select('id, invoice_number').eq('invoice_number', invNum).maybeSingle()
      invoiceId = data?.id
    }
    if (!invoiceId) return { error: 'invoice_id or invoice_number required and must match a row' }
    const { error } = await ctx.supabase.from('invoices').delete().eq('id', invoiceId)
    if (error) return { error: error.message }
    return { ok: true, invoice_id: invoiceId }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: build_route
// ═══════════════════════════════════════════════════════════════
// Server-side port of routeJobs() from appv2.html. Same filter rules
// (reject TEST/DEMO, require street number in address), same pool
// behavior (overdue + today + tomorrow + day-after-tomorrow when no
// explicit filter given), same Directions-API call with
// waypoints=optimize:true, same Haversine fallback.
//
// Returned shape mirrors what openRouteView renders — stop order +
// per-leg miles/duration + totals. No ETA synthesis in v1; that was
// never in the client logic either.

const BASE_ADDR = '3801 Alder Trail, Euless, TX 76040'
const BASE_LATLNG = { lat: 32.837, lng: -97.082 }
const CITY_COORDS = {
  'euless': { lat: 32.837, lng: -97.082 }, 'bedford': { lat: 32.844, lng: -97.143 },
  'hurst': { lat: 32.823, lng: -97.188 }, 'colleyville': { lat: 32.900, lng: -97.150 },
  'grapevine': { lat: 32.934, lng: -97.078 }, 'irving': { lat: 32.814, lng: -96.949 },
  'grand prairie': { lat: 32.746, lng: -96.994 }, 'arlington': { lat: 32.735, lng: -97.108 },
  'mansfield': { lat: 32.563, lng: -97.141 }, 'fort worth': { lat: 32.755, lng: -97.333 },
  'dallas': { lat: 32.779, lng: -96.800 }, 'garland': { lat: 32.912, lng: -96.638 },
  'mesquite': { lat: 32.767, lng: -96.599 }, 'carrollton': { lat: 32.954, lng: -96.890 },
  'lewisville': { lat: 33.046, lng: -96.994 }, 'denton': { lat: 33.215, lng: -97.133 },
  'plano': { lat: 33.020, lng: -96.699 }, 'frisco': { lat: 33.150, lng: -96.824 },
  'mckinney': { lat: 33.197, lng: -96.640 }, 'allen': { lat: 33.103, lng: -96.671 },
  'richardson': { lat: 32.948, lng: -96.730 }, 'sachse': { lat: 32.970, lng: -96.578 },
  'wylie': { lat: 33.015, lng: -96.539 }, 'melissa': { lat: 33.284, lng: -96.571 },
  'weatherford': { lat: 32.760, lng: -97.797 }, 'glen rose': { lat: 32.233, lng: -97.757 },
  'cleburne': { lat: 32.350, lng: -97.386 }, 'burleson': { lat: 32.542, lng: -97.321 }
}
function _cityCoords(city) {
  if (!city) return BASE_LATLNG
  return CITY_COORDS[String(city).toLowerCase().trim()] || BASE_LATLNG
}
function _haversine(a, b) {
  const R = 3959
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}
function _locAddr(l) {
  return [l.address, l.city, l.state || 'TX', l.zip].filter(Boolean).join(', ')
}
function _fallbackRoute(jobs) {
  let remaining = [...jobs], route = [], cur = BASE_LATLNG
  while (remaining.length) {
    let best = null, bestD = Infinity, bestI = 0
    remaining.forEach((j, i) => {
      const c = _cityCoords(j.location?.city)
      const d = _haversine(cur, c)
      if (d < bestD) { bestD = d; best = j; bestI = i }
    })
    route.push({ job: best, address: _locAddr(best.location || {}), dist: Math.round(bestD), duration: Math.round(bestD * 2.2), durationText: Math.round(bestD * 2.2) + ' min' })
    cur = _cityCoords(best.location?.city)
    remaining.splice(bestI, 1)
  }
  return route
}

const build_route = {
  schema: {
    name: 'build_route',
    description: "Build an optimized driving route through Jon's scheduled jobs. Uses the same logic as the app's Route Plan button (Google Maps directions with waypoint optimization, Haversine fallback if the API fails, skips TEST/DEMO rows and anything without a street number). Default pool is overdue + today + tomorrow + day-after. Pass date for a specific day, or job_ids for an arbitrary subset. Returns stops in drive order with per-leg miles/minutes and totals.",
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD. If given alone, route just this date.' },
        job_ids: { type: 'array', items: { type: 'string' }, description: 'Explicit job UUID list — overrides date/pool logic.' },
        include_overdue: { type: 'boolean', description: 'When routing today (default), include overdue scheduled jobs. Default true.' }
      }
    }
  },
  async handler(input, ctx) {
    const key = process.env.GOOGLE_MAPS_API_KEY
    const today = new Date().toISOString().split('T')[0]

    // 1. Pick the job pool.
    let pool = []
    if (Array.isArray(input.job_ids) && input.job_ids.length) {
      const { data, error } = await ctx.supabase.from('jobs')
        .select('id, status, scheduled_date, scheduled_time, scope, location_id, location:locations(id,name,address,city,state,zip,lat,lng)')
        .in('id', input.job_ids)
      if (error) return { error: error.message }
      pool = data || []
    } else if (input.date) {
      const { data, error } = await ctx.supabase.from('jobs')
        .select('id, status, scheduled_date, scheduled_time, scope, location_id, location:locations(id,name,address,city,state,zip,lat,lng)')
        .eq('scheduled_date', input.date)
        .eq('status', 'scheduled')
      if (error) return { error: error.message }
      pool = data || []
    } else {
      // Default pool: overdue + today + tomorrow + day-after. Mirrors openRouteView.
      const tom = new Date(Date.now() + 86400000).toISOString().split('T')[0]
      const dat2 = new Date(Date.now() + 172800000).toISOString().split('T')[0]
      const { data, error } = await ctx.supabase.from('jobs')
        .select('id, status, scheduled_date, scheduled_time, scope, location_id, location:locations(id,name,address,city,state,zip,lat,lng)')
        .eq('status', 'scheduled')
        .lte('scheduled_date', dat2)
      if (error) return { error: error.message }
      pool = (data || []).filter(j => {
        if (j.scheduled_date < today && input.include_overdue === false) return false
        return j.scheduled_date < today || j.scheduled_date === today || j.scheduled_date === tom || j.scheduled_date === dat2
      })
    }

    // 2. Filter out test rows and addresses without a street number.
    pool = pool.filter(j => {
      const name = (j.location?.name || '').toUpperCase()
      if (name.includes('TEST') || name.includes('DEMO') || name.includes('SAMPLE')) return false
      const a = _locAddr(j.location || {})
      return a.length > 5 && /\d/.test(a)
    })

    if (!pool.length) return { ok: true, date: input.date || today, count: 0, stops: [], note: 'No routable jobs in the selected pool.' }

    // 3. Build stops in the order the client would.
    const stops = pool.map(j => ({ job: j, address: _locAddr(j.location || {}) }))

    // 4. One-stop fast path — distance_matrix for the single leg, no optimization needed.
    if (stops.length === 1) {
      if (key) {
        try {
          const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(BASE_ADDR)}&destinations=${encodeURIComponent(stops[0].address)}&key=${key}`
          const r = await fetch(url)
          const d = await r.json()
          const el = d.rows?.[0]?.elements?.[0]
          if (el?.status === 'OK') {
            const routed = [{ job: stops[0].job, address: stops[0].address, dist: Math.round(el.distance.value / 1609.34), duration: Math.round(el.duration.value / 60), durationText: el.duration.text }]
            return _formatRoute(routed, 'google')
          }
        } catch (e) { /* fall through */ }
      }
      return _formatRoute(_fallbackRoute(pool), 'haversine')
    }

    // 5. Multi-stop: Directions with waypoint optimization. Same call the
    //    field app makes via cachedMapsCall('directions').
    if (key) {
      try {
        const allAddr = stops.map(s => s.address)
        const waypointStr = '&waypoints=optimize:true|' + allAddr.slice(0, -1).map(w => encodeURIComponent(w)).join('|')
        const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(BASE_ADDR)}&destination=${encodeURIComponent(allAddr[allAddr.length - 1])}${waypointStr}&key=${key}`
        const r = await fetch(url)
        const d = await r.json()
        if (d.status === 'OK' && d.routes?.[0]) {
          const route = d.routes[0]
          const order = route.waypoint_order || []
          const legs = route.legs || []
          const optimized = []
          if (order.length) {
            const reordered = [...order.map(idx => stops[idx]), stops[stops.length - 1]]
            reordered.forEach((s, i) => optimized.push({
              job: s.job, address: s.address,
              dist: Math.round((legs[i]?.distance?.value || 0) / 1609.34),
              duration: Math.round((legs[i]?.duration?.value || 0) / 60),
              durationText: legs[i]?.duration?.text || ''
            }))
          } else {
            stops.forEach((s, i) => optimized.push({
              job: s.job, address: s.address,
              dist: Math.round((legs[i]?.distance?.value || 0) / 1609.34),
              duration: Math.round((legs[i]?.duration?.value || 0) / 60),
              durationText: legs[i]?.duration?.text || ''
            }))
          }
          return _formatRoute(optimized, 'google')
        }
      } catch (e) { /* fall through */ }
    }

    return _formatRoute(_fallbackRoute(pool), 'haversine')
  }
}

function _formatRoute(routed, source) {
  const total_miles = routed.reduce((s, r) => s + (r.dist || 0), 0)
  const total_minutes = routed.reduce((s, r) => s + (r.duration || 0), 0)
  return {
    ok: true,
    source,
    count: routed.length,
    total_miles,
    total_minutes,
    origin: BASE_ADDR,
    stops: routed.map((r, i) => ({
      order: i + 1,
      job_id: r.job.id,
      location_id: r.job.location?.id || r.job.location_id,
      name: r.job.location?.name || null,
      city: r.job.location?.city || null,
      address: r.address,
      scope: r.job.scope || [],
      scheduled_date: r.job.scheduled_date,
      scheduled_time: r.job.scheduled_time,
      miles_from_prev: r.dist,
      minutes_from_prev: r.duration,
      duration_text: r.durationText
    }))
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: get_job_activity — read the per-job audit log + notes
// ═══════════════════════════════════════════════════════════════
// Same source as the Activity section on each job card in the app.
// Returns merged job-scoped + invoice-scoped audit_log entries sorted
// newest-first. Lets Riker answer "what's the history on this job",
// "what did Jon note last time", "when was the last communication".
const get_job_activity = {
  schema: {
    name: 'get_job_activity',
    description: "Read the activity log for a job — every event (created, rescheduled, completed, paid, assigned, Mazon, etc.) plus any free-form notes Jon typed on the job card. Merges job events and events on invoices tied to the job. Use when Jon asks 'what's been happening with this job', 'has the customer been notified', 'did I leave a note on Wabi', or when you need history before proposing action.",
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID. Required.' },
        limit: { type: 'integer', description: 'Max entries (default 30, cap 200).' },
        include_invoice_events: { type: 'boolean', description: 'Also include audit rows on invoices tied to this job. Default true.' }
      },
      required: ['job_id']
    }
  },
  async handler(input, ctx) {
    const jobId = input.job_id
    if (!jobId) return { error: 'job_id required' }
    const limit = Math.min(200, Number(input.limit) || 30)
    const includeInv = input.include_invoice_events !== false

    const jobQ = ctx.supabase.from('audit_log')
      .select('action, actor, summary, changes, created_at, entity_type, entity_id')
      .eq('entity_type', 'job').eq('entity_id', jobId)
      .order('created_at', { ascending: false }).limit(limit)
    const invIdQ = includeInv
      ? ctx.supabase.from('invoices').select('id').eq('job_id', jobId)
      : Promise.resolve({ data: [] })

    const [jobRes, invIdRes] = await Promise.all([jobQ, invIdQ])
    if (jobRes.error) return { error: jobRes.error.message }
    const jobEvents = jobRes.data || []

    let invEvents = []
    const invIds = (invIdRes.data || []).map(r => r.id)
    if (includeInv && invIds.length) {
      const { data, error } = await ctx.supabase.from('audit_log')
        .select('action, actor, summary, changes, created_at, entity_type, entity_id')
        .eq('entity_type', 'invoice').in('entity_id', invIds)
        .order('created_at', { ascending: false }).limit(limit)
      if (error) return { error: error.message }
      invEvents = data || []
    }

    const all = [...jobEvents, ...invEvents]
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, limit)

    return {
      job_id: jobId,
      count: all.length,
      events: all.map(e => ({
        when: e.created_at,
        action: e.action,
        actor: e.actor,
        on: e.entity_type,
        summary: e.summary || null
      }))
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: add_job_note — append a free-form memo to a job's log
// ═══════════════════════════════════════════════════════════════
// Same thing the "Log it" button on the job card does. Writes an
// audit_log row with action='note' so Jon can find it on the card.
const add_job_note = {
  schema: {
    name: 'add_job_note',
    description: "Append a free-form note to a job's activity log. Use when Jon says 'log on Wabi that the owner called', 'note that I had to come back for the second extinguisher', 'put on the Amigos job that they asked about monthly billing'. Equivalent to Jon typing in the Activity box on the job card.",
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID. Required.' },
        text: { type: 'string', description: 'The note body. Required.' }
      },
      required: ['job_id', 'text']
    }
  },
  async handler(input, ctx) {
    const jobId = input.job_id
    const text = String(input.text || '').trim()
    if (!jobId) return { error: 'job_id required' }
    if (!text) return { error: 'text required' }
    const actor = ctx.context === 'app' || ctx.context === 'sms_jon' ? 'ai_chat' : 'system'
    const { error } = await ctx.supabase.from('audit_log').insert({
      action: 'note',
      entity_type: 'job',
      entity_id: jobId,
      actor,
      summary: text
    })
    if (error) return { error: error.message }
    return { ok: true, job_id: jobId }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: update_job — edit job fields
// ═══════════════════════════════════════════════════════════════
const update_job = {
  schema: {
    name: 'update_job',
    description: "Edit fields on an existing job. Pass job_id and any subset of fields to change. For status changes prefer the specific tools (schedule_job, cancel_job). For marking completed, the app's complete-flow is required (captures signature + generates invoice).",
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        scope: { type: 'array', items: { type: 'string' }, description: "e.g. ['suppression','extinguishers','elights','hydro']" },
        type: { type: 'string', description: "inspection, installation, repair, etc." },
        notes: { type: 'string' },
        estimated_value: { type: 'number' },
        scheduled_date: { type: 'string', description: 'YYYY-MM-DD' },
        scheduled_time: { type: 'string', description: 'HH:MM (24h)' },
        assigned_to: { type: 'string', description: 'Tech UUID, or empty string to unassign.' }
      },
      required: ['job_id']
    }
  },
  async handler(input, ctx) {
    const patch = {}
    if (input.scope !== undefined) patch.scope = input.scope
    if (input.type !== undefined) patch.type = input.type
    if (input.notes !== undefined) patch.notes = input.notes
    if (input.estimated_value !== undefined) patch.estimated_value = Number(input.estimated_value)
    if (input.scheduled_date !== undefined) patch.scheduled_date = input.scheduled_date
    if (input.scheduled_time !== undefined) patch.scheduled_time = input.scheduled_time
    if (input.assigned_to !== undefined) patch.assigned_to = input.assigned_to || null
    if (Object.keys(patch).length === 0) return { error: 'Nothing to update — pass at least one field.' }
    const { error } = await ctx.supabase.from('jobs').update(patch).eq('id', input.job_id)
    if (error) return { error: error.message }
    const fields = Object.keys(patch).join(', ')
    await ctx.supabase.from('audit_log').insert({
      action: 'updated', entity_type: 'job', entity_id: input.job_id,
      actor: 'ai_chat', changes: patch, summary: 'Job updated: ' + fields
    })
    return { ok: true, job_id: input.job_id, updated: Object.keys(patch) }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: cancel_job
// ═══════════════════════════════════════════════════════════════
const cancel_job = {
  schema: {
    name: 'cancel_job',
    description: "Cancel a job (non-destructive — sets status='cancelled', keeps the record for audit). Use when the customer declines service, reschedules indefinitely, or the job was created in error. For hard delete, use update_job or ask Jon.",
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        reason: { type: 'string', description: 'Short reason recorded in the activity log.' }
      },
      required: ['job_id']
    }
  },
  async handler(input, ctx) {
    const { data: job } = await ctx.supabase.from('jobs').select('id, status, location:locations(name)').eq('id', input.job_id).maybeSingle()
    if (!job) return { error: 'Job not found' }
    if (job.status === 'cancelled') return { error: 'Already cancelled' }
    if (job.status === 'completed') return { error: 'Job is completed — cannot cancel a completed job' }
    const { error } = await ctx.supabase.from('jobs').update({ status: 'cancelled' }).eq('id', job.id)
    if (error) return { error: error.message }
    const summary = 'Job cancelled for ' + (job.location?.name || 'client') + (input.reason ? ' — ' + input.reason : '')
    await ctx.supabase.from('audit_log').insert({
      action: 'cancelled', entity_type: 'job', entity_id: job.id,
      actor: 'ai_chat', changes: { reason: input.reason || null }, summary
    })
    return { ok: true, job_id: job.id }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: send_email
// ═══════════════════════════════════════════════════════════════
const send_email = {
  schema: {
    name: 'send_email',
    description: "Send an email to a customer from jonathan@stephensadvanced.com. Use for reports, invoices, follow-ups, quotes. Logs the outbound in the conversation thread if one exists.",
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email.' },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Plain text body. Double line-breaks become paragraphs in the HTML wrapper.' }
      },
      required: ['to', 'subject', 'body']
    }
  },
  async handler(input, ctx) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to)) return { error: 'Invalid email address' }
    try {
      await sendEmailRaw({ to: input.to, subject: input.subject, body: input.body })
    } catch (e) {
      return { error: e.message }
    }
    try {
      const { data: conv } = await ctx.supabase.from('conversations')
        .select('id').eq('channel', 'email').eq('email', input.to).eq('status', 'active')
        .order('last_message_at', { ascending: false }).limit(1).maybeSingle()
      if (conv) {
        await ctx.supabase.from('messages').insert({
          conversation_id: conv.id, direction: 'outbound', channel: 'email',
          body: input.body, email_subject: input.subject
        })
      }
    } catch (e) { /* best effort logging */ }
    return { ok: true, to: input.to }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: get_conversation_history
// ═══════════════════════════════════════════════════════════════
const get_conversation_history = {
  schema: {
    name: 'get_conversation_history',
    description: "Read past SMS and email messages with a customer. Filter by location_id, phone, or email. Use before replying, calling, or rescheduling to build context — 'have we heard from them before', 'did we already notify about the reschedule', 'any prior complaints'. Returns messages in chronological order (oldest first) so it reads like a transcript.",
    input_schema: {
      type: 'object',
      properties: {
        location_id: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        limit: { type: 'integer', description: 'Max messages (default 20, cap 100).' }
      }
    }
  },
  async handler(input, ctx) {
    if (!input.location_id && !input.phone && !input.email) {
      return { error: 'Must pass one of: location_id, phone, email' }
    }
    const limit = Math.min(100, Number(input.limit) || 20)
    let convQ = ctx.supabase.from('conversations')
      .select('id, channel, phone, email, customer_name, location_id, started_at, last_message_at')
      .order('last_message_at', { ascending: false }).limit(10)
    if (input.location_id) convQ = convQ.eq('location_id', input.location_id)
    if (input.phone) {
      let p = String(input.phone).replace(/[\s\-().]/g, '')
      if (!p.startsWith('+')) p = '+1' + p.replace(/^1/, '')
      convQ = convQ.eq('phone', p)
    }
    if (input.email) convQ = convQ.eq('email', input.email.toLowerCase())
    const { data: convs, error: cErr } = await convQ
    if (cErr) return { error: cErr.message }
    if (!convs || !convs.length) return { count: 0, conversations: [], messages: [] }
    const convIds = convs.map(c => c.id)
    const { data: msgs, error: mErr } = await ctx.supabase.from('messages')
      .select('conversation_id, direction, channel, body, created_at, email_subject')
      .in('conversation_id', convIds)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (mErr) return { error: mErr.message }
    return {
      count: (msgs || []).length,
      conversations: convs,
      messages: (msgs || []).reverse()  // oldest first → reads like a transcript
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: create_invoice
// ═══════════════════════════════════════════════════════════════
const create_invoice = {
  schema: {
    name: 'create_invoice',
    description: "Generate a new invoice for a job from line items. Auto-generates an INV-XXXXXX number and puts it in draft status. Invoice is tied to the job's location + billing account. Use when Jon says 'invoice Wabi for Tuesday — 4 ext at 22.80 and 1 supp at 285'. Pair with send_email or mark_invoice_paid to close the loop.",
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        line_items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantity: { type: 'number' },
              unit_price: { type: 'number' }
            },
            required: ['description', 'quantity', 'unit_price']
          }
        },
        notes: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD invoice date. Default today.' },
        due_date: { type: 'string', description: 'YYYY-MM-DD. Default invoice date + 30 days.' }
      },
      required: ['job_id', 'line_items']
    }
  },
  async handler(input, ctx) {
    if (!Array.isArray(input.line_items) || !input.line_items.length) return { error: 'line_items required' }
    const { data: job } = await ctx.supabase.from('jobs')
      .select('id, location_id, billing_account_id, location:locations(name)')
      .eq('id', input.job_id).maybeSingle()
    if (!job) return { error: 'Job not found' }
    const lines = input.line_items.map(l => {
      const qty = Number(l.quantity) || 1
      const up = Number(l.unit_price) || 0
      return {
        description: String(l.description || '').trim(),
        quantity: qty,
        unit_price: up,
        total: Math.round(qty * up * 100) / 100
      }
    })
    const sub = Math.round(lines.reduce((s, l) => s + l.total, 0) * 100) / 100
    const today = new Date().toISOString().split('T')[0]
    const invDate = input.date || today
    const dueDefault = new Date(new Date(invDate + 'T12:00:00').getTime() + 30 * 86400000).toISOString().split('T')[0]
    const invNum = 'INV-' + Date.now().toString().slice(-6)
    const { data: inv, error } = await ctx.supabase.from('invoices').insert({
      job_id: job.id,
      location_id: job.location_id,
      billing_account_id: job.billing_account_id,
      invoice_number: invNum,
      subtotal: sub,
      total: sub,
      status: 'draft',
      date: invDate,
      due_date: input.due_date || dueDefault,
      notes: input.notes || null
    }).select().single()
    if (error) return { error: error.message }
    const lineRows = lines.map((ln, i) => ({ invoice_id: inv.id, description: ln.description, quantity: ln.quantity, unit_price: ln.unit_price, total: ln.total, sort_order: i }))
    const { error: lErr } = await ctx.supabase.from('invoice_lines').insert(lineRows)
    if (lErr) return { ok: true, invoice_id: inv.id, invoice_number: invNum, total: sub, warning: 'Lines insert warning: ' + lErr.message }
    await ctx.supabase.from('audit_log').insert({
      action: 'created', entity_type: 'invoice', entity_id: inv.id,
      actor: 'ai_chat', changes: { invoice_number: invNum, total: sub },
      summary: `Invoice ${invNum} created for ${job.location?.name || 'job'} ($${sub.toFixed(2)})`
    })
    return { ok: true, invoice_id: inv.id, invoice_number: invNum, total: sub, line_count: lines.length }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: list_job_documents
// ═══════════════════════════════════════════════════════════════
const list_job_documents = {
  schema: {
    name: 'list_job_documents',
    description: "List photos, reports, signature flag, and extinguisher-report pages on a job. Useful for 'did I photograph the extinguisher tag', 'is the signature captured', 'what reports are on this job'.",
    input_schema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id']
    }
  },
  async handler(input, ctx) {
    const { data: job } = await ctx.supabase.from('jobs')
      .select('id, photos, signature_data, ext_report_photos, location:locations(name)')
      .eq('id', input.job_id).maybeSingle()
    if (!job) return { error: 'Job not found' }
    const { data: reports } = await ctx.supabase.from('reports')
      .select('id, report_type, created_at').eq('job_id', input.job_id)
    return {
      job_id: job.id,
      location_name: job.location?.name || null,
      photo_count: (job.photos || []).length,
      ext_report_page_count: (job.ext_report_photos || []).length,
      signature_captured: !!job.signature_data,
      reports: (reports || []).map(r => ({ id: r.id, type: r.report_type, created_at: r.created_at })),
      report_count: (reports || []).length
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: mazon_list_queue — read-only queue status
// ═══════════════════════════════════════════════════════════════
const mazon_list_queue = {
  schema: {
    name: 'mazon_list_queue',
    description: "List the Mazon factoring queue filtered by status. Use for 'what's pending Mazon', 'how much is waiting to fund', 'anything rejected'.",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'submitted', 'funded', 'rejected', 'voided', 'all'], description: "Default 'pending'." }
      }
    }
  },
  async handler(input, ctx) {
    const status = input.status || 'pending'
    let q = ctx.supabase.from('mazon_queue')
      .select('id, invoice_id, invoice_number, customer_name, amount, status, signed_at, submitted_at, funded_at, funded_amount, rejected_reason')
      .order('created_at', { ascending: false }).limit(50)
    if (status !== 'all') q = q.eq('status', status)
    const { data, error } = await q
    if (error) return { error: error.message }
    const total = (data || []).reduce((s, r) => s + Number(r.amount || 0), 0)
    return { count: data.length, total_usd: Math.round(total * 100) / 100, queue: data }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: mazon_mark_funded
// ═══════════════════════════════════════════════════════════════
const mazon_mark_funded = {
  schema: {
    name: 'mazon_mark_funded',
    description: "Mark a Mazon queue row funded after Jon confirms the deposit landed. Sets invoice status='paid' and records the funded amount. Use when Jon says 'Mazon funded Wabi for $342'.",
    input_schema: {
      type: 'object',
      properties: {
        queue_id: { type: 'string' },
        invoice_number: { type: 'string', description: 'Lookup alternative.' },
        funded_amount: { type: 'number' },
        reason: { type: 'string' }
      },
      required: ['funded_amount']
    }
  },
  async handler(input, ctx) {
    let qId = input.queue_id
    if (!qId && input.invoice_number) {
      const { data: inv } = await ctx.supabase.from('invoices').select('id, mazon_queue_id').eq('invoice_number', input.invoice_number).maybeSingle()
      qId = inv?.mazon_queue_id
    }
    if (!qId) return { error: 'queue_id or invoice_number required' }
    const { data: qr } = await ctx.supabase.from('mazon_queue').select('*').eq('id', qId).maybeSingle()
    if (!qr) return { error: 'Queue row not found' }
    const amt = Number(input.funded_amount)
    if (!(amt > 0)) return { error: 'funded_amount must be > 0' }
    const fundedAt = new Date().toISOString()
    await ctx.supabase.from('mazon_queue').update({ status: 'funded', funded_at: fundedAt, funded_amount: amt }).eq('id', qId)
    await ctx.supabase.from('invoices').update({ status: 'paid', paid_at: fundedAt, payment_method: 'mazon' }).eq('id', qr.invoice_id)
    await ctx.supabase.from('mazon_audit_log').insert({
      actor: 'ai_chat', entity_type: 'queue', entity_id: qId,
      old_status: qr.status, new_status: 'funded',
      reason: input.reason || 'Marked funded via Riker',
      metadata: { funded_amount: amt }
    })
    await ctx.supabase.from('audit_log').insert({
      action: 'paid', entity_type: 'invoice', entity_id: qr.invoice_id,
      actor: 'ai_chat', changes: { amount: amt, method: 'mazon' },
      summary: `Mazon funded — ${qr.customer_name} ($${amt.toFixed(2)})`
    })
    return { ok: true, queue_id: qId, invoice_id: qr.invoice_id, funded_amount: amt }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: mazon_void
// ═══════════════════════════════════════════════════════════════
const mazon_void = {
  schema: {
    name: 'mazon_void',
    description: "Void a pending or submitted Mazon queue row. Rolls the invoice status back to 'sent' so it can be collected normally. Use when the customer paid directly before Mazon funded.",
    input_schema: {
      type: 'object',
      properties: {
        queue_id: { type: 'string' },
        invoice_number: { type: 'string' },
        reason: { type: 'string' }
      }
    }
  },
  async handler(input, ctx) {
    let qId = input.queue_id
    if (!qId && input.invoice_number) {
      const { data: inv } = await ctx.supabase.from('invoices').select('id, mazon_queue_id').eq('invoice_number', input.invoice_number).maybeSingle()
      qId = inv?.mazon_queue_id
    }
    if (!qId) return { error: 'queue_id or invoice_number required' }
    const { data: qr } = await ctx.supabase.from('mazon_queue').select('*').eq('id', qId).maybeSingle()
    if (!qr) return { error: 'Queue row not found' }
    if (qr.status !== 'pending' && qr.status !== 'submitted') return { error: 'Only pending or submitted rows can be voided (current: ' + qr.status + ')' }
    await ctx.supabase.from('mazon_queue').update({ status: 'voided', voided_reason: input.reason || null }).eq('id', qId)
    await ctx.supabase.from('invoices').update({ status: 'sent', payment_method: null, mazon_queue_id: null }).eq('id', qr.invoice_id)
    await ctx.supabase.from('mazon_audit_log').insert({
      actor: 'ai_chat', entity_type: 'queue', entity_id: qId,
      old_status: qr.status, new_status: 'voided',
      reason: input.reason || 'Voided via Riker'
    })
    return { ok: true, queue_id: qId, invoice_id: qr.invoice_id }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: request_owner_otp  (website context only)
// ═══════════════════════════════════════════════════════════════
// When someone on the website chat claims to be Jon / the owner and
// wants to verify their identity, send a 6-digit code to Jon's
// registered phone number. They then type it back into the chat.
const request_owner_otp = {
  schema: {
    name: 'request_owner_otp',
    description: "Send a one-time verification code to Jon's registered phone number so the person can prove they're the owner. Call this when someone says they're Jon, claims to be the owner, or asks for admin/owner access. After calling it, tell them: 'I just texted a verification code to your registered number — type it here when you get it.'",
    input_schema: { type: 'object', properties: {} }
  },
  async handler(_input, ctx) {
    const otp = String(Math.floor(100000 + Math.random() * 900000))
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
    const { error } = await ctx.supabase.from('admin_otps').insert({
      phone: JON_PHONE, code: otp, expires_at: expiresAt, used: false
    })
    if (error) return { error: 'Failed to generate code: ' + error.message }
    try {
      await sendSMSRaw(JON_PHONE, `Verification code: ${otp}\n(Requested from website chat — expires in 10 min)`)
    } catch (e) {
      return { error: 'Code created but SMS failed: ' + e.message }
    }
    return { ok: true, sent: true }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: verify_owner_otp  (website context only)
// ═══════════════════════════════════════════════════════════════
const verify_owner_otp = {
  schema: {
    name: 'verify_owner_otp',
    description: "Verify the 6-digit code the person typed to confirm they're the owner. Call after request_owner_otp when the user provides a code.",
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The 6-digit code the user typed.' }
      },
      required: ['code']
    }
  },
  async handler(input, ctx) {
    const code = String(input.code || '').trim()
    if (!/^\d{6}$/.test(code)) return { verified: false, reason: 'invalid_format' }
    const { data: row } = await ctx.supabase.from('admin_otps')
      .select('id')
      .eq('phone', JON_PHONE)
      .eq('code', code)
      .eq('used', false)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1).maybeSingle()
    if (!row) return { verified: false, reason: 'invalid_or_expired' }
    await ctx.supabase.from('admin_otps').update({ used: true }).eq('id', row.id)
    return { verified: true }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: escalate_to_jon  (website context only)
// ═══════════════════════════════════════════════════════════════
// When the bot can't answer something and needs Jon's input, call
// this instead of fabricating a response. It creates a chat_escalations
// row and texts Jon. Jon can reply "RELAY: [answer]" via SMS and the
// reply is pushed back into the customer's website chat session.
const escalate_to_jon = {
  schema: {
    name: 'escalate_to_jon',
    description: "Escalate a customer question to Jon via SMS when you can't answer it. Creates a record so Jon's SMS reply can be relayed back to the customer's website chat. After calling this, tell the customer: \"I've messaged Jon — he usually gets back right away unless he's got his hands full.\" Never fabricate Jon's availability or imply he'll respond at a specific time.",
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: "The customer's question or situation to relay to Jon, verbatim or summarized." },
        customer_name: { type: 'string', description: "Customer's name if already collected." },
        context: { type: 'string', description: "Any relevant background Jon needs (what service, what was already collected, etc.)." }
      },
      required: ['question']
    }
  },
  async handler(input, ctx) {
    const sessionId = ctx.rikerSessionId || ctx.sessionId
    // Log the escalation
    const { error: escErr } = await ctx.supabase.from('chat_escalations').insert({
      web_session_id: sessionId,
      customer_name: input.customer_name || null,
      question: input.question
    })
    if (escErr) console.warn('[escalate_to_jon] insert failed:', escErr.message)
    // Text Jon — include RELAY instructions so he knows how to respond cross-channel
    try {
      const nameStr = input.customer_name || 'Website visitor'
      const ctxLine = input.context ? `\nContext: ${input.context}` : ''
      const body = `🌐 Web chat\n${nameStr} asks: ${input.question}${ctxLine}\n\nReply: RELAY: [your answer]`
      await sendSMSRaw(JON_PHONE, body)
    } catch (e) {
      return { error: 'Failed to notify Jon: ' + e.message }
    }
    return { ok: true, escalated: true }
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
  lookup_business,
  update_client, delete_client, merge_clients,
  update_invoice, void_invoice, delete_invoice,
  build_route,
  get_job_activity, add_job_note,
  update_job, cancel_job,
  send_email, get_conversation_history, create_invoice, list_job_documents,
  mazon_list_queue, mazon_mark_funded, mazon_void,
  escalate_to_jon,
  request_owner_otp, verify_owner_otp
}

// null = all tools. Keeps Jon contexts unrestricted; trims customer contexts.
const CONTEXT_TOOLS = {
  website: null,  // full tool access — owner verification via OTP gates destructive use
  portal: ['lookup_client', 'get_invoices', 'get_equipment', 'get_schedule_slots', 'schedule_job', 'write_memory'],
  app: null,
  sms_jon: null,
  sms_customer: ['lookup_client', 'lookup_business', 'get_schedule_slots', 'get_rate_card', 'schedule_job', 'add_client'],
  email_customer: ['lookup_client', 'lookup_business', 'get_schedule_slots', 'schedule_job', 'add_client', 'send_sms']
}

// Anthropic-hosted server tool. No handler needed — the API executes it
// during the turn and returns both the query and results inline. We just
// include the spec in the tools array when the context should have web
// access.
const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 3
}
const WEB_SEARCH_CONTEXTS = new Set(['app', 'sms_jon'])

function getToolsForContext(context) {
  const allowed = CONTEXT_TOOLS[context]
  const names = allowed === null || allowed === undefined ? Object.keys(ALL_TOOLS) : allowed
  const schemas = names.filter(n => ALL_TOOLS[n]).map(n => ALL_TOOLS[n].schema)
  if (WEB_SEARCH_CONTEXTS.has(context)) schemas.push(WEB_SEARCH_TOOL)
  return schemas
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
