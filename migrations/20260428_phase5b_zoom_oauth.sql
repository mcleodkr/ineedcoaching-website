-- PR 5.B — Zoom user-OAuth (per-coach Zoom account integration)
-- Coexists with the existing Server-to-Server flow at /api/zoom-meeting.
-- When zoom_oauth_enabled is true, /api/booking-confirmation prefers the
-- coach's user-OAuth account over the platform S2S account so meetings
-- land on the coach's own Zoom (recording, billing, history).

ALTER TABLE coach_profiles
  ADD COLUMN IF NOT EXISTS zoom_oauth_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS zoom_oauth_access_token text,
  ADD COLUMN IF NOT EXISTS zoom_oauth_refresh_token text,
  ADD COLUMN IF NOT EXISTS zoom_oauth_token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS zoom_oauth_user_id text,
  ADD COLUMN IF NOT EXISTS zoom_oauth_connected_at timestamptz;

-- coach_bookings.zoom_link already stores the join URL — reused for both flows
-- to avoid column drift. These are the user-OAuth-specific extras.
ALTER TABLE coach_bookings
  ADD COLUMN IF NOT EXISTS zoom_meeting_id text,
  ADD COLUMN IF NOT EXISTS zoom_meeting_password text;

-- Hide the secret token columns from PostgREST clients. anon and authenticated
-- roles can still SELECT the rest of the row via the existing dashboard
-- queries; service_role (used by /api/zoom-oauth-* endpoints) bypasses these
-- grants and can still read/write the tokens. select=* from the browser will
-- silently skip these columns.
REVOKE SELECT (zoom_oauth_access_token, zoom_oauth_refresh_token, zoom_oauth_token_expires_at)
  ON coach_profiles
  FROM anon, authenticated;
