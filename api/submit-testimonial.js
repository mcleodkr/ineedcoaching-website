// POST { testimonialId, whatChanged, recommendation, coachDescription, allowName, rating, clientName }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { testimonialId, whatChanged, recommendation, coachDescription, allowName, rating, clientName } = body;
    if (!testimonialId) return res.status(400).json({ error: 'Missing testimonialId' });

    // Build content from the structured fields for backwards compat
    const content = [whatChanged, recommendation].filter(Boolean).join('\n\n');

    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_testimonials?id=eq.${testimonialId}`,
      {
        method: 'PATCH',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          what_changed: whatChanged || null,
          recommendation: recommendation || null,
          coach_description: coachDescription || null,
          allow_name: allowName !== false,
          rating: rating || null,
          client_name: clientName || null,
          content: content,
          status: 'submitted',
          is_approved: false
        })
      }
    );
    if (!patchRes.ok) {
      const err = await patchRes.text();
      return res.status(500).json({ error: 'Failed to save', details: err });
    }

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('[submit-testimonial] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
