-- Journal AI mirror response storage — run in Supabase SQL Editor
ALTER TABLE coach_journal_entries ADD COLUMN IF NOT EXISTS mirror_response text;
