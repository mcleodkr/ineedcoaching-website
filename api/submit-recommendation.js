// POST { recommendationId, recommenderName, recommenderTitle, recommenderCompany, howYouKnow, content, allowName }

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
    const { recommendationId, recommenderName, recommenderTitle, recommenderCompany, howYouKnow, content, allowName } = body;
    if (!recommendationId || !content) return res.status(400).json({ error: 'Missing required fields' });

    const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/coach_recommendations?id=eq.${recommendationId}`, {
      method: 'PATCH',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        recommender_name: recommenderName || null, recommender_title: recommenderTitle || null,
        recommender_company: recommenderCompany || null, relationship: howYouKnow || null,
        content: content, allow_name: allowName !== false, status: 'submitted', is_approved: false
      })
    });
    if (!patchRes.ok) { const err = await patchRes.text(); return res.status(500).json({ error: err }); }

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('[submit-recommendation] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
