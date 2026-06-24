// Server-side endpoint for sending an intake form to a client.
// Ports the proven send-checkin flow onto intake (separate instrument, separate table).
// POST { formId, coachId, clientEmail?, clientName?, bookingId? }
// Creates a coach_intake_responses record (token-based) and, when an email is
// provided, sends the client a magic link. Returns a single shareable intakeUrl.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) {
    console.error('[send-intake] SUPABASE_SERVICE_ROLE_KEY not set');
    return res.status(500).json({ error: 'Server not configured' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { formId, coachId, clientEmail, clientName, bookingId } = body;
    console.log('[send-intake] Input:', { formId, coachId, clientEmail, clientName, bookingId });

    if (!formId || !coachId) {
      return res.status(400).json({ error: 'Missing required fields: formId, coachId' });
    }

    // Fetch the form to get its name (and confirm it exists)
    console.log('[send-intake] Fetching form:', formId);
    const formRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_intake_forms?id=eq.${formId}&select=name,questions`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const forms = await formRes.json();
    if (!forms || !forms.length) {
      console.error('[send-intake] Form not found:', formId);
      return res.status(404).json({ error: 'Form not found' });
    }
    const formName = forms[0].name || 'Intake Form';
    console.log('[send-intake] Form found:', formName);

    // Fetch coach name (for the email)
    const coachRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${coachId}&select=display_name,full_name`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const coaches = await coachRes.json();
    const coachName = (coaches && coaches[0]) ? (coaches[0].display_name || coaches[0].full_name || 'Your Coach') : 'Your Coach';

    // Generate unique token (in_ prefix distinguishes intake from ci_ check-ins)
    const token = 'in_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 12);
    console.log('[send-intake] Generated token:', token);

    // Insert intake response record (responses stay empty until the client submits)
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/coach_intake_responses`, {
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
        client_email: clientEmail || null,
        client_name: clientName || null,
        form_id: formId,
        token: token
      })
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error('[send-intake] INSERT failed:', insertRes.status, errText);
      return res.status(500).json({ error: 'Failed to create intake record', details: errText });
    }

    const inserted = await insertRes.json();
    console.log('[send-intake] Insert success:', inserted[0]?.id);

    // Build intake URL
    const origin = req.headers.host ? `https://${req.headers.host}` : 'https://www.ineedcoaching.org';
    const intakeUrl = `${origin}/intake.html?token=${token}`;
    console.log('[send-intake] Intake URL:', intakeUrl);

    // Send email only when a client email was supplied (Copy-link flow skips this)
    if (clientEmail) {
      try {
        const emailRes = await fetch(`${origin}/api/send-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: clientEmail,
            subject: `${coachName} sent you an intake form`,
            html: `<div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#1a3a52;">
              <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:1.6rem;color:#1a3a52;margin-bottom:16px;">Welcome — let's get started</h1>
              <p style="font-size:0.95rem;line-height:1.6;color:#6b6b60;">Hi ${clientName || 'there'},</p>
              <p style="font-size:0.95rem;line-height:1.6;color:#6b6b60;">Before we begin working together, I'd love to learn more about you. This intake helps me understand where you're starting from so our time together is focused on what matters most to you.</p>
              <div style="margin:24px 0;"><a href="${intakeUrl}" style="display:inline-block;background:#c49a3c;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:0.95rem;">Complete Intake</a></div>
              <p style="font-size:0.95rem;line-height:1.6;color:#1a3a52;margin-top:28px;">— ${coachName}</p>
            </div>`
          })
        });
        const emailData = await emailRes.json();
        console.log('[send-intake] Email result:', emailRes.status, emailData);
      } catch (emailErr) {
        console.warn('[send-intake] Email send failed (non-fatal):', emailErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      token: token,
      intakeUrl: intakeUrl,
      formName: formName
    });
  } catch (e) {
    console.error('[send-intake] Unhandled error:', e);
    return res.status(500).json({ error: e.message });
  }
}
