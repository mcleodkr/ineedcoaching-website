// POST { coach_id, client_email }
// Returns the per-session Coach Mirror timeline for one (coach, client):
//   { sessions: [ { session_id, booking_id, ordinal, date, coaching_reflection,
//                   missed_windows } ... ] }
//
// Coach Mirror is a viewing surface over Coach Clarity output — it does NOT
// generate anything. coaching_reflection and missed_windows are read straight
// from coach_session_notes.post_session_analysis. Sessions are returned
// most-recent-first (the panel renders top-to-bottom newest-first).
//
// Per the audit doc: this surface is for the coach's eyes only; it must
// never be exposed in any client-facing dashboard. The panel HTML enforces
// that intent visually.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { coach_id, client_email } = body;
    if (!coach_id || !client_email) {
      return res.status(400).json({ error: 'Missing required fields: coach_id, client_email' });
    }

    const headers = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    };

    // Fetch every session note for this (coach, client) that has Coach Clarity
    // analysis. Order ascending so we can assign session ordinals (1-based,
    // chronological); the response is reversed at the end so newest is first.
    const enc = encodeURIComponent(client_email);
    const fetchUrl = `${SUPABASE_URL}/rest/v1/coach_session_notes`
      + `?coach_id=eq.${coach_id}`
      + `&client_email=eq.${enc}`
      + `&post_session_analysis=not.is.null`
      + `&select=id,booking_id,created_at,post_session_analysis`
      + `&order=created_at.asc`;

    const resp = await fetch(fetchUrl, { headers });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[coach-mirror] supabase fetch failed:', resp.status, errText);
      return res.status(500).json({ error: 'Failed to load session notes', detail: errText.slice(0, 400) });
    }
    const rows = await resp.json();
    if (!Array.isArray(rows)) {
      return res.status(200).json({ sessions: [] });
    }

    const sessions = rows.map(function(row, i) {
      const psa = (row.post_session_analysis && typeof row.post_session_analysis === 'object')
        ? row.post_session_analysis
        : {};
      return {
        session_id: row.id,
        booking_id: row.booking_id || null,
        ordinal: i + 1,
        date: row.created_at,
        coaching_reflection: psa.coaching_reflection || null,
        missed_windows: Array.isArray(psa.missed_windows) ? psa.missed_windows : [],
      };
    });

    // Newest first for the panel timeline.
    sessions.reverse();

    return res.status(200).json({ sessions, total: sessions.length });
  } catch (e) {
    console.error('[coach-mirror] error:', e);
    return res.status(500).json({ error: e.message });
  }
}
