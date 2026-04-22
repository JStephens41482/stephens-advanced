-- Migration 015: "One Jon" — unified session thread across SMS + App
--
-- Phase 6a of situational awareness: Jon's SMS conversation with Riker and
-- his in-app chat with Riker are currently separate riker_sessions rows.
-- Text, then open the app, then text again = three sessions. Cross-session
-- linking only shows a summary of the others.
--
-- This migration adds a `principal` column. When principal is set (e.g.
-- 'jon'), ALL channels resolve to the same row. Messages from SMS and App
-- interleave into one continuous thread, tagged by channel in the message
-- metadata.
--
-- Jon is currently the only principal, but the column is open-ended — in
-- the future Mike / Brandon could each get their own.

ALTER TABLE riker_sessions ADD COLUMN IF NOT EXISTS principal text;

-- Expand the context CHECK to allow 'jon_unified' — the new context value
-- for Jon's single rolling thread. All existing values kept so nothing
-- breaks on in-flight rows.
ALTER TABLE riker_sessions DROP CONSTRAINT IF EXISTS riker_sessions_context_check;
ALTER TABLE riker_sessions ADD CONSTRAINT riker_sessions_context_check
  CHECK (context = ANY (ARRAY[
    'website', 'portal', 'app', 'sms', 'email',
    'sms_customer', 'sms_jon', 'email_customer', 'proactive',
    'jon_unified'
  ]));

-- Partial unique index: only ONE active row per principal can exist.
-- We keep the ability to have closed/archived principal rows around.
CREATE UNIQUE INDEX IF NOT EXISTS idx_riker_sessions_principal_active
  ON riker_sessions (principal)
  WHERE principal IS NOT NULL AND status = 'active';

-- One-time backfill: find Jon's most recent active sms_jon OR app session
-- and mark it principal='jon'. If multiple, pick the newest. Older Jon
-- sessions stay as-is (status='active' but principal NULL) — they'll still
-- show up in cross-session thread lookups. Going forward, all new Jon
-- traffic lands on the principal row.
DO $$
DECLARE
  jon_session_id uuid;
BEGIN
  SELECT id INTO jon_session_id
  FROM riker_sessions
  WHERE status = 'active'
    AND context IN ('sms_jon', 'app')
    AND principal IS NULL
  ORDER BY updated_at DESC
  LIMIT 1;

  IF jon_session_id IS NOT NULL THEN
    UPDATE riker_sessions
    SET principal = 'jon',
        context = 'jon_unified',
        updated_at = now()
    WHERE id = jon_session_id;
  END IF;
END $$;

-- Expand the context CHECK if one exists, otherwise no-op.
-- (Looking at existing migrations, context isn't CHECK-constrained.)

-- Speed up the "find by principal" lookup path even for closed rows.
CREATE INDEX IF NOT EXISTS idx_riker_sessions_principal
  ON riker_sessions (principal) WHERE principal IS NOT NULL;

-- Phase 6d prep: make sure audit_log queries stay fast even as the table grows.
-- Migration 014 already added idx_audit_log_actor_created + idx_audit_log_entity;
-- add a plain created_at index for the "last N rows regardless of actor" query
-- the Desk will run every turn.
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC);

-- Phase 6c prep: messages table is already indexed on created_at (migration 014).
-- No additional index needed for the verbatim activity feed.
