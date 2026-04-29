// Phase 4d — monthly usage-counter reset (cron)
//
// Runs daily, resets monthly_client_count and monthly_session_count to 0
// for every active coach whose current_period_end is in the past — i.e.
// their billing period rolled over and they're now in a new period.
//
// Why daily instead of monthly: coach billing cycles aren't month-aligned
// (a coach signing up on the 14th renews on the 14th of every month).
// A monthly cron only catches the narrow window between Stripe's
// renewal and our customer.subscription.updated webhook firing — daily
// gives every coach a same-day reset on their own anniversary.
//
// To switch to strict monthly, change schedule in vercel.json to
// "0 6 1 * *" (06:00 UTC on the 1st).
//
// Auth: requires Authorization: Bearer ${CRON_SECRET}. Vercel Cron sends
// this header automatically when CRON_SECRET is set in the project's env.
// Same pattern as api/process-reminders.js + api/cron-interventions.js.
//
// Audit: writes a structured console log line per run with the count
// reset, the coach IDs, and the run timestamp. Vercel persists these
// logs and they're filterable in the Vercel dashboard. (If a DB-side
// audit table is ever wanted, add a separate migration + insert here.)

export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) {
    console.error('[cron][reset-usage] missing SUPABASE_SERVICE_ROLE_KEY');
    return res.status(500).json({ error: 'Server not configured' });
  }

  // ── Auth ─────────────────────────────────────────────────────────────
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = (req.headers && req.headers.authorization) || '';
    if (auth !== `Bearer ${expected}`) {
      console.warn('[cron][reset-usage] unauthorized');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } else {
    // No secret set — refuse rather than running open. Configuration error
    // is loud, not silent. Set CRON_SECRET in Vercel before scheduling.
    console.error('[cron][reset-usage] CRON_SECRET not configured — refusing to run');
    return res.status(500).json({ error: 'CRON_SECRET not configured' });
  }

  const SB_HEADERS = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };

  const startedAt = new Date().toISOString();

  try {
    // PATCH with PostgREST filter: every active coach whose period_end is
    // strictly in the past. We use return=representation so we get back
    // the rows that were actually updated and can log them for audit.
    //
    // Note: subscription_status='trialing' is NOT included. Trialing
    // coaches don't have a billing-period rollover yet; their counters
    // start at 0 and stay there until Stripe converts them to 'active'.
    const filter =
      'subscription_status=eq.active'
      + '&current_period_end=lt.' + encodeURIComponent(startedAt);
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_profiles?` + filter,
      {
        method: 'PATCH',
        headers: { ...SB_HEADERS, Prefer: 'return=representation' },
        body: JSON.stringify({
          monthly_client_count: 0,
          monthly_session_count: 0,
        }),
      }
    );

    if (!patchRes.ok) {
      const txt = await patchRes.text().catch(() => '');
      console.error('[cron][reset-usage] patch failed', patchRes.status, txt);
      return res.status(500).json({ error: 'Patch failed', detail: txt.slice(0, 200) });
    }

    const rows = await patchRes.json().catch(() => []);
    const resetCount = Array.isArray(rows) ? rows.length : 0;
    const resetIds = Array.isArray(rows) ? rows.map((r) => r.id).filter(Boolean) : [];

    // Structured audit line — one entry per run, includes the coach IDs.
    // Vercel persists this; filter by the [cron][reset-usage] tag.
    console.log('[cron][reset-usage] complete', JSON.stringify({
      started_at: startedAt,
      reset_count: resetCount,
      coach_ids: resetIds,
    }));

    return res.status(200).json({
      ok: true,
      started_at: startedAt,
      reset_count: resetCount,
      coach_ids: resetIds,
    });
  } catch (e) {
    console.error('[cron][reset-usage] error', e && e.message);
    return res.status(500).json({ error: e.message || 'Cron error' });
  }
}
