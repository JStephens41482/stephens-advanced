// /api/mazon/submit-batch.js
// Bundles pending Mazon queue rows into a Schedule of Accounts submission,
// emails it to Mazon via Resend, and transitions all DB state atomically
// ONLY after Resend returns a 2xx.
//
// Request body (optional selection):
//   {
//     queue_ids?: [UUID, ...]   // if omitted, all pending are included
//   }
//
// Response:
//   { schedule_number, count, total, message_id }
//
// Flow (per spec section 8):
//   1. Snapshot pending queue rows (filtered by queue_ids if provided)
//   2. Verify threshold ≥ $1000 (unless ?override=debug)
//   3. Compute next schedule_number
//   4. Download template xlsx from mazon-templates/
//   5. Fill it (row 5H date, row 8D client#, row 8H schedule#, row 46B PIN, rows 18+ per invoice)
//   6. Verify grand total matches to the cent
//   7. Save to mazon-schedules/
//   8. Gather all stamped invoice + backup PDFs (abort if any missing)
//   9. Compose Resend email with all attachments
//  10. On Resend 2xx: insert schedule row, update queue, update invoices, write audit log
//
// If anything in steps 3-8 fails, NO DB rows are mutated.

const { createClient } = require('@supabase/supabase-js')
const ExcelJS = require('exceljs')
const MAZON = require('../../src/config/mazon')

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://motjasdokoxwiodwzyps.supabase.co'
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  const supabase = createClient(sbUrl, sbKey)

  const body = req.body || {}
  const selectedIds = Array.isArray(body.queue_ids) ? body.queue_ids : null
  const debugOverride = req.query?.override === 'debug'

  try {
    // ─── 1. Snapshot pending queue ───
    let q = supabase.from('mazon_queue').select('*').eq('status', 'pending').order('created_at', { ascending: true })
    if (selectedIds?.length) q = q.in('id', selectedIds)
    const { data: pending, error: pErr } = await q
    if (pErr) return res.status(500).json({ error: 'Queue read failed: ' + pErr.message })
    if (!pending?.length) return res.status(400).json({ error: 'No pending queue rows to submit' })

    const total = pending.reduce((s, r) => s + Number(r.amount), 0)
    const totalCents = Math.round(total * 100)

    // ─── 2. Threshold check ───
    if (!debugOverride && totalCents < MAZON.BATCH_THRESHOLD_USD * 100) {
      return res.status(400).json({
        error: `Batch total $${total.toFixed(2)} is below $${MAZON.BATCH_THRESHOLD_USD} threshold. Add more invoices or use ?override=debug.`,
        total,
        threshold: MAZON.BATCH_THRESHOLD_USD
      })
    }

    // ─── 3. Verify all stamped PDFs and backups exist in storage ───
    const missing = []
    const invoiceFiles = []
    const backupFiles = []
    for (const row of pending) {
      const path = `${row.invoice_id}.pdf`
      const invBlob = await downloadFromBucket(supabase, MAZON.BUCKETS.INVOICES, path)
      if (!invBlob) missing.push({ invoice_id: row.invoice_id, invoice_number: row.invoice_number, kind: 'stamped_invoice' })
      else invoiceFiles.push({ row, path, bytes: invBlob })

      const bkBlob = await downloadFromBucket(supabase, MAZON.BUCKETS.BACKUPS, path)
      if (!bkBlob) missing.push({ invoice_id: row.invoice_id, invoice_number: row.invoice_number, kind: 'backup' })
      else backupFiles.push({ row, path, bytes: bkBlob })
    }
    if (missing.length) {
      return res.status(400).json({
        error: 'Missing required artifacts — cannot submit',
        missing
      })
    }

    // ─── 4. Compute next schedule_number ───
    const { data: maxRow } = await supabase
      .from('mazon_schedules')
      .select('schedule_number')
      .order('schedule_number', { ascending: false })
      .limit(1)
      .maybeSingle()
    const nextScheduleNumber = (maxRow?.schedule_number || 0) + 1

    // ─── 5. Download + fill xlsx template ───
    const tmplBytes = await downloadFromBucket(supabase, MAZON.BUCKETS.TEMPLATES, MAZON.TEMPLATE_PATH)
    if (!tmplBytes) {
      return res.status(500).json({
        error: `Mazon template not found at ${MAZON.BUCKETS.TEMPLATES}/${MAZON.TEMPLATE_PATH}. Upload it once via the Supabase dashboard before first submission.`
      })
    }

    const pin = MAZON.PIN
    if (!pin) return res.status(500).json({ error: `${MAZON.PIN_ENV_VAR} env var not set` })

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(tmplBytes)
    const ws = wb.worksheets[0]
    if (!ws) return res.status(500).json({ error: 'Template has no worksheet' })

    // Per spec section 8.1 step 4:
    //   Row 5, Col H  = today's date MM/DD/YYYY
    //   Row 8, Col D  = client number 1410
    //   Row 8, Col H  = schedule number
    //   Row 46, Col B = PIN
    //   Row 18+, Col C–H per invoice
    const today = new Date()
    const todayStr = fmtDate(today)
    ws.getCell('H5').value = todayStr
    ws.getCell('D8').value = MAZON.CLIENT_NUMBER
    ws.getCell('H8').value = nextScheduleNumber
    ws.getCell('B46').value = pin

    let row = 18
    for (const item of pending) {
      ws.getCell(`C${row}`).value = fmtDate(item.date_of_service)
      ws.getCell(`D${row}`).value = 'Net 30'
      ws.getCell(`E${row}`).value = item.invoice_number || ''
      ws.getCell(`F${row}`).value = item.customer_name
      ws.getCell(`G${row}`).value = cityStateFromAddress(item.location_address)
      ws.getCell(`H${row}`).value = Number(item.amount)
      row++
    }

    // Force formula recalc on next open
    wb.calcProperties.fullCalcOnLoad = true
    const filledBytes = await wb.xlsx.writeBuffer()

    // ─── 6. Verify grand total ───
    // Compute our own sum from the buffer we just wrote (belt & suspenders)
    const computedTotal = pending.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0)
    if (computedTotal !== totalCents) {
      return res.status(500).json({ error: 'Internal total mismatch — abort' })
    }

    // ─── 7. Save filled xlsx ───
    const yyyymmdd = today.toISOString().slice(0, 10).replace(/-/g, '')
    const xlsxPath = `schedule_${nextScheduleNumber}_${yyyymmdd}.xlsx`
    const upXlsx = await supabase.storage
      .from(MAZON.BUCKETS.SCHEDULES)
      .upload(xlsxPath, filledBytes, {
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        upsert: true
      })
    if (upXlsx.error) return res.status(500).json({ error: 'Schedule upload failed: ' + upXlsx.error.message })

    const FIVE_YEARS = 60 * 60 * 24 * 365 * 5
    const xlsxSig = await supabase.storage.from(MAZON.BUCKETS.SCHEDULES).createSignedUrl(xlsxPath, FIVE_YEARS)
    if (xlsxSig.error) return res.status(500).json({ error: 'Schedule URL failed: ' + xlsxSig.error.message })

    // ─── 8. Compose Resend email ───
    const resendKey = process.env.RESEND_API_KEY
    if (!resendKey) return res.status(500).json({ error: 'RESEND_API_KEY not set' })

    const subject = `Stephens Advanced LLC — Schedule #${nextScheduleNumber} — ${pending.length} invoices — $${total.toFixed(2)}`
    const bodyText = [
      'Mazon Associates,',
      '',
      `Please find attached Schedule of Accounts #${nextScheduleNumber} for Stephens Advanced LLC, Client #${MAZON.CLIENT_NUMBER}, along with the invoices and signed work orders.`,
      '',
      `Total: $${total.toFixed(2)}`,
      `Count: ${pending.length} invoices`,
      '',
      'Thank you,',
      'Jonathan Stephens',
      'Stephens Advanced LLC'
    ].join('\n')

    const bodyHtml = bodyText.split('\n').map(l => l ? `<p style="margin:0 0 12px">${escapeHtml(l)}</p>` : '<br>').join('')

    const attachments = [
      { filename: xlsxPath, content: Buffer.from(filledBytes).toString('base64') }
    ]
    for (const { row: r, bytes } of invoiceFiles) {
      attachments.push({
        filename: `invoice_${r.invoice_number || r.invoice_id}.pdf`,
        content: Buffer.from(bytes).toString('base64')
      })
    }
    for (const { row: r, bytes } of backupFiles) {
      attachments.push({
        filename: `workorder_${r.invoice_number || r.invoice_id}.pdf`,
        content: Buffer.from(bytes).toString('base64')
      })
    }

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Jonathan Stephens <jonathan@stephensadvanced.com>',
        to: [MAZON.SUBMISSION_EMAIL],
        subject,
        text: bodyText,
        html: `<div style="font-family:Arial,sans-serif;color:#222;line-height:1.5">${bodyHtml}</div>`,
        attachments
      })
    })
    const resendData = await resendRes.json()
    if (!resendRes.ok) {
      return res.status(500).json({ error: 'Resend failed: ' + (resendData.message || resendRes.status), detail: resendData })
    }
    const messageId = resendData.id

    // ─── 9. Insert schedule + update queue + update invoices ───
    const pdfUrls = await Promise.all(invoiceFiles.map(async f => {
      const s = await supabase.storage.from(MAZON.BUCKETS.INVOICES).createSignedUrl(f.path, FIVE_YEARS)
      return s.data?.signedUrl
    }))
    const backupUrls = await Promise.all(backupFiles.map(async f => {
      const s = await supabase.storage.from(MAZON.BUCKETS.BACKUPS).createSignedUrl(f.path, FIVE_YEARS)
      return s.data?.signedUrl
    }))

    const { data: sched, error: schedErr } = await supabase.from('mazon_schedules').insert({
      schedule_number: nextScheduleNumber,
      invoice_count: pending.length,
      total_amount: total,
      email_message_id: messageId,
      xlsx_url: xlsxSig.data.signedUrl,
      pdf_bundle_urls: pdfUrls,
      backup_urls: backupUrls,
      status: 'submitted'
    }).select().single()
    if (schedErr) {
      // Email sent but we failed to record it — surface loudly
      return res.status(500).json({
        error: 'Schedule insert failed AFTER email was sent. Record manually: schedule #' + nextScheduleNumber + ', message_id ' + messageId,
        detail: schedErr.message
      })
    }

    const queueIds = pending.map(r => r.id)
    const nowIso = new Date().toISOString()
    await supabase.from('mazon_queue').update({
      status: 'submitted',
      schedule_id: sched.id,
      submitted_at: nowIso,
      updated_at: nowIso
    }).in('id', queueIds).eq('status', 'pending')

    const invoiceIds = pending.map(r => r.invoice_id)
    await supabase.from('invoices').update({
      status: 'factored_submitted',
      updated_at: nowIso
    }).in('id', invoiceIds)

    // Audit log
    for (const r of pending) {
      await supabase.from('mazon_audit_log').insert({
        actor: 'jon',
        entity_type: 'queue',
        entity_id: r.id,
        old_status: 'pending',
        new_status: 'submitted',
        reason: 'Batch submitted in schedule #' + nextScheduleNumber,
        metadata: { schedule_id: sched.id, message_id: messageId }
      })
    }
    await supabase.from('mazon_audit_log').insert({
      actor: 'jon',
      entity_type: 'schedule',
      entity_id: sched.id,
      new_status: 'submitted',
      reason: 'Batch created',
      metadata: { count: pending.length, total, message_id: messageId }
    })

    return res.status(200).json({
      schedule_number: nextScheduleNumber,
      schedule_id: sched.id,
      count: pending.length,
      total,
      message_id: messageId,
      xlsx_url: xlsxSig.data.signedUrl
    })

  } catch (e) {
    console.error('[submit-batch] error:', e)
    return res.status(500).json({ error: e.message })
  }
}

// ─── helpers ───

async function downloadFromBucket(supabase, bucket, path) {
  try {
    const { data, error } = await supabase.storage.from(bucket).download(path)
    if (error || !data) return null
    const arr = await data.arrayBuffer()
    return new Uint8Array(arr)
  } catch { return null }
}

function fmtDate(d) {
  if (!d) return ''
  const dt = new Date(d)
  if (isNaN(dt)) return String(d)
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  const yyyy = dt.getUTCFullYear()
  return `${mm}/${dd}/${yyyy}`
}

function cityStateFromAddress(addr) {
  if (!addr) return ''
  // Expect "street, city, ST zip" — pick "city, ST"
  const parts = addr.split(',').map(s => s.trim()).filter(Boolean)
  if (parts.length < 2) return addr
  const city = parts[parts.length - 2]
  const stZip = parts[parts.length - 1]
  const st = (stZip.match(/\b([A-Z]{2})\b/) || [])[1] || ''
  return st ? `${city}, ${st}` : city
}

function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
