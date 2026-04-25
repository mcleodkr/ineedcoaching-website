// POST { plan_id }
// Marks an intervention plan locked. After lock, /api/revise-intervention-plan
// is rejected (use intervention-plan-section for inline edits or
// regenerate-intervention-plan-from-scratch for a new version).

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
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { plan_id } = body;
    if (!plan_id) return res.status(400).json({ error: 'Missing required field: plan_id' });

    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

    const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/intervention_plans?id=eq.${plan_id}&status=eq.draft`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'locked', locked_at: new Date().toISOString() }),
    });
    if (!patchRes.ok) {
      const err = await patchRes.text();
      console.error('[lock-intervention-plan] PATCH failed:', err);
      return res.status(500).json({ error: 'Failed to lock plan', detail: err.slice(0, 400) });
    }
    const rows = await patchRes.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({ error: 'Plan not found or already locked' });
    }
    return res.status(200).json(rows[0]);
  } catch (e) {
    console.error('[lock-intervention-plan] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
