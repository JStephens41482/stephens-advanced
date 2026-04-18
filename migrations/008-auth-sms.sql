-- Migration 008: SMS-link sign-in + device cookies
-- Replaces the shared PIN 264526 (bus-factor 1, in-the-clear, no revoke)
-- with a phone-tied flow: request a 6-digit code via Twilio, verify to
-- mint a 30-day device cookie. Biometric/passkey binding is a later pass.

-- Short-lived verification codes. One row per request; marked used=true
-- on successful verify. Phone column stores E.164 (+1XXXXXXXXXX).
CREATE TABLE IF NOT EXISTS auth_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL,
  code_hash text NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  used boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_codes_phone_created ON auth_codes(phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_codes_expires ON auth_codes(expires_at);

-- Long-lived device tokens. Cookie value is the raw token; DB stores
-- sha256(token) only. Revoked rows stay for audit.
CREATE TABLE IF NOT EXISTS auth_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  label text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_auth_devices_phone ON auth_devices(phone) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_auth_devices_expires ON auth_devices(expires_at) WHERE revoked_at IS NULL;

-- RLS: lock both tables down. Only the service role (server endpoint)
-- should touch them. Anon key has zero access.
ALTER TABLE auth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_devices ENABLE ROW LEVEL SECURITY;
