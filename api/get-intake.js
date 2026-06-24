// Server-side endpoint to fetch an intake by token (public, no auth required).
// Ports get-checkin onto intake. GET /api/get-intake?token=in_xxx

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) {
    console.error('[get-intake] SUPABASE_SERVICE_ROLE_KEY not set');
    return res.status(500).json({ error: 'Server not configured' });
  }

  const token = req.query.token;
  if (!token) return res.status(400).json({ error: 'Missing token parameter' });

  console.log('[get-intake] Looking up token:', token);

  try {
    // Fetch the intake response record (only if not yet submitted)
    const inRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_intake_responses?token=eq.${encodeURIComponent(token)}&submitted_at=is.null&select=id,client_name,client_email,form_id,submitted_at`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const intakes = await inRes.json();
    console.log('[get-intake] Intake query result:', intakes?.length || 0, 'records');

    if (!intakes || !intakes.length) {
      return res.status(404).json({ error: 'Intake not found or already submitted' });
    }

    const intake = intakes[0];

    // Fetch the form questions
    console.log('[get-intake] Fetching form:', intake.form_id);
    const formRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_intake_forms?id=eq.${intake.form_id}&select=name,questions`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const forms = await formRes.json();

    if (!forms || !forms.length) {
      console.error('[get-intake] Form not found:', intake.form_id);
      return res.status(404).json({ error: 'Form not found' });
    }

    return res.status(200).json({
      id: intake.id,
      clientName: intake.client_name,
      clientEmail: intake.client_email,
      formName: forms[0].name || 'Intake Form',
      questions: forms[0].questions || []
    });
  } catch (e) {
    console.error('[get-intake] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
