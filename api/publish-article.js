// POST { articleId, coachId }
// PATCHes article to published using service role key

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
    const { articleId, coachId } = body;
    if (!articleId || !coachId) return res.status(400).json({ error: 'Missing articleId or coachId' });

    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/articles?id=eq.${articleId}&author_coach_id=eq.${coachId}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          is_published: true,
          published_at: new Date().toISOString()
        })
      }
    );

    if (!patchRes.ok) {
      const err = await patchRes.text();
      console.error('[publish-article] PATCH failed:', patchRes.status, err);
      return res.status(500).json({ error: 'Failed to publish', details: err });
    }

    console.log('[publish-article] Published article:', articleId);
    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('[publish-article] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
