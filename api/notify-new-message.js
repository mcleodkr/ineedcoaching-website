// POST /api/notify-new-message { message_id }
//
// Fired (best-effort) by the client dashboard right after a client inserts a
// row into coach_messages. The dashboard writes the message directly to
// Supabase under the client's JWT; this endpoint then notifies the coach so
// they don't have to be logged in to learn a client reached out.
//
// It re-reads the stored row by id with the service role (authoritative — the
// caller never supplies the message text or recipient), and only notifies when
// sender = 'client'. Email goes out via Resend (the project's existing mailer
// setup); an optional Twilio SMS is sent when the coach has a phone on file and
// has opted into SMS alerts. Everything here is best-effort: a notify failure
// must never surface to the client, who has already sent their message.

const COACH_DASHBOARD_MESSAGES_URL = 'https://www.ineedcoaching.org/coach-dashboard.html?tab=messages';

function toE164(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (s.startsWith('+')) return s;
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const messageId = body.message_id ? String(body.message_id).trim() : '';
    if (!messageId) return res.status(400).json({ error: 'Missing message_id' });

    const SB_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

    // Authoritative read: the message text + recipient come from the stored row,
    // never from the caller, so this endpoint can't be used to spoof content.
    const mRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_messages`
        + `?id=eq.${encodeURIComponent(messageId)}`
        + `&select=id,sender,sender_name,client_email,message,`
        +   `coach_profiles(display_name,full_name,user_email,coach_phone,booking_sms_alerts_enabled,twilio_phone_number)`
        + `&limit=1`,
      { headers: SB_HEADERS }
    );
    if (!mRes.ok) {
      const t = await mRes.text().catch(() => '');
      console.error('[notify-new-message] message lookup failed', mRes.status, t.slice(0, 300));
      return res.status(502).json({ error: 'message_lookup_failed', status: mRes.status });
    }
    const rows = await mRes.json().catch(() => []);
    const msg = Array.isArray(rows) && rows[0];
    if (!msg) return res.status(404).json({ error: 'message_not_found' });

    // Only client → coach messages trigger a coach notification.
    if (msg.sender !== 'client') {
      return res.status(200).json({ skipped: true, reason: 'not_a_client_message' });
    }

    const coach = msg.coach_profiles || {};
    const coachEmail = coach.user_email || '';
    const coachName = coach.display_name || coach.full_name || 'Coach';
    const clientName = msg.sender_name || msg.client_email || 'A client';
    const messageText = msg.message || '';

    const result = { email: 'skipped', sms: 'skipped' };

    // ── Email via Resend (the primary, expected channel). ──────────────────
    if (coachEmail && RESEND_API_KEY) {
      const subject = `New message from ${clientName}`;
      const text =
        `Hi ${coachName},\n\n` +
        `${clientName} just sent you a message on ineedcoaching.org:\n\n` +
        `"${messageText}"\n\n` +
        `Reply from your dashboard:\n${COACH_DASHBOARD_MESSAGES_URL}\n\n` +
        `The ineedcoaching.org team`;
      const safeName = escapeHtml(clientName);
      const html =
        `<p>Hi ${escapeHtml(coachName)},</p>` +
        `<p><strong>${safeName}</strong> just sent you a message on ineedcoaching.org:</p>` +
        `<blockquote style="margin:0 0 16px;padding:12px 16px;border-left:3px solid #c49a3c;background:#f7f4ee;color:#1a3a52;white-space:pre-wrap;">${escapeHtml(messageText)}</blockquote>` +
        `<p><a href="${COACH_DASHBOARD_MESSAGES_URL}" style="color:#c49a3c;font-weight:600;">Open your messages &rarr;</a></p>` +
        `<p style="color:#6b6b6b;">The ineedcoaching.org team</p>`;
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'ineedcoaching.org <noreply@ineedcoaching.org>',
            to: coachEmail,
            subject,
            text,
            html,
          }),
        });
        if (r.ok) {
          result.email = 'sent';
        } else {
          result.email = 'failed';
          console.error('[notify-new-message] resend failed', r.status, await r.text().catch(() => ''));
        }
      } catch (mailErr) {
        result.email = 'failed';
        console.error('[notify-new-message] resend error', mailErr && mailErr.message);
      }
    } else {
      result.email = coachEmail ? 'no_resend_key' : 'no_coach_email';
    }

    // ── SMS via Twilio (nice-to-have). Consent-gated: only when the coach has
    //    a phone on file AND has SMS alerts enabled. Skips silently otherwise. ─
    const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
    const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
    const PLATFORM_TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER;
    const coachTo = coach.booking_sms_alerts_enabled ? toE164(coach.coach_phone) : '';
    if (coachTo && TWILIO_SID && TWILIO_AUTH && PLATFORM_TWILIO_PHONE) {
      const fromNumber = coach.twilio_phone_number || PLATFORM_TWILIO_PHONE;
      const snippet = messageText.length > 240 ? `${messageText.slice(0, 237)}...` : messageText;
      const smsBody = `New message from ${clientName} on ineedcoaching.org: "${snippet}" — reply: ${COACH_DASHBOARD_MESSAGES_URL}`;
      try {
        const tw = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: coachTo, From: fromNumber, Body: smsBody }),
        });
        if (tw.ok) {
          result.sms = 'sent';
        } else {
          result.sms = 'failed';
          const twData = await tw.json().catch(() => ({}));
          console.error('[notify-new-message] twilio failed', tw.status, twData && twData.message);
        }
      } catch (smsErr) {
        result.sms = 'failed';
        console.error('[notify-new-message] twilio error', smsErr && smsErr.message);
      }
    }

    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error('[notify-new-message] error', e);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
