# Riker — Unified AI Brain for Stephens Advanced

**Version:** 0.1 — Architecture Spec  
**Date:** 2026-04-17  
**Author:** DATA, Second Officer, USS Enterprise  
**Status:** Pre-build specification

---

## 1. What Riker Is

Riker is one AI brain with three faces. Every interaction — website visitor, customer portal, field app — routes through the same core intelligence. The difference between contexts is not the model or the logic. It is the system prompt, the permissions, and the data surface exposed.

Think of it like this: same officer, three uniforms. On the bridge (website), Riker is a scheduling receptionist who books appointments and answers questions. In the ready room (portal), Riker is a customer service representative who handles account inquiries, invoices, and service requests. In engineering (field app), Riker is the full executive officer — scheduling, dispatch, invoicing, route optimization, equipment analysis, and administrative decision-making.

### What Riker Is Not

Riker is not three chatbots. It is not a wrapper around Claude with different prompts pasted in. Riker is a **stateful agent** with persistent memory, a notebook, and the ability to take autonomous action on schedules — not just when spoken to.

---

## 2. Current State (What Exists)

| Surface | Endpoint | Status | Intelligence |
|---------|----------|--------|-------------|
| Website chat | `/api/scheduler-chat` | DISABLED (static "Coming Soon") | Purpose-built scheduling bot. Extensive system prompt, calendar integration, Brycer awareness, action blocks. Good bones. |
| Customer portal | None | No AI | Zero chat. Portal is read-only with a service request form. |
| Field app chat | `/api/claude` (raw proxy) | ACTIVE | System prompt lives in `appv2.html` client-side JS. Multiple AI features: photo invoice scanning, extinguisher label reading, suppression analysis, and an action-taking chat with 15+ action types. |
| Cron automation | `/api/cron` | ACTIVE | Morning digest email, auto-reschedule (monthly). No AI — pure procedural logic. |

### Problems With Current Architecture

1. **No memory.** Every Claude call starts from zero. The field app sends last 20 messages as context, but across sessions, everything is gone. No continuity. The AI doesn't know that Maria from Taqueria La Estrella called yesterday, or that the Captive-Aire tank at Dragon Palace is 15 years old and you told her last visit it has maybe 2 years left.

2. **Split brain.** The website bot and the field app bot share no context. If a customer books via website chat, the field app AI doesn't know why they're on the schedule.

3. **No proactive behavior.** The AI only acts when spoken to. It should be the one telling Jon: "You're in Haltom City today — there's a 6-year internal due at Blaze BBQ two miles away, been 5 years 10 months since their last. Want me to call them?"

4. **Client-side prompts.** The field app's system prompt lives in `appv2.html` JavaScript. Anyone with browser dev tools can read the full prompt, rate card, and context. For an internal tool this is tolerable. For Riker, it is not.

5. **No audit trail for AI decisions.** The field app logs actions via `audit()`, but there's no record of what the AI *recommended*, what context it had, or what alternatives it considered.

---

## 3. Architecture

### 3.1 Single Endpoint: `/api/riker`

All three surfaces call one endpoint. The endpoint accepts:

```json
{
  "context": "website" | "portal" | "app",
  "session_id": "uuid",
  "location_id": "uuid (portal/app only)",
  "user_id": "uuid (app only, tech ID)",
  "messages": [{ "role": "user", "content": "..." }],
  "attachments": [{ "type": "image", "data": "base64" }],
  "client_context": {
    // Minimal metadata from the client. NOT system prompts.
    // Website: referrer page, UTM params
    // Portal: which screen they're on, their location_id
    // App: current screen, active job, GPS coords, loaded data summary
  }
}
```

The server constructs the full system prompt, injects the memory context, calls Claude, parses actions, executes them, and returns:

```json
{
  "reply": "Clean text for the user",
  "actions_taken": [{ "type": "schedule_job", "job_id": "..." }],
  "memory_updated": true,
  "suggestions": ["Would you like me to send a confirmation text?"]
}
```

### 3.2 System Prompt Hierarchy

The system prompt is assembled server-side from layers:

```
[CORE IDENTITY]          — Who Riker is, company knowledge, NFPA codes, pricing, Brycer
[CONTEXT LAYER]          — Website/Portal/App specific voice and permissions
[MEMORY LAYER]           — Relevant notebook entries for this location/customer/time
[LIVE DATA LAYER]        — Calendar, jobs, invoices, equipment (fetched real-time from Supabase)
[ACTION DEFINITIONS]     — Available actions for this context (website gets 6, app gets 20+)
[CONVERSATION HISTORY]   — From session table, not from client
```

**Core Identity** is shared across all contexts. It contains:
- Company facts (Stephens Advanced LLC, Euless TX, Jon Stephens = owner/tech)
- NFPA code knowledge (10, 17, 17A, 2001, 101)
- Pricing/rate card (pulled from `rate_card` table, not hardcoded)
- Brycer cities and compliance rules
- General behavioral rules (one question at a time, never say "I'm an AI", etc.)

**Context Layer** changes the voice and scope:

| Context | Voice | Permissions | Cannot Do |
|---------|-------|-------------|-----------|
| Website | Friendly receptionist. Casual. Under 40 words. | Create customer, schedule job, send SMS, generate portal link, escalate to Jon | Access invoices, modify equipment, see internal pricing margins, run reports |
| Portal | Professional customer service. Warm but structured. | View invoices/equipment, submit service requests, request portal extension, update contact info | Schedule directly (submits request), see other customers, access internal data |
| App | Executive officer. Technical. Concise. Action-oriented. | Everything: CRUD on all entities, photo analysis, route optimization, SMS, invoicing, equipment management, scheduling, reporting | Nothing — full access with confirmation flow |

### 3.3 Memory / Notebook System

This is the core differentiator. Riker keeps a notebook — a structured log of things worth remembering, organized by relevance, with automatic expiration.

#### New Supabase Table: `riker_memory`

```sql
CREATE TABLE riker_memory (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ,              -- NULL = permanent
  
  -- Scope
  scope TEXT NOT NULL CHECK (scope IN ('global', 'location', 'customer', 'job', 'tech')),
  location_id UUID REFERENCES locations(id),
  billing_account_id UUID REFERENCES billing_accounts(id),
  job_id UUID REFERENCES jobs(id),
  tech_id UUID REFERENCES techs(id),
  
  -- Content
  category TEXT NOT NULL CHECK (category IN (
    'preference',      -- "Prefers early morning service"
    'relationship',    -- "Daughter translates for owner"
    'equipment_note',  -- "R-102 tank showing corrosion, discussed replacement timeline"
    'scheduling',      -- "Closed Mondays, best Tuesday-Thursday after 2pm"
    'billing',         -- "Always pays by check, net-30"
    'compliance',      -- "Fire marshal cited them in March, re-inspection due"
    'conversation',    -- "Customer asked about clean agent for server room"
    'action_pending',  -- "Need to send quote for 2nd hood system"
    'route_note',      -- "Gate code 4455, enter from rear loading dock"
    'internal'         -- Jon's internal notes, never exposed to customers
  )),
  content TEXT NOT NULL,
  priority INT DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),  -- 1=low, 10=critical
  
  -- Metadata
  source TEXT,          -- 'website_chat', 'portal', 'app_chat', 'photo_ai', 'cron', 'manual'
  source_session_id UUID,
  auto_generated BOOLEAN DEFAULT false,
  archived BOOLEAN DEFAULT false
);

-- Indexes for fast retrieval
CREATE INDEX idx_memory_location ON riker_memory(location_id) WHERE NOT archived;
CREATE INDEX idx_memory_scope ON riker_memory(scope, category) WHERE NOT archived;
CREATE INDEX idx_memory_expires ON riker_memory(expires_at) WHERE expires_at IS NOT NULL AND NOT archived;
CREATE INDEX idx_memory_billing ON riker_memory(billing_account_id) WHERE NOT archived;
```

#### How Memory Works

**Writing:** After every conversation turn where something noteworthy happens, Riker's response includes a `memory_write` action block:

```json
{
  "type": "memory_write",
  "entries": [
    {
      "scope": "location",
      "location_id": "...",
      "category": "preference",
      "content": "Owner (Wei Chen) prefers written documentation. Daughter handles communication.",
      "priority": 7,
      "expires_at": null
    },
    {
      "scope": "location",
      "location_id": "...",
      "category": "action_pending",
      "content": "Need to send insurance documentation from last inspection. Customer asked 2026-04-17.",
      "priority": 8,
      "expires_at": "2026-05-01T00:00:00Z"
    }
  ]
}
```

**Reading:** Before every Claude call, the server fetches relevant memories:
- All `global` scope memories (company-wide notes)
- All memories for the `location_id` in context (if any)
- All memories for the `billing_account_id` (multi-location accounts)
- All `action_pending` memories for today (across all locations)
- All memories with `priority >= 8` created in last 7 days

These get injected into the system prompt as:

```
NOTEBOOK (things you've noted about this customer/situation):
- [preference, priority 7] Owner (Wei Chen) prefers written documentation. Daughter handles communication.
- [action_pending, priority 8, expires 2026-05-01] Need to send insurance documentation from last inspection.
- [equipment_note, priority 6] Kitchen Knight II is 15 years old. Discussed replacement timeline last visit (2026-01-15).
- [route_note, priority 5] Gate code 4455, enter from rear loading dock.
```

**Pruning:** A cron job runs daily:
1. Archive expired entries (`expires_at < now()`)
2. Archive `action_pending` entries that have been completed (cross-reference with audit_log)
3. Archive `conversation` entries older than 30 days with priority < 5
4. Consolidate duplicate memories (same location + same category + similar content)

**Deletion by Riker:** Riker can also issue `memory_delete` actions when information is no longer relevant:

```json
{ "type": "memory_delete", "memory_id": "...", "reason": "Action completed — insurance docs sent" }
```

### 3.4 Session Management

#### New Supabase Table: `riker_sessions`

```sql
CREATE TABLE riker_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  
  context TEXT NOT NULL CHECK (context IN ('website', 'portal', 'app')),
  location_id UUID REFERENCES locations(id),
  tech_id UUID REFERENCES techs(id),
  
  -- Conversation stored server-side
  messages JSONB DEFAULT '[]'::jsonb,
  
  -- Session metadata
  customer_phone TEXT,
  customer_name TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'closed', 'abandoned')),
  
  -- AI tracking
  total_tokens INT DEFAULT 0,
  total_cost NUMERIC(10,4) DEFAULT 0,
  actions_taken JSONB DEFAULT '[]'::jsonb
);

CREATE INDEX idx_sessions_active ON riker_sessions(context, status) WHERE status = 'active';
CREATE INDEX idx_sessions_location ON riker_sessions(location_id);
```

Sessions are server-side. The client sends a `session_id` and the new message. The server loads the conversation history from the database, appends the new message, calls Claude, appends the response, and saves back. No conversation history transits from the client.

Sessions auto-close after 30 minutes of inactivity (website), 1 hour (portal), or never (app — manual close only).

### 3.5 Action System

Actions are JSON blocks in Claude's response, parsed server-side. The client never sees raw action blocks — only the clean reply text and a list of what was done.

#### Website Actions (6)

| Action | Description |
|--------|-------------|
| `create_customer` | New location in Supabase with geocoding and Brycer detection |
| `schedule_job` | Create job + calendar event |
| `generate_portal` | Create portal token and URL |
| `sms_jon` | Text Jon about this inquiry |
| `sms_customer` | Text customer (requires opt-in) |
| `need_quote` | Escalate complex pricing to Jon |

#### Portal Actions (8)

| Action | Description |
|--------|-------------|
| `submit_service_request` | Create a job with status 'requested' |
| `view_invoices` | Fetch and summarize invoice history |
| `view_equipment` | Fetch and summarize extinguishers/suppression systems |
| `update_contact` | Update location contact info |
| `request_portal_extension` | Extend portal token expiry |
| `view_next_service` | Show next scheduled job |
| `sms_jon` | Text Jon |
| `memory_write` | Note something about this customer |

#### App Actions (20+)

Everything the current field app chat does, plus:

| New Action | Description |
|------------|-------------|
| `memory_write` | Write to notebook |
| `memory_delete` | Remove outdated notebook entry |
| `proactive_suggest` | Generate a suggestion (nearby job, overdue service, etc.) |
| `generate_invoice` | Create invoice from job data |
| `check_compliance` | Query upcoming compliance deadlines for a location |
| `draft_email` | Compose email (confirmation, report, follow-up) |
| `analyze_route` | Evaluate today's route for efficiency, suggest reorder |
| `flag_equipment` | Mark extinguisher/system for follow-up |

### 3.6 Proactive Behavior (Cron-Driven)

Riker doesn't just respond to conversations. It runs on schedules.

#### Morning Brief (replaces current `morning-digest`)

Instead of a static HTML email, Riker generates an AI-authored morning briefing:

```
Good morning, Jon. Thursday, April 17.

You have 4 jobs today. First stop is Dragon Palace in Arlington at 8:00 — 
semi-annual hood inspection, Kitchen Knight II. Reminder: the daughter 
translates, and they asked for insurance documentation last time. I have 
that ready to send after you complete the inspection.

Second stop is Blaze BBQ at 10:30, also semi-annual. Darren mentioned 
the fire marshal flagged his smoker exhaust last time — bring the NFPA 96 
reference for that conversation.

Route note: there's a 6-year internal due at Greenfield Montessori, 3 miles 
from Dragon Palace. They're on the schedule for next month but if you have 
30 minutes between jobs today I can call them to see if they want it done early.

Outstanding: $4,280 unpaid. Sal's NY Pizza is at 45 days — I'll send the 
second reminder today unless you tell me not to.
```

This gets delivered via email at 6 AM and is also the first thing Riker shows when the app opens.

#### Proactive Check-Ins

- **Invoice aging:** At 7/14/30 days, Riker sends reminders (SMS or email based on customer preference from memory)
- **Compliance alerts:** 30 days before a semi-annual or annual is due, Riker flags it and can auto-schedule if the customer has a contract
- **Equipment lifecycle:** When an extinguisher approaches its 6-year or 12-year date, Riker notes it in memory and mentions it in the morning brief

### 3.7 AI Interaction Audit Log

#### New Supabase Table: `riker_interactions`

```sql
CREATE TABLE riker_interactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  session_id UUID REFERENCES riker_sessions(id),
  context TEXT NOT NULL,
  
  -- Request
  user_message TEXT,
  attachments_count INT DEFAULT 0,
  
  -- Response
  model TEXT,
  reply TEXT,
  actions_attempted JSONB DEFAULT '[]'::jsonb,
  actions_succeeded JSONB DEFAULT '[]'::jsonb,
  memory_entries_written INT DEFAULT 0,
  
  -- Cost tracking
  input_tokens INT,
  output_tokens INT,
  cost_usd NUMERIC(10,6),
  latency_ms INT
);
```

Every single Claude call is logged. This gives you:
- Cost tracking per context (how much does the website bot cost vs the app?)
- Quality auditing (review what Riker said and did)
- Training data (if you ever want to fine-tune or build evals)

---

## 4. Build Plan

### Phase 1: Foundation (Week 1)

**Goal:** Riker endpoint exists, memory table exists, website chat works.

1. Create Supabase migration: `riker_memory`, `riker_sessions`, `riker_interactions` tables
2. Build `/api/riker.js` — the unified endpoint
3. Port `scheduler-chat.js` system prompt into the Core Identity + Website Context Layer
4. Move rate card lookup from hardcoded to `rate_card` table query
5. Implement session management (server-side conversation storage)
6. Implement memory read (fetch relevant memories before Claude call)
7. Implement memory write (parse `memory_write` actions from Claude response)
8. Implement action execution (port all 6 website actions from `scheduler-chat.js`)
9. Re-enable website chat widget in `indexv2.html`, point to `/api/riker?context=website`
10. Test end-to-end: customer books appointment via website chat

### Phase 2: Portal (Week 2)

**Goal:** Portal has a chat widget connected to Riker.

1. Add chat UI to `portal.html`
2. Define Portal Context Layer system prompt
3. Implement portal actions (view invoices, view equipment, submit service request, etc.)
4. Portal sessions authenticate via portal token — Riker knows which location it's talking to
5. Test: customer opens portal, asks about their next inspection, gets accurate answer from Supabase data

### Phase 3: App Migration (Week 2-3)

**Goal:** Field app chat migrates from `/api/claude` to `/api/riker?context=app`.

1. Define App Context Layer system prompt (port from `appv2.html` client-side prompt)
2. Implement all app actions server-side (currently 15+ action types in client JS)
3. Move photo AI prompts server-side (invoice scan, label read, suppression analysis)
4. Implement GPS/location awareness in context injection
5. Confirmation flow: Riker returns `requires_confirmation: true` for write actions; client renders Yes/No; client sends confirmation message; Riker executes
6. Migrate `appv2.html` to call `/api/riker` instead of `/api/claude`
7. Test all existing workflows: photo scan, chat actions, route building

### Phase 4: Memory + Proactive (Week 3-4)

**Goal:** Riker remembers things and acts on its own.

1. Implement memory pruning cron job
2. Implement proactive morning brief (AI-generated, replaces static digest)
3. Implement invoice aging reminders (7/14/30 day auto-SMS/email)
4. Implement compliance alert generation (30-day advance warning)
5. Implement "nearby opportunity" suggestions (GPS + job pool + route awareness)
6. Build memory consolidation logic (merge duplicates, update stale facts)
7. Add memory management UI to field app (view/edit/delete notebook entries)

### Phase 5: Polish + Hardening (Week 4+)

1. Rate limiting per session and per context
2. Cost monitoring alerts (daily spend threshold)
3. Fallback behavior when Claude API is down
4. Spanish language support (bilingual system prompt for website context)
5. Analytics dashboard (token usage, action frequency, session duration)
6. Load testing (concurrent website sessions)

---

## 5. File Changes Summary

### New Files

| File | Purpose |
|------|---------|
| `api/riker.js` | Unified AI endpoint — the brain |
| `api/riker-memory.js` | Memory CRUD helpers (read, write, prune, consolidate) |
| `api/riker-prompts.js` | System prompt assembly (core + context + memory + data layers) |
| `api/riker-actions.js` | Action parser and executor |
| `api/riker-proactive.js` | Cron-driven proactive behaviors |

### Modified Files

| File | Change |
|------|--------|
| `indexv2.html` | Re-enable chat widget, point to `/api/riker?context=website` |
| `portal.html` | Add chat widget UI |
| `appv2.html` | Replace `/api/claude` calls with `/api/riker?context=app` |
| `api/cron.js` | Add `riker-morning-brief` and `riker-memory-prune` jobs |
| `vercel.json` | Add cron entries for new jobs |

### Deprecated (Eventually Removed)

| File | Replaced By |
|------|-------------|
| `api/scheduler-chat.js` | `api/riker.js` with `context=website` |
| `api/claude.js` | `api/riker.js` with `context=app` |

---

## 6. Environment Variables

Existing (already configured):
- `CLAUDE_KEY` — Anthropic API key
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase admin access
- `GOOGLE_MAPS_API_KEY` — Geocoding
- `RESEND_API_KEY` — Email
- `SQUARE_ACCESS_TOKEN` — Payments

No new env vars required. Riker uses the same infrastructure.

---

## 7. Cost Estimation

Current Claude usage: ~$0.50-2.00/day (field app photo AI + chat, low volume)

Projected Riker usage:
- Website chat: ~5-15 conversations/day avg, 3-5 turns each = ~$0.30-0.75/day
- Portal chat: ~2-5 conversations/day = ~$0.10-0.25/day
- App chat: ~10-20 turns/day = ~$0.20-0.50/day
- Photo AI: same as current = ~$0.30-0.50/day
- Proactive (morning brief, reminders): ~$0.10-0.20/day
- **Total estimated: $1.00-2.20/day = $30-66/month**

Model: `claude-sonnet-4-6` for all contexts. Opus is unnecessary for this workload. Haiku would be insufficient for the action-taking and memory management complexity.

---

## 8. Security Considerations

1. **No client-side system prompts.** All prompts assembled server-side. The client sends messages and context metadata only.

2. **Context isolation.** Website context cannot access invoice data, equipment details, or internal notes. Portal context is scoped to one location. App context requires tech authentication.

3. **Memory visibility.** Memories with category `internal` are never included in website or portal system prompts. They only appear in app context.

4. **Rate limiting.** Website: 20 messages/session, 3 sessions/IP/hour. Portal: 50 messages/session. App: unlimited.

5. **Action authorization.** Write actions from website context require SMS verification or are queued for Jon's approval. Portal write actions are limited to service requests. App write actions use the existing confirmation flow.

---

## 9. The Receptionist Analogy

From the admin job duties document and the 50 customer archetypes: Riker is the receptionist who has been at the front desk for 10 years. She knows every customer by name. She knows that Maria from Taqueria La Estrella needs bilingual communication and got burned by no-shows. She knows that Sal doesn't trust vendors and needs honesty, not upsells. She knows that Dragon Palace's daughter handles communication and they need documentation for insurance.

When the phone rings, she doesn't start from scratch. She pulls up the notebook, sees the history, and picks up where the last conversation left off. When she hangs up, she writes down what matters and throws away what doesn't.

That is Riker.
