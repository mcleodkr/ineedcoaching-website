-- Backfill coach_email on existing coach_journal_entries rows so coach-side
-- RLS (coach_email = auth.jwt()->>'email') can read shared entries written
-- before the client-side enrichment fix shipped.
--
-- Strategy: most recent confirmed/manual booking wins. Rows belonging to
-- clients with no matched booking remain NULL (legitimate not-yet-matched).
--
-- Idempotent: WHERE je.coach_email IS NULL ensures already-stamped rows are
-- never overwritten. Safe to re-run.

UPDATE coach_journal_entries je
SET coach_email = sub.coach_email
FROM (
  SELECT DISTINCT ON (lower(cb.client_email))
    lower(cb.client_email) AS client_email,
    lower(cp.user_email) AS coach_email
  FROM coach_bookings cb
  JOIN coach_profiles cp ON cp.id = cb.coach_id
  WHERE cb.status IN ('confirmed', 'manual')
    AND cp.user_email IS NOT NULL
  ORDER BY lower(cb.client_email), cb.scheduled_at DESC NULLS LAST, cb.created_at DESC NULLS LAST
) sub
WHERE lower(je.client_email) = sub.client_email
  AND je.coach_email IS NULL;
