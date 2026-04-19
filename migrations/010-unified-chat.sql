-- 010-unified-chat.sql
-- Supports the unified website-chat + SMS bot architecture.
-- Two new tables:
--   admin_otps     — Jon can authenticate as admin via SMS keyword → OTP flow
--   chat_escalations — tracks when the website bot escalated to Jon, allows
--                      Jon to reply via SMS with "RELAY: [answer]" and have
--                      the reply appear in the customer's website chat session

-- ── Admin OTP ─────────────────────────────────────────────────────────────
create table if not exists admin_otps (
  id          uuid        primary key default gen_random_uuid(),
  phone       text        not null,
  code        text        not null,
  used        boolean     not null default false,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_admin_otps_lookup
  on admin_otps(phone, code, used, expires_at);

-- ── Website chat escalations ───────────────────────────────────────────────
create table if not exists chat_escalations (
  id               uuid        primary key default gen_random_uuid(),
  web_session_id   uuid        not null references riker_sessions(id) on delete cascade,
  customer_name    text,
  question         text        not null,
  jon_notified_at  timestamptz not null default now(),
  jon_replied_at   timestamptz,
  jon_reply        text,
  resolved         boolean     not null default false,
  created_at       timestamptz not null default now()
);

create index if not exists idx_chat_escalations_session
  on chat_escalations(web_session_id);

-- For quick lookup of open escalations when Jon's SMS comes in
create index if not exists idx_chat_escalations_open
  on chat_escalations(resolved, created_at desc)
  where not resolved;
