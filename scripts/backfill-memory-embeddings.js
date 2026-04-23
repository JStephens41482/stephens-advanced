#!/usr/bin/env node
// scripts/backfill-memory-embeddings.js
// One-shot: generate embeddings for every riker_memory row that predates
// migration 016. Safe to run repeatedly — rows that already have an embedding
// are skipped by the SQL filter.
//
// Usage:
//   node scripts/backfill-memory-embeddings.js
//
// Requires env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//               and VOYAGE_API_KEY or OPENAI_API_KEY.

require('dotenv').config({ path: '.env.local' })

const { createClient } = require('@supabase/supabase-js')
const memory = require('../api/riker-memory')
const embeddings = require('../api/riker-embeddings')

async function main() {
  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!sbUrl || !sbKey) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
    process.exit(1)
  }
  if (!embeddings.isAvailable()) {
    console.error('No embedding provider. Set VOYAGE_API_KEY or OPENAI_API_KEY in .env.local')
    process.exit(1)
  }
  console.log(`[backfill] provider=${embeddings.resolveProvider()}`)

  const supabase = createClient(sbUrl, sbKey)
  const start = Date.now()
  const result = await memory.backfillEmbeddings(supabase, {
    batchSize: 25,
    maxBatches: 100
  })
  const elapsed = Math.round((Date.now() - start) / 1000)
  console.log(`[backfill] done in ${elapsed}s:`, result)
}

main().catch(e => {
  console.error('[backfill] fatal:', e)
  process.exit(1)
})
