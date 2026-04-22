// /api/cron.js — Unified cron handler
// Routes: ?job=morning-digest  (daily 6 AM CDT = 11 UTC)
//         ?job=auto-reschedule (daily 7 AM CDT = 12 UTC)

const { createClient } = require('@supabase/supabase-js')
const william = require('./william-schedule')

const JON_PHONE = '+12149944799'

async function sendSMSToJon(body) {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_FROM_NUMBER
  if (!sid || !token || !from) throw new Error('Twilio not configured')
  const auth = Buffer.from(sid + ':' + token).toString('base64')
  const params = new URLSearchParams({ To: JON_PHONE, From: from, Body: body })
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error('Twilio send failed: ' + (data.message || res.status))
  }
}

// End-of-month in local (America/Chicago) calendar, returned as Date.
function endOfMonth(dateLike) {
  const d = new Date(dateLike)
  return new Date(d.getFullYear(), d.getMonth() + 1, 0)
}
function addDays(dateLike, n) {
  const d = new Date(dateLike)
  d.setDate(d.getDate() + n)
  return d
}
function ymd(d) { return d.toISOString().split('T')[0] }

// Pick a weekday inside the compliance window that Jon is available on.
// Prefer the by-the-book window (day 165–180 for supp, 335–365 for ext);
// fall back to the grace window (rest of the end-of-month containing day
// 180/365). Prefer Tue/Wed. Returns { date, tier } where tier is 'window'
// or 'grace'.
function pickTargetDate(windowStart, windowEnd, graceEnd) {
  const earliest = new Date(Math.max(windowStart.getTime(), Date.now() + 86400000 * 2))  // don't propose yesterday
  const scan = (from, to, tier) => {
    const out = []
    for (let d = new Date(from); d <= to; d = addDays(d, 1)) {
      const dow = d.getDay()
      if (dow === 0 || dow === 6) continue
      const avail = william.getJonAvailability(new Date(d))
      if (!avail.available) continue
      const dayScore = (dow === 2 || dow === 3) ? 0 : (dow === 4) ? 1 : (dow === 1 || dow === 5) ? 2 : 3
      out.push({ date: ymd(d), score: dayScore, tier })
    }
    return out
  }
  let options = scan(earliest, windowEnd, 'window')
  if (!options.length) options = scan(addDays(windowEnd, 1), graceEnd, 'grace')
  options.sort((a, b) => a.score - b.score)
  return options[0] || { date: ymd(windowEnd), tier: 'grace' }
}

module.exports = async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).end()

  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://motjasdokoxwiodwzyps.supabase.co'
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!sbKey) return res.status(500).json({ error: 'Missing Supabase key' })

  const SB = createClient(sbUrl, sbKey)
  const job = req.query.job || req.url.split('job=')[1]?.split('&')[0]

  if (job === 'morning-digest') return morningDigest(req, res, SB)
  if (job === 'auto-reschedule') return autoReschedule(req, res, SB)
  if (job === 'riker-feedback-review') return feedbackReview(req, res, SB)
  if (job === 'riker-morning-brief') return runProactive('morningBrief', res, SB)
  if (job === 'riker-invoice-aging') return runProactive('invoiceAging', res, SB)
  if (job === 'riker-compliance-alerts') return runProactive('complianceAlerts', res, SB)
  if (job === 'riker-memory-prune') return runProactive('memoryPrune', res, SB)
  if (job === 'departure-check') {
    try {
      const result = await runDepartureCheck(SB)
      return res.status(200).json({ ok: true, job: 'departure-check', ...result })
    } catch (e) {
      console.error('[cron] departure-check error:', e)
      return res.status(500).json({ error: e.message })
    }
  }
  return res.status(400).json({ error: 'Unknown job' })
}

async function runProactive(fnName, res, SB) {
  try {
    const mod = require('./riker-proactive')
    const fn = mod[fnName]
    if (!fn) return res.status(400).json({ error: 'Unknown proactive fn: ' + fnName })
    const result = await fn(SB)
    return res.status(200).json({ ok: true, job: fnName, result })
  } catch (e) {
    console.error('[cron] proactive error:', fnName, e)
    return res.status(500).json({ error: e.message, job: fnName })
  }
}

// ═══════════════════════════════════════════════════════════════
// MORNING DIGEST — Daily 6 AM Central
// ═══════════════════════════════════════════════════════════════
async function morningDigest(req, res, SB) {
  const resendKey = process.env.RESEND_API_KEY
  if (!resendKey) return res.status(500).json({ error: 'Missing Resend key' })

  const today = new Date().toISOString().split('T')[0]
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString()

  try {
    // Today's scheduled jobs
    const { data: todayJobs } = await SB
      .from('jobs')
      .select('id, location_id, scope, scheduled_date, scheduled_time, type, assigned_to, estimated_value, notes')
      .eq('scheduled_date', today)
      .in('status', ['scheduled', 'en_route', 'active'])
      .is('deleted_at', null)
      .order('scheduled_time', { ascending: true })

    // Get location names
    const locIds = [...new Set((todayJobs || []).map(j => j.location_id))]
    const { data: locs } = locIds.length
      ? await SB.from('locations').select('id, name, address, city').in('id', locIds).is('deleted_at', null)
      : { data: [] }
    const locMap = Object.fromEntries((locs || []).map(l => [l.id, l]))

    // Overdue jobs
    const { data: overdueJobs } = await SB
      .from('jobs')
      .select('id, location_id, scheduled_date')
      .eq('status', 'scheduled')
      .lt('scheduled_date', today)
      .is('deleted_at', null)

    // Unassigned jobs
    const { data: unassignedJobs } = await SB
      .from('jobs')
      .select('id')
      .eq('status', 'scheduled')
      .is('assigned_to', null)
      .is('deleted_at', null)

    // Unpaid invoices 30+ days
    const { data: agingInvoices } = await SB
      .from('invoices')
      .select('id, invoice_number, total, date, location_id')
      .not('status', 'in', '("paid","void","record","factored")')
      .lt('date', thirtyDaysAgo)

    const agingTotal = (agingInvoices || []).reduce((sum, inv) => sum + parseFloat(inv.total || 0), 0)

    // All unpaid invoices total
    const { data: allUnpaid } = await SB
      .from('invoices')
      .select('total')
      .not('status', 'in', '("paid","void","record","factored")')

    const unpaidTotal = (allUnpaid || []).reduce((sum, inv) => sum + parseFloat(inv.total || 0), 0)

    // New service requests in last 24h
    const yesterday = new Date(Date.now() - 86400000).toISOString()
    const { data: newRequests } = await SB
      .from('jobs')
      .select('id, location_id, created_at')
      .gte('created_at', yesterday)
      .ilike('notes', '%WEB SERVICE REQUEST%')

    // Build the email
    const jobCount = (todayJobs || []).length
    const overdueCount = (overdueJobs || []).length
    const unassignedCount = (unassignedJobs || []).length
    const agingCount = (agingInvoices || []).length
    const newRequestCount = (newRequests || []).length
    const fmt = n => '$' + parseFloat(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const todayValue = (todayJobs || []).reduce((sum, j) => sum + parseFloat(j.estimated_value || 0), 0)

    let jobListHtml = ''
    if (jobCount > 0) {
      jobListHtml = (todayJobs || []).map((j, i) => {
        const loc = locMap[j.location_id] || {}
        const scope = (j.scope || []).join(', ')
        const time = j.scheduled_time ? j.scheduled_time.slice(0, 5) : ''
        const val = j.estimated_value ? fmt(j.estimated_value) : ''
        return `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#666">${i + 1}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:13px"><b>${loc.name || 'Unknown'}</b><br><span style="color:#888;font-size:11px">${loc.address || ''}, ${loc.city || ''}</span></td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#666">${scope}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#666">${time}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#333;font-weight:600">${val}</td>
        </tr>`
      }).join('')
    }

    const alerts = []
    if (overdueCount > 0) alerts.push(`<span style="display:inline-block;padding:6px 14px;background:#fef2f2;color:#dc2626;border-radius:20px;font-size:13px;font-weight:700;margin:4px">${overdueCount} Overdue Jobs</span>`)
    if (unassignedCount > 0) alerts.push(`<span style="display:inline-block;padding:6px 14px;background:#fffbeb;color:#d97706;border-radius:20px;font-size:13px;font-weight:700;margin:4px">${unassignedCount} Unassigned</span>`)
    if (agingCount > 0) alerts.push(`<span style="display:inline-block;padding:6px 14px;background:#fef2f2;color:#dc2626;border-radius:20px;font-size:13px;font-weight:700;margin:4px">${agingCount} Invoices 30+ Days — ${fmt(agingTotal)}</span>`)
    if (newRequestCount > 0) alerts.push(`<span style="display:inline-block;padding:6px 14px;background:#ecfdf5;color:#059669;border-radius:20px;font-size:13px;font-weight:700;margin:4px">${newRequestCount} New Service Request${newRequestCount > 1 ? 's' : ''}</span>`)

    const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

    const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
      <div style="background:#1a1a1a;padding:24px;text-align:center">
        <div style="color:#f05a28;font-size:22px;font-weight:900;letter-spacing:1px">STEPHENS ADVANCED</div>
        <div style="color:#888;font-size:12px;margin-top:4px">${dateStr}</div>
      </div>
      <div style="padding:24px">
        <div style="display:flex;text-align:center;margin-bottom:24px">
          <div style="flex:1;padding:16px;background:#f8f9fa;border-radius:8px;margin-right:8px">
            <div style="font-size:28px;font-weight:900;color:#1a1a1a">${jobCount}</div>
            <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px">Jobs Today</div>
          </div>
          <div style="flex:1;padding:16px;background:#f8f9fa;border-radius:8px;margin-right:8px">
            <div style="font-size:28px;font-weight:900;color:#059669">${todayValue > 0 ? fmt(todayValue) : '$0'}</div>
            <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px">Est. Revenue</div>
          </div>
          <div style="flex:1;padding:16px;background:#f8f9fa;border-radius:8px">
            <div style="font-size:28px;font-weight:900;color:#dc2626">${fmt(unpaidTotal)}</div>
            <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px">Unpaid Total</div>
          </div>
        </div>
        ${alerts.length ? '<div style="text-align:center;margin-bottom:24px">' + alerts.join('') + '</div>' : ''}
        ${jobCount > 0 ? `
        <div style="margin-bottom:24px">
          <div style="font-size:14px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#999;margin-bottom:12px">Today's Schedule</div>
          <table style="width:100%;border-collapse:collapse">
            <tr style="background:#f8f9fa">
              <th style="padding:8px 12px;text-align:left;font-size:11px;color:#888;text-transform:uppercase">#</th>
              <th style="padding:8px 12px;text-align:left;font-size:11px;color:#888;text-transform:uppercase">Location</th>
              <th style="padding:8px 12px;text-align:left;font-size:11px;color:#888;text-transform:uppercase">Scope</th>
              <th style="padding:8px 12px;text-align:left;font-size:11px;color:#888;text-transform:uppercase">Time</th>
              <th style="padding:8px 12px;text-align:left;font-size:11px;color:#888;text-transform:uppercase">Est.</th>
            </tr>
            ${jobListHtml}
          </table>
        </div>` : '<p style="color:#888;text-align:center;padding:20px">No jobs scheduled for today.</p>'}
        <div style="text-align:center;padding:20px 0">
          <a href="https://stephensadvanced.com/app" style="display:inline-block;padding:14px 36px;background:#f05a28;color:#fff;text-decoration:none;border-radius:8px;font-weight:800;font-size:15px">Open App</a>
        </div>
      </div>
      <div style="background:#f8f9fa;padding:16px;text-align:center;font-size:11px;color:#aaa">
        Stephens Advanced LLC · (214) 994-4799 · stephensadvanced.com
      </div>
    </div>`

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Stephens Advanced <jonathan@stephensadvanced.com>',
        to: ['jonathan@stephensadvanced.com'],
        subject: `${dateStr} — ${jobCount} jobs, ${overdueCount > 0 ? overdueCount + ' overdue, ' : ''}${fmt(unpaidTotal)} unpaid`,
        html
      })
    })

    const emailData = await emailRes.json()
    return res.status(200).json({
      success: true,
      summary: { date: today, jobs: jobCount, overdue: overdueCount, unassigned: unassignedCount, aging30: agingCount, agingTotal, unpaidTotal, newRequests: newRequestCount, todayValue },
      email: emailData
    })

  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

// ═══════════════════════════════════════════════════════════════
// AUTO-RESCHEDULE — 1st of every month
// ═══════════════════════════════════════════════════════════════
// AUTO-RESCHEDULE — daily proposal run.
//
// Finds recurring inspections coming due. Due-date rule per Jon: day 180
// is by-the-book, but in practice we have until end-of-month the 180th
// day falls in. Suppression = 180d cycle, extinguishers = 365d cycle.
//
// Rather than insert jobs silently, this cron builds a proposal list,
// writes one pending_confirmations row (type=auto_schedule_batch), and
// texts Jon a digest. Jon replies YES/NO (or lets it expire), and the
// approve_pending flow materializes the jobs.
//
// Jobs that appear in a still-open pending proposal are skipped so
// successive daily runs don't re-spam.
// ═══════════════════════════════════════════════════════════════
// FEEDBACK REVIEW — weekly digest of 👎 / 👍 signals
// ═══════════════════════════════════════════════════════════════
// Runs Sundays; pulls the last 7 days of unreviewed feedback, asks
// Claude to synthesize patterns, texts Jon a one-SMS summary. Marks
// the rows reviewed so they don't re-appear next week.
async function feedbackReview(req, res, SB) {
  try {
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString()
    const { data: fbs, error } = await SB.from('riker_feedback')
      .select('id, rating, note, user_message, assistant_reply, context, created_at')
      .gte('created_at', weekAgo)
      .eq('reviewed', false)
      .order('created_at', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    if (!fbs || !fbs.length) return res.status(200).json({ ok: true, summary: 'No unreviewed feedback.' })

    const ups = fbs.filter(f => f.rating === 'up').length
    const downs = fbs.filter(f => f.rating === 'down')

    let summary = `Riker weekly: ${ups}👍  ${downs.length}👎 this week.`
    if (downs.length) {
      const key = process.env.CLAUDE_KEY
      if (key) {
        try {
          const reviewPrompt = `Jon flagged ${downs.length} Riker turns as "down" this week. For each, you have the user message, Riker's reply, and (sometimes) Jon's note. Identify the 1-3 patterns worth fixing and propose a concrete prompt-rule or tool-behavior change for each. Keep under 160 chars total — it goes in a single SMS to Jon. Lead with the most actionable.

${downs.map((d, i) => `#${i+1} user:"${(d.user_message||'').slice(0,120)}" riker:"${(d.assistant_reply||'').slice(0,120)}"${d.note?` jon said:"${d.note.slice(0,120)}"`:''}`).join('\n\n')}`
          const res2 = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
              model: 'claude-sonnet-4-6',
              max_tokens: 300,
              messages: [{ role: 'user', content: reviewPrompt }]
            })
          })
          if (res2.ok) {
            const d2 = await res2.json()
            const txt = (d2.content?.[0]?.text || '').trim()
            if (txt) summary += '\n\n' + txt
          }
        } catch (e) { /* best effort */ }
      }
    }

    // Send to Jon
    const sid = process.env.TWILIO_ACCOUNT_SID
    const token = process.env.TWILIO_AUTH_TOKEN
    const from = process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_FROM_NUMBER
    if (sid && token && from) {
      try {
        const auth = Buffer.from(sid + ':' + token).toString('base64')
        await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: 'POST',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ To: '+12149944799', From: from, Body: summary }).toString()
        })
      } catch (e) { console.error('[feedback-review] sms send:', e.message) }
    }

    // Mark rows reviewed
    await SB.from('riker_feedback').update({ reviewed: true }).in('id', fbs.map(f => f.id))

    return res.status(200).json({ ok: true, ups, downs: downs.length, summary })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}

async function autoReschedule(req, res, SB) {
  const now = new Date()
  const log = []

  try {
    const { data: techs } = await SB.from('techs').select('id, name').ilike('name', '%jon%').limit(1)
    const jonId = techs?.[0]?.id || null

    // 1. Don't re-propose jobs Jon hasn't answered yet.
    const { data: openPending } = await SB
      .from('pending_confirmations')
      .select('proposed_action, created_at, expires_at, status')
      .eq('status', 'pending')
      .gt('expires_at', now.toISOString())
    const alreadyProposedSources = new Set()
    ;(openPending || []).forEach(p => {
      const a = p.proposed_action
      if (a?.type === 'auto_schedule_batch' && Array.isArray(a.jobs)) {
        a.jobs.forEach(j => { if (j.source_job_id) alreadyProposedSources.add(j.source_job_id) })
      }
    })

    // 2. Pull candidate completions. Compliance windows per Jon:
    //    Suppression (semi-annual): performed between day 165 and 180;
    //    grace = end-of-month containing day 180.
    //    Extinguishers (annual): performed between day 335 and 365;
    //    grace = end-of-month containing day 365.
    //
    //    Riker should propose ~1 week before the window opens, so the
    //    starting filter is completed ≥ (cycleStart - 10) days ago. We
    //    drop anything whose grace window has already passed (those are
    //    now overdue and handled by the overdue flow, not auto-reschedule).
    const suppStartCutoff = addDays(now, -(165 - 10))  // propose from day 155
    const extStartCutoff = addDays(now, -(335 - 10))   // propose from day 325

    const { data: suppJobs, error: suppErr } = await SB.from('jobs')
      .select('id, location_id, billing_account_id, contract_id, scope, completed_at')
      .eq('status', 'completed').contains('scope', ['suppression'])
      .lte('completed_at', suppStartCutoff.toISOString())
    if (suppErr) log.push({ error: 'suppression query failed', detail: suppErr.message })

    const { data: extJobs, error: extErr } = await SB.from('jobs')
      .select('id, location_id, billing_account_id, contract_id, scope, completed_at')
      .eq('status', 'completed').contains('scope', ['extinguishers'])
      .not('scope', 'cs', '{"suppression"}')  // don't double-count combos
      .lte('completed_at', extStartCutoff.toISOString())
    if (extErr) log.push({ error: 'extinguisher query failed', detail: extErr.message })

    const candidates = [
      ...(suppJobs || []).map(j => ({ ...j, _cycle: 'suppression', _cycleStart: 165, _cycleEnd: 180 })),
      ...(extJobs || []).map(j => ({ ...j, _cycle: 'extinguisher', _cycleStart: 335, _cycleEnd: 365 }))
    ]

    // 3. Resolve locations for filtering + display.
    const locIds = [...new Set(candidates.map(j => j.location_id))]
    const { data: locs } = locIds.length
      ? await SB.from('locations').select('id, name, address, city').in('id', locIds).is('deleted_at', null)
      : { data: [] }
    const locMap = Object.fromEntries((locs || []).map(l => [l.id, l]))

    // 4. Keep only the most-recent completion per (location, cycle) so we don't
    //    propose twice for a location that has multiple historical completions.
    const latestBySource = new Map()
    for (const c of candidates) {
      const k = c.location_id + '|' + c._cycle
      const cur = latestBySource.get(k)
      if (!cur || c.completed_at > cur.completed_at) latestBySource.set(k, c)
    }

    // 5. Build proposals.
    const proposals = []
    for (const c of latestBySource.values()) {
      const loc = locMap[c.location_id]
      if (!loc) { skipped('no location', c); continue }
      const name = (loc.name || '').toUpperCase()
      if (name.includes('TEST') || name.includes('DEMO') || name.includes('SAMPLE')) { skipped('test entry', c, loc); continue }
      if (!String(loc.address || '').match(/\d/)) { skipped('no street number', c, loc); continue }
      if (alreadyProposedSources.has(c.id)) { skipped('already in open proposal', c, loc); continue }

      // Compliance windows:
      //   windowStart = completed + cycleStart days   (day 165 supp / 335 ext)
      //   windowEnd   = completed + cycleEnd days     (day 180 supp / 365 ext)
      //   graceEnd    = end-of-month(windowEnd)       (Jon's in-practice buffer)
      const windowStart = addDays(c.completed_at, c._cycleStart)
      const windowEnd = addDays(c.completed_at, c._cycleEnd)
      const graceEnd = endOfMonth(windowEnd)

      // If the grace window has already passed, this isn't an auto-reschedule
      // candidate — it's an overdue job. Skip.
      if (now > graceEnd) { skipped('past grace window — overdue flow', c, loc); continue }

      const pick = pickTargetDate(windowStart, windowEnd, graceEnd)
      const targetDateStr = pick.date
      const targetTier = pick.tier  // 'window' or 'grace'

      // Skip if a next-cycle job already exists anywhere in the compliance window.
      const { data: existing } = await SB.from('jobs')
        .select('id').eq('location_id', c.location_id)
        .gte('scheduled_date', ymd(windowStart)).lte('scheduled_date', ymd(graceEnd))
        .in('status', ['scheduled', 'completed', 'en_route', 'active']).limit(1)
      if (existing && existing.length) { skipped('already scheduled in window', c, loc); continue }

      // Carry line-item template + estimated value from previous invoice.
      let lineTemplate = null, estimatedValue = null
      const { data: oldInv } = await SB.from('invoices').select('id').eq('job_id', c.id).is('deleted_at', null).limit(1).maybeSingle()
      if (oldInv?.id) {
        const { data: lines } = await SB.from('invoice_lines')
          .select('description, quantity, unit_price, total, sort_order')
          .eq('invoice_id', oldInv.id).is('deleted_at', null).order('sort_order')
        if (lines && lines.length) {
          lineTemplate = lines.map(l => `${l.quantity}x ${l.description} @ $${l.unit_price}`).join(' | ')
          estimatedValue = lines.reduce((s, l) => s + parseFloat(l.total || 0), 0)
        }
      }

      proposals.push({
        source_job_id: c.id,
        location_id: c.location_id,
        location_name: loc.name,
        location_city: loc.city || '',
        billing_account_id: c.billing_account_id,
        contract_id: c.contract_id,
        scope: c.scope,
        cycle: c._cycle,
        scheduled_date: targetDateStr,
        target_tier: targetTier,
        window_start: ymd(windowStart),
        window_end: ymd(windowEnd),
        grace_end: ymd(graceEnd),
        assigned_to: jonId,
        estimated_value: estimatedValue,
        notes: `Auto-proposed from job ${c.id} (${c._cycle}, window ${ymd(windowStart)}–${ymd(windowEnd)}, grace ${ymd(graceEnd)})${lineTemplate ? '\nPrevious line items: ' + lineTemplate : ''}`
      })
    }

    function skipped(reason, c, loc) {
      log.push({ skipped: true, reason, location_id: c.location_id, location_name: loc?.name, source_job_id: c.id, cycle: c._cycle })
    }

    if (!proposals.length) {
      return res.status(200).json({ success: true, summary: { ran_at: now.toISOString(), proposals: 0 }, log })
    }

    // 6. Persist the batch as a pending_confirmation.
    const expires = new Date(now.getTime() + 72 * 3600 * 1000).toISOString()
    const digestLines = proposals.map((p, i) =>
      `${i + 1}. ${p.location_name}${p.location_city ? ' · ' + p.location_city : ''}` +
      ` — ${p.cycle === 'suppression' ? 'supp' : 'ext'} ${p.scheduled_date}` +
      (p.target_tier === 'grace' ? ' [grace]' : '') +
      (p.estimated_value ? ` ($${Math.round(p.estimated_value)})` : '')
    )
    const digestBody = `Riker proposes ${proposals.length} job${proposals.length === 1 ? '' : 's'}:\n\n${digestLines.join('\n')}\n\nReply YES to schedule all, NO to skip. Expires in 72h.`

    const { data: pending, error: pErr } = await SB.from('pending_confirmations').insert({
      source_channel: 'internal',
      proposed_action: { type: 'auto_schedule_batch', jobs: proposals },
      proposed_reply: `OK, scheduled ${proposals.length} inspections.`,
      expires_at: expires,
      status: 'pending'
    }).select().single()
    if (pErr) return res.status(500).json({ error: 'pending insert failed: ' + pErr.message, log })

    // 7. Text Jon the digest.
    try {
      await sendSMSToJon(digestBody)
    } catch (e) {
      log.push({ error: 'sms send failed', detail: e.message, pending_id: pending.id })
    }

    return res.status(200).json({
      success: true,
      summary: {
        ran_at: now.toISOString(),
        proposals: proposals.length,
        pending_id: pending.id,
        expires_at: expires
      },
      proposals,
      log
    })

  } catch (err) {
    return res.status(500).json({ error: err.message, log })
  }
}

// ═══════════════════════════════════════════════════════════════
// DEPARTURE CHECK — Every 5 min during work hours
// Reads Jon's GPS beacon, computes drive time to next job,
// texts him when it's time to leave. Fires once per job.
// ═══════════════════════════════════════════════════════════════
async function runDepartureCheck(SB) {
  const key = process.env.GOOGLE_MAPS_API_KEY
  const now = new Date()

  // Work hours only: 5 AM – 9 PM Central
  const hourCST = parseInt(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Chicago' }), 10)
  if (hourCST < 5 || hourCST >= 21) return { skipped: 'outside work hours' }

  const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }) // YYYY-MM-DD

  // Today's scheduled jobs that haven't had a departure alert yet
  const { data: jobs, error: jobsErr } = await SB.from('jobs')
    .select('id, scheduled_time, departure_alert_sent_at, location:locations(name, address, city, state, zip)')
    .eq('status', 'scheduled')
    .eq('scheduled_date', todayStr)
    .is('departure_alert_sent_at', null)
    .order('scheduled_time')
  if (jobsErr) throw new Error('jobs query: ' + jobsErr.message)
  if (!jobs || !jobs.length) return { ok: true, checked: 0, alerted: 0 }

  // Jon's current GPS — use if fresh (< 15 min)
  const { data: jonLoc } = await SB.from('jon_location')
    .select('lat, lng, updated_at').eq('id', 1).maybeSingle()
  let originAddr = '3801 Alder Trail, Euless, TX 76040'
  if (jonLoc && jonLoc.lat && jonLoc.lng) {
    const ageMin = (Date.now() - new Date(jonLoc.updated_at).getTime()) / 60000
    if (ageMin < 15) originAddr = `${jonLoc.lat},${jonLoc.lng}`
  }

  const alerted = []

  for (const job of jobs) {
    const loc = job.location
    if (!loc) continue
    const destAddr = [loc.address, loc.city, loc.state || 'TX', loc.zip].filter(Boolean).join(', ')
    if (!destAddr || !/\d/.test(destAddr)) continue

    // Parse scheduled time as CST Date
    const [h, m] = (job.scheduled_time || '09:00:00').split(':').map(Number)
    const schedMs = new Date(now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }) + `T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`)
      .getTime() + (now.getTimezoneOffset() + (-300)) * 60000  // offset to CST

    // Approximate: rebuild scheduled time in CST
    const schedCST = new Date(now)
    schedCST.setHours(h, m, 0, 0)
    // adjust from local tz to CST
    const localOffsetMin = schedCST.getTimezoneOffset()
    const cstOffsetMin = 300 // UTC-5 (CDT) or 360 (CST); close enough for scheduling
    const schedUTC = schedCST.getTime() + (localOffsetMin - cstOffsetMin) * 60000
    const schedDate = new Date(schedUTC)

    // Get drive time via Distance Matrix
    let driveMin = 30
    if (key) {
      try {
        const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(originAddr)}&destinations=${encodeURIComponent(destAddr)}&departure_time=now&key=${key}`
        const r = await fetch(url)
        const d = await r.json()
        const el = d.rows?.[0]?.elements?.[0]
        if (el?.status === 'OK') {
          driveMin = Math.ceil((el.duration_in_traffic?.value || el.duration.value) / 60)
        }
      } catch {}
    }

    const leaveByMs = schedDate.getTime() - (driveMin + 10) * 60000
    const alertWindowStartMs = leaveByMs - 15 * 60000
    const nowMs = now.getTime()
    const lateGraceMs = schedDate.getTime() + 30 * 60000

    if (nowMs < alertWindowStartMs || nowMs > lateGraceMs) continue

    const isLate = nowMs > schedDate.getTime()
    const schedTimeStr = new Date(schedDate).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })
    const leaveStr = new Date(leaveByMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })
    const minsToLeave = Math.max(0, Math.round((leaveByMs - nowMs) / 60000))

    let msg
    if (isLate) {
      msg = `⏰ Running late — ${loc.name} (${loc.city}) was at ${schedTimeStr}. ${driveMin}min drive from current location.`
    } else if (minsToLeave <= 2) {
      msg = `⏰ Leave NOW for ${loc.name}, ${loc.city} — ${driveMin}min drive, appt at ${schedTimeStr}.`
    } else {
      msg = `⏰ Leave in ${minsToLeave} min for ${loc.name}, ${loc.city}. ${driveMin}min drive → ${schedTimeStr}. Leave by ${leaveStr}.`
    }

    await sendSMSToJon(msg)
    await SB.from('jobs').update({ departure_alert_sent_at: new Date().toISOString() }).eq('id', job.id)
    alerted.push({ job_id: job.id, location: loc.name, msg })
  }

  return { ok: true, checked: jobs.length, alerted: alerted.length, alerts: alerted }
}
