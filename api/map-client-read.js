// api/map-client-read.js
//
// POST /api/map-client-read — every Effectiveness Map belonging to the logged-in
// CLIENT, so they can re-read their own Maps from the client dashboard (Step 7).
// The client's own Supabase JWT is the authorization; the email is derived from
// that token server-side (never trusted from the body) and the service-role read
// is scoped strictly to client_email = that email — a client can only ever see
// Maps that were generated for their own address.
//
// SECURITY — this returns the EXPLORER-FACING surface only, never coach-only data:
//   - The email is read from /auth/v1/user using the caller's bearer token; the
//     request body carries no identity, so it cannot widen scope.
//   - SELECT lists explorer-safe columns ONLY. raw_output, answers, coach_id,
//     explorer_id, dominant_pattern_label, overall_evidence_strength and
//     prompt_version are never selected, so coach-only content (Coach Synthesis,
//     Intelligence Notes, per-domain evidence/confidence, dominant pattern) can
//     never reach the browser — it lives only in those unselected columns.
//   - explorer_facing_output is REBUILT field-by-field through an allowlist (same
//     model as api/map-results-read.js): each domain status is trimmed to the
//     explorer fields and secondary_status is dropped, so a future change to the
//     stored blob cannot leak a new field.
//   - Crisis rows carry no Map content, so they are excluded at the query level
//     (crisis_flag=eq.false), exactly like the coach read.
//
// Reading already-generated Maps is NOT paywalled and requires no coach profile —
// only a valid client session. Mirrors api/map-coach-read.js, retargeted to the
// client's own email.
//
// Body: {}  (identity comes from the JWT, not the body)
// Returns: { ok:true, maps:[ { id, session_id, goal, phase, created_at,
//            explorer_facing_output } ] }  newest first  |  { ok:false, error }

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FAIL_MSG = 'Could not load your Effectiveness Maps.';
const EMAIL_MAX = 254; // RFC 5321 max

// Explorer-safe columns ONLY. Note the deliberate absence of raw_output / answers
// / coach_id / explorer_id / dominant_pattern_label / overall_evidence_strength /
// prompt_version — all coach-only or sensitive.
const SELECT_COLS = 'id,session_id,goal,phase,created_at,explorer_facing_output';

// The five P.I.P.E.S. domains, in display order.
const DOMAINS = ['physical', 'intellectual', 'psychological', 'environmental', 'social'];

function sbHeaders() {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
}

// Resolve the caller's email from their Supabase JWT (never trusted from body).
async function deriveUserEmail(req) {
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
    return email && email.length <= EMAIL_MAX ? email : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!SUPABASE_KEY) {
    console.error('[map-client-read] server not configured');
    return res.status(500).json({ ok: false, error: FAIL_MSG });
  }

  try {
    // --- client auth: the JWT is the authorization; the email is derived from it,
    //     never from the request body, so scope cannot be widened by the caller. ---
    const clientEmail = await deriveUserEmail(req);
    if (!clientEmail) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });

    // --- scoped read: Maps generated for THIS client's own email, coaching only,
    //     non-crisis (crisis rows carry no Map content), newest first. The stored
    //     client_email is lowercased so eq. is an exact match (no LIKE-wildcard
    //     semantics). limit bounds the response. ---
    const url = `${SUPABASE_URL}/rest/v1/effectiveness_maps`
      + `?client_email=eq.${encodeURIComponent(clientEmail)}`
      + `&product_context=eq.coaching`
      + `&crisis_flag=eq.false`
      + `&order=created_at.desc`
      + `&limit=50`
      + `&select=${SELECT_COLS}`;
    const r = await fetch(url, { headers: sbHeaders() });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[map-client-read] read failed', r.status, t.slice(0, 200));
      return res.status(200).json({ ok: false, error: FAIL_MSG });
    }
    const rows = await r.json().catch(() => []);
    const maps = (Array.isArray(rows) ? rows : []).map((m) => ({
      id: m.id,
      session_id: m.session_id,
      goal: m.goal ?? null,
      phase: m.phase ?? null,
      created_at: m.created_at,
      explorer_facing_output: sanitizeExplorerFacing(m.explorer_facing_output),
    }));
    return res.status(200).json({ ok: true, maps });
  } catch (e) {
    console.error('[map-client-read] error', e && e.message);
    return res.status(500).json({ ok: false, error: FAIL_MSG });
  }
}

// Rebuild the explorer-facing output from scratch so only known, explorer-safe
// fields can ever be returned (defense in depth — the column is already the
// explorer blob, but a field-by-field allowlist means a future stored-shape
// change cannot leak a new field). Domain statuses are trimmed to the explorer
// fields; secondary_status is dropped to match api/map-results-read.js. The full
// explorer surface the client dashboard renders is preserved: opener, the five
// domain snapshots + primary status, The Whole Picture, How this shows up, Where
// the load is moving, In short, the release question, and the status legend.
function sanitizeExplorerFacing(efo) {
  if (!efo || typeof efo !== 'object') return null;

  const out = {};

  if (typeof efo.opener === 'string') out.opener = efo.opener;

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

  if (efo.system_picture && typeof efo.system_picture === 'object') {
    out.system_picture = { narrative: efo.system_picture.narrative ?? null };
  }

  if (typeof efo.how_this_shows_up === 'string') out.how_this_shows_up = efo.how_this_shows_up;

  if (efo.cross_domain_tax && typeof efo.cross_domain_tax === 'object') {
    out.cross_domain_tax = { narrative: efo.cross_domain_tax.narrative ?? null };
  }

  if (efo.closing_summary && typeof efo.closing_summary === 'object') {
    out.closing_summary = {};
    for (const domain of DOMAINS) {
      const c = efo.closing_summary[domain];
      if (!c || typeof c !== 'object') continue;
      out.closing_summary[domain] = {
        direction: c.direction ?? null,
        plain: c.plain ?? null,
      };
    }
  }

  if (efo.release_question && typeof efo.release_question === 'object') {
    out.release_question = { question: efo.release_question.question ?? null };
  }

  if (typeof efo.status_legend === 'string') out.status_legend = efo.status_legend;

  return out;
}
