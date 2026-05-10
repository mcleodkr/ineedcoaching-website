// Sent when an explorer clicks "I choose you" on a coach response in the
// Coaching Commons (client-dashboard.html chooseProvider). Notifies the
// coach by email so they know to log in and confirm availability — at
// which point /api/match-confirmed-notification fires the other direction.
// Body introduces Coach Clarity as the AI support layer that activates
// after the first session.

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

    const supaHeaders = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

    const respLookup = await fetch(
      `${SUPABASE_URL}/rest/v1/explorer_responses?id=eq.${encodeURIComponent(response_id)}&select=*`,
      { headers: supaHeaders }
    );
    if (!respLookup.ok) {
      const errText = await respLookup.text().catch(() => '');
      console.error('[match-chosen] explorer_responses lookup failed', respLookup.status, errText);
      return res.status(500).json({ error: 'Response lookup failed' });
    }
    const responses = await respLookup.json();
    if (!Array.isArray(responses) || !responses.length) {
      return res.status(404).json({ error: 'Response not found' });
    }
    const response = responses[0];

    const reqLookup = await fetch(
      `${SUPABASE_URL}/rest/v1/explorer_requests?id=eq.${encodeURIComponent(request_id)}&select=*`,
      { headers: supaHeaders }
    );
    if (!reqLookup.ok) {
      const errText = await reqLookup.text().catch(() => '');
      console.error('[match-chosen] explorer_requests lookup failed', reqLookup.status, errText);
      return res.status(500).json({ error: 'Request lookup failed' });
    }
    const requests = await reqLookup.json();
    if (!Array.isArray(requests) || !requests.length) {
      return res.status(404).json({ error: 'Request not found' });
    }
    const request = requests[0];

    const coachEmail = response.provider_email;
    if (!coachEmail) return res.status(400).json({ error: 'Response has no provider_email' });

    let coachDisplayName = null;
    try {
      const coachLookup = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_profiles?user_email=eq.${encodeURIComponent(coachEmail.toLowerCase())}&select=display_name,full_name&limit=1`,
        { headers: supaHeaders }
      );
      if (coachLookup.ok) {
        const rows = await coachLookup.json();
        if (Array.isArray(rows) && rows[0]) {
          coachDisplayName = (rows[0].display_name && String(rows[0].display_name).trim())
            || (rows[0].full_name && String(rows[0].full_name).trim())
            || null;
        }
      }
    } catch (e) { /* coach_profiles miss is non-fatal — fall through to provider_name */ }

    const coachName = coachDisplayName
      || (response.provider_name && String(response.provider_name).trim())
      || 'there';
    const coachFirstName = coachName.split(/\s+/)[0] || 'there';

    const explorerName = (request.display_name && String(request.display_name).trim()) || 'Someone';

    const subject = 'Someone chose you. They want to work with you.';
    const text =
      `Hi ${coachFirstName},\n\n` +
      `Real news. ${explorerName} just chose you from the responses they received. They're ready to work with you, and they're waiting for you to confirm you're available.\n\n` +
      `Confirm availability: https://www.ineedcoaching.org/coach-dashboard.html\n\n` +
      `What happens once you confirm: this isn't just a lead. The moment you start working with this client, Coach Clarity activates as your support layer. After your first session, you'll get a Coaching Mirror reflection on what actually happened, post-session intelligence on patterns and breakthroughs, and an Approach Lab that surfaces alternative angles you could try next time. Over time, Coach Clarity builds a picture of how you coach (your Coach DNA) and how this client moves (their pattern map), so every session you run gets sharper than the last.\n\n` +
      `You always take the lead. Coach Clarity supports you showing up prepared with deeper insight for every session.\n\n` +
      `Someone read your note, looked at your profile, and decided you might be the one. That trust matters.\n\n` +
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
        to: coachEmail,
        subject,
        text
      })
    });

    const data = await sendRes.json().catch(() => ({}));
    if (!sendRes.ok) {
      console.error('[match-chosen] Resend error', sendRes.status, JSON.stringify(data));
      return res.status(500).json({ error: 'Email send failed', detail: data });
    }

    return res.status(200).json({ sent: true, to: coachEmail, id: data.id });
  } catch (e) {
    console.error('match-chosen-notification error:', e);
    return res.status(500).json({ error: e.message });
  }
}
