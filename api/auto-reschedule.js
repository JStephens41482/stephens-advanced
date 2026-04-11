// /api/auto-reschedule.js
// Runs on the 1st of every month via Vercel cron.
// - Looks back 5.5–6 months for completed SUPPRESSION jobs → creates new semi-annual jobs
// - Looks back 11.5–12 months for completed EXTINGUISHER jobs → creates new annual jobs
// - Assigns to Jon, copies line items from last invoice, schedules ~2 weeks before due

const { createClient } = require('@supabase/supabase-js')

module.exports = async function handler(req, res) {
  // Only allow GET (cron) or POST (manual trigger)
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).end()

  // Optional: verify cron secret to prevent unauthorized triggers
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://motjasdokoxwiodwzyps.supabase.co'
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!sbKey) return res.status(500).json({ error: 'Missing Supabase key' })

  const SB = createClient(sbUrl, sbKey)

  const now = new Date()
  const log = []

  try {
    // ─── Find Jon's tech ID ───
    const { data: techs } = await SB.from('techs').select('id, name').ilike('name', '%jon%').limit(1)
    const jonId = techs?.[0]?.id || null

    // ─── SUPPRESSION: completed 5.5–6 months ago ───
    const supp6mo = new Date(now)
    supp6mo.setMonth(supp6mo.getMonth() - 6)
    const supp55mo = new Date(now)
    supp55mo.setMonth(supp55mo.getMonth() - 6)
    supp55mo.setDate(supp55mo.getDate() + 15) // 5.5 months = 6 months minus ~15 days

    const { data: suppJobs, error: suppErr } = await SB
      .from('jobs')
      .select('id, location_id, billing_account_id, contract_id, scope, type, completed_at, notes')
      .eq('status', 'completed')
      .contains('scope', ['suppression'])
      .gte('completed_at', supp6mo.toISOString())
      .lte('completed_at', supp55mo.toISOString())

    if (suppErr) log.push({ error: 'suppression query failed', detail: suppErr.message })

    // ─── EXTINGUISHERS: completed 11.5–12 months ago ───
    const ext12mo = new Date(now)
    ext12mo.setMonth(ext12mo.getMonth() - 12)
    const ext115mo = new Date(now)
    ext115mo.setMonth(ext115mo.getMonth() - 12)
    ext115mo.setDate(ext115mo.getDate() + 15) // 11.5 months

    const { data: extJobs, error: extErr } = await SB
      .from('jobs')
      .select('id, location_id, billing_account_id, contract_id, scope, type, completed_at, notes')
      .eq('status', 'completed')
      .contains('scope', ['extinguishers'])
      .not('scope', 'cs', '{"suppression"}') // skip jobs that ALSO had suppression (those are caught above)
      .gte('completed_at', ext12mo.toISOString())
      .lte('completed_at', ext115mo.toISOString())

    if (extErr) log.push({ error: 'extinguisher query failed', detail: extErr.message })

    // ─── Filter out test jobs and jobs with incomplete addresses ───
    const isReal = (j) => {
      // Get location name to check for test entries
      return true // location filtering happens below after we fetch location names
    }

    const allCandidates = [
      ...(suppJobs || []).map(j => ({ ...j, _rebookType: 'suppression', _monthsOut: 6 })),
      ...(extJobs || []).map(j => ({ ...j, _rebookType: 'extinguisher', _monthsOut: 12 }))
    ]

    // Fetch location names for test filtering
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
      // Skip test entries and locations with no real street address
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

    let created = 0
    let skipped = 0

    for (const oldJob of allJobs) {
      // ─── Check if a job already exists for this location in the target month ───
      const targetDate = new Date(oldJob.completed_at)
      targetDate.setMonth(targetDate.getMonth() + oldJob._monthsOut)
      const targetMonthStart = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1)
      const targetMonthEnd = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0)

      // Schedule 2 weeks before the exact due date (buffer)
      const scheduledDate = new Date(targetDate)
      scheduledDate.setDate(scheduledDate.getDate() - 14)
      // But not in the past
      if (scheduledDate < now) scheduledDate.setTime(now.getTime() + 86400000) // tomorrow

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

      // ─── Create the new job ───
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

      // ─── Copy line items from the old job's invoice ───
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
          // Store as job notes or a reference — the actual invoice gets created at completion
          // We'll store the template in the notes so the app can pre-populate
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
