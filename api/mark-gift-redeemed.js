// POST /api/mark-gift-redeemed { gift_certificate_id, redeemed_by_email }
//
// Server-side endpoint that stamps redeemed_at and redeemed_by on a gift
// certificate after a successful booking. This replaces the previous client-side
// PATCH in book.html that used the anon key — under the RLS-protected
// gift_certificates table, only the service role key can write to the table.
//
// Defenses:
//   - Validates gift_certificate_id is a non-empty string
//   - Validates redeemed_by_email is present (kept lowercase for consistency)
//   - Refuses to overwrite an already-redeemed certificate (preserves audit trail)
//   - Uses service role internally; never exposes it to the client
//
// On error this returns a 200 with a reason so book.html can ignore quietly
// (the booking itself is already inserted by that point — failing to mark the
// gift as redeemed should not erase the booking).

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) {
    console.error('[mark-gift-redeemed] SUPABASE_SERVICE_ROLE_KEY not set');
    return res.status(500).json({ error: 'Server not configured' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const giftId = String(body.gift_certificate_id || '').trim();
  const redeemedByEmail = String(body.redeemed_by_email || '').trim().toLowerCase();

  if (!giftId) return res.status(400).json({ error: 'Missing gift_certificate_id' });
  if (!redeemedByEmail) return res.status(400).json({ error: 'Missing redeemed_by_email' });

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    // Pre-check: don't overwrite an already-redeemed certificate
    const lookup = await fetch(
      `${SUPABASE_URL}/rest/v1/gift_certificates?id=eq.${encodeURIComponent(giftId)}&select=id,redeemed_at&limit=1`,
      { headers }
    );
    if (!lookup.ok) {
      console.error('[mark-gift-redeemed] lookup failed', lookup.status);
      return res.status(200).json({ ok: false, reason: 'lookup_failed' });
    }
    const rows = await lookup.json();
    const existing = Array.isArray(rows) && rows[0];
    if (!existing) return res.status(200).json({ ok: false, reason: 'not_found' });
    if (existing.redeemed_at) {
      return res.status(200).json({ ok: false, reason: 'already_redeemed' });
    }

    // Stamp redeemed_at and redeemed_by
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/gift_certificates?id=eq.${encodeURIComponent(giftId)}`,
      {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({
          redeemed_by: redeemedByEmail,
          redeemed_at: new Date().toISOString(),
        }),
      }
    );
    if (!patchRes.ok && patchRes.status !== 204) {
      console.error('[mark-gift-redeemed] patch failed', patchRes.status);
      return res.status(200).json({ ok: false, reason: 'patch_failed' });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[mark-gift-redeemed] error', e);
    return res.status(200).json({ ok: false, reason: 'exception' });
  }
}
