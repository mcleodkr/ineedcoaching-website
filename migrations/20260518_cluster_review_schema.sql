-- Brief 2b schema additions for cluster review and backfill.
--
-- pattern_taxonomy gains cluster_proposal_id (links candidate to its
-- cluster-generation run) + review_action + reviewed_at + reviewer_notes
-- (Kim's review trail).
--
-- cluster_membership: bridges proposed canonical candidates to the raw
-- dna_tag strings they would absorb. Populated by the batched cluster
-- generation endpoint; read by the review UI; consumed by the backfill
-- stored function on approval.

ALTER TABLE pattern_taxonomy
  ADD COLUMN cluster_proposal_id UUID,
  ADD COLUMN review_action TEXT
    CHECK (review_action IS NULL OR review_action IN (
      'approved_as_proposed',
      'approved_with_name_change',
      'split_into_multiple',
      'merged_with_existing',
      'rejected'
    )),
  ADD COLUMN reviewed_at TIMESTAMPTZ,
  ADD COLUMN reviewer_notes TEXT;

-- cluster_membership: which raw tags would resolve to which candidate
CREATE TABLE cluster_membership (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_proposal_id UUID NOT NULL,
  candidate_taxonomy_id UUID NOT NULL REFERENCES pattern_taxonomy(id),
  raw_tag TEXT NOT NULL,
  normalized_tag TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  is_from_history BOOLEAN NOT NULL DEFAULT true,
  -- true = from existing coach_session_notes, false = from Brief 2a live candidates
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cluster_membership_proposal
  ON cluster_membership(cluster_proposal_id);

CREATE INDEX idx_cluster_membership_candidate
  ON cluster_membership(candidate_taxonomy_id);

CREATE UNIQUE INDEX idx_cluster_membership_unique_tag
  ON cluster_membership(cluster_proposal_id, normalized_tag);
-- One row per (cluster_run, normalized_tag) — prevents duplicates within a run.

-- RLS: admin-only (Kim). Matches codebase auth model:
-- coach_profiles.user_email vs auth.jwt() ->> 'email' (no user_id column).
ALTER TABLE cluster_membership ENABLE ROW LEVEL SECURITY;

CREATE POLICY cluster_membership_admin_only
  ON cluster_membership
  FOR ALL
  TO authenticated
  USING (
    lower((auth.jwt() ->> 'email')) = (
      SELECT lower(user_email)
      FROM coach_profiles
      WHERE id = '8c5fb4de-2ff0-45fd-a543-4e1b149527ee'
    )
  )
  WITH CHECK (
    lower((auth.jwt() ->> 'email')) = (
      SELECT lower(user_email)
      FROM coach_profiles
      WHERE id = '8c5fb4de-2ff0-45fd-a543-4e1b149527ee'
    )
  );

COMMENT ON TABLE cluster_membership IS
'Maps proposed canonical candidates to the raw dna_tag strings they
would absorb upon approval. Populated by the batched cluster generation
endpoint; read by the review UI to show "this canonical unifies these
raw tags." Admin-only access (Kim).';

COMMENT ON COLUMN pattern_taxonomy.review_action IS
'How the candidate was reviewed (NULL until reviewed):
- approved_as_proposed: Kim accepted Claude proposal as-is
- approved_with_name_change: Kim approved but renamed the canonical
- split_into_multiple: Kim split the cluster into 2+ canonicals
- merged_with_existing: Kim merged into an existing canonical
- rejected: Kim rejected the cluster entirely';

-- Stored function: backfill_dna_tags_for_canonical
--
-- For a given approved canonical_id, finds all raw_tag strings recorded in
-- cluster_membership for that candidate, then walks every coach_session_notes
-- row with post_session_analysis and rewrites matching raw tags in every
-- coaching_interventions[].dna_tag[] array to the canonical name. Also
-- de-duplicates resulting arrays (when both raw and canonical co-exist).
-- Returns the count of session rows updated.

CREATE OR REPLACE FUNCTION backfill_dna_tags_for_canonical(canonical_id UUID)
RETURNS INTEGER AS $$
DECLARE
  canonical_text TEXT;
  raw_tags_to_replace TEXT[];
  rewrite_count INTEGER := 0;
BEGIN
  SELECT canonical_name INTO canonical_text
  FROM pattern_taxonomy WHERE id = canonical_id;

  IF canonical_text IS NULL THEN
    RAISE EXCEPTION 'backfill_dna_tags_for_canonical: no pattern_taxonomy row for id %', canonical_id;
  END IF;

  SELECT array_agg(DISTINCT raw_tag) INTO raw_tags_to_replace
  FROM cluster_membership
  WHERE candidate_taxonomy_id = canonical_id;

  IF raw_tags_to_replace IS NULL OR array_length(raw_tags_to_replace, 1) IS NULL THEN
    RETURN 0;
  END IF;

  WITH updated AS (
    UPDATE coach_session_notes csn
    SET post_session_analysis = jsonb_set(
      csn.post_session_analysis,
      '{coaching_interventions}',
      (
        SELECT jsonb_agg(
          jsonb_set(
            intervention,
            '{dna_tag}',
            (
              SELECT COALESCE(jsonb_agg(DISTINCT new_tag), '[]'::jsonb)
              FROM (
                SELECT CASE
                  WHEN tag = ANY(raw_tags_to_replace) THEN canonical_text
                  ELSE tag
                END AS new_tag
                FROM jsonb_array_elements_text(
                  COALESCE(intervention->'dna_tag', '[]'::jsonb)
                ) AS tag
              ) renamed
            )
          )
        )
        FROM jsonb_array_elements(
          COALESCE(csn.post_session_analysis->'coaching_interventions', '[]'::jsonb)
        ) AS intervention
      )
    )
    WHERE csn.post_session_analysis IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
               COALESCE(csn.post_session_analysis->'coaching_interventions', '[]'::jsonb)
             ) AS i,
             jsonb_array_elements_text(
               COALESCE(i->'dna_tag', '[]'::jsonb)
             ) AS t
        WHERE t = ANY(raw_tags_to_replace)
      )
    RETURNING 1
  )
  SELECT COUNT(*) INTO rewrite_count FROM updated;

  RETURN rewrite_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION backfill_dna_tags_for_canonical(UUID) IS
'Rewrites raw dna_tag strings in coach_session_notes.post_session_analysis
.coaching_interventions[].dna_tag[] to the canonical_name when their
candidate_taxonomy_id matches the input. Called by promote-cluster-candidate
on Approve/Rename/Split/Merge actions. Returns the count of session rows
updated. The function uses jsonb_agg DISTINCT so arrays that already contain
the canonical name are de-duplicated.';
