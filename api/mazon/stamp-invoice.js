// /api/mazon/stamp-invoice.js
// Atomic "add invoice to Mazon queue" endpoint. Does everything in one
// server call so partial failures can't leave orphans.
//
// Request body:
//   {
//     invoice_id: UUID,
//     signature_data_url: string,   // "data:image/png;base64,..."
//     printed_name: string
//   }
//
// Response:
//   { queue_id, invoice_url, backup_url, signature_url }
//
// Flow:
//   1. Validate preflight (billing phone, mazon_approved)
//   2. Upload signature PNG to `signatures/{invoice_id}/{timestamp}.png`
//   3. Build stamped invoice PDF → `mazon-invoices/{invoice_id}.pdf`
//   4. Build backup work order PDF → `mazon-backups/{invoice_id}.pdf`
//   5. INSERT mazon_queue row
//   6. UPDATE invoice: status='factored_pending', payment_method='mazon',
//      mazon_queue_id=<new id>, mazon_stamped_pdf_url=<url>
//   7. Write mazon_audit_log row
//
// If any step fails, prior side effects are rolled back (storage deletes
// + queue row delete) so nothing orphaned.
//
// Stamps on the invoice PDF (native text, not rasterized):
//   HEADER:  REMIT PAYMENT TO: block (replaces Stephens address)
//   FOOTER:  NOTICE OF ASSIGNMENT bordered box near total
// Backup PDF: job details + customer sign-off signature (from jobs.signature_data).

const { createClient } = require('@supabase/supabase-js')
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib')
const MAZON = require('../../src/config/mazon')

const STEPHENS = {
  name: 'Stephens Advanced LLC',
  tagline: 'Fire Suppression Services',
  phone: '(214) 994-4799',
  email: 'jonathan@stephensadvanced.com'
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const { invoice_id: invoiceId, signature_data_url, printed_name } = req.body || {}
  if (!invoiceId) return res.status(400).json({ error: 'invoice_id required' })
  if (!signature_data_url || !signature_data_url.startsWith('data:image/')) return res.status(400).json({ error: 'signature_data_url (PNG data URL) required' })
  if (!printed_name || !printed_name.trim()) return res.status(400).json({ error: 'printed_name required' })

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://motjasdokoxwiodwzyps.supabase.co'
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!sbKey) return res.status(500).json({ error: 'Supabase not configured' })
  const supabase = createClient(sbUrl, sbKey)

  // Roll-back tracking
  const uploaded = []  // {bucket, path}
  let createdQueueId = null

  try {
    // ─── Load invoice + dependencies ───
    const { data: inv, error: invErr } = await supabase
      .from('invoices')
      .select('*, lines:invoice_lines(*), location:locations(*), billing:billing_accounts(*), job:jobs(*)')
      .eq('id', invoiceId)
      .single()
    if (invErr || !inv) return res.status(404).json({ error: 'Invoice not found' })

    // Preflight — redundant with UI check, but catches API misuse
    const billing = inv.billing
    if (!billing) return res.status(400).json({ error: 'Invoice has no billing account — Mazon requires one' })
    if (!billing.phone || !billing.phone.trim()) return res.status(400).json({ error: 'Billing account has no phone number — required by Mazon' })
    if (!billing.mazon_approved) return res.status(400).json({ error: 'Billing account is not mazon_approved' })
    if (inv.mazon_queue_id) return res.status(409).json({ error: 'Invoice already queued for Mazon (mazon_queue_id: ' + inv.mazon_queue_id + ')' })

    const FIVE_YEARS = 60 * 60 * 24 * 365 * 5

    // ─── 1. Upload signature PNG ───
    const sigMatch = signature_data_url.match(/^data:image\/png;base64,(.+)$/)
    if (!sigMatch) return res.status(400).json({ error: 'signature must be image/png data URL' })
    const sigBytes = Buffer.from(sigMatch[1], 'base64')
    const sigPath = `${invoiceId}/${Date.now()}.png`
    const upSig = await supabase.storage.from(MAZON.BUCKETS.SIGNATURES).upload(sigPath, sigBytes, { contentType: 'image/png', upsert: false })
    if (upSig.error) return res.status(500).json({ error: 'Signature upload failed: ' + upSig.error.message })
    uploaded.push({ bucket: MAZON.BUCKETS.SIGNATURES, path: sigPath })
    const sigSignedRes = await supabase.storage.from(MAZON.BUCKETS.SIGNATURES).createSignedUrl(sigPath, FIVE_YEARS)
    if (sigSignedRes.error) throw new Error('Signature signed URL failed: ' + sigSignedRes.error.message)
    const signatureUrl = sigSignedRes.data.signedUrl

    // ─── 2+3. Build and upload invoice + backup PDFs ───
    const invoicePdfBytes = await buildInvoicePdf(inv)
    const backupPdfBytes = await buildBackupPdf(inv)
    const pdfPath = `${invoiceId}.pdf`

    const upInv = await supabase.storage.from(MAZON.BUCKETS.INVOICES).upload(pdfPath, invoicePdfBytes, { contentType: 'application/pdf', upsert: true })
    if (upInv.error) throw new Error('Invoice PDF upload failed: ' + upInv.error.message)
    uploaded.push({ bucket: MAZON.BUCKETS.INVOICES, path: pdfPath })

    const upBk = await supabase.storage.from(MAZON.BUCKETS.BACKUPS).upload(pdfPath, backupPdfBytes, { contentType: 'application/pdf', upsert: true })
    if (upBk.error) throw new Error('Backup PDF upload failed: ' + upBk.error.message)
    uploaded.push({ bucket: MAZON.BUCKETS.BACKUPS, path: pdfPath })

    const invSigRes = await supabase.storage.from(MAZON.BUCKETS.INVOICES).createSignedUrl(pdfPath, FIVE_YEARS)
    if (invSigRes.error) throw new Error('Invoice URL failed: ' + invSigRes.error.message)
    const bkSigRes = await supabase.storage.from(MAZON.BUCKETS.BACKUPS).createSignedUrl(pdfPath, FIVE_YEARS)
    if (bkSigRes.error) throw new Error('Backup URL failed: ' + bkSigRes.error.message)
    const invoiceUrl = invSigRes.data.signedUrl
    const backupUrl = bkSigRes.data.signedUrl

    // ─── 4. Insert mazon_queue row ───
    const locAddr = [inv.location?.address, inv.location?.city, inv.location?.state, inv.location?.zip].filter(Boolean).join(', ')
    const { data: queueRow, error: qErr } = await supabase.from('mazon_queue').insert({
      invoice_id: invoiceId,
      billing_account_id: billing.id,
      customer_name: printed_name,
      location_address: locAddr,
      date_of_service: inv.job?.completed_at ? new Date(inv.job.completed_at).toISOString().slice(0, 10) : (inv.date ? new Date(inv.date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)),
      amount: Number(inv.total),
      invoice_number: inv.invoice_number,
      signature_url: signatureUrl,
      signature_printed_name: printed_name,
      signed_at: new Date().toISOString(),
      status: 'pending'
    }).select().single()
    if (qErr) throw new Error('Queue insert failed: ' + qErr.message)
    createdQueueId = queueRow.id

    // ─── 5. Update invoice ───
    const { error: invUpdErr } = await supabase.from('invoices').update({
      status: 'factored_pending',
      payment_method: 'mazon',
      mazon_queue_id: queueRow.id,
      mazon_stamped_pdf_url: invoiceUrl,
      updated_at: new Date().toISOString()
    }).eq('id', invoiceId)
    if (invUpdErr) throw new Error('Invoice update failed: ' + invUpdErr.message)

    // ─── 6. Audit ───
    await supabase.from('mazon_audit_log').insert({
      actor: 'jon',
      entity_type: 'queue',
      entity_id: queueRow.id,
      new_status: 'pending',
      reason: 'Customer signed Mazon assignment',
      metadata: { invoice_id: invoiceId, printed_name, signature_url: signatureUrl }
    })

    return res.status(200).json({
      queue_id: queueRow.id,
      invoice_url: invoiceUrl,
      backup_url: backupUrl,
      signature_url: signatureUrl
    })

  } catch (e) {
    console.error('[stamp-invoice] error:', e)
    // Roll back: delete uploaded files and any queue row we created
    for (const { bucket, path } of uploaded) {
      try { await supabase.storage.from(bucket).remove([path]) } catch {}
    }
    if (createdQueueId) {
      try {
        const { data: qRow } = await supabase.from('mazon_queue').select('*').eq('id', createdQueueId).maybeSingle()
        if (qRow) {
          await supabase.from('deleted_records').insert({
            table_name: 'mazon_queue', record_id: String(createdQueueId),
            record_data: qRow, deleted_by: 'system',
            reason: 'stamp-invoice rollback: ' + e.message, context: 'mazon'
          })
        }
        await supabase.from('mazon_queue').delete().eq('id', createdQueueId)
      } catch {}
    }
    return res.status(500).json({ error: e.message })
  }
}

// ═══════════════════════════════════════════════════════════════
// PDF LAYOUT
// ═══════════════════════════════════════════════════════════════

async function buildInvoicePdf(inv) {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])   // US Letter
  const { height } = page.getSize()

  const fontReg = await pdf.embedFont(StandardFonts.Helvetica)
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold)

  const black = rgb(0, 0, 0)
  const grey = rgb(0.35, 0.35, 0.38)
  const red = rgb(0.78, 0.12, 0.12)

  // Margins
  const L = 50, R = 562, T = height - 50

  // ─── HEADER — REMIT PAYMENT TO (replaces Stephens address) ───
  page.drawText(STEPHENS.name, { x: L, y: T, size: 18, font: fontBold, color: black })
  page.drawText(STEPHENS.tagline, { x: L, y: T - 18, size: 10, font: fontReg, color: grey })
  page.drawText(STEPHENS.phone + '  ·  ' + STEPHENS.email, { x: L, y: T - 32, size: 9, font: fontReg, color: grey })

  // Remit-to block — right side of header, prominent
  const remitX = 350
  let remitY = T + 4
  page.drawText(MAZON.STAMP_REMIT_TITLE, { x: remitX, y: remitY, size: 10, font: fontBold, color: red })
  remitY -= 14
  for (const line of MAZON.STAMP_REMIT_BODY) {
    page.drawText(line, { x: remitX, y: remitY, size: 10, font: fontBold, color: black })
    remitY -= 12
  }

  // Horizontal rule
  page.drawLine({ start: { x: L, y: T - 50 }, end: { x: R, y: T - 50 }, thickness: 1, color: rgb(0.85, 0.85, 0.88) })

  // ─── Invoice meta ───
  let y = T - 70
  page.drawText('INVOICE', { x: L, y, size: 24, font: fontBold, color: black })
  y -= 28

  const metaRight = (label, value, yy) => {
    page.drawText(label, { x: 380, y: yy, size: 9, font: fontBold, color: grey })
    page.drawText(value || '', { x: 460, y: yy, size: 10, font: fontReg, color: black })
  }
  metaRight('INVOICE #', inv.invoice_number || '', T - 70)
  metaRight('DATE', fmtDate(inv.date), T - 84)
  if (inv.due_date) metaRight('DUE', fmtDate(inv.due_date), T - 98)

  // Bill to
  const billingName = inv.billing?.name || inv.location?.contact_name || inv.location?.name || 'Customer'
  const billingAddr = [inv.billing?.address, [inv.billing?.city, inv.billing?.state, inv.billing?.zip].filter(Boolean).join(', ')].filter(Boolean)

  page.drawText('BILL TO', { x: L, y: y, size: 9, font: fontBold, color: grey })
  y -= 14
  page.drawText(billingName, { x: L, y, size: 12, font: fontBold, color: black })
  y -= 14
  for (const line of billingAddr) {
    page.drawText(line, { x: L, y, size: 10, font: fontReg, color: black })
    y -= 12
  }
  // Service location (if different)
  if (inv.location && inv.location.name !== billingName) {
    y -= 4
    page.drawText('SERVICE LOCATION', { x: L, y, size: 9, font: fontBold, color: grey })
    y -= 12
    page.drawText(inv.location.name || '', { x: L, y, size: 10, font: fontReg, color: black })
    y -= 11
    const locLine = [inv.location.address, inv.location.city, inv.location.state, inv.location.zip].filter(Boolean).join(', ')
    if (locLine) { page.drawText(locLine, { x: L, y, size: 10, font: fontReg, color: black }); y -= 12 }
  }

  // ─── Line items table ───
  y -= 16
  page.drawLine({ start: { x: L, y }, end: { x: R, y }, thickness: 0.5, color: rgb(0.85, 0.85, 0.88) })
  y -= 14
  page.drawText('DESCRIPTION', { x: L, y, size: 9, font: fontBold, color: grey })
  page.drawText('QTY', { x: 360, y, size: 9, font: fontBold, color: grey })
  page.drawText('PRICE', { x: 420, y, size: 9, font: fontBold, color: grey })
  page.drawText('TOTAL', { x: 500, y, size: 9, font: fontBold, color: grey })
  y -= 6
  page.drawLine({ start: { x: L, y }, end: { x: R, y }, thickness: 0.5, color: rgb(0.85, 0.85, 0.88) })
  y -= 14

  const lines = (inv.lines || []).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
  for (const line of lines) {
    // Wrap description if too long
    const desc = line.description || ''
    const descWrap = wrapText(desc, 55)
    for (let i = 0; i < descWrap.length; i++) {
      page.drawText(descWrap[i], { x: L, y, size: 10, font: fontReg, color: black })
      if (i === 0) {
        page.drawText(String(line.quantity || 1), { x: 360, y, size: 10, font: fontReg, color: black })
        page.drawText(fmtMoney(line.unit_price), { x: 420, y, size: 10, font: fontReg, color: black })
        page.drawText(fmtMoney(line.total), { x: 500, y, size: 10, font: fontReg, color: black })
      }
      y -= 14
    }
    y -= 2
  }

  // Totals
  y -= 10
  page.drawLine({ start: { x: 340, y }, end: { x: R, y }, thickness: 0.5, color: rgb(0.85, 0.85, 0.88) })
  y -= 14
  const totalRow = (label, value, bold = false, color = black) => {
    const f = bold ? fontBold : fontReg
    page.drawText(label, { x: 380, y, size: 10, font: f, color })
    page.drawText(value, { x: 500, y, size: 10, font: f, color })
  }
  totalRow('Subtotal', fmtMoney(inv.subtotal))
  y -= 14
  if (Number(inv.travel_charge) > 0) {
    totalRow('Travel', fmtMoney(inv.travel_charge))
    y -= 14
  }
  totalRow('TOTAL', fmtMoney(inv.total), true)

  // ─── NOTICE OF ASSIGNMENT — bordered box near total ───
  y -= 40
  const boxTop = y + 10
  const boxH = 96
  const boxBottom = boxTop - boxH

  // Border
  page.drawRectangle({
    x: L - 4, y: boxBottom,
    width: R - L + 8, height: boxH,
    borderColor: red, borderWidth: 1.5
  })
  // Title bar
  page.drawRectangle({
    x: L - 4, y: boxTop - 20,
    width: R - L + 8, height: 20,
    color: red
  })
  page.drawText(MAZON.STAMP_NOTICE_TITLE, {
    x: L + 4, y: boxTop - 14, size: 11, font: fontBold, color: rgb(1, 1, 1)
  })

  let noticeY = boxTop - 34
  for (const line of MAZON.STAMP_NOTICE_BODY) {
    const isName = line === MAZON.LEGAL_NAME
    const isAddr = line === MAZON.REMIT_ADDRESS_FULL
    page.drawText(line, {
      x: L, y: noticeY,
      size: (isName || isAddr) ? 10 : 9,
      font: (isName || isAddr) ? fontBold : fontReg,
      color: black
    })
    noticeY -= 12
  }

  // ─── Footer ───
  page.drawText('Thank you for your business. · Stephens Advanced LLC', {
    x: L, y: 40, size: 8, font: fontReg, color: grey
  })

  return await pdf.save()
}

// ═══════════════════════════════════════════════════════════════
// BACKUP (SIGNED WORK ORDER) PDF
// ═══════════════════════════════════════════════════════════════

async function buildBackupPdf(inv /*, _unused */) {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  const { height } = page.getSize()
  const fontReg = await pdf.embedFont(StandardFonts.Helvetica)
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const black = rgb(0, 0, 0)
  const grey = rgb(0.35, 0.35, 0.38)

  const L = 50, R = 562, T = height - 50

  // Header
  page.drawText(STEPHENS.name, { x: L, y: T, size: 18, font: fontBold, color: black })
  page.drawText(STEPHENS.tagline, { x: L, y: T - 18, size: 10, font: fontReg, color: grey })
  page.drawText(STEPHENS.phone + '  ·  ' + STEPHENS.email, { x: L, y: T - 32, size: 9, font: fontReg, color: grey })
  page.drawLine({ start: { x: L, y: T - 50 }, end: { x: R, y: T - 50 }, thickness: 1, color: rgb(0.85, 0.85, 0.88) })

  let y = T - 80
  page.drawText('SIGNED WORK ORDER', { x: L, y, size: 20, font: fontBold, color: black })
  y -= 24
  page.drawText('Proof of service delivery — attached to invoice ' + (inv.invoice_number || ''), { x: L, y, size: 10, font: fontReg, color: grey })
  y -= 24

  const job = inv.job || {}
  const locName = inv.location?.name || inv.billing?.name || 'Customer'
  const serviceDate = job.completed_at || job.scheduled_date || inv.date

  // Two columns of facts
  const factRow = (label, value, yy) => {
    page.drawText(label, { x: L, y: yy, size: 9, font: fontBold, color: grey })
    page.drawText(value || '—', { x: L + 140, y: yy, size: 10, font: fontReg, color: black })
  }
  factRow('LOCATION', locName, y); y -= 18
  const addr = [inv.location?.address, inv.location?.city, inv.location?.state, inv.location?.zip].filter(Boolean).join(', ')
  if (addr) { factRow('ADDRESS', addr, y); y -= 18 }
  factRow('SERVICE DATE', fmtDate(serviceDate), y); y -= 18
  factRow('JOB #', job.job_number || job.id?.slice(0, 8) || '—', y); y -= 18
  if (Array.isArray(job.scope) && job.scope.length) {
    factRow('SCOPE', job.scope.join(', '), y); y -= 18
  }
  factRow('TECHNICIAN', job.technician || 'Jon Stephens', y); y -= 18
  factRow('INVOICE', inv.invoice_number || '—', y); y -= 18
  factRow('TOTAL', fmtMoney(inv.total), y); y -= 28

  // Line items (abbreviated)
  if ((inv.lines || []).length) {
    page.drawText('WORK PERFORMED', { x: L, y, size: 9, font: fontBold, color: grey })
    y -= 16
    const lines = (inv.lines || []).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
    for (const line of lines) {
      const desc = line.description || ''
      const descWrap = wrapText(desc, 75)
      for (const wline of descWrap) {
        page.drawText('• ' + wline, { x: L, y, size: 10, font: fontReg, color: black })
        y -= 13
      }
    }
    y -= 8
  }

  // Customer sign-off
  y -= 20
  page.drawLine({ start: { x: L, y: y + 8 }, end: { x: R, y: y + 8 }, thickness: 0.5, color: rgb(0.85, 0.85, 0.88) })
  page.drawText('CUSTOMER ACKNOWLEDGEMENT', { x: L, y, size: 9, font: fontBold, color: grey })
  y -= 16
  page.drawText('The services described above have been performed to the customer\'s satisfaction.', {
    x: L, y, size: 10, font: fontReg, color: black
  })
  y -= 30

  // Signature box
  const sigBoxTop = y
  const sigBoxH = 100
  page.drawRectangle({
    x: L, y: sigBoxTop - sigBoxH,
    width: R - L, height: sigBoxH,
    borderColor: rgb(0.7, 0.7, 0.75), borderWidth: 0.8
  })
  page.drawText('Customer Signature', { x: L + 6, y: sigBoxTop - 14, size: 8, font: fontBold, color: grey })

  // Embed signature if present
  if (job.signature_data && typeof job.signature_data === 'string') {
    try {
      const dataUrl = job.signature_data
      const m = dataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/)
      if (m) {
        const sigBytes = Buffer.from(m[2], 'base64')
        const sigImg = m[1] === 'png'
          ? await pdf.embedPng(sigBytes)
          : await pdf.embedJpg(sigBytes)
        // Fit signature to box
        const maxW = R - L - 20
        const maxH = sigBoxH - 30
        const scale = Math.min(maxW / sigImg.width, maxH / sigImg.height)
        page.drawImage(sigImg, {
          x: L + 10,
          y: sigBoxTop - sigBoxH + 15,
          width: sigImg.width * scale,
          height: sigImg.height * scale
        })
      }
    } catch (e) {
      console.error('[backup] signature embed failed:', e.message)
      page.drawText('(Signature on file — embedding failed)', { x: L + 10, y: sigBoxTop - sigBoxH / 2, size: 9, font: fontReg, color: grey })
    }
  } else {
    page.drawText('(No signature on file — signed work order pending)', { x: L + 10, y: sigBoxTop - sigBoxH / 2, size: 9, font: fontReg, color: grey })
  }

  // Date stamp
  page.drawText('Signed: ' + fmtDate(serviceDate), { x: L, y: sigBoxTop - sigBoxH - 14, size: 9, font: fontReg, color: grey })

  return await pdf.save()
}

function wrapText(s, maxChars) {
  if (!s) return ['']
  const words = s.split(' ')
  const out = []
  let cur = ''
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars) {
      if (cur) out.push(cur)
      cur = w
    } else {
      cur = (cur ? cur + ' ' : '') + w
    }
  }
  if (cur) out.push(cur)
  return out.length ? out : ['']
}

function fmtMoney(n) {
  const v = Number(n || 0)
  return '$' + v.toFixed(2)
}

function fmtDate(d) {
  if (!d) return ''
  const dt = new Date(d)
  if (isNaN(dt)) return String(d)
  return (dt.getUTCMonth() + 1).toString().padStart(2, '0') + '/' +
         dt.getUTCDate().toString().padStart(2, '0') + '/' +
         dt.getUTCFullYear()
}
