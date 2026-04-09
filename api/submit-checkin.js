// Server-side endpoint to submit check-in responses (public, no auth required)
// POST { checkinId, responses }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) {
    console.error('[submit-checkin] SUPABASE_SERVICE_ROLE_KEY not set');
    return res.status(500).json({ error: 'Server not configured' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { checkinId, responses } = body;

    if (!checkinId || !responses) {
      return res.status(400).json({ error: 'Missing checkinId or responses' });
    }

    console.log('[submit-checkin] Updating checkin:', checkinId, 'with', responses.length, 'responses');

    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_checkin_responses?id=eq.${checkinId}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          responses: responses,
          submitted_at: new Date().toISOString()
        })
      }
    );

    if (!patchRes.ok) {
      const errText = await patchRes.text();
      console.error('[submit-checkin] PATCH failed:', patchRes.status, errText);
      return res.status(500).json({ error: 'Failed to save responses' });
    }

    console.log('[submit-checkin] Success');
    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('[submit-checkin] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
