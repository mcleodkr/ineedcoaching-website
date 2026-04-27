-- Scheduler Phase 4 (PR 4.A): packages + gifts + coupons + recurring +
-- waitlist + analytics + late-cancel policy. Run in Supabase SQL Editor.

-- ── Session packages ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coach_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL REFERENCES coach_profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  session_count integer NOT NULL CHECK (session_count > 0),
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  savings_cents integer DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  stripe_product_id text,
  stripe_price_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS client_package_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_email text NOT NULL,
  coach_id uuid NOT NULL REFERENCES coach_profiles(id) ON DELETE CASCADE,
  package_id uuid NOT NULL REFERENCES coach_packages(id) ON DELETE RESTRICT,
  credits_total integer NOT NULL,
  credits_remaining integer NOT NULL,
  stripe_session_id text UNIQUE,
  stripe_payment_intent_id text,
  payment_amount_cents integer,
  purchased_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  CONSTRAINT credits_valid CHECK (credits_remaining >= 0 AND credits_remaining <= credits_total)
);

-- ── Gift certificates ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gift_certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL REFERENCES coach_profiles(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  amount_cents integer CHECK (amount_cents IS NULL OR amount_cents > 0),
  session_count integer CHECK (session_count IS NULL OR session_count > 0),
  purchased_by text,
  recipient_email text,
  recipient_name text,
  message text,
  stripe_session_id text,
  payment_amount_cents integer,
  redeemed_by text,
  redeemed_at timestamptz,
  purchased_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  CONSTRAINT gift_type CHECK ((amount_cents IS NOT NULL AND session_count IS NULL) OR (amount_cents IS NULL AND session_count IS NOT NULL))
);

-- ── Coupons ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coach_coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL REFERENCES coach_profiles(id) ON DELETE CASCADE,
  code text NOT NULL,
  discount_type text NOT NULL CHECK (discount_type IN ('percentage', 'fixed_amount')),
  discount_value numeric NOT NULL CHECK (discount_value > 0),
  applies_to text NOT NULL CHECK (applies_to IN ('all', 'specific_service')),
  service_id uuid REFERENCES coach_services(id) ON DELETE CASCADE,
  max_uses integer,
  times_used integer NOT NULL DEFAULT 0,
  expires_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  stripe_coupon_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(coach_id, code)
);

CREATE TABLE IF NOT EXISTS coupon_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id uuid NOT NULL REFERENCES coach_coupons(id) ON DELETE CASCADE,
  client_email text NOT NULL,
  booking_id uuid REFERENCES coach_bookings(id) ON DELETE SET NULL,
  discount_amount_cents integer NOT NULL,
  used_at timestamptz NOT NULL DEFAULT now()
);

-- ── Recurring bookings ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recurring_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL REFERENCES coach_profiles(id) ON DELETE CASCADE,
  client_email text NOT NULL,
  client_name text,
  service_id uuid NOT NULL REFERENCES coach_services(id) ON DELETE RESTRICT,
  start_date date NOT NULL,
  end_date date,
  day_of_week integer NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  time_of_day time NOT NULL,
  frequency text NOT NULL DEFAULT 'weekly' CHECK (frequency IN ('weekly', 'biweekly', 'monthly')),
  total_sessions integer,
  sessions_created integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Waitlist ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS booking_waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL REFERENCES coach_profiles(id) ON DELETE CASCADE,
  client_email text NOT NULL,
  client_name text,
  service_id uuid REFERENCES coach_services(id) ON DELETE SET NULL,
  requested_date date,
  requested_time time,
  notes text,
  notified_at timestamptz,
  joined_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);

-- ── Analytics events ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS booking_analytics_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL REFERENCES coach_profiles(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('view', 'service_selected', 'slot_selected', 'booking_completed', 'booking_cancelled', 'booking_no_show')),
  service_id uuid REFERENCES coach_services(id) ON DELETE SET NULL,
  booking_id uuid REFERENCES coach_bookings(id) ON DELETE SET NULL,
  client_email text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Coach-side late cancellation policy (added on coach_profiles to keep
--    the cancellation engine from joining a separate settings table). ───
ALTER TABLE coach_profiles
  ADD COLUMN IF NOT EXISTS late_cancel_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS late_cancel_window_hours integer NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS late_cancel_fee_type text NOT NULL DEFAULT 'percentage' CHECK (late_cancel_fee_type IN ('percentage', 'fixed')),
  ADD COLUMN IF NOT EXISTS late_cancel_fee_amount numeric NOT NULL DEFAULT 50;

-- ── Booking-side joins to the new tables. ────────────────────────────────
ALTER TABLE coach_bookings
  ADD COLUMN IF NOT EXISTS package_purchase_id uuid REFERENCES client_package_purchases(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS gift_certificate_id uuid REFERENCES gift_certificates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS coupon_id uuid REFERENCES coach_coupons(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS discount_amount_cents integer,
  ADD COLUMN IF NOT EXISTS recurring_booking_id uuid REFERENCES recurring_bookings(id) ON DELETE SET NULL;

-- ── Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_packages_coach ON coach_packages(coach_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_package_purchases_client ON client_package_purchases(client_email, coach_id);
CREATE INDEX IF NOT EXISTS idx_gift_codes ON gift_certificates(code) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_coupons_coach_code ON coach_coupons(coach_id, code) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_recurring_active ON recurring_bookings(coach_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_waitlist_coach ON booking_waitlist(coach_id);
CREATE INDEX IF NOT EXISTS idx_analytics_coach_date ON booking_analytics_events(coach_id, created_at);
