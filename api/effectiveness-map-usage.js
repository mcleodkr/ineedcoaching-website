// api/effectiveness-map-usage.js
//
// GET /api/effectiveness-map-usage — coach-facing Effectiveness Map usage counter.
// The coach's Supabase JWT is the authorization; no body. Returns the coach's tier,
// their monthly Map limit, Maps generated this calendar month, and remaining — read
// through lib/effmap-limits.js, the SAME source the generate/assign gates enforce,
// so the displayed counter can never drift from what's actually allowed.
//
//   Authorization: Bearer <coach JWT>   (required)
//   200 { ok:true, tier, subscription_status, limit, used, remaining, at_limit, count_unavailable }
//   401 { ok:false, code:'UNAUTHORIZED' }   ·   403 { ok:false, code:'ACCESS_DENIED' }
//
// Crisis Maps never count (the shared monthlyMapCount filters crisis_flag=false).
// `used`/`remaining` are null when the count can't be determined (telemetry glitch);
// the gates fail open in that case, so the UI treats null as "no number to show".

import { limitForTier, monthlyMapCount } from '../lib/effmap-limits.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sbHeaders(extra) {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'content-type': 'application/json', ...(extra || {}) };
}

// Caller (coach) email from the verified JWT — never from the body.
async function deriveCoachEmail(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const u = await r.json().catch(() => null);
    const email = u && u.email ? String(u.email).trim().toLowerCase() : '';
    return email || null;
  } catch {
    return null;
  }
}

async function loadCoach(coachEmail) {
  const url = `${SUPABASE_URL}/rest/v1/coach_profiles`
    + `?user_email=ilike.${encodeURIComponent(coachEmail)}`
    + `&select=id,subscription_status,subscription_tier&limit=1`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => null);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!SUPABASE_KEY) return res.status(500).json({ ok: false, error: 'Server not configured' });

  const coachEmail = await deriveCoachEmail(req);
  if (!coachEmail) return res.status(401).json({ ok: false, error: 'Please sign in again.', code: 'UNAUTHORIZED' });

  const coach = await loadCoach(coachEmail);
  if (!coach) return res.status(403).json({ ok: false, error: 'Coach profile not found.', code: 'ACCESS_DENIED' });

  const tier = coach.subscription_tier ? String(coach.subscription_tier).toLowerCase() : null;
  const limit = limitForTier(tier);
  const count = await monthlyMapCount(coach.id, SUPABASE_URL, SUPABASE_KEY);
  const used = count === null ? null : count;
  const remaining = count === null ? null : Math.max(0, limit - count);

  return res.status(200).json({
    ok: true,
    tier,
    subscription_status: coach.subscription_status || null,
    limit,
    used,
    remaining,
    at_limit: count !== null && count >= limit,
    count_unavailable: count === null,
  });
}
