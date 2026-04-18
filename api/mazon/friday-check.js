// /api/mazon/friday-check.js
// Friday 8 AM CT cron. If the pending Mazon queue total is >= $1000, SMS
// Jon a reminder to submit by 10 AM for same-day funding. If below
// threshold, do nothing (no nag).
//
// Called by /api/cron?job=mazon-friday-check (cron schedule in vercel.json)
// or directly via GET /api/mazon/friday-check.

const { createClient } = require('@supabase/supabase-js')
const MAZON = require('../../src/config/mazon')

const JON_PHONE = '+12149944799'

module.exports = async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}` && req.query?.override !== 'test') {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://motjasdokoxwiodwzyps.supabase.co'
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  const supabase = createClient(sbUrl, sbKey)

  try {
    // Only fire on Fridays in America/Chicago unless explicitly overridden
    const now = new Date()
    const dayName = now.toLocaleString('en-US', { weekday: 'short', timeZone: MAZON.TIMEZONE })
    const isFriday = dayName === 'Fri'
    if (!isFriday && req.query?.override !== 'test') {
      return res.status(200).json({ skipped: 'not Friday in ' + MAZON.TIMEZONE, day: dayName })
    }

    // Pull pending queue
    const { data: pending, error } = await supabase
      .from('mazon_queue').select('amount, invoice_number, customer_name')
      .eq('status', 'pending')
    if (error) return res.status(500).json({ error: error.message })

    const count = (pending || []).length
    const total = (pending || []).reduce((s, r) => s + Number(r.amount), 0)

    if (total < MAZON.BATCH_THRESHOLD_USD) {
      return res.status(200).json({
        fired: false,
        reason: 'below threshold',
        count, total,
        threshold: MAZON.BATCH_THRESHOLD_USD
      })
    }

    // Send SMS reminder to Jon
    const message = `Mazon Friday: ${count} invoice${count === 1 ? '' : 's'}, $${total.toFixed(2)} ready to submit. Ships by 10 AM CT for same-day funding.`
    await sendSMS(JON_PHONE, message)

    return res.status(200).json({ fired: true, count, total, message })

  } catch (e) {
    console.error('[friday-check] error:', e)
    return res.status(500).json({ error: e.message })
  }
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
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error('Twilio send failed: ' + (d.message || res.status))
  }
}
