-- Migration 004: Riker Core — Memory, Sessions, Audit Log
-- Builds on 003 (SMS/email plumbing) to add the unified AI brain's
-- persistent state: notebook-style memory, server-side conversation
-- sessions, and an audit log of every Claude call.
-- All statements are idempotent.

-- ============================================================
-- Riker Memory — the notebook
-- ============================================================

-- Structured, scoped, expiring memory that Riker reads before every call
-- and writes after every significant conversation. Acts as the receptionist's
-- notebook: things worth remembering about customers, equipment, and work.
CREATE TABLE IF NOT EXISTS riker_memory (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ,

  scope TEXT NOT NULL CHECK (scope IN ('global', 'location', 'customer', 'job', 'tech')),
  location_id UUID REFERENCES locations(id) ON DELETE CASCADE,
  billing_account_id UUID REFERENCES billing_accounts(id) ON DELETE CASCADE,
  job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
  tech_id UUID REFERENCES technicians(id) ON DELETE CASCADE,

  category TEXT NOT NULL CHECK (category IN (
    'preference',
    'relationship',
    'equipment_note',
    'scheduling',
    'billing',
    'compliance',
    'conversation',
    'action_pending',
    'route_note',
    'internal'
  )),
  content TEXT NOT NULL,
  priority INT DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),

  source TEXT,
  source_session_id UUID,
  auto_generated BOOLEAN DEFAULT false,
  archived BOOLEAN DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_memory_location ON riker_memory(location_id) WHERE NOT archived;
CREATE INDEX IF NOT EXISTS idx_memory_scope ON riker_memory(scope, category) WHERE NOT archived;
CREATE INDEX IF NOT EXISTS idx_memory_expires ON riker_memory(expires_at) WHERE expires_at IS NOT NULL AND NOT archived;
CREATE INDEX IF NOT EXISTS idx_memory_billing ON riker_memory(billing_account_id) WHERE NOT archived;
CREATE INDEX IF NOT EXISTS idx_memory_job ON riker_memory(job_id) WHERE NOT archived;
CREATE INDEX IF NOT EXISTS idx_memory_category_priority ON riker_memory(category, priority DESC) WHERE NOT archived;

-- ============================================================
-- Riker Sessions — server-side conversation storage
-- ============================================================

-- For web / portal / app chat surfaces. Unlike the sms/email `conversations`
-- table (which is keyed by external identity), sessions are keyed by the
-- session_id generated when a chat widget opens. Same data model shape
-- on purpose — future work may merge these tables.
CREATE TABLE IF NOT EXISTS riker_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  context TEXT NOT NULL CHECK (context IN ('website', 'portal', 'app', 'sms', 'email')),

  -- Identity
  location_id UUID REFERENCES locations(id),
  billing_account_id UUID REFERENCES billing_accounts(id),
  tech_id UUID REFERENCES technicians(id),
  portal_token TEXT,                      -- for portal sessions

  -- Customer-facing surfaces may have partial identity
  customer_phone TEXT,
  customer_email TEXT,
  customer_name TEXT,

  -- Conversation (newest at end)
  messages JSONB DEFAULT '[]'::jsonb,

  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'closed', 'abandoned')),

  -- Cost/usage aggregates (denormalized for quick inspection)
  total_input_tokens INT DEFAULT 0,
  total_output_tokens INT DEFAULT 0,
  total_cost_usd NUMERIC(10,4) DEFAULT 0,
  actions_taken JSONB DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_sessions_active ON riker_sessions(context, status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_sessions_location ON riker_sessions(location_id);
CREATE INDEX IF NOT EXISTS idx_sessions_tech ON riker_sessions(tech_id);

-- ============================================================
-- Riker Interactions — audit log
-- ============================================================

-- One row per Claude call across all contexts. Gives cost tracking,
-- quality auditing, and raw training data should we ever want it.
CREATE TABLE IF NOT EXISTS riker_interactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),

  session_id UUID,                        -- may point to riker_sessions or conversations
  session_source TEXT,                    -- 'riker_sessions' | 'conversations'
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
  memory_entries_read INT DEFAULT 0,

  -- Cost tracking
  input_tokens INT,
  output_tokens INT,
  cache_read_tokens INT,
  cache_creation_tokens INT,
  cost_usd NUMERIC(10,6),
  latency_ms INT,

  -- Errors
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_interactions_created ON riker_interactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_interactions_context ON riker_interactions(context, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_interactions_session ON riker_interactions(session_id);

-- ============================================================
-- Service requests (referenced by portal.html; schema may not have it yet)
-- ============================================================

CREATE TABLE IF NOT EXISTS service_requests (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  billing_account_id UUID REFERENCES billing_accounts(id),
  location_id UUID REFERENCES locations(id),
  request_type TEXT,                      -- 'reschedule_sooner', 'new_service', 'emergency', 'question', 'other'
  requested_date DATE,
  notes TEXT,
  source TEXT DEFAULT 'portal',           -- 'portal', 'website', 'sms', 'email'

  status TEXT DEFAULT 'new' CHECK (status IN ('new', 'acknowledged', 'scheduled', 'closed', 'rejected')),
  responded_at TIMESTAMPTZ,
  job_id UUID REFERENCES jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_service_requests_status ON service_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_requests_location ON service_requests(location_id);
