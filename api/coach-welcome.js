// Branded onboarding email for newly-paid coaches. Sent from the Stripe
// webhook after Supabase auth provisioning. Distinct from the Supabase
// recovery email (which carries the sign-in link); this email carries the
// profile URL, dashboard URL, and getting-started checklist.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { email, display_name, slug } = body || {};
    if (!email) return res.status(400).json({ error: 'Missing email' });

    const name = display_name || 'Coach';
    const profileUrl = `https://www.ineedcoaching.org/coach/${slug || ''}`;
    const dashboardUrl = 'https://www.ineedcoaching.org/coach-dashboard.html';

    const subject = `Welcome to ineedcoaching.org, ${name}!`;
    const text =
      `Hi ${name},\n\n` +
      `Welcome to ineedcoaching.org. Your coach profile is live at ${profileUrl}\n\n` +
      `You'll also receive a separate email from us with a link to set your password — that's how you sign in to your dashboard for the first time. ` +
      `Once you're in, manage your practice here: ${dashboardUrl}\n\n` +
      `Getting started:\n` +
      `1. Complete your profile with a photo and bio\n` +
      `2. Add your services and pricing\n` +
      `3. Set your availability or connect Calendly\n` +
      `4. Create an intake form for new clients\n` +
      `5. Share your profile link to start getting bookings\n\n` +
      `The ineedcoaching.org team`;

    const origin = req.headers.host ? `https://${req.headers.host}` : 'https://www.ineedcoaching.org';
    const sendRes = await fetch(`${origin}/api/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: email, subject, text }),
    });
    if (!sendRes.ok) {
      const errText = await sendRes.text().catch(() => '');
      console.error('[coach-welcome] send-email failed', sendRes.status, errText);
      return res.status(500).json({ error: 'send-email failed', status: sendRes.status });
    }

    const data = await sendRes.json().catch(() => ({}));
    return res.status(200).json({ sent: true, to: email, subject, id: data.id });
  } catch (e) {
    console.error('coach-welcome error:', e);
    return res.status(500).json({ error: e.message });
  }
}
