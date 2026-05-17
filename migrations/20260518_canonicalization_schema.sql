-- Brief 2a schema additions for canonicalization service.
--
-- Adds proposed_* columns to pattern_taxonomy so candidates can carry
-- Claude's full proposal (name, domain, modalities, aliases, definition,
-- reasoning) until Kim promotes them via Brief 2b's review UI.
--
-- Adds dna_tag_resolutions bridge table to map raw dna_tag strings to
-- their canonical taxonomy entry, with full audit trail.

-- Proposed-* columns on pattern_taxonomy (nullable, populated only for candidates)
ALTER TABLE pattern_taxonomy
  ADD COLUMN proposed_canonical_name TEXT,
  ADD COLUMN proposed_domain pattern_domain,
  ADD COLUMN proposed_modalities TEXT[] DEFAULT '{}',
  ADD COLUMN proposed_aliases TEXT[] DEFAULT '{}',
  ADD COLUMN proposed_definition TEXT,
  ADD COLUMN proposal_reasoning TEXT,
  ADD COLUMN proposed_at TIMESTAMPTZ;

-- Bridge table: maps raw dna_tag strings to their canonical resolution
CREATE TABLE dna_tag_resolutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_tag TEXT NOT NULL,
  normalized_tag TEXT NOT NULL,
  taxonomy_id UUID NOT NULL REFERENCES pattern_taxonomy(id),
  resolution_method TEXT NOT NULL
    CHECK (resolution_method IN (
      'exact_canonical',
      'exact_alias',
      'similarity_match',
      'new_candidate',
      'manual'
    )),
  confidence TEXT NOT NULL
    CHECK (confidence IN ('high', 'medium', 'low', 'exact')),
  similarity_score NUMERIC,
  reasoning TEXT,
  source_session_id UUID,
  source_endpoint TEXT,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_by_run_id TEXT
);

-- Indices for the canonicalization service's hot path
CREATE UNIQUE INDEX idx_dna_tag_resolutions_normalized
  ON dna_tag_resolutions(normalized_tag);
-- One canonical resolution per normalized form. Idempotent lookup.

CREATE INDEX idx_dna_tag_resolutions_taxonomy
  ON dna_tag_resolutions(taxonomy_id);
-- Lets us answer "which raw tags resolve to this canonical?"

CREATE INDEX idx_dna_tag_resolutions_source_session
  ON dna_tag_resolutions(source_session_id)
  WHERE source_session_id IS NOT NULL;
-- Lets us answer "what tags came from this session?"

-- RLS: same model as pattern_taxonomy. Service role writes; authenticated coaches read.
ALTER TABLE dna_tag_resolutions ENABLE ROW LEVEL SECURITY;

CREATE POLICY dna_tag_resolutions_read_authenticated
  ON dna_tag_resolutions
  FOR SELECT
  TO authenticated
  USING (true);

COMMENT ON TABLE dna_tag_resolutions IS
'Bridge table mapping raw dna_tag strings (as they appear in
coach_session_notes.post_session_analysis.coaching_interventions[].dna_tag[])
to their canonical pattern_taxonomy entry. Created during canonicalization
at write-time. Full audit trail of every resolution decision.';

COMMENT ON COLUMN dna_tag_resolutions.resolution_method IS
'How the resolution was determined:
- exact_canonical: raw_tag (normalized) matched an existing canonical_name
- exact_alias: raw_tag (normalized) matched an existing alias
- similarity_match: Claude judged sufficient similarity to existing canonical
- new_candidate: Claude proposed a new candidate (no good match)
- manual: human created via Brief 2b review UI';
