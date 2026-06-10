// POST /api/map-intake-save — save-as-you-go draft persistence for the
// Effectiveness Map intake (brief v1.1, Step 2). Service-role only; the signed
// MAP_LINK_SECRET token authorizes the write. The explorer never authenticates.
//
// Body: { token, answers, current_screen }
//   - session_id is taken from the TOKEN, never from the body.
//   - answers is whitelisted to the known intake keys (goal, phase, the 10 P.I.P.E.S.
//     fields) so a tampered client can't stuff arbitrary JSON into the row.
//   - Upserts effectiveness_map_drafts on session_id, stamping updated_at = now()
//     (the column default only fires on INSERT). Does NOT call Claude.
//
// Refuses to write for a completed/expired/past-expiry link.

import { verifyMapLink } from '../lib/map-link.js';

const ANSWER_KEYS = [
  'goal', 'phase',
  'physical_1', 'physical_2',
  'intellectual_1', 'intellectual_2',
  'psychological_1', 'psychological_2',
  'environmental_1', 'environmental_2',
  'social_1', 'social_2',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY || !process.env.MAP_LINK_SECRET) {
    console.error('[map-intake-save] server not configured');
    return res.status(500).json({ ok: false });
  }

  const SB_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
  const READ_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    const decoded = verifyMapLink(body.token);
    if (!decoded) return res.status(200).json({ ok: false });
    const sessionId = decoded.sessionId;

    // Whitelist answers to known keys; coerce each to a string.
    const rawAnswers = (body.answers && typeof body.answers === 'object') ? body.answers : {};
    const answers = {};
    for (const k of ANSWER_KEYS) {
      if (rawAnswers[k] != null) answers[k] = String(rawAnswers[k]);
    }
    let currentScreen = parseInt(body.current_screen, 10);
    if (!Number.isInteger(currentScreen) || currentScreen < 0) currentScreen = 0;
    if (currentScreen > 6) currentScreen = 6;

    // Only write drafts for a live link.
    const aRes = await fetch(
      `${SUPABASE_URL}/rest/v1/effectiveness_map_assignments?session_id=eq.${encodeURIComponent(sessionId)}&select=status,expires_at&limit=1`,
      { headers: READ_HEADERS }
    );
    const aRows = await aRes.json().catch(() => []);
    const assignment = Array.isArray(aRows) ? aRows[0] : null;
    if (!assignment) return res.status(200).json({ ok: false });
    if (assignment.status === 'completed' || assignment.status === 'expired') {
      return res.status(200).json({ ok: false });
    }
    const expMs = new Date(assignment.expires_at).getTime();
    if (Number.isFinite(expMs) && Date.now() > expMs) return res.status(200).json({ ok: false });

    // Upsert the draft on session_id; stamp updated_at (default only fires on insert).
    const upRes = await fetch(
      `${SUPABASE_URL}/rest/v1/effectiveness_map_drafts?on_conflict=session_id`,
      {
        method: 'POST',
        headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          session_id: sessionId,
          answers,
          current_screen: currentScreen,
          updated_at: new Date().toISOString(),
          product_context: 'coaching',
        }),
      }
    );
    if (!upRes.ok) {
      const t = await upRes.text().catch(() => '');
      console.error('[map-intake-save] upsert failed', upRes.status, t.slice(0, 200));
      return res.status(200).json({ ok: false });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[map-intake-save] error', e && e.message);
    return res.status(500).json({ ok: false });
  }
}
