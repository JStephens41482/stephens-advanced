# Riker Tool-Use Rewrite — Claude Code Brief

**Paste this entire document into Claude Code as the task.**

---

## What you're doing

Rewriting `api/riker-core.js` to use Claude's native tool_use API instead of prompt-stuffing. The current architecture pre-loads ~23K tokens of data into every system prompt (all jobs, all slots, all clients, rate card, overdue list, etc.) regardless of what the user asked. This causes rate-limit errors, costs $0.07/message, and makes simple replies like "Y" absurdly expensive.

The new architecture: small cached system prompt (~1.5K tokens for identity, ~1.5K for tool definitions) + Claude calls tools on demand to fetch only the data it needs. Expected cost per message: $0.003-$0.01.

## Repo and environment

- GitHub: `JStephens41482/stephens-advanced`, branch `main`
- Deployed on Vercel (serverless functions in `api/`)
- Database: Supabase project `motjasdokoxwiodwzyps`
- SMS: Twilio, number +18176350712
- Claude model: `claude-sonnet-4-6`
- Env vars available on Vercel: `CLAUDE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` (or `NEXT_PUBLIC_SUPABASE_URL`), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`

## Files to read first

Read ALL of these before writing any code:

1. `api/riker-core.js` — the current brain. You're rewriting this.
2. `api/riker-prompts.js` — has CORE_IDENTITY, CONTEXT_ACTIONS, assemblePrompt(). The identity text stays but gets dramatically slimmed. CONTEXT_ACTIONS becomes unnecessary (tools replace it).
3. `api/riker-actions.js` — has `parseActions()` and `executeActions()`. The action handlers here contain the actual Supabase queries and mutations. These become tool handlers.
4. `api/riker-memory.js` — notebook/memory system. Keep as-is, but wrap as tools.
5. `api/riker.js` — HTTP endpoint for website/portal/app chat. Calls `riker-core.processMessage()`. Interface stays the same.
6. `api/claude.js` — HTTP endpoint for app chat. Also calls `riker-core.processMessage()`. Interface stays the same.
7. `api/sms-inbound.js` — Twilio webhook. Calls `riker-core.processMessage()`. Interface stays the same.
8. `api/william-schedule.js` — William custody schedule + Jon availability. Wrap as a tool.
9. `supabase-schema.sql` — full database schema for reference on table/column names.

## Architecture: what changes and what doesn't

### STAYS THE SAME
- `api/riker.js`, `api/claude.js`, `api/sms-inbound.js` — these call `processMessage()` and return `{ reply, actions_taken, session_id, ... }`. The interface doesn't change.
- `api/riker-memory.js` — keep the functions, just call them from tool handlers.
- `api/william-schedule.js` — keep as-is, wrap in a tool.
- Session adapters (riker_sessions + conversations/messages) — keep as-is.
- `riker_interactions` logging — keep as-is.

### CHANGES
- `api/riker-core.js` — major rewrite. `buildLiveData()` is deleted. `callClaude()` becomes a tool-use loop. `processMessage()` orchestrates the loop.
- `api/riker-prompts.js` — `assemblePrompt()` is replaced with a slim identity-only prompt. `CONTEXT_ACTIONS` is deleted (tools define permissions). The CORE_IDENTITY text gets trimmed to essentials.
- `api/riker-actions.js` — `parseActions()` and `executeActions()` are deleted (Claude uses structured tool_use, not text-parsed action blocks). The actual handler functions stay but get rewired as tool callbacks.

### NEW
- `api/riker-tools.js` — new file. Defines all tool schemas and their handler functions.

## The tool-use loop

Here's how the Claude API tool_use flow works. This replaces the current single-shot call:

```javascript
async function callClaudeWithTools({ systemPrompt, messages, tools, maxTurns = 10 }) {
  let allMessages = [...messages];
  let allActionsTaken = [];
  
  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: systemPrompt,  // Use cache_control for this — see prompt caching section
        messages: allMessages,
        tools: tools
      })
    });
    
    const data = await response.json();
    if (!response.ok) throw new Error('Claude error: ' + JSON.stringify(data));
    
    // Check if Claude wants to use tools
    const toolUseBlocks = (data.content || []).filter(b => b.type === 'tool_use');
    const textBlocks = (data.content || []).filter(b => b.type === 'text');
    
    if (toolUseBlocks.length === 0) {
      // No tools requested — Claude is done, return the text response
      return {
        text: textBlocks.map(b => b.text).join('\n'),
        usage: data.usage,
        actionsTaken: allActionsTaken
      };
    }
    
    // Claude wants tools — execute them and send results back
    // Add assistant's response (with tool_use blocks) to messages
    allMessages.push({ role: 'assistant', content: data.content });
    
    // Execute each tool call and build tool_result messages
    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      const result = await executeToolCall(toolUse.name, toolUse.input);
      allActionsTaken.push({ type: toolUse.name, input: toolUse.input, result });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result)
      });
    }
    
    // Send tool results back to Claude
    allMessages.push({ role: 'user', content: toolResults });
  }
  
  throw new Error('Max tool-use turns exceeded');
}
```

## Prompt caching

Use Anthropic's prompt caching to make the static system prompt nearly free after the first message. The system prompt should be structured as an array with cache_control:

```javascript
system: [
  {
    type: "text",
    text: RIKER_IDENTITY,  // ~1500 tokens — who Riker is, company facts, voice
    cache_control: { type: "ephemeral" }  // Cache this block
  }
]
```

The tools array is also automatically cached by the API. So the identity + tool definitions (~3K tokens total) cost full price on the first call and 90% less on subsequent calls within the same 5-minute window.

## Tool definitions

Define these in `api/riker-tools.js`. Each tool has a `schema` (for the Claude API) and a `handler` (the function that runs server-side).

### Read tools (query only)

**get_today_summary** — Quick dashboard: date, number of jobs today, overdue count, unpaid total.
- No required inputs
- Handler: 3 parallel Supabase queries (today's jobs, overdue count, unpaid sum)
- This is the ONLY data fetched automatically — call it at session start so Riker always has a baseline

**query_jobs** — Search/filter jobs
- Inputs: `status` (enum: scheduled/completed/cancelled), `date_from`, `date_to`, `location_id`, `scope` (array), `limit` (default 20)
- Handler: Supabase query on `jobs` table with joins to `locations`

**lookup_client** — Search clients by name, city, or phone
- Inputs: `search` (string, required)
- Handler: Supabase ilike query on `locations` joined with `billing_accounts` and `location_contacts`

**get_invoices** — Query invoices
- Inputs: `status` (enum: paid/unpaid/void/all), `billing_account_id`, `date_from`, `date_to`, `limit` (default 10)
- Handler: Supabase query on `invoices`

**get_schedule_slots** — Get available time slots (William-aware)
- Inputs: `date_from` (default today), `num_days` (default 5)
- Handler: Uses william-schedule.js + calendar_events + existing jobs to compute open slots

**get_equipment** — Get equipment at a location
- Inputs: `location_id` (required)
- Handler: Queries `extinguishers`, `suppression_systems`, `emergency_lights` for that location

**get_pending_confirmations** — Get pending approval items
- No required inputs
- Handler: Supabase query on `pending_confirmations` where status=pending and not expired

**get_todos** — Get Jon's to-do list
- No required inputs  
- Handler: Supabase query on `todos` table, ordered by priority

**read_memory** — Read Riker's notebook entries
- Inputs: `category` (optional: standing_order, preference, note, all)
- Handler: Calls riker-memory.readRelevantMemories()

**get_rate_card** — Get service pricing
- No required inputs
- Handler: Supabase query on `rate_card`

### Write tools (mutate data)

**schedule_job** — Create a new job
- Inputs: `location_id`, `date`, `time`, `scope` (array), `notes`, `auto_confirm` (boolean, default false)
- Handler: If auto_confirm=false (default for website context), creates a pending_confirmation and texts Jon. If true (Jon via SMS/app), creates the job directly.

**approve_pending** — Approve a pending confirmation
- Inputs: `confirmation_id` (required)
- Handler: Loads the pending_confirmation, executes the proposed action, updates status to approved

**reject_pending** — Reject a pending confirmation
- Inputs: `confirmation_id` (required), `reason` (optional)
- Handler: Updates pending_confirmation status to rejected

**send_sms** — Send SMS to a customer
- Inputs: `to` (phone number, required), `body` (required)
- Handler: Twilio sendMessage

**add_client** — Create a new location/billing account
- Inputs: `business_name`, `city`, `address`, `contact_name`, `contact_phone`, `contact_email`
- Handler: Creates billing_account + location + location_contact in Supabase

**add_todo** — Add to Jon's to-do list
- Inputs: `text` (required), `priority` (default 5)
- Handler: Insert into `todos`

**write_memory** — Save a standing order, preference, or note
- Inputs: `category` (enum: standing_order/preference/note), `key` (short label), `content` (the actual text), `priority` (default 5, use 10 for standing orders)
- Handler: Calls riker-memory.writeMemory()

**delete_memory** — Remove a memory entry
- Inputs: `memory_id` (required)
- Handler: Calls riker-memory.deleteMemory()

**mark_invoice_paid** — Mark an invoice as paid
- Inputs: `invoice_id` (required), `payment_method` (optional), `payment_date` (optional, default today)
- Handler: Updates invoice status in Supabase

## The slim system prompt

Replace the current 23K-token assembled prompt with this (~1500 tokens):

```
You are Riker, the assistant for Stephens Advanced LLC — a fire suppression inspection company based in Euless, Texas, serving the Dallas-Fort Worth metro.

COMPANY FACTS:
- Owner / primary tech: Jon Stephens
- Phone: (214) 994-4799
- Email: jonathan@stephensadvanced.com
- Service area: Dallas-Fort Worth metro, extra focus on Brycer-compliance cities (Fort Worth, Arlington, surrounding)

WHO YOU ARE:
You are a long-tenured receptionist and executive officer rolled into one. You know every customer by name. You remember what they told you last time. You are friendly but efficient — no fluff, no filler. You have five faces:
- Website chat: friendly receptionist for new prospects
- Customer portal: professional service rep for existing customers  
- Field app + SMS + Email: Jon's executive assistant — full access, terse, action-oriented

FIRE PROTECTION KNOWLEDGE:
- NFPA 10 (Portable Extinguishers): annual visual, 6-year internal on stored-pressure (ABC, BC, Purple K, Halon, Halotron, Class D, Clean Agent), 12-year hydrostatic on those same types, 5-year hydrostatic on CO2/Water/Class K. CO2/Water/Class K do NOT get 6-year internals.
- NFPA 17A (Wet Chemical Kitchen Hood Suppression): semi-annual (every 6 months). Brands: Ansul R-102, Pyro-Chem Kitchen Knight II, and CORE, Amerex. 33-point inspection.
- NFPA 96 (Hood Cleaning): required but we don't do it — refer out.
- Emergency Lighting: annual inspection per NFPA 101.
- Brycer: Fort Worth's third-party compliance system. Annual fire inspections required.

CRITICAL RULES:
1. NEVER fabricate data. If you don't have it, say so and offer to look it up.
2. Use your tools — don't guess at job counts, invoice totals, or client details.
3. For scheduling, ALWAYS check get_schedule_slots first. Jon's son William has a custody schedule that blocks certain times.
4. On the website, collect info one question at a time. Don't ask for everything at once.
5. When Jon (SMS or app context) gives a directive phrased as a standing order, write it to memory immediately.
6. If a pending confirmation exists and the user says Y, Yes, Confirm, Approve, or similar — treat it as approve_pending.

TODAY: {today_date}
CONTEXT: {context}
```

The `{today_date}` and `{context}` are the only dynamic parts — injected at call time.

## Context-based tool filtering

Different surfaces get different tool subsets. Define this in riker-tools.js:

```javascript
const CONTEXT_TOOLS = {
  website: ['lookup_client', 'get_schedule_slots', 'get_rate_card', 'schedule_job', 'add_client', 'send_sms'],
  portal: ['lookup_client', 'get_invoices', 'get_equipment', 'get_schedule_slots', 'schedule_job'],
  app: null,       // ALL tools
  sms_jon: null,   // ALL tools
  sms_customer: ['lookup_client', 'get_schedule_slots', 'get_rate_card', 'schedule_job', 'add_client'],
  email_customer: ['lookup_client', 'get_schedule_slots', 'schedule_job', 'add_client', 'send_sms']
};
```

`null` means all tools are available. For website/portal/customer contexts, only expose a safe subset.

## processMessage() rewrite

The new `processMessage()` flow:

1. Resolve session (same as now — adapter pattern stays)
2. Load conversation history (same as now)
3. Read memory via tool at session start — OR, for efficiency, pre-load memory into a small context block appended to the system prompt (memory entries are tiny, typically < 200 tokens)
4. Build the system prompt (identity + today's date + context + memory block)
5. Filter tools by context
6. Call `callClaudeWithTools()` with the tool-use loop
7. Extract the final text reply and actions taken
8. Save assistant message via adapter
9. Log to riker_interactions
10. Return `{ reply, actions_taken, session_id, cost }`

## Important implementation details

### Don't pre-fetch data
The entire point is that Claude fetches what it needs. Do NOT call `get_today_summary` before Claude runs. Let Claude decide. The exception: you MAY inject memory entries into the system prompt since they're tiny and always relevant.

### Handle tool errors gracefully
If a Supabase query fails inside a tool handler, return `{ error: "..." }` as the tool result — don't throw. Claude will see the error and tell the user something went wrong.

### Conversation context carries tools
The tool results from earlier turns stay in the message history. So if Claude looked up a client in turn 1, it still has that data in turn 3 without re-querying.

### Token budget
Set `max_tokens: 1500` for the response (same as now). The tool-use loop adds tokens for each round-trip, but individual tool results should be kept compact — don't return 100 rows when 20 will do. Default `limit: 20` on all query tools.

### Cost tracking
Track tokens across all turns in the loop. Sum up `input_tokens` and `output_tokens` from each API call. Cache hits show up in `cache_read_input_tokens`.

### The pending confirmation + "Y" problem
Currently broken because Riker doesn't recognize short affirmative texts as approval commands. The new system prompt explicitly says: "If a pending confirmation exists and the user says Y, Yes, Confirm, Approve, or similar — treat it as approve_pending." And since `approve_pending` is now a proper tool, Claude will call it directly instead of trying to emit a text action block.

## Testing after rewrite

After deploying, test:
1. Website chat: "hello" → should get a greeting, no errors
2. Website chat: full scheduling flow (name → city → contact → time → confirm)
3. App chat: "what's overdue" → should call query_jobs tool and return real data
4. App chat: "who owes me money" → should call get_invoices tool
5. SMS (have Jon text): "Y" with a pending confirmation → should call approve_pending
6. SMS: "what's on my schedule today" → should call query_jobs

## Files to create/modify (summary)

| File | Action |
|------|--------|
| `api/riker-tools.js` | CREATE — tool schemas + handlers |
| `api/riker-core.js` | REWRITE — tool-use loop, slim prompt, remove buildLiveData |
| `api/riker-prompts.js` | SLIM DOWN — keep identity text, remove CONTEXT_ACTIONS, remove assemblePrompt |
| `api/riker-actions.js` | KEEP for reference during rewrite, then can be removed once tools are verified |
| `api/riker.js` | NO CHANGE |
| `api/claude.js` | NO CHANGE |
| `api/sms-inbound.js` | NO CHANGE |
| `api/riker-memory.js` | NO CHANGE (called by tool handlers) |
| `api/william-schedule.js` | NO CHANGE (called by get_schedule_slots handler) |
