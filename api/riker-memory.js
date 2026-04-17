// /api/riker-memory.js
// The notebook. Read relevant entries before every Claude call, write new
// ones when Riker issues memory_write actions, prune daily.

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
  // Best-effort de-dup: if an identical content exists for same scope+category+location, update priority + updated_at instead
  const { data: existing } = await supabase
    .from('riker_memory')
    .select('id, priority')
    .eq('archived', false)
    .eq('scope', row.scope)
    .eq('category', row.category)
    .eq('content', row.content)
    .eq('location_id', row.location_id)
    .limit(1)
    .maybeSingle()
  if (existing) {
    await supabase.from('riker_memory').update({
      priority: Math.max(existing.priority, row.priority),
      updated_at: new Date().toISOString(),
      expires_at: row.expires_at
    }).eq('id', existing.id)
    return { id: existing.id, updated: true }
  }
  const { data: inserted, error } = await supabase.from('riker_memory').insert(row).select().single()
  if (error) {
    console.error('[riker-memory] write error:', error)
    return null
  }
  return { id: inserted.id, updated: false }
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

module.exports = {
  readRelevantMemories,
  renderMemoriesForPrompt,
  writeMemory,
  deleteMemory,
  pruneMemories
}
