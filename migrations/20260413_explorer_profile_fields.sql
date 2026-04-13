-- Adds timezone and preferred_contact columns to explorer_profiles
-- so clients can manage these in the My Profile section of client-dashboard.html.
-- Safe to run repeatedly.

ALTER TABLE explorer_profiles ADD COLUMN IF NOT EXISTS timezone text;
ALTER TABLE explorer_profiles ADD COLUMN IF NOT EXISTS preferred_contact text;
