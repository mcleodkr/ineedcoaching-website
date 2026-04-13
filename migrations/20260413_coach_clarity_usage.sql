-- Coach Clarity usage logging — run in Supabase SQL Editor
CREATE TABLE IF NOT EXISTS coach_clarity_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  coach_email text NOT NULL,
  client_email text,
  is_regeneration boolean NOT NULL DEFAULT false,
  clarity_run_number int NOT NULL DEFAULT 1,
  estimated_tokens int NOT NULL DEFAULT 0,
  estimated_cost_usd numeric(10, 4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS coach_clarity_usage_session_idx ON coach_clarity_usage(session_id);
CREATE INDEX IF NOT EXISTS coach_clarity_usage_coach_idx ON coach_clarity_usage(coach_email);
CREATE INDEX IF NOT EXISTS coach_clarity_usage_created_idx ON coach_clarity_usage(created_at DESC);

ALTER TABLE coach_clarity_usage ENABLE ROW LEVEL SECURITY;

-- Allow the authenticated coach to insert their own usage rows
CREATE POLICY "Coaches can insert own usage" ON coach_clarity_usage
  FOR INSERT TO authenticated
  WITH CHECK (coach_email = (SELECT email FROM auth.users WHERE id = auth.uid()));

-- Allow coaches to read their own usage rows
CREATE POLICY "Coaches can read own usage" ON coach_clarity_usage
  FOR SELECT TO authenticated
  USING (coach_email = (SELECT email FROM auth.users WHERE id = auth.uid()));

-- Service role bypasses RLS (used by api/admin-query.js) — no policy needed
