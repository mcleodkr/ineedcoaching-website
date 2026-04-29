-- Phase 4b — atomic usage-counter increment RPC
--
-- Bumps coach_profiles.monthly_client_count or monthly_session_count by 1.
-- Atomic via the row-level lock on the UPDATE; concurrent calls serialize.
--
-- Authorization model:
--   - service_role (webhook + cron + admin server code) bypasses checks.
--   - authenticated callers (the coach's own browser session) may only
--     increment THEIR OWN row, gated by auth.jwt()->>'email' matching
--     coach_profiles.user_email — same pattern as the existing email-based
--     RLS in 20260413_coach_journaling_rls.sql / 20260426_coach_notifications.sql.
--   - anon is denied (not granted EXECUTE).
--
-- Called from:
--   coach-dashboard.html  manual "+ Add client" handler (kind='client')
--   api/stripe-webhook.js handleBookingCompleted (kind='client', if first
--                         confirmed/manual booking from this client_email)
--   api/generate-post-session-intelligence.js (kind='session', once per
--                         first-time analysis run for a booking)

CREATE OR REPLACE FUNCTION increment_coach_usage(p_coach_id uuid, p_kind text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_jwt_email text;
  v_coach_email text;
BEGIN
  IF p_coach_id IS NULL THEN RETURN; END IF;
  IF p_kind NOT IN ('client', 'session') THEN
    RAISE EXCEPTION 'p_kind must be ''client'' or ''session''' USING ERRCODE = '22023';
  END IF;

  v_role := coalesce(auth.role(), 'anon');
  IF v_role <> 'service_role' THEN
    v_jwt_email := lower(coalesce(auth.jwt() ->> 'email', ''));
    SELECT lower(user_email) INTO v_coach_email
    FROM coach_profiles WHERE id = p_coach_id;
    IF v_coach_email IS NULL OR v_coach_email = '' OR v_coach_email <> v_jwt_email THEN
      RAISE EXCEPTION 'Not authorized to increment usage for this coach' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_kind = 'client' THEN
    UPDATE coach_profiles
    SET monthly_client_count = COALESCE(monthly_client_count, 0) + 1
    WHERE id = p_coach_id;
  ELSE -- 'session'
    UPDATE coach_profiles
    SET monthly_session_count = COALESCE(monthly_session_count, 0) + 1
    WHERE id = p_coach_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION increment_coach_usage(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION increment_coach_usage(uuid, text) TO authenticated, service_role;
