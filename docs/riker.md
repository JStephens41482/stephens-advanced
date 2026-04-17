# Riker — Unified AI Brain

Riker is one AI with five faces — website chat, portal chat, field app, SMS,
and email — all sharing memory, calendar, William's custody rules, and
Jon's approval gate. This is the build-out of the original design spec.

## Architecture

```
  ┌───────────────────────────────────────────────────┐
  │                    Riker Brain                    │
  │                                                   │
  │  riker-prompts.js — layered system prompt         │
  │  riker-memory.js  — notebook (read/write/prune)   │
  │  riker-actions.js — action registry + executors   │
  │  riker-core.js    — orchestrator + session adapter│
  └───┬───────┬───────┬───────┬─────────┬─────────────┘
      │       │       │       │         │
      ▼       ▼       ▼       ▼         ▼
   website portal   app    sms-in    email-in
   (new UI)(new UI) (appv2) (twilio)  (gmail)
      │       │       │       │         │
      └───────┴───────┴───────┴─────────┘
                  /api/riker.js
             (unified HTTP endpoint)
                    +
                 webhooks
               sms-inbound.js
               email-inbound.js
```

## Files

| File | Purpose |
|---|---|
| `api/riker.js` | HTTP endpoint for website/portal/app. Dispatches by `context`. |
| `api/riker-core.js` | Main `processMessage` orchestrator — builds context, calls Claude, executes actions, logs interactions |
| `api/riker-prompts.js` | Core identity + per-context prompt layers + action definitions |
| `api/riker-memory.js` | Notebook CRUD, read relevant memories, prune |
| `api/riker-actions.js` | All action handlers. Permission-gated per context. |
| `api/riker-proactive.js` | Cron-driven behaviors (morning brief, aging, compliance alerts, prune) |
| `api/sms-inbound.js` | Twilio webhook — routes to core with `context=sms_customer` / `sms_jon` |
| `api/email-inbound.js` | Gmail polling cron — routes to core with `context=email_customer` |
| `api/william-schedule.js` | Tarrant County ESPO custody rules → Jon's daily availability |
| `migrations/003-sms-scheduling.sql` | conversations, messages, pending_confirmations, processed_emails |
| `migrations/004-riker-core.sql` | riker_memory, riker_sessions, riker_interactions, service_requests |

## Five faces

### 1. Website chat (`indexv2.html`)
Live on the marketing site. Session persists in `localStorage`.
Can: create customers, schedule jobs (via Jon approval), generate portal
links, SMS Jon, request quotes, write memory.

### 2. Portal chat (`portal.html`)
Added to the customer portal. Auto-authenticates via `portal_token`.
Scoped to billing_account — never sees other customers' data.
Can: view invoices/equipment (own only), submit service requests,
update contact info, request portal extension.

### 3. Field app (`appv2.html`)
The `sendChat` function now calls `/api/riker?context=app`. All context
(calendar, rate card, William availability, notebook) is built server-side.
Every action is permission-checked. Photo AI endpoints still hit
`/api/claude` (they're one-shot extractions, not conversational).

### 4. SMS (Twilio → `api/sms-inbound.js`)
Customer inbound → `sms_customer` context.
Jon inbound (+12149944799) → `sms_jon` context. YES/NO/counter-offer
against pending_confirmations.

### 5. Email (Gmail polling → `api/email-inbound.js`)
Label "Riker" filter → poll every 5 min → reply threaded via Resend.
Same brain as SMS.

## The notebook

Every conversation can read and write to `riker_memory`. Entries are
scoped (global, location, customer, job, tech) and categorized
(preference, relationship, equipment_note, scheduling, billing,
compliance, conversation, action_pending, route_note, internal).

Before each Claude call, Riker pulls the relevant entries and injects
them into the system prompt. After, if the AI issues a `memory_write`
action, the entries are saved. `memory_delete` archives stale entries.

Pruning runs daily: archives expired, stale low-priority conversation
entries older than 30 days.

`internal` category memories only surface in `app` / `sms_jon` contexts
— never exposed to customers.

## Approval gate

Customer-facing contexts (website, sms_customer, email_customer, portal
via service_requests) route scheduling writes through
`pending_confirmations`. Jon gets an SMS, replies YES/NO/counter, Riker
executes and replies to the customer on their original channel.

Flip `RIKER_AUTO_CONFIRM=true` to skip the gate when the proposed slot
cleanly fits Jon's availability.

## Proactive crons

| Cron | Schedule (UTC) | Local | What it does |
|---|---|---|---|
| `riker-morning-brief` | `0 11 * * *` | 6 AM CDT | AI-authored email to Jon with today's schedule + notebook-aware callouts |
| `riker-invoice-aging` | `0 15 * * *` | 10 AM CDT | 7/14/30-day reminder drafts → SMS or email customers, with memory-based dedup |
| `riker-compliance-alerts` | `0 14 * * *` | 9 AM CDT | 30/14/7-day advance warnings for upcoming service; writes to notebook + pings Jon |
| `riker-memory-prune` | `0 9 * * *` | 4 AM CDT | Archives expired / stale entries |
| `email-inbound` | `*/5 * * * *` | every 5 min | Polls Gmail for Riker-labeled threads |
| `auto-reschedule` | `0 8 1 * *` | 3 AM CDT, 1st of month | Creates 6-mo / 12-mo follow-up jobs |

## Cost tracking

Every Claude call logs a row in `riker_interactions`: context, user
message, reply, input/output/cache tokens, computed cost in USD, latency,
actions attempted/succeeded, memory reads/writes.

Query to see yesterday's spend:
```sql
SELECT context, COUNT(*) AS calls, SUM(cost_usd) AS cost
FROM riker_interactions
WHERE created_at >= now() - interval '1 day'
GROUP BY context ORDER BY cost DESC;
```

## Setup

### Database
Apply both migrations in order via Supabase SQL editor:
1. `migrations/003-sms-scheduling.sql`
2. `migrations/004-riker-core.sql`

### Environment variables
Already set: `CLAUDE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`,
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`,
`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
`GOOGLE_CALENDAR_REFRESH_TOKEN`, `GOOGLE_MAPS_API_KEY`.

To enable email inbound, re-authorize OAuth with `gmail.modify` scope and
replace `GOOGLE_CALENDAR_REFRESH_TOKEN` (see `docs/riker-sms-setup.md` for
the walkthrough).

Optional:
- `RIKER_AUTO_CONFIRM=true` — skip manual approval gate when slot fits
- `RIKER_SKIP_TWILIO_SIG=true` — local testing only
- `CRON_SECRET` — protects cron endpoints (Vercel Cron passes it as Bearer)

### Twilio
Webhook: `https://stephensadvanced.com/api/sms-inbound` (POST).

### Gmail
Create a label called `Riker`. Set up a filter:
- Has the words: `schedule OR inspection OR extinguisher OR appointment OR quote OR suppression OR "fire system"`
- Action: Apply label `Riker` (do not mark as read)

### Deploy
`git add . && git commit -m "Riker" && git push` → Vercel auto-deploys.

Vercel **Pro tier required** for 5-minute cron (`email-inbound`). Hobby
tier caps cron at daily.

## Testing

1. **Migration**: apply 003 + 004 in Supabase. Verify tables exist.
2. **Website chat**: open stephensadvanced.com, click chat bubble, ask
   "hey can you schedule a kitchen inspection for my restaurant?".
   Verify reply comes back and you get a `CONFIRM?` SMS.
3. **Portal chat**: open a portal link, click chat bubble, ask
   "when's my next inspection?". Verify scoped reply (only your data).
4. **App chat**: open the field app, open chat, say "show me my
   overdue jobs". Verify reply pulls from LIVE_DATA correctly.
5. **SMS**: text Twilio number from a test phone. Same `CONFIRM?` flow.
6. **Email**: send an email with "schedule" in the subject to
   jonathan@stephensadvanced.com, apply Riker label. Wait 5 min.
   Verify threaded reply.
7. **Morning brief**: hit `/api/cron?job=riker-morning-brief` manually.
   Verify email arrives.
8. **Compliance alert**: hit `/api/cron?job=riker-compliance-alerts`.
   Verify SMS if anything is due within 14 days.

## Not yet implemented (Phase 5 polish)

- Client-side Yes/No confirmation for destructive app actions
  (`delete_job`, `send_sms`). Currently server executes immediately in
  app context. Server-side confirmation gate will come when needed.
- Summer custody rules for William (June–August). Override via manual
  calendar events for now.
- Prompt caching for the core identity (would cut Claude costs ~80%).
- Spanish language support for website / SMS.
- Rate limiting per session.
- Dashboard UI for viewing interactions / memory.
