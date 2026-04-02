// /api/upc-lookup.js — Fire extinguisher barcode → product data
// Uses UPCitemdb.com free API (100/day) with local cache in Supabase

const { createClient } = require('@supabase/supabase-js')

// Known extinguisher patterns — maps UPC prefixes and keywords to type/size
const EXT_PATTERNS = {
  // Size detection from product title
  sizes: [
    { pattern: /(\d+(?:\.\d+)?)\s*(?:lb|pound)/i, extract: (m) => m[1] + 'lb' },
    { pattern: /(\d+(?:\.\d+)?)\s*(?:liter|litre|ltr)/i, extract: (m) => m[1] + ' Liter' },
    { pattern: /(\d+(?:\.\d+)?)\s*(?:gal|gallon)/i, extract: (m) => m[1] + 'gal' },
    { pattern: /(\d+(?:\.\d+)?)\s*(?:oz|ounce)/i, extract: (m) => m[1] + 'oz' },
  ],
  // Type detection from product title
  types: [
    { pattern: /class\s*k/i, type: 'Class K' },
    { pattern: /co2|carbon dioxide/i, type: 'CO2' },
    { pattern: /halon/i, type: 'Halon' },
    { pattern: /halotron/i, type: 'Halotron' },
    { pattern: /purple\s*k/i, type: 'Purple K' },
    { pattern: /clean\s*agent/i, type: 'Clean Agent' },
    { pattern: /class\s*d/i, type: 'Class D' },
    { pattern: /water/i, type: 'Water' },
    { pattern: /bc\s+dry/i, type: 'BC Dry Chemical' },
    { pattern: /abc|dry\s*chem|multi.?purpose/i, type: 'ABC Dry Chemical' },
  ],
  // Brand detection
  brands: [
    { pattern: /amerex/i, brand: 'Amerex' },
    { pattern: /kidde/i, brand: 'Kidde' },
    { pattern: /buckeye/i, brand: 'Buckeye' },
    { pattern: /ansul/i, brand: 'Ansul' },
    { pattern: /badger/i, brand: 'Badger' },
    { pattern: /first\s*alert/i, brand: 'First Alert' },
    { pattern: /strike\s*first/i, brand: 'Strike First' },
    { pattern: /pyro.?chem/i, brand: 'Pyro-Chem' },
  ]
}

function parseProductTitle(title) {
  if (!title) return {}
  const result = {}

  // Brand
  for (const b of EXT_PATTERNS.brands) {
    if (b.pattern.test(title)) { result.brand = b.brand; break }
  }

  // Type
  for (const t of EXT_PATTERNS.types) {
    if (t.pattern.test(title)) { result.type = t.type; break }
  }

  // Size
  for (const s of EXT_PATTERNS.sizes) {
    const m = title.match(s.pattern)
    if (m) { result.size = s.extract(m); break }
  }

  // Model number — look for patterns like B500, PRO10, etc
  const modelMatch = title.match(/\b([A-Z]{1,3}[\-]?\d{2,5}[A-Z]*)\b/i)
  if (modelMatch) result.model = modelMatch[1]

  return result
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const { barcode, format } = req.body
  if (!barcode) return res.status(400).json({ error: 'barcode required' })

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://motjasdokoxwiodwzyps.supabase.co'
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1vdGphc2Rva294d2lvZHd6eXBzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzNDI2NTcsImV4cCI6MjA4ODkxODY1N30.IMf0plnDRhVgts9LjJr219Tax4J175iuWN1u6ZKTZ-I'
  const sb = createClient(sbUrl, sbKey)

  // Check local cache first
  try {
    const { data: cached } = await sb.from('barcode_cache').select('*').eq('barcode', barcode).limit(1).single()
    if (cached) {
      return res.json({ success: true, source: 'cache', ...cached.product_data })
    }
  } catch (e) {} // no cache hit

  // Try UPCitemdb API (free, no key needed for basic)
  let product = null
  try {
    const upcRes = await fetch('https://api.upcitemdb.com/prod/trial/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upc: barcode })
    })
    const upcData = await upcRes.json()

    if (upcData.items?.length) {
      const item = upcData.items[0]
      const parsed = parseProductTitle(item.title || '')
      product = {
        title: item.title || '',
        brand: parsed.brand || item.brand || '',
        type: parsed.type || 'ABC Dry Chemical',
        size: parsed.size || '',
        model: parsed.model || item.model || '',
        upc: barcode,
        category: item.category || '',
        description: item.description || ''
      }
    }
  } catch (e) {
    console.error('UPC API error:', e)
  }

  // If UPC lookup failed, try serial number pattern matching
  if (!product) {
    // Serial barcodes (Code 128/39) — extract manufacturer from pattern
    const brands = {
      Amerex: [/^B\d{3}/i, /^A\d{3}/i, /^24\d/],
      Kidde: [/^XY/i, /^PRO/i, /^46\d/],
      Buckeye: [/^BK/i, /^121/],
      Ansul: [/^AN/i, /^43\d/, /^SEN/i],
      Badger: [/^BG/i, /^BD/i],
    }
    let mfr = ''
    for (const [name, patterns] of Object.entries(brands)) {
      if (patterns.some(p => p.test(barcode))) { mfr = name; break }
    }
    product = {
      title: '',
      brand: mfr,
      type: '',
      size: '',
      model: '',
      serial: barcode,
      upc: '',
      isSerial: true
    }
  }

  // Cache the result
  if (product && !product.isSerial) {
    try {
      await sb.from('barcode_cache').upsert({
        barcode,
        format: format || 'unknown',
        product_data: product,
        created_at: new Date().toISOString()
      }, { onConflict: 'barcode' })
    } catch (e) { console.error('cache save:', e) }
  }

  res.json({ success: true, source: 'api', ...product })
}
