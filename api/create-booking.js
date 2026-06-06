// POST /api/create-booking
//
// Phase 3a of the coach_bookings lockdown: the public booking page (book.html)
// used to INSERT into coach_bookings directly with the anon key. This moves that
// write server-side (service role) so a later phase can drop anon write access
// and enable RLS. Behavior is intentionally identical to the old direct insert —
// it takes the same fields book.html already assembled, inserts one row, and
// returns exactly what the page needs: { id, zoom_link }.
//
// This does NOT enable RLS and does NOT touch reminder crons, webhooks, or admin
// reads (those are 3b/3c). It is an unauthenticated endpoint because booking is
// public — same trust model as the old anon-key insert — but it allowlists the
// columns a booker may set so the service role can't be used to write arbitrary
// columns (reschedule_token, etc.).

const ALLOWED_STATUS = new Set(['confirmed', 'pending_payment']);

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

    // Required fields — same ones book.html always sends.
    const coachId = body.coach_id;
    const clientEmail = typeof body.client_email === 'string' ? body.client_email.trim() : '';
    const scheduledAt = body.scheduled_at;
    if (!coachId || !clientEmail || !scheduledAt) {
      return res.status(400).json({ error: 'Missing required fields: coach_id, client_email, scheduled_at' });
    }

    // Status — clamp to the two the public flow uses; default confirmed.
    const status = ALLOWED_STATUS.has(body.status) ? body.status : 'confirmed';

    // sms_reminder_timing — only 15 or 30, default 30 (mirrors book.html).
    const smsTimingInput = parseInt(body.sms_reminder_timing, 10);
    const smsTiming = (smsTimingInput === 15 || smsTimingInput === 30) ? smsTimingInput : 30;

    // Allowlist exactly the columns the public booking insert sets. Anything
    // not listed here is ignored — the service role never writes arbitrary
    // columns from client input.
    const row = {
      coach_id: coachId,
      client_email: clientEmail,
      client_name: typeof body.client_name === 'string' ? body.client_name : null,
      client_phone: body.client_phone || null,
      service_id: body.service_id || null,
      service_name: typeof body.service_name === 'string' ? body.service_name : null,
      service_price: Number(body.service_price || 0),
      scheduled_at: scheduledAt,
      notes: typeof body.notes === 'string' ? body.notes : null,
      status: status,
      sms_opt_in: !!body.sms_opt_in && !!body.client_phone,
      sms_reminder_timing: smsTiming,
    };
    if (status === 'pending_payment' && body.payment_amount_cents != null) {
      row.payment_amount_cents = Math.round(Number(body.payment_amount_cents) || 0);
    }
    if (body.gift_certificate_id) row.gift_certificate_id = body.gift_certificate_id;
    if (typeof body.discount_amount_cents === 'number' && body.discount_amount_cents > 0) {
      row.discount_amount_cents = body.discount_amount_cents;
    }

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/coach_bookings`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(row),
    });
    if (!insertRes.ok && insertRes.status !== 201) {
      const text = await insertRes.text().catch(() => '');
      console.error('[create-booking] insert failed', insertRes.status, text.slice(0, 400));
      return res.status(502).json({ error: 'Booking insert failed', status: insertRes.status });
    }
    const rows = await insertRes.json().catch(() => null);
    const inserted = Array.isArray(rows) && rows[0];
    if (!inserted || !inserted.id) {
      return res.status(502).json({ error: 'Booking insert returned no row' });
    }

    return res.status(200).json({ id: inserted.id, zoom_link: inserted.zoom_link || '' });
  } catch (e) {
    console.error('[create-booking] error', e);
    return res.status(500).json({ error: e.message });
  }
}
