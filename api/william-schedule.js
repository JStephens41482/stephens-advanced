// /api/william-schedule.js
// Tarrant County extended standard possession order — computes Jon's custody
// constraints day by day.
//
// William (13) attends Nichols Junior High in Arlington. Drop-off by 8:40,
// pickup at 4:10. Mom has extended Thursdays (Thu school dismissal -> Fri
// school start) and extended 1st/3rd/5th weekends (Thu school dismissal ->
// Mon school start). Jon has everything else during school year.
//
// Summer and specific holidays are NOT yet encoded — override via a manual
// "William" Google Calendar until those rules are added.

const SCHOOL = {
  name: 'Nichols Junior High',
  address: 'Nichols Junior High School, Arlington, TX',
  dropoffBy: '08:40',
  pickupAt: '16:10'
}

const DRIVE_BUFFER_MIN = 20

// Approximate Arlington ISD school year window
const SCHOOL_YEAR = {
  startMonth: 8, startDay: 15,   // Aug 15
  endMonth: 5, endDay: 30        // May 30
}

function isSchoolYear(date) {
  const m = date.getMonth() + 1
  const d = date.getDate()
  const afterStart = m > SCHOOL_YEAR.startMonth || (m === SCHOOL_YEAR.startMonth && d >= SCHOOL_YEAR.startDay)
  const beforeEnd = m < SCHOOL_YEAR.endMonth || (m === SCHOOL_YEAR.endMonth && d <= SCHOOL_YEAR.endDay)
  return afterStart || beforeEnd
}

function isWeekday(date) {
  const dow = date.getDay()
  return dow >= 1 && dow <= 5
}

function isSchoolDay(date) {
  return isSchoolYear(date) && isWeekday(date)
}

// Which Friday of the month is the Friday anchoring this date's week?
// Returns 1-5. A Saturday/Sunday uses the Friday just before.
function fridayRankForDate(date) {
  const d = new Date(date)
  const dow = d.getDay()
  let fri
  if (dow === 6) { fri = new Date(d); fri.setDate(d.getDate() - 1) }
  else if (dow === 0) { fri = new Date(d); fri.setDate(d.getDate() - 2) }
  else { fri = new Date(d); fri.setDate(d.getDate() + (5 - dow)) }
  const firstOfMonth = new Date(fri.getFullYear(), fri.getMonth(), 1)
  const firstFridayOffset = (5 - firstOfMonth.getDay() + 7) % 7
  const firstFriday = 1 + firstFridayOffset
  return Math.floor((fri.getDate() - firstFriday) / 7) + 1
}

function isMomsWeekend(date) {
  const rank = fridayRankForDate(date)
  return rank === 1 || rank === 3 || rank === 5
}

function addMin(timeStr, min) {
  const [h, m] = timeStr.split(':').map(Number)
  const total = Math.max(0, Math.min(24 * 60 - 1, h * 60 + m + min))
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0')
}

// Main: Jon's work availability for a given date
// Returns:
//   { available: bool, workStart: "HH:MM"|null, workEnd: "HH:MM"|null,
//     pickupRequired: bool, dropoffRequired: bool, reason: string }
function getJonAvailability(date) {
  const d = new Date(date)
  const dow = d.getDay()
  const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow]

  // Weekend during school year
  if (isSchoolYear(d) && (dow === 6 || dow === 0)) {
    if (isMomsWeekend(d)) {
      return {
        available: true,
        workStart: '08:00',
        workEnd: '18:00',
        pickupRequired: false,
        dropoffRequired: false,
        reason: `${dayName}: mom's weekend (1st/3rd/5th) — William with mom`
      }
    }
    return {
      available: false,
      workStart: null,
      workEnd: null,
      pickupRequired: false,
      dropoffRequired: false,
      reason: `${dayName}: Jon's weekend — William with Jon`
    }
  }

  // Outside school year — summer/holiday custody not yet encoded
  if (!isSchoolDay(d)) {
    return {
      available: true,
      workStart: '07:00',
      workEnd: '18:00',
      pickupRequired: false,
      dropoffRequired: false,
      reason: `${dayName}: outside school year — verify custody manually (summer rules not yet encoded)`
    }
  }

  // School weekday — determine drop-off and pickup responsibility
  let jonHadOvernight = true

  if (dow === 5) {
    // Friday morning — mom always had Thursday overnight
    jonHadOvernight = false
  } else if (dow === 1) {
    // Monday morning — Sunday night depends on whose weekend just ended
    const lastFri = new Date(d); lastFri.setDate(d.getDate() - 3)
    if (isMomsWeekend(lastFri)) jonHadOvernight = false
  }

  let jonPicksUp = true
  if (dow === 4) {
    // Thursday — mom always picks up
    jonPicksUp = false
  } else if (dow === 5) {
    // Friday — depends on whose weekend
    if (isMomsWeekend(d)) jonPicksUp = false
  }

  const workStart = jonHadOvernight ? addMin(SCHOOL.dropoffBy, DRIVE_BUFFER_MIN) : '07:00'
  const workEnd = jonPicksUp ? addMin(SCHOOL.pickupAt, -DRIVE_BUFFER_MIN) : '18:00'

  const notes = []
  notes.push(jonHadOvernight ? `Jon drops William ${SCHOOL.dropoffBy}` : 'Mom drops William')
  notes.push(jonPicksUp ? `Jon picks up ${SCHOOL.pickupAt}` : 'Mom picks up')

  return {
    available: true,
    workStart,
    workEnd,
    pickupRequired: jonPicksUp,
    dropoffRequired: jonHadOvernight,
    reason: `${dayName}: ${notes.join('; ')}`
  }
}

// Return busy blocks for a given date (YYYY-MM-DD string) so they can be
// merged with existing calendar busy blocks by the scheduler.
function getWilliamBusyBlocks(dateStr) {
  const date = new Date(dateStr + 'T12:00:00')
  const avail = getJonAvailability(date)
  const blocks = []

  if (!avail.available) {
    blocks.push({ start: '00:00', end: '23:59', reason: avail.reason, source: 'william' })
    return blocks
  }
  if (avail.workStart > '00:00') {
    blocks.push({
      start: '00:00',
      end: avail.workStart,
      reason: avail.dropoffRequired ? `Jon drops William at school (${SCHOOL.dropoffBy})` : 'Before work hours',
      source: 'william'
    })
  }
  if (avail.workEnd < '23:59') {
    blocks.push({
      start: avail.workEnd,
      end: '23:59',
      reason: avail.pickupRequired ? `Jon picks up William (${SCHOOL.pickupAt})` : 'After work hours',
      source: 'william'
    })
  }
  return blocks
}

// Summary text for Riker's context — one line per day, the next N days.
function getAvailabilitySummary(days = 7) {
  const lines = []
  const cur = new Date()
  for (let i = 0; i < days; i++) {
    const d = new Date(cur); d.setDate(cur.getDate() + i)
    const dateStr = d.toISOString().split('T')[0]
    const a = getJonAvailability(d)
    if (!a.available) {
      lines.push(`${dateStr} — UNAVAILABLE (${a.reason})`)
    } else {
      lines.push(`${dateStr} — work ${a.workStart}–${a.workEnd} (${a.reason})`)
    }
  }
  return lines.join('\n')
}

module.exports = {
  SCHOOL,
  DRIVE_BUFFER_MIN,
  getJonAvailability,
  getWilliamBusyBlocks,
  getAvailabilitySummary,
  fridayRankForDate,
  isMomsWeekend,
  isSchoolDay,
  isSchoolYear
}
