// GET /api/get-testimonial?token=tm_xxx
// Public endpoint — fetches testimonial request by token

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  const token = req.query.token;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  try {
    const ciRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_testimonials?token=eq.${encodeURIComponent(token)}&status=eq.pending&select=id,coach_id,client_name,personal_note,coach_profiles(display_name,full_name,photo_url)`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const data = await ciRes.json();
    if (!data || !data.length) return res.status(404).json({ error: 'Testimonial request not found or already submitted' });

    const t = data[0];
    const coach = t.coach_profiles || {};
    return res.status(200).json({
      id: t.id,
      clientName: t.client_name,
      personalNote: t.personal_note,
      coachName: coach.display_name || coach.full_name || 'Your Coach',
      coachPhoto: coach.photo_url || null
    });
  } catch (e) {
    console.error('[get-testimonial] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
