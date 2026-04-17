-- Migration 003: Riker Scheduling Coordinator (SMS + Email)
-- Channel-agnostic conversation tables so both inbound SMS (Twilio) and
-- inbound email (Gmail polling) share the same pipeline + pending-
-- confirmation gate.
-- All statements are idempotent.

-- ============================================================
-- Conversations + message log (SMS + Email)
-- ============================================================

CREATE TABLE IF NOT EXISTS conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  last_message_at TIMESTAMPTZ DEFAULT now(),

  channel TEXT NOT NULL CHECK (channel IN ('sms', 'email')),
  party TEXT NOT NULL CHECK (party IN ('customer', 'jon')),

  -- SMS identity
  phone TEXT,
  -- Email identity
  email TEXT,
  email_thread_id TEXT,                   -- Gmail threadId for reply threading

  -- Customer-side conversations may be linked to a known location.
  -- Jon-side conversations leave this null.
  location_id UUID REFERENCES locations(id),
  customer_name TEXT,

  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'closed', 'abandoned'))
);

CREATE INDEX IF NOT EXISTS idx_conv_phone ON conversations(phone, status) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conv_email ON conversations(email, status) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conv_thread ON conversations(email_thread_id) WHERE email_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conv_location ON conversations(location_id);

CREATE TABLE IF NOT EXISTS messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),

  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  channel TEXT NOT NULL CHECK (channel IN ('sms', 'email')),
  body TEXT NOT NULL,

  -- Channel-specific metadata
  twilio_sid TEXT,                        -- SMS
  email_message_id TEXT,                  -- Email Message-ID header or Gmail id
  email_subject TEXT,                     -- Email only
  email_from TEXT,
  email_to TEXT,

  status TEXT,                            -- delivered, failed, etc.
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_email_id ON messages(email_message_id) WHERE email_message_id IS NOT NULL;

-- ============================================================
-- Pending confirmations (Jon-approval gate)
-- ============================================================

CREATE TABLE IF NOT EXISTS pending_confirmations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ DEFAULT (now() + interval '4 hours'),
  responded_at TIMESTAMPTZ,

  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed')),

  source_conversation_id UUID REFERENCES conversations(id),
  source_channel TEXT CHECK (source_channel IN ('sms', 'email')),
  customer_phone TEXT,
  customer_email TEXT,
  customer_name TEXT,
  location_id UUID REFERENCES locations(id),

  proposed_action JSONB NOT NULL,         -- { type: "schedule_job", date, time, scope, duration_hours, ... }
  proposed_reply TEXT NOT NULL,           -- the message Riker will send on approval
  reasoning TEXT,                         -- why Riker asked instead of auto-confirming
  jon_response TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_confirmations(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pending_expires ON pending_confirmations(expires_at) WHERE status = 'pending';

-- ============================================================
-- Location SMS + Email opt-in
-- ============================================================

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS sms_opt_in BOOLEAN DEFAULT false;

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS sms_opt_in_at TIMESTAMPTZ;

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS sms_opt_in_source TEXT;    -- 'website', 'verbal', 'inbound_sms', 'form'

-- ============================================================
-- Processed email tracking (Gmail polling idempotency)
-- ============================================================

-- Prevents double-processing of Gmail messages if the cron runs overlapping
-- or a message was already handled.
CREATE TABLE IF NOT EXISTS processed_emails (
  gmail_message_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ DEFAULT now(),
  conversation_id UUID REFERENCES conversations(id),
  outcome TEXT                            -- 'replied', 'ignored', 'failed'
);
