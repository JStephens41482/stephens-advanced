-- Migration 014: Riker's Desk + memory categories + session rolling summary
--
-- Phase 1 (Riker's Desk): needs two new memory categories so the desk can
-- distinguish durable notebook facts from short-lived situational state.
--   short_term_desk  — ephemeral notes Riker keeps on his desk (48h TTL)
--   web_lookup       — cached web lookup summaries (24h TTL)
--   email_drafted    — outbound drafts awaiting Jon's review
-- Phase 2 (session sliding window): riker_sessions.summary holds the rolling
-- paragraph so older turns can be pruned without losing their gist.

-- ─────────────────────────────────────────────
-- Expand riker_memory.category CHECK
-- ─────────────────────────────────────────────
ALTER TABLE riker_memory DROP CONSTRAINT IF EXISTS riker_memory_category_check;
ALTER TABLE riker_memory
  ADD CONSTRAINT riker_memory_category_check
  CHECK (category IN (
    'preference',
    'relationship',
    'equipment_note',
    'scheduling',
    'billing',
    'compliance',
    'conversation',
    'action_pending',
    'route_note',
    'internal',
    'short_term_desk',   -- Phase 1: live situational notes, 48h TTL default
    'web_lookup',        -- Phase 4: cached web lookup results
    'email_drafted',     -- Phase 3: Riker-drafted email awaiting Jon's nod
    'fact',              -- general fact learned from conversation
    'vendor',            -- vendor-specific notes
    'procedure',         -- SOP-style how-we-do-X
    'gate_code'          -- site access info (door codes, keys, etc.)
  ));

-- ─────────────────────────────────────────────
-- riker_sessions: rolling summary for the sliding-window memory
-- ─────────────────────────────────────────────
ALTER TABLE riker_sessions ADD COLUMN IF NOT EXISTS summary text;
ALTER TABLE riker_sessions ADD COLUMN IF NOT EXISTS summary_updated_at timestamptz;
ALTER TABLE riker_sessions ADD COLUMN IF NOT EXISTS summary_covers_turn_count int DEFAULT 0;

-- ─────────────────────────────────────────────
-- audit_log hygiene — make sure we can write at the speed Riker needs
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_created ON audit_log (actor, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_riker_sessions_updated ON riker_sessions (updated_at DESC) WHERE status = 'active';

-- ─────────────────────────────────────────────
-- Web lookup cache (Phase 4). Keyed by a normalized query string so repeat
-- lookups in the same hour don't re-hit the external API.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS web_lookup_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_key text NOT NULL UNIQUE,
  query_text text NOT NULL,
  kind text NOT NULL,                 -- 'search' | 'fetch' | 'weather'
  response jsonb NOT NULL,
  source text,                        -- 'brave' | 'tavily' | 'openweathermap' | 'browserbase'
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_web_lookup_expires ON web_lookup_cache (expires_at);
CREATE INDEX IF NOT EXISTS idx_web_lookup_kind ON web_lookup_cache (kind, created_at DESC);

ALTER TABLE web_lookup_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_web_lookup_cache" ON web_lookup_cache FOR ALL USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────
-- Email inbox mirror (Phase 3). Inbound emails are already logged as
-- messages rows by email-inbound.js, but a lightweight view of "unread
-- threads" lets Riker ask read_inbox() without re-parsing every message.
-- We model it as a simple table that email-inbound.js appends to, plus a
-- read-marker Riker can update.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at timestamptz NOT NULL DEFAULT now(),
  thread_id text,                     -- maps to conversations.email_thread_id
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  from_email text NOT NULL,
  from_name text,
  to_email text,
  subject text,
  preview text,                       -- first ~200 chars of plain-text body
  message_id text,                    -- RFC 5322 Message-ID
  in_reply_to text,
  read_at timestamptz,                -- set when Riker or Jon marks it read
  replied_at timestamptz,
  jon_notified_at timestamptz,        -- Riker pinged Jon about this one
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  classification text,                -- 'customer' | 'vendor' | 'personal' | 'spam' | 'other'
  needs_reply boolean DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_email_inbox_unread ON email_inbox (received_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_email_inbox_thread ON email_inbox (thread_id);
CREATE INDEX IF NOT EXISTS idx_email_inbox_conv ON email_inbox (conversation_id);
CREATE INDEX IF NOT EXISTS idx_email_inbox_needs_reply ON email_inbox (needs_reply, received_at DESC) WHERE needs_reply = true AND read_at IS NULL;

ALTER TABLE email_inbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_email_inbox" ON email_inbox FOR ALL USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────
-- Email drafts awaiting Jon's approval (Phase 3).
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  thread_id text,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  to_email text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  reply_to_message_id text,           -- In-Reply-To header
  references_header text,             -- RFC 5322 References
  status text DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','sent','failed')),
  approved_at timestamptz,
  sent_at timestamptz,
  source_context text,                -- 'sms_jon' | 'app' | 'cron' etc.
  reasoning text
);

CREATE INDEX IF NOT EXISTS idx_email_drafts_pending ON email_drafts (created_at DESC) WHERE status = 'pending';

ALTER TABLE email_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_email_drafts" ON email_drafts FOR ALL USING (true) WITH CHECK (true);
