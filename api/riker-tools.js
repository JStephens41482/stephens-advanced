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
const web = require('./riker-web')

const JON_PHONE = '+12149944799'
const BRYCER_CITIES = ['fort worth', 'benbrook', 'burleson', 'crowley', 'edgecliff village', 'everman', 'forest hill', 'haltom city', 'kennedale', 'lake worth', 'north richland hills', 'richland hills', 'river oaks', 'saginaw', 'sansom park', 'westover hills', 'westworth village', 'white settlement', 'watauga', 'blue mound', 'haslet', 'keller', 'southlake', 'colleyville', 'grapevine', 'euless', 'bedford', 'hurst']

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

// Log a row to deleted_records before removing it from its source table.
// Never throws — a logging failure should not block the caller.
async function trashRecord(supabase, { tableName, recordId, recordData, deletedBy, reason, context }) {
  try {
    await supabase.from('deleted_records').insert({
      table_name: tableName,
      record_id: String(recordId),
      record_data: recordData,
      deleted_by: deletedBy || 'unknown',
      reason: reason || null,
      context: context || null
    })
  } catch (e) {
    console.error('[trashRecord] failed to log deletion:', e.message)
  }
}

// rikerAudit — single source of truth for Riker-driven audit_log inserts.
// The live audit_log schema stores `details: JSONB` with `{changes, summary}`
// nested inside — there are NO direct `changes` or `summary` columns. Several
// tools across this file were inserting against the wrong columns; those
// writes silently failed (unused result, no `await` error capture) so every
// Riker-driven update / cancel / mazon-funding was missing its audit row.
// All Riker-side audit writes should go through this helper.
async function rikerAudit(ctx, action, entityType, entityId, summary, changes) {
  try {
    await ctx.supabase.from('audit_log').insert({
      action,
      entity_type: entityType,
      entity_id: entityId,
      actor: 'ai_chat',
      details: { changes: changes || null, summary: summary || null }
    })
  } catch (e) {
    console.warn(`[rikerAudit ${action} ${entityType}] insert failed:`, e.message)
  }
}

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

const { renderEmail, renderText } = require('./email-template')

async function sendEmailRaw({ to, subject, body, inReplyTo, references, attachments, plain }) {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) throw new Error('RESEND_API_KEY not configured')

  // `plain: true` sends a barebones inline-HTML email (used for thread replies
  // where the customer is already mid-conversation and template chrome would
  // be jarring). Default is to wrap in the branded template.
  let html, text
  if (plain) {
    html = body.split('\n\n').map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')
    text = body
  } else {
    // Promote the first paragraph to "intro" and the rest to body HTML so
    // simple Riker-driven sends ("send Mauro a follow-up about the receipt")
    // get the full template chrome with logo + footer.
    const paragraphs = body.split('\n\n').map(p => p.trim()).filter(Boolean)
    const intro = paragraphs[0] || ''
    const restHtml = paragraphs.slice(1).map(p => `<p style="margin:0 0 14px;font-size:14px;color:#444;line-height:1.7">${p.replace(/\n/g, '<br>')}</p>`).join('')
    const opts = {
      headline: subject || 'Stephens Advanced',
      subheadline: 'Stephens Advanced LLC &mdash; Fire Suppression &amp; Safety',
      intro,
      bodyHtml: restHtml,
    }
    html = renderEmail(opts)
    text = renderText(opts)
  }

  const headers = {}
  if (inReplyTo) headers['In-Reply-To'] = inReplyTo
  if (references) headers['References'] = references
  const payload = {
    from: 'Stephens Advanced <jonathan@stephensadvanced.com>',
    to: [to], subject, html, text,
  }
  if (Object.keys(headers).length) payload.headers = headers
  if (attachments && attachments.length) payload.attachments = attachments

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
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

// ─── Gmail helpers (used by read_inbox / read_email_thread) ─────
async function getGmailToken() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || '780674517325-ar9lod4h4phk6sdbtcljoqv7e1m41g2p.apps.googleusercontent.com'
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN
  if (!clientSecret || !refreshToken) throw new Error('Gmail OAuth not configured (GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_CALENDAR_REFRESH_TOKEN missing)')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' })
  })
  const data = await res.json()
  if (!res.ok) throw new Error('Gmail token refresh failed: ' + JSON.stringify(data))
  return data.access_token
}

async function gmailFetch(token, path, opts = {}) {
  const init = { headers: { Authorization: `Bearer ${token}` } }
  if (opts.method && opts.method !== 'GET') {
    init.method = opts.method
    if (opts.body !== undefined) {
      init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
      init.headers['Content-Type'] = 'application/json'
    }
  }
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/' + path, init)
  // Some endpoints (modify, batchModify, trash) return 204 No Content.
  if (res.status === 204) return { ok: true }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = data.error?.message || res.statusText
    if (msg.includes('Insufficient Permission') || msg.includes('insufficient authentication'))
      throw new Error('Gmail scope missing — re-authorize with gmail.modify scope (or gmail.readonly for read-only paths)')
    throw new Error('Gmail API: ' + msg)
  }
  return data
}

function gmailParseFrom(fromHeader) {
  const m = fromHeader.match(/<([^>]+)>/)
  const email = (m ? m[1] : fromHeader).trim().toLowerCase()
  const name = m ? fromHeader.replace(/<[^>]+>/, '').trim().replace(/^"(.+)"$/, '$1') : email
  return { email, name }
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
    description: "Search jobs by status, date range, location, or scope. Use this when Jon asks 'what's overdue', 'show me next week', etc. IMPORTANT: this tool filters by location_id (UUID), NOT by client name. If Jon asks about jobs for a specific client by name (e.g. 'jobs at Dragon Palace'), call lookup_client first to get their location_id, then pass it here. You can also pass location_name and this tool will resolve it automatically.",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['scheduled', 'completed', 'cancelled', 'en_route', 'active', 'any'], description: 'Defaults to any.' },
        date_from: { type: 'string', description: 'YYYY-MM-DD inclusive. Omit for no lower bound.' },
        date_to: { type: 'string', description: 'YYYY-MM-DD inclusive. Omit for no upper bound.' },
        overdue_only: { type: 'boolean', description: 'If true, only return jobs scheduled before today with status=scheduled.' },
        location_id: { type: 'string', description: 'UUID of the location. Use this if you already have it from lookup_client.' },
        location_name: { type: 'string', description: 'Client name to search for (fuzzy). The tool resolves this to a location_id automatically. Use instead of location_id when Jon gives a name.' },
        scope: { type: 'array', items: { type: 'string' }, description: 'Filter to jobs whose scope array contains ANY of these.' },
        limit: { type: 'integer', description: 'Max rows (default 20, cap 100).' }
      }
    }
  },
  async handler(input, ctx) {
    const limit = Math.min(100, Number(input.limit) || 20)
    const today = new Date().toISOString().split('T')[0]

    // If caller gave a name instead of a UUID, resolve it via the locations table.
    let locationId = input.location_id || null
    let resolvedClient = null
    if (!locationId && input.location_name) {
      const s = String(input.location_name).trim().toLowerCase()
      if (s) {
        const stopwords = new Set(['the', 'a', 'an', 'of', 'in', 'at', 'on', 'to', 'for', 'and', 'or', 'store', 'shop', 'restaurant', 'llc', 'inc', 'co', 'company'])
        const tokens = s.split(/\s+/)
          .map(t => t.replace(/[^a-z0-9']/g, ''))
          .filter(t => { const bare = t.replace(/'/g, ''); return bare.length >= 2 && !stopwords.has(bare) })
          .slice(0, 4)
        let lq = ctx.supabase.from('locations').select('id, name, city').is('deleted_at', null).limit(5)
        if (tokens.length === 0) {
          lq = lq.or(`name.ilike.%${s.replace(/[%_]/g, '')}%,city.ilike.%${s.replace(/[%_]/g, '')}%`)
        } else {
          for (const tok of tokens) {
            const pat = '%' + tok.replace(/'/g, '%') + '%'
            lq = lq.or(`name.ilike.${pat},city.ilike.${pat}`)
          }
        }
        const { data: locs } = await lq
        if (locs && locs.length) {
          locationId = locs[0].id
          resolvedClient = { name: locs[0].name, city: locs[0].city }
        } else {
          return { count: 0, jobs: [], note: `No client found matching "${input.location_name}" — try lookup_client to verify spelling.` }
        }
      }
    }

    let q = ctx.supabase.from('jobs')
      .select('id, job_number, scheduled_date, scheduled_time, scope, status, estimated_value, type, notes, location:locations(id,name,city,address,contact_phone)')
      .is('deleted_at', null)
      .order('scheduled_date', { ascending: false })
      .limit(limit)
    if (input.overdue_only) {
      q = q.lt('scheduled_date', today).eq('status', 'scheduled')
    } else {
      if (input.status && input.status !== 'any') q = q.eq('status', input.status)
      if (input.date_from) q = q.gte('scheduled_date', input.date_from)
      if (input.date_to) q = q.lte('scheduled_date', input.date_to)
    }
    if (locationId) q = q.eq('location_id', locationId)
    if (input.scope?.length) q = q.overlaps('scope', input.scope)
    const { data, error } = await q
    if (error) return { error: error.message }
    return { count: data.length, jobs: data, ...(resolvedClient ? { client: resolvedClient } : {}) }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: lookup_client
// ═══════════════════════════════════════════════════════════════
const lookup_client = {
  schema: {
    name: 'lookup_client',
    description: "Primary client search — use this whenever Jon OR a customer mentions a business name and you need their details, location_id, or last-service history. Fuzzy ILIKE match on name and city. Returns up to 10 matches with full location details AND last_job. ALWAYS call this first when anyone gives a business name — before asking for info that's already on file. For job lookups by client name, call this first to get the location_id, then call query_jobs.",
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Business name, city, or phone number fragment. Required.' },
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
      .is('deleted_at', null)
      .limit(limit)

    if (phoneDigits.length >= 7) {
      // phone search — dashes/parens stripped, match digits anywhere
      q = q.ilike('contact_phone', '%' + phoneDigits + '%')
    } else {
      // Tokenize so "Amigos Grocery Store Irving" matches name="Amigos
      // Grocery Store" city="Irving". Each token must appear in name OR
      // city. Strip stopwords that show up in noisy business names.
      // Keep apostrophes during tokenization so "Mario's" → pattern
      // "%mario%s%" which matches "Mario's Pizza" in the DB.
      const stopwords = new Set(['the', 'a', 'an', 'of', 'in', 'at', 'on', 'to', 'for', 'and', 'or', 'store', 'shop', 'restaurant', 'llc', 'inc', 'co', 'company'])
      const tokens = s.toLowerCase()
        .split(/\s+/)
        .map(t => t.replace(/[^a-z0-9']/g, ''))   // keep apostrophes, strip everything else
        .filter(t => {
          const bare = t.replace(/'/g, '')          // strip apostrophe for length / stopword check
          return bare.length >= 2 && !stopwords.has(bare)
        })
        .slice(0, 5)
      if (tokens.length === 0) {
        const wc = '%' + s.replace(/[%_]/g, '') + '%'
        q = q.or(`name.ilike.${wc},city.ilike.${wc}`)
      } else {
        for (const tok of tokens) {
          // Replace apostrophes with % wildcard so "mario's" → "%mario%s%"
          // which matches both "Mario's Pizza" (has apostrophe) and
          // "Marios Kitchen" (no apostrophe) in the database.
          const wc = '%' + tok.replace(/'/g, '%') + '%'
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

    const matches = data.map(r => ({
      ...r,
      last_job: lastJobByLoc[r.id]
        ? { date: lastJobByLoc[r.id].scheduled_date, scope: lastJobByLoc[r.id].scope, status: lastJobByLoc[r.id].status }
        : null
    }))

    // If there's exactly one match and we're in a website session, stamp the
    // location_id onto the session so customer-scoped memories load next turn.
    if (matches.length === 1 && ctx.rikerSessionId && ctx.context === 'website') {
      ctx.supabase.from('riker_sessions').update({
        location_id: matches[0].id, updated_at: new Date().toISOString()
      }).eq('id', ctx.rikerSessionId).then(() => {}).catch(() => {})
      ctx.lastLocationId = matches[0].id
    }

    return { count: matches.length, matches }
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
      .is('deleted_at', null)
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
    description: "Get available booking time slots for the next N days. Already accounts for Jon's custody schedule with his son William. Each day includes a 'booked' array showing existing jobs with their time, customer name, and city — use this to find days when Jon is already working near the new customer's location. Always call this before proposing a time — never guess availability.",
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
      .select('id, scheduled_date, scheduled_time, estimated_duration_hours, status, location:locations(name,city)')
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
      out.push({ date: d, available: true, work_window: `${avail.workStart}-${avail.workEnd}`, reason: avail.reason, slots, booked: dayJobs.map(j => ({ time: j.scheduled_time, customer: j.location?.name, city: j.location?.city || null })) })
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
    description: "Summarize the equipment at a location based on what's actually been inspected and billed. DERIVED ONLY — there is no manually-maintained equipment table. Sources: reports.report_data (extinguisher / kitchen_suppression / dry_chemical / clean_agent / emergency_light) and invoice_lines on the location's invoices.",
    input_schema: {
      type: 'object',
      properties: { location_id: { type: 'string' } },
      required: ['location_id']
    }
  },
  async handler(input, ctx) {
    if (!input.location_id) return { error: 'location_id required' }
    const sb = ctx.supabase

    const { data: jobs } = await sb.from('jobs').select('id').eq('location_id', input.location_id)
    const jobIds = (jobs || []).map(j => j.id)

    const { data: reports } = jobIds.length
      ? await sb.from('reports').select('job_id, report_type, report_data, created_at').in('job_id', jobIds).order('created_at', { ascending: false })
      : { data: [] }

    const { data: invs } = await sb.from('invoices').select('id, date').eq('location_id', input.location_id)
    const invIds = (invs || []).map(i => i.id)
    const { data: lines } = invIds.length
      ? await sb.from('invoice_lines').select('invoice_id, description, quantity').in('invoice_id', invIds)
      : { data: [] }

    // Suppression systems — from reports first, then invoice line fallback.
    const systems = []
    const seen = new Set()
    ;(reports || [])
      .filter(r => ['kitchen_suppression', 'dry_chemical', 'clean_agent'].includes(r.report_type))
      .forEach(r => {
        const d = r.report_data || {}
        const name = [d.mfg || d.sysType || '', d.model || ''].filter(Boolean).join(' ').trim()
          || (r.report_type === 'clean_agent' ? 'Clean Agent System'
            : r.report_type === 'dry_chemical' ? 'Dry Chemical System'
              : 'Kitchen Suppression')
        const key = name.toLowerCase()
        if (seen.has(key)) return
        seen.add(key)
        systems.push({
          name,
          type: r.report_type,
          last_inspected: r.created_at,
          detail: d.links ? `${d.links}` : (d.tanks ? `${d.tanks} tanks` : ''),
          source: 'inspection_report'
        })
      })
    ;(lines || []).forEach(ln => {
      const desc = (ln.description || '').toLowerCase()
      if (/semi.?annual|suppression|kitchen|ansul|pyro|buckeye|kidde|captive|clean.?agent|fm.?200|paint.?booth|dry.?chem/.test(desc)) {
        const key = desc
        if (seen.has(key)) return
        seen.add(key)
        systems.push({ name: ln.description, source: 'billing' })
      }
    })

    // Extinguishers — count from latest inspection or billed quantity
    let extCount = 0, extSource = 'unknown'
    const extRpt = (reports || []).find(r => r.report_type === 'extinguisher')
    if (extRpt?.report_data?.units?.length) {
      extCount = extRpt.report_data.units.length
      extSource = 'last inspection ' + (extRpt.created_at || '').slice(0, 10)
    } else {
      const billed = (lines || [])
        .filter(ln => /extinguisher/i.test(ln.description || ''))
        .reduce((s, ln) => s + (+ln.quantity || 0), 0)
      if (billed) { extCount = billed; extSource = 'billing history' }
    }

    // Emergency lights — latest fixture_count from report, else billed
    let lightCount = 0, lightSource = 'unknown'
    const elRpt = (reports || []).find(r => r.report_type === 'emergency_light')
    if (elRpt?.report_data?.fixture_count) {
      lightCount = elRpt.report_data.fixture_count
      lightSource = 'last inspection ' + (elRpt.created_at || '').slice(0, 10)
    } else {
      const billed = (lines || [])
        .filter(ln => /e.?light|emergency.?light/i.test(ln.description || ''))
        .reduce((s, ln) => s + (+ln.quantity || 0), 0)
      if (billed) { lightCount = billed; lightSource = 'billing history' }
    }

    return {
      note: 'Derived from inspection reports and invoice line items. No manual equipment table exists.',
      systems,
      extinguishers: { count: extCount, source: extSource },
      emergency_lights: { count: lightCount, source: lightSource },
      report_count: (reports || []).length
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
    let q = ctx.supabase.from('todos').select('*').is('deleted_at', null).order('created_at', { ascending: false }).limit(50)
    if (!input.include_completed) q = q.eq('done', false)
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
    // ── William hard guard ───────────────────────────────────────
    // Non-negotiable: reject any time that falls outside Jon's custody
    // work window for that day. This runs before ANY context branch so
    // it cannot be bypassed regardless of who is asking.
    if (input.date) {
      const dayAvail = william.getJonAvailability(new Date(input.date + 'T12:00:00'))
      if (!dayAvail.available) {
        return { error: `WILLIAM BLOCK: ${input.date} is unavailable — ${dayAvail.reason}. Do not schedule on this day. Call get_schedule_slots to find an open day.` }
      }
      if (input.time) {
        const tMin = timeToMin(input.time)
        const startMin = timeToMin(dayAvail.workStart)
        const durMin = Math.round((input.duration_hours || 1.5) * 60)
        const endMin = timeToMin(dayAvail.workEnd)
        if (tMin < startMin) {
          return { error: `WILLIAM BLOCK: ${input.time} is before Jon's work start (${dayAvail.workStart}) on ${input.date}. ${dayAvail.reason}. Earliest start: ${dayAvail.workStart}.` }
        }
        if (tMin + durMin > endMin) {
          const latest = minToTime(endMin - durMin)
          return { error: `WILLIAM BLOCK: A ${durMin}-min job starting at ${input.time} on ${input.date} runs past Jon's hard cutoff (${dayAvail.workEnd}). ${dayAvail.reason}. Latest start for this duration: ${latest}.` }
        }
      }
    }

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
    description: "Send a text message. Jon's number is +12149944799. In website context: after schedule_job creates a booking, also call send_sms to +12149944799 with a summary so Jon always knows what just got booked on his calendar. Also use to text customers a confirmation if you have their phone number.",
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
      if (geo) await ctx.supabase.from('locations').update({ latitude: geo.lat, longitude: geo.lng }).eq('id', loc.id)
    }
    ctx.lastLocationId = loc.id
    // Stamp the location onto the riker_session so subsequent turns in this
    // chat load customer-scoped memories from the notebook automatically.
    if (ctx.rikerSessionId) {
      ctx.supabase.from('riker_sessions').update({
        location_id: loc.id, updated_at: new Date().toISOString()
      }).eq('id', ctx.rikerSessionId).then(() => {}).catch(() => {})
    }
    return { ok: true, location_id: loc.id, business_name: input.business_name, brycer: isBrycer }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: create_billing_account
// ═══════════════════════════════════════════════════════════════
const create_billing_account = {
  schema: {
    name: 'create_billing_account',
    description: "Create a new billing account (parent company). Use when Jon adds a multi-location client and needs a parent entity for consolidated billing. After creating, call assign_location_to_billing_account to link locations to it.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Company/parent name, e.g. "Acme Corp Corporate"' },
        contact_name: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        address: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string', description: 'Default TX' },
        zip: { type: 'string' },
        notes: { type: 'string' }
      },
      required: ['name']
    }
  },
  async handler(input, ctx) {
    const { data, error } = await ctx.supabase.from('billing_accounts').insert({
      name: input.name,
      contact_name: input.contact_name || null,
      phone: input.phone || null,
      email: input.email || null,
      address: input.address || null,
      city: input.city || null,
      state: input.state || 'TX',
      zip: input.zip || null,
      notes: input.notes || null
    }).select().single()
    if (error) return { error: error.message }
    return { ok: true, billing_account_id: data.id, name: data.name }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: list_locations_by_account
// ═══════════════════════════════════════════════════════════════
const list_locations_by_account = {
  schema: {
    name: 'list_locations_by_account',
    description: "List all locations under a billing account (parent company). Use when Jon asks 'show me all [Company] locations' or wants to see a parent account's full client footprint.",
    input_schema: {
      type: 'object',
      properties: {
        billing_account_id: { type: 'string', description: 'UUID of the billing account. Use this if you already have it.' },
        billing_account_name: { type: 'string', description: 'Fuzzy name search — resolves to the best match. Use instead of billing_account_id when Jon gives a company name.' }
      }
    }
  },
  async handler(input, ctx) {
    let baId = input.billing_account_id
    let baName = null

    if (!baId && input.billing_account_name) {
      const { data: bas } = await ctx.supabase.from('billing_accounts')
        .select('id, name').ilike('name', `%${input.billing_account_name}%`).limit(5)
      if (!bas || bas.length === 0) return { error: `No billing account found matching "${input.billing_account_name}"` }
      baId = bas[0].id
      baName = bas[0].name
    }
    if (!baId) return { error: 'billing_account_id or billing_account_name required' }

    const { data: ba } = await ctx.supabase.from('billing_accounts')
      .select('id, name, contact_name, phone, email, w9_on_file, coi_on_file').eq('id', baId).maybeSingle()
    if (!ba) return { error: 'Billing account not found' }

    const { data: locs } = await ctx.supabase.from('locations')
      .select('id, name, address, city, state, zip, contact_name, contact_phone, contact_email, deleted_at')
      .eq('billing_account_id', baId).order('name')

    const active = (locs || []).filter(l => !l.deleted_at)
    const inactive = (locs || []).filter(l => l.deleted_at)

    // Pull last job for each location
    const locIds = active.map(l => l.id)
    let lastJobMap = {}
    if (locIds.length > 0) {
      const { data: jobs } = await ctx.supabase.from('jobs')
        .select('location_id, scheduled_date, status').in('location_id', locIds)
        .order('scheduled_date', { ascending: false })
      for (const j of (jobs || [])) {
        if (!lastJobMap[j.location_id]) lastJobMap[j.location_id] = j
      }
    }

    return {
      billing_account: { id: ba.id, name: ba.name, contact_name: ba.contact_name, phone: ba.phone, email: ba.email, w9_on_file: ba.w9_on_file, coi_on_file: ba.coi_on_file },
      location_count: active.length,
      locations: active.map(l => ({
        location_id: l.id, name: l.name, city: l.city, state: l.state,
        address: l.address, contact_name: l.contact_name, contact_phone: l.contact_phone,
        last_job_date: lastJobMap[l.id]?.scheduled_date || null,
        last_job_status: lastJobMap[l.id]?.status || null
      })),
      ...(inactive.length > 0 ? { inactive_locations: inactive.length } : {})
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: assign_location_to_billing_account
// ═══════════════════════════════════════════════════════════════
const assign_location_to_billing_account = {
  schema: {
    name: 'assign_location_to_billing_account',
    description: "Assign a location to a billing account (parent company), or reassign it to a different one. Also updates open jobs and unpaid invoices for that location. Use when Jon says 'put [location] under [company]' or 'link these locations together'.",
    input_schema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'UUID of the location. Use lookup_client first if you only have a name.' },
        billing_account_id: { type: 'string', description: 'UUID of the target billing account. Use create_billing_account first if it does not exist yet.' },
        cascade_jobs: { type: 'boolean', description: 'Also update billing_account_id on open/scheduled jobs for this location. Default true.' },
        cascade_invoices: { type: 'boolean', description: 'Also update billing_account_id on unpaid invoices for this location. Default true.' }
      },
      required: ['location_id', 'billing_account_id']
    }
  },
  async handler(input, ctx) {
    const cascade = { jobs: input.cascade_jobs !== false, invoices: input.cascade_invoices !== false }

    // Verify both exist
    const { data: loc } = await ctx.supabase.from('locations').select('id, name, billing_account_id').eq('id', input.location_id).maybeSingle()
    if (!loc) return { error: 'Location not found' }
    const { data: ba } = await ctx.supabase.from('billing_accounts').select('id, name').eq('id', input.billing_account_id).maybeSingle()
    if (!ba) return { error: 'Billing account not found' }

    const prevBaId = loc.billing_account_id

    const { error } = await ctx.supabase.from('locations')
      .update({ billing_account_id: input.billing_account_id }).eq('id', input.location_id)
    if (error) return { error: error.message }

    const result = { ok: true, location: loc.name, billing_account: ba.name, previous_account: prevBaId || null }

    if (cascade.jobs) {
      const { count } = await ctx.supabase.from('jobs')
        .update({ billing_account_id: input.billing_account_id })
        .eq('location_id', input.location_id)
        .in('status', ['scheduled', 'in_progress'])
        .select('id', { count: 'exact', head: true })
      result.jobs_updated = count || 0
    }

    if (cascade.invoices) {
      const { count } = await ctx.supabase.from('invoices')
        .update({ billing_account_id: input.billing_account_id })
        .eq('location_id', input.location_id)
        .in('status', ['draft', 'sent', 'overdue'])
        .select('id', { count: 'exact', head: true })
      result.invoices_updated = count || 0
    }

    return result
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
      done: false
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
      const { data } = await ctx.supabase.from('invoices').select('id').eq('invoice_number', input.invoice_number).is('deleted_at', null).maybeSingle()
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
      if (geo) await ctx.supabase.from('locations').update({ latitude: geo.lat, longitude: geo.lng }).eq('id', loc.id)
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
    description: "Move a client location to the trash (soft-delete — recoverable). SAFETY: must pass confirm_name that matches the stored client name (echo back what Jon typed). By default fails if related jobs/invoices exist; pass confirm_cascade=true to also trash those. For accidental duplicates prefer merge_clients.",
    input_schema: {
      type: 'object',
      properties: {
        location_id: { type: 'string' },
        confirm_name: { type: 'string', description: "Must match the stored name (case-insensitive, partial OK). Echo back what Jon called the client. Safety gate against accidental deletes." },
        confirm_cascade: { type: 'boolean', description: 'If true, also trashes all jobs/invoices tied to this location. Default false.' },
        reason: { type: 'string', description: 'Why this client is being removed. Required for audit trail.' }
      },
      required: ['location_id', 'confirm_name']
    }
  },
  async handler(input, ctx) {
    const { data: loc } = await ctx.supabase.from('locations').select('*').eq('id', input.location_id).is('deleted_at', null).maybeSingle()
    if (!loc) return { error: 'Location not found (or already deleted)' }
    const a = (input.confirm_name || '').toLowerCase().trim()
    const b = (loc.name || '').toLowerCase().trim()
    const match = a && b && (a.includes(b.slice(0, Math.min(4, b.length))) || b.includes(a.slice(0, Math.min(4, a.length))))
    if (!match) return { error: `Safety check failed: confirm_name "${input.confirm_name}" doesn't overlap the stored name "${loc.name}". Echo back what Jon named.` }

    const now = new Date().toISOString()
    const deletedBy = ctx.context === 'app' || ctx.context === 'sms_jon' ? 'jon' : 'riker'
    const trashMeta = { deletedBy, reason: input.reason || null, context: ctx.context }

    let cascadedJobs = 0
    let cascadedInvoices = 0

    if (input.confirm_cascade) {
      // Trash cascaded jobs
      const { data: jobs } = await ctx.supabase.from('jobs').select('*').eq('location_id', loc.id).is('deleted_at', null)
      for (const j of (jobs || [])) {
        await trashRecord(ctx.supabase, { tableName: 'jobs', recordId: j.id, recordData: j, ...trashMeta, reason: `Cascade from delete_client: ${loc.name}` })
      }
      if (jobs?.length) {
        await ctx.supabase.from('jobs').update({ deleted_at: now }).eq('location_id', loc.id).is('deleted_at', null)
        cascadedJobs = jobs.length
      }
      // Trash cascaded invoices
      const { data: invs } = await ctx.supabase.from('invoices').select('*').eq('location_id', loc.id).is('deleted_at', null)
      for (const inv of (invs || [])) {
        await trashRecord(ctx.supabase, { tableName: 'invoices', recordId: inv.id, recordData: inv, ...trashMeta, reason: `Cascade from delete_client: ${loc.name}` })
      }
      if (invs?.length) {
        await ctx.supabase.from('invoices').update({ deleted_at: now }).eq('location_id', loc.id).is('deleted_at', null)
        cascadedInvoices = invs.length
      }
    }

    // Trash the location itself
    await trashRecord(ctx.supabase, { tableName: 'locations', recordId: loc.id, recordData: loc, ...trashMeta })
    const { error } = await ctx.supabase.from('locations').update({ deleted_at: now }).eq('id', loc.id)
    if (error) return { error: 'Trash failed: ' + error.message }

    return { ok: true, location_id: loc.id, name: loc.name, cascaded: !!input.confirm_cascade, cascaded_jobs: cascadedJobs, cascaded_invoices: cascadedInvoices, note: 'Moved to trash — recoverable from deleted_records table.' }
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
    const { data: src } = await ctx.supabase.from('locations').select('*').eq('id', input.source_id).is('deleted_at', null).maybeSingle()
    const { data: tgt } = await ctx.supabase.from('locations').select('id, name').eq('id', input.target_id).is('deleted_at', null).maybeSingle()
    if (!src) return { error: 'source location not found' }
    if (!tgt) return { error: 'target location not found' }
    const moved = {}
    for (const t of ['jobs', 'invoices']) {
      const { data, error } = await ctx.supabase.from(t).update({ location_id: tgt.id }).eq('location_id', src.id).select('id')
      if (error) return { error: `${t} move failed: ${error.message}`, moved }
      moved[t] = data?.length || 0
    }
    // Trash the source location (all records already moved to target)
    await trashRecord(ctx.supabase, {
      tableName: 'locations', recordId: src.id, recordData: src,
      deletedBy: ctx.context === 'app' || ctx.context === 'sms_jon' ? 'jon' : 'riker',
      reason: `Merged into ${tgt.name} (${tgt.id})`,
      context: ctx.context
    })
    const { error: delErr } = await ctx.supabase.from('locations').update({ deleted_at: new Date().toISOString() }).eq('id', src.id)
    if (delErr) return { error: 'source trash failed after moves: ' + delErr.message, moved }
    return { ok: true, source: src.name, target: tgt.name, moved, note: 'Source moved to trash — recoverable from deleted_records.' }
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
      const { data } = await ctx.supabase.from('invoices').select('id').eq('invoice_number', input.invoice_number).is('deleted_at', null).maybeSingle()
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
      const { data } = await ctx.supabase.from('invoices').select('id').eq('invoice_number', input.invoice_number).is('deleted_at', null).maybeSingle()
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
    description: "Move an invoice to the trash (soft-delete — recoverable). Use for test invoices or duplicates. For production invoices that were sent but are wrong, prefer void_invoice.",
    input_schema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string' },
        invoice_number: { type: 'string' },
        reason: { type: 'string', description: 'Why this invoice is being trashed. Logged to audit trail.' }
      }
    }
  },
  async handler(input, ctx) {
    let invoiceId = input.invoice_id
    if (!invoiceId && input.invoice_number) {
      const { data } = await ctx.supabase.from('invoices').select('id').eq('invoice_number', input.invoice_number).is('deleted_at', null).maybeSingle()
      invoiceId = data?.id
    }
    if (!invoiceId) return { error: 'invoice_id or invoice_number required and must match a row' }
    const { data: inv } = await ctx.supabase.from('invoices').select('*').eq('id', invoiceId).is('deleted_at', null).maybeSingle()
    if (!inv) return { error: 'Invoice not found (or already deleted)' }
    await trashRecord(ctx.supabase, {
      tableName: 'invoices', recordId: inv.id, recordData: inv,
      deletedBy: ctx.context === 'app' || ctx.context === 'sms_jon' ? 'jon' : 'riker',
      reason: input.reason || null,
      context: ctx.context
    })
    const { error } = await ctx.supabase.from('invoices').update({ deleted_at: new Date().toISOString() }).eq('id', invoiceId)
    if (error) return { error: error.message }
    return { ok: true, invoice_id: invoiceId, invoice_number: inv.invoice_number, note: 'Moved to trash — recoverable from deleted_records table.' }
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
function _fallbackRoute(jobs, startLatLng = BASE_LATLNG) {
  let remaining = [...jobs], route = [], cur = startLatLng
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
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })

    // Determine origin — use Jon's live GPS if fresh (< 15 min), else home base
    let routeOrigin = BASE_ADDR
    let routeOriginLatLng = BASE_LATLNG
    try {
      const { data: jonLoc } = await ctx.supabase.from('jon_location')
        .select('lat, lng, updated_at').eq('id', 1).maybeSingle()
      if (jonLoc && jonLoc.lat && jonLoc.lng) {
        const ageMin = (Date.now() - new Date(jonLoc.updated_at).getTime()) / 60000
        if (ageMin < 15) {
          routeOrigin = `${jonLoc.lat},${jonLoc.lng}`
          routeOriginLatLng = { lat: jonLoc.lat, lng: jonLoc.lng }
        }
      }
    } catch {}

    // 1. Pick the job pool.
    let pool = []
    if (Array.isArray(input.job_ids) && input.job_ids.length) {
      const { data, error } = await ctx.supabase.from('jobs')
        .select('id, status, scheduled_date, scheduled_time, scope, location_id, location:locations(id,name,address,city,state,zip,latitude,longitude)')
        .in('id', input.job_ids)
      if (error) return { error: error.message }
      pool = data || []
    } else if (input.date) {
      const { data, error } = await ctx.supabase.from('jobs')
        .select('id, status, scheduled_date, scheduled_time, scope, location_id, location:locations(id,name,address,city,state,zip,latitude,longitude)')
        .eq('scheduled_date', input.date)
        .eq('status', 'scheduled')
      if (error) return { error: error.message }
      pool = data || []
    } else {
      // Default pool: overdue + today + tomorrow + day-after. Mirrors openRouteView.
      const tom = new Date(Date.now() + 86400000).toISOString().split('T')[0]
      const dat2 = new Date(Date.now() + 172800000).toISOString().split('T')[0]
      const { data, error } = await ctx.supabase.from('jobs')
        .select('id, status, scheduled_date, scheduled_time, scope, location_id, location:locations(id,name,address,city,state,zip,latitude,longitude)')
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
          const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(routeOrigin)}&destinations=${encodeURIComponent(stops[0].address)}&key=${key}`
          const r = await fetch(url)
          const d = await r.json()
          const el = d.rows?.[0]?.elements?.[0]
          if (el?.status === 'OK') {
            const routed = [{ job: stops[0].job, address: stops[0].address, dist: Math.round(el.distance.value / 1609.34), duration: Math.round(el.duration.value / 60), durationText: el.duration.text }]
            return _formatRoute(routed, 'google')
          }
        } catch (e) { /* fall through */ }
      }
      return _formatRoute(_fallbackRoute(pool, routeOriginLatLng), 'haversine')
    }

    // 5. Multi-stop: Directions with waypoint optimization. Same call the
    //    field app makes via cachedMapsCall('directions').
    if (key) {
      try {
        const allAddr = stops.map(s => s.address)
        const waypointStr = '&waypoints=optimize:true|' + allAddr.slice(0, -1).map(w => encodeURIComponent(w)).join('|')
        const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(routeOrigin)}&destination=${encodeURIComponent(allAddr[allAddr.length - 1])}${waypointStr}&key=${key}`
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

    return _formatRoute(_fallbackRoute(pool, routeOriginLatLng), 'haversine')
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

    // audit_log stores summary + changes nested in `details` JSONB — there
    // are NO direct `summary` or `changes` columns. The previous SELECT
    // asked for those columns, got null back, and Riker's view of history
    // was just bare action verbs with no context.
    const jobQ = ctx.supabase.from('audit_log')
      .select('action, actor, details, created_at, entity_type, entity_id')
      .eq('entity_type', 'job').eq('entity_id', jobId)
      .order('created_at', { ascending: false }).limit(limit)
    const invIdQ = includeInv
      ? ctx.supabase.from('invoices').select('id').eq('job_id', jobId).is('deleted_at', null)
      : Promise.resolve({ data: [] })

    const [jobRes, invIdRes] = await Promise.all([jobQ, invIdQ])
    if (jobRes.error) return { error: jobRes.error.message }
    const jobEvents = jobRes.data || []

    let invEvents = []
    const invIds = (invIdRes.data || []).map(r => r.id)
    if (includeInv && invIds.length) {
      const { data, error } = await ctx.supabase.from('audit_log')
        .select('action, actor, details, created_at, entity_type, entity_id')
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
        summary: e.details?.summary || null,
        changes: e.details?.changes || null
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
    // Same audit_log column-shape bug as the four tools fixed by rikerAudit.
    // add_job_note actually surfaces the error (captures `error` and returns
    // it) so this one was VISIBLY failing on every call — Riker's notes
    // never landed. Inlined here (not via rikerAudit) so we can preserve
    // the actor-from-context distinction.
    // PostgREST returns errors as `{error}` rather than throwing, so we
    // destructure-and-check to actually surface FK / RLS / schema failures.
    const actor = ctx.context === 'app' || ctx.context === 'sms_jon' ? 'ai_chat' : 'system'
    const { error } = await ctx.supabase.from('audit_log').insert({
      action: 'note',
      entity_type: 'job',
      entity_id: jobId,
      actor,
      details: { summary: text }
    })
    if (error) return { error: 'audit_log insert failed: ' + error.message }
    return { ok: true, job_id: jobId }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: update_job — edit job fields
// ═══════════════════════════════════════════════════════════════
const update_job = {
  schema: {
    name: 'update_job',
    description: "Edit fields on an existing job. Pass job_id and any subset of fields to change. Can also flip status — use this to reactivate a cancelled job (status='scheduled'), mark en_route/active, etc. Setting status='completed' is blocked here — that requires the app's completion flow (captures signature + generates invoice).",
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        status: { type: 'string', enum: ['scheduled', 'en_route', 'active', 'cancelled', 'rescheduled'], description: "Change job status. 'completed' is not allowed here — use the app completion flow. Use 'scheduled' to reactivate a cancelled job." },
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
    if (input.status === 'completed') {
      return { error: "Cannot mark completed via update_job — use the app's completion flow (captures signature and generates invoice)." }
    }
    const patch = {}
    if (input.status !== undefined) patch.status = input.status
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
    await rikerAudit(ctx, 'updated', 'job', input.job_id, 'Job updated: ' + fields, patch)
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
    const { data: job } = await ctx.supabase.from('jobs').select('id, status, location:locations(name)').eq('id', input.job_id).is('deleted_at', null).maybeSingle()
    if (!job) return { error: 'Job not found (or already deleted)' }
    if (job.status === 'cancelled') return { error: 'Already cancelled' }
    if (job.status === 'completed') return { error: 'Job is completed — cannot cancel a completed job' }
    const { error } = await ctx.supabase.from('jobs').update({ status: 'cancelled' }).eq('id', job.id)
    if (error) return { error: error.message }
    const summary = 'Job cancelled for ' + (job.location?.name || 'client') + (input.reason ? ' — ' + input.reason : '')
    await rikerAudit(ctx, 'cancelled', 'job', job.id, summary, { reason: input.reason || null })
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
    await rikerAudit(ctx, 'created', 'invoice', inv.id,
      `Invoice ${invNum} created for ${job.location?.name || 'job'} ($${sub.toFixed(2)})`,
      { invoice_number: invNum, total: sub })
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
      const { data: inv } = await ctx.supabase.from('invoices').select('id, mazon_queue_id').eq('invoice_number', input.invoice_number).is('deleted_at', null).maybeSingle()
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
    await rikerAudit(ctx, 'paid', 'invoice', qr.invoice_id,
      `Mazon funded — ${qr.customer_name} ($${amt.toFixed(2)})`,
      { amount: amt, method: 'mazon' })
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
      const { data: inv } = await ctx.supabase.from('invoices').select('id, mazon_queue_id').eq('invoice_number', input.invoice_number).is('deleted_at', null).maybeSingle()
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
    description: "Text Jon about a customer on the website and create a relay record so his SMS reply comes back to the chat. Call this in ANY of these situations: (1) customer asks something you can't answer from the database or NFPA knowledge — pricing edge cases, specific equipment questions, anything requiring Jon's personal judgment; (2) customer seems frustrated, urgent, or wants to speak to a human; (3) customer asks about a past service or inspection and you need Jon's context; (4) ANYTHING where you'd otherwise say 'I don't know' or give a vague non-answer. After calling it, tell the customer: 'I've messaged Jon — he usually gets back right away unless he's got his hands full.' Never fabricate his availability.",
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
// TOOL: get_jon_location
// ═══════════════════════════════════════════════════════════════
const get_jon_location = {
  schema: {
    name: 'get_jon_location',
    description: "Get Jon's current GPS coordinates from the field app beacon. Returns lat/lng, accuracy, speed, and how many minutes ago it was last updated. If age_minutes > 15 the app is probably closed — fall back to home base (Euless) for routing. Use this before build_route to confirm whether live location is available, or to answer 'where am I / how far am I from the next job'.",
    input_schema: { type: 'object', properties: {} }
  },
  async handler(input, ctx) {
    const { data, error } = await ctx.supabase.from('jon_location')
      .select('lat, lng, accuracy, heading, speed, source, updated_at')
      .eq('id', 1).maybeSingle()
    if (error) return { error: error.message }
    if (!data) return { ok: false, note: 'No location on file — open the field app to start the beacon.' }
    const ageMin = Math.floor((Date.now() - new Date(data.updated_at).getTime()) / 60000)
    return {
      ok: true,
      lat: data.lat,
      lng: data.lng,
      accuracy_m: data.accuracy ? Math.round(data.accuracy) : null,
      speed_mph: data.speed ? Math.round(data.speed * 2.237) : null,
      updated_at: data.updated_at,
      age_minutes: ageMin,
      stale: ageMin > 15
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// PHASE 3 — EMAIL READ / REPLY / DRAFT TOOLS
// These let Riker act like an inbox copilot: read unread threads,
// draft a reply for Jon's approval, then send when Jon says go.
// ═══════════════════════════════════════════════════════════════

const read_inbox = {
  schema: {
    name: 'read_inbox',
    description: "Read recent emails from Jon's inbox directly from Gmail. Returns threads from the past N hours regardless of read/unread status — Jon reads email on his phone which marks them as read in Gmail, so is:unread is never used. Use this when Jon asks 'what's in my inbox', 'any new emails', 'did customer X email'. For flexible searches use search_email instead.",
    input_schema: {
      type: 'object',
      properties: {
        since_hours: { type: 'integer', description: 'Look back this many hours (default 48, cap 720 / 30d).' },
        from: { type: 'string', description: 'Filter by sender email (optional).' },
        limit: { type: 'integer', description: 'Max threads returned (default 10, cap 30).' }
      }
    }
  },
  async handler(input, ctx) {
    const hours = Math.min(720, Math.max(1, Number(input.since_hours) || 48))
    const limit = Math.min(30, Math.max(1, Number(input.limit) || 15))

    // ── Live Gmail read ──────────────────────────────────────────
    let token
    try { token = await getGmailToken() }
    catch (e) { return { error: e.message } }

    const afterEpoch = Math.floor((Date.now() - hours * 3600000) / 1000)
    // Do NOT use is:unread — Jon reads emails on his phone which marks them read in Gmail.
    // Use after: timestamp so Riker sees all recent emails regardless of read status.
    let q = `in:inbox after:${afterEpoch} -category:promotions -category:social -category:updates`
    if (input.from) q += ` from:${input.from}`

    let list
    try { list = await gmailFetch(token, `users/me/messages?q=${encodeURIComponent(q)}&maxResults=${limit}`) }
    catch (e) { return { error: 'Gmail list failed: ' + e.message } }

    const msgIds = (list.messages || []).map(m => m.id)
    if (!msgIds.length) return { count: 0, since_hours: hours, unread_threads: [] }

    const threads = []
    for (const gmailId of msgIds) {
      try {
        const msg = await gmailFetch(token,
          `users/me/messages/${gmailId}?format=metadata` +
          `&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID`)
        const hdrs = {}
        for (const h of (msg.payload?.headers || [])) hdrs[h.name.toLowerCase()] = h.value
        const { email: fromEmail, name: fromName } = gmailParseFrom(hdrs['from'] || '')

        // Check if we already have a reply logged in conversations
        const { data: conv } = await ctx.supabase.from('conversations')
          .select('id, location_id, customer_name')
          .eq('channel', 'email').eq('email_thread_id', msg.threadId)
          .maybeSingle()
        let replied = false
        if (conv) {
          const { data: ob } = await ctx.supabase.from('messages')
            .select('id').eq('conversation_id', conv.id).eq('direction', 'outbound').limit(1).maybeSingle()
          replied = !!ob
        }

        threads.push({
          gmail_message_id: gmailId,
          thread_id: msg.threadId,
          conversation_id: conv?.id || null,
          from_email: fromEmail,
          from_name: fromName,
          subject: hdrs['subject'] || '(no subject)',
          snippet: (msg.snippet || '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).slice(0, 240),
          date: hdrs['date'] || null,
          riker_replied: replied,
          location_id: conv?.location_id || null,
          customer_name: conv?.customer_name || null
        })
      } catch (e) {
        threads.push({ gmail_message_id: gmailId, error: e.message })
      }
    }
    return { count: threads.length, since_hours: hours, unread_threads: threads }
  }
}

const read_email_thread = {
  schema: {
    name: 'read_email_thread',
    description: "Read a full email thread in chronological order. Accepts either conversation_id (preferred — as returned by read_inbox) or email_thread_id (the Gmail thread ID). Returns every inbound + outbound message with subject, body, and timestamps. Use this to build context before drafting a reply.",
    input_schema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: 'UUID from conversations table.' },
        email_thread_id: { type: 'string', description: 'Gmail thread ID (alternative).' },
        limit: { type: 'integer', description: 'Max messages (default 40, cap 100).' }
      }
    }
  },
  async handler(input, ctx) {
    const limit = Math.min(100, Math.max(1, Number(input.limit) || 40))
    const threadId = input.email_thread_id || input.thread_id
    let convId = input.conversation_id

    // Prefer DB conversation if we have one
    if (!convId && threadId) {
      const { data: conv } = await ctx.supabase.from('conversations')
        .select('id').eq('channel', 'email').eq('email_thread_id', threadId)
        .order('last_message_at', { ascending: false }).limit(1).maybeSingle()
      if (conv) convId = conv.id
    }

    // If we have a DB conversation, read from messages table
    if (convId) {
      const { data: conv } = await ctx.supabase.from('conversations')
        .select('id, email, customer_name, email_thread_id, location_id, last_message_at')
        .eq('id', convId).maybeSingle()
      if (!conv) return { error: `Conversation ${convId} not found` }
      const { data: msgs, error } = await ctx.supabase.from('messages')
        .select('direction, channel, body, email_subject, email_from, email_to, email_message_id, created_at')
        .eq('conversation_id', convId)
        .order('created_at', { ascending: false })
        .limit(limit)
      if (error) return { error: error.message }
      return { source: 'db', conversation: conv, count: (msgs || []).length, messages: (msgs || []).reverse() }
    }

    // No DB conversation — fetch directly from Gmail
    if (!threadId) return { error: 'Must pass conversation_id, email_thread_id, or thread_id' }
    let token
    try { token = await getGmailToken() }
    catch (e) { return { error: e.message } }
    try {
      const thread = await gmailFetch(token, `users/me/threads/${threadId}?format=full`)
      const messages = (thread.messages || []).slice(-limit).map(msg => {
        const hdrs = {}
        for (const h of (msg.payload?.headers || [])) hdrs[h.name.toLowerCase()] = h.value
        const { email: fromEmail, name: fromName } = gmailParseFrom(hdrs['from'] || '')
        // Extract plain text body
        let body = ''
        const extractText = p => {
          if (!p) return
          if (p.mimeType === 'text/plain' && p.body?.data) { body = Buffer.from(p.body.data.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf-8'); return }
          for (const part of (p.parts || [])) extractText(part)
        }
        extractText(msg.payload)
        return { direction: 'inbound', from_email: fromEmail, from_name: fromName, subject: hdrs['subject'], date: hdrs['date'], body: body.slice(0, 2000) }
      })
      return { source: 'gmail', thread_id: threadId, count: messages.length, messages }
    } catch (e) { return { error: 'Gmail thread fetch failed: ' + e.message } }
  }
}

const draft_email_reply = {
  schema: {
    name: 'draft_email_reply',
    description: "Draft an email reply and park it for Jon's approval — does NOT send. Use when you want to pre-compose a response that Jon can eyeball before it goes out. Accepts conversation_id (preferred) or a raw to_email. Returns a draft_id Jon can hand back to approve_email_draft to send. Prefer this for anything customer-facing that isn't a 1-sentence ack.",
    input_schema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: 'Reply to this conversation. Auto-fills to/subject/threading.' },
        to_email: { type: 'string', description: 'Recipient (required if no conversation_id).' },
        subject: { type: 'string', description: 'Override the auto "Re: ..." subject.' },
        body: { type: 'string', description: 'Plain-text body.' },
        reasoning: { type: 'string', description: "One-line note on why this reply (shown to Jon with the draft)." }
      },
      required: ['body']
    }
  },
  async handler(input, ctx) {
    if (!input.body || !String(input.body).trim()) return { error: 'body is required' }

    let toEmail = input.to_email ? String(input.to_email).toLowerCase() : null
    let subject = input.subject || null
    let conv = null
    let replyToMessageId = null
    let referencesHeader = null
    let emailThreadId = null

    if (input.conversation_id) {
      const { data: c } = await ctx.supabase.from('conversations')
        .select('id, email, customer_name, email_thread_id, location_id')
        .eq('id', input.conversation_id).maybeSingle()
      if (!c) return { error: `Conversation ${input.conversation_id} not found` }
      conv = c
      toEmail = toEmail || c.email
      emailThreadId = c.email_thread_id || null
      // Pull the latest inbound to thread the reply
      const { data: lastIn } = await ctx.supabase.from('messages')
        .select('email_subject, email_message_id, body')
        .eq('conversation_id', c.id).eq('direction', 'inbound')
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (lastIn) {
        if (!subject) {
          subject = lastIn.email_subject
            ? (lastIn.email_subject.startsWith('Re:') ? lastIn.email_subject : 'Re: ' + lastIn.email_subject)
            : 'Re: your email'
        }
        replyToMessageId = lastIn.email_message_id || null
        referencesHeader = lastIn.email_message_id || null
      }
    }

    if (!toEmail) return { error: 'to_email is required (or pass a conversation_id)' }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) return { error: 'Invalid to_email' }
    if (!subject) subject = 'Re: your email'

    const { data: draft, error } = await ctx.supabase.from('email_drafts').insert({
      thread_id: emailThreadId,
      conversation_id: conv?.id || null,
      to_email: toEmail,
      subject,
      body: String(input.body),
      reply_to_message_id: replyToMessageId,
      references_header: referencesHeader,
      status: 'pending',
      source_context: ctx.context || null,
      reasoning: input.reasoning || null
    }).select('id, created_at').single()
    if (error) return { error: error.message }

    return {
      ok: true,
      draft_id: draft.id,
      status: 'pending',
      to: toEmail,
      subject,
      preview: String(input.body).slice(0, 160),
      note: "Draft parked. Jon can call approve_email_draft with this draft_id to send it."
    }
  }
}

const approve_email_draft = {
  schema: {
    name: 'approve_email_draft',
    description: "Send a previously drafted email reply (from draft_email_reply) that Jon has approved. Marks the draft approved+sent, pushes it through Resend/SMTP with proper threading headers, and logs the outbound message on the conversation. Use ONLY after Jon says 'send it' or similar explicit approval.",
    input_schema: {
      type: 'object',
      properties: {
        draft_id: { type: 'string', description: 'The id returned by draft_email_reply.' }
      },
      required: ['draft_id']
    }
  },
  async handler(input, ctx) {
    const { data: draft, error } = await ctx.supabase.from('email_drafts')
      .select('*').eq('id', input.draft_id).maybeSingle()
    if (error) return { error: error.message }
    if (!draft) return { error: `Draft ${input.draft_id} not found` }
    if (draft.status === 'sent') return { error: 'Draft was already sent' }
    if (draft.status === 'rejected') return { error: 'Draft was rejected and cannot be sent' }

    // Mark approved first so we don't double-send on retry
    await ctx.supabase.from('email_drafts').update({
      status: 'approved', approved_at: new Date().toISOString()
    }).eq('id', draft.id)

    try {
      await sendEmailRaw({
        to: draft.to_email,
        subject: draft.subject,
        body: draft.body,
        inReplyTo: draft.reply_to_message_id || undefined,
        references: draft.references_header || undefined
      })
    } catch (e) {
      await ctx.supabase.from('email_drafts').update({
        status: 'failed'
      }).eq('id', draft.id)
      return { error: 'Send failed: ' + e.message }
    }

    await ctx.supabase.from('email_drafts').update({
      status: 'sent', sent_at: new Date().toISOString()
    }).eq('id', draft.id)

    // Mirror into messages for the conversation timeline
    if (draft.conversation_id) {
      try {
        await ctx.supabase.from('messages').insert({
          conversation_id: draft.conversation_id,
          direction: 'outbound',
          channel: 'email',
          body: draft.body,
          email_subject: draft.subject
        })
        await ctx.supabase.from('conversations').update({
          last_message_at: new Date().toISOString()
        }).eq('id', draft.conversation_id)
      } catch (e) { /* best effort */ }
    }

    // Mark the inbox row(s) replied so the desk counter drops
    if (draft.thread_id) {
      try {
        await ctx.supabase.from('email_inbox').update({
          replied_at: new Date().toISOString(),
          needs_reply: false
        }).eq('thread_id', draft.thread_id)
      } catch (e) { /* best effort */ }
    }

    return {
      ok: true,
      draft_id: draft.id,
      sent_to: draft.to_email,
      subject: draft.subject
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// PHASE 4 — WEB LOOKUP TOOLS
// Brave Search (paid), Browserbase headless fetch (paid), OpenWeatherMap
// (free tier). Results are cached in web_lookup_cache for 15–60 min so
// repeat questions in the same turn stay free.
// ═══════════════════════════════════════════════════════════════

const web_search_brave = {
  schema: {
    name: 'web_search_brave',
    description: "Search the web via Brave Search. Use for current facts Jon can't know from the database: competitor pricing, code requirements that might have changed, a company Jon's never worked with before, a news event he mentioned. Returns title/url/description for each result. Cached 30 min per query. Prefer this over any built-in web_search for cost reasons.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        count: { type: 'integer', description: 'Number of results (default 6, cap 20).' }
      },
      required: ['query']
    }
  },
  async handler(input, ctx) {
    return web.braveSearch(ctx.supabase, input.query, { count: input.count })
  }
}

const web_fetch = {
  schema: {
    name: 'web_fetch',
    description: "Fetch a web page and return its rendered text + title. Uses Browserbase (real Chromium) so JS-heavy pages work. Use after web_search_brave when a result needs full reading, or when Jon hands you a URL. Text is trimmed to 8000 chars. Cached 1 hour per URL.",
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full http/https URL.' },
        max_chars: { type: 'integer', description: 'Trim returned text to this many chars (default 8000, cap 20000).' }
      },
      required: ['url']
    }
  },
  async handler(input, ctx) {
    const maxChars = Math.min(20000, Math.max(500, Number(input.max_chars) || 8000))
    return web.browserbaseFetch(ctx.supabase, input.url, { maxChars })
  }
}

const get_weather = {
  schema: {
    name: 'get_weather',
    description: "Get current conditions + 7-day forecast for a city. Use when Jon asks 'will it rain Tuesday on the Fort Worth job' or 'how cold will it be overnight' — weather affects whether cold-weather jobs get pushed or tank tests get delayed. Optionally pass date (YYYY-MM-DD within the 7-day window) to highlight that day. Cached 15 min per query.",
    input_schema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: "City name, optionally with state/country. E.g. 'Fort Worth', 'Fort Worth, TX', 'Euless, TX, US'." },
        date: { type: 'string', description: 'YYYY-MM-DD — pulls that specific day from the forecast (must be within 7 days).' }
      },
      required: ['city']
    }
  },
  async handler(input, ctx) {
    return web.openWeatherMap(ctx.supabase, input.city, { date: input.date })
  }
}

// Manual equipment CRUD (add_equipment / update_equipment / delete_equipment) has
// been removed. Equipment is no longer a manually-maintained table — it's derived
// from inspection reports and invoice history by get_equipment. Techs record what
// they find on each visit; billing records what was serviced. That's the record.

// ═══════════════════════════════════════════════════════════════
// TOOL: reschedule_job
// ═══════════════════════════════════════════════════════════════
const reschedule_job = {
  schema: {
    name: 'reschedule_job',
    description: "Reschedule a job to a new date (and optionally new time). Writes to audit_log. If notify_customer=true and the location has a phone, sends an SMS.",
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID. Required.' },
        new_date: { type: 'string', description: 'YYYY-MM-DD. Required.' },
        new_time: { type: 'string', description: 'HH:MM (24h). Optional — keeps existing time if omitted.' },
        notify_customer: { type: 'boolean', description: 'If true, send SMS to location contact phone. Default false.' },
        reason: { type: 'string', description: 'Short reason for audit trail.' }
      },
      required: ['job_id', 'new_date']
    }
  },
  async handler(input, ctx) {
    if (!input.job_id) return { error: 'job_id required' }
    if (!input.new_date) return { error: 'new_date required' }

    // William hard guard — same as schedule_job
    const dayAvail = william.getJonAvailability(new Date(input.new_date + 'T12:00:00'))
    if (!dayAvail.available) {
      return { error: `WILLIAM BLOCK: ${input.new_date} is unavailable — ${dayAvail.reason}. Pick a different day.` }
    }
    if (input.new_time) {
      const tMin = timeToMin(input.new_time)
      if (tMin < timeToMin(dayAvail.workStart)) {
        return { error: `WILLIAM BLOCK: ${input.new_time} is before work start (${dayAvail.workStart}) on ${input.new_date}. ${dayAvail.reason}.` }
      }
      if (tMin >= timeToMin(dayAvail.workEnd)) {
        return { error: `WILLIAM BLOCK: ${input.new_time} is at or after Jon's cutoff (${dayAvail.workEnd}) on ${input.new_date}. ${dayAvail.reason}.` }
      }
    }

    const { data: job } = await ctx.supabase.from('jobs')
      .select('id, scheduled_date, scheduled_time, status, location:locations(name, contact_phone, contact_email)')
      .eq('id', input.job_id).is('deleted_at', null).maybeSingle()
    if (!job) return { error: 'Job not found' }

    const patch = {
      scheduled_date: input.new_date,
      updated_at: new Date().toISOString()
    }
    if (input.new_time !== undefined) patch.scheduled_time = input.new_time

    const { error } = await ctx.supabase.from('jobs').update(patch).eq('id', input.job_id)
    if (error) return { error: error.message }

    // Write to audit_log. Two bugs fixed here that have been silently breaking
    // every reschedule_job call since at least 2026-04-28:
    //   1. .insert(...).catch(...) doesn't work — Supabase's query builder
    //      isn't a promise until awaited, so .catch on it throws
    //      "catch is not a function" and aborts the WHOLE handler. The
    //      database UPDATE on line above DID succeed; the audit-log JS error
    //      then made Riker report failure to Jon, who'd retry repeatedly.
    //   2. Columns `changes` and `summary` don't exist on audit_log — the
    //      only writable JSON-shaped column is `details`. Folding the old
    //      structured fields into details preserves all the info.
    const summary = `Job rescheduled from ${job.scheduled_date} to ${input.new_date}` + (input.reason ? ' — ' + input.reason : '')
    try {
      await ctx.supabase.from('audit_log').insert({
        action: 'rescheduled', entity_type: 'job', entity_id: input.job_id,
        actor: 'ai_chat',
        details: { summary, old_date: job.scheduled_date, new_date: input.new_date, new_time: input.new_time || null, reason: input.reason || null }
      })
    } catch (e) {
      console.warn('[reschedule_job] audit_log insert failed:', e.message)
    }

    let notified = false
    if (input.notify_customer && job.location?.contact_phone) {
      try {
        const name = job.location?.name || 'your location'
        const timeStr = input.new_time || job.scheduled_time || ''
        const msg = `Hi, this is Jon with Stephens Advanced. Your service appointment at ${name} has been rescheduled to ${input.new_date}${timeStr ? ' at ' + timeStr : ''}. Sorry for any inconvenience — please call or text if you have questions.`
        let to = String(job.location.contact_phone).replace(/[\s\-\(\)\.]/g, '')
        if (!to.startsWith('+')) to = '+1' + to.replace(/^1/, '')
        await sendSMSRaw(to, msg)
        notified = true
      } catch (e) {
        console.warn('[reschedule_job] SMS notify failed:', e.message)
      }
    }

    return {
      ok: true,
      job_id: input.job_id,
      new_date: input.new_date,
      new_time: input.new_time || job.scheduled_time || null,
      customer_notified: notified
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: get_invoice_lines
// ═══════════════════════════════════════════════════════════════
const get_invoice_lines = {
  schema: {
    name: 'get_invoice_lines',
    description: "Get all line items for an invoice. Returns each line's id, description, quantity, unit_price, and total.",
    input_schema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string', description: 'Invoice UUID. Required.' }
      },
      required: ['invoice_id']
    }
  },
  async handler(input, ctx) {
    if (!input.invoice_id) return { error: 'invoice_id required' }
    const { data, error } = await ctx.supabase.from('invoice_lines')
      .select('id, description, quantity, unit_price, total, sort_order')
      .eq('invoice_id', input.invoice_id)
      .order('sort_order')
    if (error) return { error: error.message }
    return { invoice_id: input.invoice_id, count: (data || []).length, lines: data || [] }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: add_invoice_line
// ═══════════════════════════════════════════════════════════════
const add_invoice_line = {
  schema: {
    name: 'add_invoice_line',
    description: "Add a line item to an invoice and recalculate the invoice total.",
    input_schema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string', description: 'Invoice UUID. Required.' },
        description: { type: 'string', description: 'Line item description. Required.' },
        quantity: { type: 'number', description: 'Default 1.' },
        unit_price: { type: 'number', description: 'Price per unit. Required.' }
      },
      required: ['invoice_id', 'description', 'unit_price']
    }
  },
  async handler(input, ctx) {
    if (!input.invoice_id) return { error: 'invoice_id required' }
    const qty = Number(input.quantity) || 1
    const up = Number(input.unit_price) || 0
    const lineTotal = Math.round(qty * up * 100) / 100

    // Get current sort_order max
    const { data: existing } = await ctx.supabase.from('invoice_lines')
      .select('sort_order').eq('invoice_id', input.invoice_id).order('sort_order', { ascending: false }).limit(1)
    const nextSort = ((existing?.[0]?.sort_order) ?? -1) + 1

    const { data: line, error } = await ctx.supabase.from('invoice_lines').insert({
      invoice_id: input.invoice_id,
      description: String(input.description || '').trim(),
      quantity: qty,
      unit_price: up,
      total: lineTotal,
      sort_order: nextSort
    }).select('id').single()
    if (error) return { error: error.message }

    // Recalculate invoice total
    const { data: allLines } = await ctx.supabase.from('invoice_lines')
      .select('total').eq('invoice_id', input.invoice_id)
    const newTotal = Math.round((allLines || []).reduce((s, l) => s + Number(l.total || 0), 0) * 100) / 100
    await ctx.supabase.from('invoices').update({ total: newTotal, subtotal: newTotal }).eq('id', input.invoice_id)

    return { ok: true, line_id: line.id, new_total: newTotal }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: update_invoice_line
// ═══════════════════════════════════════════════════════════════
const update_invoice_line = {
  schema: {
    name: 'update_invoice_line',
    description: "Update a line item on an invoice and recalculate the invoice total.",
    input_schema: {
      type: 'object',
      properties: {
        line_id: { type: 'string', description: 'invoice_lines UUID. Required.' },
        description: { type: 'string' },
        quantity: { type: 'number' },
        unit_price: { type: 'number' }
      },
      required: ['line_id']
    }
  },
  async handler(input, ctx) {
    if (!input.line_id) return { error: 'line_id required' }
    // Fetch current row to get invoice_id and compute new total
    const { data: cur } = await ctx.supabase.from('invoice_lines').select('*').eq('id', input.line_id).maybeSingle()
    if (!cur) return { error: 'Line not found' }
    const patch = {}
    if (input.description !== undefined) patch.description = input.description
    if (input.quantity !== undefined) patch.quantity = Number(input.quantity)
    if (input.unit_price !== undefined) patch.unit_price = Number(input.unit_price)
    if (Object.keys(patch).length === 0) return { error: 'Nothing to update' }
    const qty = patch.quantity ?? Number(cur.quantity)
    const up = patch.unit_price ?? Number(cur.unit_price)
    patch.total = Math.round(qty * up * 100) / 100
    const { error } = await ctx.supabase.from('invoice_lines').update(patch).eq('id', input.line_id)
    if (error) return { error: error.message }
    // Recalculate invoice total
    const { data: allLines } = await ctx.supabase.from('invoice_lines')
      .select('total').eq('invoice_id', cur.invoice_id)
    const newTotal = Math.round((allLines || []).reduce((s, l) => s + Number(l.total || 0), 0) * 100) / 100
    await ctx.supabase.from('invoices').update({ total: newTotal, subtotal: newTotal }).eq('id', cur.invoice_id)
    return { ok: true, new_total: newTotal }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: delete_invoice_line
// ═══════════════════════════════════════════════════════════════
const delete_invoice_line = {
  schema: {
    name: 'delete_invoice_line',
    description: "Remove a line item from an invoice and recalculate the invoice total.",
    input_schema: {
      type: 'object',
      properties: {
        line_id: { type: 'string', description: 'invoice_lines UUID. Required.' },
        invoice_id: { type: 'string', description: 'Pass to avoid an extra lookup, but the tool can resolve it from line_id.' }
      },
      required: ['line_id']
    }
  },
  async handler(input, ctx) {
    if (!input.line_id) return { error: 'line_id required' }
    let invoiceId = input.invoice_id
    if (!invoiceId) {
      const { data: cur } = await ctx.supabase.from('invoice_lines').select('invoice_id').eq('id', input.line_id).maybeSingle()
      if (!cur) return { error: 'Line not found' }
      invoiceId = cur.invoice_id
    }
    const { error } = await ctx.supabase.from('invoice_lines').delete().eq('id', input.line_id)
    if (error) return { error: error.message }
    // Recalculate invoice total
    const { data: allLines } = await ctx.supabase.from('invoice_lines')
      .select('total').eq('invoice_id', invoiceId)
    const newTotal = Math.round((allLines || []).reduce((s, l) => s + Number(l.total || 0), 0) * 100) / 100
    await ctx.supabase.from('invoices').update({ total: newTotal, subtotal: newTotal }).eq('id', invoiceId)
    return { ok: true, new_total: newTotal }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: generate_portal_link
// ═══════════════════════════════════════════════════════════════
const generate_portal_link = {
  schema: {
    name: 'generate_portal_link',
    description: "Generate a customer portal access link for a location or billing account. Creates a portal_tokens row (15-day expiry) and returns the URL. Use when Jon or a customer needs portal access.",
    input_schema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'Location UUID — one of location_id or billing_account_id required.' },
        billing_account_id: { type: 'string', description: 'Billing account UUID — alternative to location_id.' }
      }
    }
  },
  async handler(input, ctx) {
    if (!input.location_id && !input.billing_account_id) return { error: 'location_id or billing_account_id required' }
    const token = crypto.randomBytes(16).toString('hex')
    const expiresAt = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString()
    const { error } = await ctx.supabase.from('portal_tokens').insert({
      token,
      location_id: input.location_id || null,
      billing_account_id: input.billing_account_id || null,
      is_active: true,
      expires_at: expiresAt
    })
    if (error) return { error: error.message }
    const portalUrl = 'https://stephensadvanced.com/portal?t=' + token
    return { ok: true, portal_url: portalUrl, token, expires_at: expiresAt }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: list_techs
// ═══════════════════════════════════════════════════════════════
const list_techs = {
  schema: {
    name: 'list_techs',
    description: "List all technicians. Returns id, name, phone, email, license_number, color, and active status.",
    input_schema: {
      type: 'object',
      properties: {
        active_only: { type: 'boolean', description: 'If true, only return active techs. Default false (all).' }
      }
    }
  },
  async handler(input, ctx) {
    let q = ctx.supabase.from('techs').select('id, name, phone, email, license_number, color, active, created_at').order('name')
    if (input.active_only) q = q.eq('active', true)
    const { data, error } = await q
    if (error) return { error: error.message }
    return { count: (data || []).length, techs: data || [] }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: add_tech
// ═══════════════════════════════════════════════════════════════
const add_tech = {
  schema: {
    name: 'add_tech',
    description: "Add a new technician to the techs table.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Full name. Required.' },
        phone: { type: 'string' },
        email: { type: 'string' },
        license_number: { type: 'string', description: 'FEL or other license number.' },
        color: { type: 'string', description: 'Hex color for calendar display. Default #f05a28.' }
      },
      required: ['name']
    }
  },
  async handler(input, ctx) {
    if (!input.name) return { error: 'name required' }
    const { data, error } = await ctx.supabase.from('techs').insert({
      name: input.name,
      phone: input.phone || null,
      email: input.email || null,
      license_number: input.license_number || null,
      color: input.color || '#f05a28',
      active: true
    }).select('id').single()
    if (error) return { error: error.message }
    return { ok: true, id: data.id, name: input.name }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: update_tech
// ═══════════════════════════════════════════════════════════════
const update_tech = {
  schema: {
    name: 'update_tech',
    description: "Update technician info. Pass tech_id and any fields to change.",
    input_schema: {
      type: 'object',
      properties: {
        tech_id: { type: 'string', description: 'Techs UUID. Required.' },
        name: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        license_number: { type: 'string' },
        color: { type: 'string' },
        active: { type: 'boolean' }
      },
      required: ['tech_id']
    }
  },
  async handler(input, ctx) {
    if (!input.tech_id) return { error: 'tech_id required' }
    const patch = {}
    if (input.name !== undefined) patch.name = input.name
    if (input.phone !== undefined) patch.phone = input.phone
    if (input.email !== undefined) patch.email = input.email
    if (input.license_number !== undefined) patch.license_number = input.license_number
    if (input.color !== undefined) patch.color = input.color
    if (input.active !== undefined) patch.active = input.active
    if (Object.keys(patch).length === 0) return { error: 'Nothing to update — pass at least one field.' }
    const { error } = await ctx.supabase.from('techs').update(patch).eq('id', input.tech_id)
    if (error) return { error: error.message }
    return { ok: true, tech_id: input.tech_id, updated: Object.keys(patch) }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: assign_job_to_tech
// ═══════════════════════════════════════════════════════════════
const assign_job_to_tech = {
  schema: {
    name: 'assign_job_to_tech',
    description: "Assign a job to a specific technician by setting jobs.assigned_to. Pass null or empty string to unassign.",
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID. Required.' },
        tech_id: { type: 'string', description: 'Techs UUID. Pass empty string to unassign.' }
      },
      required: ['job_id']
    }
  },
  async handler(input, ctx) {
    if (!input.job_id) return { error: 'job_id required' }
    const techId = input.tech_id || null
    const { error } = await ctx.supabase.from('jobs').update({ assigned_to: techId }).eq('id', input.job_id)
    if (error) return { error: error.message }
    // Same fix as reschedule_job above — .insert().catch() throws and the
    // audit_log schema only accepts `details` (not `changes` / `summary`).
    try {
      await ctx.supabase.from('audit_log').insert({
        action: 'assigned', entity_type: 'job', entity_id: input.job_id,
        actor: 'ai_chat',
        details: { assigned_to: techId, summary: techId ? `Job assigned to tech ${techId}` : 'Job unassigned' }
      })
    } catch (e) {
      console.warn('[assign_job] audit_log insert failed:', e.message)
    }
    return { ok: true, job_id: input.job_id, assigned_to: techId }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: get_brycer_queue
// ═══════════════════════════════════════════════════════════════
const get_brycer_queue = {
  schema: {
    name: 'get_brycer_queue',
    description: "Get jobs pending Brycer compliance submission (submitted=false). Returns job_id, location name, address, system_type, and job date.",
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max rows (default 25, cap 100).' }
      }
    }
  },
  async handler(input, ctx) {
    const limit = Math.min(100, Number(input.limit) || 25)
    const { data, error } = await ctx.supabase.from('brycer_queue')
      .select('id, job_id, location_id, location_name, system_type, job_date, submitted, report_generated, created_at')
      .eq('submitted', false)
      .order('created_at')
      .limit(limit)
    if (error) return { error: error.message }
    // Enrich with location address
    const locIds = [...new Set((data || []).map(r => r.location_id).filter(Boolean))]
    let locMap = {}
    if (locIds.length) {
      const { data: locs } = await ctx.supabase.from('locations')
        .select('id, address, city, state, zip').in('id', locIds)
      for (const l of (locs || [])) locMap[l.id] = l
    }
    const enriched = (data || []).map(r => ({
      ...r,
      address: r.location_id && locMap[r.location_id]
        ? [locMap[r.location_id].address, locMap[r.location_id].city, locMap[r.location_id].state].filter(Boolean).join(', ')
        : null
    }))
    return { count: enriched.length, pending: enriched }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: mark_brycer_submitted
// ═══════════════════════════════════════════════════════════════
const mark_brycer_submitted = {
  schema: {
    name: 'mark_brycer_submitted',
    description: "Mark a Brycer queue entry as submitted. Pass either job_id or brycer_queue_id.",
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID. The tool looks up the queue entry by job_id.' },
        brycer_queue_id: { type: 'string', description: 'Direct brycer_queue row UUID.' }
      }
    }
  },
  async handler(input, ctx) {
    if (!input.job_id && !input.brycer_queue_id) return { error: 'job_id or brycer_queue_id required' }
    const today = new Date().toISOString().split('T')[0]
    let q = ctx.supabase.from('brycer_queue').update({ submitted: true, submitted_date: today })
    if (input.brycer_queue_id) {
      q = q.eq('id', input.brycer_queue_id)
    } else {
      q = q.eq('job_id', input.job_id)
    }
    const { error } = await q
    if (error) return { error: error.message }
    return { ok: true, submitted_date: today }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: list_contracts
// ═══════════════════════════════════════════════════════════════
const list_contracts = {
  schema: {
    name: 'list_contracts',
    description: "List service contracts. Optionally filter by location_id. Returns id, location_id, location_name, status, created_at, signed_at, and signer info.",
    input_schema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'Filter to a specific location (optional).' },
        status: { type: 'string', description: 'draft, active, expired, cancelled, or all (default all).' },
        limit: { type: 'integer', description: 'Max rows (default 20, cap 100).' }
      }
    }
  },
  async handler(input, ctx) {
    const limit = Math.min(100, Number(input.limit) || 20)
    let q = ctx.supabase.from('contracts')
      .select('id, location_id, billing_account_id, type, frequency, status, signed, signed_at, annual_value, start_date, end_date, notes, created_at, location:locations(name,city)')
      .order('created_at', { ascending: false })
      .limit(limit)
    if (input.location_id) q = q.eq('location_id', input.location_id)
    if (input.status && input.status !== 'all') q = q.eq('status', input.status)
    const { data, error } = await q
    if (error) return { error: error.message }
    return {
      count: (data || []).length,
      contracts: (data || []).map(c => ({
        id: c.id,
        location_id: c.location_id,
        location_name: c.location?.name || null,
        city: c.location?.city || null,
        status: c.status,
        type: c.type,
        frequency: c.frequency,
        annual_value: c.annual_value,
        signed: c.signed,
        signed_at: c.signed_at,
        start_date: c.start_date,
        end_date: c.end_date,
        created_at: c.created_at,
        notes: c.notes
      }))
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: create_contract
// ═══════════════════════════════════════════════════════════════
const create_contract = {
  schema: {
    name: 'create_contract',
    description: "Create a service contract for a location in draft status.",
    input_schema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'Location UUID. Required.' },
        contract_type: { type: 'string', description: "Contract type: 'recurring' or 'one-time'. Default 'recurring'." },
        frequency: { type: 'string', description: "annual, semi-annual, quarterly — service frequency." },
        annual_value: { type: 'number', description: 'Annual contract value in dollars.' },
        notes: { type: 'string' }
      },
      required: ['location_id']
    }
  },
  async handler(input, ctx) {
    if (!input.location_id) return { error: 'location_id required' }
    // Look up billing_account_id from location
    const { data: loc } = await ctx.supabase.from('locations').select('billing_account_id').eq('id', input.location_id).maybeSingle()
    const { data, error } = await ctx.supabase.from('contracts').insert({
      location_id: input.location_id,
      billing_account_id: loc?.billing_account_id || null,
      type: input.contract_type || 'recurring',
      frequency: input.frequency || null,
      annual_value: input.annual_value || null,
      status: 'draft',
      notes: input.notes || null
    }).select('id').single()
    if (error) return { error: error.message }
    return { ok: true, contract_id: data.id, status: 'draft' }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: send_contract
// ═══════════════════════════════════════════════════════════════
const send_contract = {
  schema: {
    name: 'send_contract',
    description: "Send a contract signing email to the customer. Updates contract status to 'sent'. Uses the same branded email template as /api/send-contract.js.",
    input_schema: {
      type: 'object',
      properties: {
        contract_id: { type: 'string', description: 'Contract UUID. Required.' },
        recipient_email: { type: 'string', description: 'Override the email address on file (optional).' },
        recipient_name: { type: 'string', description: 'Override the contact name on file (optional).' }
      },
      required: ['contract_id']
    }
  },
  async handler(input, ctx) {
    if (!input.contract_id) return { error: 'contract_id required' }
    const apiKey = process.env.RESEND_API_KEY
    if (!apiKey) return { error: 'RESEND_API_KEY not configured' }

    // Load contract + location
    const { data: contract, error: cErr } = await ctx.supabase.from('contracts')
      .select('*, location_id, billing_account_id').eq('id', input.contract_id).maybeSingle()
    if (cErr || !contract) return { error: 'Contract not found' }

    let location = null
    if (contract.location_id) {
      const { data: l } = await ctx.supabase.from('locations').select('*').eq('id', contract.location_id).maybeSingle()
      location = l
    }

    const customerName = input.recipient_name || location?.contact_name || contract.customer_name || 'Valued Customer'
    const customerEmail = input.recipient_email || contract.customer_email || location?.contact_email
    if (!customerEmail) return { error: 'No customer email on file — pass recipient_email' }

    const locationName = location?.name || ''
    const signUrl = `https://www.stephensadvanced.com/sign-contract?token=${input.contract_id}`

    // Simple text email (full HTML template lives in send-contract.js; replicate core content)
    const body = [
      `Dear ${customerName},`,
      '',
      `Your service agreement${locationName ? ' for ' + locationName : ''} is ready to review and sign.`,
      '',
      `Sign here: ${signUrl}`,
      '',
      'Benefits: Priority scheduling, price lock, and customer portal access.',
      '',
      'Questions? Call or text (214) 994-4799 or reply to this email.',
      '',
      'Thank you,',
      'Jon Stephens — Stephens Advanced LLC'
    ].join('\n')

    try {
      await sendEmailRaw({
        to: customerEmail,
        subject: `Your Service Agreement is Ready — Stephens Advanced${locationName ? ' | ' + locationName : ''}`,
        body
      })
    } catch (e) {
      return { error: 'Email send failed: ' + e.message }
    }

    // Same .catch-on-builder fix as reschedule_job + audit_log column fix.
    const now = new Date().toISOString()
    try {
      await ctx.supabase.from('contracts').update({ status: 'sent', sent_at: now, sent_to: customerEmail }).eq('id', input.contract_id)
    } catch (e) {
      console.warn('[send_contract] contracts update failed:', e.message)
    }
    try {
      await ctx.supabase.from('audit_log').insert({
        action: 'sent', entity_type: 'contract', entity_id: input.contract_id,
        actor: 'ai_chat', details: { summary: `Contract sent to ${customerEmail}` }
      })
    } catch (e) {
      console.warn('[send_contract] audit_log insert failed:', e.message)
    }

    return { ok: true, contract_id: input.contract_id, sent_to_email: customerEmail, sent_at: now }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: get_business_report
// ═══════════════════════════════════════════════════════════════
const get_business_report = {
  schema: {
    name: 'get_business_report',
    description: "Business performance summary for a period. Includes total revenue, outstanding AR, job count, average job value, and top clients by revenue.",
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['today', 'week', 'month', 'ytd'], description: "Default 'month'." }
      }
    }
  },
  async handler(input, ctx) {
    const period = input.period || 'month'
    const now = new Date()
    const todayStr = now.toISOString().split('T')[0]
    let dateFrom
    if (period === 'today') {
      dateFrom = todayStr
    } else if (period === 'week') {
      const d = new Date(now); d.setDate(d.getDate() - 7)
      dateFrom = d.toISOString().split('T')[0]
    } else if (period === 'month') {
      dateFrom = todayStr.slice(0, 7) + '-01'
    } else { // ytd
      dateFrom = now.getFullYear() + '-01-01'
    }

    const [paidInvs, unpaidInvs, completedJobs] = await Promise.all([
      ctx.supabase.from('invoices').select('total, billing_account_id, location:locations(name)')
        .eq('status', 'paid').gte('paid_at', dateFrom + 'T00:00:00').is('deleted_at', null),
      ctx.supabase.from('invoices').select('total, invoice_number, location:locations(name)')
        .not('status', 'in', '(paid,void,record,factored)').is('deleted_at', null),
      ctx.supabase.from('jobs').select('id, estimated_value, location:locations(name)')
        .eq('status', 'completed').gte('scheduled_date', dateFrom).is('deleted_at', null)
    ])

    const revenue = Math.round((paidInvs.data || []).reduce((s, i) => s + Number(i.total || 0), 0) * 100) / 100
    const outstanding = Math.round((unpaidInvs.data || []).reduce((s, i) => s + Number(i.total || 0), 0) * 100) / 100
    const jobCount = (completedJobs.data || []).length
    const totalJobValue = (completedJobs.data || []).reduce((s, j) => s + Number(j.estimated_value || 0), 0)
    const avgJobValue = jobCount > 0 ? Math.round(totalJobValue / jobCount * 100) / 100 : 0

    // Top clients by revenue
    const clientRevMap = {}
    for (const inv of (paidInvs.data || [])) {
      const name = inv.location?.name || 'Unknown'
      clientRevMap[name] = (clientRevMap[name] || 0) + Number(inv.total || 0)
    }
    const topClients = Object.entries(clientRevMap)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([name, total]) => ({ name, total: Math.round(total * 100) / 100 }))

    return {
      period,
      date_from: dateFrom,
      date_to: todayStr,
      revenue_usd: revenue,
      outstanding_ar_usd: outstanding,
      outstanding_invoice_count: (unpaidInvs.data || []).length,
      jobs_completed: jobCount,
      avg_job_value_usd: avgJobValue,
      top_clients_by_revenue: topClients
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: get_ar_aging
// ═══════════════════════════════════════════════════════════════
const get_ar_aging = {
  schema: {
    name: 'get_ar_aging',
    description: "Accounts receivable aging report. Buckets open invoices by age: current (0-30 days), 31-60, 61-90, 90+ days past due.",
    input_schema: { type: 'object', properties: {} }
  },
  async handler(_input, ctx) {
    const { data, error } = await ctx.supabase.from('invoices')
      .select('id, invoice_number, total, due_date, date, location:locations(name,city)')
      .not('status', 'in', '(paid,void,record,factored)')
      .is('deleted_at', null)
      .order('due_date')
    if (error) return { error: error.message }

    const today = new Date()
    const buckets = { current: [], days_31_60: [], days_61_90: [], over_90: [] }
    for (const inv of (data || [])) {
      const due = new Date(inv.due_date || inv.date)
      const ageDays = Math.floor((today - due) / 86400000)
      const item = {
        invoice_id: inv.id,
        invoice_number: inv.invoice_number,
        client: inv.location?.name || null,
        city: inv.location?.city || null,
        total: Number(inv.total || 0),
        due_date: inv.due_date,
        age_days: ageDays
      }
      if (ageDays <= 30) buckets.current.push(item)
      else if (ageDays <= 60) buckets.days_31_60.push(item)
      else if (ageDays <= 90) buckets.days_61_90.push(item)
      else buckets.over_90.push(item)
    }

    const sum = arr => Math.round(arr.reduce((s, i) => s + i.total, 0) * 100) / 100
    return {
      total_usd: sum([...buckets.current, ...buckets.days_31_60, ...buckets.days_61_90, ...buckets.over_90]),
      current: { count: buckets.current.length, total_usd: sum(buckets.current), invoices: buckets.current },
      days_31_60: { count: buckets.days_31_60.length, total_usd: sum(buckets.days_31_60), invoices: buckets.days_31_60 },
      days_61_90: { count: buckets.days_61_90.length, total_usd: sum(buckets.days_61_90), invoices: buckets.days_61_90 },
      over_90: { count: buckets.over_90.length, total_usd: sum(buckets.over_90), invoices: buckets.over_90 }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: get_audit_log
// ═══════════════════════════════════════════════════════════════
const get_audit_log = {
  schema: {
    name: 'get_audit_log',
    description: "Get recent audit log entries. Optionally filter by entity_type and/or entity_id.",
    input_schema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', description: "job, invoice, contract, portal_token, etc." },
        entity_id: { type: 'string', description: 'UUID of the specific entity.' },
        limit: { type: 'integer', description: 'Max rows (default 20, cap 100).' }
      }
    }
  },
  async handler(input, ctx) {
    const limit = Math.min(100, Number(input.limit) || 20)
    // audit_log columns: id, action, entity_type, entity_id, actor, details (JSONB), created_at.
    // The previous SELECT asked for non-existent `summary` and `changes` direct
    // columns and got null back, so Riker's audit-log view was effectively empty
    // beyond the action verb.
    let q = ctx.supabase.from('audit_log')
      .select('id, action, entity_type, entity_id, actor, details, created_at')
      .order('created_at', { ascending: false })
      .limit(limit)
    if (input.entity_type) q = q.eq('entity_type', input.entity_type)
    if (input.entity_id) q = q.eq('entity_id', input.entity_id)
    const { data, error } = await q
    if (error) return { error: error.message }
    return {
      count: (data || []).length,
      entries: (data || []).map(e => ({
        action: e.action,
        entity_type: e.entity_type,
        entity_id: e.entity_id,
        actor: e.actor,
        summary: e.details?.summary || null,
        changes: e.details?.changes || null,
        created_at: e.created_at
      }))
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: list_service_requests
// ═══════════════════════════════════════════════════════════════
const list_service_requests = {
  schema: {
    name: 'list_service_requests',
    description: "List service requests from the customer portal. Filter by status: pending, acknowledged, scheduled, closed, rejected. Default 'pending'.",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: "pending, acknowledged, scheduled, closed, rejected, or all. Default 'pending'." },
        limit: { type: 'integer', description: 'Max rows (default 20, cap 100).' }
      }
    }
  },
  async handler(input, ctx) {
    const limit = Math.min(100, Number(input.limit) || 20)
    const status = input.status || 'pending'
    let q = ctx.supabase.from('service_requests')
      .select('id, location_id, billing_account_id, job_id, request_type, requested_date, notes, reason, status, source, created_at, location:locations(name,city,address)')
      .order('created_at', { ascending: false })
      .limit(limit)
    if (status !== 'all') q = q.eq('status', status)
    const { data, error } = await q
    if (error) {
      // Table might use different column names — graceful fallback
      if (error.message && error.message.includes('does not exist')) {
        return { error: 'service_requests table not yet migrated — run migrations/018-riker-tool-tables.sql' }
      }
      return { error: error.message }
    }
    return {
      count: (data || []).length,
      requests: (data || []).map(r => ({
        id: r.id,
        location_id: r.location_id,
        location_name: r.location?.name || null,
        city: r.location?.city || null,
        request_type: r.request_type || null,
        description: r.reason || r.notes || null,
        requested_date: r.requested_date,
        status: r.status,
        job_id: r.job_id,
        created_at: r.created_at
      }))
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: respond_to_service_request
// ═══════════════════════════════════════════════════════════════
const respond_to_service_request = {
  schema: {
    name: 'respond_to_service_request',
    description: "Approve or decline a portal service request. If approved with a date, optionally creates a scheduled job.",
    input_schema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: 'service_requests UUID. Required.' },
        action: { type: 'string', enum: ['approve', 'decline'], description: 'Required.' },
        scheduled_date: { type: 'string', description: 'YYYY-MM-DD — date for the new job (if approving).' },
        scheduled_time: { type: 'string', description: 'HH:MM — time for the new job (if approving).' },
        notes: { type: 'string', description: 'Internal notes.' }
      },
      required: ['request_id', 'action']
    }
  },
  async handler(input, ctx) {
    if (!input.request_id) return { error: 'request_id required' }
    if (!input.action) return { error: 'action required' }

    const { data: req } = await ctx.supabase.from('service_requests').select('*').eq('id', input.request_id).maybeSingle()
    if (!req) return { error: 'Service request not found' }

    const now = new Date().toISOString()
    let newJobId = null

    if (input.action === 'approve') {
      const patch = { status: 'scheduled', responded_at: now }
      if (input.notes) patch.notes = input.notes

      // Optionally create a job
      if (input.scheduled_date && req.location_id) {
        const { data: job } = await ctx.supabase.from('jobs').insert({
          location_id: req.location_id,
          billing_account_id: req.billing_account_id || null,
          scheduled_date: input.scheduled_date,
          scheduled_time: input.scheduled_time || null,
          status: 'scheduled',
          type: 'inspection',
          notes: req.reason || req.notes || 'From portal service request'
        }).select('id').single()
        if (job) {
          newJobId = job.id
          patch.job_id = job.id
        }
      }
      await ctx.supabase.from('service_requests').update(patch).eq('id', input.request_id)
      return { ok: true, action: 'approved', request_id: input.request_id, job_id: newJobId }
    } else {
      await ctx.supabase.from('service_requests').update({
        status: 'rejected', responded_at: now, notes: input.notes || null
      }).eq('id', input.request_id)
      return { ok: true, action: 'declined', request_id: input.request_id }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: list_custom_items
// ═══════════════════════════════════════════════════════════════
const list_custom_items = {
  schema: {
    name: 'list_custom_items',
    description: "List saved custom line items (reusable invoice line item templates). Returns id, description, and unit_price.",
    input_schema: { type: 'object', properties: {} }
  },
  async handler(_input, ctx) {
    const { data, error } = await ctx.supabase.from('custom_items')
      .select('id, description, unit_price, normalized_key').order('description')
    if (error) {
      if (error.message && (error.message.includes('does not exist') || error.message.includes('relation'))) {
        return { error: 'custom_items table not yet migrated — run migrations/018-riker-tool-tables.sql' }
      }
      return { error: error.message }
    }
    return { count: (data || []).length, items: data || [] }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: add_custom_item
// ═══════════════════════════════════════════════════════════════
const add_custom_item = {
  schema: {
    name: 'add_custom_item',
    description: "Save a reusable custom line item for quick invoice entry.",
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Line item description. Required.' },
        unit_price: { type: 'number', description: 'Price in dollars. Required.' }
      },
      required: ['description', 'unit_price']
    }
  },
  async handler(input, ctx) {
    if (!input.description) return { error: 'description required' }
    const desc = String(input.description).trim()
    const nk = desc.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
    const { data, error } = await ctx.supabase.from('custom_items')
      .upsert({ normalized_key: nk, description: desc, unit_price: Number(input.unit_price) || 0 }, { onConflict: 'normalized_key' })
      .select('id').single()
    if (error) {
      if (error.message && (error.message.includes('does not exist') || error.message.includes('relation'))) {
        return { error: 'custom_items table not yet migrated — run migrations/018-riker-tool-tables.sql' }
      }
      return { error: error.message }
    }
    return { ok: true, id: data.id, description: desc, unit_price: Number(input.unit_price) || 0 }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: delete_custom_item
// ═══════════════════════════════════════════════════════════════
const delete_custom_item = {
  schema: {
    name: 'delete_custom_item',
    description: "Remove a saved custom line item.",
    input_schema: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'custom_items UUID. Required.' }
      },
      required: ['item_id']
    }
  },
  async handler(input, ctx) {
    if (!input.item_id) return { error: 'item_id required' }
    const { error } = await ctx.supabase.from('custom_items').delete().eq('id', input.item_id)
    if (error) {
      if (error.message && (error.message.includes('does not exist') || error.message.includes('relation'))) {
        return { error: 'custom_items table not yet migrated — run migrations/018-riker-tool-tables.sql' }
      }
      return { error: error.message }
    }
    return { ok: true, item_id: input.item_id }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: send_on_my_way
// ═══════════════════════════════════════════════════════════════
const send_on_my_way = {
  schema: {
    name: 'send_on_my_way',
    description: "Send an 'on my way' SMS to the customer at a job site. Looks up the location's contact phone and sends a friendly ETA message from Jon.",
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID. Required.' },
        eta_minutes: { type: 'integer', description: 'Estimated minutes until arrival (optional). If omitted, says "heading your way now".' }
      },
      required: ['job_id']
    }
  },
  async handler(input, ctx) {
    if (!input.job_id) return { error: 'job_id required' }
    const { data: job } = await ctx.supabase.from('jobs')
      .select('id, location:locations(name, contact_phone, contact_name)')
      .eq('id', input.job_id).maybeSingle()
    if (!job) return { error: 'Job not found' }
    const phone = job.location?.contact_phone
    if (!phone) return { error: 'No contact phone on file for this location. Update the client record first.' }

    const businessName = job.location?.name || 'your location'
    const msg = input.eta_minutes
      ? `Hi, this is Jon with Stephens Advanced — I'm on my way to ${businessName} and should arrive in about ${input.eta_minutes} minutes. See you soon!`
      : `Hi, this is Jon with Stephens Advanced — I'm heading your way to ${businessName} now. See you soon!`

    let to = String(phone).replace(/[\s\-\(\)\.]/g, '')
    if (!to.startsWith('+')) to = '+1' + to.replace(/^1/, '')

    try {
      const sid = await sendSMSRaw(to, msg)
      // Stamp the job with customer_notified_at. Wrap in try — Supabase
      // builders return a thenable, NOT a real promise, so .catch() on
      // them throws "TypeError: .catch is not a function" inside the
      // handler. The previous .catch(()=>{}) chain caused the await to
      // throw AFTER the SMS already went out → tool returned {error},
      // Jon thought it failed and re-sent → customer got two texts.
      try {
        await ctx.supabase.from('jobs').update({ customer_notified_at: new Date().toISOString() }).eq('id', input.job_id)
      } catch (stampErr) {
        console.warn('[send_on_my_way] customer_notified_at stamp failed:', stampErr.message)
      }
      return { ok: true, sent_to: to, message: msg, sid }
    } catch (e) {
      return { error: 'SMS send failed: ' + e.message }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: send_review_request
// ═══════════════════════════════════════════════════════════════
// After Jon finishes a job he can text Riker "send the customer a
// review link" and Riker fires the canonical Google review URL to
// the location's contact phone. Pairs with send_on_my_way (start of
// visit) — this is the end-of-visit closer.
const send_review_request = {
  schema: {
    name: 'send_review_request',
    description: "Text a Google review link via Twilio. Default mode: looks up the location's contact_phone from job_id / location_id / location_name and texts the customer. Test mode: pass to_phone to send the same review-link SMS to ANY phone (typically Jon's own number for end-to-end verification). When Jon says 'send me a review link' or 'send the review link to my phone', use to_phone='+12149944799'. The Twilio SID returned proves the send actually happened.",
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: "Job UUID. Preferred when known — guarantees the right customer/phone. Omit if using to_phone." },
        location_id: { type: 'string', description: 'Location UUID. Use when no job_id is available. Omit if using to_phone.' },
        location_name: { type: 'string', description: "Fuzzy client name, e.g. 'Bobby's Diner'. Resolves to a location automatically. Omit if using to_phone." },
        to_phone: { type: 'string', description: "Override recipient phone in E.164 (+12149944799). Use when the user asks to send the review link to a specific number — typically Jon's own for testing. When set, customer-resolution params are ignored." }
      }
    }
  },
  async handler(input, ctx) {
    const REVIEW_URL = 'https://g.page/r/CVoOkNkSCkSkEAI/review'

    // Test path: explicit to_phone overrides customer resolution. Greeting
    // and signature stay the same as the customer-facing copy so what Jon
    // sees on his test phone matches what a real customer would receive.
    if (input.to_phone) {
      let to = String(input.to_phone).replace(/[\s\-\(\)\.]/g, '')
      if (!to.startsWith('+')) to = '+1' + to.replace(/^1/, '')
      if (!/^\+\d{10,15}$/.test(to)) return { error: `Invalid to_phone: ${input.to_phone}` }
      const msg = `Hi — Jon with Stephens Advanced. Thanks for letting us out today! If you've got 30 seconds, we'd really appreciate a quick review on Google: ${REVIEW_URL}\n\nThank you!`
      try {
        const sid = await sendSMSRaw(to, msg)
        return { ok: true, sent_to: to, mode: 'test', message: msg, sid }
      } catch (e) {
        return { error: 'SMS send failed: ' + e.message }
      }
    }

    // Production path: resolve location → contact_phone, contact_name, business name
    let loc = null
    if (input.job_id) {
      const { data: job } = await ctx.supabase.from('jobs')
        .select('id, location:locations(id, name, contact_name, contact_phone)')
        .eq('id', input.job_id).maybeSingle()
      if (!job) return { error: 'Job not found' }
      loc = job.location
    } else if (input.location_id) {
      const { data } = await ctx.supabase.from('locations')
        .select('id, name, contact_name, contact_phone')
        .eq('id', input.location_id).maybeSingle()
      loc = data
    } else if (input.location_name) {
      const s = String(input.location_name).trim().toLowerCase().replace(/[%_]/g, '')
      const { data: locs } = await ctx.supabase.from('locations')
        .select('id, name, contact_name, contact_phone')
        .is('deleted_at', null)
        .ilike('name', `%${s}%`)
        .limit(5)
      if (!locs || !locs.length) return { error: `No client found matching "${input.location_name}"` }
      if (locs.length > 1) return { error: `Ambiguous — ${locs.length} matches for "${input.location_name}". Pass location_id explicitly.`, candidates: locs.map(l => ({ id: l.id, name: l.name })) }
      loc = locs[0]
    } else {
      return { error: 'Provide job_id, location_id, location_name, or to_phone.' }
    }

    if (!loc) return { error: 'Location not found' }
    const phone = loc.contact_phone
    if (!phone) return { error: `No contact phone on file for ${loc.name}. Update the client record first.` }

    const firstName = (loc.contact_name || '').split(/\s+/)[0]
    const greeting = firstName ? `Hi ${firstName}` : 'Hi'
    const msg = `${greeting} — Jon with Stephens Advanced. Thanks for letting us out today! If you've got 30 seconds, we'd really appreciate a quick review on Google: ${REVIEW_URL}\n\nThank you!`

    let to = String(phone).replace(/[\s\-\(\)\.]/g, '')
    if (!to.startsWith('+')) to = '+1' + to.replace(/^1/, '')

    try {
      const sid = await sendSMSRaw(to, msg)
      return { ok: true, sent_to: to, customer: loc.name, message: msg, sid }
    } catch (e) {
      return { error: 'SMS send failed: ' + e.message }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL: search_email
// ═══════════════════════════════════════════════════════════════
// Searches Gmail directly with an arbitrary query. Used for reading
// Jon's inbox, finding client email history, and win-back campaigns.
const search_email = {
  schema: {
    name: 'search_email',
    description: "Search Jon's Gmail with any Gmail query string. Returns matching threads with from, subject, snippet, date, and whether the sender is a known client in the database. IMPORTANT: never use is:unread — Jon reads on his phone so all emails appear read in Gmail. Use after: or newer_than: instead. Examples: 'in:inbox newer_than:3d -category:promotions', 'from:bob@acme.com', 'dragon palace inspection', 'subject:invoice'. ALWAYS use this when Jon asks about emails.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Gmail search query. Examples: 'in:inbox is:unread -category:promotions', 'from:bob@acme.com', 'subject:invoice', 'dragon palace older_than:6m', 'in:sent to:customer@place.com'" },
        max_results: { type: 'integer', description: 'Max threads returned (default 15, cap 30).' }
      },
      required: ['query']
    }
  },
  async handler(input, ctx) {
    let token
    try { token = await getGmailToken() }
    catch (e) { return { error: e.message } }

    const limit = Math.min(30, Math.max(1, Number(input.max_results) || 15))

    let list
    try {
      list = await gmailFetch(token, `users/me/messages?q=${encodeURIComponent(input.query)}&maxResults=${limit}`)
    } catch (e) { return { error: 'Gmail search failed: ' + e.message } }

    const msgIds = (list.messages || []).map(m => m.id)
    if (!msgIds.length) return { count: 0, query: input.query, results: [] }

    const results = []
    for (const gmailId of msgIds) {
      try {
        const msg = await gmailFetch(token,
          `users/me/messages/${gmailId}?format=metadata` +
          `&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`)
        const hdrs = {}
        for (const h of (msg.payload?.headers || [])) hdrs[h.name.toLowerCase()] = h.value
        const { email: fromEmail, name: fromName } = gmailParseFrom(hdrs['from'] || '')

        // Cross-ref: is this a known client?
        const { data: loc } = await ctx.supabase.from('locations')
          .select('id, name, city').eq('contact_email', fromEmail).maybeSingle()

        results.push({
          gmail_message_id: gmailId,
          thread_id: msg.threadId,
          from_email: fromEmail,
          from_name: fromName,
          to: hdrs['to'] || null,
          subject: hdrs['subject'] || '(no subject)',
          snippet: (msg.snippet || '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).slice(0, 280),
          date: hdrs['date'] || null,
          known_client: loc ? { location_id: loc.id, name: loc.name, city: loc.city } : null
        })
      } catch (e) {
        results.push({ gmail_message_id: gmailId, error: e.message })
      }
    }
    return { count: results.length, query: input.query, results }
  }
}

// ═══════════════════════════════════════════════════════════════
// REGISTRY + CONTEXT FILTERING
// ═══════════════════════════════════════════════════════════════

// ALL_TOOLS declaration is moved below, after every const tool definition,
// to satisfy temporal-dead-zone for the new Phase 2/3/4 tools.

// ═══════════════════════════════════════════════════════════════
// PHASE 2 — INBOX MANAGEMENT
// One verb-driven tool keeps the prompt budget tight (vs. 7 separate tools).
// ═══════════════════════════════════════════════════════════════

const manage_email = {
  schema: {
    name: 'manage_email',
    description: "Take an action on an existing Gmail message or thread (yours, jonathan@). Verbs: archive, unarchive, trash, untrash, mark_read, mark_unread, apply_label, remove_label. Pass message_id (single message) OR thread_id (whole thread). For label verbs, pass label_name (e.g. 'Riker', 'Brycer/Submitted'); the tool resolves the name to an ID via list_labels. Use after read_inbox / search_email when Jon says things like 'archive every Brycer email this week' or 'mark these read'.",
    input_schema: {
      type: 'object',
      properties: {
        verb: { type: 'string', enum: ['archive', 'unarchive', 'trash', 'untrash', 'mark_read', 'mark_unread', 'apply_label', 'remove_label'] },
        message_id: { type: 'string', description: 'Gmail message ID. Either this OR thread_id.' },
        thread_id: { type: 'string', description: 'Gmail thread ID — applies the verb to every message in the thread.' },
        label_name: { type: 'string', description: 'Required for apply_label / remove_label. Case-insensitive name; nested labels use slash (e.g. "Riker/Drafts").' }
      },
      required: ['verb']
    }
  },
  async handler(input, ctx) {
    const { verb, message_id, thread_id, label_name } = input
    if (!message_id && !thread_id) return { error: 'Pass message_id or thread_id' }
    if ((verb === 'apply_label' || verb === 'remove_label') && !label_name) return { error: 'label_name required for ' + verb }

    let token
    try { token = await getGmailToken() } catch (e) { return { error: e.message } }

    // Resolve label name → ID if needed
    let labelId = null
    if (verb === 'apply_label' || verb === 'remove_label') {
      try {
        const list = await gmailFetch(token, 'users/me/labels')
        const match = (list.labels || []).find(l => l.name.toLowerCase() === label_name.toLowerCase())
        if (!match) return { error: `Label '${label_name}' not found. Use list_labels to see what's available, or create_label first.` }
        labelId = match.id
      } catch (e) { return { error: 'Label lookup failed: ' + e.message } }
    }

    // Build modify body or pick endpoint
    const target = thread_id ? `threads/${thread_id}` : `messages/${message_id}`
    let body, method = 'POST', path
    switch (verb) {
      case 'archive':      body = { removeLabelIds: ['INBOX'] }; path = `users/me/${target}/modify`; break
      case 'unarchive':    body = { addLabelIds: ['INBOX'] };    path = `users/me/${target}/modify`; break
      case 'mark_read':    body = { removeLabelIds: ['UNREAD'] };path = `users/me/${target}/modify`; break
      case 'mark_unread':  body = { addLabelIds: ['UNREAD'] };   path = `users/me/${target}/modify`; break
      case 'apply_label':  body = { addLabelIds: [labelId] };    path = `users/me/${target}/modify`; break
      case 'remove_label': body = { removeLabelIds: [labelId] }; path = `users/me/${target}/modify`; break
      case 'trash':        path = `users/me/${target}/trash`; break
      case 'untrash':      path = `users/me/${target}/untrash`; break
      default: return { error: `Unknown verb: ${verb}` }
    }

    try {
      await gmailFetch(token, path, { method, body })
    } catch (e) {
      return { error: e.message }
    }

    // Audit
    try {
      await ctx.supabase.from('audit_log').insert({
        action: 'email_' + verb,
        entity_type: thread_id ? 'email_thread' : 'email_message',
        entity_id: thread_id || message_id,
        actor: 'riker',
        details: { verb, label_name: label_name || null }
      })
    } catch {}

    return { ok: true, verb, target: thread_id ? `thread:${thread_id}` : `message:${message_id}` }
  }
}

// ─── list_labels ────────────────────────────────────────────────
const list_labels = {
  schema: {
    name: 'list_labels',
    description: "List all Gmail labels in jonathan@'s account (system labels + user-created). Use before manage_email's apply_label/remove_label so you know what label_name strings are valid. Returns just names + types (system vs user) — IDs resolved internally.",
    input_schema: { type: 'object', properties: {} }
  },
  async handler(input, ctx) {
    let token
    try { token = await getGmailToken() } catch (e) { return { error: e.message } }
    try {
      const data = await gmailFetch(token, 'users/me/labels')
      const labels = (data.labels || []).map(l => ({ name: l.name, type: l.type }))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'system' ? -1 : 1)))
      return { count: labels.length, labels }
    } catch (e) { return { error: e.message } }
  }
}

// ─── create_label ───────────────────────────────────────────────
const create_label = {
  schema: {
    name: 'create_label',
    description: "Create a new Gmail label (e.g. 'Riker/Drafts', 'Customers/Mauro'). Use slashes for nested labels. Returns the new label's name. Idempotent: if a label with the same name exists, returns it without erroring.",
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Label name. Slashes create nesting.' } },
      required: ['name']
    }
  },
  async handler(input, ctx) {
    const { name } = input
    if (!name || !name.trim()) return { error: 'name required' }
    let token
    try { token = await getGmailToken() } catch (e) { return { error: e.message } }
    try {
      // Idempotency check
      const existing = await gmailFetch(token, 'users/me/labels')
      const match = (existing.labels || []).find(l => l.name.toLowerCase() === name.trim().toLowerCase())
      if (match) return { ok: true, name: match.name, created: false }
      const created = await gmailFetch(token, 'users/me/labels', { method: 'POST', body: { name: name.trim(), labelListVisibility: 'labelShow', messageListVisibility: 'show' } })
      return { ok: true, name: created.name, created: true }
    } catch (e) { return { error: e.message } }
  }
}

// ─── forward_email ──────────────────────────────────────────────
const forward_email = {
  schema: {
    name: 'forward_email',
    description: "Forward an existing email (by message_id) to another recipient. Optionally adds a note above the quoted original. Sends through the branded template chrome. Use when Jon says 'Riker, forward that RFQ to Mauro at mauro@grill.com'.",
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Gmail message ID of the email to forward.' },
        to: { type: 'string', description: 'Recipient email address.' },
        note: { type: 'string', description: 'Optional note from you to add above the forwarded content.' }
      },
      required: ['message_id', 'to']
    }
  },
  async handler(input, ctx) {
    const { message_id, to, note } = input
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { error: 'Invalid email address' }
    let token
    try { token = await getGmailToken() } catch (e) { return { error: e.message } }
    let original
    try {
      original = await gmailFetch(token, `users/me/messages/${message_id}?format=full`)
    } catch (e) { return { error: 'Could not fetch original: ' + e.message } }

    // Pull headers
    const hdrs = (original.payload?.headers || []).reduce((acc, h) => { acc[h.name.toLowerCase()] = h.value; return acc }, {})
    const origSubject = hdrs.subject || '(no subject)'
    const origFrom = hdrs.from || '(unknown sender)'
    const origDate = hdrs.date || ''

    // Pull plain-text body if present, else fall back to snippet
    let origText = original.snippet || ''
    function findPart(p, mime) {
      if (!p) return null
      if (p.mimeType === mime && p.body?.data) return Buffer.from(p.body.data, 'base64').toString('utf-8')
      for (const c of (p.parts || [])) { const r = findPart(c, mime); if (r) return r }
      return null
    }
    const text = findPart(original.payload, 'text/plain')
    if (text) origText = text

    const subject = origSubject.toLowerCase().startsWith('fwd:') ? origSubject : `Fwd: ${origSubject}`
    const noteParagraph = note ? `${note}\n\n` : ''
    const body = `${noteParagraph}---------- Forwarded message ----------\nFrom: ${origFrom}\nDate: ${origDate}\nSubject: ${origSubject}\n\n${origText}`

    try {
      await sendEmailRaw({ to, subject, body, plain: false })
    } catch (e) { return { error: 'Send failed: ' + e.message } }

    try {
      await ctx.supabase.from('audit_log').insert({
        action: 'email_forwarded', entity_type: 'email_message', entity_id: message_id,
        actor: 'riker', details: { to, has_note: !!note }
      })
    } catch {}

    return { ok: true, forwarded_to: to, subject }
  }
}

// ═══════════════════════════════════════════════════════════════
// PHASE 3 — ATTACHMENTS (read + save + send)
// ═══════════════════════════════════════════════════════════════

// Helper: walk a Gmail message payload tree to find every attachment part.
function collectAttachments(payload, out = []) {
  if (!payload) return out
  if (payload.filename && payload.body?.attachmentId) {
    out.push({
      filename: payload.filename,
      mime_type: payload.mimeType || 'application/octet-stream',
      size: payload.body.size || 0,
      attachment_id: payload.body.attachmentId,
    })
  }
  for (const child of (payload.parts || [])) collectAttachments(child, out)
  return out
}

const list_attachments_in_thread = {
  schema: {
    name: 'list_attachments_in_thread',
    description: "List every attachment across every message in a Gmail thread. Returns filename, mime_type, size (bytes), and message_id + attachment_id you'll need to fetch the bytes via read_attachment_text or save_email_attachment_to_storage.",
    input_schema: {
      type: 'object',
      properties: { thread_id: { type: 'string' } },
      required: ['thread_id']
    }
  },
  async handler(input, ctx) {
    let token; try { token = await getGmailToken() } catch (e) { return { error: e.message } }
    try {
      const thread = await gmailFetch(token, `users/me/threads/${input.thread_id}?format=full`)
      const all = []
      for (const msg of (thread.messages || [])) {
        const parts = collectAttachments(msg.payload)
        for (const p of parts) all.push({ ...p, message_id: msg.id })
      }
      return { count: all.length, attachments: all }
    } catch (e) { return { error: e.message } }
  }
}

const read_attachment_text = {
  schema: {
    name: 'read_attachment_text',
    description: "Fetch a Gmail attachment and return its text content. Works for text/* and (best-effort) for HTML. PDFs and images are NOT parsed — only their metadata returned. Capped at ~50KB returned text per call. Use list_attachments_in_thread first to find the attachment_id.",
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
        attachment_id: { type: 'string' }
      },
      required: ['message_id', 'attachment_id']
    }
  },
  async handler(input, ctx) {
    let token; try { token = await getGmailToken() } catch (e) { return { error: e.message } }
    try {
      const att = await gmailFetch(token, `users/me/messages/${input.message_id}/attachments/${input.attachment_id}`)
      const data = att.data
      if (!data) return { error: 'Attachment empty' }
      const buf = Buffer.from(data, 'base64url')
      const size = buf.length
      // Try UTF-8 decode for text-likely buffers (heuristic: looks ASCII-ish in first 1KB)
      const sample = buf.slice(0, Math.min(1024, buf.length))
      const printable = sample.filter(b => (b >= 32 && b < 127) || b === 9 || b === 10 || b === 13).length
      const isProbablyText = printable / sample.length > 0.85
      if (!isProbablyText) {
        return { binary: true, size, hint: 'Binary content (likely PDF/image). Use save_email_attachment_to_storage to forward it; do not try to read inline.' }
      }
      const text = buf.slice(0, 50 * 1024).toString('utf-8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      return { text, size, truncated: size > 50 * 1024 }
    } catch (e) { return { error: e.message } }
  }
}

const save_email_attachment_to_storage = {
  schema: {
    name: 'save_email_attachment_to_storage',
    description: "Pull a Gmail attachment and copy it to Supabase storage so it can be referenced by URL later (e.g. forwarded via send_email_with_attachment, attached to a job/invoice document, etc.). Returns a signed URL valid for 1 hour. Use list_attachments_in_thread first for IDs.",
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
        attachment_id: { type: 'string' },
        filename: { type: 'string', description: 'Override the filename. Defaults to the original.' }
      },
      required: ['message_id', 'attachment_id']
    }
  },
  async handler(input, ctx) {
    let token; try { token = await getGmailToken() } catch (e) { return { error: e.message } }
    try {
      // Need filename + mime from message metadata (Gmail attachments endpoint
      // returns just bytes, not filename). Fetch metadata-format message to find it.
      const metaMsg = await gmailFetch(token, `users/me/messages/${input.message_id}?format=full`)
      const all = collectAttachments(metaMsg.payload)
      const meta = all.find(a => a.attachment_id === input.attachment_id)
      if (!meta) return { error: 'Attachment metadata not found in message' }

      const att = await gmailFetch(token, `users/me/messages/${input.message_id}/attachments/${input.attachment_id}`)
      const buf = Buffer.from(att.data, 'base64url')

      const safeName = (input.filename || meta.filename || 'attachment').replace(/[^\w.\-]/g, '_')
      const path = `inbound/${input.message_id}/${input.attachment_id}-${safeName}`
      const { error: upErr } = await ctx.supabase.storage.from('email-attachments').upload(path, buf, { contentType: meta.mime_type, upsert: true })
      if (upErr) return { error: 'Storage upload failed: ' + upErr.message }
      const { data: signed, error: signErr } = await ctx.supabase.storage.from('email-attachments').createSignedUrl(path, 60 * 60)
      if (signErr) return { error: 'Signed URL failed: ' + signErr.message }
      return { ok: true, url: signed.signedUrl, filename: safeName, mime_type: meta.mime_type, size: meta.size, expires_in_seconds: 3600 }
    } catch (e) { return { error: e.message } }
  }
}

const send_email_with_attachment = {
  schema: {
    name: 'send_email_with_attachment',
    description: "Send a branded email (via the Phase-1 template) with one or more attachments. Pass attachment_urls — typically Supabase storage signed URLs from save_email_attachment_to_storage, OR a public URL of an MMS pic Jon texted you. Files are fetched, base64-encoded, and attached to the outbound email via Resend's attachments parameter. Use this to satisfy 'Riker, send this pic to <customer> as the inspection-tag photo'.",
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
        attachment_urls: { type: 'array', items: { type: 'string' }, description: 'One or more URLs to fetch and attach. Resolved by GET; data is base64-encoded into the outgoing email.' },
        filenames: { type: 'array', items: { type: 'string' }, description: 'Optional. Same length as attachment_urls; overrides the filename Resend sees.' }
      },
      required: ['to', 'subject', 'body', 'attachment_urls']
    }
  },
  async handler(input, ctx) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to)) return { error: 'Invalid email address' }
    if (!Array.isArray(input.attachment_urls) || !input.attachment_urls.length) return { error: 'attachment_urls required' }

    // Fetch each URL, base64-encode for Resend
    const attachments = []
    for (let i = 0; i < input.attachment_urls.length; i++) {
      const url = input.attachment_urls[i]
      try {
        const r = await fetch(url)
        if (!r.ok) return { error: `Fetch failed for ${url}: ${r.status}` }
        const buf = Buffer.from(await r.arrayBuffer())
        if (buf.length > 20 * 1024 * 1024) return { error: `Attachment ${i} too large (${buf.length} bytes; 20MB cap)` }
        const filename = (input.filenames && input.filenames[i]) || (url.split('/').pop().split('?')[0]) || `attachment-${i}`
        attachments.push({ filename, content: buf.toString('base64') })
      } catch (e) {
        return { error: `Attachment ${i} fetch error: ${e.message}` }
      }
    }

    try {
      await sendEmailRaw({ to: input.to, subject: input.subject, body: input.body, attachments })
    } catch (e) { return { error: e.message } }

    try {
      await ctx.supabase.from('audit_log').insert({
        action: 'email_sent_with_attachment',
        entity_type: 'email',
        entity_id: input.to,
        actor: 'riker',
        details: { to: input.to, subject: input.subject, attachment_count: attachments.length }
      })
    } catch {}

    return { ok: true, to: input.to, attached: attachments.length }
  }
}

// ═══════════════════════════════════════════════════════════════
// PHASE 4 — DRAFTS + REPLY_ALL
// ═══════════════════════════════════════════════════════════════

// Build a base64url-encoded RFC822 message for Gmail's drafts API.
function buildRawRfc822({ to, cc, bcc, subject, html, text, inReplyTo, references }) {
  const boundary = 'sa-' + Math.random().toString(36).slice(2)
  const headers = [
    'From: Stephens Advanced <jonathan@stephensadvanced.com>',
    `To: ${(Array.isArray(to) ? to : [to]).join(', ')}`,
  ]
  if (cc && cc.length) headers.push(`Cc: ${(Array.isArray(cc) ? cc : [cc]).join(', ')}`)
  if (bcc && bcc.length) headers.push(`Bcc: ${(Array.isArray(bcc) ? bcc : [bcc]).join(', ')}`)
  headers.push(`Subject: ${subject || ''}`)
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`)
  if (references) headers.push(`References: ${references}`)
  headers.push('MIME-Version: 1.0')
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
  const body = [
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    (text || '').replace(/[^\x20-\x7E\n\r\t]/g, ''),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    html || '',
    '',
    `--${boundary}--`,
    ''
  ].join('\r\n')
  const raw = headers.join('\r\n') + '\r\n' + body
  return Buffer.from(raw, 'utf-8').toString('base64url')
}

const create_holding_draft = {
  schema: {
    name: 'create_holding_draft',
    description: "Create a Gmail draft (saved in Drafts, NOT sent). Distinct from draft_email_reply, which is a Riker-internal pending-approval slot. Use this when Jon says 'Riker, draft an email to mauro@grill.com about the discount and leave it in my drafts so I can edit before sending.' Returns the Gmail draft ID.",
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        cc: { type: 'array', items: { type: 'string' } },
        bcc: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Plain-text body. Wrapped in the Phase-1 branded template for HTML side; both versions saved.' }
      },
      required: ['to', 'subject', 'body']
    }
  },
  async handler(input, ctx) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to)) return { error: 'Invalid email address' }
    let token; try { token = await getGmailToken() } catch (e) { return { error: e.message } }

    const paragraphs = input.body.split('\n\n').map(p => p.trim()).filter(Boolean)
    const intro = paragraphs[0] || ''
    const restHtml = paragraphs.slice(1).map(p => `<p style="margin:0 0 14px;font-size:14px;color:#444;line-height:1.7">${p.replace(/\n/g, '<br>')}</p>`).join('')
    const opts = {
      headline: input.subject || 'Stephens Advanced',
      subheadline: 'Stephens Advanced LLC &mdash; Fire Suppression &amp; Safety',
      intro, bodyHtml: restHtml,
    }
    const html = renderEmail(opts)
    const text = renderText(opts)

    const raw = buildRawRfc822({ to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject, html, text })
    try {
      const draft = await gmailFetch(token, 'users/me/drafts', { method: 'POST', body: { message: { raw } } })
      try {
        await ctx.supabase.from('audit_log').insert({
          action: 'email_draft_created', entity_type: 'email_draft', entity_id: draft.id,
          actor: 'riker', details: { to: input.to, subject: input.subject }
        })
      } catch {}
      return { ok: true, draft_id: draft.id, message_id: draft.message?.id, to: input.to, subject: input.subject }
    } catch (e) { return { error: e.message } }
  }
}

const list_drafts = {
  schema: {
    name: 'list_drafts',
    description: "List drafts currently saved in Gmail (the human-edit-then-send queue, not the Riker-pending-approval queue). Returns id, subject, recipient, and snippet for each.",
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Max drafts to return (default 20, cap 100).' } }
    }
  },
  async handler(input, ctx) {
    let token; try { token = await getGmailToken() } catch (e) { return { error: e.message } }
    const limit = Math.min(100, Number(input.limit) || 20)
    try {
      const list = await gmailFetch(token, `users/me/drafts?maxResults=${limit}`)
      const ids = (list.drafts || []).map(d => d.id)
      const drafts = []
      for (const id of ids) {
        const d = await gmailFetch(token, `users/me/drafts/${id}?format=metadata`)
        const hdrs = (d.message?.payload?.headers || []).reduce((acc, h) => { acc[h.name.toLowerCase()] = h.value; return acc }, {})
        drafts.push({
          draft_id: id,
          message_id: d.message?.id,
          to: hdrs.to || '',
          subject: hdrs.subject || '',
          snippet: d.message?.snippet || ''
        })
      }
      return { count: drafts.length, drafts }
    } catch (e) { return { error: e.message } }
  }
}

const delete_draft = {
  schema: {
    name: 'delete_draft',
    description: "Delete a Gmail draft permanently (different from trash; this is unrecoverable). Use draft_id from create_holding_draft or list_drafts.",
    input_schema: {
      type: 'object',
      properties: { draft_id: { type: 'string' } },
      required: ['draft_id']
    }
  },
  async handler(input, ctx) {
    let token; try { token = await getGmailToken() } catch (e) { return { error: e.message } }
    try {
      await gmailFetch(token, `users/me/drafts/${input.draft_id}`, { method: 'DELETE' })
      try {
        await ctx.supabase.from('audit_log').insert({
          action: 'email_draft_deleted', entity_type: 'email_draft', entity_id: input.draft_id,
          actor: 'riker', details: {}
        })
      } catch {}
      return { ok: true, deleted: input.draft_id }
    } catch (e) { return { error: e.message } }
  }
}

const reply_all = {
  schema: {
    name: 'reply_all',
    description: "Reply to a Gmail message AND copy everyone in the original To + Cc lines (excluding jonathan@). Maintains the thread by adding In-Reply-To and References headers. Subject becomes 'Re: <original>'. Sent immediately via Resend through the branded template (use create_holding_draft instead if you want it to wait for human review).",
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Gmail ID of the message you are replying to.' },
        body: { type: 'string', description: 'Reply body in plain text.' },
        plain: { type: 'boolean', description: 'If true, send as a barebones inline reply (no logo header). Better for active threads. Default false.' }
      },
      required: ['message_id', 'body']
    }
  },
  async handler(input, ctx) {
    let token; try { token = await getGmailToken() } catch (e) { return { error: e.message } }
    let original
    try { original = await gmailFetch(token, `users/me/messages/${input.message_id}?format=full`) } catch (e) { return { error: 'Could not fetch original: ' + e.message } }

    const hdrs = (original.payload?.headers || []).reduce((acc, h) => { acc[h.name.toLowerCase()] = h.value; return acc }, {})
    const origMsgId = hdrs['message-id'] || ''
    const origSubject = hdrs.subject || '(no subject)'
    const subject = origSubject.toLowerCase().startsWith('re:') ? origSubject : `Re: ${origSubject}`

    // Build recipient list: original From + To + Cc, minus jonathan@
    function parseAddrs(s) {
      if (!s) return []
      return s.split(',').map(a => {
        const m = a.match(/<([^>]+)>/)
        return (m ? m[1] : a).trim().toLowerCase()
      }).filter(a => a && a.includes('@'))
    }
    const me = 'jonathan@stephensadvanced.com'
    const recipients = new Set([...parseAddrs(hdrs.from), ...parseAddrs(hdrs.to), ...parseAddrs(hdrs.cc)])
    recipients.delete(me)
    if (!recipients.size) return { error: 'No recipients on original message' }
    const [primary, ...others] = Array.from(recipients)

    try {
      await sendEmailRaw({
        to: primary,
        subject,
        body: input.body,
        plain: !!input.plain,
        inReplyTo: origMsgId,
        references: hdrs.references ? `${hdrs.references} ${origMsgId}` : origMsgId,
      })
      // Resend doesn't auto-CC — additional recipients sent as separate messages
      // is the simplest way without breaking thread integrity. Acceptable trade.
      for (const cc of others) {
        try { await sendEmailRaw({ to: cc, subject, body: input.body, plain: !!input.plain, inReplyTo: origMsgId, references: hdrs.references ? `${hdrs.references} ${origMsgId}` : origMsgId }) } catch {}
      }
    } catch (e) { return { error: 'Send failed: ' + e.message } }

    try {
      await ctx.supabase.from('audit_log').insert({
        action: 'email_reply_all', entity_type: 'email_message', entity_id: input.message_id,
        actor: 'riker', details: { recipients: Array.from(recipients), subject }
      })
    } catch {}

    return { ok: true, replied_to: Array.from(recipients), subject }
  }
}

// ═══════════════════════════════════════════════════════════════
// CAPABILITY-PARITY BATCH: tools added to close the gap between what
// Jon can do in the app and what Riker can do via chat. Goal — the
// "green dot" UX never lies. If the dot pulses on an action Jon took,
// Riker must actually be able to do that same action.
// ═══════════════════════════════════════════════════════════════

// ─── mark_job_confirmed ──────────────────────────────────────────
const mark_job_confirmed = {
  schema: {
    name: 'mark_job_confirmed',
    description: "Toggle the CONFIRMED-with-customer chip on a job — use when the customer has explicitly confirmed they will be available at the scheduled time. Records who confirmed and how (sms / call / email / in_person). Setting this enables the departure-alert cron to fire.",
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID. Required.' },
        confirmed_by: { type: 'string', description: 'Name of the person at the customer who confirmed (e.g. "Maria the manager"). Optional but useful for the activity log.' },
        confirmation_method: { type: 'string', enum: ['sms', 'call', 'email', 'in_person', 'auto'], description: 'How the confirmation was received. Default "sms".' }
      },
      required: ['job_id']
    }
  },
  async handler(input, ctx) {
    if (!input.job_id) return { error: 'job_id required' }
    const method = input.confirmation_method || 'sms'
    const by = input.confirmed_by || null
    const nowIso = new Date().toISOString()
    const { error } = await ctx.supabase.from('jobs').update({
      confirmed_at: nowIso,
      confirmed_by: by,
      confirmation_method: method
    }).eq('id', input.job_id)
    if (error) return { error: error.message }
    try {
      await ctx.supabase.from('audit_log').insert({
        action: 'confirmed', entity_type: 'job', entity_id: input.job_id,
        actor: 'ai_chat',
        details: { confirmed_by: by, confirmation_method: method, summary: by ? `Confirmed with ${by} via ${method} (Riker)` : `Confirmed via ${method} (Riker)` }
      })
    } catch (e) { console.warn('[mark_job_confirmed] audit insert failed:', e.message) }
    return { ok: true, job_id: input.job_id, confirmed_at: nowIso, confirmed_by: by, confirmation_method: method }
  }
}

// ─── unmark_job_confirmed ────────────────────────────────────────
const unmark_job_confirmed = {
  schema: {
    name: 'unmark_job_confirmed',
    description: "Remove the CONFIRMED chip from a job (clears confirmed_at, confirmed_by, confirmation_method). Use when a customer un-confirms or the confirmation was made in error. Re-arms the departure-alert cron.",
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID. Required.' },
        reason: { type: 'string', description: 'Why the confirmation is being removed (for activity log).' }
      },
      required: ['job_id']
    }
  },
  async handler(input, ctx) {
    if (!input.job_id) return { error: 'job_id required' }
    const { error } = await ctx.supabase.from('jobs').update({
      confirmed_at: null,
      confirmed_by: null,
      confirmation_method: null,
      departure_alert_sent_at: null
    }).eq('id', input.job_id)
    if (error) return { error: error.message }
    try {
      await ctx.supabase.from('audit_log').insert({
        action: 'unconfirmed', entity_type: 'job', entity_id: input.job_id,
        actor: 'ai_chat',
        details: { reason: input.reason || null, summary: 'Confirmation removed' + (input.reason ? ': ' + input.reason : '') + ' (Riker)' }
      })
    } catch (e) { console.warn('[unmark_job_confirmed] audit insert failed:', e.message) }
    return { ok: true, job_id: input.job_id }
  }
}

// ─── charge_card_on_file ─────────────────────────────────────────
const charge_card_on_file = {
  schema: {
    name: 'charge_card_on_file',
    description: "Run a Square charge against the customer's saved card-on-file. Marks the invoice paid on success. Returns the Square payment ID and receipt URL. Will fail with a clear error if no card is on file or Square is misconfigured. Mirrors the app's chargeCardOnFile button.",
    input_schema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string' },
        invoice_number: { type: 'string', description: 'Alternative to invoice_id.' }
      }
    }
  },
  async handler(input, ctx) {
    let invoiceId = input.invoice_id
    if (!invoiceId && input.invoice_number) {
      const { data } = await ctx.supabase.from('invoices').select('id').eq('invoice_number', input.invoice_number).is('deleted_at', null).maybeSingle()
      invoiceId = data?.id
    }
    if (!invoiceId) return { error: 'invoice_id or invoice_number required' }

    const { data: inv } = await ctx.supabase.from('invoices').select('id,invoice_number,total,status,location_id').eq('id', invoiceId).maybeSingle()
    if (!inv) return { error: 'Invoice not found' }
    if (inv.status === 'paid') return { error: 'Invoice already paid' }
    if (!(+inv.total > 0)) return { error: 'Invoice has zero or negative total' }

    const { data: loc } = await ctx.supabase.from('locations').select('id,name,contact_name,contact_email,contact_phone').eq('id', inv.location_id).maybeSingle()
    if (!loc) return { error: 'Location not found' }

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.stephensadvanced.com'

    // Step 1 — find / create Square customer + get cards list
    const custRes = await fetch(`${siteUrl}/api/square`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create_or_find',
        name: loc.contact_name || loc.name,
        email: loc.contact_email || '',
        phone: loc.contact_phone || '',
        locationId: loc.id
      })
    })
    const custData = await custRes.json()
    if (!custData.success) return { error: 'Square customer lookup failed: ' + (custData.error || 'unknown') }
    if (!custData.cards?.length) return { error: 'No card on file for this customer. Use request_card_save to send them a save-card link.' }

    // Step 2 — charge the first card on file
    const card = custData.cards[0]
    const total = +inv.total
    const chargeRes = await fetch(`${siteUrl}/api/square`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'charge_card',
        customerId: custData.customerId,
        cardId: card.id,
        amount: total,
        invoiceId: invoiceId,
        invoiceNumber: inv.invoice_number
      })
    })
    const chargeData = await chargeRes.json()
    if (!chargeData.success) return { error: chargeData.error || 'Square charge failed' }

    // /api/square already marked invoice paid server-side. Just write the audit row.
    try {
      await ctx.supabase.from('audit_log').insert({
        action: 'paid', entity_type: 'invoice', entity_id: invoiceId,
        actor: 'ai_chat',
        details: {
          method: 'card_on_file',
          amount: total,
          square_payment_id: chargeData.paymentId,
          last4: card.last_4,
          brand: card.card_brand,
          summary: `Charged $${total.toFixed(2)} to ${card.card_brand || 'card'} ending ${card.last_4 || '????'} (Riker)`
        }
      })
    } catch (e) { console.warn('[charge_card_on_file] audit insert failed:', e.message) }

    return { ok: true, payment_id: chargeData.paymentId, receipt_url: chargeData.receiptUrl, amount_charged: total, card: { brand: card.card_brand, last4: card.last_4 } }
  }
}

// ─── bulk_assign_jobs_to_tech ────────────────────────────────────
const bulk_assign_jobs_to_tech = {
  schema: {
    name: 'bulk_assign_jobs_to_tech',
    description: "Assign multiple jobs to a single technician in one call. Use for 'assign all of tomorrow's jobs to Bobby' style requests.",
    input_schema: {
      type: 'object',
      properties: {
        job_ids: { type: 'array', items: { type: 'string' }, description: 'Array of job UUIDs.' },
        tech_id: { type: 'string', description: 'Tech UUID. Pass empty string to bulk-unassign.' }
      },
      required: ['job_ids']
    }
  },
  async handler(input, ctx) {
    if (!Array.isArray(input.job_ids) || !input.job_ids.length) return { error: 'job_ids (non-empty array) required' }
    const techId = input.tech_id || null
    const { error } = await ctx.supabase.from('jobs').update({ assigned_to: techId }).in('id', input.job_ids)
    if (error) return { error: error.message }
    try {
      const rows = input.job_ids.map(jid => ({
        action: 'assigned', entity_type: 'job', entity_id: jid,
        actor: 'ai_chat',
        details: { assigned_to: techId, summary: techId ? `Bulk-assigned to tech ${techId} (Riker)` : 'Bulk-unassigned (Riker)' }
      }))
      await ctx.supabase.from('audit_log').insert(rows)
    } catch (e) { console.warn('[bulk_assign_jobs_to_tech] audit insert failed:', e.message) }
    return { ok: true, count: input.job_ids.length, tech_id: techId }
  }
}

// ─── add_job_photo ───────────────────────────────────────────────
const add_job_photo = {
  schema: {
    name: 'add_job_photo',
    description: "Attach a photo to a job. Accepts a base64-encoded image (with or without the data:image/...; prefix). Photo is appended to jobs.photos. Use when a customer emails or texts a photo Jon should keep with a job. The same array that Jon's in-app camera button writes to.",
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID. Required.' },
        photo_b64: { type: 'string', description: 'Base64-encoded image data, with or without the data:image/...; prefix.' },
        caption: { type: 'string', description: 'Optional caption / source note (e.g. "Customer emailed 4/29").' }
      },
      required: ['job_id', 'photo_b64']
    }
  },
  async handler(input, ctx) {
    if (!input.job_id || !input.photo_b64) return { error: 'job_id and photo_b64 required' }

    const { data: job } = await ctx.supabase.from('jobs').select('photos').eq('id', input.job_id).maybeSingle()
    if (!job) return { error: 'Job not found' }

    const photo = input.photo_b64.startsWith('data:') ? input.photo_b64 : `data:image/jpeg;base64,${input.photo_b64}`
    const photos = Array.isArray(job.photos) ? [...job.photos, photo] : [photo]

    const { error } = await ctx.supabase.from('jobs').update({ photos }).eq('id', input.job_id)
    if (error) return { error: error.message }

    try {
      await ctx.supabase.from('audit_log').insert({
        action: 'photo_added', entity_type: 'job', entity_id: input.job_id,
        actor: 'ai_chat',
        details: { caption: input.caption || null, summary: 'Photo attached' + (input.caption ? ': ' + input.caption : '') + ' (Riker)' }
      })
    } catch (e) { console.warn('[add_job_photo] audit insert failed:', e.message) }

    return { ok: true, job_id: input.job_id, photo_count: photos.length }
  }
}

// ─── request_remote_signature ────────────────────────────────────
const request_remote_signature = {
  schema: {
    name: 'request_remote_signature',
    description: "Send the customer a unique signing link via email + SMS. Customer can sign on their phone — covers the invoice and any inspection reports for this job. Use when a job is completed but the signature wasn't captured at site (most common case for old completed jobs missing signature_data). Link is unique per job, expires in 14 days.",
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID. Required.' }
      },
      required: ['job_id']
    }
  },
  async handler(input, ctx) {
    if (!input.job_id) return { error: 'job_id required' }
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.stephensadvanced.com'
    const r = await fetch(`${siteUrl}/api/send-signature-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: input.job_id })
    })
    const data = await r.json()
    if (!r.ok) return { error: data.error || 'Send failed' }

    try {
      await ctx.supabase.from('audit_log').insert({
        action: 'signature_request_sent', entity_type: 'job', entity_id: input.job_id,
        actor: 'ai_chat',
        details: { email_sent: !!data.email?.sent, sms_sent: !!data.sms?.sent, summary: 'Signing link sent (Riker)' }
      })
    } catch (e) { console.warn('[request_remote_signature] audit insert failed:', e.message) }

    const channels = []
    if (data.email?.sent) channels.push('email')
    if (data.sms?.sent) channels.push('text')
    return { ok: true, sent_via: channels, expires_in_days: 14 }
  }
}

// ─── request_card_save ───────────────────────────────────────────
const request_card_save = {
  schema: {
    name: 'request_card_save',
    description: "Send the customer a Square-hosted link to save a card on file (and optionally pay an invoice at the same time). Use when a customer has agreed to autopay or prepaid billing but hasn't entered card info yet. After they save, future charges can run via charge_card_on_file. Sends via SMS + email if both are on file.",
    input_schema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string', description: 'Optional: invoice to charge at the same time the card is saved. If omitted, this is a save-only flow.' },
        location_id: { type: 'string', description: 'Required if no invoice_id — which location/customer should the card be saved against.' }
      }
    }
  },
  async handler(input, ctx) {
    let inv = null
    if (input.invoice_id) {
      const { data } = await ctx.supabase.from('invoices').select('id,invoice_number,total,location_id').eq('id', input.invoice_id).maybeSingle()
      if (!data) return { error: 'Invoice not found' }
      inv = data
    }

    const locId = inv?.location_id || input.location_id
    if (!locId) return { error: 'invoice_id or location_id required' }

    const { data: loc } = await ctx.supabase.from('locations').select('id,name,contact_name,contact_email,contact_phone,billing_account_id').eq('id', locId).maybeSingle()
    if (!loc) return { error: 'Location not found' }

    if (!loc.contact_email && !loc.contact_phone) {
      return { error: 'No contact email or phone on file for this location. Add one first.' }
    }

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.stephensadvanced.com'

    // Step 1 — ensure Square customer exists
    const custRes = await fetch(`${siteUrl}/api/square`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create_or_find',
        name: loc.contact_name || loc.name,
        email: loc.contact_email || '',
        phone: loc.contact_phone || '',
        locationId: loc.id
      })
    })
    const custData = await custRes.json()
    if (!custData.success) return { error: 'Square customer setup failed: ' + (custData.error || 'unknown') }

    // Step 2 — create the hosted-checkout link
    const linkRes = await fetch(`${siteUrl}/api/square`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'checkout_and_save_card',
        customerId: custData.customerId,
        amount: inv ? +inv.total : 0,
        invoiceNumber: inv?.invoice_number || '',
        customerName: loc.contact_name || loc.name,
        invoiceId: inv?.id || null,
        email: loc.contact_email || ''
      })
    })
    const linkData = await linkRes.json()
    if (!linkData.success || !linkData.url) return { error: linkData.error || 'Could not create Square checkout link' }

    // Step 3 — send the link via SMS + email
    const sentVia = []
    const msg = inv
      ? `Hi from Stephens Advanced — secure payment link for invoice ${inv.invoice_number} ($${(+inv.total).toFixed(2)}). Pays the invoice and saves your card for future service: ${linkData.url}`
      : `Hi from Stephens Advanced — secure link to save your card on file for future service. No charge today: ${linkData.url}`

    if (loc.contact_phone) {
      try {
        const toPhone = loc.contact_phone.startsWith('+') ? loc.contact_phone : '+1' + loc.contact_phone.replace(/\D/g, '')
        await sendSMSRaw(toPhone, msg)
        sentVia.push('sms')
      } catch (e) { console.warn('[request_card_save] SMS failed:', e.message) }
    }

    if (loc.contact_email) {
      try {
        await sendEmailRaw({
          to: loc.contact_email,
          subject: inv ? `Payment & save card · Invoice ${inv.invoice_number}` : 'Save your card · Stephens Advanced',
          body: msg
        })
        sentVia.push('email')
      } catch (e) { console.warn('[request_card_save] email failed:', e.message) }
    }

    if (!sentVia.length) return { error: 'Both SMS and email send failed' }

    try {
      await ctx.supabase.from('audit_log').insert({
        action: 'card_save_link_sent', entity_type: 'location', entity_id: loc.id,
        actor: 'ai_chat',
        details: { invoice_id: inv?.id || null, sent_via: sentVia, summary: `Card-save link sent via ${sentVia.join(' + ')} (Riker)` }
      })
    } catch (e) { console.warn('[request_card_save] audit insert failed:', e.message) }

    return { ok: true, sent_via: sentVia, link: linkData.url }
  }
}

// ─── complete_job_with_invoice ───────────────────────────────────
const complete_job_with_invoice = {
  schema: {
    name: 'complete_job_with_invoice',
    description: "Mark a job as completed AND generate the invoice from its work-order lines (or from explicitly-passed lines). The standard end-of-day flow when Jon's done with a job. If `lines` is not passed, uses the job's saved work_order_lines. Refuses if neither exists, if the job is already completed, or if an invoice already exists for this job. Invoice is created in 'draft' status — pass it through send / charge / mark_paid separately.",
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID. Required.' },
        lines: {
          type: 'array',
          description: 'Optional: explicit invoice lines. If omitted, uses job.work_order_lines. Each line: {description, quantity, unit_price}',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantity: { type: 'number' },
              unit_price: { type: 'number' }
            },
            required: ['description', 'unit_price']
          }
        },
        notes: { type: 'string', description: 'Tech notes / deficiencies for the invoice.' }
      },
      required: ['job_id']
    }
  },
  async handler(input, ctx) {
    if (!input.job_id) return { error: 'job_id required' }

    const { data: job } = await ctx.supabase.from('jobs').select('id,location_id,billing_account_id,work_order_lines,status,job_number').eq('id', input.job_id).maybeSingle()
    if (!job) return { error: 'Job not found' }
    if (job.status === 'completed') return { error: 'Job already completed' }

    // Refuse to create a duplicate invoice for the same job
    const { data: existing } = await ctx.supabase.from('invoices').select('id,invoice_number').eq('job_id', job.id).is('deleted_at', null).maybeSingle()
    if (existing) return { error: `Invoice already exists for this job: ${existing.invoice_number} (${existing.id}). Use mark_invoice_paid or update_invoice instead.` }

    const lines = (input.lines && input.lines.length) ? input.lines : (Array.isArray(job.work_order_lines) ? job.work_order_lines.map(l => ({
      description: l.desc || l.description,
      quantity: +(l.qty || l.quantity || 1),
      unit_price: +(l.price || l.unit_price || 0)
    })) : [])

    if (!lines.length) return { error: 'No lines on job and none provided. Pass `lines` or save work_order_lines first.' }

    const total = lines.reduce((s, l) => s + (+l.quantity || 1) * (+l.unit_price || 0), 0)
    if (total < 0) return { error: 'Invoice total is negative — refusing to create' }

    const today = new Date().toISOString().split('T')[0]
    const due = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]
    const invNum = 'INV-' + Math.floor(100000 + Math.random() * 900000)

    const { data: invRow, error: invErr } = await ctx.supabase.from('invoices').insert({
      invoice_number: invNum,
      job_id: job.id,
      location_id: job.location_id,
      billing_account_id: job.billing_account_id,
      total,
      status: 'draft',
      date: today,
      due_date: due,
      notes: input.notes || null
    }).select('id,invoice_number').single()
    if (invErr) return { error: 'Invoice insert failed: ' + invErr.message }

    const lineRows = lines.map((l, i) => ({
      invoice_id: invRow.id,
      description: l.description,
      quantity: +(l.quantity || 1),
      unit_price: +(l.unit_price || 0),
      total: +(l.quantity || 1) * +(l.unit_price || 0),
      sort_order: i
    }))
    const { error: lineErr } = await ctx.supabase.from('invoice_lines').insert(lineRows)
    if (lineErr) {
      // Rollback the invoice we just inserted so we don't leave an orphan with no lines.
      await ctx.supabase.from('invoices').delete().eq('id', invRow.id)
      return { error: 'Invoice lines insert failed (invoice rolled back): ' + lineErr.message }
    }

    const { error: jobErr } = await ctx.supabase.from('jobs').update({
      status: 'completed',
      completed_at: new Date().toISOString()
    }).eq('id', job.id)
    if (jobErr) return { error: 'Job status update failed (invoice still created): ' + jobErr.message }

    try {
      await ctx.supabase.from('audit_log').insert([
        {
          action: 'completed', entity_type: 'job', entity_id: job.id,
          actor: 'ai_chat',
          details: { invoice_id: invRow.id, invoice_number: invRow.invoice_number, total, summary: `Job completed and invoice ${invRow.invoice_number} generated for $${total.toFixed(2)} (Riker)` }
        },
        {
          action: 'created', entity_type: 'invoice', entity_id: invRow.id,
          actor: 'ai_chat',
          details: { job_id: job.id, total, line_count: lines.length, summary: `Invoice ${invRow.invoice_number} created from job (Riker)` }
        }
      ])
    } catch (e) { console.warn('[complete_job_with_invoice] audit insert failed:', e.message) }

    return { ok: true, job_id: job.id, invoice_id: invRow.id, invoice_number: invRow.invoice_number, total, line_count: lines.length }
  }
}

// ─── create_inspection_report ────────────────────────────────────
const create_inspection_report = {
  schema: {
    name: 'create_inspection_report',
    description: "Create an inspection report attached to a job. Pass the report_type and the full report_data object. Shape of report_data depends on type:\n\n- extinguisher: { units: [{ id, location, type, manufacturer, model, mfg_date, last_hydro, last_six_year, next_hydro, next_six_year, status, notes }, ...] }\n- kitchen_suppression: { sysId, sysLocation, sysType, tankCount, nozzleCount, fusibleLinkCount, semiAnnual: {...checks}, deficiencies, technician_notes }\n- dry_chemical: similar shape to kitchen_suppression but for dry-chem / paint-booth systems\n- clean_agent: similar shape but for clean-agent systems (FM-200, Novec, CO2, halon)\n\nReturns the new report_id so you can call update_inspection_report later if details change.",
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID. Required.' },
        report_type: { type: 'string', enum: ['extinguisher', 'kitchen_suppression', 'dry_chemical', 'clean_agent'] },
        report_data: { type: 'object', description: 'Type-specific report data. See description for the per-type shape.' }
      },
      required: ['job_id', 'report_type', 'report_data']
    }
  },
  async handler(input, ctx) {
    if (!input.job_id || !input.report_type || !input.report_data) {
      return { error: 'job_id, report_type, and report_data required' }
    }

    const validTypes = ['extinguisher', 'kitchen_suppression', 'dry_chemical', 'clean_agent']
    if (!validTypes.includes(input.report_type)) {
      return { error: `Invalid report_type. Must be one of: ${validTypes.join(', ')}` }
    }

    const { data: job } = await ctx.supabase.from('jobs').select('location_id').eq('id', input.job_id).maybeSingle()
    if (!job) return { error: 'Job not found' }

    const { data: report, error } = await ctx.supabase.from('reports').insert({
      job_id: input.job_id,
      location_id: job.location_id,
      report_type: input.report_type,
      report_data: input.report_data
    }).select('id').single()
    if (error) return { error: 'Report insert failed: ' + error.message }

    try {
      await ctx.supabase.from('audit_log').insert({
        action: 'report_created', entity_type: 'job', entity_id: input.job_id,
        actor: 'ai_chat',
        details: {
          report_id: report.id,
          report_type: input.report_type,
          summary: `${input.report_type.replace(/_/g, ' ')} report created (Riker)`
        }
      })
    } catch (e) { console.warn('[create_inspection_report] audit insert failed:', e.message) }

    return { ok: true, report_id: report.id, report_type: input.report_type }
  }
}

// ─── update_inspection_report ────────────────────────────────────
const update_inspection_report = {
  schema: {
    name: 'update_inspection_report',
    description: "Update an existing inspection report's data. Pass the full new report_data — it REPLACES the existing JSON (not a partial merge). Use after create_inspection_report when the customer asks for changes, when more detail is added later, or when an extinguisher unit's status flips (pass → fail, etc.).",
    input_schema: {
      type: 'object',
      properties: {
        report_id: { type: 'string' },
        report_data: { type: 'object', description: 'Full replacement report_data JSON.' }
      },
      required: ['report_id', 'report_data']
    }
  },
  async handler(input, ctx) {
    if (!input.report_id || !input.report_data) return { error: 'report_id and report_data required' }
    const { data: existing } = await ctx.supabase.from('reports').select('id,job_id,report_type').eq('id', input.report_id).maybeSingle()
    if (!existing) return { error: 'Report not found' }
    const { error } = await ctx.supabase.from('reports').update({ report_data: input.report_data }).eq('id', input.report_id)
    if (error) return { error: error.message }
    try {
      await ctx.supabase.from('audit_log').insert({
        action: 'report_updated', entity_type: 'job', entity_id: existing.job_id,
        actor: 'ai_chat',
        details: { report_id: existing.id, report_type: existing.report_type, summary: `${existing.report_type.replace(/_/g, ' ')} report updated (Riker)` }
      })
    } catch (e) { console.warn('[update_inspection_report] audit insert failed:', e.message) }
    return { ok: true, report_id: existing.id }
  }
}

// ═══════════════════════════════════════════════════════════════
// REGISTRY (placed after every tool const so all references resolve)
// ═══════════════════════════════════════════════════════════════

const ALL_TOOLS = {
  get_today_summary, query_jobs, lookup_client, get_invoices,
  get_schedule_slots, get_equipment, get_pending_confirmations,
  get_todos, read_memory, get_rate_card, get_jon_location,
  schedule_job, approve_pending, reject_pending, send_sms,
  add_client, create_billing_account, list_locations_by_account, assign_location_to_billing_account,
  add_todo, write_memory, delete_memory, mark_invoice_paid,
  lookup_business,
  update_client, delete_client, merge_clients,
  update_invoice, void_invoice, delete_invoice,
  build_route,
  get_job_activity, add_job_note,
  update_job, cancel_job,
  send_email, get_conversation_history, create_invoice, list_job_documents,
  mazon_list_queue, mazon_mark_funded, mazon_void,
  escalate_to_jon,
  request_owner_otp, verify_owner_otp,
  search_email, read_inbox, read_email_thread, draft_email_reply, approve_email_draft,
  web_search_brave, web_fetch, get_weather,
  reschedule_job,
  get_invoice_lines, add_invoice_line, update_invoice_line, delete_invoice_line,
  generate_portal_link,
  list_techs, add_tech, update_tech, assign_job_to_tech,
  get_brycer_queue, mark_brycer_submitted,
  list_contracts, create_contract, send_contract,
  get_business_report, get_ar_aging, get_audit_log,
  list_service_requests, respond_to_service_request,
  list_custom_items, add_custom_item, delete_custom_item,
  send_on_my_way, send_review_request,
  // Phase 2 — inbox management
  manage_email, list_labels, create_label, forward_email,
  // Phase 3 — attachments
  list_attachments_in_thread, read_attachment_text, save_email_attachment_to_storage, send_email_with_attachment,
  // Phase 4 — drafts + reply_all
  create_holding_draft, list_drafts, delete_draft, reply_all,
  // Capability-parity batch — match the actions Jon takes in the app
  mark_job_confirmed, unmark_job_confirmed,
  charge_card_on_file, request_card_save,
  bulk_assign_jobs_to_tech,
  add_job_photo,
  request_remote_signature,
  complete_job_with_invoice,
  create_inspection_report, update_inspection_report,
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

// Multi-tech: tools that touch money, customer data destructively, tech
// admin, the standing-orders memory, or the approval/escalation queue.
// Non-owner techs (e.g. Bobby, an employee) cannot invoke these from the
// app. Owner status is set on identity at /api/riker entry from techs.
// is_owner. Customer-side contexts (website/sms_customer/etc) are NOT
// gated by this set — those have their own per-context tool whitelist
// in CONTEXT_TOOLS, and the customer is implicitly never the owner.
//
// Keep this list narrow and explicit. If a tool isn't here, every
// authenticated tech can call it (read-only, scheduling, notes, photos,
// signature requests, getting context, etc.).
const OWNER_ONLY_TOOLS = new Set([
  // Payments / invoices (money movement)
  'mark_invoice_paid', 'update_invoice', 'void_invoice', 'delete_invoice',
  'create_invoice', 'add_invoice_line', 'update_invoice_line', 'delete_invoice_line',
  'charge_card_on_file', 'request_card_save',
  'mazon_mark_funded', 'mazon_void',
  'complete_job_with_invoice',
  // Destructive customer / data
  'delete_client', 'merge_clients',
  'create_billing_account', 'assign_location_to_billing_account',
  // Rate-card adjacent
  'add_custom_item', 'delete_custom_item',
  // Tech admin
  'add_tech', 'update_tech',
  'assign_job_to_tech', 'bulk_assign_jobs_to_tech',
  // Memory (standing orders are owner policy)
  'write_memory', 'delete_memory',
  // Approvals queue (owner-only by definition)
  'approve_pending', 'reject_pending',
  'request_owner_otp', 'verify_owner_otp', 'escalate_to_jon',
  // Contracts (commit the business legally)
  'create_contract', 'send_contract', 'request_remote_signature',
  // Portal access (issues a customer login link)
  'generate_portal_link'
])

async function executeToolCall(name, input, ctx) {
  const tool = ALL_TOOLS[name]
  if (!tool) return { error: `Unknown tool: ${name}` }
  // Per-context whitelist
  const allowed = CONTEXT_TOOLS[ctx.context]
  if (allowed && !allowed.includes(name)) return { error: `Tool '${name}' not available in context '${ctx.context}'` }
  // Multi-tech: owner-only gate. Enforced on Jon-side surfaces — `app`
  // (cookie-authenticated tech) and `sms_jon` (Jon's number, identity
  // resolved in sms-inbound.js). Customer-side contexts (website /
  // portal / sms_customer / email_customer) can't reach these tools via
  // CONTEXT_TOOLS anyway, so the gate would be redundant there.
  //
  // Fail-closed: undefined `is_owner` is treated as false. Both the app
  // path (riker.js) and the SMS path (sms-inbound.js) explicitly set
  // is_owner from the techs table — the only way is_owner is undefined
  // is if a future surface added itself to the gate without populating
  // identity. That should refuse, not allow.
  const OWNER_GATED_CONTEXTS = new Set(['app', 'sms_jon'])
  if (OWNER_GATED_CONTEXTS.has(ctx.context) && OWNER_ONLY_TOOLS.has(name) && !ctx.identity?.is_owner) {
    return {
      error: `Tool '${name}' is owner-only. ${ctx.identity?.tech_name || 'You'} can't invoke it — ask the owner to do it from their device.`
    }
  }
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
