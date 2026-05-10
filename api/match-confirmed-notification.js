// Sent when a coach clicks "Confirm I'm available" on the My Outreach tab
// of coach-dashboard.html. Notifies the explorer that the match is real
// and they can now reach the coach by email or book a session.
// Subject falls back to "Your coach confirmed..." when coach name
// resolution misses entirely (no coach_profiles row, no provider_name on
// the response) so the explorer never sees an awkward "There confirmed."

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

    const reqLookup = await fetch(
      `${SUPABASE_URL}/rest/v1/explorer_requests?id=eq.${encodeURIComponent(request_id)}&select=*`,
      { headers: supaHeaders }
    );
    if (!reqLookup.ok) {
      const errText = await reqLookup.text().catch(() => '');
      console.error('[match-confirmed] explorer_requests lookup failed', reqLookup.status, errText);
      return res.status(500).json({ error: 'Request lookup failed' });
    }
    const requests = await reqLookup.json();
    if (!Array.isArray(requests) || !requests.length) {
      return res.status(404).json({ error: 'Request not found' });
    }
    const request = requests[0];

    const respLookup = await fetch(
      `${SUPABASE_URL}/rest/v1/explorer_responses?id=eq.${encodeURIComponent(response_id)}&select=*`,
      { headers: supaHeaders }
    );
    if (!respLookup.ok) {
      const errText = await respLookup.text().catch(() => '');
      console.error('[match-confirmed] explorer_responses lookup failed', respLookup.status, errText);
      return res.status(500).json({ error: 'Response lookup failed' });
    }
    const responses = await respLookup.json();
    if (!Array.isArray(responses) || !responses.length) {
      return res.status(404).json({ error: 'Response not found' });
    }
    const response = responses[0];

    const explorerEmail = request.user_email;
    if (!explorerEmail) return res.status(400).json({ error: 'Request has no user_email' });

    let coachDisplayName = null;
    if (response.provider_email) {
      try {
        const coachLookup = await fetch(
          `${SUPABASE_URL}/rest/v1/coach_profiles?user_email=eq.${encodeURIComponent(response.provider_email.toLowerCase())}&select=display_name,full_name&limit=1`,
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
      } catch (e) { /* coach_profiles miss is non-fatal */ }
    }

    const resolvedCoachName = coachDisplayName
      || (response.provider_name && String(response.provider_name).trim())
      || null;
    const coachName = resolvedCoachName || 'there';
    const coachFirstName = coachName.split(/\s+/)[0] || 'there';

    const explorerName = (request.display_name && String(request.display_name).trim()) || 'there';

    // Subject fallback: when the coach name resolution misses entirely we
    // would otherwise produce "There confirmed. You have a match." Swap to a
    // cleaner generic line. Body greeting "Hi there," can stay because that
    // refers to the EXPLORER, not the coach.
    const subject = resolvedCoachName
      ? `${coachFirstName} confirmed. You have a match.`
      : 'Your coach confirmed. You have a match.';

    const text =
      `Hi ${explorerName},\n\n` +
      `Good news. ${coachName} just confirmed they're available to work with you. The match is real.\n\n` +
      `From here, you and ${coachFirstName} can connect directly. Head to your dashboard to see how to reach out, book a session, or just say hello.\n\n` +
      `Take the next step: https://www.ineedcoaching.org/client-dashboard.html\n\n` +
      `You posted a request, you read the response, you chose someone. That took something. The hardest part is behind you. The conversation can begin whenever you're ready.\n\n` +
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
        to: explorerEmail,
        subject,
        text
      })
    });

    const data = await sendRes.json().catch(() => ({}));
    if (!sendRes.ok) {
      console.error('[match-confirmed] Resend error', sendRes.status, JSON.stringify(data));
      return res.status(500).json({ error: 'Email send failed', detail: data });
    }

    return res.status(200).json({ sent: true, to: explorerEmail, id: data.id });
  } catch (e) {
    console.error('match-confirmed-notification error:', e);
    return res.status(500).json({ error: e.message });
  }
}
