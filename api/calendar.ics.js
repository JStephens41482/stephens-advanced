const { createClient } = require('@supabase/supabase-js')

const DAY_MAP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

function expandRecurring(events, rangeStart, rangeEnd) {
  const rs = new Date(rangeStart), re = new Date(rangeEnd)
  const results = []
  for (const ev of (events || [])) {
    if (!ev.recurring) {
      const st = new Date(ev.start_time)
      if (st >= rs && st <= re) results.push({ ...ev, _expanded: false })
      continue
    }
    const rule = ev.recurrence_rule || {}
    const until = rule.until ? new Date(rule.until + 'T23:59:59') : re
    const effEnd = until < re ? until : re
    const baseStart = new Date(ev.start_time)
    const baseEnd = new Date(ev.end_time)
    const durMs = baseEnd - baseStart

    if (rule.freq === 'weekly' && rule.days) {
      const targetDays = rule.days.map(d => DAY_MAP[d]).filter(d => d !== undefined)
      let cur = new Date(rs)
      cur.setHours(0, 0, 0, 0)
      while (cur <= effEnd) {
        if (targetDays.includes(cur.getDay())) {
          const oStart = new Date(cur)
          oStart.setHours(baseStart.getHours(), baseStart.getMinutes(), baseStart.getSeconds())
          if (oStart >= rs && oStart <= effEnd) {
            const oEnd = new Date(oStart.getTime() + durMs)
            results.push({ ...ev, start_time: oStart.toISOString(), end_time: oEnd.toISOString(), _uid: ev.id + '-' + oStart.toISOString() })
          }
        }
        cur.setDate(cur.getDate() + 1)
      }
    } else if (rule.freq === 'monthly' && rule.day_of_month) {
      let cur = new Date(rs.getFullYear(), rs.getMonth(), 1)
      while (cur <= effEnd) {
        const dom = rule.day_of_month
        const dim = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate()
        if (dom <= dim) {
          const oStart = new Date(cur.getFullYear(), cur.getMonth(), dom, baseStart.getHours(), baseStart.getMinutes())
          if (oStart >= rs && oStart <= effEnd) {
            const oEnd = new Date(oStart.getTime() + durMs)
            results.push({ ...ev, start_time: oStart.toISOString(), end_time: oEnd.toISOString(), _uid: ev.id + '-' + oStart.toISOString() })
          }
        }
        cur.setMonth(cur.getMonth() + 1)
      }
    }
  }
  return results
}

function toICSDate(d) {
  const dt = new Date(d)
  return dt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function escICS(s) {
  return (s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')
}

module.exports = async function handler(req, res) {
  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!sbUrl || !sbKey) return res.status(500).send('Missing Supabase config')

  const sb = createClient(sbUrl, sbKey)
  const { data: events } = await sb.from('calendar_events').select('*')

  const now = new Date()
  const rangeEnd = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000) // 90 days
  const expanded = expandRecurring(events || [], now, rangeEnd)

  let ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Stephens Advanced//Field Service//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Stephens Advanced',
    'X-WR-TIMEZONE:America/Chicago'
  ]

  for (const ev of expanded) {
    const uid = ev._uid || ev.id
    ics.push('BEGIN:VEVENT')
    ics.push('UID:' + uid + '@stephensadvanced.com')
    ics.push('DTSTART:' + toICSDate(ev.start_time))
    ics.push('DTEND:' + toICSDate(ev.end_time))
    ics.push('SUMMARY:' + escICS(ev.title))
    if (ev.location_text) ics.push('LOCATION:' + escICS(ev.location_text))
    if (ev.notes) ics.push('DESCRIPTION:' + escICS(ev.notes))
    ics.push('STATUS:CONFIRMED')
    ics.push('END:VEVENT')
  }

  ics.push('END:VCALENDAR')

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="stephens-advanced.ics"')
  res.status(200).send(ics.join('\r\n'))
}
