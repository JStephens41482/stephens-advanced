// /api/auth-sms.js
// SMS-link sign-in for the field app. Replaces the shared PIN with a
// phone-tied flow: request a 6-digit code, verify to mint a 30-day
// device cookie. Biometric/passkey binding will layer on top later.
//
// Actions (via ?action= or body.action):
//   request  { phone }                 -> sends code via Twilio
//   verify   { phone, code, label? }   -> sets sa_device cookie (30d)
//   check    (reads sa_device cookie)  -> { ok, phone, expires_at }
//   logout   (reads sa_device cookie)  -> revokes current device
//
// Allow-list: only phones in AUTH_ALLOWED_PHONES (env) can receive codes.
// Defaults to Jon's number so solo operation works out of the box.

const { createClient } = require('@supabase/supabase-js')
const crypto = require('crypto')

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://motjasdokoxwiodwzyps.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const SB = SB_KEY ? createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null

const JON_PHONE = '+12149944799'
const ALLOWED = (process.env.AUTH_ALLOWED_PHONES || JON_PHONE)
  .split(',').map(s => s.trim()).filter(Boolean)

const CODE_TTL_MIN = 10
const DEVICE_TTL_DAYS = 30
const MAX_CODE_ATTEMPTS = 5
const CODE_REQUEST_COOLDOWN_SEC = 45

function normalizePhone(raw) {
  if (!raw) return null
  let p = String(raw).replace(/[\s\-().]/g, '')
  if (!p.startsWith('+')) p = '+1' + p.replace(/^1/, '')
  if (!/^\+\d{10,15}$/.test(p)) return null
  return p
}

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex') }
function randomDigits(n) {
  const max = 10 ** n
  return crypto.randomInt(0, max).toString().padStart(n, '0')
}
function randomToken() {
  return crypto.randomBytes(32).toString('base64url')
}

function parseCookie(header, name) {
  if (!header) return null
  const m = header.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'))
  return m ? decodeURIComponent(m[1]) : null
}

function setDeviceCookie(res, token, maxAgeSec) {
  const parts = [
    `sa_device=${token}`,
    'Path=/',
    `Max-Age=${maxAgeSec}`,
    'HttpOnly',
    'SameSite=Lax',
    'Secure'
  ]
  res.setHeader('Set-Cookie', parts.join('; '))
}

function clearDeviceCookie(res) {
  res.setHeader('Set-Cookie', 'sa_device=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure')
}

function deviceLabelFromUA(ua) {
  if (!ua) return null
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android'
  if (/Mac OS X/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows'
  return null
}

async function sendSMSDirect(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_PHONE_NUMBER
  if (!sid || !token || !from) throw new Error('Twilio not configured')
  const auth = Buffer.from(sid + ':' + token).toString('base64')
  const params = new URLSearchParams({ To: to, From: from, Body: body })
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  })
  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    throw new Error(err.message || 'SMS send failed')
  }
}

async function handleRequest(req, res) {
  const phone = normalizePhone(req.body?.phone)
  if (!phone) return res.status(400).json({ error: 'Invalid phone number' })
  if (!ALLOWED.includes(phone)) {
    // Don't leak whether the number is allow-listed; pretend it worked.
    return res.status(200).json({ ok: true, cooldown_seconds: CODE_REQUEST_COOLDOWN_SEC })
  }

  // Cooldown: refuse if a code was issued in the last N seconds.
  const cutoff = new Date(Date.now() - CODE_REQUEST_COOLDOWN_SEC * 1000).toISOString()
  const { data: recent } = await SB
    .from('auth_codes')
    .select('created_at')
    .eq('phone', phone)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(1)
  if (recent && recent.length) {
    return res.status(429).json({ error: 'Please wait before requesting another code', cooldown_seconds: CODE_REQUEST_COOLDOWN_SEC })
  }

  const code = randomDigits(6)
  const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60 * 1000).toISOString()

  const { error: insErr } = await SB.from('auth_codes').insert({
    phone,
    code_hash: sha256(code),
    expires_at: expiresAt
  })
  if (insErr) {
    console.error('auth-sms insert code:', insErr)
    return res.status(500).json({ error: 'Could not issue code' })
  }

  try {
    await sendSMSDirect(phone, `Stephens Advanced sign-in code: ${code}\n(Valid ${CODE_TTL_MIN} min. Don't share.)`)
  } catch (e) {
    console.error('auth-sms twilio send:', e)
    return res.status(500).json({ error: 'SMS send failed' })
  }

  return res.status(200).json({ ok: true, cooldown_seconds: CODE_REQUEST_COOLDOWN_SEC })
}

async function handleVerify(req, res) {
  const phone = normalizePhone(req.body?.phone)
  const code = String(req.body?.code || '').replace(/\D/g, '')
  const label = (req.body?.label || deviceLabelFromUA(req.headers['user-agent']) || '').slice(0, 40) || null
  if (!phone || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Invalid phone or code' })
  if (!ALLOWED.includes(phone)) return res.status(400).json({ error: 'Code incorrect or expired' })

  const { data: rows } = await SB
    .from('auth_codes')
    .select('id, code_hash, attempts, used, expires_at')
    .eq('phone', phone)
    .eq('used', false)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)

  const row = rows && rows[0]
  if (!row) return res.status(400).json({ error: 'Code incorrect or expired' })

  if (row.attempts >= MAX_CODE_ATTEMPTS) {
    await SB.from('auth_codes').update({ used: true }).eq('id', row.id)
    return res.status(400).json({ error: 'Too many attempts — request a new code' })
  }

  if (sha256(code) !== row.code_hash) {
    await SB.from('auth_codes').update({ attempts: row.attempts + 1 }).eq('id', row.id)
    return res.status(400).json({ error: 'Code incorrect or expired' })
  }

  // Success: burn the code, mint a device token.
  await SB.from('auth_codes').update({ used: true }).eq('id', row.id)

  // Resolve which tech this phone belongs to. Multi-tech support: the
  // techs table stores phone in E.164, matching what normalizePhone()
  // produces above. If no tech matches, we still mint the cookie (so
  // the legacy phone-only path keeps working) but tech_id is null.
  // The client will treat null-tech as "not in roster yet — read only".
  let resolvedTechId = null
  try {
    const { data: techRow } = await SB
      .from('techs')
      .select('id')
      .eq('phone', phone)
      .eq('active', true)
      .maybeSingle()
    if (techRow?.id) resolvedTechId = techRow.id
  } catch (e) {
    console.error('auth-sms tech lookup:', e)
  }

  const token = randomToken()
  const tokenHash = sha256(token)
  const expiresAt = new Date(Date.now() + DEVICE_TTL_DAYS * 86400 * 1000).toISOString()

  const { error: devErr } = await SB.from('auth_devices').insert({
    phone,
    tech_id: resolvedTechId,
    token_hash: tokenHash,
    label,
    user_agent: (req.headers['user-agent'] || '').slice(0, 300),
    expires_at: expiresAt
  })
  if (devErr) {
    console.error('auth-sms insert device:', devErr)
    return res.status(500).json({ error: 'Could not issue device token' })
  }

  setDeviceCookie(res, token, DEVICE_TTL_DAYS * 86400)
  return res.status(200).json({ ok: true, phone, expires_at: expiresAt, tech_id: resolvedTechId })
}

async function handleCheck(req, res) {
  const token = parseCookie(req.headers.cookie, 'sa_device')
  if (!token) return res.status(200).json({ ok: false })

  const { data: rows } = await SB
    .from('auth_devices')
    .select('id, phone, tech_id, expires_at, revoked_at')
    .eq('token_hash', sha256(token))
    .limit(1)

  const row = rows && rows[0]
  if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) {
    clearDeviceCookie(res)
    return res.status(200).json({ ok: false })
  }

  // Touch last_seen_at so we can prune stale devices later.
  SB.from('auth_devices').update({ last_seen_at: new Date().toISOString() }).eq('id', row.id).then(() => {}).catch(() => {})

  // Multi-tech: also resolve the tech row so the client knows who it is
  // and what role it has, in a single round-trip. If tech_id wasn't set
  // when the device was minted (legacy device, or tech added later),
  // fall back to a phone lookup and patch the device row so future
  // checks are cheap.
  let tech = null
  let techIdForCookie = row.tech_id
  if (techIdForCookie) {
    const { data: t } = await SB
      .from('techs')
      .select('id, name, phone, email, license_number, color, active, is_owner')
      .eq('id', techIdForCookie)
      .maybeSingle()
    if (t) tech = t
  }
  if (!tech && row.phone) {
    const { data: t } = await SB
      .from('techs')
      .select('id, name, phone, email, license_number, color, active, is_owner')
      .eq('phone', row.phone)
      .eq('active', true)
      .maybeSingle()
    if (t) {
      tech = t
      // Backfill the device row for future check() calls.
      SB.from('auth_devices').update({ tech_id: t.id }).eq('id', row.id).then(() => {}).catch(() => {})
    }
  }

  return res.status(200).json({
    ok: true,
    phone: row.phone,
    expires_at: row.expires_at,
    tech: tech || null
  })
}

async function handleLogout(req, res) {
  const token = parseCookie(req.headers.cookie, 'sa_device')
  if (token) {
    await SB.from('auth_devices').update({ revoked_at: new Date().toISOString() }).eq('token_hash', sha256(token))
  }
  clearDeviceCookie(res)
  return res.status(200).json({ ok: true })
}

module.exports = async function handler(req, res) {
  if (!SB) {
    console.error('auth-sms: no Supabase service key in env')
    return res.status(500).json({ error: 'Server auth not configured (no service key)' })
  }
  const action = (req.query?.action || req.body?.action || '').toString()
  try {
    if (req.method === 'GET' && action === 'check') return handleCheck(req, res)
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    if (action === 'request') return handleRequest(req, res)
    if (action === 'verify') return handleVerify(req, res)
    if (action === 'logout') return handleLogout(req, res)
    if (action === 'check') return handleCheck(req, res)
    return res.status(400).json({ error: 'Unknown action' })
  } catch (err) {
    console.error('auth-sms fatal:', err)
    return res.status(500).json({ error: err.message || 'Server error' })
  }
}
