// ADMIN DASHBOARD NOTE: Admin email list is hardcoded for MVP. Move to role-based system before scaling.
// Phase 3b — service-role admin read for the all-coaches bookings views in
// admin.html. admin.html used to read coach_bookings directly with the anon key
// (unfiltered, every coach, full client PII). This moves those reads server-side
// behind the SAME admin check api/admin-query.js uses, so a later phase can drop
// anon read access and enable RLS.
//
// SECURITY: this endpoint returns EVERY coach's bookings with full PII, so the
// admin check IS the entire security boundary and is enforced here, server-side —
// never trust the page UI. Any caller without a valid session token belonging to
// an allowlisted admin is rejected (401). The service role key never leaves this
// file. Does NOT change RLS, crons, webhooks, or the booking-create endpoint.
//
// POST { sessionAccessToken, view: 'overview'|'clients'|'revenue' } → { bookings: [...] }

// Mirrors api/admin-query.js ADMIN_EMAILS — keep the two in sync until the
// allowlist moves to a role-based system.
const ADMIN_EMAILS = ['drkmcleod@gmail.com', 'creativeenergytx@gmail.com', 'major.mcleod@icloud.com'];

// Server-controlled selects — the client picks a view, never a raw select, so
// the endpoint fully controls what columns leave the server.
const VIEWS = {
  overview: 'coach_bookings?select=id,client_email,coach_id,service_name,status,created_at,scheduled_at,service_price',
  clients: 'coach_bookings?select=id,client_email,client_name,created_at,referral_source&order=created_at.desc',
  revenue: 'coach_bookings?select=*,coach_profiles(display_name)&order=created_at.desc',
};

export default async function handler(req, res) {
  // Same-origin only — no wildcard CORS on an admin PII endpoint.
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SERVICE_KEY) {
    console.error('[admin-bookings] SUPABASE_SERVICE_ROLE_KEY not set');
    return res.status(500).json({ error: 'Server not configured' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  const { sessionAccessToken, view } = body || {};
  if (!sessionAccessToken) return res.status(401).json({ error: 'Missing session token' });
  if (!view || !Object.prototype.hasOwnProperty.call(VIEWS, view)) {
    return res.status(400).json({ error: 'Invalid view' });
  }

  // --- Admin check (the entire security boundary) — verify caller via Supabase
  //     auth, then require the allowlist. Mirrors api/admin-query.js. ---
  let callerEmail = null;
  try {
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${sessionAccessToken}` },
    });
    if (!authRes.ok) return res.status(401).json({ error: 'Invalid session' });
    const user = await authRes.json();
    callerEmail = (user.email || '').toLowerCase();
  } catch (e) {
    console.error('[admin-bookings] auth check failed:', e.message);
    return res.status(401).json({ error: 'Auth check failed' });
  }
  if (!ADMIN_EMAILS.includes(callerEmail)) {
    return res.status(401).json({ error: 'Not authorized' });
  }

  // --- Service-role read of the selected view ---
  try {
    const readRes = await fetch(`${SUPABASE_URL}/rest/v1/${VIEWS[view]}`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (!readRes.ok) {
      const text = await readRes.text().catch(() => '');
      console.error('[admin-bookings] read failed', readRes.status, text.slice(0, 300));
      return res.status(502).json({ error: 'Failed to load bookings' });
    }
    const bookings = await readRes.json();
    return res.status(200).json({ bookings: Array.isArray(bookings) ? bookings : [] });
  } catch (e) {
    console.error('[admin-bookings] error', e);
    return res.status(500).json({ error: e.message });
  }
}
