-- Migration 005: Mazon Factoring Module
-- Rebuilds the factoring workflow per the ORDERS: Mazon Factoring Module spec.
-- Adds mazon_schedules + mazon_audit_log, brings mazon_queue to the required
-- shape, adds columns to billing_accounts and invoices, and updates the
-- invoice status progression for factored invoices.
-- All statements are idempotent.

-- ============================================================
-- mazon_schedules — one row per batch submission
-- ============================================================

CREATE TABLE IF NOT EXISTS mazon_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_number INTEGER NOT NULL UNIQUE,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invoice_count INTEGER NOT NULL,
  total_amount NUMERIC(10,2) NOT NULL,
  email_message_id TEXT,
  xlsx_url TEXT,
  pdf_bundle_urls JSONB,
  backup_urls JSONB,
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','funded','partially_funded','rejected')),
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_mazon_schedules_submitted ON mazon_schedules(submitted_at DESC);

-- ============================================================
-- mazon_queue — bring the existing table up to the required shape.
-- The table already exists in production (created earlier without this
-- migration), so we ADD COLUMN IF NOT EXISTS for every field and only
-- recreate the table when it's missing entirely.
-- ============================================================

CREATE TABLE IF NOT EXISTS mazon_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  billing_account_id UUID REFERENCES billing_accounts(id),
  customer_name TEXT NOT NULL,
  location_address TEXT NOT NULL,
  date_of_service DATE NOT NULL,
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  invoice_number TEXT,
  signature_url TEXT,
  signature_printed_name TEXT,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','submitted','funded','rejected','voided')),
  schedule_id UUID REFERENCES mazon_schedules(id),
  submitted_at TIMESTAMPTZ,
  funded_at TIMESTAMPTZ,
  funded_amount NUMERIC(10,2),
  rejected_reason TEXT,
  voided_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Additive columns for the existing production table
ALTER TABLE mazon_queue ADD COLUMN IF NOT EXISTS billing_account_id UUID REFERENCES billing_accounts(id);
ALTER TABLE mazon_queue ADD COLUMN IF NOT EXISTS signature_url TEXT;
ALTER TABLE mazon_queue ADD COLUMN IF NOT EXISTS signature_printed_name TEXT;
ALTER TABLE mazon_queue ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ;
ALTER TABLE mazon_queue ADD COLUMN IF NOT EXISTS schedule_id UUID REFERENCES mazon_schedules(id);
ALTER TABLE mazon_queue ADD COLUMN IF NOT EXISTS funded_at TIMESTAMPTZ;
ALTER TABLE mazon_queue ADD COLUMN IF NOT EXISTS funded_amount NUMERIC(10,2);
ALTER TABLE mazon_queue ADD COLUMN IF NOT EXISTS rejected_reason TEXT;
ALTER TABLE mazon_queue ADD COLUMN IF NOT EXISTS voided_reason TEXT;
ALTER TABLE mazon_queue ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Default signed_at so retroactively-added rows pass NOT NULL
UPDATE mazon_queue SET signed_at = COALESCE(signed_at, created_at, NOW()) WHERE signed_at IS NULL;
ALTER TABLE mazon_queue ALTER COLUMN signed_at SET DEFAULT NOW();
ALTER TABLE mazon_queue ALTER COLUMN signed_at SET NOT NULL;

-- Extend status CHECK to include voided (new value required by spec)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'mazon_queue' AND constraint_name LIKE '%status%'
  ) THEN
    ALTER TABLE mazon_queue DROP CONSTRAINT IF EXISTS mazon_queue_status_check;
  END IF;
  ALTER TABLE mazon_queue ADD CONSTRAINT mazon_queue_status_check
    CHECK (status IN ('pending','submitted','funded','rejected','voided'));
END $$;

CREATE INDEX IF NOT EXISTS idx_mazon_queue_status ON mazon_queue(status);
CREATE INDEX IF NOT EXISTS idx_mazon_queue_invoice ON mazon_queue(invoice_id);
CREATE INDEX IF NOT EXISTS idx_mazon_queue_schedule ON mazon_queue(schedule_id);

-- ============================================================
-- mazon_audit_log — every state change on queue or schedule
-- ============================================================

CREATE TABLE IF NOT EXISTS mazon_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor TEXT NOT NULL,                         -- 'jon', 'system', 'cron', 'riker'
  entity_type TEXT NOT NULL CHECK (entity_type IN ('queue','schedule')),
  entity_id UUID NOT NULL,
  old_status TEXT,
  new_status TEXT NOT NULL,
  reason TEXT,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_mazon_audit_entity ON mazon_audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_mazon_audit_created ON mazon_audit_log(created_at DESC);

-- ============================================================
-- billing_accounts: Mazon approval flag
-- (phone already exists on billing_accounts)
-- ============================================================

ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS mazon_approved BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS mazon_approved_at TIMESTAMPTZ;

-- ============================================================
-- invoices: stamped PDF URL, queue back-reference
-- New allowed status values for factored progression:
--   'factored_pending'   — in Mazon queue, not yet submitted to Mazon
--   'factored_submitted' — emailed to Mazon, awaiting funding
--   'paid'               — Mazon funded
-- Existing columns status/payment_method/paid_at are reused.
-- ============================================================

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS mazon_stamped_pdf_url TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS mazon_queue_id UUID REFERENCES mazon_queue(id);

-- The invoices.status column has no CHECK constraint today (just a comment);
-- we're not adding one here because doing so risks locking legacy rows with
-- ad-hoc statuses. The app enforces the new values via its write paths.
