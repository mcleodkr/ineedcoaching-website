// Public read-only counter for the founder cohort.
//
// GET /api/founder-cohort-status
//   → { claimed: 12, cap: 50, remaining: 38, is_full: false }
//
// Powers the "X of 50 spots claimed" badge on /founding-coaches.html.
// Uses the Supabase REST API's count=exact prefer header (HEAD request — no
// body downloaded) so the call is cheap and cacheable. Service-role key is
// used so we don't depend on permissive RLS on coach_profiles for an
// unauthenticated read.

const FOUNDER_COHORT_CAP = 50;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) {
    console.error('[founder-cohort-status] no supabase key configured');
    return res.status(500).json({ error: 'Server not configured' });
  }

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_profiles?signup_source=eq.founding_cohort&select=id`,
      {
        method: 'HEAD',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: 'count=exact',
        },
      },
    );
    if (!r.ok) {
      console.error('[founder-cohort-status] supabase non-ok', r.status);
      return res.status(500).json({ error: 'Failed to fetch count' });
    }
    // Content-Range header format: "0-0/N" where N is the total count.
    const contentRange = r.headers.get('content-range') || '0-0/0';
    const total = parseInt(contentRange.split('/')[1] || '0', 10);
    const claimed = Number.isFinite(total) ? total : 0;
    return res.status(200).json({
      claimed,
      cap: FOUNDER_COHORT_CAP,
      remaining: Math.max(0, FOUNDER_COHORT_CAP - claimed),
      is_full: claimed >= FOUNDER_COHORT_CAP,
    });
  } catch (e) {
    console.error('[founder-cohort-status] threw', e && e.message);
    return res.status(500).json({ error: 'Failed' });
  }
}
