-- Add scheduling fields to coach_profiles
ALTER TABLE coach_profiles ADD COLUMN IF NOT EXISTS calendly_url text;
ALTER TABLE coach_profiles ADD COLUMN IF NOT EXISTS zoom_meeting_link text;
ALTER TABLE coach_profiles ADD COLUMN IF NOT EXISTS weekly_availability jsonb DEFAULT '[]'::jsonb;

-- Add phone field to bookings
ALTER TABLE coach_bookings ADD COLUMN IF NOT EXISTS client_phone text;

-- Intake forms
CREATE TABLE IF NOT EXISTS coach_intake_forms (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  coach_id uuid REFERENCES coach_profiles(id),
  questions jsonb DEFAULT '[]'::jsonb,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- Intake responses
CREATE TABLE IF NOT EXISTS coach_intake_responses (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  coach_id uuid REFERENCES coach_profiles(id),
  client_email text,
  booking_id uuid REFERENCES coach_bookings(id),
  responses jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now()
);
