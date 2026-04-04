CREATE TABLE IF NOT EXISTS coach_messages (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  coach_id uuid REFERENCES coach_profiles(id),
  client_email text NOT NULL,
  booking_id uuid REFERENCES coach_bookings(id),
  sender text CHECK (sender IN ('coach','client')) NOT NULL,
  message text NOT NULL,
  is_read boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coach_goals (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  coach_id uuid REFERENCES coach_profiles(id),
  client_email text NOT NULL,
  title text NOT NULL,
  description text,
  target_date date,
  status text CHECK (status IN ('not_started','in_progress','completed')) DEFAULT 'not_started',
  created_at timestamptz DEFAULT now()
);
