// /api/riker-actions.js
// Action executor — dispatches parsed action blocks to their handler.
// Permission check (is this action allowed in this context?) happens before
// the handler is called. Side effects are isolated here so the core
// orchestrator stays small.

const crypto = require('crypto')
const { CONTEXT_ACTIONS } = require('./riker-prompts')
const memory = require('./riker-memory')
const william = require('./william-schedule')

const BRYCER_CITIES = ['fort worth', 'benbrook', 'burleson', 'crowley', 'edgecliff village', 'everman', 'forest hill', 'haltom city', 'kennedale', 'lake worth', 'north richland hills', 'richland hills', 'river oaks', 'saginaw', 'sansom park', 'westover hills', 'westworth village', 'white settlement', 'watauga', 'blue mound', 'haslet', 'keller', 'southlake', 'colleyville', 'grapevine', 'euless', 'bedford', 'hurst']

const JON_PHONE = '+12149944799'
const CUSTOMER_CONTEXTS = new Set(['website', 'sms_customer', 'email_customer'])
const AUTO_CONFIRM = process.env.RIKER_AUTO_CONFIRM === 'true'

// Slot fit check given pre-fetched calendar data
function slotFits({ date, time, duration_hours, calEvents, jobs }) {
  const avail = william.getJonAvailability(new Date(date + 'T12:00:00'))
  if (!avail.available) return false
  const workStart = timeToMin(avail.workStart)
  const workEnd = timeToMin(avail.workEnd)
  const startMin = timeToMin(time)
  const endMin = startMin + Math.round((duration_hours || 1.5) * 60)
  if (startMin < workStart || endMin > workEnd) return false
  // Check conflicts
  const dayJobs = (jobs || []).filter(j => j.scheduled_date === date && j.status !== 'cancelled' && j.status !== 'completed')
  for (const j of dayJobs) {
    const t = j.scheduled_time || '09:00'
    const [jh, jm] = t.split(':').map(Number)
    const jStart = jh * 60 + jm
    const jEnd = jStart + (j.estimated_duration_hours || 1.5) * 60
    if (startMin < jEnd && endMin > jStart) return false
  }
  const ds = new Date(date + 'T00:00:00'), de = new Date(date + 'T23:59:59')
  for (const ev of (calEvents || [])) {
    if (ev.event_type === 'job') continue
    const s = new Date(ev.start_time), e = new Date(ev.end_time)
    if (s > de || e < ds) continue
    const eStart = s.getHours() * 60 + s.getMinutes()
    const eEnd = e.getHours() * 60 + e.getMinutes()
    if (startMin < eEnd && endMin > eStart) return false
  }
  return true
}

function timeToMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m }

async function createPendingConfirmation(action, ctx, reasoning) {
  // Best-effort location identity
  const locationId = action.location_id || ctx.lastLocationId || ctx.identity.location_id || null
  const customerPhone = ctx.identity.phone || null
  const customerEmail = ctx.identity.email || null
  const sourceChannel = ctx.context === 'email_customer' ? 'email' : (ctx.context === 'sms_customer' ? 'sms' : ctx.context)

  const { data: pending } = await ctx.supabase.from('pending_confirmations').insert({
    source_conversation_id: ctx.sessionId,
    source_channel: sourceChannel === 'website' || sourceChannel === 'portal' ? null : sourceChannel,
    customer_phone: customerPhone,
    customer_email: customerEmail,
    customer_name: action.contact_name || ctx.identity.customer_name || null,
    location_id: locationId,
    proposed_action: action,
    proposed_reply: ctx.rawReply || '',
    reasoning: reasoning || null
  }).select().single()

  // Ping Jon
  const via = ctx.context
  const lines = [
    `CONFIRM? ${action.business_name || action.contact_name || 'Unknown'} (via ${via})`,
    `${action.date || '?'} ${action.time || '?'} (${action.duration_hours || 1.5}hr)`,
    `${(action.scope || []).join(', ')}`,
    action.city ? action.city : null,
    reasoning ? `(${reasoning})` : null,
    '',
    'Reply YES to approve, NO to reject, or suggest alt like "Tue 2pm"'
  ].filter(Boolean).join('\n')
  try { await sendSMS(JON_PHONE, lines) } catch (e) { console.error('[create-pending] sms_jon failed:', e.message) }
  return pending
}

// ─── helpers ───

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

// ─── action handlers ───
// Each handler receives (action, ctx). ctx provides: { supabase, identity,
// context, sessionId }. Returns { ok, detail, replyInject? } where
// replyInject is text to weave into the final reply (e.g. portal URL).

const handlers = {
  async create_customer(a, ctx) {
    const city = (a.city || '').toLowerCase()
    const isBrycer = BRYCER_CITIES.includes(city)
    const { data: loc, error } = await ctx.supabase.from('locations').insert({
      name: a.business_name,
      contact_name: a.contact_name,
      contact_phone: a.phone,
      contact_email: a.email || null,
      address: a.address || null,
      city: a.city || null,
      state: a.state || 'TX',
      zip: a.zip || null,
      is_brycer_jurisdiction: isBrycer,
      brycer_ahj_name: isBrycer ? (a.city || '') + ' Fire Department' : null
    }).select().single()
    if (error) return { ok: false, detail: error.message }
    if (a.address) {
      const geo = await geocode([a.address, a.city, a.state, a.zip].filter(Boolean).join(', '))
      if (geo) await ctx.supabase.from('locations').update({ lat: geo.lat, lng: geo.lng }).eq('id', loc.id)
    }
    ctx.lastLocationId = loc.id
    return { ok: true, detail: { location_id: loc.id } }
  },

  async schedule_job(a, ctx) {
    // Customer-facing contexts route through Jon's approval gate unless
    // AUTO_CONFIRM is on AND the proposed slot cleanly fits.
    if (CUSTOMER_CONTEXTS.has(ctx.context)) {
      const fits = a.date && a.time
        ? slotFits({ date: a.date, time: a.time, duration_hours: a.duration_hours, calEvents: ctx.calEvents, jobs: ctx.jobs })
        : false
      if (!AUTO_CONFIRM || !fits) {
        const reason = !AUTO_CONFIRM
          ? 'Manual-confirm mode'
          : 'Proposed slot conflicts with schedule or William constraints'
        const pending = await createPendingConfirmation(a, ctx, reason)
        return {
          ok: true,
          detail: { pending_id: pending?.id, waiting_for_jon: true },
          replyOverride: 'Let me double-check with Jon and get right back to you.'
        }
      }
      // Auto-confirmed — fall through to execute, and also text Jon a heads-up
      try { await sendSMS(JON_PHONE, `Auto-booked: ${a.business_name || a.location_id} ${a.date} ${a.time} (${(a.scope || []).join(',')})`) } catch {}
    }

    const locationId = a.location_id || ctx.lastLocationId
    if (!locationId) return { ok: false, detail: 'no location_id' }
    const { data: job, error } = await ctx.supabase.from('jobs').insert({
      location_id: locationId,
      scheduled_date: a.date,
      scheduled_time: a.time || '09:00',
      scope: a.scope || ['extinguishers', 'suppression'],
      status: 'scheduled',
      estimated_duration_hours: a.duration_hours || 1.5,
      notes: a.notes || 'Booked via ' + ctx.context
    }).select().single()
    if (error) return { ok: false, detail: error.message }

    const startDt = new Date(a.date + 'T' + (a.time || '09:00') + ':00')
    const endDt = new Date(startDt.getTime() + (a.duration_hours || 1.5) * 3600000)
    await ctx.supabase.from('calendar_events').insert({
      title: a.notes || 'Booking: ' + ctx.context,
      event_type: 'job',
      start_time: startDt.toISOString(),
      end_time: endDt.toISOString(),
      location_id: locationId,
      job_id: job.id,
      color: '#3b82f6'
    })

    const { data: locInfo } = await ctx.supabase.from('locations').select('name,is_brycer_jurisdiction').eq('id', locationId).single()
    if (locInfo?.is_brycer_jurisdiction) {
      await ctx.supabase.from('brycer_queue').insert({ location_id: locationId, location_name: locInfo.name, submitted: false })
    }
    return { ok: true, detail: { job_id: job.id } }
  },

  async generate_portal(a, ctx) {
    const locationId = a.location_id || ctx.lastLocationId
    if (!locationId) return { ok: false, detail: 'no location_id' }
    const buf = crypto.randomBytes(16)
    const token = buf.toString('hex')
    // Find billing account for this location
    const { data: loc } = await ctx.supabase.from('locations').select('billing_account_id').eq('id', locationId).single()
    await ctx.supabase.from('portal_tokens').insert({
      token,
      location_id: locationId,
      billing_account_id: loc?.billing_account_id || null,
      expires_at: new Date(Date.now() + 15 * 86400000).toISOString(),
      is_active: true
    })
    const url = 'https://stephensadvanced.com/portal?t=' + token
    return { ok: true, detail: { url, token }, replyInject: { placeholder: /\[portal\s*(?:URL|link)?\]/gi, value: url, append: url } }
  },

  async sms_jon(a) {
    try {
      await sendSMS(JON_PHONE, a.body)
      return { ok: true }
    } catch (e) { return { ok: false, detail: e.message } }
  },

  async sms_customer(a) {
    try {
      await sendSMS(a.to, a.body)
      return { ok: true }
    } catch (e) { return { ok: false, detail: e.message } }
  },

  async send_sms(a) {
    // App-context alias for sms_customer — explicit Jon action
    try {
      await sendSMS(a.to, a.body)
      return { ok: true }
    } catch (e) { return { ok: false, detail: e.message } }
  },

  async need_quote(a) {
    const msg = `QUOTE REQUEST\n${a.business_name || '?'}\n${a.contact || '?'} ${a.phone || ''}\n${a.details || ''}`
    try {
      await sendSMS(JON_PHONE, msg)
      return { ok: true }
    } catch (e) { return { ok: false, detail: e.message } }
  },

  // ─── portal ───

  async submit_service_request(a, ctx) {
    const locationId = a.location_id || ctx.identity.location_id
    const { data: loc } = await ctx.supabase.from('locations').select('billing_account_id').eq('id', locationId).maybeSingle()
    const { data: req } = await ctx.supabase.from('service_requests').insert({
      location_id: locationId,
      billing_account_id: loc?.billing_account_id || ctx.identity.billing_account_id || null,
      request_type: a.request_type || 'new_service',
      requested_date: a.requested_date || null,
      notes: a.notes || null,
      source: ctx.context
    }).select().single()
    // Notify Jon
    try {
      await sendSMS(JON_PHONE, `Service request (portal): ${a.request_type || 'new'} at ${locationId}${a.requested_date ? ' for ' + a.requested_date : ''}\n${a.notes || ''}`)
    } catch (e) { console.error('sms_jon from service_request:', e.message) }
    return { ok: true, detail: { request_id: req?.id } }
  },

  async view_invoices(a, ctx) {
    const locationId = a.location_id || ctx.identity.location_id
    const baId = ctx.identity.billing_account_id
    let q = ctx.supabase.from('invoices').select('id, invoice_number, date, due_date, total, status, paid_at').order('date', { ascending: false }).limit(a.limit || 10)
    if (locationId) q = q.eq('location_id', locationId)
    else if (baId) q = q.eq('billing_account_id', baId)
    const { data: invoices } = await q
    return { ok: true, detail: { invoices: invoices || [] } }
  },

  async view_equipment(a, ctx) {
    const locationId = a.location_id || ctx.identity.location_id
    if (!locationId) return { ok: false, detail: 'no location_id' }
    const [ext, sup, emg] = await Promise.all([
      ctx.supabase.from('extinguishers').select('*').eq('location_id', locationId),
      ctx.supabase.from('suppression_systems').select('*').eq('location_id', locationId),
      ctx.supabase.from('emergency_lights').select('*').eq('location_id', locationId)
    ])
    return { ok: true, detail: { extinguishers: ext.data || [], suppression: sup.data || [], emergency_lights: emg.data || [] } }
  },

  async update_contact_info(a, ctx) {
    const locationId = a.location_id || ctx.identity.location_id
    const updates = {}
    if (a.contact_name) updates.contact_name = a.contact_name
    if (a.contact_phone) updates.contact_phone = a.contact_phone
    if (a.contact_email) updates.contact_email = a.contact_email
    if (!Object.keys(updates).length) return { ok: false, detail: 'no fields to update' }
    await ctx.supabase.from('locations').update(updates).eq('id', locationId)
    return { ok: true }
  },

  async request_portal_extension(a, ctx) {
    // Jon needs to approve; just notify him
    try {
      await sendSMS(JON_PHONE, `Portal extension requested for location ${a.location_id || ctx.identity.location_id}`)
    } catch {}
    return { ok: true }
  },

  async view_next_service(a, ctx) {
    const locationId = a.location_id || ctx.identity.location_id
    const today = new Date().toISOString().split('T')[0]
    const { data: jobs } = await ctx.supabase
      .from('jobs')
      .select('id, scheduled_date, scheduled_time, scope, status')
      .eq('location_id', locationId)
      .gte('scheduled_date', today)
      .in('status', ['scheduled', 'en_route', 'active'])
      .order('scheduled_date', { ascending: true })
      .limit(5)
    return { ok: true, detail: { jobs: jobs || [] } }
  },

  // ─── app ───

  async add_client(a, ctx) {
    return handlers.create_customer({
      type: 'create_customer',
      business_name: a.name,
      contact_name: a.contact || null,
      phone: a.phone,
      email: a.email,
      address: a.address,
      city: a.city,
      state: a.state || 'TX',
      zip: a.zip
    }, ctx)
  },

  async add_todo(a, ctx) {
    const { data } = await ctx.supabase.from('todos').insert({
      text: a.text,
      created_by: ctx.identity.tech_id || null,
      completed: false
    }).select().single()
    return { ok: true, detail: { todo_id: data?.id } }
  },

  async mark_paid(a, ctx) {
    await ctx.supabase.from('invoices').update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      payment_method: a.method || 'manual',
      notes: a.note || null
    }).eq('id', a.invoice_id)
    return { ok: true }
  },

  async lookup_client(a, ctx) {
    const { data: locs } = await ctx.supabase.from('locations').select('*').ilike('name', '%' + a.name + '%').limit(5)
    return { ok: true, detail: { matches: locs || [] } }
  },

  async lookup_invoice(a, ctx) {
    const { data: inv } = await ctx.supabase.from('invoices').select('*, lines:invoice_lines(*)').eq('invoice_number', a.invoice_number).maybeSingle()
    return { ok: true, detail: { invoice: inv } }
  },

  async open_screen(a) {
    return { ok: true, detail: { screen: a.screen }, clientHint: { type: 'open_screen', screen: a.screen } }
  },

  async open_client(a) {
    return { ok: true, detail: { location_id: a.location_id }, clientHint: { type: 'open_client', location_id: a.location_id } }
  },

  async open_job(a) {
    return { ok: true, detail: { job_id: a.job_id }, clientHint: { type: 'open_job', job_id: a.job_id } }
  },

  async delete_job(a, ctx) {
    await ctx.supabase.from('jobs').delete().eq('id', a.job_id)
    return { ok: true }
  },

  async add_extinguisher(a, ctx) {
    const { data } = await ctx.supabase.from('extinguishers').insert({
      location_id: a.location_id,
      type: a.type,
      size: a.size,
      location_in_building: a.location_in_building || null
    }).select().single()
    return { ok: true, detail: { extinguisher_id: data?.id } }
  },

  async add_suppression(a, ctx) {
    const { data } = await ctx.supabase.from('suppression_systems').insert({
      location_id: a.location_id,
      system_type: a.system_type,
      category: a.category || null,
      tank_count: a.tank_count || 1,
      nozzle_count: a.nozzle_count || 0,
      fusible_link_count: a.fusible_link_count || 0
    }).select().single()
    return { ok: true, detail: { system_id: data?.id } }
  },

  async add_contact(a, ctx) {
    const { data } = await ctx.supabase.from('location_contacts').insert({
      location_id: a.location_id,
      name: a.name,
      role: a.role || null,
      phone: a.phone || null,
      email: a.email || null
    }).select().single()
    return { ok: true, detail: { contact_id: data?.id } }
  },

  async toast(a) {
    return { ok: true, detail: { toast: a.message }, clientHint: { type: 'toast', message: a.message } }
  },

  async build_route(a) {
    return { ok: true, detail: a, clientHint: { type: 'build_route', ...a } }
  },

  async modify_route(a) {
    return { ok: true, detail: a, clientHint: { type: 'modify_route', ...a } }
  },

  async suggest_job(a) {
    return { ok: true, detail: a, clientHint: { type: 'suggest_job', ...a } }
  },

  // ─── memory ───

  async memory_write(a, ctx) {
    const entries = a.entries || []
    let written = 0
    for (const e of entries) {
      const r = await memory.writeMemory(ctx.supabase, e, { sessionId: ctx.sessionId, source: ctx.context })
      if (r) written++
    }
    return { ok: true, detail: { written } }
  },

  async memory_delete(a, ctx) {
    await memory.deleteMemory(ctx.supabase, a.memory_id, a.reason)
    return { ok: true }
  },

  // ─── Jon pending-confirmation actions ───

  async approve_pending(a, ctx) {
    let pending
    if (a.pending_id) {
      const { data } = await ctx.supabase.from('pending_confirmations').select('*').eq('id', a.pending_id).maybeSingle()
      pending = data
    } else {
      const { data } = await ctx.supabase.from('pending_confirmations').select('*').eq('status', 'pending').gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1)
      pending = data?.[0]
    }
    if (!pending) return { ok: false, detail: 'no pending confirmation found' }

    // Temporarily disable AUTO_CONFIRM gate — we want the nested action to execute
    const subCtx = { ...ctx, context: 'app', lastLocationId: pending.location_id }
    const subAction = pending.proposed_action
    const subHandler = handlers[subAction.type]
    if (!subHandler) return { ok: false, detail: 'unknown nested action type: ' + subAction.type }

    let subResult
    try {
      subResult = await subHandler(subAction, subCtx)
    } catch (e) {
      await ctx.supabase.from('pending_confirmations').update({ status: 'failed', responded_at: new Date().toISOString() }).eq('id', pending.id)
      return { ok: false, detail: 'execute failed: ' + e.message }
    }

    await ctx.supabase.from('pending_confirmations').update({
      status: 'executed',
      responded_at: new Date().toISOString()
    }).eq('id', pending.id)

    // Send the original proposed_reply to the customer on their channel
    try {
      if (pending.source_channel === 'sms' && pending.customer_phone) {
        await sendSMS(pending.customer_phone, pending.proposed_reply)
        if (pending.source_conversation_id) {
          await ctx.supabase.from('messages').insert({
            conversation_id: pending.source_conversation_id,
            direction: 'outbound',
            channel: 'sms',
            body: pending.proposed_reply
          })
        }
      } else if (pending.source_channel === 'email' && pending.customer_email) {
        // Fetch thread info for threading
        let inReplyTo = null, references = null, subject = 'Re: scheduling'
        if (pending.source_conversation_id) {
          const { data: lastInbound } = await ctx.supabase
            .from('messages').select('email_message_id, email_subject')
            .eq('conversation_id', pending.source_conversation_id)
            .eq('direction', 'inbound')
            .order('created_at', { ascending: false }).limit(1).maybeSingle()
          if (lastInbound) {
            inReplyTo = lastInbound.email_message_id
            references = lastInbound.email_message_id
            subject = lastInbound.email_subject
              ? (lastInbound.email_subject.startsWith('Re:') ? lastInbound.email_subject : 'Re: ' + lastInbound.email_subject)
              : subject
          }
        }
        await sendEmail({ to: pending.customer_email, subject, body: pending.proposed_reply, inReplyTo, references })
        if (pending.source_conversation_id) {
          await ctx.supabase.from('messages').insert({
            conversation_id: pending.source_conversation_id,
            direction: 'outbound',
            channel: 'email',
            body: pending.proposed_reply,
            email_subject: subject
          })
        }
      }
    } catch (e) { console.error('[approve_pending] customer notify failed:', e.message) }

    return { ok: true, detail: { pending_id: pending.id, executed: subAction.type, sub_result: subResult } }
  },

  async reject_pending(a, ctx) {
    let pending
    if (a.pending_id) {
      const { data } = await ctx.supabase.from('pending_confirmations').select('*').eq('id', a.pending_id).maybeSingle()
      pending = data
    } else {
      const { data } = await ctx.supabase.from('pending_confirmations').select('*').eq('status', 'pending').gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1)
      pending = data?.[0]
    }
    if (!pending) return { ok: false, detail: 'no pending confirmation found' }

    await ctx.supabase.from('pending_confirmations').update({
      status: 'rejected',
      responded_at: new Date().toISOString()
    }).eq('id', pending.id)

    const msg = a.reason
      ? `Hey — Jon needs to adjust that time. ${a.reason} I'll reach back out shortly.`
      : "Hey — Jon needs to adjust that time. I'll reach back out shortly with another option."

    try {
      if (pending.source_channel === 'sms' && pending.customer_phone) {
        await sendSMS(pending.customer_phone, msg)
      } else if (pending.source_channel === 'email' && pending.customer_email) {
        await sendEmail({ to: pending.customer_email, subject: 'Re: scheduling', body: msg })
      }
    } catch (e) { console.error('[reject_pending] customer notify failed:', e.message) }

    return { ok: true, detail: { pending_id: pending.id } }
  },

  async counter_offer(a, ctx) {
    // Find pending
    let pending
    if (a.pending_id) {
      const { data } = await ctx.supabase.from('pending_confirmations').select('*').eq('id', a.pending_id).maybeSingle()
      pending = data
    } else {
      const { data } = await ctx.supabase.from('pending_confirmations').select('*').eq('status', 'pending').gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1)
      pending = data?.[0]
    }
    if (!pending) return { ok: false, detail: 'no pending confirmation found' }

    // Reject original + create new pending with updated date/time
    await ctx.supabase.from('pending_confirmations').update({
      status: 'rejected',
      responded_at: new Date().toISOString(),
      jon_response: 'counter: ' + (a.note || `${a.new_date} ${a.new_time}`)
    }).eq('id', pending.id)

    const newAction = { ...pending.proposed_action, date: a.new_date, time: a.new_time }
    const newReply = a.note || `Jon can do ${a.new_date} at ${a.new_time} instead. Does that work?`
    await ctx.supabase.from('pending_confirmations').insert({
      source_conversation_id: pending.source_conversation_id,
      source_channel: pending.source_channel,
      customer_phone: pending.customer_phone,
      customer_email: pending.customer_email,
      customer_name: pending.customer_name,
      location_id: pending.location_id,
      proposed_action: newAction,
      proposed_reply: newReply,
      reasoning: 'Jon counter-offered'
    })

    // Send counter-offer to customer
    try {
      if (pending.source_channel === 'sms' && pending.customer_phone) {
        await sendSMS(pending.customer_phone, newReply)
      } else if (pending.source_channel === 'email' && pending.customer_email) {
        await sendEmail({ to: pending.customer_email, subject: 'Re: scheduling', body: newReply })
      }
    } catch (e) { console.error('[counter_offer] notify failed:', e.message) }

    return { ok: true, detail: { old_pending: pending.id, new_date: a.new_date, new_time: a.new_time } }
  }
}

// ─── parse + execute ───

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

async function executeActions(actions, ctx) {
  const allowed = new Set(CONTEXT_ACTIONS[ctx.context] || [])
  const taken = []
  const clientHints = []
  let replyInject = null
  let pendingAction = null
  let replyOverride = null

  for (const action of actions) {
    if (!action || !action.type) continue
    if (!allowed.has(action.type)) {
      taken.push({ type: action.type, ok: false, detail: 'action not allowed in this context' })
      continue
    }
    const handler = handlers[action.type]
    if (!handler) {
      taken.push({ type: action.type, ok: false, detail: 'no handler' })
      continue
    }
    try {
      const result = await handler(action, ctx)
      taken.push({ type: action.type, ...result })
      if (result?.replyInject) replyInject = result.replyInject
      if (result?.clientHint) clientHints.push(result.clientHint)
      if (result?.pendingAction) pendingAction = result.pendingAction
      if (result?.replyOverride) replyOverride = result.replyOverride
    } catch (e) {
      console.error('[riker-actions] handler error:', action.type, e)
      taken.push({ type: action.type, ok: false, detail: e.message })
    }
  }

  return { taken, clientHints, replyInject, pendingAction, replyOverride }
}

module.exports = {
  parseActions,
  executeActions,
  sendSMS,
  sendEmail,
  JON_PHONE,
  handlers
}
