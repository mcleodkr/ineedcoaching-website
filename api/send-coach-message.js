// Public coach-message endpoint backing the unauthenticated lead form on
// /coach/<slug> (coach-profile.html). Uses the Supabase service-role key
// to insert into coach_messages despite the table's tightened RLS.
//
// Why this exists: under the spec'd coach_messages policies, a direct
// INSERT from coach-profile.html with the anon key fails because
// auth.jwt()->>'email' is null. Routing the public form through this
// endpoint preserves the unauthenticated lead-capture UX while closing
// the spoofing vector — a sender can no longer claim to be a *coach*
// because this endpoint hard-codes sender='client', and is the only
// path that can write a row without an authenticated user JWT.
//
// Defenses inside the endpoint:
//   - sender hard-coded to 'client' (no spoofing as a coach)
//   - sender_email and client_email both set from the form payload, then
//     copied into the row — a future enhancement can verify ownership
//     (email confirmation flow) before delivery; for now we record what
//     was provided and surface it in the coach inbox
//   - coach_id must reference an existing coach_profiles row
//   - message + email + name length caps to deflect obvious abuse
//   - is_read forced to false so the coach sees a fresh unread

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });
  const SB_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

  try {
    const body = req.body || {};
    const coachId = String(body.coach_id || '').trim();
    const senderName = String(body.sender_name || '').trim().slice(0, 200);
    const senderEmail = String(body.sender_email || '').trim().toLowerCase().slice(0, 200);
    const message = String(body.message || '').trim().slice(0, 5000);
    if (!coachId || !senderEmail || !message) {
      return res.status(400).json({ error: 'Missing coach_id, sender_email, or message' });
    }
    // Light sanity check on email shape — defer hard validation to Stripe /
    // Supabase later if we add email-confirmed delivery.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
      return res.status(400).json({ error: 'Invalid sender_email' });
    }

    // Confirm coach_id resolves to a real coach_profiles row before writing.
    const coachRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${encodeURIComponent(coachId)}&select=id`,
      { headers: SB_HEADERS }
    );
    const coachRows = await coachRes.json();
    if (!Array.isArray(coachRows) || coachRows.length === 0) {
      return res.status(404).json({ error: 'Coach not found' });
    }

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/coach_messages`, {
      method: 'POST',
      headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
      body: JSON.stringify({
        coach_id: coachId,
        client_email: senderEmail,
        sender: 'client',
        sender_name: senderName || null,
        sender_email: senderEmail,
        message,
        is_read: false,
      }),
    });
    if (!insertRes.ok) {
      const errText = await insertRes.text().catch(function() { return ''; });
      console.error('[send-coach-message] insert failed', insertRes.status, errText);
      return res.status(500).json({ error: 'Could not send message' });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[send-coach-message] error', e);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
}
