// POST { ids: string[] }  or  GET ?ids=uuid,uuid,...
// Brief 2b: Cached read endpoint for canonical pattern definitions used by
// the hover-to-define tooltip across coach-facing surfaces. Returns
// canonical_name + definition + domain + status for each requested id.
//
// Authenticated coaches can read; pattern_taxonomy RLS already permits.

const ALLOWED_STATUSES = ['canonical', 'candidate'];
const MAX_IDS = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Hover tooltips can stand to be cached for a while — definitions change rarely.
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  let rawIds = [];
  if (req.method === 'POST') {
    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    rawIds = Array.isArray(body.ids) ? body.ids : [];
  } else {
    const idsParam = (req.query && req.query.ids) || '';
    rawIds = String(idsParam).split(',').map(s => s.trim()).filter(Boolean);
  }

  const ids = Array.from(new Set(rawIds.filter(id => typeof id === 'string' && UUID_RE.test(id)))).slice(0, MAX_IDS);
  if (ids.length === 0) return res.status(200).json({ definitions: [] });

  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
  const idList = ids.map(id => `"${id}"`).join(',');

  try {
    const lookupRes = await fetch(
      `${SUPABASE_URL}/rest/v1/pattern_taxonomy?id=in.(${idList})&status=in.(${ALLOWED_STATUSES.map(s => `"${s}"`).join(',')})&select=id,canonical_name,definition,domain,status`,
      { headers }
    );
    if (!lookupRes.ok) {
      const t = await lookupRes.text().catch(() => '');
      console.error('[pattern-definitions] lookup failed', { status: lookupRes.status, body: t.slice(0, 200) });
      return res.status(500).json({ error: 'Lookup failed' });
    }
    const rows = await lookupRes.json();
    const definitions = Array.isArray(rows) ? rows.map(r => ({
      id: r.id,
      canonical_name: r.canonical_name,
      definition: r.definition || '',
      domain: r.domain,
      status: r.status,
    })) : [];
    return res.status(200).json({ definitions });
  } catch (e) {
    console.error('[pattern-definitions] threw', { message: e.message });
    return res.status(500).json({ error: 'Internal error' });
  }
}
