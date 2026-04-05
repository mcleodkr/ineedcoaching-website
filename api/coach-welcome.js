export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { email, display_name, slug } = body;
    if (!email) return res.status(400).json({ error: 'Missing email' });

    const name = display_name || 'Coach';
    const profileUrl = `https://www.ineedcoaching.org/coach/${slug || ''}`;
    const dashboardUrl = 'https://www.ineedcoaching.org/coach-dashboard.html';

    const subject = `Welcome to ineedcoaching.org, ${name}!`;
    const emailBody = `Hi ${name},\n\nYour profile is live: ${profileUrl}\n\nManage your practice: ${dashboardUrl}\n\nGetting started:\n1. Complete your profile with a photo and bio\n2. Add your services and pricing\n3. Set your availability or connect Calendly\n4. Create an intake form for new clients\n5. Share your profile link to start getting bookings\n\nThe ineedcoaching.org team`;

    console.log('=== COACH WELCOME EMAIL ===');
    console.log('To:', email);
    console.log('Subject:', subject);
    console.log('Body:', emailBody);

    return res.status(200).json({ sent: true, to: email, subject });
  } catch (e) {
    console.error('coach-welcome error:', e);
    return res.status(500).json({ error: e.message });
  }
}
