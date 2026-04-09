// Server-side endpoint to fetch a check-in by token (public, no auth required)
// GET /api/get-checkin?token=ci_xxx

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) {
    console.error('[get-checkin] SUPABASE_SERVICE_ROLE_KEY not set');
    return res.status(500).json({ error: 'Server not configured' });
  }

  const token = req.query.token;
  if (!token) return res.status(400).json({ error: 'Missing token parameter' });

  console.log('[get-checkin] Looking up token:', token);

  try {
    // Fetch the checkin response record
    const ciRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_checkin_responses?token=eq.${encodeURIComponent(token)}&submitted_at=is.null&select=id,client_name,client_email,form_id,submitted_at`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const checkins = await ciRes.json();
    console.log('[get-checkin] Checkin query result:', checkins?.length || 0, 'records');

    if (!checkins || !checkins.length) {
      return res.status(404).json({ error: 'Check-in not found or already submitted' });
    }

    const checkin = checkins[0];

    // Fetch the form questions
    console.log('[get-checkin] Fetching form:', checkin.form_id);
    const formRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_intake_forms?id=eq.${checkin.form_id}&select=name,questions`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const forms = await formRes.json();

    if (!forms || !forms.length) {
      console.error('[get-checkin] Form not found:', checkin.form_id);
      return res.status(404).json({ error: 'Form not found' });
    }

    return res.status(200).json({
      id: checkin.id,
      clientName: checkin.client_name,
      formName: forms[0].name || 'Pre-Session Check-in',
      questions: forms[0].questions || []
    });
  } catch (e) {
    console.error('[get-checkin] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
