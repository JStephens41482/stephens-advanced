-- Migration 009: Riker feedback loop
-- When Jon replies 👍 or 👎 to a Riker SMS, we log the signal against the
-- interaction it refers to. A weekly cron reads recent negatives and
-- proposes prompt / behavior tweaks that Jon can approve.

CREATE TABLE IF NOT EXISTS riker_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interaction_id UUID REFERENCES riker_interactions(id) ON DELETE SET NULL,
  session_id UUID,
  context TEXT,
  rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
  note TEXT,
  user_message TEXT,
  assistant_reply TEXT,
  reviewed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_riker_feedback_created ON riker_feedback(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_riker_feedback_rating ON riker_feedback(rating, reviewed) WHERE reviewed = false;

ALTER TABLE riker_feedback ENABLE ROW LEVEL SECURITY;
