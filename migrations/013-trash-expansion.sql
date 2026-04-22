-- Migration 013: Expand trash/soft-delete to every table that was still hard-deleting.
-- Extends the pattern from 012 so NOTHING in the app is ever physically deleted again.

-- ─────────────────────────────────────────────
-- Add deleted_at to every table with a delete() call in appv2.html / riker-tools.js
-- ─────────────────────────────────────────────
ALTER TABLE extinguishers          ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE extinguisher_results   ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE suppression_systems    ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE suppression_results    ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE reports                ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE invoice_lines          ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE invoice_attachments    ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE todos                  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE location_contacts      ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- ─────────────────────────────────────────────
-- Partial indexes so "active only" filters stay fast
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_extinguishers_deleted_at        ON extinguishers        (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_extinguisher_results_deleted_at ON extinguisher_results (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_suppression_systems_deleted_at  ON suppression_systems  (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_suppression_results_deleted_at  ON suppression_results  (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reports_deleted_at              ON reports              (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_lines_deleted_at        ON invoice_lines        (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_attachments_deleted_at  ON invoice_attachments  (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_todos_deleted_at                ON todos                (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_location_contacts_deleted_at    ON location_contacts    (deleted_at) WHERE deleted_at IS NOT NULL;
