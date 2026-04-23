-- 017-email-monitor.sql
-- Tracks emails processed by Jon's inbox monitor.
-- Separate from processed_emails (which is for customer emails labeled "Riker").

CREATE TABLE IF NOT EXISTS jon_inbox_processed (
  gmail_message_id  TEXT PRIMARY KEY,
  processed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  from_email        TEXT,
  from_name         TEXT,
  subject           TEXT,
  classified_as     TEXT NOT NULL CHECK (classified_as IN ('important', 'ignorable')),
  reason            TEXT,
  alerted_jon       BOOLEAN NOT NULL DEFAULT FALSE,
  email_date        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jon_inbox_processed_at
  ON jon_inbox_processed (processed_at DESC);

CREATE INDEX IF NOT EXISTS idx_jon_inbox_processed_from
  ON jon_inbox_processed (from_email, classified_as);
