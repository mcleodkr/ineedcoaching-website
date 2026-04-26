-- Per-call instrumentation for every Anthropic API call. Pricing decisions
-- (per-coach caps, billing tiers, monthly cost forecasts) all depend on
-- accurate per-feature, per-model token counts. Cost is precomputed at
-- write-time so admin queries don't need to re-derive it on every read.
--
-- RLS: no coach-facing read policy. Writes happen via service-role from
-- the API endpoints; admin reads happen via service-role too (Supabase
-- dashboard or a server-side admin endpoint). Default deny is correct.

CREATE TABLE IF NOT EXISTS coach_ai_usage_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id uuid REFERENCES coach_profiles(id) ON DELETE SET NULL,
  feature text NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cache_creation_input_tokens integer NOT NULL DEFAULT 0,
  cache_read_input_tokens integer NOT NULL DEFAULT 0,
  estimated_cost_cents numeric(10,4),
  request_id text,
  status text NOT NULL DEFAULT 'success' CHECK (status IN ('success','error','timeout')),
  error_message text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_coach_date ON coach_ai_usage_log(coach_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_feature ON coach_ai_usage_log(feature, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created_at ON coach_ai_usage_log(created_at DESC);

ALTER TABLE coach_ai_usage_log ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies — service role bypasses RLS for writes/admin reads.
