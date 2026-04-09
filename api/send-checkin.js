// Server-side endpoint for sending pre-session check-ins
// POST { bookingId, formId, clientEmail, clientName, coachId }
// Creates coach_checkin_responses record + sends email via /api/send-email

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) {
    console.error('[send-checkin] SUPABASE_SERVICE_ROLE_KEY not set');
    return res.status(500).json({ error: 'Server not configured' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { bookingId, formId, clientEmail, clientName, coachId } = body;
    console.log('[send-checkin] Input:', { bookingId, formId, clientEmail, clientName, coachId });

    if (!formId || !clientEmail || !coachId) {
      return res.status(400).json({ error: 'Missing required fields: formId, clientEmail, coachId' });
    }

    // Fetch the form to get its name
    console.log('[send-checkin] Fetching form:', formId);
    const formRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_intake_forms?id=eq.${formId}&select=name,questions`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const forms = await formRes.json();
    if (!forms || !forms.length) {
      console.error('[send-checkin] Form not found:', formId);
      return res.status(404).json({ error: 'Form not found' });
    }
    const formName = forms[0].name || 'Pre-Session Check-in';
    console.log('[send-checkin] Form found:', formName);

    // Fetch coach name
    console.log('[send-checkin] Fetching coach:', coachId);
    const coachRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${coachId}&select=display_name,full_name`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const coaches = await coachRes.json();
    const coachName = (coaches && coaches[0]) ? (coaches[0].display_name || coaches[0].full_name || 'Your Coach') : 'Your Coach';
    console.log('[send-checkin] Coach:', coachName);

    // Generate unique token
    const token = 'ci_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 12);
    console.log('[send-checkin] Generated token:', token);

    // Insert checkin response record
    console.log('[send-checkin] Inserting checkin response...');
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/coach_checkin_responses`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        booking_id: bookingId || null,
        coach_id: coachId,
        client_email: clientEmail,
        client_name: clientName || null,
        form_id: formId,
        token: token
      })
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error('[send-checkin] INSERT failed:', insertRes.status, errText);
      return res.status(500).json({ error: 'Failed to create check-in record', details: errText });
    }

    const inserted = await insertRes.json();
    console.log('[send-checkin] Insert success:', inserted[0]?.id);

    // Build check-in URL
    const origin = req.headers.host ? `https://${req.headers.host}` : 'https://www.ineedcoaching.org';
    const checkinUrl = `${origin}/checkin.html?token=${token}`;
    console.log('[send-checkin] Check-in URL:', checkinUrl);

    // Send email
    console.log('[send-checkin] Sending email to:', clientEmail);
    try {
      const emailRes = await fetch(`${origin}/api/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: clientEmail,
          subject: `${coachName} sent you a pre-session check-in`,
          html: `<div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#1a3a52;">
            <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:1.6rem;color:#1a3a52;margin-bottom:16px;">${formName}</h1>
            <p style="font-size:0.95rem;line-height:1.6;color:#6b6b60;">Hi ${clientName || 'there'},</p>
            <p style="font-size:0.95rem;line-height:1.6;color:#6b6b60;">${coachName} has sent you a pre-session check-in. Please take a few minutes to fill it out before your session.</p>
            <div style="margin:24px 0;"><a href="${checkinUrl}" style="display:inline-block;background:#c49a3c;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:0.95rem;">Complete Check-in</a></div>
            <p style="font-size:0.82rem;color:#6b6b60;">Or copy this link: <a href="${checkinUrl}" style="color:#c49a3c;">${checkinUrl}</a></p>
            <p style="font-size:0.82rem;color:#6b6b60;margin-top:24px;">— <a href="https://www.ineedcoaching.org" style="color:#c49a3c;text-decoration:none;font-weight:600;">ineedcoaching.org</a></p>
          </div>`
        })
      });
      const emailData = await emailRes.json();
      console.log('[send-checkin] Email result:', emailRes.status, emailData);
    } catch (emailErr) {
      console.warn('[send-checkin] Email send failed (non-fatal):', emailErr.message);
    }

    return res.status(200).json({
      success: true,
      token: token,
      checkinUrl: checkinUrl,
      formName: formName
    });
  } catch (e) {
    console.error('[send-checkin] Unhandled error:', e);
    return res.status(500).json({ error: e.message });
  }
}
