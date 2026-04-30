-- Brief 2: dashboard simplification — auto-confirm flow.
-- Run in Supabase SQL Editor.
--
-- Old rows still carry status='pending' from the pre-2.A workflow when
-- coaches manually confirmed each booking. The dashboard now drops the
-- Pending tab and the Confirm/Decline buttons; without this backfill those
-- rows would be invisible from the bookings list.
--
-- Scope: only flips the literal 'pending' status. 'pending_payment' rows
-- (Stripe in-flight) are left alone — the webhook upgrades those to
-- 'confirmed' on its own.

UPDATE coach_bookings
SET status = 'confirmed'
WHERE status = 'pending';
