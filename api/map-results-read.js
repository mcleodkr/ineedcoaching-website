// api/map-results-read.js
//
// POST /api/map-results-read — return the explorer-facing Effectiveness Map for a
// finished intake (brief v1.1, Step 4 — results page). No Supabase auth: a valid
// MAP_LINK_SECRET HMAC token IS the authorization, exactly like its Step 2 sibling
// api/map-intake-validate.js. Service-role only; the explorer never authenticates.
//
// Body: { token }  — the signed link from /map/results?token=...
//
// SECURITY — this endpoint reads a row the explorer is not otherwise authorized to
// see, so it is deliberately narrow:
//   - verifyMapLink(token) runs BEFORE any DB read (HMAC + expiry); the token's
//     session_id is the only key used, same authz model as validate/submit.
//   - The SELECT lists explorer-safe columns ONLY. raw_output, coach_id,
//     client_email, explorer_id, prompt_version are never selected, so they can
//     never reach the browser even if the response shape later changes.
//   - The returned explorer_facing_output is REBUILT field-by-field (not passed
//     through), and each domain status is trimmed to primary_status only — a
//     future change to the stored blob cannot leak a new field.
//   - Crisis rows carry no map content: return a content-free { status:'crisis' }
//     so the page can show safety resources, never map data.
//   - One generic message on every failure; never leak why a link failed.
//
// Returns:
//   { ok:true,  status:'ready',  goal, phase, explorer_facing_output }
//   { ok:true,  status:'crisis' }                    crisis row — show safety resources
//   { ok:false, error:'<friendly>' }                 invalid link, or map not ready

import { verifyMapLink } from '../lib/map-link.js';

const INACTIVE_MSG = 'This link is no longer active. Ask your coach to send a new one.';
const NOT_READY_MSG = 'Your map isn’t ready yet. Check back shortly, or ask your coach to resend the link.';

// Explorer-safe columns ONLY. Note the absence of raw_output / coach_id /
// client_email / explorer_id / prompt_version — coach-only or sensitive.
const SELECT_COLS = 'goal,phase,crisis_flag,explorer_facing_output';

// The five P.I.P.E.S. domains, in display order.
const DOMAINS = ['physical', 'intellectual', 'psychological', 'environmental', 'social'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY || !process.env.MAP_LINK_SECRET) {
    console.error('[map-results-read] server not configured');
    return res.status(500).json({ ok: false, error: INACTIVE_MSG });
  }

  const READ_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const token = typeof body.token === 'string' ? body.token : '';

    // 1. Cryptographic gate — runs before any DB read.
    const decoded = verifyMapLink(token);
    if (!decoded) return res.status(200).json({ ok: false, error: INACTIVE_MSG });
    const sessionId = decoded.sessionId;

    // 2. The map row, by session_id (unique). Explorer-safe columns only.
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/effectiveness_maps?session_id=eq.${encodeURIComponent(sessionId)}&select=${SELECT_COLS}&limit=1`,
      { headers: READ_HEADERS }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[map-results-read] map read failed', r.status, t.slice(0, 200));
      return res.status(200).json({ ok: false, error: NOT_READY_MSG });
    }
    const rows = await r.json().catch(() => []);
    const map = Array.isArray(rows) ? rows[0] : null;

    // 3. No row yet → the Map has not been generated (single-use submit not done).
    if (!map) return res.status(200).json({ ok: false, error: NOT_READY_MSG });

    // 4. Crisis row → no content, ever. Page shows safety resources.
    if (map.crisis_flag === true) {
      return res.status(200).json({ ok: true, status: 'crisis' });
    }

    // 5. Ready → goal, phase, and a rebuilt explorer-facing payload (primary only).
    return res.status(200).json({
      ok: true,
      status: 'ready',
      goal: map.goal ?? null,
      phase: map.phase ?? null,
      explorer_facing_output: sanitizeExplorerFacing(map.explorer_facing_output),
    });
  } catch (e) {
    console.error('[map-results-read] error', e && e.message);
    return res.status(500).json({ ok: false, error: INACTIVE_MSG });
  }
}

// Rebuild the explorer-facing output from scratch so only known, explorer-safe
// fields can ever be returned. Domain statuses are trimmed to PRIMARY ONLY
// (secondary_status is dropped); the one-line read and snapshot paragraph stay —
// they are the explorer-facing content of the results page.
function sanitizeExplorerFacing(efo) {
  if (!efo || typeof efo !== 'object') return null;

  const out = {};

  if (efo.domain_statuses && typeof efo.domain_statuses === 'object') {
    out.domain_statuses = {};
    for (const domain of DOMAINS) {
      const d = efo.domain_statuses[domain];
      if (!d || typeof d !== 'object') continue;
      out.domain_statuses[domain] = {
        primary_status: d.primary_status ?? null,   // primary only — secondary_status intentionally omitted
        one_line_read: d.one_line_read ?? null,
        snapshot_paragraph: d.snapshot_paragraph ?? null,
      };
    }
  }

  out.system_picture = efo.system_picture ?? null;
  out.cross_domain_tax = efo.cross_domain_tax ?? null;
  out.release_question = efo.release_question ?? null;

  return out;
}
