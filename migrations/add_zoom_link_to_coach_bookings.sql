-- Add zoom_link column to coach_bookings for per-session Zoom links
-- Run this in Supabase Dashboard > SQL Editor
ALTER TABLE public.coach_bookings ADD COLUMN IF NOT EXISTS zoom_link text;
