-- Phase 2a — Client-facing post-session summary
--
-- Adds an authoritative, client-safe recap generated server-side by the
-- post-session pipeline (api/generate-post-session-intelligence.js). Today the
-- client dashboard derives a client view on the fly by scraping the coach-facing
-- post_session_analysis blob and rewriting pronouns with regex — fragile, and it
-- over-fetches coach-only content into the browser. This column holds a dedicated,
-- already-client-voiced recap (headline / recap / what_stood_out / practice /
-- commitments / closing) with NO coach analysis, patterns, blind spots, or
-- diagnostic framing.
--
-- No new RLS policy: coach_session_notes already has client_reads_own_session_notes
-- (SELECT WHERE lower(client_email)=lower(auth.jwt()->>'email')). RLS is row-level,
-- so the new column inherits that read access for the client and the existing
-- coach_reads_own_session_notes for the coach. Writes go through the service role
-- in the post-session pipeline.
--
-- Run this once via Supabase SQL Editor.

ALTER TABLE coach_session_notes
  ADD COLUMN IF NOT EXISTS client_summary jsonb;

-- Verify
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'coach_session_notes' AND column_name = 'client_summary';  -- 1 row, jsonb
