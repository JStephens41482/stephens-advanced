import { supabase } from './supabase'

export type RateCard = Record<string, number>

let cachedRates: RateCard | null = null

export async function getRateCard(): Promise<RateCard> {
  if (cachedRates) return cachedRates

  const { data, error } = await supabase
    .from('rate_card')
    .select('key, price')

  if (error || !data) {
    console.error('Failed to load rate card:', error)
    return getDefaultRates()
  }

  const rates: RateCard = {}
  data.forEach((r: { key: string; price: number }) => {
    rates[r.key] = Number(r.price)
  })

  cachedRates = rates
  return rates
}

export function clearRateCardCache() {
  cachedRates = null
}

export function getDefaultRates(): RateCard {
  return {
    extinguisher_inspection: 20,
    suppression_standard: 250,
    suppression_captiveaire_tank: 450,
    suppression_captiveaire_core: 650,
    suppression_additional_tank: 50,
    emergency_light: 20,
    hydro_class_k: 275,
    hydro_co2: 72,
    hydro_h2o: 57,
    hydro_abc: 68,
    dry_chem_internal: 68,
    labor_hr: 200,
    fusible_link: 25,
    nozzle: 92.50,
    silicone_cap: 9,
    metal_blowoff_cap: 25,
    new_5lb_ext: 102.50,
    new_10lb_ext: 141.50,
    emergency_call: 500,
    emergency_after_hrs: 750,
    emergency_holiday: 1000,
    travel_rate_hr: 250,
    travel_free_radius: 50,
    travel_mileage_rate: 0.70,
  }
}

export function calcSuppressionPrice(
  category: string,
  tankCount: number,
  rates: RateCard
): number {
  let base = rates.suppression_standard
  if (category === 'captiveaire_tank') base = rates.suppression_captiveaire_tank
  if (category === 'captiveaire_core') base = rates.suppression_captiveaire_core
  return base + ((tankCount - 1) * rates.suppression_additional_tank)
}

export function calcTravelCharge(
  distanceMiles: number,
  rates: RateCard
): number {
  const freeRadius = rates.travel_free_radius
  if (distanceMiles <= freeRadius) return 0
  
  const excessMiles = distanceMiles - freeRadius
  // Estimate drive time at 45mph average
  const driveTimeHours = excessMiles / 45
  // Round trip
  const roundTripHours = driveTimeHours * 2
  const roundTripMiles = excessMiles * 2
  
  const timeCost = roundTripHours * rates.travel_rate_hr
  const mileageCost = roundTripMiles * rates.travel_mileage_rate
  
  return Math.round((timeCost + mileageCost) * 100) / 100
}

export function calcHydroPrice(extType: string, rates: RateCard): number {
  switch (extType) {
    case 'Class K': return rates.hydro_class_k
    case 'CO2': return rates.hydro_co2
    case 'H2O': return rates.hydro_h2o
    default: return rates.hydro_abc
  }
}
