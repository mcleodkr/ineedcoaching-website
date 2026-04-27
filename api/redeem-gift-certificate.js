// POST /api/redeem-gift-certificate { code, coach_id, service_price_cents? }
//
// Validates a gift certificate code and returns the credit it would apply.
// Doesn't redeem yet — the booking insert (book.html) writes
// gift_certificate_id on the row, and a follow-up PATCH stamps redeemed_at.
// Failure modes (not found, expired, already redeemed, wrong coach) come
// back as 200 + valid:false so book.html can render an inline error.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const code = String(body.code || '').trim().toUpperCase();
    const coachId = String(body.coach_id || '').trim();
    const servicePriceCents = Number(body.service_price_cents || 0);
    if (!code) return res.status(400).json({ error: 'Missing code' });

    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
    const lookup = await fetch(
      `${SUPABASE_URL}/rest/v1/gift_certificates`
        + `?code=eq.${encodeURIComponent(code)}`
        + `&is_active=eq.true`
        + `&select=id,coach_id,amount_cents,session_count,redeemed_at,expires_at`
        + `&limit=1`,
      { headers }
    );
    if (!lookup.ok) return res.status(500).json({ error: 'lookup_failed' });
    const rows = await lookup.json();
    const gift = Array.isArray(rows) && rows[0];
    if (!gift) return res.status(200).json({ valid: false, reason: 'not_found' });
    if (gift.redeemed_at) return res.status(200).json({ valid: false, reason: 'already_redeemed' });
    if (gift.expires_at && new Date(gift.expires_at).getTime() < Date.now()) {
      return res.status(200).json({ valid: false, reason: 'expired' });
    }
    if (coachId && gift.coach_id !== coachId) {
      return res.status(200).json({ valid: false, reason: 'wrong_coach' });
    }

    // amount_cents gifts apply as a flat dollar credit, capped at the
    // service price. session_count gifts cover one whole session (so the
    // booking is effectively free regardless of price); the remaining
    // session_count is decremented by the booking flow.
    let coversFull = false;
    let creditCents = 0;
    if (gift.session_count != null) {
      coversFull = true;
    } else if (gift.amount_cents != null) {
      creditCents = servicePriceCents > 0 ? Math.min(servicePriceCents, gift.amount_cents) : gift.amount_cents;
      if (servicePriceCents > 0 && creditCents >= servicePriceCents) coversFull = true;
    }

    return res.status(200).json({
      valid: true,
      gift_certificate_id: gift.id,
      coach_id: gift.coach_id,
      gift_type: gift.session_count != null ? 'sessions' : 'amount',
      session_count: gift.session_count || null,
      amount_cents: gift.amount_cents || null,
      credit_cents: creditCents,
      covers_full: coversFull,
    });
  } catch (e) {
    console.error('[redeem-gift-certificate] error', e);
    return res.status(500).json({ error: e.message });
  }
}
