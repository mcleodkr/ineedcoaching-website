// POST /api/map-intake-submit — generate the Effectiveness Map on intake submit
// (brief v1.1, Step 3). The signed MAP_LINK_SECRET token is the authorization;
// the explorer never authenticates. Option A bridge: mint a short-lived COACH
// session server-side (Supabase admin generate_link + verify) and POST to the
// live, UNTOUCHED api/generate-effectiveness-map as that coach — so the edge
// function sees the coach as caller and runs its own three gates.
//
// Single-use: one Map per link. On success the assignment flips to 'completed'
// and the draft is deleted; a completed link short-circuits.
//
// SECURITY: this endpoint can briefly act AS the coach. Service-role-only, gated
// on a valid HMAC token, and it never logs the minted access token, the
// hashed_token/OTP, or the explorer's answers. Run security-reviewer before merge.
//
// Body: { token }   (answers are read server-side from the draft — not trusted from the body)
// Returns:
//   { ok:true,  status:'completed' }         Map generated/stored (or reused)
//   { ok:true,  status:'crisis' }            crisis language — show safety resources
//   { ok:false, incomplete:true, screen:N }  intake unfinished — bounce to screen N
//   { ok:false, error:'<friendly>' }         generation failed — link still usable for retry

import { verifyMapLink } from '../lib/effmap-core/map-link.js';

const ANSWER_KEYS = [
  'physical_1', 'physical_2',
  'intellectual_1', 'intellectual_2',
  'psychological_1', 'psychological_2',
  'environmental_1', 'environmental_2',
  'social_1', 'social_2',
];

// First-blank bounce: draft screen index per domain (matches map/intake.html).
const DOMAIN_SCREENS = [
  { screen: 1, keys: ['physical_1', 'physical_2'] },
  { screen: 2, keys: ['intellectual_1', 'intellectual_2'] },
  { screen: 3, keys: ['psychological_1', 'psychological_2'] },
  { screen: 4, keys: ['environmental_1', 'environmental_2'] },
  { screen: 5, keys: ['social_1', 'social_2'] },
];

const FAIL_MSG = 'Something went wrong. Your answers have been saved — try again or ask your coach to resend the link.';
const INACTIVE_MSG = 'This link is no longer active. Ask your coach to send a new one.';

// Pinned origin for the internal edge-function call and for CORS. NEVER derive
// the self-call target from req.headers.host: that header is attacker-controllable,
// and the call carries the minted coach JWT + VERCEL_AUTOMATION_BYPASS_SECRET, so a
// spoofed Host would be a credential-exfiltration SSRF. Hardcoded prod domain
// (house convention — see CLAUDE.md), overridable via SITE_URL. Use the canonical
// www host: the apex 308-redirects to www, and fetch drops the Authorization
// bearer across that host change → the coach JWT is lost and gen returns 401.
const SITE_ORIGIN = process.env.SITE_URL || 'https://www.ineedcoaching.org';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', SITE_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: FAIL_MSG });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY || !process.env.MAP_LINK_SECRET) {
    console.error('[map-intake-submit] server not configured');
    return res.status(500).json({ ok: false, error: FAIL_MSG });
  }

  const SB_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
  const READ_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const decoded = verifyMapLink(body.token);
    if (!decoded) return res.status(200).json({ ok: false, error: INACTIVE_MSG });
    const { coachId, clientEmail, sessionId } = decoded;

    // --- assignment: single-use + liveness ---
    const aRes = await fetch(
      `${SUPABASE_URL}/rest/v1/effectiveness_map_assignments?session_id=eq.${encodeURIComponent(sessionId)}&select=status,expires_at&limit=1`,
      { headers: READ_HEADERS }
    );
    const assignment = (await aRes.json().catch(() => []))[0] || null;
    if (!assignment) return res.status(200).json({ ok: false, error: INACTIVE_MSG });
    if (assignment.status === 'completed') {
      return res.status(200).json({ ok: true, status: 'completed' }); // single-use: Map already exists
    }
    const expMs = new Date(assignment.expires_at).getTime();
    if (assignment.status === 'expired' || (Number.isFinite(expMs) && Date.now() > expMs)) {
      return res.status(200).json({ ok: false, error: INACTIVE_MSG });
    }

    // --- authoritative answers from the draft; require completeness (D3) ---
    const dRes = await fetch(
      `${SUPABASE_URL}/rest/v1/effectiveness_map_drafts?session_id=eq.${encodeURIComponent(sessionId)}&select=answers&limit=1`,
      { headers: READ_HEADERS }
    );
    const draft = (await dRes.json().catch(() => []))[0] || null;
    const answers = (draft && draft.answers && typeof draft.answers === 'object') ? draft.answers : {};
    const filled = (k) => answers[k] != null && String(answers[k]).trim() !== '';

    if (!filled('goal') || !filled('phase')) {
      return res.status(200).json({ ok: false, incomplete: true, screen: 0 });
    }
    for (const d of DOMAIN_SCREENS) {
      if (d.keys.some((k) => !filled(k))) {
        return res.status(200).json({ ok: false, incomplete: true, screen: d.screen });
      }
    }

    // --- resolve the coach (Map is generated AS the coach) ---
    const cRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${encodeURIComponent(coachId)}&select=user_email&limit=1`,
      { headers: READ_HEADERS }
    );
    const coach = (await cRes.json().catch(() => []))[0] || null;
    if (!coach || !coach.user_email) {
      console.error('[map-intake-submit] coach not found for assignment');
      return res.status(200).json({ ok: false, error: FAIL_MSG });
    }

    // --- Option A: mint a short-lived coach session (never logged) ---
    const coachJwt = await mintCoachSession(SUPABASE_URL, SB_HEADERS, coach.user_email);
    if (!coachJwt) return res.status(200).json({ ok: false, error: FAIL_MSG });

    // --- POST to the live edge function AS the coach (edge fn untouched) ---
    // Target is the pinned SITE_ORIGIN, never req.headers.host (SSRF — see above).
    const base = SITE_ORIGIN;
    const genHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${coachJwt}` };
    if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
      genHeaders['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
      genHeaders['x-vercel-set-bypass-cookie'] = 'false';
    }

    let gen, genBody;
    try {
      gen = await fetch(`${base}/api/generate-effectiveness-map`, {
        method: 'POST',
        redirect: 'error', // never follow a redirect: a cross-host hop (apex→www) strips the bearer → silent 401. Fail loud; the catch below keeps the link usable.
        headers: genHeaders,
        body: JSON.stringify({
          goal: String(answers.goal),
          phase: String(answers.phase),
          client_email: clientEmail,
          session_id: sessionId,
          product_context: 'coaching',
          answers: pickAnswers(answers),
        }),
      });
      genBody = await gen.json().catch(() => ({}));
    } catch (e) {
      console.error('[map-intake-submit] edge call threw', e && e.message);
      return res.status(200).json({ ok: false, error: FAIL_MSG });
    }

    const success = gen.ok && genBody && genBody.status === 'ok';
    const crisis = gen.ok && genBody && genBody.crisis_flag === true;
    if (!success && !crisis) {
      console.error('[map-intake-submit] generation not ok', gen.status, genBody && (genBody.error || genBody.error_code));
      return res.status(200).json({ ok: false, error: FAIL_MSG }); // link stays usable for retry
    }

    // --- single-use: consume the link, drop the draft ---
    await markCompleted(SUPABASE_URL, SB_HEADERS, sessionId);
    await deleteDraft(SUPABASE_URL, SB_HEADERS, sessionId);

    return res.status(200).json({ ok: true, status: crisis ? 'crisis' : 'completed' });
  } catch (e) {
    console.error('[map-intake-submit] error', e && e.message);
    return res.status(500).json({ ok: false, error: FAIL_MSG });
  }
}

function pickAnswers(answers) {
  const out = {};
  for (const k of ANSWER_KEYS) out[k] = String(answers[k]);
  return out;
}

// Mint a short-lived coach access token: admin generate_link -> verify.
// Returns the access_token, or null. Never logs the token, hash, or OTP.
async function mintCoachSession(supabaseUrl, sbHeaders, coachEmail) {
  try {
    const gl = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify({ type: 'magiclink', email: coachEmail }),
    });
    if (!gl.ok) { console.error('[map-intake-submit] generate_link failed', gl.status); return null; }
    const glBody = await gl.json().catch(() => ({}));
    const tokenHash = glBody.hashed_token || (glBody.properties && glBody.properties.hashed_token);
    const vType = glBody.verification_type || (glBody.properties && glBody.properties.verification_type) || 'magiclink';
    if (!tokenHash) { console.error('[map-intake-submit] generate_link returned no hashed_token'); return null; }

    const vr = await fetch(`${supabaseUrl}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: sbHeaders.apikey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: vType, token_hash: tokenHash }),
    });
    if (!vr.ok) { console.error('[map-intake-submit] verify failed', vr.status); return null; }
    const vrBody = await vr.json().catch(() => ({}));
    return vrBody.access_token || null;
  } catch (e) {
    console.error('[map-intake-submit] mint threw', e && e.message);
    return null;
  }
}

async function markCompleted(supabaseUrl, sbHeaders, sessionId) {
  try {
    await fetch(`${supabaseUrl}/rest/v1/effectiveness_map_assignments?session_id=eq.${encodeURIComponent(sessionId)}`, {
      method: 'PATCH', headers: sbHeaders,
      body: JSON.stringify({ status: 'completed', completed_at: new Date().toISOString() }),
    });
  } catch (e) { console.error('[map-intake-submit] markCompleted threw', e && e.message); }
}

async function deleteDraft(supabaseUrl, sbHeaders, sessionId) {
  try {
    await fetch(`${supabaseUrl}/rest/v1/effectiveness_map_drafts?session_id=eq.${encodeURIComponent(sessionId)}`, {
      method: 'DELETE', headers: sbHeaders,
    });
  } catch (e) { console.error('[map-intake-submit] deleteDraft threw', e && e.message); }
}
