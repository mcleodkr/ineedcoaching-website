-- Backfill coach_profiles.slug for rows where it's NULL or empty. Pre-dates
-- the slug-on-insert logic added to api/stripe-webhook.js
-- (handleSubscriptionCreated). Without this, the coach dashboard's
-- "View Profile" link resolves to /coach/ with no slug and 404s on Vercel
-- because the rewrite /coach/:slug requires a non-empty path segment.
--
-- Source preference per row: display_name → full_name → email-local-part
-- → 'coach'.
-- Slugify: lowercase; keep [a-z0-9], whitespace, and dashes; turn whitespace
-- runs into single dashes; collapse multiple dashes; trim leading/trailing
-- dashes; cap at 60 chars; trim again post-cap to avoid a trailing dash.
-- Dedupe within this batch and against existing slugs by appending -2, -3, …
--
-- Idempotent: WHERE slug IS NULL OR slug = '' guarantees rows already
-- carrying a slug are never touched. Safe to re-run.

DO $$
DECLARE
  r          RECORD;
  base_raw   TEXT;
  base_slug  TEXT;
  candidate  TEXT;
  n          INT;
BEGIN
  FOR r IN
    SELECT id, display_name, full_name, user_email
    FROM coach_profiles
    WHERE slug IS NULL OR slug = ''
    ORDER BY created_at NULLS LAST, id
  LOOP
    base_raw := COALESCE(
      NULLIF(TRIM(r.display_name), ''),
      NULLIF(TRIM(r.full_name), ''),
      NULLIF(SPLIT_PART(COALESCE(r.user_email, ''), '@', 1), ''),
      'coach'
    );

    base_slug := LOWER(base_raw);
    base_slug := REGEXP_REPLACE(base_slug, '[^a-z0-9[:space:]-]', '', 'g');
    base_slug := REGEXP_REPLACE(base_slug, '[[:space:]]+', '-', 'g');
    base_slug := REGEXP_REPLACE(base_slug, '-+', '-', 'g');
    base_slug := TRIM(BOTH '-' FROM base_slug);
    base_slug := LEFT(base_slug, 60);
    base_slug := TRIM(BOTH '-' FROM base_slug);
    IF base_slug IS NULL OR base_slug = '' THEN
      base_slug := 'coach';
    END IF;

    candidate := base_slug;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM coach_profiles WHERE slug = candidate) LOOP
      n := n + 1;
      candidate := base_slug || '-' || n::text;
    END LOOP;

    UPDATE coach_profiles
    SET slug = candidate
    WHERE id = r.id;
  END LOOP;
END $$;
