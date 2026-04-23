// /api/email-monitor.js
// Monitors Jon's Gmail inbox for important emails and texts him about them.
// Runs every 10 minutes via Vercel cron.
//
// Learning loop: email-notification preferences are stored in riker_memory
// (scope=global, content starting with "EMAIL_MONITOR_IGNORE:" or
// "EMAIL_MONITOR_WATCH:"). Riker writes these when Jon gives feedback via SMS
// ("stop texting me about X"). This file reads them before each classification.
//
// Uses claude-haiku for cheap per-email classification (~$0.0003 each).
// Starts conservative (flags borderline as important) and narrows over time.

const { createClient } = require('@supabase/supabase-js')

const JON_PHONE = '+12149944799'
const JON_EMAIL = 'jonathan@stephensadvanced.com'
const LOOKBACK_SECONDS = 1200  // 20 min — wider than 10-min cron interval

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

  try {
    const accessToken = await getGmailAccessToken()

    // Load ignore/watch patterns Jon has set via SMS feedback
    const { data: memEntries } = await SB.from('riker_memory')
      .select('content')
      .eq('scope', 'global')
      .eq('archived', false)
      .or('content.ilike.EMAIL_MONITOR_IGNORE%,content.ilike.EMAIL_MONITOR_WATCH%')

    const ignorePatterns = (memEntries || [])
      .filter(e => /^EMAIL_MONITOR_IGNORE:/i.test(e.content))
      .map(e => e.content.replace(/^EMAIL_MONITOR_IGNORE:\s*/i, '').trim())

    const watchPatterns = (memEntries || [])
      .filter(e => /^EMAIL_MONITOR_WATCH:/i.test(e.content))
      .map(e => e.content.replace(/^EMAIL_MONITOR_WATCH:\s*/i, '').trim())

    // Fetch recent unread inbox emails
    const afterEpoch = Math.floor((Date.now() - LOOKBACK_SECONDS * 1000) / 1000)
    const q = `in:inbox is:unread -from:${JON_EMAIL} after:${afterEpoch}`
    const list = await gmailRequest(accessToken, `users/me/messages?q=${encodeURIComponent(q)}&maxResults=20`)
    const msgIds = (list.messages || []).map(m => m.id)

    if (!msgIds.length) {
      return res.status(200).json({ ok: true, checked: 0, important: 0, ignorable: 0, alerted: [] })
    }

    const results = { checked: 0, important: 0, ignorable: 0, alerted: [], errors: [] }

    for (const gmailId of msgIds) {
      try {
        // Idempotency — don't re-process what we've already seen
        const { data: seen } = await SB.from('jon_inbox_processed')
          .select('gmail_message_id').eq('gmail_message_id', gmailId).maybeSingle()
        if (seen) continue

        results.checked++

        const msg = await gmailRequest(accessToken, `users/me/messages/${gmailId}?format=full`)
        const parsed = parseGmailMessage(msg)

        // Skip Jon's own outbound emails (shouldn't appear in inbox but be safe)
        if ((parsed.from || '').toLowerCase().includes(JON_EMAIL.toLowerCase())) {
          await markProcessed(SB, gmailId, parsed, 'ignorable', 'from self')
          results.ignorable++
          continue
        }

        // Quick-ignore check against memory patterns (cheap, before Claude call)
        const quickIgnoreReason = checkQuickIgnore(parsed, ignorePatterns)
        if (quickIgnoreReason) {
          await markProcessed(SB, gmailId, parsed, 'ignorable', quickIgnoreReason)
          results.ignorable++
          continue
        }

        // Claude classification
        const classification = await classifyEmail(parsed, ignorePatterns, watchPatterns)
        await markProcessed(SB, gmailId, parsed, classification.verdict, classification.reason)

        if (classification.verdict === 'important') {
          results.important++
          const smsText = formatEmailAlert(parsed, classification.summary)
          await sendSMSToJon(smsText)
          await SB.from('jon_inbox_processed')
            .update({ alerted_jon: true })
            .eq('gmail_message_id', gmailId)
          results.alerted.push({ from: parsed.from, subject: parsed.subject })
        } else {
          results.ignorable++
        }
      } catch (e) {
        console.error('[email-monitor] error processing', gmailId, e.message)
        results.errors.push({ gmailId, error: e.message })
      }
    }

    return res.status(200).json({ ok: true, ...results })
  } catch (e) {
    console.error('[email-monitor] fatal:', e.message)
    return res.status(500).json({ error: e.message })
  }
}

// ─── Classification ───────────────────────────────────────────────────────────

async function classifyEmail(parsed, ignorePatterns, watchPatterns) {
  const key = process.env.CLAUDE_KEY || process.env.ANTHROPIC_API_KEY
  // No key → default important (better to over-notify while warming up)
  if (!key) return { verdict: 'important', reason: 'no Claude key', summary: parsed.subject || '' }

  const ignoreBlock = ignorePatterns.length
    ? '\nJon has asked to ignore:\n' + ignorePatterns.map(p => '- ' + p).join('\n')
    : ''
  const watchBlock = watchPatterns.length
    ? '\nJon wants to be alerted about:\n' + watchPatterns.map(p => '- ' + p).join('\n')
    : ''

  const bodyPreview = (parsed.bodyText || '').replace(/\s+/g, ' ').slice(0, 600)

  const prompt = `You are an email triage assistant for Jon Stephens, owner of Stephens Advanced LLC (fire suppression inspection company in DFW, Texas).

Should Jon be notified via text about this email?

EMAIL:
From: ${parsed.from}${parsed.fromName ? ' (' + parsed.fromName + ')' : ''}
Subject: ${parsed.subject || '(no subject)'}
Body: ${bodyPreview || '(empty)'}
${ignoreBlock}${watchBlock}

TEXT JON (mark important) if any:
- Business inquiry or customer reaching out
- Payment, billing, invoice, or financial issue
- Legal, compliance, or licensing notice
- Vendor or supplier requiring a decision
- Government or regulatory communication
- Direct personal message from a real person
- Anything flagged in Jon's watch list above

SKIP (mark ignorable) if any:
- Marketing, promotional, or newsletter
- Automated notification with no required action
- Social media notification
- Routine order/shipping confirmation
- General announcement or blast email
- Matches Jon's ignore list above
- Unsubscribe-eligible bulk mail

When in doubt, mark important — Jon can train the filter by replying to Riker.

Respond ONLY with valid JSON:
{"verdict":"important"|"ignorable","reason":"brief reason under 60 chars","summary":"one sentence describing the email for Jon's SMS alert"}`

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      })
    })
    if (!r.ok) throw new Error('Claude API ' + r.status)
    const data = await r.json()
    const text = (data.content?.[0]?.text || '').trim()
    const match = text.match(/\{[\s\S]*?\}/)
    if (!match) throw new Error('no JSON in response')
    const out = JSON.parse(match[0])
    return {
      verdict: out.verdict === 'ignorable' ? 'ignorable' : 'important',
      reason: String(out.reason || '').slice(0, 200),
      summary: String(out.summary || '').slice(0, 200)
    }
  } catch (e) {
    console.error('[email-monitor] classify error:', e.message)
    // Default important on error — over-notification beats silent misses
    return { verdict: 'important', reason: 'classify error — defaulting', summary: parsed.subject || '' }
  }
}

// Quick pattern-match against ignore list before calling Claude
function checkQuickIgnore(parsed, ignorePatterns) {
  if (!ignorePatterns.length) return null
  const from = (parsed.from || '').toLowerCase()
  const subject = (parsed.subject || '').toLowerCase()
  const body = (parsed.bodyText || '').toLowerCase().slice(0, 300)
  const haystack = from + ' ' + subject + ' ' + body

  for (const pat of ignorePatterns) {
    const p = pat.toLowerCase()
    // Exact substring match or domain match
    if (haystack.includes(p)) return 'matches ignore: ' + pat.slice(0, 60)
    // Domain in from address
    const domainMatch = pat.match(/^[^@\s]+\.[a-z]{2,}$/)
    if (domainMatch && from.includes(domainMatch[0].toLowerCase())) {
      return 'domain ignore: ' + pat.slice(0, 60)
    }
    // Category keywords
    if (p.includes('marketing') && isMarketingEmail(parsed)) return 'marketing email'
    if (p.includes('newsletter') && isNewsletterEmail(parsed)) return 'newsletter email'
    if (p.includes('promotional') && isMarketingEmail(parsed)) return 'promotional email'
  }
  return null
}

function isMarketingEmail(parsed) {
  const s = ((parsed.subject || '') + ' ' + (parsed.bodyText || '')).toLowerCase()
  return /\b(sale|% off|coupon|promo|discount|limited time|exclusive offer|free shipping|unsubscribe|opt.out)\b/.test(s)
}

function isNewsletterEmail(parsed) {
  const from = (parsed.from || '').toLowerCase()
  return /newsletter|mailchimp|constantcontact|hubspot|sendgrid|campaignmonitor|klaviyo|noreply@|no-reply@/.test(from)
}

// ─── SMS formatting ───────────────────────────────────────────────────────────

function formatEmailAlert(parsed, summary) {
  const from = (parsed.fromName || parsed.from || 'Unknown').slice(0, 40)
  const subject = (parsed.subject || '(no subject)').slice(0, 70)
  const sum = (summary || '').slice(0, 130)
  // Two SMS segments max (~320 chars)
  let text = `📧 ${from}: "${subject}"`
  if (sum && sum !== subject) text += `\n${sum}`
  return text.slice(0, 320)
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

async function markProcessed(SB, gmailId, parsed, verdict, reason) {
  const emailDate = parsed.internalDate
    ? new Date(parseInt(parsed.internalDate)).toISOString()
    : null
  await SB.from('jon_inbox_processed').upsert({
    gmail_message_id: gmailId,
    from_email: (parsed.from || '').slice(0, 255) || null,
    from_name: (parsed.fromName || '').slice(0, 255) || null,
    subject: (parsed.subject || '').slice(0, 500),
    classified_as: verdict,
    reason: (reason || '').slice(0, 500),
    alerted_jon: false,
    email_date: emailDate
  }, { onConflict: 'gmail_message_id' })
}

// ─── Twilio ───────────────────────────────────────────────────────────────────

async function sendSMSToJon(body) {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_FROM_NUMBER
  if (!sid || !token || !from) throw new Error('Twilio not configured')
  const auth = Buffer.from(sid + ':' + token).toString('base64')
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: JON_PHONE, From: from, Body: body }).toString()
  })
  if (!r.ok) {
    const d = await r.json().catch(() => ({}))
    throw new Error('Twilio send failed: ' + (d.message || r.status))
  }
}

// ─── Gmail helpers ────────────────────────────────────────────────────────────

async function getGmailAccessToken() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || '780674517325-ar9lod4h4phk6sdbtcljoqv7e1m41g2p.apps.googleusercontent.com'
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN
  if (!clientSecret || !refreshToken) throw new Error('Google OAuth not configured')
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: 'refresh_token'
    })
  })
  const data = await r.json()
  if (!r.ok) throw new Error('Gmail token refresh failed: ' + JSON.stringify(data))
  return data.access_token
}

async function gmailRequest(accessToken, path) {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/' + path, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  const data = await r.json()
  if (!r.ok) {
    const msg = data.error?.message || r.statusText
    if (msg.includes('Insufficient Permission') || msg.includes('insufficient authentication')) {
      throw new Error('Gmail scope missing — needs gmail.readonly')
    }
    throw new Error('Gmail API: ' + msg)
  }
  return data
}

function parseGmailMessage(msg) {
  const hdrs = {}
  for (const h of (msg.payload?.headers || [])) hdrs[h.name.toLowerCase()] = h.value

  const fromRaw = hdrs['from'] || ''
  const nameMatch = fromRaw.match(/^(.+?)\s*<(.+?)>$/)
  const fromName = nameMatch ? nameMatch[1].replace(/^["']|["']$/g, '').trim() : null
  const from = nameMatch ? nameMatch[2].trim() : fromRaw.trim()

  return {
    from,
    fromName,
    to: hdrs['to'] || '',
    subject: hdrs['subject'] || '',
    threadId: msg.threadId || '',
    messageIdHeader: hdrs['message-id'] || '',
    internalDate: msg.internalDate || null,
    bodyText: extractBody(msg.payload)
  }
}

function decodeBase64Url(b64) {
  if (!b64) return ''
  return Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
}

function extractBody(payload) {
  if (!payload) return ''
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decodeBase64Url(payload.body.data)
  if (payload.parts) {
    for (const p of payload.parts) {
      if (p.mimeType === 'text/plain' && p.body?.data) return decodeBase64Url(p.body.data)
    }
    for (const p of payload.parts) {
      if (p.mimeType === 'text/html' && p.body?.data) return stripHtml(decodeBase64Url(p.body.data))
      if (p.parts) { const n = extractBody(p); if (n) return n }
    }
  }
  if (payload.body?.data) {
    return payload.mimeType === 'text/html'
      ? stripHtml(decodeBase64Url(payload.body.data))
      : decodeBase64Url(payload.body.data)
  }
  return ''
}

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim()
}
