-- Create coach_proposals table
-- Run this in Supabase Dashboard > SQL Editor
CREATE TABLE IF NOT EXISTS public.coach_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL REFERENCES public.coach_profiles(id) ON DELETE CASCADE,
  client_company text NOT NULL,
  client_name text,
  client_email text NOT NULL,
  service_type text NOT NULL,
  participants integer DEFAULT 1,
  proposed_dates text,
  investment numeric(10,2),
  inclusions jsonb DEFAULT '[]'::jsonb,
  custom_message text,
  status text DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','declined')),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.coach_proposals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Coaches can manage their own proposals"
  ON public.coach_proposals FOR ALL
  USING (true)
  WITH CHECK (true);
