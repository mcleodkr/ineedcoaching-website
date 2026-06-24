// Server-side endpoint to submit intake responses (public, no auth required).
// Ports submit-checkin onto intake. POST { intakeId, responses, clientName?, clientEmail? }
// clientName/clientEmail are accepted so a generic (form-level) link can capture
// who filled it; per-client links already have these bound and may omit them.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) {
    console.error('[submit-intake] SUPABASE_SERVICE_ROLE_KEY not set');
    return res.status(500).json({ error: 'Server not configured' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { intakeId, responses, clientName, clientEmail } = body;

    if (!intakeId || !responses) {
      return res.status(400).json({ error: 'Missing intakeId or responses' });
    }

    console.log('[submit-intake] Updating intake:', intakeId, 'with', responses.length, 'responses');

    const update = {
      responses: responses,
      submitted_at: new Date().toISOString()
    };
    // Only overwrite identity when the client supplied it (generic-link flow).
    if (clientName) update.client_name = clientName;
    if (clientEmail) update.client_email = clientEmail;

    // Guard against double-submit by scoping the PATCH to un-submitted rows.
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_intake_responses?id=eq.${intakeId}&submitted_at=is.null`,
      {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(update)
      }
    );

    if (!patchRes.ok) {
      const errText = await patchRes.text();
      console.error('[submit-intake] PATCH failed:', patchRes.status, errText);
      return res.status(500).json({ error: 'Failed to save responses' });
    }

    console.log('[submit-intake] Success');
    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('[submit-intake] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
