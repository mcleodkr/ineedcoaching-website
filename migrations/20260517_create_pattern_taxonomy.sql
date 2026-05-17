-- pattern_taxonomy: cross-client canonical pattern vocabulary
--
-- Custom synthesis taxonomy combining:
--   - Process-Based Therapy six-dimension model (Hayes & Hofmann, 2019)
--     as backstage analytic framing
--   - Hogan Development Survey 11 derailers as seeded executive coaching patterns
--   - ICF modality-agnostic competency framework for cross-modality coverage
--   - Practice literature from executive, life, wellness, recovery, career coaching
--
-- Design decisions documented in: pattern-taxonomy-audit-findings.md
-- Decision conversation: 2026-05-17 Claude planning session

-- Domain enum: 16 values grouped by function
CREATE TYPE pattern_domain AS ENUM (
  -- process domains
  'decision_making',
  'action_followthrough',
  'habits_behavior_change',
  'cognitive_patterns',
  'self_expression',
  -- influence & relational
  'influencing',
  'interpersonal_dynamics',
  -- context
  'life_transitions',
  'change_navigation',
  'navigating_systems',
  -- inner architecture
  'self_concept',
  'emotional_regulation',
  'body_somatic',
  'recovery_sobriety',
  -- life integration
  'meaning_purpose',
  'whole_life_integration'
);

-- Status enum: lifecycle of a pattern
CREATE TYPE pattern_status AS ENUM (
  'canonical',     -- approved, used in production
  'candidate',     -- auto-created from new dna_tag, awaiting review
  'merged_into',   -- consolidated into another canonical (see merged_into_id)
  'retired'        -- soft-deleted; rows retained for audit
);

CREATE TABLE pattern_taxonomy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name TEXT NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}',
  domain pattern_domain NOT NULL,
  modalities TEXT[] NOT NULL DEFAULT '{}',
  definition TEXT,
  behavioral_markers JSONB DEFAULT '{}'::jsonb,
  status pattern_status NOT NULL DEFAULT 'candidate',
  merged_into_id UUID REFERENCES pattern_taxonomy(id),
  source TEXT,  -- e.g., 'hogan_hds_seed', 'coach_code_canonicalization', 'manual'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,   -- coach_id of who introduced (may be system on seed)
  approved_by UUID,  -- coach_id who promoted to canonical (NULL until approved)
  approved_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  retired_reason TEXT,

  -- Constraints
  CONSTRAINT canonical_name_lowercase
    CHECK (canonical_name = LOWER(canonical_name)),
  CONSTRAINT canonical_name_no_whitespace_edges
    CHECK (canonical_name = TRIM(canonical_name)),
  CONSTRAINT merged_into_only_when_merged
    CHECK (
      (status = 'merged_into' AND merged_into_id IS NOT NULL) OR
      (status != 'merged_into' AND merged_into_id IS NULL)
    ),
  CONSTRAINT retired_has_timestamp
    CHECK (
      (status = 'retired' AND retired_at IS NOT NULL) OR
      (status != 'retired')
    ),
  CONSTRAINT approved_consistency
    CHECK (
      (status = 'canonical' AND approved_by IS NOT NULL AND approved_at IS NOT NULL) OR
      (status != 'canonical')
    )
);

-- Indices
CREATE UNIQUE INDEX idx_pattern_taxonomy_canonical_active
  ON pattern_taxonomy(canonical_name)
  WHERE status IN ('canonical', 'candidate');
-- Partial unique index allows retiring a name and reusing it later if needed.

CREATE INDEX idx_pattern_taxonomy_aliases
  ON pattern_taxonomy USING GIN(aliases);

CREATE INDEX idx_pattern_taxonomy_modalities
  ON pattern_taxonomy USING GIN(modalities);

CREATE INDEX idx_pattern_taxonomy_domain_status
  ON pattern_taxonomy(domain, status);

CREATE INDEX idx_pattern_taxonomy_status
  ON pattern_taxonomy(status)
  WHERE status = 'candidate';
-- Partial index optimizes the review-queue query (only candidates).

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_pattern_taxonomy_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_pattern_taxonomy_updated_at
  BEFORE UPDATE ON pattern_taxonomy
  FOR EACH ROW
  EXECUTE FUNCTION update_pattern_taxonomy_updated_at();

-- RLS: enabled but permissive for now since no write paths exist yet.
-- Brief 2 will tighten promotion authority via SECURITY DEFINER RPC.
ALTER TABLE pattern_taxonomy ENABLE ROW LEVEL SECURITY;

-- Read: any authenticated coach can read the taxonomy
CREATE POLICY pattern_taxonomy_read_authenticated
  ON pattern_taxonomy
  FOR SELECT
  TO authenticated
  USING (true);

-- Write: blocked for now. Brief 2 will add SECURITY DEFINER RPC for the writer.
-- Service role bypasses RLS, which is how the seed migration writes.

COMMENT ON TABLE pattern_taxonomy IS
'Cross-client canonical taxonomy of coaching patterns. Custom synthesis
combining Hogan derailers, PBT process dimensions, and ICF modality-agnostic
coaching framework. See pattern-taxonomy-audit-findings.md for design rationale.';

COMMENT ON COLUMN pattern_taxonomy.behavioral_markers IS
'JSONB capturing additional structured detail. Conventional keys:
  effective_at: text[] - contexts where the pattern is functional
  ineffective_at: text[] - contexts where the pattern erodes effectiveness
  hogan_strength_framing: text - Hogan strength voice (for Hogan-seeded patterns)
  hogan_derailer_framing: text - Hogan derailer voice (for Hogan-seeded patterns)
  cluster: text - Hogan interpersonal cluster (moving_away/against/toward)
Additional keys may be added per pattern; schema is intentionally open.';

COMMENT ON COLUMN pattern_taxonomy.aliases IS
'Lowercase synonyms that resolve to this canonical_name. Used by canonicalization
write path to merge incoming dna_tags. Aliases are unique only across active
(canonical+candidate) patterns; retired patterns can hold stale aliases.';
