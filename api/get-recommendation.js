// GET /api/get-recommendation?token=rc_xxx

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  const token = req.query.token;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_recommendations?token=eq.${encodeURIComponent(token)}&status=eq.pending&select=id,recommender_name,recommender_title,recommender_company,personal_note,coach_profiles(display_name,full_name,photo_url)`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const data = await r.json();
    if (!data || !data.length) return res.status(404).json({ error: 'Not found or already submitted' });

    const rec = data[0];
    const coach = rec.coach_profiles || {};
    return res.status(200).json({
      id: rec.id,
      recommenderName: rec.recommender_name,
      recommenderTitle: rec.recommender_title,
      recommenderCompany: rec.recommender_company,
      personalNote: rec.personal_note,
      coachName: coach.display_name || coach.full_name || 'This Coach',
      coachPhoto: coach.photo_url || null
    });
  } catch (e) {
    console.error('[get-recommendation] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
