// /api/riker-embeddings.js
// Text → vector embeddings for semantic memory dedup and retrieval.
//
// Provider-agnostic: prefer Voyage if VOYAGE_API_KEY is set (Anthropic's
// recommended embedding partner), fall back to OpenAI if OPENAI_API_KEY is
// set. If neither is set the module returns null for every call and callers
// (riker-memory.js) gracefully fall back to the old Levenshtein dedup path.
//
// Both providers produce 1024-dimension vectors so the riker_memory.embedding
// column schema is provider-stable:
//   - voyage-3-lite: native 1024
//   - text-embedding-3-small: reduced from 1536 via `dimensions: 1024` param
//
// Cost at 75 existing rows + ~20 writes/day:
//   ≈ 50k tokens/month × $0.02/M = $0.001/month. Effectively free.

const VOYAGE_MODEL = 'voyage-3-lite'
const OPENAI_MODEL = 'text-embedding-3-small'
const EMBEDDING_DIM = 1024

function resolveProvider() {
  if (process.env.VOYAGE_API_KEY) return 'voyage'
  if (process.env.OPENAI_API_KEY) return 'openai'
  return null
}

/**
 * Generate a single embedding. Returns { vector: number[1024], model: string }
 * or null if no provider is configured / the call failed. Callers must
 * tolerate null (fall through to Levenshtein).
 */
async function embedText(text) {
  const provider = resolveProvider()
  if (!provider) return null
  const input = String(text || '').slice(0, 8000).trim()  // both providers cap around 8k tokens
  if (!input) return null

  try {
    if (provider === 'voyage') return await embedViaVoyage(input)
    return await embedViaOpenAI(input)
  } catch (e) {
    console.error('[riker-embeddings] embedText error:', e.message)
    return null
  }
}

async function embedViaVoyage(input) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input,
      input_type: 'document'
    })
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`voyage ${res.status}: ${err.slice(0, 200)}`)
  }
  const data = await res.json()
  const vec = data?.data?.[0]?.embedding
  if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) {
    throw new Error(`voyage returned bad shape: ${vec?.length}`)
  }
  return { vector: vec, model: VOYAGE_MODEL }
}

async function embedViaOpenAI(input) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input,
      dimensions: EMBEDDING_DIM
    })
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`openai ${res.status}: ${err.slice(0, 200)}`)
  }
  const data = await res.json()
  const vec = data?.data?.[0]?.embedding
  if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) {
    throw new Error(`openai returned bad shape: ${vec?.length}`)
  }
  return { vector: vec, model: OPENAI_MODEL }
}

/**
 * Format a JS array into pgvector's string wire format: "[0.1,0.2,...]".
 * Supabase client sends this as-is and PG casts it to vector(1024).
 */
function toPgVector(arr) {
  if (!Array.isArray(arr)) return null
  return '[' + arr.map(n => Number(n).toFixed(6)).join(',') + ']'
}

function isAvailable() {
  return !!resolveProvider()
}

module.exports = {
  embedText,
  toPgVector,
  isAvailable,
  resolveProvider,
  EMBEDDING_DIM
}
