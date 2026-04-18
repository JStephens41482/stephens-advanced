-- Migration 006: Expand riker_sessions.context CHECK constraint
-- Root cause of Data's observed `[riker-core] upsertRikerSession insert failed`:
-- migration 004 defined the CHECK as ('website','portal','app','sms','email'),
-- but riker-core.upsertRikerSessionForChannel passes the full context values
-- 'sms_customer', 'sms_jon', 'email_customer' that the rest of the codebase
-- uses. Every insert with those values silently failed the CHECK, leaving
-- riker_sessions empty for SMS/email and causing downstream NULL dereferences.

ALTER TABLE riker_sessions DROP CONSTRAINT IF EXISTS riker_sessions_context_check;

ALTER TABLE riker_sessions
  ADD CONSTRAINT riker_sessions_context_check
  CHECK (context IN (
    'website',
    'portal',
    'app',
    'sms',              -- legacy, kept for compat with any rows created pre-006
    'email',            -- legacy, kept for compat
    'sms_customer',
    'sms_jon',
    'email_customer',
    'proactive'         -- cron-authored sessions (morning brief, aging reminders, compliance alerts)
  ));
