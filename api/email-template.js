// /api/email-template.js
//
// One canonical branded HTML email template for every outbound email
// in the system. Built on top of the existing send-contract.js chrome
// (orange header with logo, white body, dark navy footer with phone/email).
//
// Usage:
//   const { renderEmail, renderText } = require('./email-template')
//   const html = renderEmail({
//     headline: 'Invoice INV-12345',
//     subheadline: 'Stephens Advanced LLC',
//     greeting: 'Hi Jon,',
//     intro: 'Thanks for the work today. Your invoice is attached.',
//     lineItems: [{description: 'Inspection', quantity: 1, unit_price: 175, total: 175}],
//     totalLabel: 'Total',
//     total: '$175.00',
//     cta: { label: 'View invoice', url: 'https://...' },
//     spanish: {  // optional, drops a translated block under the English body
//       greeting: 'Hola Jon,',
//       intro: 'Gracias por el trabajo de hoy.',
//       ctaLabel: 'Ver factura'
//     },
//     fineprint: 'Optional small text under the CTA',
//   })
//
// All sections are optional — pass only the slots you need. Missing slots
// are skipped cleanly.

const LOGO_URL = 'https://www.stephensadvanced.com/icon-120.png'
const FIRE = '#f05a28'
const FIRE_DARK = '#d04010'
const NAVY = '#1a1a2e'
const PHONE_DISPLAY = '(214) 994-4799'
const PHONE_TEL = '+12149944799'
const EMAIL_ADDR = 'jonathan@stephensadvanced.com'
const SITE_URL = 'https://www.stephensadvanced.com'

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function renderLineItems(lineItems) {
  if (!lineItems || !lineItems.length) return ''
  const rows = lineItems.map(l => {
    const qty = +l.quantity || 1
    const price = +l.unit_price || 0
    const total = +l.total || (qty * price)
    const qtyStr = qty !== 1 ? `${qty} &times; $${price.toFixed(2)}` : ''
    return `<tr>
      <td style="padding:10px 0;border-bottom:1px solid #eee;font-size:13px;color:#333">
        ${esc(l.description || '')}${qtyStr ? `<div style="font-size:11px;color:#999;margin-top:2px">${qtyStr}</div>` : ''}
      </td>
      <td style="padding:10px 0;border-bottom:1px solid #eee;font-size:13px;color:#333;font-weight:600;text-align:right;white-space:nowrap;vertical-align:top">$${total.toFixed(2)}</td>
    </tr>`
  }).join('')
  return rows
}

function renderTotalRow(totalLabel, total) {
  if (!total) return ''
  return `<tr>
    <td style="padding:14px 0 0;font-size:14px;color:#1a1a1a;font-weight:800">${esc(totalLabel || 'Total')}</td>
    <td style="padding:14px 0 0;font-size:15px;color:${FIRE};font-weight:800;text-align:right">${esc(total)}</td>
  </tr>`
}

function renderCta(cta) {
  if (!cta || !cta.url) return ''
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 12px"><tr><td align="center">
    <a href="${esc(cta.url)}" target="_blank" style="display:inline-block;background:${FIRE};color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 36px;border-radius:8px;letter-spacing:0.2px">
      ${esc(cta.label || 'View')}
    </a>
  </td></tr></table>`
}

function renderSpanishBlock(es, cta) {
  if (!es) return ''
  return `<hr style="border:none;border-top:1px solid #eee;margin:24px 0">
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;background:#f8f8fa;border-radius:8px">
  <tr><td style="padding:18px 22px">
    <p style="margin:0 0 8px;font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.5px">Espa&ntilde;ol</p>
    ${es.greeting ? `<p style="margin:0 0 8px;font-size:13px;color:#444;line-height:1.65">${esc(es.greeting)}</p>` : ''}
    ${es.intro ? `<p style="margin:0 0 12px;font-size:13px;color:#555;line-height:1.65">${esc(es.intro)}</p>` : ''}
    ${(cta && cta.url && es.ctaLabel) ? `<a href="${esc(cta.url)}" target="_blank" style="display:inline-block;background:${FIRE};color:#ffffff;font-size:13px;font-weight:700;text-decoration:none;padding:10px 26px;border-radius:6px">${esc(es.ctaLabel)}</a>` : ''}
  </td></tr>
  </table>`
}

/**
 * Render a branded HTML email.
 *
 * @param {object} opts
 * @param {string} [opts.headline]      — large white text in the orange header
 * @param {string} [opts.subheadline]   — small text under the headline
 * @param {string} [opts.greeting]      — first paragraph e.g. "Hi Jon,"
 * @param {string} [opts.intro]         — second paragraph (the main message)
 * @param {string} [opts.bodyHtml]      — raw HTML to insert after intro
 *                                        (caller is responsible for escaping)
 * @param {Array}  [opts.lineItems]     — [{description, quantity, unit_price, total}]
 * @param {string} [opts.totalLabel]    — "Total", "Amount Due", etc.
 * @param {string} [opts.total]         — "$195.00"
 * @param {object} [opts.cta]           — {label, url}
 * @param {object} [opts.spanish]       — {greeting, intro, ctaLabel}
 * @param {string} [opts.fineprint]     — small text below CTA
 * @returns {string} HTML
 */
function renderEmail(opts = {}) {
  const {
    headline = 'Stephens Advanced',
    subheadline = 'Fire Suppression &amp; Safety',
    greeting,
    intro,
    bodyHtml = '',
    lineItems = [],
    totalLabel = 'Total',
    total = '',
    cta,
    spanish,
    fineprint,
  } = opts

  const lineItemsHtml = lineItems.length
    ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 4px">
        ${renderLineItems(lineItems)}
        ${renderTotalRow(totalLabel, total)}
      </table>`
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 16px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

  <!-- Header -->
  <tr><td style="background:${FIRE};padding:28px 32px;border-radius:10px 10px 0 0;text-align:center">
    <img src="${LOGO_URL}" alt="Stephens Advanced" width="60" height="60" style="display:block;margin:0 auto 12px;border-radius:12px">
    <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.3px">${esc(headline)}</h1>
    <p style="margin:6px 0 0;color:rgba(255,255,255,0.92);font-size:13px">${subheadline}</p>
  </td></tr>

  <!-- Body -->
  <tr><td style="background:#ffffff;padding:28px 32px;border-left:1px solid #e8e8eb;border-right:1px solid #e8e8eb">
    ${greeting ? `<p style="margin:0 0 14px;font-size:15px;color:#222;line-height:1.6">${esc(greeting)}</p>` : ''}
    ${intro ? `<p style="margin:0 0 18px;font-size:14px;color:#444;line-height:1.7">${esc(intro)}</p>` : ''}
    ${bodyHtml}
    ${lineItemsHtml}
    ${renderCta(cta)}
    ${fineprint ? `<p style="margin:0 0 4px;font-size:12px;color:#888;text-align:center;line-height:1.55">${esc(fineprint)}</p>` : ''}
    ${renderSpanishBlock(spanish, cta)}
  </td></tr>

  <!-- Footer -->
  <tr><td style="background:${NAVY};padding:22px 32px;border-radius:0 0 10px 10px;text-align:center">
    <p style="margin:0 0 6px;font-size:13px;color:#ccc;font-weight:600">Stephens Advanced LLC</p>
    <p style="margin:0 0 4px;font-size:11px;color:#999;line-height:1.6">
      Fire Suppression Systems &bull; Inspections &bull; Installations &bull; Service
    </p>
    <p style="margin:0 0 4px;font-size:11px;color:#999;line-height:1.6">
      <a href="tel:${PHONE_TEL}" style="color:${FIRE};text-decoration:none">${PHONE_DISPLAY}</a> &bull;
      <a href="mailto:${EMAIL_ADDR}" style="color:${FIRE};text-decoration:none">${EMAIL_ADDR}</a>
    </p>
    <p style="margin:8px 0 0;font-size:10px;color:#666">
      <a href="${SITE_URL}" style="color:${FIRE};text-decoration:none">www.stephensadvanced.com</a>
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`
}

/**
 * Plain-text version of the same email. Strict 7-bit ASCII so SMTP doesn't
 * apply quoted-printable encoding (which mangles tokenized URLs by
 * re-decoding '=' as a hex escape).
 *
 * Same signature as renderEmail. Pass identical opts in to keep both
 * versions in sync.
 */
function renderText(opts = {}) {
  const {
    headline = 'Stephens Advanced',
    greeting,
    intro,
    lineItems = [],
    totalLabel = 'Total',
    total = '',
    cta,
    fineprint,
  } = opts

  const lines = []
  lines.push('STEPHENS ADVANCED LLC')
  lines.push(headline.toUpperCase())
  lines.push('')
  if (greeting) lines.push(greeting)
  if (intro) lines.push(intro)
  if (lineItems.length) {
    lines.push('')
    for (const l of lineItems) {
      const qty = +l.quantity || 1, price = +l.unit_price || 0
      const lt = +l.total || (qty * price)
      const qtyStr = qty !== 1 ? `${qty} x $${price.toFixed(2)}  ` : ''
      lines.push(`  ${qtyStr}${(l.description || '').replace(/\s+/g, ' ')}  $${lt.toFixed(2)}`)
    }
    lines.push('  ' + '-'.repeat(40))
    lines.push(`  ${totalLabel.toUpperCase()}: ${total || '$' + lineItems.reduce((s, l) => s + (+l.total || 0), 0).toFixed(2)}`)
  }
  if (cta && cta.url) {
    lines.push('')
    if (cta.label) lines.push(cta.label.replace(/[^\x20-\x7E]/g, '') + ':')
    lines.push(cta.url)
  }
  if (fineprint) {
    lines.push('')
    lines.push(fineprint)
  }
  lines.push('')
  lines.push('---')
  lines.push('Stephens Advanced LLC')
  lines.push('Fire Suppression and Safety - DFW Texas')
  lines.push(`${PHONE_DISPLAY} - ${EMAIL_ADDR}`)
  lines.push(SITE_URL.replace('https://', ''))

  return lines.join('\n').replace(/[^\x20-\x7E\n\r\t]/g, '')
}

/**
 * Convenience helper: build a Resend payload (HTML + text + From/To/etc.)
 * from a single opts object. Most senders can use this directly.
 */
function buildResendPayload({ to, bcc, subject, opts, attachments }) {
  const payload = {
    from: 'Stephens Advanced <jonathan@stephensadvanced.com>',
    to: Array.isArray(to) ? to : [to],
    subject,
    html: renderEmail(opts),
    text: renderText(opts),
  }
  if (bcc) payload.bcc = Array.isArray(bcc) ? bcc : [bcc]
  if (attachments && attachments.length) payload.attachments = attachments
  return payload
}

module.exports = {
  renderEmail,
  renderText,
  buildResendPayload,
  // Constants exposed for senders that need them directly
  LOGO_URL,
  FIRE,
  FIRE_DARK,
  NAVY,
  PHONE_DISPLAY,
  PHONE_TEL,
  EMAIL_ADDR,
  SITE_URL,
}
