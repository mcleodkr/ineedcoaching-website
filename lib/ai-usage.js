// Shared helpers for instrumenting Anthropic API calls. Imported by
// every /api endpoint that talks to Claude. Two responsibilities:
//
//   1. calculateCost(usage, model) — dollar-cents math from usage tokens
//      using current Anthropic published rates. Centralized so a single
//      edit covers all call sites when pricing changes.
//
//   2. logAIUsage({...}) — fire-and-forget insert into
//      coach_ai_usage_log via the service-role key. Awaited briefly so
//      the row lands before the serverless function returns. Failures
//      are non-fatal — telemetry must never break a real request.

// Anthropic published pricing (per 1M tokens, USD).
// Update here when Anthropic changes prices; every call site picks it
// up automatically.
const PRICING = {
  // Defaults match claude-sonnet-4-5-20250929 (the model the spec quotes).
  default: {
    input: 3.00,
    output: 15.00,
    cache_write: 3.75,
    cache_read: 0.30,
  },
  // Add overrides keyed by model id when we run other models. Example:
  // 'claude-opus-4-7': { input: 15, output: 75, cache_write: 18.75, cache_read: 1.50 },
  // For now, every prefix that starts with 'claude-sonnet' or 'claude-3-5-sonnet'
  // falls through to default Sonnet 4.5 pricing.
};

function pricingForModel(model) {
  if (!model) return PRICING.default;
  const exact = PRICING[model];
  if (exact) return exact;
  // Look for a prefix match (e.g., 'claude-opus-4-7-x' matches 'claude-opus-4-7').
  const keys = Object.keys(PRICING).filter(function(k) { return k !== 'default'; });
  for (const k of keys) {
    if (model.indexOf(k) === 0) return PRICING[k];
  }
  return PRICING.default;
}

export function calculateCost(usage, model) {
  if (!usage) return 0;
  const rates = pricingForModel(model);
  const input = Number(usage.input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  const cacheWrite = Number(usage.cache_creation_input_tokens || 0);
  const cacheRead = Number(usage.cache_read_input_tokens || 0);
  // dollars per 1M tokens → cents per token
  const costDollars =
    (input / 1_000_000) * rates.input +
    (output / 1_000_000) * rates.output +
    (cacheWrite / 1_000_000) * rates.cache_write +
    (cacheRead / 1_000_000) * rates.cache_read;
  return Math.round(costDollars * 100 * 10000) / 10000; // cents, 4 decimals
}

export async function logAIUsage(opts) {
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) {
    // Telemetry is optional. If the service-role key isn't set, log a
    // warning but don't throw — the calling endpoint must keep working.
    console.warn('[ai-usage] SUPABASE_SERVICE_ROLE_KEY not set — skipping log');
    return;
  }
  const usage = opts.usage || {};
  const model = opts.model || 'unknown';
  const payload = {
    coach_id: opts.coachId || null,
    feature: opts.feature || 'unknown',
    model,
    input_tokens: Number(usage.input_tokens || 0),
    output_tokens: Number(usage.output_tokens || 0),
    cache_creation_input_tokens: Number(usage.cache_creation_input_tokens || 0),
    cache_read_input_tokens: Number(usage.cache_read_input_tokens || 0),
    estimated_cost_cents: calculateCost(usage, model),
    request_id: opts.requestId || null,
    status: opts.status || 'success',
    error_message: opts.errorMessage || null,
    duration_ms: opts.durationMs != null ? Math.round(opts.durationMs) : null,
  };
  try {
    await fetch(SUPABASE_URL + '/rest/v1/coach_ai_usage_log', {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Never throw out of telemetry. Log and move on so the originating
    // endpoint isn't broken by a transient Supabase blip.
    console.warn('[ai-usage] log failed (non-fatal):', err && err.message);
  }
}
