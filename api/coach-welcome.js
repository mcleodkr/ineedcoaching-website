export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { email, display_name, slug } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });

  const profileUrl = 'https://www.ineedcoaching.org/coach/' + (slug || '');
  const dashboardUrl = 'https://www.ineedcoaching.org/coach-dashboard.html';

  console.log('WELCOME EMAIL to:', email);
  console.log('Subject: Welcome to ineedcoaching.org, ' + (display_name || 'Coach') + '!');
  console.log('Body:');
  console.log('Your profile is live at:', profileUrl);
  console.log('Manage your practice at:', dashboardUrl);
  console.log('Getting started:');
  console.log('1. Complete your profile with a photo and bio');
  console.log('2. Add your services and pricing');
  console.log('3. Set your availability or connect Calendly');
  console.log('4. Create an intake form for new clients');
  console.log('5. Share your profile link to start getting bookings');

  return res.status(200).json({ sent: true });
}
