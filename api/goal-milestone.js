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
    const { goal_id } = body;
    if (!goal_id) return res.status(400).json({ error: 'Missing goal_id' });

    const gRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coaching_goals?id=eq.${goal_id}&select=*,coach_profiles(display_name)`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const goals = await gRes.json();
    if (!goals.length) return res.status(404).json({ error: 'Goal not found' });

    const goal = goals[0];
    const clientName = goal.client_name || goal.client_email;
    const coachName = goal.coach_profiles?.display_name || 'your coach';
    const goalTitle = goal.title || 'your goal';

    const subject = `You completed a goal with ${coachName}`;
    const emailBody = `Hi ${clientName},\n\nYou and ${coachName} set a goal together: ${goalTitle}.\n\nYou just marked it complete.\n\nProgress in coaching is not always visible from the inside. This is a moment worth recognizing — you followed through.\n\nhttps://www.ineedcoaching.org/client-portal.html\n\nThe ineedcoaching.org team`;

    console.log('=== GOAL MILESTONE EMAIL ===');
    console.log('To:', goal.client_email);
    console.log('Subject:', subject);
    console.log('Body:', emailBody);

    return res.status(200).json({ sent: true, to: goal.client_email, subject });
  } catch (e) {
    console.error('goal-milestone error:', e);
    return res.status(500).json({ error: e.message });
  }
}
