// /api/email-inbound.js
// Polls Gmail for inbound emails labeled "Riker", routes each through
// Riker core, and replies via Resend (threaded).
//
// Google OAuth refresh token must have gmail.modify scope. See
// docs/riker-sms-setup.md for the authorization walkthrough.
//
// Called by cron every 5 minutes (vercel.json) or manual GET.

const { createClient } = require('@supabase/supabase-js')
const core = require('./riker-core')
const { sendSMS, sendEmail, JON_PHONE } = require('./riker-actions')

const JON_EMAIL = 'jonathan@stephensadvanced.com'
const RIKER_LABEL = 'Riker'

module.exports = async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).end()

  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://motjasdokoxwiodwzyps.supabase.co'
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  const supabase = createClient(sbUrl, sbKey)

  try {
    const accessToken = await getGmailAccessToken()
    const labels = await gmailRequest(accessToken, 'users/me/labels')
    const rikerLabel = (labels.labels || []).find(l => l.name === RIKER_LABEL)
    if (!rikerLabel) {
      return res.status(200).json({ warning: `Label "${RIKER_LABEL}" not found. Create it and set up a filter.`, processed: 0 })
    }

    const q = `label:${RIKER_LABEL} is:unread -from:${JON_EMAIL}`
    const list = await gmailRequest(accessToken, `users/me/messages?q=${encodeURIComponent(q)}&maxResults=25`)
    const msgIds = (list.messages || []).map(m => m.id)

    const results = { processed: 0, skipped: 0, errors: [], details: [] }

    for (const gmailId of msgIds) {
      try {
        const { data: seen } = await supabase.from('processed_emails').select('gmail_message_id').eq('gmail_message_id', gmailId).maybeSingle()
        if (seen) { results.skipped++; continue }

        const msg = await gmailRequest(accessToken, `users/me/messages/${gmailId}?format=full`)
        const parsed = parseGmailMessage(msg)
        if (!parsed.from || parsed.from.toLowerCase().includes(JON_EMAIL)) {
          results.skipped++
          await markProcessed(supabase, gmailId, null, 'ignored')
          await markRead(accessToken, gmailId)
          continue
        }

        // Find or create conversation
        let conv = await findOrCreateEmailConversation(supabase, {
          email: parsed.from,
          emailThreadId: parsed.threadId,
          customerName: parsed.fromName
        })

        // Link to known location if phone is unknown but email matches
        if (!conv.location_id) {
          const { data: loc } = await supabase.from('locations').select('id, name, contact_name, billing_account_id').eq('contact_email', parsed.from).limit(1).maybeSingle()
          if (loc) {
            await supabase.from('conversations').update({
              location_id: loc.id,
              customer_name: loc.contact_name || loc.name
            }).eq('id', conv.id)
            conv = { ...conv, location_id: loc.id, customer_name: loc.contact_name || loc.name }
          }
        }

        // Log inbound
        await supabase.from('messages').insert({
          conversation_id: conv.id,
          direction: 'inbound', channel: 'email',
          body: parsed.bodyText,
          email_message_id: parsed.messageIdHeader,
          email_subject: parsed.subject,
          email_from: parsed.from,
          email_to: parsed.to
        })

        // Dispatch to core
        const result = await core.processMessage({
          supabase,
          context: 'email_customer',
          sessionKey: conv.id,
          sessionStorage: 'conversations',
          identity: {
            email: parsed.from,
            location_id: conv.location_id,
            customer_name: conv.customer_name
          },
          message: parsed.bodyText,
          inboundAlreadyLogged: true
        })

        // Send threaded reply via Resend
        if (result.reply) {
          const replySubject = parsed.subject
            ? (parsed.subject.startsWith('Re:') ? parsed.subject : 'Re: ' + parsed.subject)
            : 'Re: your inquiry'
          try {
            await sendEmail({
              to: parsed.from,
              subject: replySubject,
              body: result.reply,
              inReplyTo: parsed.messageIdHeader,
              references: parsed.references
                ? parsed.references + ' ' + parsed.messageIdHeader
                : parsed.messageIdHeader
            })
          } catch (e) {
            console.error('[email-inbound] reply send failed:', e.message)
            results.errors.push({ gmailId, error: 'send: ' + e.message })
          }
        }

        await markProcessed(supabase, gmailId, conv.id, 'replied')
        await markRead(accessToken, gmailId)

        results.processed++
        results.details.push({ gmailId, from: parsed.from, subject: parsed.subject, conversation_id: conv.id })
      } catch (e) {
        console.error('[email-inbound] message error:', gmailId, e)
        results.errors.push({ gmailId, error: e.message })
        try { await markProcessed(supabase, gmailId, null, 'failed') } catch {}
      }
    }

    return res.status(200).json(results)

  } catch (e) {
    console.error('[email-inbound] fatal:', e)
    return res.status(500).json({ error: e.message })
  }
}

// ─── helpers ───

async function getGmailAccessToken() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || '780674517325-ar9lod4h4phk6sdbtcljoqv7e1m41g2p.apps.googleusercontent.com'
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN
  if (!clientSecret || !refreshToken) throw new Error('Google OAuth not configured')

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: 'refresh_token'
    })
  })
  const data = await res.json()
  if (!res.ok) throw new Error('Gmail token refresh failed: ' + JSON.stringify(data))
  return data.access_token
}

async function gmailRequest(accessToken, path) {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/' + path, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  const data = await res.json()
  if (!res.ok) {
    const msg = data.error?.message || res.statusText
    if (msg.includes('Insufficient Permission') || msg.includes('insufficient authentication')) {
      throw new Error('Gmail scope missing. Re-authorize with gmail.modify.')
    }
    throw new Error('Gmail API error: ' + msg)
  }
  return data
}

async function markRead(accessToken, gmailId) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailId}/modify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ removeLabelIds: ['UNREAD'] })
  })
  if (!res.ok) { const data = await res.json().catch(() => ({})); console.warn('[email-inbound] markRead failed:', data) }
}

async function markProcessed(supabase, gmailId, conversationId, outcome) {
  await supabase.from('processed_emails').upsert({
    gmail_message_id: gmailId, conversation_id: conversationId, outcome
  }, { onConflict: 'gmail_message_id' })
}

async function findOrCreateEmailConversation(supabase, { email, emailThreadId, customerName }) {
  if (emailThreadId) {
    const { data: byThread } = await supabase
      .from('conversations').select('*')
      .eq('channel', 'email').eq('email_thread_id', emailThreadId).eq('status', 'active').maybeSingle()
    if (byThread) return byThread
  }
  const { data: byEmail } = await supabase
    .from('conversations').select('*')
    .eq('channel', 'email').eq('email', email).eq('status', 'active')
    .order('last_message_at', { ascending: false }).limit(1).maybeSingle()
  if (byEmail) {
    if (emailThreadId && !byEmail.email_thread_id) {
      await supabase.from('conversations').update({ email_thread_id: emailThreadId }).eq('id', byEmail.id)
      byEmail.email_thread_id = emailThreadId
    }
    return byEmail
  }
  const { data: created } = await supabase.from('conversations').insert({
    channel: 'email', party: 'customer',
    email, email_thread_id: emailThreadId || null,
    customer_name: customerName || null, status: 'active'
  }).select().single()
  return created
}

// ─── Gmail parse helpers ───

function decodeBase64Url(b64) {
  if (!b64) return ''
  const s = b64.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(s, 'base64').toString('utf-8')
}

function extractBody(payload) {
  if (!payload) return ''
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decodeBase64Url(payload.body.data)
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) return decodeBase64Url(part.body.data)
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) return stripHtml(decodeBase64Url(part.body.data))
      if (part.parts) {
        const nested = extractBody(part)
        if (nested) return nested
      }
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
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .trim()
}

function stripQuotedReply(body) {
  if (!body) return ''
  const lines = body.split(/\r?\n/)
  const cutPatterns = [/^On .+wrote:\s*$/i, /^-+\s*Original Message\s*-+/i, /^From:\s.+/i, /^>.*$/]
  const out = []
  for (const line of lines) {
    if (cutPatterns.some(p => p.test(line.trim()))) break
    out.push(line)
  }
  return out.join('\n').trim()
}

function parseGmailMessage(msg) {
  const headers = {}
  for (const h of (msg.payload?.headers || [])) headers[h.name.toLowerCase()] = h.value
  const fromHeader = headers['from'] || ''
  const emailMatch = fromHeader.match(/<([^>]+)>/)
  const email = (emailMatch ? emailMatch[1] : fromHeader).trim().toLowerCase()
  const fromName = emailMatch ? fromHeader.replace(/<[^>]+>/, '').trim().replace(/^"(.+)"$/, '$1') : null
  const bodyRaw = extractBody(msg.payload)
  const bodyText = stripQuotedReply(bodyRaw)
  return {
    from: email, fromName,
    to: headers['to'] || '',
    subject: headers['subject'] || '',
    messageIdHeader: headers['message-id'] || null,
    references: headers['references'] || null,
    inReplyTo: headers['in-reply-to'] || null,
    threadId: msg.threadId,
    bodyText
  }
}
