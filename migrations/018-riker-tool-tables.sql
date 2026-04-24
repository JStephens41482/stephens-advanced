-- Migration 018: Tables for new Riker tool suite (Phase 5)
-- Safe to run multiple times — all statements use IF NOT EXISTS.
--
-- What this adds:
--   1. techs — technician roster (live table; technicians is an orphan schema relic)
--   2. brycer_queue — Brycer compliance submission queue
--   3. portal_tokens — customer portal access tokens with expiry
--   4. service_requests — service requests submitted via portal
--   5. custom_items — reusable invoice line item templates
--   6. contracts.sent_at / contracts.sent_to — columns send_contract needs
--   7. jobs.assigned_to FK — ties jobs to techs row
--
-- Most of these already exist in production (created inline in app.html /
-- appv2.html). This migration makes them formal so Riker tools can rely on
-- them without "table not found" errors.

-- ─── 1. TECHS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS techs (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name       text NOT NULL,
  phone      text,
  email      text,
  license_number text,
  color      text DEFAULT '#f05a28',
  active     boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE techs ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "allow_all_techs" ON techs FOR ALL USING (true) WITH CHECK (true);

-- ─── 2. BRYCER QUEUE ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brycer_queue (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id           uuid REFERENCES jobs(id) ON DELETE SET NULL,
  location_id      uuid REFERENCES locations(id) ON DELETE SET NULL,
  location_name    text,
  system_type      text,
  job_date         date,
  report_generated boolean DEFAULT false,
  submitted        boolean DEFAULT false,
  submitted_date   date,
  created_at       timestamptz DEFAULT now()
);

ALTER TABLE brycer_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "allow_all_brycer_queue" ON brycer_queue FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_brycer_queue_submitted ON brycer_queue (submitted, created_at) WHERE submitted = false;
CREATE INDEX IF NOT EXISTS idx_brycer_queue_location  ON brycer_queue (location_id);

-- ─── 3. PORTAL TOKENS ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS portal_tokens (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  token             text UNIQUE NOT NULL,
  location_id       uuid REFERENCES locations(id) ON DELETE SET NULL,
  billing_account_id uuid,
  is_active         boolean DEFAULT true,
  last_accessed_at  timestamptz,
  expires_at        timestamptz,
  created_at        timestamptz DEFAULT now()
);

ALTER TABLE portal_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "allow_all_portal_tokens" ON portal_tokens FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_portal_tokens_token    ON portal_tokens (token);
CREATE INDEX IF NOT EXISTS idx_portal_tokens_location ON portal_tokens (location_id);

-- ─── 4. SERVICE REQUESTS ────────────────────────────────────────
-- Migration 004 already created service_requests with a slightly different
-- shape (status CHECK list: new/acknowledged/scheduled/closed/rejected).
-- The app.html version uses status='pending'. Add 'pending' to the check
-- if needed, and add any missing columns.

CREATE TABLE IF NOT EXISTS service_requests (
  id                 uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now(),
  location_id        uuid REFERENCES locations(id) ON DELETE SET NULL,
  billing_account_id uuid,
  job_id             uuid REFERENCES jobs(id) ON DELETE SET NULL,
  request_type       text,
  requested_date     date,
  reason             text,
  notes              text,
  source             text DEFAULT 'portal',
  status             text DEFAULT 'pending',
  responded_at       timestamptz
);

-- Add columns that may be missing from the 004 version
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS request_type  text;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS reason        text;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS source        text DEFAULT 'portal';
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS updated_at    timestamptz DEFAULT now();
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS responded_at  timestamptz;

ALTER TABLE service_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "allow_all_service_requests" ON service_requests FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_service_requests_status   ON service_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_requests_location ON service_requests (location_id);

-- ─── 5. CUSTOM ITEMS ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS custom_items (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  normalized_key text UNIQUE NOT NULL,
  description    text NOT NULL,
  unit_price     numeric(10,2) NOT NULL DEFAULT 0,
  created_at     timestamptz DEFAULT now()
);

ALTER TABLE custom_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "allow_all_custom_items" ON custom_items FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_custom_items_key ON custom_items (normalized_key);

-- ─── 6. CONTRACTS — add sent_at / sent_to columns ───────────────
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS sent_at   timestamptz;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS sent_to   text;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS customer_name  text;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS customer_email text;

-- ─── 7. JOBS — add assigned_to FK to techs ──────────────────────
-- This may already exist from migration 007 or the inline schema in app.html.
-- The IF NOT EXISTS on ADD COLUMN makes it safe to re-run.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES techs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_assigned_to ON jobs (assigned_to) WHERE assigned_to IS NOT NULL;
