// POST /api/send-gift-certificate { gift_id }
//
// Emails the recipient their gift certificate code + redemption link.
// Called from /api/stripe-webhook after the gift_certificates row is
// created, so this endpoint just reads the row and sends mail via
// /api/send-email.

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
    const giftId = body.gift_id;
    if (!giftId) return res.status(400).json({ error: 'Missing gift_id' });

    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
    const lookup = await fetch(
      `${SUPABASE_URL}/rest/v1/gift_certificates`
        + `?id=eq.${encodeURIComponent(giftId)}`
        + `&select=id,code,amount_cents,session_count,recipient_email,recipient_name,purchased_by,message,coach_profiles:coach_id(slug,display_name,full_name)`
        + `&limit=1`,
      { headers }
    );
    const rows = await lookup.json();
    const gift = Array.isArray(rows) && rows[0];
    if (!gift) return res.status(404).json({ error: 'gift_not_found' });
    if (!gift.recipient_email) return res.status(200).json({ skipped: true, reason: 'no_recipient' });
    const coach = gift.coach_profiles || {};
    const coachName = coach.display_name || coach.full_name || 'Your Coach';
    const slug = coach.slug || '';
    const valueLabel = gift.session_count
      ? `${gift.session_count} ${gift.session_count === 1 ? 'session' : 'sessions'}`
      : `$${(gift.amount_cents / 100).toFixed(2).replace(/\.00$/, '')}`;
    const fromLabel = gift.purchased_by ? ` from ${gift.purchased_by}` : '';
    const redeemLink = `https://www.ineedcoaching.org/book?coach=${encodeURIComponent(slug)}&gift_code=${encodeURIComponent(gift.code)}`;

    const subject = `You've received a coaching gift${fromLabel ? ' from ' + gift.purchased_by : ''}`;
    const html = `
      <div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#1a3a52;">
        <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:1.8rem;color:#1a3a52;margin-bottom:16px;">You've been gifted coaching</h1>
        <p style="font-size:0.95rem;line-height:1.6;">Hi ${escapeHtml(gift.recipient_name || 'there')},</p>
        <p style="font-size:0.95rem;line-height:1.6;color:#6b6b60;">${escapeHtml(gift.purchased_by || 'Someone')} has gifted you ${escapeHtml(valueLabel)} with ${escapeHtml(coachName)}.</p>
        ${gift.message ? `<div style="background:#f7f4ee;border-left:3px solid #c49a3c;border-radius:0 8px 8px 0;padding:18px 22px;margin:20px 0;font-style:italic;color:#1a3a52;">"${escapeHtml(gift.message)}"</div>` : ''}
        <div style="background:#f7f4ee;border-radius:8px;padding:24px;margin:20px 0;text-align:center;">
          <div style="font-size:0.78rem;letter-spacing:0.08em;text-transform:uppercase;color:#6b6b60;margin-bottom:8px;">Your gift code</div>
          <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:2rem;font-weight:700;color:#c49a3c;letter-spacing:0.08em;">${escapeHtml(gift.code)}</div>
        </div>
        <p style="text-align:center;margin:24px 0;"><a href="${redeemLink}" style="display:inline-block;background:#c49a3c;color:#fff;padding:14px 32px;border-radius:50px;text-decoration:none;font-weight:700;font-size:0.92rem;">Redeem your gift &rarr;</a></p>
        <p style="font-size:0.82rem;color:#6b6b60;line-height:1.6;">Or visit <a href="https://www.ineedcoaching.org/book?coach=${encodeURIComponent(slug)}" style="color:#c49a3c;text-decoration:none;font-weight:600;">${coachName}'s booking page</a> and enter your code at checkout.</p>
        <p style="font-size:0.78rem;color:#6b6b60;margin-top:24px;">— The <a href="https://www.ineedcoaching.org" style="color:#c49a3c;text-decoration:none;font-weight:600;">ineedcoaching.org</a> team</p>
      </div>
    `;

    const origin = req.headers.host ? `https://${req.headers.host}` : 'https://www.ineedcoaching.org';
    const sendRes = await fetch(`${origin}/api/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: gift.recipient_email, subject, html }),
    });
    if (!sendRes.ok) {
      const t = await sendRes.text().catch(() => '');
      console.error('[send-gift-certificate] send-email failed', sendRes.status, t);
      return res.status(502).json({ error: 'send_failed' });
    }
    return res.status(200).json({ sent: true, to: gift.recipient_email });
  } catch (e) {
    console.error('[send-gift-certificate] error', e);
    return res.status(500).json({ error: e.message });
  }
}
