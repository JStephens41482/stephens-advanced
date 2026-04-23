-- Migration 016: pgvector semantic memory dedup
--
-- Problem: Levenshtein at 0.85 threshold couldn't catch paraphrased standing
-- orders. E.g. the $125 trip charge rule was stored 3× because "trip charge
-- is $125" vs "charge customers $125 for trips" are character-different but
-- semantically identical. Result: memory table grew noisy, Jon had to clean
-- up duplicates by hand.
--
-- Solution: pgvector cosine similarity. Generate an embedding on every
-- write, compare to recent entries in the same scope/category, treat >= 0.88
-- similarity (<= 0.12 cosine distance) as a semantic match (UPDATE instead
-- of INSERT).
--
-- Column dim = 1024 works for both embedding providers we support:
--   - Voyage voyage-3 (native 1024; voyage-3-lite is 512-dim so we don't use it)
--   - OpenAI text-embedding-3-small (reduced from 1536 via `dimensions: 1024`)
--
-- Existing rows get their embedding backfilled lazily by riker-memory.js on
-- next read OR by scripts/backfill-memory-embeddings.js. Not required for
-- the migration to succeed.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE riker_memory ADD COLUMN IF NOT EXISTS embedding vector(1024);
ALTER TABLE riker_memory ADD COLUMN IF NOT EXISTS embedding_model text;

-- ivfflat works well for our scale (hundreds to low-thousands of rows).
-- lists=100 is a sensible default; tune once we cross 10k rows.
-- Partial index skips archived rows — same pattern as the other memory indexes.
CREATE INDEX IF NOT EXISTS idx_riker_memory_embedding_cosine
  ON riker_memory USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100)
  WHERE NOT archived AND embedding IS NOT NULL;

-- RPC helper: find the closest non-archived memory to a candidate embedding
-- in a given scope/category/location scope, above a similarity threshold.
-- Returns the row with cosine distance (0 = identical, 1 = orthogonal).
CREATE OR REPLACE FUNCTION match_memory_candidates(
  query_embedding vector(1024),
  p_scope text,
  p_category text,
  p_location_id uuid DEFAULT NULL,
  p_threshold float DEFAULT 0.12,  -- cosine distance; 0.12 ≈ 0.88 similarity
  p_match_count int DEFAULT 5
)
RETURNS TABLE (
  id uuid,
  content text,
  priority int,
  distance float
)
LANGUAGE sql STABLE AS $$
  SELECT m.id, m.content, m.priority,
    (m.embedding <=> query_embedding) AS distance
  FROM riker_memory m
  WHERE NOT m.archived
    AND m.scope = p_scope
    AND m.category = p_category
    AND m.embedding IS NOT NULL
    AND (p_location_id IS NULL OR m.location_id = p_location_id)
    AND (m.embedding <=> query_embedding) <= p_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT p_match_count;
$$;
