// POST /api/notify-waitlist { waitlist_id }
//
// Sends a "slot opened" email to a single waitlist client and stamps
// notified_at. Coach triggers this from the Waitlist tab in the dashboard
// when they have an opening they want to invite the client to grab.

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
    const waitlistId = body.waitlist_id;
    if (!waitlistId) return res.status(400).json({ error: 'Missing waitlist_id' });

    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
    const lookup = await fetch(
      `${SUPABASE_URL}/rest/v1/booking_waitlist`
        + `?id=eq.${encodeURIComponent(waitlistId)}`
        + `&select=id,client_email,client_name,coach_profiles:coach_id(slug,display_name,full_name),coach_services:service_id(title)`
        + `&limit=1`,
      { headers }
    );
    const rows = await lookup.json();
    const wl = Array.isArray(rows) && rows[0];
    if (!wl) return res.status(404).json({ error: 'waitlist_not_found' });
    if (!wl.client_email) return res.status(200).json({ skipped: true, reason: 'no_client_email' });

    const coach = wl.coach_profiles || {};
    const svc = wl.coach_services || {};
    const coachName = coach.display_name || coach.full_name || 'Your Coach';
    const slug = coach.slug || '';
    const subject = `A coaching slot just opened up with ${coachName}`;
    const html = `
      <div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#1a3a52;">
        <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:1.7rem;color:#1a3a52;margin-bottom:16px;">A spot just opened up</h1>
        <p style="font-size:0.95rem;line-height:1.6;">Hi ${escapeHtml(wl.client_name || 'there')},</p>
        <p style="font-size:0.95rem;line-height:1.6;color:#6b6b60;">${escapeHtml(coachName)} has availability for ${svc.title ? escapeHtml(svc.title) : 'a coaching session'} and saved a spot for you to book first.</p>
        <p style="text-align:center;margin:24px 0;"><a href="https://www.ineedcoaching.org/book?coach=${encodeURIComponent(slug)}" style="display:inline-block;background:#c49a3c;color:#fff;padding:14px 32px;border-radius:50px;text-decoration:none;font-weight:700;font-size:0.92rem;">Pick a time &rarr;</a></p>
        <p style="font-size:0.82rem;color:#6b6b60;line-height:1.6;">Slots get claimed quickly — book today if it works for you. If you no longer need a session, you can ignore this email.</p>
        <p style="font-size:0.78rem;color:#6b6b60;margin-top:24px;">— The <a href="https://www.ineedcoaching.org" style="color:#c49a3c;text-decoration:none;font-weight:600;">ineedcoaching.org</a> team</p>
      </div>
    `;

    const origin = req.headers.host ? `https://${req.headers.host}` : 'https://www.ineedcoaching.org';
    const sendRes = await fetch(`${origin}/api/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: wl.client_email, subject, html }),
    });
    if (!sendRes.ok) {
      const t = await sendRes.text().catch(() => '');
      console.error('[notify-waitlist] send-email failed', sendRes.status, t);
      return res.status(502).json({ error: 'send_failed' });
    }
    await fetch(`${SUPABASE_URL}/rest/v1/booking_waitlist?id=eq.${encodeURIComponent(waitlistId)}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ notified_at: new Date().toISOString() }),
    });
    return res.status(200).json({ sent: true, to: wl.client_email });
  } catch (e) {
    console.error('[notify-waitlist] error', e);
    return res.status(500).json({ error: e.message });
  }
}
