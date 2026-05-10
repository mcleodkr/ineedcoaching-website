// Sent when a provider clicks "I Can Help" on find-a-match.html and
// submits a response to a Coaching Commons request. Notifies the
// explorer (request poster) by email so they know to check their
// dashboard. The provider's note itself is NOT included inline — it
// lives on the dashboard alongside the provider's full profile so the
// explorer reads it in context.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured: SUPABASE_SERVICE_ROLE_KEY missing' });
  if (!RESEND_API_KEY) return res.status(500).json({ error: 'Server not configured: RESEND_API_KEY missing' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { request_id, response_id } = body || {};
    if (!request_id || !response_id) {
      return res.status(400).json({ error: 'Missing required fields: request_id, response_id' });
    }

    const reqLookup = await fetch(
      `${SUPABASE_URL}/rest/v1/explorer_requests?id=eq.${encodeURIComponent(request_id)}&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!reqLookup.ok) {
      const errText = await reqLookup.text().catch(() => '');
      console.error('[match-notification] explorer_requests lookup failed', reqLookup.status, errText);
      return res.status(500).json({ error: 'Request lookup failed' });
    }
    const requests = await reqLookup.json();
    if (!Array.isArray(requests) || !requests.length) {
      return res.status(404).json({ error: 'Request not found' });
    }
    const request = requests[0];

    const respLookup = await fetch(
      `${SUPABASE_URL}/rest/v1/explorer_responses?id=eq.${encodeURIComponent(response_id)}&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!respLookup.ok) {
      const errText = await respLookup.text().catch(() => '');
      console.error('[match-notification] explorer_responses lookup failed', respLookup.status, errText);
      return res.status(500).json({ error: 'Response lookup failed' });
    }
    const responses = await respLookup.json();
    if (!Array.isArray(responses) || !responses.length) {
      return res.status(404).json({ error: 'Response not found' });
    }

    const email = request.user_email;
    if (!email) return res.status(400).json({ error: 'Request has no user_email' });

    const name = (request.display_name && String(request.display_name).trim()) || 'there';

    const subject = 'Your request just got a response from a provider who wants to help';
    const text =
      `Hi ${name},\n\n` +
      `Good news. A provider just responded to the request you posted on The Coaching Commons. They read what you shared and think they might be able to help.\n\n` +
      `Head over to your dashboard to see who they are. You'll be able to read their full profile, get a sense of how they work, and see the note they sent you. If something feels right, you can message them directly from there. If it's not the right fit, no pressure at all. Others may still respond, and you can keep things at your own pace.\n\n` +
      `See your responses: https://www.ineedcoaching.org/client-dashboard.html\n\n` +
      `Reaching out for support is a real step, and posting your request was part of that. Whatever you decide from here, whether you message a provider, wait for more responses, or just sit with it for a bit, your dashboard will be waiting whenever you're ready.\n\n` +
      `Warmly,\n` +
      `The ineedcoaching.org team`;

    const sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'The ineedcoaching.org team <hello@ineedcoaching.org>',
        to: email,
        subject,
        text
      })
    });

    const data = await sendRes.json().catch(() => ({}));
    if (!sendRes.ok) {
      console.error('[match-notification] Resend error', sendRes.status, JSON.stringify(data));
      return res.status(500).json({ error: 'Email send failed', detail: data });
    }

    return res.status(200).json({ sent: true, to: email, id: data.id });
  } catch (e) {
    console.error('match-notification error:', e);
    return res.status(500).json({ error: e.message });
  }
}
