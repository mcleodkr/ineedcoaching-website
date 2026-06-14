// lib/effmap-limits.js
//
// Single source of truth for Effectiveness Map monthly limits + usage counting.
// Imported by the generate gate (api/generate-effectiveness-map.js), the assign
// gate (api/assign-effectiveness-map.js), and the coach-facing usage endpoint
// (api/effectiveness-map-usage.js), so the limit a coach SEES is always the limit
// the gates ENFORCE and the "used" count is computed one way everywhere.
//
// Monthly Map-generation limits by subscription tier (2026-06-13). Unknown/null
// tier falls back to DEFAULT_TIER_LIMIT (lowest) so an active coach is never hard-
// blocked by a tier-string mismatch. Crisis Maps never count toward the limit.
export const TIER_LIMITS = { founding: 25, practice: 25, scale: 50 };
export const DEFAULT_TIER_LIMIT = 25;

export function limitForTier(tier) {
  const t = tier ? String(tier).toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(TIER_LIMITS, t) ? TIER_LIMITS[t] : DEFAULT_TIER_LIMIT;
}

// First instant of the current calendar month, UTC (ISO) — the window counted against.
export function monthStartISO() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

// Exact count of this coach's NON-CRISIS Maps generated since monthStart (crisis
// Maps never count). Returns null if the count can't be determined — the caller
// decides whether to fail open. Crisis exemption + month boundary live here so the
// gate and the counter can never diverge.
//
// productContext scopes the count to one product (default 'coaching'). The coaching
// tier gate counts ONLY coaching Maps, so therapy Maps (e.g. a consumer self-serve
// Map later shared to a coach, product_context='therapy') never burn a coaching
// coach's monthly quota — the consumer already paid for those.
export async function monthlyMapCount(coachId, supabaseUrl, supabaseKey, productContext = 'coaching') {
  const url = `${supabaseUrl}/rest/v1/effectiveness_maps`
    + `?coach_id=eq.${encodeURIComponent(coachId)}&crisis_flag=eq.false`
    + `&product_context=eq.${encodeURIComponent(productContext)}`
    + `&created_at=gte.${encodeURIComponent(monthStartISO())}&select=id`;
  const r = await fetch(url, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'count=exact', Range: '0-0' },
  });
  if (!r.ok && r.status !== 206) return null;
  const cr = r.headers.get('content-range') || '';
  const total = parseInt(cr.split('/')[1], 10);
  return Number.isFinite(total) ? total : null;
}
