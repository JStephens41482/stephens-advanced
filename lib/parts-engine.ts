// Smart Parts Engine
// Resolves fuzzy part names to specific parts based on system type

export type SystemPartProfile = {
  cartridge: string
  cartridgeOptions?: string[] // if multiple options exist
  capType: string
  capDescription: string
  agentType: string
  detectionType: string
}

const SYSTEM_PARTS: Record<string, SystemPartProfile> = {
  'Ansul R-102': {
    cartridge: 'LT-10 Nitrogen',
    cartridgeOptions: ['LT-10 Nitrogen', 'LT-30 Nitrogen'],
    capType: 'rubber',
    capDescription: 'Rubber Blow-Off Cap',
    agentType: 'Ansulex Wet Chemical',
    detectionType: 'fusible_link',
  },
  'Ansul Piranha': {
    cartridge: 'LT-10 Nitrogen',
    cartridgeOptions: ['LT-10 Nitrogen', 'LT-30 Nitrogen'],
    capType: 'rubber',
    capDescription: 'Rubber Blow-Off Cap',
    agentType: 'Ansulex Wet Chemical',
    detectionType: 'fusible_link',
  },
  'Pyro-Chem Kitchen Knight II': {
    cartridge: '16g CO2 Cartridge',
    capType: 'rubber',
    capDescription: 'Rubber Nozzle Cap',
    agentType: 'Pyro-Chem Wet Chemical',
    detectionType: 'fusible_link',
  },
  'Buckeye Kitchen Mister': {
    cartridge: 'BFR-AC-S Nitrogen',
    cartridgeOptions: ['BFR-AC-S Nitrogen (Small)', 'BFR-AC-L Nitrogen (Large)'],
    capType: 'stainless_steel',
    capDescription: 'Stainless Steel Nozzle Cap',
    agentType: 'Buckeye Wet Chemical',
    detectionType: 'shielded_cable',
  },
  'Kidde WHDR': {
    cartridge: 'Kidde XV Nitrogen Cartridge',
    capType: 'foil_seal',
    capDescription: 'Threaded Cap with Foil Seal',
    agentType: 'Kidde APC Wet Chemical',
    detectionType: 'fusible_link',
  },
  'Pyro-Chem Monarch': {
    cartridge: '16g CO2 Cartridge',
    capType: 'rubber',
    capDescription: 'Rubber Nozzle Cap',
    agentType: 'Dry Chemical',
    detectionType: 'fusible_link',
  },
}

export function getSystemParts(systemType: string): SystemPartProfile | null {
  // Exact match first
  if (SYSTEM_PARTS[systemType]) return SYSTEM_PARTS[systemType]

  // Fuzzy match
  const lower = systemType.toLowerCase()
  for (const [key, profile] of Object.entries(SYSTEM_PARTS)) {
    if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
      return profile
    }
  }

  return null
}

export function resolveCartridge(systemType: string, tankCount: number): string {
  const parts = getSystemParts(systemType)
  if (!parts) return 'Unknown Cartridge'

  // Ansul R-102 and Piranha: LT-30 for multi-tank, LT-10 for single
  if (systemType.includes('R-102') || systemType.includes('Piranha')) {
    return tankCount > 1 ? 'LT-30 Nitrogen' : 'LT-10 Nitrogen'
  }

  return parts.cartridge
}

// Fuzzy text matching for part entry
const PART_ALIASES: Record<string, string[]> = {
  'cartridge': ['cartridge', 'cart', 'co2 cart', 'actuation cartridge', 'nitrogen cart', 'n2 cart'],
  'nozzle': ['nozzle', 'noz', 'discharge nozzle'],
  'fusible_link': ['link', 'fusible link', 'fuse link', 'detection link', 'links'],
  'cap': ['cap', 'blow off cap', 'blowoff cap', 'nozzle cap', 'blow-off'],
  'agent': ['agent', 'chemical', 'wet chem', 'ansulex', 'recharge'],
  'gas_valve': ['gas valve', 'shutoff', 'shut off', 'gas shutoff'],
  'pull_station': ['pull station', 'pull', 'manual pull', 'remote pull'],
}

export function resolvePartFromText(input: string, systemType: string): {
  partCategory: string
  specificPart: string
} | null {
  const lower = input.toLowerCase().trim()
  const parts = getSystemParts(systemType)
  if (!parts) return null

  for (const [category, aliases] of Object.entries(PART_ALIASES)) {
    for (const alias of aliases) {
      if (lower.includes(alias) || alias.includes(lower)) {
        switch (category) {
          case 'cartridge':
            return { partCategory: 'cartridge', specificPart: parts.cartridge }
          case 'cap':
            return { partCategory: 'cap', specificPart: parts.capDescription }
          case 'fusible_link':
            return { partCategory: 'fusible_link', specificPart: 'Fusible Link' }
          case 'nozzle':
            return { partCategory: 'nozzle', specificPart: 'Discharge Nozzle' }
          case 'agent':
            return { partCategory: 'agent', specificPart: parts.agentType }
          case 'gas_valve':
            return { partCategory: 'gas_valve', specificPart: 'Gas Shutoff Valve' }
          case 'pull_station':
            return { partCategory: 'pull_station', specificPart: 'Remote Manual Pull Station' }
        }
      }
    }
  }

  return null
}

// Calculate daily load list from jobs
export function calcLoadList(jobs: Array<{
  suppressionSystems: Array<{
    system_type: string
    tank_count: number
    nozzle_count: number
    fusible_link_count: number
  }>
  extinguisherCount: number
  emergencyLightCount: number
  scope: string[]
}>) {
  let tags = 0
  let links = 0
  let caps = 0
  const cartridges: string[] = []

  for (const job of jobs) {
    if (job.scope.includes('extinguishers')) {
      tags += job.extinguisherCount
    }

    if (job.scope.includes('suppression')) {
      for (const sys of job.suppressionSystems) {
        links += sys.fusible_link_count
        caps += sys.nozzle_count
        cartridges.push(resolveCartridge(sys.system_type, sys.tank_count))
      }
    }
  }

  return { tags, links, caps, cartridges }
}
