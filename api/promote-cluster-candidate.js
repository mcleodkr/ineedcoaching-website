// POST { sessionAccessToken, candidate_id, action, ...action-specific fields }
// Brief 2b: Promotes a candidate pattern_taxonomy row based on Kim's review.
//
// Actions:
//   - approve:             promote candidate to canonical as-proposed
//   - approve_with_rename: promote with a new canonical_name
//   - split:               create N additional canonicals; reassign memberships
//   - reject:              retire the candidate; no backfill
//
// On approve / approve_with_rename / split, runs backfill_dna_tags_for_canonical
// to rewrite raw tags in coach_session_notes. On reject, raw tags stay
// free-form and the candidate is retired.
//
// Admin-only.

import crypto from 'crypto';

const ADMIN_EMAIL = 'drkmcleod@gmail.com';
const KIM_COACH_ID = '8c5fb4de-2ff0-45fd-a543-4e1b149527ee';

const VALID_MODALITIES = ['executive', 'life', 'wellness', 'recovery', 'career'];
const VALID_DOMAINS = [
  'decision_making', 'action_followthrough', 'habits_behavior_change',
  'cognitive_patterns', 'self_expression', 'influencing',
  'interpersonal_dynamics', 'life_transitions', 'change_navigation',
  'navigating_systems', 'self_concept', 'emotional_regulation',
  'body_somatic', 'recovery_sobriety', 'meaning_purpose', 'whole_life_integration',
];

function normalizeTag(raw) {
  if (typeof raw !== 'string') return null;
  let n = raw.toLowerCase().trim();
  n = n.replace(/_/g, ' ');
  n = n.replace(/\s+/g, ' ');
  return n.length > 0 ? n : null;
}

function isValidCanonicalName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= 60
    && name === name.toLowerCase()
    && name === name.trim()
    && !name.includes('_');
}

async function runBackfill(SUPABASE_URL, headers, canonicalId, invokeId) {
  try {
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/backfill_dna_tags_for_canonical`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ canonical_id: canonicalId }),
    });
    if (!rpcRes.ok) {
      const t = await rpcRes.text().catch(() => '');
      console.warn('[promote-cluster-candidate] backfill failed', { invokeId, canonicalId, status: rpcRes.status, body: t.slice(0, 200) });
      return null;
    }
    const count = await rpcRes.json().catch(() => null);
    return typeof count === 'number' ? count : (count && Number.isFinite(Number(count)) ? Number(count) : 0);
  } catch (e) {
    console.warn('[promote-cluster-candidate] backfill threw', { invokeId, canonicalId, message: e.message });
    return null;
  }
}

async function recordResolutions(SUPABASE_URL, headers, canonicalId, invokeId) {
  // Insert dna_tag_resolutions rows for every cluster_membership entry of this candidate
  try {
    const memRes = await fetch(
      `${SUPABASE_URL}/rest/v1/cluster_membership?candidate_taxonomy_id=eq.${canonicalId}&select=raw_tag,normalized_tag`,
      { headers }
    );
    if (!memRes.ok) return 0;
    const members = await memRes.json();
    if (!Array.isArray(members) || members.length === 0) return 0;
    const rows = members.map(m => ({
      raw_tag: m.raw_tag,
      normalized_tag: m.normalized_tag,
      taxonomy_id: canonicalId,
      resolution_method: 'manual',
      confidence: 'high',
      reasoning: 'cluster_approved during taxonomy review',
      source_endpoint: 'backfill_cluster_review',
      resolved_by_run_id: invokeId,
    }));
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/dna_tag_resolutions?on_conflict=normalized_tag`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal,resolution=ignore-duplicates' },
      body: JSON.stringify(rows),
    });
    if (!insertRes.ok) {
      const t = await insertRes.text().catch(() => '');
      console.warn('[promote-cluster-candidate] dna_tag_resolutions insert failed', { invokeId, canonicalId, status: insertRes.status, body: t.slice(0, 200) });
    }
    return rows.length;
  } catch (e) {
    console.warn('[promote-cluster-candidate] resolutions threw', { invokeId, canonicalId, message: e.message });
    return 0;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  const invokeId = crypto.randomBytes(4).toString('hex');

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { sessionAccessToken, candidate_id, action } = body;
  if (!sessionAccessToken) return res.status(401).json({ error: 'Missing sessionAccessToken' });
  if (!candidate_id) return res.status(400).json({ error: 'Missing candidate_id' });
  if (!action) return res.status(400).json({ error: 'Missing action' });

  // Admin auth
  try {
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${sessionAccessToken}` },
    });
    if (!authRes.ok) return res.status(401).json({ error: 'Invalid session' });
    const user = await authRes.json();
    const callerEmail = (user.email || '').toLowerCase();
    if (callerEmail !== ADMIN_EMAIL) return res.status(403).json({ error: 'Not authorized' });
  } catch (e) {
    return res.status(401).json({ error: 'Auth check failed' });
  }

  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

  // Fetch candidate to verify it exists and is still a candidate
  let candidate;
  try {
    const findRes = await fetch(
      `${SUPABASE_URL}/rest/v1/pattern_taxonomy?id=eq.${candidate_id}&select=*&limit=1`,
      { headers }
    );
    const found = findRes.ok ? await findRes.json() : [];
    if (!Array.isArray(found) || !found.length) return res.status(404).json({ error: 'Candidate not found' });
    candidate = found[0];
  } catch (e) {
    return res.status(500).json({ error: 'Candidate lookup failed' });
  }

  if (candidate.status !== 'candidate') {
    return res.status(409).json({ error: `Candidate already in state '${candidate.status}'`, current_status: candidate.status });
  }

  console.log('[promote-cluster-candidate] invoked', { invokeId, candidate_id, action });

  try {
    if (action === 'approve') {
      // Promote candidate to canonical using its proposed_* values
      const updates = {
        status: 'canonical',
        canonical_name: candidate.proposed_canonical_name || candidate.canonical_name,
        domain: candidate.proposed_domain || candidate.domain,
        modalities: Array.isArray(candidate.proposed_modalities) ? candidate.proposed_modalities : (candidate.modalities || []),
        aliases: Array.isArray(candidate.proposed_aliases) ? candidate.proposed_aliases : (candidate.aliases || []),
        definition: candidate.proposed_definition || candidate.definition,
        approved_by: KIM_COACH_ID,
        approved_at: new Date().toISOString(),
        reviewed_at: new Date().toISOString(),
        review_action: 'approved_as_proposed',
      };
      const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/pattern_taxonomy?id=eq.${candidate_id}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify(updates),
      });
      if (!patchRes.ok) {
        const t = await patchRes.text().catch(() => '');
        return res.status(500).json({ error: 'Promotion patch failed', detail: t.slice(0, 200) });
      }
      const rewriteCount = await runBackfill(SUPABASE_URL, headers, candidate_id, invokeId);
      const resolutionsCount = await recordResolutions(SUPABASE_URL, headers, candidate_id, invokeId);
      return res.status(200).json({ success: true, action: 'approve', canonical_id: candidate_id, sessions_rewritten: rewriteCount, resolutions_recorded: resolutionsCount });
    }

    if (action === 'approve_with_rename') {
      const newName = normalizeTag(body.new_canonical_name);
      if (!isValidCanonicalName(newName)) {
        return res.status(400).json({ error: 'Invalid new_canonical_name (must be lowercase, spaces, 1-60 chars, no underscores)' });
      }
      // Check no other active row holds that name
      const dupRes = await fetch(
        `${SUPABASE_URL}/rest/v1/pattern_taxonomy?canonical_name=eq.${encodeURIComponent(newName)}&status=in.(canonical,candidate)&id=not.eq.${candidate_id}&select=id&limit=1`,
        { headers }
      );
      const dup = dupRes.ok ? await dupRes.json() : [];
      if (Array.isArray(dup) && dup.length) {
        return res.status(409).json({ error: `Another active row already uses canonical_name "${newName}"` });
      }
      const updates = {
        status: 'canonical',
        canonical_name: newName,
        domain: candidate.proposed_domain || candidate.domain,
        modalities: Array.isArray(candidate.proposed_modalities) ? candidate.proposed_modalities : (candidate.modalities || []),
        aliases: Array.isArray(candidate.proposed_aliases) ? candidate.proposed_aliases : (candidate.aliases || []),
        definition: candidate.proposed_definition || candidate.definition,
        approved_by: KIM_COACH_ID,
        approved_at: new Date().toISOString(),
        reviewed_at: new Date().toISOString(),
        review_action: 'approved_with_name_change',
        reviewer_notes: body.reviewer_notes || `Renamed from "${candidate.proposed_canonical_name || candidate.canonical_name}" during cluster review.`,
      };
      const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/pattern_taxonomy?id=eq.${candidate_id}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify(updates),
      });
      if (!patchRes.ok) {
        const t = await patchRes.text().catch(() => '');
        return res.status(500).json({ error: 'Rename patch failed', detail: t.slice(0, 200) });
      }
      const rewriteCount = await runBackfill(SUPABASE_URL, headers, candidate_id, invokeId);
      const resolutionsCount = await recordResolutions(SUPABASE_URL, headers, candidate_id, invokeId);
      return res.status(200).json({ success: true, action: 'approve_with_rename', canonical_id: candidate_id, new_name: newName, sessions_rewritten: rewriteCount, resolutions_recorded: resolutionsCount });
    }

    if (action === 'split') {
      // body.splits = [{ canonical_name, domain, modalities, definition, member_normalized_tags: [...] }, ...]
      // Original candidate keeps any member_normalized_tags assigned to it (member_split_index = 0 by convention)
      const splits = Array.isArray(body.splits) ? body.splits : null;
      if (!splits || !splits.length) return res.status(400).json({ error: 'splits array required for split action' });

      // Fetch existing memberships for this candidate
      const memRes = await fetch(
        `${SUPABASE_URL}/rest/v1/cluster_membership?candidate_taxonomy_id=eq.${candidate_id}&select=*`,
        { headers }
      );
      const members = memRes.ok ? await memRes.json() : [];
      if (!Array.isArray(members) || !members.length) return res.status(400).json({ error: 'Candidate has no cluster memberships to split' });

      const memberByNorm = new Map();
      for (const m of members) memberByNorm.set(m.normalized_tag, m);

      // Validate every split and resolve which one is "primary" (retains the original candidate row)
      // We treat splits[0] as primary; remaining splits create new candidate rows.
      const validatedSplits = [];
      for (let i = 0; i < splits.length; i++) {
        const s = splits[i];
        const name = normalizeTag(s && s.canonical_name);
        if (!isValidCanonicalName(name)) {
          return res.status(400).json({ error: `Split ${i}: invalid canonical_name "${s && s.canonical_name}"` });
        }
        const domain = s && VALID_DOMAINS.includes(s.domain) ? s.domain : (candidate.proposed_domain || candidate.domain);
        const modalities = Array.isArray(s && s.modalities) ? s.modalities.filter(m => VALID_MODALITIES.includes(m)) : [];
        const definition = (s && typeof s.definition === 'string' && s.definition.trim().length >= 40) ? s.definition.trim() : (candidate.proposed_definition || candidate.definition);
        const memberNorms = Array.isArray(s && s.member_normalized_tags) ? s.member_normalized_tags.map(t => normalizeTag(t)).filter(Boolean) : [];
        const matchedMembers = memberNorms.map(n => memberByNorm.get(n)).filter(Boolean);
        if (matchedMembers.length === 0) {
          return res.status(400).json({ error: `Split ${i} (${name}): no matching cluster memberships` });
        }
        validatedSplits.push({ name, domain, modalities, definition, memberRows: matchedMembers });
      }

      const createdIds = [];

      // splits[0] → keep original candidate row; promote to canonical with new metadata
      const primary = validatedSplits[0];
      const primaryUpdates = {
        status: 'canonical',
        canonical_name: primary.name,
        domain: primary.domain,
        modalities: primary.modalities,
        aliases: primary.memberRows.map(m => m.normalized_tag).filter(n => n !== primary.name),
        definition: primary.definition,
        approved_by: KIM_COACH_ID,
        approved_at: new Date().toISOString(),
        reviewed_at: new Date().toISOString(),
        review_action: 'split_into_multiple',
        reviewer_notes: body.reviewer_notes || `Split into ${validatedSplits.length} canonicals during cluster review.`,
      };
      const pPatch = await fetch(`${SUPABASE_URL}/rest/v1/pattern_taxonomy?id=eq.${candidate_id}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify(primaryUpdates),
      });
      if (!pPatch.ok) {
        const t = await pPatch.text().catch(() => '');
        return res.status(500).json({ error: 'Primary split patch failed', detail: t.slice(0, 200) });
      }
      createdIds.push(candidate_id);

      // splits[1..N] → new canonical rows; reassign cluster_membership
      for (let i = 1; i < validatedSplits.length; i++) {
        const v = validatedSplits[i];
        const insRes = await fetch(`${SUPABASE_URL}/rest/v1/pattern_taxonomy`, {
          method: 'POST',
          headers: { ...headers, Prefer: 'return=representation' },
          body: JSON.stringify({
            canonical_name: v.name,
            domain: v.domain,
            modalities: v.modalities,
            aliases: v.memberRows.map(m => m.normalized_tag).filter(n => n !== v.name),
            definition: v.definition,
            status: 'canonical',
            source: 'cluster_review',
            cluster_proposal_id: candidate.cluster_proposal_id || null,
            approved_by: KIM_COACH_ID,
            approved_at: new Date().toISOString(),
            reviewed_at: new Date().toISOString(),
            review_action: 'approved_as_proposed',
            reviewer_notes: `Created via split of candidate ${candidate_id} during cluster review.`,
            proposed_canonical_name: v.name,
            proposed_domain: v.domain,
            proposed_modalities: v.modalities,
            proposed_aliases: v.memberRows.map(m => m.normalized_tag).filter(n => n !== v.name),
            proposed_definition: v.definition,
            proposal_reasoning: `Split-spawn from candidate ${candidate_id}.`,
            proposed_at: new Date().toISOString(),
          }),
        });
        if (!insRes.ok) {
          const t = await insRes.text().catch(() => '');
          return res.status(500).json({ error: `Failed to create split candidate ${i}`, detail: t.slice(0, 200) });
        }
        const rows = await insRes.json();
        const newId = Array.isArray(rows) && rows.length ? rows[0].id : null;
        if (!newId) return res.status(500).json({ error: `Split ${i} insert returned no id` });
        createdIds.push(newId);

        // Reassign memberships
        for (const m of v.memberRows) {
          await fetch(`${SUPABASE_URL}/rest/v1/cluster_membership?id=eq.${m.id}`, {
            method: 'PATCH',
            headers: { ...headers, Prefer: 'return=minimal' },
            body: JSON.stringify({ candidate_taxonomy_id: newId }),
          });
        }
      }

      // Backfill + resolution audit for each canonical
      const results = [];
      for (const id of createdIds) {
        const rewriteCount = await runBackfill(SUPABASE_URL, headers, id, invokeId);
        const resolutionsCount = await recordResolutions(SUPABASE_URL, headers, id, invokeId);
        results.push({ canonical_id: id, sessions_rewritten: rewriteCount, resolutions_recorded: resolutionsCount });
      }

      return res.status(200).json({ success: true, action: 'split', canonical_ids: createdIds, splits: results });
    }

    if (action === 'reject') {
      const updates = {
        status: 'retired',
        retired_at: new Date().toISOString(),
        retired_reason: body.reviewer_notes || 'rejected during cluster review',
        reviewed_at: new Date().toISOString(),
        review_action: 'rejected',
        reviewer_notes: body.reviewer_notes || null,
      };
      const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/pattern_taxonomy?id=eq.${candidate_id}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify(updates),
      });
      if (!patchRes.ok) {
        const t = await patchRes.text().catch(() => '');
        return res.status(500).json({ error: 'Reject patch failed', detail: t.slice(0, 200) });
      }
      return res.status(200).json({ success: true, action: 'reject', canonical_id: candidate_id });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (e) {
    console.error('[promote-cluster-candidate] FATAL', { invokeId, message: e && e.message });
    return res.status(500).json({ error: (e && e.message) || 'Internal error', invoke_id: invokeId });
  }
}
