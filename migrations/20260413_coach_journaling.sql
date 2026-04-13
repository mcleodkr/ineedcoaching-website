-- Coaching-native journaling — run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS coach_journal_entries (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  client_email text,
  coach_email text,
  prompt_text text,
  prompt_source text DEFAULT 'ai_generated',
  entry_text text,
  entry_title text,
  share_mode text DEFAULT 'private',
  shared_with_coach boolean DEFAULT false,
  related_session_id uuid,
  related_goal_id uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS coach_journal_entries_client_idx
  ON coach_journal_entries(client_email, created_at DESC);

CREATE TABLE IF NOT EXISTS coach_journal_reflections (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  journal_entry_id uuid,
  client_email text,
  what_became_clearer text,
  what_still_unresolved text,
  next_step text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS coach_journal_reflections_entry_idx
  ON coach_journal_reflections(journal_entry_id);

CREATE TABLE IF NOT EXISTS coach_growth_signals (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  client_email text,
  source_type text,
  source_id uuid,
  dimension_key text,
  signal_direction text,
  signal_strength int DEFAULT 1,
  signal_summary text,
  coach_visible boolean DEFAULT false,
  client_visible boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS coach_growth_signals_client_idx
  ON coach_growth_signals(client_email, created_at DESC);

CREATE TABLE IF NOT EXISTS coach_prompt_assignments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  client_email text,
  coach_email text,
  prompt_title text,
  prompt_text text,
  source_type text DEFAULT 'ai_session',
  status text DEFAULT 'pending',
  related_session_id uuid,
  related_goal_id uuid,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS coach_prompt_assignments_client_status_idx
  ON coach_prompt_assignments(client_email, status);
