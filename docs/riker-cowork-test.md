# Riker End-to-End Test Protocol

**For:** Claude Cowork (the in-browser AI tester)
**Goal:** Exercise every surface of the Riker AI assistant on stephensadvanced.com, capture exactly what works and what's broken, and report back in the structured format at the bottom.

You are NOT Jon. You are an independent QA agent testing Jon's system. Act like an end-user: type messages and observe responses. Do not modify any code. Do not text Jon's real phone. Only use the browser-accessible surfaces.

---

## Before you start

Open three browser tabs:
1. `https://stephensadvanced.com` — the marketing website (chat widget is the circular button in the lower-right)
2. `https://stephensadvanced.com/app` — Jon's field app (tap the AI Assistant icon, typically top-right or in a menu)
3. `https://stephensadvanced.com/api/riker-last?n=30` — the diagnostic endpoint. Reload this between tests to see what Claude actually received/returned.

Also keep available:
- `https://stephensadvanced.com/api/riker-diag` — one-shot env + read-access report

**Do NOT test the portal.** It requires a valid customer token that you don't have.
**Do NOT test SMS or email.** Those surfaces need a real phone number or mailbox Jon controls.

---

## Test Plan

For each test below, in the stated surface, **type the exact input** and capture:
- **Response text** (copy-paste verbatim — every character)
- **Response time** (stopwatch or eyeball — seconds)
- **UI state** (did anything besides the chat bubble change? new screen, toast, modal?)
- **Any browser console errors** (open DevTools → Console, filter to "riker" or "claude")

If a response is the literal string "Done." that is a **FAILURE** — note it and move on.
If a response is empty, also a FAILURE.
If a response echoes back "I didn't catch that — try again?" that is the server-side fallback firing because Claude returned nothing — also a FAILURE, note it.

### Group A — Website chat (public, unauthenticated)
Surface: `https://stephensadvanced.com` — click the orange chat button.

| # | Input | What success looks like |
|---|---|---|
| A1 | `hello` | Short warm greeting. No "Done." |
| A2 | `who are you` | Identifies as Riker / scheduling assistant for Stephens Advanced. Does NOT say "I'm an AI" or similar disclaimer. |
| A3 | `do you do fire extinguisher inspections` | Yes-answer with 1-2 NFPA-aware sentences (e.g. annual visual, 6-year internal). |
| A4 | `i need to schedule a kitchen inspection for my restaurant` | Asks ONE follow-up question. Does not ask for everything at once. |
| A5 | (continue A4 thread) `Taqueria Test in Arlington` | Asks the NEXT missing thing — likely contact name or phone. Still only one question. |
| A6 | (continue) `Maria Gonzalez 555-123-4567` | Proposes a time slot drawn from AVAILABLE_SLOTS. |
| A7 | (continue) `yes works` | Says "let me check with Jon" (since RIKER_AUTO_CONFIRM is off). Does NOT claim to have booked it. |
| A8 | (new convo — refresh page) `what's the weather today` | Politely declines or redirects; not a fabrication. |

### Group B — Field app (authenticated as Jon)
Surface: `https://stephensadvanced.com/app` — open the AI Assistant chat.

Before testing, reload `https://stephensadvanced.com/api/riker-last?context=app&n=1` and note the most recent timestamp so you can identify which row each test added.

| # | Input | What success looks like |
|---|---|---|
| B1 | `hello?` | Short acknowledgment with specifics ("Here. 3 overdue, $X unpaid. What do you need?") NOT literal "Done." |
| B2 | `what's on my schedule today` | Names actual locations and times from TODAY_JOBS in LIVE_DATA. If empty, says so. No hedging like "I don't have access." |
| B3 | `what's overdue` | Lists actual overdue jobs with dates. |
| B4 | `who owes me money` | Lists unpaid invoices with invoice numbers, locations, amounts. Rolls up a total. |
| B5 | `look up Dragon Palace` | Either returns info from CLIENTS block directly, or issues `lookup_client` action and returns the match. |
| B6 | `look up an obviously fake name — Zorglox Widgets Co` | Honest "I don't see that" — does not fabricate. |
| B7 | `add a to-do: buy spare fusible links` | Acknowledges specifically ("To-do added: buy spare fusible links") and actions_taken in `/api/riker-last` shows `add_todo` with `ok: true`. |
| B8 | `from now on, never schedule before 9:30 on school days` | Must reply something like "Locked in. [restates the rule]." AND `/api/riker-last` shows a `memory_write` action with a `STANDING ORDER:` entry at priority 10. |
| B9 | (after B8 succeeded) navigate to a new tab, re-open app, ask `what are my standing orders` | Recalls the rule from B8 from memory. If it doesn't, the memory write failed OR memory isn't being read on fresh sessions. |
| B10 | `kajsdflkjasdlfkj` (gibberish) | Asks for clarification — does not fabricate. |

### Group C — Diagnostic surface
Not a chat. Just hit these URLs and report what you see.

| # | URL | What to capture |
|---|---|---|
| C1 | `https://stephensadvanced.com/api/riker-diag` | Paste the full JSON. Key fields: `key_selection`, `jwt_role`, any `reads[X].ok === false` entries. |
| C2 | `https://stephensadvanced.com/api/riker-last?context=app&n=5` | For each of the 5 rows, expand and capture: `user_message`, `reply` (exact), `actions_attempted` and `actions_succeeded` (JSON). |
| C3 | `https://stephensadvanced.com/api/riker-last?context=website&n=5` | Same capture for the website chat tests you ran. |

---

## Reporting Format

Write a single markdown report with this structure. Keep it tight — Jon reads it once.

```
# Riker Cowork Test Report — [date/time]

## Summary
- Website chat: [WORKS | PARTIAL | BROKEN]
- App chat:      [WORKS | PARTIAL | BROKEN]
- Diagnostic:    [WORKS | PARTIAL | BROKEN]

One-paragraph headline of what's working and what isn't.

## Test Results

### Group A — Website
| # | Input | Response (verbatim) | Time | Pass/Fail | Notes |
|---|---|---|---|---|---|
| A1 | ... | ... | ... | ... | ... |

### Group B — App
(same table shape)

### Group C — Diagnostic
- C1 key_selection: ...
- C1 jwt_role: ...
- C1 failed reads: ...
- C2 row 1: user_message=... reply=... actions_succeeded=...
- (etc)

## Root-Cause Hypotheses

For any failure, state what you think is actually wrong. Look at the interaction logs (C2/C3) and compare user_message → reply → actions. Examples of hypotheses to consider:
- Claude returned empty text → client fallback fired
- Claude returned only action blocks with no prose
- action was supposed to fire but actions_attempted is empty
- data that SHOULD be in the reply (overdue count, etc.) is missing → LIVE_DATA block isn't being built
- reply mentions data incorrectly (fabrication) → model hallucinating despite context
- error field populated in riker_interactions → something upstream threw

## Specific Requests to Jon
(If any tests suggest a non-code issue — e.g., "the Supabase service key looks wrong", "no rows in riker_memory after B8 succeeded" — flag it here.)
```

---

## What we're looking for

The main recent complaint: **"Riker says 'Done.' to everything."** That's three possible root causes in play. After the latest deploy (commit `3744887`), I expect:
- Bare "Done." replies should be gone. Any remaining one-word answers are a regression to surface.
- The APP_CONTEXT prompt should push Claude to cite actual data (e.g. "3 overdue, $4,280 unpaid") in greetings.
- Memory writes from B8 should land in `riker_memory` and be recalled in B9.

If B2/B3/B4 return generic "let me check" instead of actual data → LIVE_DATA isn't reaching the prompt, or Claude isn't reading it.
If B7/B8 don't produce the expected action in riker_interactions → action parsing is broken.
If B9 fails but B8 succeeded → memory read isn't working for fresh sessions.

Report back with the structure above. Don't try to fix anything.
