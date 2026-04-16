-- Migration 002: Contract Signing & Customer Billing
-- Adds fields needed for digital contract signing workflow,
-- customer scheduling preferences, and Square payment integration.
-- All ADD COLUMN statements use IF NOT EXISTS for idempotency.

-- ============================================================
-- LOCATIONS: scheduling preferences & language
-- ============================================================

-- Structured business hours per day of week.
-- Example: {"mon":{"open":"09:00","close":"17:00","closed":false}, ...}
ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS business_hours JSONB;

-- Free-text scheduling preference the customer provides,
-- e.g. "Tuesday mornings" or "Any weekday before 10am".
ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS preferred_service_time TEXT;

-- Preferred language for customer-facing communications.
-- 'en' (English) or 'es' (Spanish).
ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS preferred_language TEXT DEFAULT 'en';


-- ============================================================
-- BILLING_ACCOUNTS: Square payment & billing preferences
-- ============================================================

-- Whether a card is stored on file via Square.
ALTER TABLE billing_accounts
  ADD COLUMN IF NOT EXISTS card_on_file BOOLEAN DEFAULT FALSE;

-- Square customer ID linking this account to Square's customer directory.
ALTER TABLE billing_accounts
  ADD COLUMN IF NOT EXISTS square_customer_id TEXT;

-- Last 4 digits of the card on file (for display purposes).
ALTER TABLE billing_accounts
  ADD COLUMN IF NOT EXISTS card_last4 TEXT;

-- Card brand, e.g. 'VISA', 'MASTERCARD', 'AMEX', 'DISCOVER'.
ALTER TABLE billing_accounts
  ADD COLUMN IF NOT EXISTS card_brand TEXT;

-- How this customer prefers to be billed:
--   'auto_charge' = charge their card on file automatically
--   'billed_invoice' = send an invoice they pay manually
ALTER TABLE billing_accounts
  ADD COLUMN IF NOT EXISTS billing_election TEXT DEFAULT 'auto_charge';


-- ============================================================
-- CONTRACTS: signing workflow fields
-- ============================================================

-- Language the contract document was generated in ('en' or 'es').
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en';

-- Name of the person who signed (or will sign) the contract.
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS signer_name TEXT;

-- Title/role of the signer, e.g. 'Owner', 'Facilities Manager'.
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS signer_title TEXT;

-- Legal entity name the signer represents, if different from billing account.
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS signer_entity TEXT;

-- Billing election captured at signing time.
-- Mirrors billing_accounts.billing_election but locked to contract terms.
--   'auto_charge' or 'billed_invoice'
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS billing_election TEXT;

-- Timestamp when the contract signing invitation email was sent.
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

-- Unique token used in the signing URL.
-- Defaults to the contract's UUID id but can be a separate opaque token.
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS token TEXT;


-- ============================================================
-- VIEW: contract_customers
-- Convenience view joining active/sent/draft contracts with their
-- location and billing account for easy querying.
-- ============================================================

CREATE OR REPLACE VIEW contract_customers AS
SELECT
  l.id              AS location_id,
  l.name            AS location_name,
  l.address,
  l.city,
  l.business_hours,
  l.preferred_service_time,
  ba.id             AS billing_account_id,
  ba.name           AS billing_account_name,
  ba.card_on_file,
  ba.card_last4,
  ba.card_brand,
  ba.billing_election,
  c.id              AS contract_id,
  c.status          AS contract_status,
  c.signed,
  c.signed_at,
  c.frequency,
  c.services_included,
  c.annual_value
FROM contracts c
JOIN locations l ON c.location_id = l.id
LEFT JOIN billing_accounts ba ON c.billing_account_id = ba.id
WHERE c.status IN ('active', 'sent', 'draft');
