-- PR 5.A — Google Calendar auto-sync
-- Adds OAuth token storage on coach_profiles and an event-id linkage on coach_bookings.
-- Tokens are sensitive: production should additionally encrypt google_refresh_token at rest.

ALTER TABLE coach_profiles
  ADD COLUMN IF NOT EXISTS google_calendar_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS google_access_token text,
  ADD COLUMN IF NOT EXISTS google_refresh_token text,
  ADD COLUMN IF NOT EXISTS google_token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS google_calendar_id text DEFAULT 'primary';

ALTER TABLE coach_bookings
  ADD COLUMN IF NOT EXISTS google_calendar_event_id text;

-- Partial index for "find unsynced bookings for this coach" queries.
-- Excludes the (much larger) population of unsynced rows so the index stays small.
CREATE INDEX IF NOT EXISTS idx_bookings_calendar_sync
  ON coach_bookings(coach_id, google_calendar_event_id)
  WHERE google_calendar_event_id IS NOT NULL;
