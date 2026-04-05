export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { coach_email } = body;
    if (!coach_email) return res.status(400).json({ error: 'Missing coach_email' });

    const cRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_profiles?user_email=eq.${coach_email}&select=display_name,user_email`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const coaches = await cRes.json();
    const coachName = coaches.length ? coaches[0].display_name || 'Coach' : 'Coach';

    const subject = 'Your referral joined — you have earned a credit';
    const emailBody = `Hi ${coachName},\n\nSomeone you referred just joined ineedcoaching.org.\n\nYour referral credit has been applied to your account.\n\nGreat coaches know great coaches. Thank you for growing this community.\n\nThe ineedcoaching.org team`;

    console.log('=== REFERRAL CREDIT EMAIL ===');
    console.log('To:', coach_email);
    console.log('Subject:', subject);
    console.log('Body:', emailBody);

    return res.status(200).json({ sent: true, to: coach_email, subject });
  } catch (e) {
    console.error('referral-credit error:', e);
    return res.status(500).json({ error: e.message });
  }
}
