-- Migration 012: Trash table — nothing is ever truly deleted
-- Every hard-delete becomes a move to deleted_records.
-- deleted_at columns on locations and invoices enable soft-delete queries.

-- ─────────────────────────────────────────────
-- deleted_records: permanent audit log of all trashed rows
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deleted_records (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deleted_at   timestamptz NOT NULL DEFAULT now(),
  table_name   text NOT NULL,
  record_id    text NOT NULL,
  record_data  jsonb NOT NULL,
  deleted_by   text NOT NULL,          -- 'jon', 'riker', 'cron', 'system', etc.
  reason       text,                   -- required for bot actors
  context      text                    -- sms_jon, app, website, cron, ...
);

ALTER TABLE deleted_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_deleted_records" ON deleted_records FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_deleted_records_table ON deleted_records (table_name, deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_deleted_records_record ON deleted_records (table_name, record_id);

-- ─────────────────────────────────────────────
-- locations: add deleted_at for soft-delete
-- ─────────────────────────────────────────────
ALTER TABLE locations ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_locations_deleted_at ON locations (deleted_at) WHERE deleted_at IS NOT NULL;

-- ─────────────────────────────────────────────
-- invoices: add deleted_at for soft-delete
-- ─────────────────────────────────────────────
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_invoices_deleted_at ON invoices (deleted_at) WHERE deleted_at IS NOT NULL;

-- ─────────────────────────────────────────────
-- jobs: add deleted_at for cascade soft-delete from delete_client
-- ─────────────────────────────────────────────
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_jobs_deleted_at ON jobs (deleted_at) WHERE deleted_at IS NOT NULL;
