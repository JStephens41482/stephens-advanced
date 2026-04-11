// /api/cron.js — Unified cron handler
// Routes: ?job=morning-digest  (daily 6 AM CDT = 11 UTC)
//         ?job=auto-reschedule (1st of month 3 AM CDT = 8 UTC)

const { createClient } = require('@supabase/supabase-js')

module.exports = async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).end()

  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://motjasdokoxwiodwzyps.supabase.co'
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!sbKey) return res.status(500).json({ error: 'Missing Supabase key' })

  const SB = createClient(sbUrl, sbKey)
  const job = req.query.job || req.url.split('job=')[1]?.split('&')[0]

  if (job === 'morning-digest') return morningDigest(req, res, SB)
  if (job === 'auto-reschedule') return autoReschedule(req, res, SB)
  return res.status(400).json({ error: 'Unknown job. Use ?job=morning-digest or ?job=auto-reschedule' })
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
      .order('scheduled_time', { ascending: true })

    // Get location names
    const locIds = [...new Set((todayJobs || []).map(j => j.location_id))]
    const { data: locs } = locIds.length
      ? await SB.from('locations').select('id, name, address, city').in('id', locIds)
      : { data: [] }
    const locMap = Object.fromEntries((locs || []).map(l => [l.id, l]))

    // Overdue jobs
    const { data: overdueJobs } = await SB
      .from('jobs')
      .select('id, location_id, scheduled_date')
      .eq('status', 'scheduled')
      .lt('scheduled_date', today)

    // Unassigned jobs
    const { data: unassignedJobs } = await SB
      .from('jobs')
      .select('id')
      .eq('status', 'scheduled')
      .is('assigned_to', null)

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
async function autoReschedule(req, res, SB) {
  const now = new Date()
  const log = []

  try {
    // Find Jon's tech ID
    const { data: techs } = await SB.from('techs').select('id, name').ilike('name', '%jon%').limit(1)
    const jonId = techs?.[0]?.id || null

    // SUPPRESSION: completed 5.5–6 months ago
    const supp6mo = new Date(now); supp6mo.setMonth(supp6mo.getMonth() - 6)
    const supp55mo = new Date(now); supp55mo.setMonth(supp55mo.getMonth() - 6); supp55mo.setDate(supp55mo.getDate() + 15)

    const { data: suppJobs, error: suppErr } = await SB
      .from('jobs')
      .select('id, location_id, billing_account_id, contract_id, scope, type, completed_at, notes')
      .eq('status', 'completed')
      .contains('scope', ['suppression'])
      .gte('completed_at', supp6mo.toISOString())
      .lte('completed_at', supp55mo.toISOString())

    if (suppErr) log.push({ error: 'suppression query failed', detail: suppErr.message })

    // EXTINGUISHERS: completed 11.5–12 months ago
    const ext12mo = new Date(now); ext12mo.setMonth(ext12mo.getMonth() - 12)
    const ext115mo = new Date(now); ext115mo.setMonth(ext115mo.getMonth() - 12); ext115mo.setDate(ext115mo.getDate() + 15)

    const { data: extJobs, error: extErr } = await SB
      .from('jobs')
      .select('id, location_id, billing_account_id, contract_id, scope, type, completed_at, notes')
      .eq('status', 'completed')
      .contains('scope', ['extinguishers'])
      .not('scope', 'cs', '{"suppression"}')
      .gte('completed_at', ext12mo.toISOString())
      .lte('completed_at', ext115mo.toISOString())

    if (extErr) log.push({ error: 'extinguisher query failed', detail: extErr.message })

    const allCandidates = [
      ...(suppJobs || []).map(j => ({ ...j, _rebookType: 'suppression', _monthsOut: 6 })),
      ...(extJobs || []).map(j => ({ ...j, _rebookType: 'extinguisher', _monthsOut: 12 }))
    ]

    // Fetch locations for test filtering
    const locIds = [...new Set(allCandidates.map(j => j.location_id))]
    const { data: locs } = locIds.length
      ? await SB.from('locations').select('id, name, address').in('id', locIds)
      : { data: [] }
    const locMap = Object.fromEntries((locs || []).map(l => [l.id, l]))

    const allJobs = allCandidates.filter(j => {
      const loc = locMap[j.location_id]
      if (!loc) return false
      const name = (loc.name || '').toUpperCase()
      const addr = loc.address || ''
      if (name.includes('TEST') || name.includes('DEMO') || name.includes('SAMPLE')) {
        log.push({ skipped: true, location: loc.name, reason: 'test entry' })
        return false
      }
      if (!addr.match(/\d/)) {
        log.push({ skipped: true, location: loc.name, reason: 'no street number in address' })
        return false
      }
      return true
    })

    let created = 0, skipped = 0

    for (const oldJob of allJobs) {
      const targetDate = new Date(oldJob.completed_at)
      targetDate.setMonth(targetDate.getMonth() + oldJob._monthsOut)
      const targetMonthStart = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1)
      const targetMonthEnd = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0)

      const scheduledDate = new Date(targetDate)
      scheduledDate.setDate(scheduledDate.getDate() - 14)
      if (scheduledDate < now) scheduledDate.setTime(now.getTime() + 86400000)

      const { data: existing } = await SB
        .from('jobs')
        .select('id')
        .eq('location_id', oldJob.location_id)
        .gte('scheduled_date', targetMonthStart.toISOString().split('T')[0])
        .lte('scheduled_date', targetMonthEnd.toISOString().split('T')[0])
        .in('status', ['scheduled', 'completed', 'en_route', 'active'])
        .limit(1)

      if (existing && existing.length > 0) {
        skipped++
        log.push({ skipped: true, location_id: oldJob.location_id, reason: 'job already exists for target month' })
        continue
      }

      const { data: newJob, error: insertErr } = await SB
        .from('jobs')
        .insert({
          location_id: oldJob.location_id,
          billing_account_id: oldJob.billing_account_id,
          contract_id: oldJob.contract_id,
          type: 'inspection',
          scope: oldJob.scope,
          status: 'scheduled',
          scheduled_date: scheduledDate.toISOString().split('T')[0],
          technician: 'Jon Stephens',
          assigned_to: jonId,
          notes: `Auto-rescheduled from job ${oldJob.id} (${oldJob._rebookType}, ${oldJob._monthsOut}-month cycle)`
        })
        .select()
        .single()

      if (insertErr) {
        log.push({ error: 'insert failed', location_id: oldJob.location_id, detail: insertErr.message })
        continue
      }

      // Copy line items from old job's invoice
      const { data: oldInvoice } = await SB
        .from('invoices')
        .select('id')
        .eq('job_id', oldJob.id)
        .limit(1)
        .single()

      if (oldInvoice) {
        const { data: oldLines } = await SB
          .from('invoice_lines')
          .select('description, quantity, unit_price, total, sort_order')
          .eq('invoice_id', oldInvoice.id)
          .order('sort_order')

        if (oldLines && oldLines.length > 0) {
          const lineTemplate = oldLines.map(l => `${l.quantity}x ${l.description} @ $${l.unit_price}`).join(' | ')
          await SB
            .from('jobs')
            .update({
              notes: `Auto-rescheduled from job ${oldJob.id} (${oldJob._rebookType}, ${oldJob._monthsOut}-month cycle)\nPrevious line items: ${lineTemplate}`,
              estimated_value: oldLines.reduce((sum, l) => sum + parseFloat(l.total), 0)
            })
            .eq('id', newJob.id)
        }
      }

      created++
      log.push({
        created: true,
        new_job_id: newJob.id,
        location_id: oldJob.location_id,
        type: oldJob._rebookType,
        scheduled_date: scheduledDate.toISOString().split('T')[0],
        from_job: oldJob.id
      })
    }

    return res.status(200).json({
      success: true,
      summary: {
        ran_at: now.toISOString(),
        suppression_candidates: suppJobs?.length || 0,
        extinguisher_candidates: extJobs?.length || 0,
        jobs_created: created,
        jobs_skipped: skipped
      },
      log
    })

  } catch (err) {
    return res.status(500).json({ error: err.message, log })
  }
}
