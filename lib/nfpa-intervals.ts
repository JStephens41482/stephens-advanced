// NFPA 10 Interval Calculator
// Knows when every piece of equipment needs service next

export type ExtinguisherType = 'ABC' | 'BC' | 'Class K' | 'CO2' | 'H2O' | 'Class D' | 'Halotron'

// Hydrostatic test intervals per NFPA 10 Table 8.3.1
const HYDRO_INTERVALS: Record<string, number> = {
  'ABC': 12,
  'BC': 12,
  'Class D': 12,
  'Class K': 5,
  'CO2': 5,
  'H2O': 5,
  'Halotron': 12,
}

// 6-year internal inspection applies to stored-pressure dry chem
const SIX_YEAR_TYPES = ['ABC', 'BC']

// Suppression system tank hydro interval
const SUPPRESSION_HYDRO_YEARS = 12

export function getHydroInterval(type: string): number {
  return HYDRO_INTERVALS[type] || 12
}

export function needs6YearInternal(type: string): boolean {
  return SIX_YEAR_TYPES.includes(type)
}

export function calcNextDates(ext: {
  type: string
  manufacture_date?: string | null
  last_inspection?: string | null
  last_6year?: string | null
  last_hydro?: string | null
}): {
  next_inspection: string
  next_6year: string | null
  next_hydro: string
  is_inspection_overdue: boolean
  is_6year_overdue: boolean
  is_hydro_overdue: boolean
} {
  const now = new Date()
  const mfgDate = ext.manufacture_date ? new Date(ext.manufacture_date) : null

  // Annual inspection: 1 year from last inspection
  const lastInsp = ext.last_inspection ? new Date(ext.last_inspection) : mfgDate
  const nextInsp = new Date(lastInsp || now)
  nextInsp.setFullYear(nextInsp.getFullYear() + 1)

  // 6-year internal (dry chem only)
  let next6yr: Date | null = null
  let is6yrOverdue = false
  if (needs6YearInternal(ext.type)) {
    const last6 = ext.last_6year ? new Date(ext.last_6year) : mfgDate
    next6yr = new Date(last6 || now)
    next6yr.setFullYear(next6yr.getFullYear() + 6)
    is6yrOverdue = next6yr <= now
  }

  // Hydrostatic test
  const hydroInterval = getHydroInterval(ext.type)
  const lastHydro = ext.last_hydro ? new Date(ext.last_hydro) : mfgDate
  const nextHydro = new Date(lastHydro || now)
  nextHydro.setFullYear(nextHydro.getFullYear() + hydroInterval)

  return {
    next_inspection: nextInsp.toISOString().split('T')[0],
    next_6year: next6yr ? next6yr.toISOString().split('T')[0] : null,
    next_hydro: nextHydro.toISOString().split('T')[0],
    is_inspection_overdue: nextInsp <= now,
    is_6year_overdue: is6yrOverdue,
    is_hydro_overdue: nextHydro <= now,
  }
}

export function calcSuppressionNextDates(sys: {
  last_inspection?: string | null
  last_hydro?: string | null
  manufacture_date?: string | null
}): {
  next_inspection: string
  next_hydro: string
  is_inspection_overdue: boolean
  is_hydro_overdue: boolean
} {
  const now = new Date()

  // Semi-annual inspection: 6 months from last
  const lastInsp = sys.last_inspection ? new Date(sys.last_inspection) : null
  const nextInsp = new Date(lastInsp || now)
  nextInsp.setMonth(nextInsp.getMonth() + 6)

  // Tank hydro: 12 years
  const mfgDate = sys.manufacture_date ? new Date(sys.manufacture_date) : null
  const lastHydro = sys.last_hydro ? new Date(sys.last_hydro) : mfgDate
  const nextHydro = new Date(lastHydro || now)
  nextHydro.setFullYear(nextHydro.getFullYear() + SUPPRESSION_HYDRO_YEARS)

  return {
    next_inspection: nextInsp.toISOString().split('T')[0],
    next_hydro: nextHydro.toISOString().split('T')[0],
    is_inspection_overdue: nextInsp <= now,
    is_hydro_overdue: nextHydro <= now,
  }
}

export function calcElightNextDate(lastTest?: string | null): {
  next_test: string
  is_overdue: boolean
} {
  const now = new Date()
  const last = lastTest ? new Date(lastTest) : null
  const next = new Date(last || now)
  next.setFullYear(next.getFullYear() + 1)

  return {
    next_test: next.toISOString().split('T')[0],
    is_overdue: next <= now,
  }
}

// Determine what services are due at a location for a given date
export function getLocationDueServices(location: {
  extinguishers: Array<{
    type: string
    manufacture_date?: string | null
    last_inspection?: string | null
    last_6year?: string | null
    last_hydro?: string | null
  }>
  suppressionSystems: Array<{
    last_inspection?: string | null
    last_hydro?: string | null
    manufacture_date?: string | null
  }>
  emergencyLights?: { last_annual_test?: string | null }
}, asOfDate?: Date) {
  const checkDate = asOfDate || new Date()
  const due: string[] = []

  // Check extinguishers
  let anyExtDue = false
  let hydrosNeeded = 0
  let internalsNeeded = 0
  for (const ext of location.extinguishers) {
    const dates = calcNextDates(ext)
    if (dates.is_inspection_overdue) anyExtDue = true
    if (dates.is_hydro_overdue) hydrosNeeded++
    if (dates.is_6year_overdue) internalsNeeded++
  }
  if (anyExtDue) due.push('extinguishers')
  if (hydrosNeeded > 0) due.push('hydro')
  if (internalsNeeded > 0) due.push('6year')

  // Check suppression
  for (const sys of location.suppressionSystems) {
    const dates = calcSuppressionNextDates(sys)
    if (dates.is_inspection_overdue && !due.includes('suppression')) {
      due.push('suppression')
    }
  }

  // Check emergency lights
  if (location.emergencyLights?.last_annual_test) {
    const dates = calcElightNextDate(location.emergencyLights.last_annual_test)
    if (dates.is_overdue) due.push('elights')
  }

  return due
}
