-- Migration 007: Re-point Riker tech_id FKs from `technicians` to `techs`
-- Root cause per Data via Worf's log pull: riker_sessions inserts are
-- failing with Postgres 23503 (foreign key violation) on
-- riker_sessions_tech_id_fkey because the client sends tech_id values from
-- the `techs` table (the authoritative table the app reads and writes),
-- but migration 004 defined the FK as REFERENCES technicians(id).
-- `technicians` is a schema-level orphan — no code ever reads from it or
-- writes to it. `techs` is the live table.
--
-- This migration drops the two bad FKs and re-adds them pointing at techs.

-- riker_sessions.tech_id
ALTER TABLE riker_sessions DROP CONSTRAINT IF EXISTS riker_sessions_tech_id_fkey;
ALTER TABLE riker_sessions
  ADD CONSTRAINT riker_sessions_tech_id_fkey
  FOREIGN KEY (tech_id) REFERENCES techs(id) ON DELETE CASCADE;

-- riker_memory.tech_id
ALTER TABLE riker_memory DROP CONSTRAINT IF EXISTS riker_memory_tech_id_fkey;
ALTER TABLE riker_memory
  ADD CONSTRAINT riker_memory_tech_id_fkey
  FOREIGN KEY (tech_id) REFERENCES techs(id) ON DELETE CASCADE;
