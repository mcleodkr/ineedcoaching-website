-- RLS policies for coaching journaling tables — run in Supabase SQL Editor
-- Companion to 20260413_coach_journaling.sql

ALTER TABLE coach_journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE coach_journal_reflections ENABLE ROW LEVEL SECURITY;
ALTER TABLE coach_growth_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE coach_prompt_assignments ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────
-- coach_journal_entries
-- ─────────────────────────────────────────────────────────────

-- Clients can insert their own entries
CREATE POLICY "clients insert own journal entries" ON coach_journal_entries
  FOR INSERT TO authenticated
  WITH CHECK (client_email = (auth.jwt() ->> 'email'));

-- Clients can read their own entries
CREATE POLICY "clients read own journal entries" ON coach_journal_entries
  FOR SELECT TO authenticated
  USING (client_email = (auth.jwt() ->> 'email'));

-- Clients can update their own entries (e.g. share_mode changes)
CREATE POLICY "clients update own journal entries" ON coach_journal_entries
  FOR UPDATE TO authenticated
  USING (client_email = (auth.jwt() ->> 'email'))
  WITH CHECK (client_email = (auth.jwt() ->> 'email'));

-- Coaches can read entries that have been shared with them
CREATE POLICY "coaches read shared journal entries" ON coach_journal_entries
  FOR SELECT TO authenticated
  USING (
    shared_with_coach = true
    AND coach_email = (auth.jwt() ->> 'email')
  );

-- ─────────────────────────────────────────────────────────────
-- coach_journal_reflections
-- ─────────────────────────────────────────────────────────────

-- Clients can insert their own reflections
CREATE POLICY "clients insert own reflections" ON coach_journal_reflections
  FOR INSERT TO authenticated
  WITH CHECK (client_email = (auth.jwt() ->> 'email'));

-- Clients can read their own reflections
CREATE POLICY "clients read own reflections" ON coach_journal_reflections
  FOR SELECT TO authenticated
  USING (client_email = (auth.jwt() ->> 'email'));

-- Coaches can read reflections tied to entries that have been shared with them
CREATE POLICY "coaches read shared reflections" ON coach_journal_reflections
  FOR SELECT TO authenticated
  USING (
    journal_entry_id IN (
      SELECT id FROM coach_journal_entries
      WHERE coach_email = (auth.jwt() ->> 'email')
        AND shared_with_coach = true
    )
  );

-- ─────────────────────────────────────────────────────────────
-- coach_growth_signals
-- ─────────────────────────────────────────────────────────────

-- Clients can insert their own growth signals
CREATE POLICY "clients insert own growth signals" ON coach_growth_signals
  FOR INSERT TO authenticated
  WITH CHECK (client_email = (auth.jwt() ->> 'email'));

-- Clients can read their own growth signals
CREATE POLICY "clients read own growth signals" ON coach_growth_signals
  FOR SELECT TO authenticated
  USING (client_email = (auth.jwt() ->> 'email'));

-- Coaches can read signals marked coach_visible for their own clients
-- (client inferred via any coach_bookings row linking coach → client email)
CREATE POLICY "coaches read visible growth signals" ON coach_growth_signals
  FOR SELECT TO authenticated
  USING (
    coach_visible = true
    AND client_email IN (
      SELECT cb.client_email FROM coach_bookings cb
      INNER JOIN coach_profiles cp ON cp.id = cb.coach_id
      WHERE cp.user_email = (auth.jwt() ->> 'email')
    )
  );

-- ─────────────────────────────────────────────────────────────
-- coach_prompt_assignments
-- ─────────────────────────────────────────────────────────────

-- Clients can read prompts assigned to them
CREATE POLICY "clients read own prompt assignments" ON coach_prompt_assignments
  FOR SELECT TO authenticated
  USING (client_email = (auth.jwt() ->> 'email'));

-- Coaches can insert prompt assignments for their clients
CREATE POLICY "coaches insert prompt assignments" ON coach_prompt_assignments
  FOR INSERT TO authenticated
  WITH CHECK (coach_email = (auth.jwt() ->> 'email'));

-- Coaches can read their own assignments
CREATE POLICY "coaches read own prompt assignments" ON coach_prompt_assignments
  FOR SELECT TO authenticated
  USING (coach_email = (auth.jwt() ->> 'email'));

-- Coaches can update their own assignments (mark status complete, etc.)
CREATE POLICY "coaches update own prompt assignments" ON coach_prompt_assignments
  FOR UPDATE TO authenticated
  USING (coach_email = (auth.jwt() ->> 'email'))
  WITH CHECK (coach_email = (auth.jwt() ->> 'email'));

-- NOTE: service role bypasses RLS automatically — api/generate-journal-prompt.js
-- and any server-side admin queries work without additional policies.
