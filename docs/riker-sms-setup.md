# Riker Scheduling Coordinator — Setup

Riker is the inbound scheduling assistant for Stephens Advanced. It receives
customer inquiries via **SMS (Twilio)** and **email (Gmail polling)**,
proposes appointment times that fit your calendar and your custody schedule
with William, and texts you to approve before booking anything.

Both channels share the same brain, the same approval gate, and the same
database tables — `conversations`, `messages`, `pending_confirmations`.

## One-time setup

### 1. Run the migration

Apply `migrations/003-sms-scheduling.sql` in Supabase SQL editor. Creates:
- `conversations` — one row per SMS or email thread (channel column)
- `messages` — full message log, both channels
- `pending_confirmations` — proposed actions awaiting your YES/NO
- `processed_emails` — Gmail message dedup
- Columns on `locations`: `sms_opt_in`, `sms_opt_in_at`, `sms_opt_in_source`

### 2. Twilio (SMS) webhook

In the Twilio console, for your messaging number:
- **A Message Comes In**: `https://stephensadvanced.com/api/sms-inbound`
- **HTTP**: POST

### 3. Gmail (email) setup

**3a. Re-authorize Google OAuth with Gmail scope.**
Your existing `GOOGLE_CALENDAR_REFRESH_TOKEN` only has calendar scope. To
read/modify inbox mail, Gmail needs its own scope:
`https://www.googleapis.com/auth/gmail.modify`

Run the OAuth flow (Google OAuth Playground is simplest):
1. Go to https://developers.google.com/oauthplayground/
2. Gear icon → check "Use your own OAuth credentials" → enter your existing
   `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`
3. In "Step 1", scroll to Gmail API v1, check
   `https://www.googleapis.com/auth/gmail.modify` **AND** re-check the
   calendar scopes you already have so the new token keeps both
4. Authorize → "Exchange authorization code for tokens"
5. Copy the new refresh token and set it in Vercel as
   `GOOGLE_CALENDAR_REFRESH_TOKEN` (replacing the old value)

**3b. Create a Gmail label + filter.**
- Create a label named exactly `Riker` (and optionally `Riker/Processed` —
  the poller will need nothing from the Processed label, but you can use it
  for manual triage).
- Create a Gmail filter. Suggested criteria:
  - Has the words: `schedule OR inspection OR extinguisher OR appointment
    OR quote OR suppression OR fire`
  - Doesn't have: `invoice no-reply noreply`
- Actions: **Skip the Inbox**, **Apply the label: Riker**, **Mark as read?
  DO NOT check** — Riker only processes unread labeled messages.

You can also apply the Riker label manually to any inbound email you want
the assistant to handle. That label is the single on-switch.

### 4. Environment variables

Already set (don't touch):
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
- `CLAUDE_KEY`, `GOOGLE_MAPS_API_KEY`, `RESEND_API_KEY`
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`
- `SUPABASE_SERVICE_ROLE_KEY`

Updated (re-generate with Gmail scope — see step 3a):
- `GOOGLE_CALENDAR_REFRESH_TOKEN`

New (optional):
- `RIKER_AUTO_CONFIRM=false` — default. Every booking pings you for approval.
  Set to `true` later to let Riker auto-book jobs that fit cleanly.
- `RIKER_SKIP_TWILIO_SIG=true` — local testing only. Leave unset in prod.
- `CRON_SECRET` — if you want the `/api/email-inbound` endpoint protected
  from manual hits. Vercel Cron will pass this automatically as
  `Authorization: Bearer <value>`.

### 5. Cron frequency

`vercel.json` polls Gmail every 5 minutes (`*/5 * * * *`). Email responses
are delayed by up to 5 min. If you need faster, lower to `*/2` or `* * * * *`.
Note: Vercel Hobby tier limits cron to daily; this needs **Pro tier** for
minute-level cron.

## How it works

### Customer sends SMS
1. Twilio POSTs to `/api/sms-inbound` with signature verification.
2. Riker looks up the phone in `conversations` (or creates a new row).
3. Inbound message saved to `messages` with `channel='sms'`.
4. Brain loads history + today's William-aware available slots + current jobs.
5. Claude responds. If there's a `schedule_job` action:
   - **Manual-confirm mode** (default): writes `pending_confirmations`, texts you
     for approval, replies to customer "Let me double-check with Jon"
   - **Auto-confirm** (when `RIKER_AUTO_CONFIRM=true` AND the slot fits):
     executes immediately, texts you a heads-up

### Customer sends email
1. Gmail filter labels the inbound as `Riker`.
2. `/api/email-inbound` cron runs, finds unread labeled messages.
3. Parses From/Subject/Body/thread-id, dedups against `processed_emails`.
4. Same brain path as SMS — conversation keyed by email address + thread id.
5. Riker replies via Resend from `jonathan@stephensadvanced.com`, threaded
   correctly with `In-Reply-To` + `References` headers so it appears as a
   normal reply in the customer's mail client and in your Sent folder.
6. Gmail message marked read; recorded in `processed_emails` so it won't
   be processed twice.

### Your reply to Riker
Any text from your phone (`+12149944799`) is treated as Jon-side. If a
pending confirmation exists:
- `YES` / `Y` / `OK` / `approve` → executes, sends customer confirmation on
  the correct channel (SMS or email, with proper threading)
- `NO` / `N` / `cancel` → rejects, tells customer you'll follow up
- Anything else → asks for clarification (counter-offer parsing is Phase 2)

### William custody rules
Encoded in `api/william-schedule.js`. School-year weekday rules:
- **Mon-Thu mornings**: Jon drops by 8:40 → work starts ~9:00
- **Fri morning**: Mom drops → work starts 7:00
- **Mon-Wed afternoons**: Jon picks up at 4:10 → last job ~3:50
- **Thu afternoon**: Mom picks up → free until 6:00
- **Fri afternoon**:
  - 1st/3rd/5th weekend: Mom picks up → free until 6:00
  - 2nd/4th weekend: Jon picks up → last job ~3:50
- **Sat/Sun**:
  - 1st/3rd/5th weekend: William with Mom → available
  - 2nd/4th weekend: William with Jon → BLOCKED

**Not yet encoded** (override via Google Calendar events):
- Summer possession
- Spring break, Thanksgiving, Christmas, other school breaks
- Specific appointments / sick days / mom-swaps

Add a busy event to your Google Calendar for any exception — Riker treats
it as unavailable.

## Testing before going live

1. Keep `RIKER_AUTO_CONFIRM=false` (default) so nothing auto-books.
2. **SMS test**: Text Riker's Twilio number from a non-Jon phone. Verify:
   - Customer gets a reply within a few seconds
   - You get the `CONFIRM?` text when the AI has enough info to propose
   - Reply YES → job + calendar event appear in Supabase + Google Cal
3. **Email test**: Send an email to `jonathan@stephensadvanced.com` from
   a test address, apply the `Riker` label manually, wait ≤5 min. Verify:
   - Reply appears in your Sent folder, threaded with the original
   - Same `CONFIRM?` flow fires on your phone
4. Check `messages`, `conversations`, `pending_confirmations`, and
   `processed_emails` tables to audit what happened.
5. When you're ready, set `RIKER_AUTO_CONFIRM=true` in Vercel env.
