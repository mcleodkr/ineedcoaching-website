-- Add site and faq_schema columns to articles table
-- Run this in Supabase Dashboard > SQL Editor
ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS site text DEFAULT 'ineedtherapy';
ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS faq_schema jsonb DEFAULT '[]'::jsonb;
