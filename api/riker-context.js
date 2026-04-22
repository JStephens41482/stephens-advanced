// /api/riker-context.js
// Phase 2 of situational awareness: long-running conversation memory.
//
// Problems this solves:
//   1. Sessions that run for days/weeks blow up the input token count —
//      every turn sends every prior message.
//   2. Prior sessions on the same phone / email are invisible to the
//      current turn. If Jon texts today about something he texted about
//      last week, Riker has no idea.
//
// Solution:
//   - SLIDING WINDOW: keep the last 20 turns verbatim in the history sent
//     to Claude; older turns are summarized into a rolling paragraph that
//     travels with the session.
//   - CROSS-SESSION THREAD: when the current surface is keyed to a phone
//     or email, pull the last N days of prior conversations on that same
//     identifier (across contexts) and prepend a short thread summary.
//
// The summary generator is a cheap Haiku call; runs after each outbound
// turn whenever msg count has grown past the last-summarized checkpoint
// by at least 6 turns. Never blocks the user-facing reply.

// Phase 6b — keep the words. The original 20-turn window meant Riker lost
// the verbatim phrasing of anything older than about a half-day of back-
// and-forth. Prompt caching on the system blocks plus Anthropic's inherent
// pricing means carrying a much larger window costs near-zero marginal
// dollars per turn. Bumped to 200 verbatim turns. Summary only kicks in
// once the thread is *both* past 200 turns AND has meaningful older
// content worth paraphrasing (min 220 so we're not summarizing 20 stale
// turns).
const SLIDING_WINDOW = 200                         // verbatim turns kept
const SUMMARY_EVERY_N_TURNS = 40                   // resummarize every N added turns
const SUMMARY_MIN_TURNS = 220                      // don't summarize before this total
const CROSS_SESSION_DAYS = 14                      // look back this far for prior threads (widened)
const CROSS_SESSION_CAP = 6                        // max prior sessions pulled
const HAIKU_MODEL = 'claude-haiku-4-5-20251001'

// ───────────────────────────────────────────────
// SLIDING WINDOW: load messages + rolling summary for a riker_sessions row
// ───────────────────────────────────────────────

/**
 * Given a session row (from riker_sessions), return:
 *   { messages:   [{ role, content }, ...]  // last SLIDING_WINDOW turns
 *     summary:    'paragraph describing older turns' | ''
 *     totalTurns: number
 *   }
 */
function slidingWindowForSession(session) {
  const msgs = Array.isArray(session?.messages) ? session.messages : []
  const total = msgs.length
  const windowed = msgs.slice(-SLIDING_WINDOW)
  const summary = session?.summary || ''
  const mapped = windowed.map(m => ({
    role: m.role === 'user' || m.role === 'assistant' ? m.role : (m.role === 'inbound' ? 'user' : 'assistant'),
    content: m.content
  }))
  return { messages: mapped, summary, totalTurns: total }
}

/**
 * Decide whether the summary needs a refresh. True if:
 *   - session has >= SUMMARY_MIN_TURNS
 *   - total turns have advanced at least SUMMARY_EVERY_N_TURNS since the
 *     last summary checkpoint (covers_turn_count column)
 */
function summaryNeedsRefresh(session) {
  const msgs = Array.isArray(session?.messages) ? session.messages : []
  const total = msgs.length
  if (total < SUMMARY_MIN_TURNS) return false
  const covered = Number(session?.summary_covers_turn_count || 0)
  return total - covered >= SUMMARY_EVERY_N_TURNS
}

/**
 * Build (or update) the rolling summary. Re-reads the session from the DB
 * so we don't lose in-flight writes. Runs a Haiku call to generate a
 * ~120-word paragraph capturing names, commitments, open threads, decisions.
 */
async function maybeUpdateSessionSummary(supabase, sessionId) {
  if (!sessionId) return { skipped: 'no sessionId' }
  const { data: session } = await supabase.from('riker_sessions')
    .select('id, context, customer_name, customer_phone, customer_email, location_id, messages, summary, summary_covers_turn_count')
    .eq('id', sessionId).maybeSingle()
  if (!session) return { skipped: 'no session' }
  if (!summaryNeedsRefresh(session)) return { skipped: 'fresh enough' }

  const msgs = Array.isArray(session.messages) ? session.messages : []
  // Summarize everything EXCEPT the sliding window (those travel verbatim)
  const toSummarize = msgs.slice(0, Math.max(0, msgs.length - SLIDING_WINDOW))
  if (!toSummarize.length) return { skipped: 'nothing older than window' }

  const key = process.env.CLAUDE_KEY
  if (!key) return { skipped: 'no CLAUDE_KEY' }

  const transcript = toSummarize.map(m => {
    const who = m.role === 'user' ? (session.context === 'sms_jon' || session.context === 'app' ? 'Jon' : (session.customer_name || 'Customer')) : 'Riker'
    return `${who}: ${String(m.content || '').slice(0, 500)}`
  }).join('\n')

  const prior = session.summary
    ? `PRIOR SUMMARY (update/extend):\n${session.summary}\n\nNEW TURNS TO FOLD IN:\n`
    : ''

  const prompt = `${prior}${transcript}

Write ONE paragraph (80-140 words) summarizing the thread so far. Focus on:
- Names, businesses, phone numbers, dates, amounts mentioned
- Decisions made, commitments Jon or Riker made
- Open threads (questions unanswered, things promised but not delivered)
- Context Riker would need to pick this conversation back up cold

Do not include pleasantries. Plain paragraph, no bullets, no markdown.`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      return { error: 'haiku ' + res.status + ': ' + (err?.error?.message || 'unknown') }
    }
    const data = await res.json()
    const text = (data.content?.[0]?.text || '').trim()
    if (!text) return { error: 'empty summary' }
    await supabase.from('riker_sessions').update({
      summary: text,
      summary_updated_at: new Date().toISOString(),
      summary_covers_turn_count: msgs.length - SLIDING_WINDOW,
      updated_at: new Date().toISOString()
    }).eq('id', sessionId)
    return { ok: true, chars: text.length, covered: msgs.length - SLIDING_WINDOW }
  } catch (e) {
    console.error('[riker-context] summary error:', e.message)
    return { error: e.message }
  }
}

// ───────────────────────────────────────────────
// CROSS-SESSION THREAD: prior conversations on the same phone/email
// ───────────────────────────────────────────────

/**
 * Return a short plain-text block summarizing prior sessions this person
 * had with Riker in the last CROSS_SESSION_DAYS days. Intended to be
 * prepended to the history or included as a system-prompt section.
 *
 * Pulls from riker_sessions (website/portal/app/email/sms mirrors) + the
 * conversations/messages pair (SMS/email source of truth).
 *
 * Returns '' if there's nothing relevant.
 */
async function buildCrossSessionThread(supabase, { currentSessionId, phone, email, locationId } = {}) {
  const since = new Date(Date.now() - CROSS_SESSION_DAYS * 86400000).toISOString()
  const lines = []

  // Prior riker_sessions keyed by same phone/email (but NOT the current session)
  if (phone || email) {
    let q = supabase.from('riker_sessions')
      .select('id, context, customer_name, summary, messages, updated_at, location_id')
      .gte('updated_at', since)
      .order('updated_at', { ascending: false })
      .limit(CROSS_SESSION_CAP + 2)
    if (phone) q = q.eq('customer_phone', phone)
    else if (email) q = q.eq('customer_email', email)
    const { data: priors } = await q
    for (const s of (priors || [])) {
      if (s.id === currentSessionId) continue
      const age = _ageDays(s.updated_at)
      const head = `prior ${s.context} session · ${age}`
      if (s.summary) {
        lines.push(`${head}: ${_oneline(s.summary, 200)}`)
      } else {
        const msgs = Array.isArray(s.messages) ? s.messages : []
        const pieces = msgs.slice(-4).map(m => `${m.role === 'user' ? 'them' : 'riker'}: ${_oneline(m.content, 60)}`)
        if (pieces.length) lines.push(`${head}: ${pieces.join(' | ')}`)
      }
      if (lines.length >= CROSS_SESSION_CAP) break
    }
  }

  // Prior conversations on same phone/email
  if (phone || email) {
    let q = supabase.from('conversations')
      .select('id, channel, customer_name, last_message_at, location_id')
      .gte('last_message_at', since)
      .order('last_message_at', { ascending: false })
      .limit(3)
    if (phone) q = q.eq('phone', phone)
    else if (email) q = q.eq('email', email.toLowerCase())
    const { data: convs } = await q
    if (convs && convs.length) {
      const convIds = convs.map(c => c.id)
      const { data: recent } = await supabase.from('messages')
        .select('conversation_id, direction, body, channel, created_at')
        .in('conversation_id', convIds)
        .order('created_at', { ascending: false })
        .limit(convIds.length * 4)
      const byConv = new Map()
      for (const m of (recent || [])) {
        const arr = byConv.get(m.conversation_id) || []
        if (arr.length < 4) arr.push(m)
        byConv.set(m.conversation_id, arr)
      }
      for (const c of convs) {
        const msgs = (byConv.get(c.id) || []).reverse()
        if (!msgs.length) continue
        const age = _ageDays(c.last_message_at)
        const head = `prior ${c.channel} with ${c.customer_name || phone || email} · ${age}`
        const pieces = msgs.map(m => `${m.direction === 'inbound' ? 'them' : 'riker'}: ${_oneline(m.body, 60)}`)
        lines.push(`${head}: ${pieces.join(' | ')}`)
        if (lines.length >= CROSS_SESSION_CAP * 2) break
      }
    }
  }

  if (!lines.length) return ''
  return `PRIOR THREADS (same ${phone ? 'phone' : 'email'}, last ${CROSS_SESSION_DAYS}d):\n` + lines.map(l => '  - ' + l).join('\n')
}

// ─── utils ───
function _oneline(s, n = 100) {
  if (!s) return ''
  const one = String(s).replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}
function _ageDays(ts) {
  if (!ts) return '?'
  const hrs = Math.round((Date.now() - new Date(ts).getTime()) / 3600000)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

module.exports = {
  slidingWindowForSession,
  maybeUpdateSessionSummary,
  buildCrossSessionThread,
  SLIDING_WINDOW,
  SUMMARY_EVERY_N_TURNS
}
