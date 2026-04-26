-- =============================================================
-- coach_messages RLS hardening
-- =============================================================
-- Closes the spoofing vector flagged in commit 9350cab. Until now anyone
-- with the anon key could insert a coach_messages row claiming any sender.
-- These policies tie writes to authenticated user identity (with sender +
-- sender_email enforcement) and reads to ownership.
--
-- Public coach-profile lead form is now routed through
-- /api/send-coach-message which uses the service-role key to bypass RLS.

ALTER TABLE coach_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "messages_client_read" ON coach_messages;
CREATE POLICY "messages_client_read" ON coach_messages FOR SELECT
  USING (lower(client_email) = lower(auth.jwt()->>'email'));

DROP POLICY IF EXISTS "messages_client_insert" ON coach_messages;
CREATE POLICY "messages_client_insert" ON coach_messages FOR INSERT
  WITH CHECK (
    lower(client_email) = lower(auth.jwt()->>'email')
    AND sender = 'client'
    AND lower(sender_email) = lower(auth.jwt()->>'email')
  );

DROP POLICY IF EXISTS "messages_coach_read" ON coach_messages;
CREATE POLICY "messages_coach_read" ON coach_messages FOR SELECT
  USING (
    coach_id IN (
      SELECT id FROM coach_profiles
      WHERE lower(user_email) = lower(auth.jwt()->>'email')
    )
  );

DROP POLICY IF EXISTS "messages_coach_insert" ON coach_messages;
CREATE POLICY "messages_coach_insert" ON coach_messages FOR INSERT
  WITH CHECK (
    coach_id IN (
      SELECT id FROM coach_profiles
      WHERE lower(user_email) = lower(auth.jwt()->>'email')
    )
    AND sender = 'coach'
  );

DROP POLICY IF EXISTS "messages_update_read_status" ON coach_messages;
CREATE POLICY "messages_update_read_status" ON coach_messages FOR UPDATE
  USING (
    (sender = 'client' AND coach_id IN (
      SELECT id FROM coach_profiles
      WHERE lower(user_email) = lower(auth.jwt()->>'email')
    ))
    OR
    (sender = 'coach' AND lower(client_email) = lower(auth.jwt()->>'email'))
  );

-- =============================================================
-- explorer_profiles RLS hardening
-- =============================================================
-- explorer_profiles had RLS enabled but with public read/insert policies
-- ("Allow public select on student_profiles" with USING true), which means
-- any anon-key request could enumerate every client's profile data.

DROP POLICY IF EXISTS "Allow public insert on student_profiles" ON explorer_profiles;
DROP POLICY IF EXISTS "Allow public select on student_profiles" ON explorer_profiles;

DROP POLICY IF EXISTS "profiles_self_read" ON explorer_profiles;
CREATE POLICY "profiles_self_read" ON explorer_profiles FOR SELECT
  USING (lower(email) = lower(auth.jwt()->>'email'));

DROP POLICY IF EXISTS "profiles_coach_read" ON explorer_profiles;
CREATE POLICY "profiles_coach_read" ON explorer_profiles FOR SELECT
  USING (
    lower(email) IN (
      SELECT lower(cb.client_email)
      FROM coach_bookings cb
      JOIN coach_profiles cp ON cp.id = cb.coach_id
      WHERE lower(cp.user_email) = lower(auth.jwt()->>'email')
        AND cb.status IN ('confirmed','manual')
    )
  );

DROP POLICY IF EXISTS "profiles_self_insert" ON explorer_profiles;
CREATE POLICY "profiles_self_insert" ON explorer_profiles FOR INSERT
  WITH CHECK (lower(email) = lower(auth.jwt()->>'email'));

DROP POLICY IF EXISTS "profiles_self_update" ON explorer_profiles;
CREATE POLICY "profiles_self_update" ON explorer_profiles FOR UPDATE
  USING (lower(email) = lower(auth.jwt()->>'email'))
  WITH CHECK (lower(email) = lower(auth.jwt()->>'email'));
