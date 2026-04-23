#!/usr/bin/env node
// tests/eval/run.js
// Regression harness for Riker. Reads gold.json, fires each prompt against
// an isolated riker_sessions row, scores the reply + tool calls against
// the expected assertions, and exits nonzero on regressions.
//
// Usage:
//   node tests/eval/run.js                  # run all
//   node tests/eval/run.js --id greeting-*  # run matching ids (glob)
//   node tests/eval/run.js --concurrency 4  # parallelism (default 2)
//   node tests/eval/run.js --report out.json
//
// Environment required:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CLAUDE_KEY
//   Optional: VOYAGE_API_KEY or OPENAI_API_KEY (for memory semantic dedup)

try { require('dotenv').config({ path: '.env.local' }) } catch (_) { /* dotenv optional */ }

const fs = require('fs')
const path = require('path')
const { createClient } = require('@supabase/supabase-js')
const core = require('../../api/riker-core')

const GOLD_PATH = path.join(__dirname, 'gold.json')

function parseArgs(argv) {
  const out = { idGlob: null, concurrency: 2, report: null, verbose: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--id') out.idGlob = argv[++i]
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]) || 2
    else if (a === '--report') out.report = argv[++i]
    else if (a === '--verbose' || a === '-v') out.verbose = true
  }
  return out
}

function matchesGlob(id, glob) {
  if (!glob) return true
  // Simple * support — convert to regex
  const re = new RegExp('^' + glob.split('*').map(escapeRegex).join('.*') + '$')
  return re.test(id)
}
function escapeRegex(s) { return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&') }

function lower(s) { return String(s || '').toLowerCase() }

function scoreAssertion(name, assertion, actual) {
  switch (name) {
    case 'tools_any_of': {
      const got = new Set(actual.toolNames)
      const hit = assertion.some(t => got.has(t))
      return { ok: hit, detail: hit ? null : `wanted any of [${assertion.join(',')}], got [${[...got].join(',') || 'none'}]` }
    }
    case 'tools_all_of': {
      const got = new Set(actual.toolNames)
      const missing = assertion.filter(t => !got.has(t))
      return { ok: missing.length === 0, detail: missing.length ? `missing tools [${missing.join(',')}]` : null }
    }
    case 'tools_none_of': {
      const got = new Set(actual.toolNames)
      const forbidden = assertion.filter(t => got.has(t))
      return { ok: forbidden.length === 0, detail: forbidden.length ? `called forbidden tools [${forbidden.join(',')}]` : null }
    }
    case 'reply_contains_any': {
      const r = lower(actual.reply)
      const hit = assertion.some(k => r.includes(lower(k)))
      return { ok: hit, detail: hit ? null : `reply missing any of [${assertion.join(',')}]` }
    }
    case 'reply_contains_all': {
      const r = lower(actual.reply)
      const missing = assertion.filter(k => !r.includes(lower(k)))
      return { ok: missing.length === 0, detail: missing.length ? `reply missing [${missing.join(',')}]` : null }
    }
    case 'reply_not_contains': {
      const r = lower(actual.reply)
      const found = assertion.filter(k => r.includes(lower(k)))
      return { ok: found.length === 0, detail: found.length ? `reply contained forbidden [${found.join(',')}]` : null }
    }
    case 'min_actions':
      return { ok: actual.actionsCount >= assertion, detail: actual.actionsCount < assertion ? `expected ≥${assertion}, got ${actual.actionsCount}` : null }
    case 'max_actions':
      return { ok: actual.actionsCount <= assertion, detail: actual.actionsCount > assertion ? `expected ≤${assertion}, got ${actual.actionsCount}` : null }
    case 'max_cost_usd':
      return { ok: actual.cost <= assertion, detail: actual.cost > assertion ? `cost $${actual.cost.toFixed(4)} > $${assertion}` : null }
    default:
      return { ok: true, detail: `unknown assertion: ${name}` }
  }
}

async function runOne(supabase, gold) {
  const started = Date.now()
  // Create a throwaway session scoped to this eval. context must match what
  // Riker's tool filter expects; we reuse existing context values.
  // Map 'sms_jon' → 'sms_jon' in riker_sessions (the CHECK constraint allows
  // sms_jon after migration 006).
  const insertRow = {
    context: gold.context,
    messages: [],
    status: 'active',
    customer_name: '[eval] ' + gold.id
  }
  const { data: session, error: insErr } = await supabase
    .from('riker_sessions')
    .insert(insertRow)
    .select()
    .single()
  if (insErr || !session) {
    return { id: gold.id, ok: false, reason: 'session insert failed: ' + (insErr?.message || 'null'), latencyMs: Date.now() - started }
  }

  let result
  try {
    result = await core.processMessage({
      supabase,
      context: gold.context,
      sessionKey: session.id,
      sessionStorage: 'riker_sessions',
      identity: {},
      message: gold.prompt,
      attachments: null,
      inboundAlreadyLogged: false,
      rikerSessionId: session.id
    })
  } catch (e) {
    await cleanupSession(supabase, session.id).catch(() => {})
    return { id: gold.id, ok: false, reason: 'processMessage threw: ' + e.message, latencyMs: Date.now() - started }
  }

  const toolNames = (result.actions_taken || []).map(a => a.type || a.name || '').filter(Boolean)
  const actual = {
    reply: result.reply || '',
    toolNames,
    actionsCount: toolNames.length,
    cost: Number(result.cost || result.cost_usd || 0)
  }

  const failures = []
  const expected = gold.expected || {}
  for (const [name, val] of Object.entries(expected)) {
    const s = scoreAssertion(name, val, actual)
    if (!s.ok) failures.push(`${name}: ${s.detail}`)
  }

  await cleanupSession(supabase, session.id).catch(() => {})

  return {
    id: gold.id,
    context: gold.context,
    ok: failures.length === 0,
    failures,
    latencyMs: Date.now() - started,
    cost: actual.cost,
    actionsCount: actual.actionsCount,
    toolNames,
    replyPreview: actual.reply.slice(0, 120)
  }
}

async function cleanupSession(supabase, id) {
  // Mark status=closed so the eval session doesn't show up in cross-session
  // lookups for real users. Leave the row for audit.
  await supabase.from('riker_sessions').update({
    status: 'closed',
    updated_at: new Date().toISOString()
  }).eq('id', id)
}

async function runAll({ idGlob, concurrency, report, verbose }) {
  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!sbUrl || !sbKey) {
    console.error('✗ Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
    process.exit(1)
  }
  if (!process.env.CLAUDE_KEY) {
    console.error('✗ Missing CLAUDE_KEY')
    process.exit(1)
  }
  const supabase = createClient(sbUrl, sbKey)

  const gold = JSON.parse(fs.readFileSync(GOLD_PATH, 'utf8'))
  const prompts = (gold.prompts || []).filter(p => matchesGlob(p.id, idGlob))
  if (!prompts.length) {
    console.error(`✗ No prompts match id glob "${idGlob}"`)
    process.exit(1)
  }

  console.log(`▶ Running ${prompts.length} eval(s) with concurrency ${concurrency}`)
  const started = Date.now()
  const results = []
  // Poor-man's concurrency limiter
  const queue = [...prompts]
  async function worker() {
    while (queue.length) {
      const next = queue.shift()
      if (!next) break
      const r = await runOne(supabase, next)
      results.push(r)
      const icon = r.ok ? '✓' : '✗'
      const cost = r.cost ? `$${r.cost.toFixed(4)}` : '—'
      console.log(`${icon} [${r.id}] ${r.latencyMs}ms ${cost} tools=${r.toolNames?.join(',') || 'none'}`)
      if (!r.ok) {
        for (const f of (r.failures || [r.reason])) console.log(`    · ${f}`)
        if (verbose) console.log(`    reply: ${r.replyPreview}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))

  const elapsed = Math.round((Date.now() - started) / 1000)
  const passed = results.filter(r => r.ok).length
  const failed = results.length - passed
  const totalCost = results.reduce((s, r) => s + (r.cost || 0), 0)
  console.log('\n─── Eval Summary ───')
  console.log(`Passed: ${passed} / ${results.length}`)
  console.log(`Failed: ${failed}`)
  console.log(`Cost:   $${totalCost.toFixed(4)}`)
  console.log(`Time:   ${elapsed}s`)

  if (report) {
    fs.writeFileSync(report, JSON.stringify({
      summary: { passed, failed, total: results.length, totalCost, elapsedSeconds: elapsed },
      results
    }, null, 2))
    console.log(`Wrote report → ${report}`)
  }

  process.exit(failed ? 1 : 0)
}

runAll(parseArgs(process.argv)).catch(e => {
  console.error('FATAL:', e)
  process.exit(2)
})
