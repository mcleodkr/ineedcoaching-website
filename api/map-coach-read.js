// api/map-coach-read.js
//
// POST /api/map-coach-read — every Effectiveness Map this coach generated for one
// of their clients (Step 5, coach dashboard display). The coach's Supabase JWT is
// the authorization; the service-role read is scoped to coach_id, so a coach only
// ever sees Maps they generated (mirrors the emaps_coach_read RLS policy). Returns
// coach-only fields (raw_output, dominant pattern, per-domain evidence/confidence,
// prompt version) plus explorer_facing_output for the reading-order display.
//
// Reading already-generated Maps is NOT paywalled: it requires only that the coach
// exists, not an active subscription (only NEW generation gates on subscription).
//
// Body: { client_email }
// Returns: { ok:true, maps:[ {...} ] }  newest first  |  { ok:false, error }

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FAIL_MSG = 'Could not load the Effectiveness Map.';
// Conservative email shape + length bound. encodeURIComponent already blocks
// PostgREST filter injection; this rejects structurally invalid input up front.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 254; // RFC 5321 max
// Explorer-facing + coach-only columns. raw_output carries the per-domain
// evidence_strength / interpretation_confidence used by Intelligence Notes.
const SELECT_COLS = 'id,session_id,goal,phase,created_at,crisis_flag,dominant_pattern_label,overall_evidence_strength,prompt_version,raw_output,explorer_facing_output';

function sbHeaders() {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

// Resolve the caller's coach email from their Supabase JWT (never trusted from body).
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

// Look up the coach_profiles id by email. `ilike.` is used for case-insensitive
// matching (user_email casing isn't guaranteed), but ILIKE treats `%`/`_` as
// wildcards — so a coach whose email contained one could otherwise resolve to a
// DIFFERENT coach's row and read their Maps. Guard with a JS-level EXACT match on
// the lowercased email, so wildcard expansion can never pick a wrong row.
async function loadCoachId(coachEmail) {
  const url = `${SUPABASE_URL}/rest/v1/coach_profiles`
    + `?user_email=ilike.${encodeURIComponent(coachEmail)}`
    + `&select=id,user_email&limit=5`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => null);
  if (!Array.isArray(rows)) return null;
  const exact = rows.find((row) => row && row.user_email && String(row.user_email).toLowerCase() === coachEmail);
  return exact ? exact.id : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!SUPABASE_KEY) {
    console.error('[map-coach-read] server not configured');
    return res.status(500).json({ ok: false, error: FAIL_MSG });
  }

  try {
    // --- coach auth: the JWT is the authorization, email derived server-side ---
    const coachEmail = await deriveCoachEmail(req);
    if (!coachEmail) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    const coachId = await loadCoachId(coachEmail);
    if (!coachId) return res.status(403).json({ ok: false, error: 'ACCESS_DENIED' });

    // --- input ---
    const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
    const clientEmail = body && body.client_email ? String(body.client_email).trim().toLowerCase() : '';
    if (!clientEmail || clientEmail.length > EMAIL_MAX || !EMAIL_RE.test(clientEmail)) {
      return res.status(400).json({ ok: false, error: 'MISSING_CLIENT_EMAIL' });
    }

    // --- scoped read: Maps THIS coach generated for THIS client, coaching only,
    //     non-crisis (crisis rows carry no Map content), newest first.
    //     coach_id scoping is the security boundary; stored client_email is
    //     lowercased so eq. is an exact match (no LIKE-wildcard semantics).
    //     limit bounds the response (each raw_output blob is several KB). ---
    const url = `${SUPABASE_URL}/rest/v1/effectiveness_maps`
      + `?coach_id=eq.${encodeURIComponent(coachId)}`
      + `&client_email=eq.${encodeURIComponent(clientEmail)}`
      + `&product_context=eq.coaching`
      + `&crisis_flag=eq.false`
      + `&order=created_at.desc`
      + `&limit=50`
      + `&select=${SELECT_COLS}`;
    const r = await fetch(url, { headers: sbHeaders() });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[map-coach-read] read failed', r.status, t.slice(0, 200));
      return res.status(200).json({ ok: false, error: FAIL_MSG });
    }
    const maps = await r.json().catch(() => []);
    return res.status(200).json({ ok: true, maps: Array.isArray(maps) ? maps : [] });
  } catch (e) {
    console.error('[map-coach-read] error', e && e.message);
    return res.status(500).json({ ok: false, error: FAIL_MSG });
  }
}
