// /api/riker-memory.js
// The notebook. Read relevant entries before every Claude call, write new
// ones when Riker issues memory_write actions, prune daily.

const embeddings = require('./riker-embeddings')

// ═══ READ ═══

// Pull the memories that should be injected into the system prompt for
// this conversation. Scoping rules:
//   - all 'global' (category != 'internal' for non-app contexts)
//   - all for the given location_id
//   - all for the given billing_account_id
//   - all 'action_pending' for today (across locations)
//   - priority >= 8 created in last 7 days (across locations)
// In non-app contexts, 'internal' category memories are filtered out.
async function readRelevantMemories({ supabase, context, locationId, billingAccountId, techId }) {
  const now = new Date()
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString()
  const todayStr = now.toISOString().split('T')[0]

  // Build conditions piecewise — Supabase's or() is string-based, so we
  // compose it from the bits we know.
  const orConditions = ['scope.eq.global']
  if (locationId) orConditions.push(`location_id.eq.${locationId}`)
  if (billingAccountId) orConditions.push(`billing_account_id.eq.${billingAccountId}`)
  if (techId) orConditions.push(`tech_id.eq.${techId}`)
  orConditions.push(`category.eq.action_pending`)
  // priority >= 8 AND recent — we'll filter in JS for simplicity

  let query = supabase
    .from('riker_memory')
    .select('*')
    .eq('archived', false)
    .or(orConditions.join(','))
    .order('priority', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(150)

  const { data, error } = await query
  if (error) {
    console.error('[riker-memory] read error:', error)
    return []
  }

  const now2 = new Date()
  const results = (data || []).filter(m => {
    if (m.expires_at && new Date(m.expires_at) < now2) return false
    // Non-app contexts never see internal memories
    if (context !== 'app' && m.category === 'internal') return false
    return true
  })

  // Add recent high-priority global entries we may have missed
  const { data: priorityRecent } = await supabase
    .from('riker_memory')
    .select('*')
    .eq('archived', false)
    .gte('priority', 8)
    .gte('created_at', weekAgo)
    .limit(25)

  for (const m of (priorityRecent || [])) {
    if (!results.find(r => r.id === m.id)) {
      if (context !== 'app' && m.category === 'internal') continue
      if (m.expires_at && new Date(m.expires_at) < now2) continue
      results.push(m)
    }
  }

  return results
}

function renderMemoriesForPrompt(memories) {
  if (!memories || !memories.length) return '(no notebook entries)'
  // Sort: priority DESC, then updated_at DESC
  const sorted = [...memories].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority
    return new Date(b.updated_at) - new Date(a.updated_at)
  })
  return sorted.map(m => {
    const bits = [`[${m.category}, p${m.priority}`]
    if (m.expires_at) bits.push(`expires ${m.expires_at.slice(0, 10)}`)
    if (m.scope === 'location' && m.location_id) bits.push(`loc ${m.location_id.slice(0, 8)}`)
    bits.push(']')
    return `- ${bits.join(' ')} ${m.content}`
  }).join('\n')
}

// ═══ WRITE ═══

// Phase 5: fuzzy dedup. Exact content match is too strict — "Jon prefers
// 9am appointments" and "jon prefers morning appointments at 9" shouldn't
// become two separate notebook rows. We normalize + Levenshtein compare and
// treat anything ≥ 0.85 similar as the same entry (UPDATE, don't INSERT).
const FUZZY_DEDUP_THRESHOLD = 0.85
const FUZZY_CANDIDATE_CAP = 30

// Phase 7 (pgvector): semantic dedup. Levenshtein was blind to paraphrase —
// "trip charge is $125" and "charge customers $125 for trips" are edit-
// distance far apart but semantically identical. We now embed each write
// (voyage-3-lite or text-embedding-3-small @ 1024 dim), cosine-compare to
// recent entries in the same scope/category/location, and merge when cosine
// distance ≤ SEMANTIC_DEDUP_DISTANCE (≈ similarity ≥ 0.88).
//
// If no embedding provider is configured the writeMemory() path silently
// falls back to Levenshtein so nothing breaks in dev environments.
const SEMANTIC_DEDUP_DISTANCE = 0.12            // cosine distance ceiling (≈ 0.88 sim)
const SEMANTIC_CANDIDATE_CAP = 5                // how many nearest candidates to consider

function _normalizeForCompare(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')   // strip punctuation
    .replace(/\s+/g, ' ')
    .trim()
}

// Classic Levenshtein, two-row implementation. O(n*m) memory = O(min(n,m)).
function _levenshtein(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  // Ensure a is the shorter — memory scales with a.length
  if (a.length > b.length) { const t = a; a = b; b = t }
  let prev = new Array(a.length + 1)
  let cur = new Array(a.length + 1)
  for (let i = 0; i <= a.length; i++) prev[i] = i
  for (let j = 1; j <= b.length; j++) {
    cur[0] = j
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[i] = Math.min(
        cur[i - 1] + 1,       // insertion
        prev[i] + 1,          // deletion
        prev[i - 1] + cost    // substitution
      )
    }
    const tmp = prev; prev = cur; cur = tmp
  }
  return prev[a.length]
}

function _similarity(a, b) {
  const A = _normalizeForCompare(a)
  const B = _normalizeForCompare(b)
  if (!A && !B) return 1
  const maxLen = Math.max(A.length, B.length)
  if (maxLen === 0) return 1
  // Fast reject: length ratio too far apart can't exceed threshold
  const minLen = Math.min(A.length, B.length)
  if (minLen / maxLen < FUZZY_DEDUP_THRESHOLD - 0.05) return 0
  const dist = _levenshtein(A, B)
  return 1 - (dist / maxLen)
}

async function writeMemory(supabase, entry, { sessionId, source } = {}) {
  const row = {
    scope: entry.scope,
    category: entry.category,
    content: entry.content,
    priority: entry.priority || 5,
    expires_at: entry.expires_at || null,
    location_id: entry.location_id || null,
    billing_account_id: entry.billing_account_id || null,
    job_id: entry.job_id || null,
    tech_id: entry.tech_id || null,
    source: source || null,
    source_session_id: sessionId || null,
    auto_generated: true
  }

  // 1) Exact-match fast path (cheap index hit).
  const { data: exact } = await supabase
    .from('riker_memory')
    .select('id, priority')
    .eq('archived', false)
    .eq('scope', row.scope)
    .eq('category', row.category)
    .eq('content', row.content)
    .eq('location_id', row.location_id)
    .limit(1)
    .maybeSingle()
  if (exact) {
    await supabase.from('riker_memory').update({
      priority: Math.max(exact.priority, row.priority),
      updated_at: new Date().toISOString(),
      expires_at: row.expires_at
    }).eq('id', exact.id)
    return { id: exact.id, updated: true, match: 'exact' }
  }

  // 2) Semantic dedup via pgvector cosine. We embed the candidate content,
  // ask Postgres for the nearest neighbors in the same scope/category (and
  // location if set) within SEMANTIC_DEDUP_DISTANCE, and treat the closest
  // as "same entry" → UPDATE. This catches paraphrased rewrites that the
  // Levenshtein path missed.
  //
  // Embedding generation is best-effort: if no provider is configured or
  // the call fails, embedResult is null and we fall through to Levenshtein.
  const embedResult = await embeddings.embedText(row.content)
  if (embedResult) {
    const vecStr = embeddings.toPgVector(embedResult.vector)
    const { data: neighbors, error: rpcErr } = await supabase.rpc('match_memory_candidates', {
      query_embedding: vecStr,
      p_scope: row.scope,
      p_category: row.category,
      p_location_id: row.location_id,
      p_threshold: SEMANTIC_DEDUP_DISTANCE,
      p_match_count: SEMANTIC_CANDIDATE_CAP
    })
    if (rpcErr) {
      console.error('[riker-memory] semantic match rpc error:', rpcErr.message)
    } else if (neighbors && neighbors.length) {
      const best = neighbors[0]  // RPC already sorted by distance ASC
      await supabase.from('riker_memory').update({
        content: row.content,
        priority: Math.max(best.priority, row.priority),
        updated_at: new Date().toISOString(),
        expires_at: row.expires_at,
        embedding: vecStr,
        embedding_model: embedResult.model
      }).eq('id', best.id)
      return {
        id: best.id,
        updated: true,
        match: 'semantic',
        distance: best.distance,
        similarity: 1 - best.distance
      }
    }
  }

  // 3) Fuzzy (Levenshtein) fallback: either the embedding provider is
  // unavailable, or pgvector found no neighbors. This keeps dev/test
  // environments working without an embedding API key.
  let candQ = supabase.from('riker_memory')
    .select('id, content, priority')
    .eq('archived', false)
    .eq('scope', row.scope)
    .eq('category', row.category)
    .order('updated_at', { ascending: false })
    .limit(FUZZY_CANDIDATE_CAP)
  if (row.location_id) candQ = candQ.eq('location_id', row.location_id)
  else candQ = candQ.is('location_id', null)
  const { data: candidates } = await candQ

  let bestMatch = null
  let bestScore = 0
  for (const c of (candidates || [])) {
    const s = _similarity(row.content, c.content)
    if (s > bestScore) { bestScore = s; bestMatch = c }
  }
  if (bestMatch && bestScore >= FUZZY_DEDUP_THRESHOLD) {
    const update = {
      content: row.content,
      priority: Math.max(bestMatch.priority, row.priority),
      updated_at: new Date().toISOString(),
      expires_at: row.expires_at
    }
    if (embedResult) {
      update.embedding = embeddings.toPgVector(embedResult.vector)
      update.embedding_model = embedResult.model
    }
    await supabase.from('riker_memory').update(update).eq('id', bestMatch.id)
    return { id: bestMatch.id, updated: true, match: 'fuzzy', score: bestScore }
  }

  // 4) No match — insert new row. Attach embedding if we have one so future
  // writes can semantic-dedup against it.
  if (embedResult) {
    row.embedding = embeddings.toPgVector(embedResult.vector)
    row.embedding_model = embedResult.model
  }
  const { data: inserted, error } = await supabase.from('riker_memory').insert(row).select().single()
  if (error) {
    console.error('[riker-memory] write error:', error)
    return null
  }
  return { id: inserted.id, updated: false, match: 'new' }
}

async function deleteMemory(supabase, memoryId, reason) {
  // Soft delete — archive rather than hard delete
  await supabase.from('riker_memory').update({
    archived: true,
    updated_at: new Date().toISOString(),
    content: reason ? `[archived: ${reason}] ` + (await getContent(supabase, memoryId)) : undefined
  }).eq('id', memoryId)
}

async function getContent(supabase, memoryId) {
  const { data } = await supabase.from('riker_memory').select('content').eq('id', memoryId).maybeSingle()
  return data?.content || ''
}

// ═══ PRUNE ═══

// Daily maintenance: archive expired, archive stale low-priority conversation
// memories, archive completed action_pending entries (caller provides
// completion check).
async function pruneMemories(supabase) {
  const now = new Date().toISOString()
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString()

  const { data: expiredRows } = await supabase
    .from('riker_memory')
    .update({ archived: true, updated_at: now })
    .eq('archived', false)
    .lt('expires_at', now)
    .select('id')

  const { data: staleRows } = await supabase
    .from('riker_memory')
    .update({ archived: true, updated_at: now })
    .eq('archived', false)
    .eq('category', 'conversation')
    .lt('priority', 5)
    .lt('created_at', thirtyDaysAgo)
    .select('id')

  return {
    expired: (expiredRows || []).length,
    stale: (staleRows || []).length
  }
}

// ═══ BACKFILL ═══
//
// Generate + persist embeddings for memory rows that predate pgvector.
// Idempotent — rows that already have an embedding are skipped. Safe to run
// repeatedly. Call from a one-shot script or a cron job.
async function backfillEmbeddings(supabase, { batchSize = 25, maxBatches = 10 } = {}) {
  if (!embeddings.isAvailable()) {
    return { skipped: 'no embedding provider configured' }
  }
  let totalUpdated = 0
  let totalFailed = 0
  for (let b = 0; b < maxBatches; b++) {
    const { data: rows, error } = await supabase
      .from('riker_memory')
      .select('id, content')
      .eq('archived', false)
      .is('embedding', null)
      .limit(batchSize)
    if (error) return { error: error.message, totalUpdated, totalFailed }
    if (!rows || !rows.length) break

    for (const r of rows) {
      const result = await embeddings.embedText(r.content)
      if (!result) { totalFailed++; continue }
      const vecStr = embeddings.toPgVector(result.vector)
      const { error: upErr } = await supabase.from('riker_memory').update({
        embedding: vecStr,
        embedding_model: result.model
      }).eq('id', r.id)
      if (upErr) totalFailed++
      else totalUpdated++
    }
  }
  return { totalUpdated, totalFailed, provider: embeddings.resolveProvider() }
}

module.exports = {
  readRelevantMemories,
  renderMemoriesForPrompt,
  writeMemory,
  deleteMemory,
  pruneMemories,
  backfillEmbeddings,
  // exported for tests
  _similarity,
  _levenshtein,
  FUZZY_DEDUP_THRESHOLD,
  SEMANTIC_DEDUP_DISTANCE
}
