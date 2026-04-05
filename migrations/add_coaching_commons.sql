CREATE TABLE IF NOT EXISTS coaching_commons_posts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  poster_type text CHECK (poster_type IN ('individual','business')),
  email text NOT NULL,
  name text,
  org_name text,
  description text,
  budget_range text,
  availability text,
  specialty_preference text,
  business_type text,
  participants text,
  timeline text,
  format text,
  location text,
  rfp_url text,
  status text DEFAULT 'active',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coaching_commons_responses (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  post_id uuid REFERENCES coaching_commons_posts(id),
  coach_id uuid REFERENCES coach_profiles(id),
  message text,
  created_at timestamptz DEFAULT now()
);
