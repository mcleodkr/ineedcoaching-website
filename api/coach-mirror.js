// POST { coach_id, client_email }
// Returns the per-session Coach Mirror timeline for one (coach, client):
//   {
//     display_name: <client display name or null>,
//     sessions: [ { session_id, booking_id, ordinal, date, coaching_reflection,
//                   missed_windows } ... ],
//     total: N
//   }
//
// Coach Mirror is a viewing surface over Coach Clarity output — it does NOT
// generate anything. coaching_reflection and missed_windows are read straight
// from coach_session_notes.post_session_analysis. Per the audit doc, this
// surface is for the coach's eyes only; the panel HTML enforces that intent
// visually.
//
// Date sourcing (5b hotfix): session card dates and ordinals come from
// coach_bookings.scheduled_at (joined via booking_id), NOT from the PSA
// row's created_at. PSA can be written days after a booking — using
// created_at made the Apr 24 card show May 11 booking content in production.
// Confirmed live column: coach_bookings.scheduled_at (used in 10+ places in
// coach-dashboard.html, coach-profile.html, admin.html). If a session note
// has no booking_id or no matching booking, fall back to PSA created_at.
//
// Display name sourcing (5b hotfix): the dashboard derives client display
// names by parsing /^Name:\s*(.+)/m out of coach_bookings.notes
// (coach-dashboard.html:4111-4125). We do the same here so Coach Mirror
// matches the dashboard's name for the same client.

function parseNameFromNotes(notes) {
  if (typeof notes !== 'string' || !notes) return null;
  const m = notes.match(/^Name:\s*(.+)/m);
  return m ? m[1].trim() : null;
}

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
    const enc = encodeURIComponent(client_email);

    // 1. Fetch session notes (PSA-analyzed only).
    const notesUrl = `${SUPABASE_URL}/rest/v1/coach_session_notes`
      + `?coach_id=eq.${coach_id}`
      + `&client_email=eq.${enc}`
      + `&post_session_analysis=not.is.null`
      + `&select=id,booking_id,created_at,post_session_analysis`
      + `&order=created_at.asc`;

    // 2. Fetch this client's bookings — for scheduled_at and Name parsing.
    //    Filter by coach_id too so a client who's worked with multiple coaches
    //    on the platform doesn't bleed bookings across coach contexts.
    const bookingsUrl = `${SUPABASE_URL}/rest/v1/coach_bookings`
      + `?coach_id=eq.${coach_id}`
      + `&client_email=eq.${enc}`
      + `&select=id,scheduled_at,notes`;

    const [notesResp, bookingsResp] = await Promise.all([
      fetch(notesUrl, { headers }),
      fetch(bookingsUrl, { headers }),
    ]);

    if (!notesResp.ok) {
      const errText = await notesResp.text();
      console.error('[coach-mirror] notes fetch failed:', notesResp.status, errText);
      return res.status(500).json({ error: 'Failed to load session notes', detail: errText.slice(0, 400) });
    }
    const noteRows = await notesResp.json();
    if (!Array.isArray(noteRows)) {
      return res.status(200).json({ display_name: null, sessions: [], total: 0 });
    }

    let bookingRows = [];
    if (bookingsResp.ok) {
      const parsed = await bookingsResp.json();
      if (Array.isArray(parsed)) bookingRows = parsed;
    } else {
      // Bookings fetch failure is non-fatal — fall back to PSA created_at and
      // null display_name. Don't block the timeline.
      console.warn('[coach-mirror] bookings fetch failed (non-fatal):', bookingsResp.status);
    }

    // bookingId → { scheduled_at, notes }
    const bookingMap = {};
    let displayName = null;
    bookingRows.forEach(function(b) {
      if (!b || !b.id) return;
      bookingMap[b.id] = { scheduled_at: b.scheduled_at || null, notes: b.notes || '' };
      if (!displayName) {
        const n = parseNameFromNotes(b.notes);
        if (n) displayName = n;
      }
    });

    // Project to timeline rows. Each session gets effective_date = the
    // booking's scheduled_at when available, else PSA created_at.
    let sessions = noteRows.map(function(row) {
      const psa = (row.post_session_analysis && typeof row.post_session_analysis === 'object')
        ? row.post_session_analysis : {};
      const bk = row.booking_id ? bookingMap[row.booking_id] : null;
      const date = (bk && bk.scheduled_at) ? bk.scheduled_at : row.created_at;
      return {
        session_id: row.id,
        booking_id: row.booking_id || null,
        date: date,
        date_source: (bk && bk.scheduled_at) ? 'booking.scheduled_at' : 'psa.created_at',
        coaching_reflection: psa.coaching_reflection || null,
        missed_windows: Array.isArray(psa.missed_windows) ? psa.missed_windows : [],
      };
    });

    // Sort ASC by effective date so ordinals are stable (oldest = 1).
    sessions.sort(function(a, b) {
      const ta = a.date ? new Date(a.date).getTime() : 0;
      const tb = b.date ? new Date(b.date).getTime() : 0;
      return ta - tb;
    });
    sessions.forEach(function(s, i) { s.ordinal = i + 1; });

    // Then reverse so the panel renders newest-first.
    sessions.reverse();

    return res.status(200).json({
      display_name: displayName,
      sessions,
      total: sessions.length,
    });
  } catch (e) {
    console.error('[coach-mirror] error:', e);
    return res.status(500).json({ error: e.message });
  }
}
