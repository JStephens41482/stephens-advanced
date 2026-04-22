// /api/riker-web.js
// Phase 4 of situational awareness: outside-the-building lookups.
//
// Three tools:
//   web_search_brave(query)   — Brave Search API (paid subscription)
//   web_fetch(url)            — Browserbase headless Chromium fetch for pages
//                               that need JS to render or aren't friendly to
//                               raw HTTP (most public sites these days)
//   get_weather(city, date?)  — OpenWeatherMap free tier
//
// All three pass through web_lookup_cache (migration 014) so repeat queries
// in the same window return instantly without re-billing the upstream API.

const crypto = require('crypto')

// ─── cache helpers ───
const CACHE_TTL = {
  search: 30 * 60 * 1000,          // 30 min — search results go stale fast
  fetch: 60 * 60 * 1000,           // 1 hour — static page content
  weather: 15 * 60 * 1000          // 15 min — forecast changes fast
}

function _keyFor(kind, payload) {
  // Stable hash. Normalize whitespace/case for search, exact-match for urls.
  const normalized = typeof payload === 'string'
    ? (kind === 'search' ? payload.toLowerCase().replace(/\s+/g, ' ').trim() : payload.trim())
    : JSON.stringify(payload)
  return kind + ':' + crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32)
}

async function _readCache(supabase, kind, payload) {
  try {
    const key = _keyFor(kind, payload)
    const { data } = await supabase.from('web_lookup_cache')
      .select('response, expires_at, source, created_at')
      .eq('query_key', key).maybeSingle()
    if (!data) return null
    if (new Date(data.expires_at).getTime() < Date.now()) return null
    return { fromCache: true, ...data.response, _cached_at: data.created_at, _source: data.source }
  } catch { return null }
}

async function _writeCache(supabase, kind, payload, response, source) {
  try {
    const key = _keyFor(kind, payload)
    const ttl = CACHE_TTL[kind] || 15 * 60 * 1000
    const expiresAt = new Date(Date.now() + ttl).toISOString()
    const queryText = typeof payload === 'string' ? payload : JSON.stringify(payload)
    // Upsert — repeat queries overwrite the stale row
    await supabase.from('web_lookup_cache').upsert({
      query_key: key,
      query_text: queryText.slice(0, 1000),
      kind,
      response,
      source,
      expires_at: expiresAt
    }, { onConflict: 'query_key' })
  } catch (e) { /* cache write never blocks the call */ }
}

// ───────────────────────────────────────────────
// BRAVE SEARCH
// ───────────────────────────────────────────────
async function braveSearch(supabase, query, { count = 6 } = {}) {
  const q = String(query || '').trim()
  if (!q) return { error: 'empty query' }
  const cached = await _readCache(supabase, 'search', q)
  if (cached) return cached

  const key = process.env.BRAVE_SEARCH_KEY || process.env.BRAVE_API_KEY
  if (!key) return { error: 'BRAVE_SEARCH_KEY not configured' }

  const url = 'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(q) + '&count=' + Math.min(20, Math.max(1, count))
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': key
      }
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      return { error: 'brave ' + res.status + ': ' + txt.slice(0, 200) }
    }
    const data = await res.json()
    const results = (data?.web?.results || []).slice(0, count).map(r => ({
      title: r.title,
      url: r.url,
      description: r.description,
      age: r.age || null,
      site: r.profile?.name || r.meta_url?.hostname || null
    }))
    const out = { query: q, count: results.length, results }
    await _writeCache(supabase, 'search', q, out, 'brave')
    return out
  } catch (e) {
    return { error: 'brave fetch failed: ' + e.message }
  }
}

// ───────────────────────────────────────────────
// BROWSERBASE FETCH
// Browserbase runs a real headless Chromium session. We open a page,
// wait for network idle, grab the rendered text + title, then close.
// ───────────────────────────────────────────────
async function browserbaseFetch(supabase, url, { maxChars = 8000 } = {}) {
  const u = String(url || '').trim()
  if (!/^https?:\/\//i.test(u)) return { error: 'Invalid URL (must be http/https)' }
  const cached = await _readCache(supabase, 'fetch', u)
  if (cached) return cached

  const key = process.env.BROWSERBASE_API_KEY
  const project = process.env.BROWSERBASE_PROJECT_ID
  if (!key || !project) return { error: 'BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID not configured' }

  // Browserbase's extract endpoint — give it a URL, get back text content.
  // Using the REST extract API keeps us from pulling in the full SDK.
  try {
    const res = await fetch('https://api.browserbase.com/v1/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BB-API-Key': key
      },
      body: JSON.stringify({
        projectId: project,
        url: u,
        waitFor: 'networkidle',
        extract: { text: true, title: true, links: false }
      })
    })
    if (!res.ok) {
      // Fallback to a plain fetch — some simple pages don't need JS
      try {
        const simple = await fetch(u, { headers: { 'User-Agent': 'RikerBot/1.0 (+https://stephensadvanced.com)' } })
        if (!simple.ok) return { error: 'browserbase ' + res.status + ' and plain fetch ' + simple.status }
        const html = await simple.text()
        const text = html.replace(/<script[\s\S]*?<\/script>/g, '')
          .replace(/<style[\s\S]*?<\/style>/g, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ').trim().slice(0, maxChars)
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
        const out = { url: u, title: titleMatch ? titleMatch[1].trim() : null, text, source: 'plain-fetch-fallback' }
        await _writeCache(supabase, 'fetch', u, out, 'plain')
        return out
      } catch (e) {
        return { error: 'browserbase + fallback failed: ' + e.message }
      }
    }
    const data = await res.json()
    const text = String(data?.text || data?.content || '').slice(0, maxChars)
    const title = data?.title || null
    const out = { url: u, title, text, source: 'browserbase' }
    await _writeCache(supabase, 'fetch', u, out, 'browserbase')
    return out
  } catch (e) {
    return { error: 'browserbase fetch failed: ' + e.message }
  }
}

// ───────────────────────────────────────────────
// OPENWEATHERMAP
// One call API: current + next 48h hourly + next 7d daily.
// Geocode via OWM's free geocoding endpoint first.
// ───────────────────────────────────────────────
async function openWeatherMap(supabase, city, { date = null, units = 'imperial' } = {}) {
  const c = String(city || '').trim()
  if (!c) return { error: 'city is required' }
  const cacheKey = { city: c.toLowerCase(), date: date || 'current', units }
  const cached = await _readCache(supabase, 'weather', cacheKey)
  if (cached) return cached

  const key = process.env.OPENWEATHERMAP_KEY || process.env.OWM_KEY
  if (!key) return { error: 'OPENWEATHERMAP_KEY not configured' }

  try {
    // Geocode
    const geoRes = await fetch(`https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(c)}&limit=1&appid=${key}`)
    if (!geoRes.ok) return { error: 'owm geocode ' + geoRes.status }
    const geo = await geoRes.json()
    if (!Array.isArray(geo) || !geo.length) return { error: `No geocode match for "${c}"` }
    const { lat, lon, name, state, country } = geo[0]

    // One Call 3.0 (requires subscription — free tier has 1000 calls/day)
    const ocRes = await fetch(`https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&units=${units}&appid=${key}&exclude=minutely,alerts`)
    if (!ocRes.ok) {
      // Fallback to 2.5 current weather — always works on free tier
      const curRes = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=${units}&appid=${key}`)
      if (!curRes.ok) return { error: 'owm current ' + curRes.status }
      const cur = await curRes.json()
      const out = {
        city: name, state: state || null, country,
        current: {
          temp_f: Math.round(cur.main?.temp),
          feels_like_f: Math.round(cur.main?.feels_like),
          humidity: cur.main?.humidity,
          wind_mph: Math.round(cur.wind?.speed || 0),
          condition: cur.weather?.[0]?.description || null
        },
        source: 'owm-2.5'
      }
      await _writeCache(supabase, 'weather', cacheKey, out, 'openweathermap')
      return out
    }
    const oc = await ocRes.json()

    // Pick the relevant day if a date was requested
    let dayBlock = null
    if (date) {
      const want = new Date(date).toISOString().split('T')[0]
      const day = (oc.daily || []).find(d => new Date(d.dt * 1000).toISOString().split('T')[0] === want)
      if (day) {
        dayBlock = {
          date: want,
          high_f: Math.round(day.temp?.max),
          low_f: Math.round(day.temp?.min),
          humidity: day.humidity,
          wind_mph: Math.round(day.wind_speed || 0),
          rain_chance: Math.round((day.pop || 0) * 100),
          condition: day.weather?.[0]?.description || null,
          summary: day.summary || null
        }
      }
    }
    const out = {
      city: name, state: state || null, country,
      current: {
        temp_f: Math.round(oc.current?.temp),
        feels_like_f: Math.round(oc.current?.feels_like),
        humidity: oc.current?.humidity,
        wind_mph: Math.round(oc.current?.wind_speed || 0),
        condition: oc.current?.weather?.[0]?.description || null
      },
      today: oc.daily?.[0] ? {
        high_f: Math.round(oc.daily[0].temp.max),
        low_f: Math.round(oc.daily[0].temp.min),
        rain_chance: Math.round((oc.daily[0].pop || 0) * 100),
        condition: oc.daily[0].weather?.[0]?.description || null
      } : null,
      requested_day: dayBlock,
      forecast_7d: (oc.daily || []).slice(0, 7).map(d => ({
        date: new Date(d.dt * 1000).toISOString().split('T')[0],
        high_f: Math.round(d.temp.max),
        low_f: Math.round(d.temp.min),
        rain_chance: Math.round((d.pop || 0) * 100),
        condition: d.weather?.[0]?.description || null
      })),
      source: 'owm-3.0'
    }
    await _writeCache(supabase, 'weather', cacheKey, out, 'openweathermap')
    return out
  } catch (e) {
    return { error: 'weather fetch failed: ' + e.message }
  }
}

module.exports = {
  braveSearch,
  browserbaseFetch,
  openWeatherMap,
  _keyFor,
  _readCache,
  _writeCache
}
