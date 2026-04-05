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
    const { coach_id, client_email } = body;
    if (!coach_id || !client_email) {
      return res.status(400).json({ error: 'Missing required fields: coach_id, client_email' });
    }

    const cRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${coach_id}&select=display_name,user_email`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const coaches = await cRes.json();
    if (!coaches.length) return res.status(404).json({ error: 'Coach not found' });

    const coachName = coaches[0].display_name || 'Coach';
    const coachEmail = coaches[0].user_email;
    const clientName = client_email;

    const subject = `${clientName} completed their intake form`;
    const emailBody = `Hi ${coachName},\n\n${clientName} has submitted their intake form ahead of your session.\n\nTheir responses are ready for you to review in your dashboard. Going in prepared makes a difference — for both of you.\n\nhttps://www.ineedcoaching.org/coach-dashboard.html\n\nThe ineedcoaching.org team`;

    console.log('=== INTAKE SUBMITTED EMAIL ===');
    console.log('To:', coachEmail);
    console.log('Subject:', subject);
    console.log('Body:', emailBody);

    return res.status(200).json({ sent: true, to: coachEmail, subject });
  } catch (e) {
    console.error('intake-submitted error:', e);
    return res.status(500).json({ error: e.message });
  }
}
