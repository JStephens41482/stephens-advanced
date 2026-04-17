// /api/riker-proactive.js
// Cron-driven Riker behaviors — the things Riker does without being asked.
//
//   - ai-morning-brief: AI-authored daily summary email to Jon at 6 AM CDT
//   - invoice-aging: SMS/email reminders at 7/14/30 days past due
//   - compliance-alerts: 30/14/7-day advance warnings for upcoming semi-
//     annual, annual, and hydrostatic service
//   - memory-prune: archive expired / stale notebook entries
//
// Called by /api/cron?job=<name>. Each function is idempotent per day.

const core = require('./riker-core')
const memory = require('./riker-memory')
const { sendSMS, sendEmail, JON_PHONE } = require('./riker-actions')

const JON_EMAIL = 'jonathan@stephensadvanced.com'

// ═══════════════════════════════════════════════════════════════
// 1. AI-AUTHORED MORNING BRIEF
// ═══════════════════════════════════════════════════════════════

async function morningBrief(supabase) {
  const instruction = `Write Jon's morning brief for today as a short, direct email he can read on his phone in 30 seconds. Use the LIVE_DATA in your context — today's jobs, overdue items, unpaid total — plus anything you see in the NOTEBOOK worth flagging.

Structure (plain paragraphs, no markdown, no bullet lists):
- Open with "Good morning, Jon." and today's day + date.
- State the first job: time, business name, city, scope. If there's anything in the notebook for that location (preference, equipment note, pending item, gate code), weave it in naturally.
- Brief tour of the rest of the day in order. One line per job max.
- Any overdue jobs or aging invoices worth naming.
- One proactive suggestion if you see something worth surfacing (nearby opportunity, upcoming compliance date, something in the notebook that's time-sensitive).
- End with "— Riker".

Keep the whole thing under 200 words. Do not use bullet points or numbered lists. Just paragraphs.`

  const result = await core.generateProactive({
    supabase,
    context: 'app',
    identity: {},
    instruction
  })

  const briefText = (result.reply || '').trim()
  if (!briefText) throw new Error('morning brief: empty reply from Riker')

  // Email it
  const apiKey = process.env.RESEND_API_KEY
  if (apiKey) {
    const html = briefText.split('\n\n').map(p => `<p style="margin:0 0 14px 0;line-height:1.55">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')
    const body = {
      from: 'Riker <jonathan@stephensadvanced.com>',
      to: [JON_EMAIL],
      subject: `Morning brief — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`,
      html: `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;color:#1a1a2e;padding:20px">${html}<p style="margin-top:20px;text-align:center"><a href="https://stephensadvanced.com/app" style="background:#f05a28;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700">Open app</a></p></div>`,
      text: briefText
    }
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  }

  return { ok: true, chars: briefText.length, cost: result.cost || 0 }
}

// ═══════════════════════════════════════════════════════════════
// 2. INVOICE AGING REMINDERS
// ═══════════════════════════════════════════════════════════════

async function invoiceAging(supabase) {
  const today = new Date().toISOString().split('T')[0]
  const stages = [
    { days: 7, tone: 'friendly', memoryPriority: 5 },
    { days: 14, tone: 'firm', memoryPriority: 7 },
    { days: 30, tone: 'urgent', memoryPriority: 9 }
  ]

  const results = { sent: 0, skipped: 0, errors: [] }

  for (const stage of stages) {
    const cutoff = new Date(Date.now() - stage.days * 86400000).toISOString().split('T')[0]
    const { data: invoices } = await supabase
      .from('invoices')
      .select('id, invoice_number, total, date, location:locations(id, name, contact_name, contact_phone, contact_email, sms_opt_in), billing_account_id')
      .not('status', 'in', '(paid,void,record,factored)')
      .eq('date', cutoff)

    for (const inv of (invoices || [])) {
      const loc = inv.location
      if (!loc) { results.skipped++; continue }

      // De-dup via memory: have we already sent this stage for this invoice?
      const tag = `invoice_aging_${stage.days}d_${inv.id}`
      const { data: already } = await supabase
        .from('riker_memory')
        .select('id').eq('archived', false).eq('content', tag).maybeSingle()
      if (already) { results.skipped++; continue }

      // Ask Riker to draft the message
      const instruction = `Draft a ${stage.tone} payment reminder for ${loc.name}. Invoice ${inv.invoice_number} for $${Number(inv.total).toFixed(2)} is ${stage.days} days past invoice date. ${stage.days === 7 ? 'First reminder — be warm.' : stage.days === 14 ? 'Second reminder — firmer but still polite.' : 'Final reminder — direct, mention we may need to pause service.'} Keep it under 40 words for SMS. If no SMS opt-in, write for email instead (under 100 words). Do NOT issue any actions — just draft the text to send.`

      let result
      try {
        result = await core.generateProactive({
          supabase, context: 'app',
          identity: { location_id: loc.id, billing_account_id: inv.billing_account_id },
          instruction
        })
      } catch (e) {
        results.errors.push({ invoice: inv.invoice_number, error: e.message })
        continue
      }

      const text = (result.reply || '').trim()
      if (!text) { results.errors.push({ invoice: inv.invoice_number, error: 'empty draft' }); continue }

      // Send via preferred channel
      try {
        if (loc.sms_opt_in && loc.contact_phone) {
          await sendSMS(loc.contact_phone, text)
        } else if (loc.contact_email) {
          await sendEmail({
            to: loc.contact_email,
            subject: `Invoice ${inv.invoice_number} — ${stage.days === 30 ? 'final notice' : 'payment reminder'}`,
            body: text + '\n\n— Jon, Stephens Advanced'
          })
        } else {
          // No channel; tell Jon instead
          await sendSMS(JON_PHONE, `Aging ${stage.days}d: ${loc.name} owes $${Number(inv.total).toFixed(2)} on ${inv.invoice_number}. No customer contact on file.`)
        }
      } catch (e) {
        results.errors.push({ invoice: inv.invoice_number, error: 'send: ' + e.message })
        continue
      }

      // Log in memory so we don't double-send
      await memory.writeMemory(supabase, {
        scope: 'location',
        location_id: loc.id,
        billing_account_id: inv.billing_account_id,
        category: 'billing',
        content: tag,
        priority: stage.memoryPriority,
        expires_at: new Date(Date.now() + 45 * 86400000).toISOString()
      }, { source: 'cron:invoice_aging' })

      results.sent++
    }
  }

  return results
}

// ═══════════════════════════════════════════════════════════════
// 3. COMPLIANCE ALERTS
// ═══════════════════════════════════════════════════════════════

async function complianceAlerts(supabase) {
  const today = new Date()
  const windows = [
    { days: 30, priority: 6 },
    { days: 14, priority: 8 },
    { days: 7, priority: 10 }
  ]

  const results = { alerts: 0, skipped: 0 }

  for (const win of windows) {
    const target = new Date(today.getTime() + win.days * 86400000).toISOString().split('T')[0]

    // Equipment due on this date
    const [extAnnual, ext6yr, extHydro, supSemi, supHydro, emgAnnual] = await Promise.all([
      supabase.from('extinguishers').select('id, type, size, location:locations(id,name,contact_name,contact_phone,contact_email,sms_opt_in)').eq('next_inspection', target),
      supabase.from('extinguishers').select('id, type, size, location:locations(id,name,contact_name,contact_phone,contact_email,sms_opt_in)').eq('next_6year', target),
      supabase.from('extinguishers').select('id, type, size, location:locations(id,name,contact_name,contact_phone,contact_email,sms_opt_in)').eq('next_hydro', target),
      supabase.from('suppression_systems').select('id, system_type, location:locations(id,name,contact_name,contact_phone,contact_email,sms_opt_in)').eq('next_inspection', target),
      supabase.from('suppression_systems').select('id, system_type, location:locations(id,name,contact_name,contact_phone,contact_email,sms_opt_in)').eq('next_hydro', target),
      supabase.from('emergency_lights').select('id, fixture_count, location:locations(id,name,contact_name,contact_phone,contact_email,sms_opt_in)').eq('next_annual_test', target)
    ])

    const items = [
      ...(extAnnual.data || []).map(e => ({ kind: 'ext_annual', loc: e.location, desc: `${e.type} ${e.size} extinguisher annual` })),
      ...(ext6yr.data || []).map(e => ({ kind: 'ext_6yr', loc: e.location, desc: `${e.type} extinguisher 6-year internal` })),
      ...(extHydro.data || []).map(e => ({ kind: 'ext_hydro', loc: e.location, desc: `${e.type} extinguisher hydrostatic` })),
      ...(supSemi.data || []).map(s => ({ kind: 'sup_semi', loc: s.location, desc: `${s.system_type} semi-annual` })),
      ...(supHydro.data || []).map(s => ({ kind: 'sup_hydro', loc: s.location, desc: `${s.system_type} 12-year hydro` })),
      ...(emgAnnual.data || []).map(e => ({ kind: 'emg_annual', loc: e.location, desc: `emergency lighting annual` }))
    ]

    // Group by location, take one alert per location
    const byLoc = new Map()
    for (const it of items) {
      if (!it.loc) continue
      const cur = byLoc.get(it.loc.id) || { loc: it.loc, items: [] }
      cur.items.push(it.desc)
      byLoc.set(it.loc.id, cur)
    }

    for (const { loc, items: descs } of byLoc.values()) {
      const tag = `compliance_alert_${win.days}d_${loc.id}_${target}`
      const { data: already } = await supabase
        .from('riker_memory').select('id').eq('archived', false).eq('content', tag).maybeSingle()
      if (already) { results.skipped++; continue }

      // Write a notebook entry and (at 14 and 7 day windows) ping Jon
      await memory.writeMemory(supabase, {
        scope: 'location',
        location_id: loc.id,
        category: 'compliance',
        content: `Compliance due ${target} (${win.days}d): ${descs.join('; ')}`,
        priority: win.priority,
        expires_at: new Date(new Date(target).getTime() + 7 * 86400000).toISOString()
      }, { source: 'cron:compliance' })

      await memory.writeMemory(supabase, {
        scope: 'location',
        location_id: loc.id,
        category: 'action_pending',
        content: tag,
        priority: win.priority,
        expires_at: new Date(new Date(target).getTime() + 7 * 86400000).toISOString()
      }, { source: 'cron:compliance' })

      if (win.days <= 14) {
        try {
          await sendSMS(JON_PHONE, `Compliance ${win.days}d — ${loc.name}: ${descs.join(', ')} due ${target}. Want me to reach out to schedule?`)
        } catch (e) { console.error('compliance sms:', e.message) }
      }

      results.alerts++
    }
  }

  return results
}

// ═══════════════════════════════════════════════════════════════
// 4. MEMORY PRUNE
// ═══════════════════════════════════════════════════════════════

async function memoryPrune(supabase) {
  return memory.pruneMemories(supabase)
}

// ─── utils ───

function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

module.exports = {
  morningBrief,
  invoiceAging,
  complianceAlerts,
  memoryPrune
}
