-- 20260610 — OAuth token isolation (Zoom Marketplace security finding)
--
-- The Zoom review flagged zoom_oauth_access_token / zoom_oauth_refresh_token /
-- google_* token fields coming back from GET /rest/v1/coach_profiles?select=*.
-- The prior column-level REVOKE (20260428_phase5b_zoom_oauth.sql) did NOT close
-- this: a column-level REVOKE SELECT does not override the table-level SELECT
-- grant PostgREST exposes to authenticated, and the google_* token columns were
-- never revoked at all.
--
-- Fix: move every OAuth token column off coach_profiles into a dedicated table
-- that has RLS enabled with zero policies and no grants to anon/authenticated,
-- so it is reachable only by the service role used inside /api/* handlers.
-- The non-secret connection-state columns stay on coach_profiles because the
-- dashboard reads them via select=*.
--
-- Run manually in the Supabase SQL Editor. Single quotes inside string literals
-- are escaped as ''.

BEGIN;

-- 1. Service-role-only token vault, one row per coach.
CREATE TABLE IF NOT EXISTS coach_oauth_tokens (
  coach_id                     uuid PRIMARY KEY REFERENCES coach_profiles(id) ON DELETE CASCADE,
  zoom_oauth_access_token      text,
  zoom_oauth_refresh_token     text,
  zoom_oauth_token_expires_at  timestamptz,
  zoom_oauth_user_id           text,
  google_access_token          text,
  google_refresh_token         text,
  google_token_expires_at      timestamptz,
  updated_at                   timestamptz DEFAULT now()
);

-- RLS on + zero policies = no row is visible to anon/authenticated. Combined
-- with the REVOKE below this makes the table service-role-only. The service
-- role bypasses RLS, so /api/* handlers keep full access.
ALTER TABLE coach_oauth_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON coach_oauth_tokens FROM anon, authenticated;

-- 2. Backfill existing tokens before the source columns are dropped.
INSERT INTO coach_oauth_tokens (
  coach_id,
  zoom_oauth_access_token,
  zoom_oauth_refresh_token,
  zoom_oauth_token_expires_at,
  zoom_oauth_user_id,
  google_access_token,
  google_refresh_token,
  google_token_expires_at
)
SELECT
  id,
  zoom_oauth_access_token,
  zoom_oauth_refresh_token,
  zoom_oauth_token_expires_at,
  zoom_oauth_user_id,
  google_access_token,
  google_refresh_token,
  google_token_expires_at
FROM coach_profiles
WHERE zoom_oauth_access_token IS NOT NULL
   OR zoom_oauth_refresh_token IS NOT NULL
   OR zoom_oauth_user_id IS NOT NULL
   OR google_access_token IS NOT NULL
   OR google_refresh_token IS NOT NULL
ON CONFLICT (coach_id) DO NOTHING;

-- 3. Drop the secret columns from coach_profiles.
-- KEEP the non-secret connection-state columns the dashboard reads:
--   zoom_oauth_enabled, zoom_oauth_connected_at,
--   google_calendar_enabled, google_calendar_id.
ALTER TABLE coach_profiles
  DROP COLUMN IF EXISTS zoom_oauth_access_token,
  DROP COLUMN IF EXISTS zoom_oauth_refresh_token,
  DROP COLUMN IF EXISTS zoom_oauth_token_expires_at,
  DROP COLUMN IF EXISTS zoom_oauth_user_id,
  DROP COLUMN IF EXISTS google_access_token,
  DROP COLUMN IF EXISTS google_refresh_token,
  DROP COLUMN IF EXISTS google_token_expires_at;

COMMIT;
