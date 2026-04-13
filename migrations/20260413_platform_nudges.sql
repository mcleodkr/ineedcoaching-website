-- Platform nudges log — run in Supabase SQL Editor
CREATE TABLE IF NOT EXISTS platform_nudges (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  recipient_email text,
  nudge_type text,
  sent_at timestamptz DEFAULT now(),
  metadata jsonb
);

CREATE INDEX IF NOT EXISTS platform_nudges_recipient_type_idx
  ON platform_nudges(recipient_email, nudge_type, sent_at DESC);
