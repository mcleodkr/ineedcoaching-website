// POST { sessionAccessToken, include_historical?: bool, include_existing_candidates?: bool, trigger_source?: string }
// Brief 2b: Batched cluster generation for the taxonomy review UI.
//
// Gathers (a) distinct historical normalized tags from coach_session_notes
// whose sessions have NOT been canonicalized by the Brief 2a pipeline, and
// (b) existing 'candidate' pattern_taxonomy rows not yet linked to a prior
// cluster run. Asks Claude in ONE expensive call to group them into clean
// canonical clusters with proposed canonical_name / aliases / domain /
// modalities / definition / reasoning per cluster. Writes one candidate
// row per cluster into pattern_taxonomy (status='candidate',
// source='cluster_review', cluster_proposal_id=<shared run id>) and one
// cluster_membership row per raw tag.
//
// Admin-only: sessionAccessToken must resolve to Kim's email.

import { logAIUsage, calculateCost } from '../lib/ai-usage.js';
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
const FALLBACK_DOMAIN = 'cognitive_patterns';

function normalizeTag(raw) {
  if (typeof raw !== 'string') return null;
  let n = raw.toLowerCase().trim();
  n = n.replace(/_/g, ' ');
  n = n.replace(/\s+/g, ' ');
  return n.length > 0 ? n : null;
}

function isValidProposedName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= 60
    && name === name.toLowerCase()
    && name === name.trim()
    && !name.includes('_');
}

function isValidDefinition(def) {
  return typeof def === 'string' && def.trim().length >= 80 && def.trim().length <= 1200;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured (Supabase)' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Server not configured (Anthropic)' });

  const invokeId = crypto.randomBytes(4).toString('hex');
  const startTime = Date.now();

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const sessionAccessToken = body.sessionAccessToken;
  if (!sessionAccessToken) return res.status(401).json({ error: 'Missing sessionAccessToken' });

  // Admin auth check (same pattern as admin-query.js)
  try {
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${sessionAccessToken}` },
    });
    if (!authRes.ok) return res.status(401).json({ error: 'Invalid session' });
    const user = await authRes.json();
    const callerEmail = (user.email || '').toLowerCase();
    if (callerEmail !== ADMIN_EMAIL) return res.status(403).json({ error: 'Not authorized' });
  } catch (e) {
    console.error('[generate-cluster-proposals] auth check failed', { invokeId, message: e.message });
    return res.status(401).json({ error: 'Auth check failed' });
  }

  const includeHistorical = body.include_historical !== false;
  const includeExistingCandidates = body.include_existing_candidates !== false;
  const triggerSource = body.trigger_source || 'admin_dashboard';

  console.log('[generate-cluster-proposals] invoked', { invokeId, includeHistorical, includeExistingCandidates, triggerSource });

  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
  const clusterProposalId = crypto.randomUUID();

  try {
    // ── STEP 1: Gather inputs via RPC-style SQL through PostgREST ────────
    // We can't run arbitrary SQL via PostgREST. Pull the raw data and aggregate
    // in JS instead. Pull only sessions WITHOUT an existing canonicalization
    // resolution row (i.e. pre-Brief-2a sessions).

    // 1a: list of session ids that have at least one dna_tag_resolutions row
    const resolvedSessionsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/dna_tag_resolutions?select=source_session_id&source_session_id=not.is.null`,
      { headers }
    );
    const resolvedSessionRows = resolvedSessionsRes.ok ? await resolvedSessionsRes.json() : [];
    const excludedSessionIds = new Set(resolvedSessionRows.map(r => r.source_session_id).filter(Boolean));

    // 1b: walk coach_session_notes pages
    const tagOccurrences = new Map(); // normalized -> { occurrence_count, raw_variants:Set, first_raw }
    if (includeHistorical) {
      let offset = 0;
      const pageSize = 200;
      while (true) {
        const pageRes = await fetch(
          `${SUPABASE_URL}/rest/v1/coach_session_notes?select=id,post_session_analysis&post_session_analysis=not.is.null&order=created_at.desc&limit=${pageSize}&offset=${offset}`,
          { headers }
        );
        if (!pageRes.ok) break;
        const page = await pageRes.json();
        if (!Array.isArray(page) || page.length === 0) break;
        for (const row of page) {
          if (excludedSessionIds.has(row.id)) continue;
          const interventions = row.post_session_analysis && Array.isArray(row.post_session_analysis.coaching_interventions)
            ? row.post_session_analysis.coaching_interventions : [];
          for (const intervention of interventions) {
            const tags = intervention && Array.isArray(intervention.dna_tag) ? intervention.dna_tag : [];
            for (const rawTag of tags) {
              const norm = normalizeTag(rawTag);
              if (!norm) continue;
              if (!tagOccurrences.has(norm)) {
                tagOccurrences.set(norm, { occurrence_count: 0, raw_variants: new Set(), first_raw: rawTag, is_from_history: true });
              }
              const entry = tagOccurrences.get(norm);
              entry.occurrence_count += 1;
              entry.raw_variants.add(rawTag);
            }
          }
        }
        if (page.length < pageSize) break;
        offset += pageSize;
      }
    }

    // 1c: pull existing candidates (with no prior cluster_proposal_id)
    let existingCandidates = [];
    if (includeExistingCandidates) {
      const candRes = await fetch(
        `${SUPABASE_URL}/rest/v1/pattern_taxonomy?status=eq.candidate&approved_at=is.null&cluster_proposal_id=is.null&select=id,canonical_name,proposed_canonical_name,proposed_domain,proposed_modalities,proposed_aliases,proposed_definition,proposal_reasoning`,
        { headers }
      );
      existingCandidates = candRes.ok ? await candRes.json() : [];
      for (const cand of existingCandidates) {
        const norm = normalizeTag(cand.canonical_name);
        if (!norm) continue;
        if (!tagOccurrences.has(norm)) {
          tagOccurrences.set(norm, { occurrence_count: 1, raw_variants: new Set([cand.canonical_name]), first_raw: cand.canonical_name, is_from_history: false, existing_candidate_id: cand.id });
        } else {
          const entry = tagOccurrences.get(norm);
          entry.existing_candidate_id = cand.id;
        }
      }
    }

    if (tagOccurrences.size === 0) {
      console.log('[generate-cluster-proposals] no tags to cluster', { invokeId });
      return res.status(200).json({
        cluster_proposal_id: clusterProposalId,
        clusters_proposed: 0,
        tags_analyzed: 0,
        candidates_created: 0,
        duration_ms: Date.now() - startTime,
      });
    }

    // 1d: pull all active canonicals (for Claude context — "merge into these only if unambiguous")
    const taxonomyRes = await fetch(
      `${SUPABASE_URL}/rest/v1/pattern_taxonomy?status=eq.canonical&select=canonical_name,domain,definition,aliases&order=canonical_name`,
      { headers }
    );
    const existingCanonicals = taxonomyRes.ok ? await taxonomyRes.json() : [];

    const tagList = Array.from(tagOccurrences.entries()).map(([norm, entry]) => ({
      normalized_tag: norm,
      occurrence_count: entry.occurrence_count,
      raw_variants: Array.from(entry.raw_variants),
      is_from_history: entry.is_from_history,
      existing_candidate_id: entry.existing_candidate_id || null,
    }));

    // ── STEP 2: Build Claude prompt ─────────────────────────────────────
    const existingCanonicalsListing = existingCanonicals.length
      ? existingCanonicals.map(c => {
          const aliasStr = Array.isArray(c.aliases) && c.aliases.length ? ` (aliases: ${c.aliases.join(', ')})` : '';
          const defStr = c.definition ? ` — ${c.definition.substring(0, 160)}${c.definition.length > 160 ? '...' : ''}` : '';
          return `- ${c.canonical_name} [${c.domain}]${aliasStr}${defStr}`;
        }).join('\n')
      : '(none — every cluster will be a new canonical)';

    const systemPrompt = `You are organizing coaching pattern tags into a clean canonical taxonomy.

You will receive a list of raw tags currently in use across coaching sessions. Your job is to:

1. Group tags that refer to the same underlying coaching pattern.
2. Propose a canonical name for each group (the official name that will replace all variants).
3. For each cluster, propose:
   - canonical_name: lowercase, spaces (not underscores), 1-4 words, must be self-explanatory when a coach reads it cold. Avoid jargon. "shame reduction" is good. "intentional agency" requires explanation.
   - aliases: the raw tags that would unify under this canonical (drawn from the input list, lowercase, spaces)
   - domain: ONE of: ${VALID_DOMAINS.join(', ')}
   - modalities: subset of [${VALID_MODALITIES.join(', ')}]
   - definition: 2-3 sentences in Gestalt voice. Use "effective at X, ineffective at Y, protects against Z" structure. Never use should/must/right/wrong/good/bad/mistake/failure.
   - reasoning: one sentence on why these tags belong together, in language a non-technical coach can understand

EXISTING CANONICALS (already in the taxonomy — propose merging into these only if the match is unambiguous; otherwise create new clusters):
${existingCanonicalsListing}

CRITICAL RULES:
- canonical_name must pass the "cold-read test": a coach who has never seen it before should understand what it means without a hover. If your proposed name requires a definition to understand, propose a different name.
- Prefer the most-used raw tag as the canonical when it passes the cold-read test. Only propose a renamed canonical when the existing language is genuinely unclear.
- Each cluster needs at least 1 raw tag. Singleton clusters (one tag, no aliases) are acceptable.
- Do NOT split tags arbitrarily. If "identity integration" and "identity shift" describe the same conceptual movement, cluster them. If "identity integration" and "identity safety" describe different things, separate them.
- Every input tag must appear in exactly one cluster's "aliases" list. Do not drop tags.

Return STRICT JSON, no prose, no markdown fences:
{
  "clusters": [
    {
      "canonical_name": "...",
      "aliases": ["..."],
      "domain": "...",
      "modalities": ["..."],
      "definition": "...",
      "reasoning": "..."
    }
  ]
}`;

    const userPrompt = `Tags to cluster (${tagList.length} total):\n${tagList.map(t => `- "${t.normalized_tag}" (appears ${t.occurrence_count} ${t.occurrence_count === 1 ? 'time' : 'times'}${t.is_from_history ? '' : ', existing candidate'})`).join('\n')}`;

    // ── STEP 3: Call Claude ────────────────────────────────────────────
    const model = 'claude-sonnet-4-6';
    const claudeStart = Date.now();
    let claudeRes;
    let claudeData = null;
    let claudeOk = false;
    try {
      claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: 8000,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });
      claudeOk = claudeRes.ok;
      claudeData = await claudeRes.json().catch(() => null);
    } catch (e) {
      console.error('[generate-cluster-proposals] claude fetch failed', { invokeId, message: e.message });
    }

    await logAIUsage({
      feature: 'cluster_proposal_generation',
      model: (claudeData && claudeData.model) || model,
      usage: claudeData && claudeData.usage,
      requestId: (claudeData && claudeData.id) || invokeId,
      status: claudeOk ? 'success' : 'error',
      errorMessage: claudeOk ? null : (claudeData && claudeData.error && claudeData.error.message) || 'Claude call failed',
      durationMs: Date.now() - claudeStart,
      coachId: KIM_COACH_ID,
    }).catch(() => {});

    if (!claudeOk) {
      console.error('[generate-cluster-proposals] claude call failed', { invokeId, status: claudeRes && claudeRes.status });
      return res.status(502).json({ error: 'Cluster generation failed (Claude error)', invoke_id: invokeId });
    }

    let clusters = [];
    {
      const text = (claudeData && claudeData.content && claudeData.content[0] && claudeData.content[0].text) || '';
      try {
        const m = text.match(/\{[\s\S]*\}/);
        const parsed = m ? JSON.parse(m[0]) : JSON.parse(text);
        clusters = Array.isArray(parsed && parsed.clusters) ? parsed.clusters : [];
      } catch (e) {
        console.error('[generate-cluster-proposals] claude parse failed', { invokeId, message: e.message, head: text.slice(0, 200) });
        return res.status(502).json({ error: 'Cluster generation failed (parse error)', invoke_id: invokeId });
      }
    }

    // ── STEP 4: Validate + persist clusters ─────────────────────────────
    let candidatesCreated = 0;
    const usedNorms = new Set();

    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i];
      const proposedNameRaw = c && typeof c.canonical_name === 'string' ? normalizeTag(c.canonical_name) : null;
      if (!isValidProposedName(proposedNameRaw)) {
        console.warn('[generate-cluster-proposals] cluster skipped (invalid name)', { invokeId, idx: i, name: c && c.canonical_name });
        continue;
      }
      const proposedDomain = c && VALID_DOMAINS.includes(c.domain) ? c.domain : FALLBACK_DOMAIN;
      const proposedModalities = Array.isArray(c && c.modalities)
        ? c.modalities.filter(m => VALID_MODALITIES.includes(m))
        : [];
      const proposedAliases = Array.isArray(c && c.aliases)
        ? Array.from(new Set(c.aliases.map(a => normalizeTag(a)).filter(a => a && a.length > 0)))
        : [];
      const proposedDefinition = c && typeof c.definition === 'string' ? c.definition.trim() : '';
      if (!isValidDefinition(proposedDefinition)) {
        console.warn('[generate-cluster-proposals] cluster skipped (invalid definition)', { invokeId, idx: i, name: proposedNameRaw, defLen: proposedDefinition.length });
        continue;
      }
      const proposalReasoning = c && typeof c.reasoning === 'string' ? c.reasoning.trim() : null;

      // Determine which raw tags map to this cluster.
      // The canonical itself is included if it matches an input tag.
      const clusterMembers = new Map(); // normalized -> input tag entry
      const considerTags = [proposedNameRaw, ...proposedAliases];
      for (const tag of considerTags) {
        if (tagOccurrences.has(tag) && !usedNorms.has(tag)) {
          clusterMembers.set(tag, tagOccurrences.get(tag));
        }
      }
      if (clusterMembers.size === 0) {
        console.warn('[generate-cluster-proposals] cluster skipped (no members matched input)', { invokeId, idx: i, name: proposedNameRaw });
        continue;
      }

      // If an existing candidate matches the proposed canonical_name, reuse that row.
      // Otherwise create a new candidate row.
      let candidateId = null;
      const existingCandidateInput = clusterMembers.get(proposedNameRaw);
      if (existingCandidateInput && existingCandidateInput.existing_candidate_id) {
        candidateId = existingCandidateInput.existing_candidate_id;
        // Patch existing candidate to link to this cluster run and update proposed_* fields
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/pattern_taxonomy?id=eq.${candidateId}`, {
            method: 'PATCH',
            headers: { ...headers, Prefer: 'return=minimal' },
            body: JSON.stringify({
              cluster_proposal_id: clusterProposalId,
              proposed_canonical_name: proposedNameRaw,
              proposed_domain: proposedDomain,
              proposed_modalities: proposedModalities,
              proposed_aliases: proposedAliases,
              proposed_definition: proposedDefinition,
              proposal_reasoning: proposalReasoning,
              proposed_at: new Date().toISOString(),
            }),
          });
        } catch (e) {
          console.warn('[generate-cluster-proposals] existing candidate patch failed', { invokeId, candidateId, message: e.message });
        }
      } else {
        // Check whether a same-name candidate already exists (race / earlier run)
        const findRes = await fetch(
          `${SUPABASE_URL}/rest/v1/pattern_taxonomy?canonical_name=eq.${encodeURIComponent(proposedNameRaw)}&status=in.(canonical,candidate)&select=id,status&limit=1`,
          { headers }
        );
        const found = findRes.ok ? await findRes.json() : [];
        if (Array.isArray(found) && found.length) {
          // If it's canonical, we don't need to create — just link memberships to that id (a kind of "merge into existing canonical" proposal)
          candidateId = found[0].id;
          if (found[0].status === 'candidate') {
            try {
              await fetch(`${SUPABASE_URL}/rest/v1/pattern_taxonomy?id=eq.${candidateId}`, {
                method: 'PATCH',
                headers: { ...headers, Prefer: 'return=minimal' },
                body: JSON.stringify({
                  cluster_proposal_id: clusterProposalId,
                  proposed_canonical_name: proposedNameRaw,
                  proposed_domain: proposedDomain,
                  proposed_modalities: proposedModalities,
                  proposed_aliases: proposedAliases,
                  proposed_definition: proposedDefinition,
                  proposal_reasoning: proposalReasoning,
                  proposed_at: new Date().toISOString(),
                }),
              });
            } catch (e) {
              console.warn('[generate-cluster-proposals] candidate patch failed', { invokeId, candidateId, message: e.message });
            }
          }
        } else {
          // Create new candidate row
          const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/pattern_taxonomy`, {
            method: 'POST',
            headers: { ...headers, Prefer: 'return=representation' },
            body: JSON.stringify({
              canonical_name: proposedNameRaw,
              domain: proposedDomain,
              modalities: proposedModalities,
              definition: proposedDefinition,
              aliases: proposedAliases,
              status: 'candidate',
              source: 'cluster_review',
              cluster_proposal_id: clusterProposalId,
              proposed_canonical_name: proposedNameRaw,
              proposed_domain: proposedDomain,
              proposed_modalities: proposedModalities,
              proposed_aliases: proposedAliases,
              proposed_definition: proposedDefinition,
              proposal_reasoning: proposalReasoning,
              proposed_at: new Date().toISOString(),
            }),
          });
          if (insertRes.ok) {
            const rows = await insertRes.json().catch(() => null);
            if (Array.isArray(rows) && rows.length) {
              candidateId = rows[0].id;
              candidatesCreated += 1;
            }
          } else {
            const errText = await insertRes.text().catch(() => '');
            console.warn('[generate-cluster-proposals] insert candidate failed', { invokeId, name: proposedNameRaw, status: insertRes.status, body: errText.slice(0, 200) });
            continue;
          }
        }
      }

      if (!candidateId) continue;

      // Insert cluster_membership rows for each matched input tag
      const memberRows = [];
      for (const [norm, entry] of clusterMembers.entries()) {
        memberRows.push({
          cluster_proposal_id: clusterProposalId,
          candidate_taxonomy_id: candidateId,
          raw_tag: entry.first_raw || norm,
          normalized_tag: norm,
          occurrence_count: entry.occurrence_count,
          is_from_history: entry.is_from_history !== false,
        });
        usedNorms.add(norm);
      }

      if (memberRows.length > 0) {
        const memRes = await fetch(`${SUPABASE_URL}/rest/v1/cluster_membership?on_conflict=cluster_proposal_id,normalized_tag`, {
          method: 'POST',
          headers: { ...headers, Prefer: 'return=minimal,resolution=ignore-duplicates' },
          body: JSON.stringify(memberRows),
        });
        if (!memRes.ok) {
          const errText = await memRes.text().catch(() => '');
          console.warn('[generate-cluster-proposals] cluster_membership insert failed', { invokeId, candidateId, status: memRes.status, body: errText.slice(0, 200) });
        }
      }
    }

    // ── STEP 5: Park any leftover (unmatched) input tags as singleton candidates ──
    // Claude may have dropped tags. We must capture every tag so review covers all of them.
    let orphansHandled = 0;
    for (const [norm, entry] of tagOccurrences.entries()) {
      if (usedNorms.has(norm)) continue;
      let candidateId = entry.existing_candidate_id || null;
      if (!candidateId) {
        // Create singleton candidate using the raw tag itself as canonical
        const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/pattern_taxonomy`, {
          method: 'POST',
          headers: { ...headers, Prefer: 'return=representation' },
          body: JSON.stringify({
            canonical_name: norm,
            domain: FALLBACK_DOMAIN,
            modalities: [],
            definition: 'Coach pattern surfaced during review without a Gestalt definition. Awaiting human-authored definition.',
            aliases: [],
            status: 'candidate',
            source: 'cluster_review',
            cluster_proposal_id: clusterProposalId,
            proposed_canonical_name: norm,
            proposed_domain: FALLBACK_DOMAIN,
            proposed_modalities: [],
            proposed_aliases: [],
            proposed_definition: 'Coach pattern surfaced during review without a Gestalt definition. Awaiting human-authored definition.',
            proposal_reasoning: 'Singleton: Claude did not group this tag with any other; preserved as its own candidate for review.',
            proposed_at: new Date().toISOString(),
          }),
        });
        if (insertRes.ok) {
          const rows = await insertRes.json().catch(() => null);
          if (Array.isArray(rows) && rows.length) {
            candidateId = rows[0].id;
            candidatesCreated += 1;
          }
        }
      } else {
        // Link existing candidate to this run
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/pattern_taxonomy?id=eq.${candidateId}`, {
            method: 'PATCH',
            headers: { ...headers, Prefer: 'return=minimal' },
            body: JSON.stringify({ cluster_proposal_id: clusterProposalId }),
          });
        } catch (e) {
          console.warn('[generate-cluster-proposals] orphan patch failed', { invokeId, candidateId, message: e.message });
        }
      }
      if (candidateId) {
        await fetch(`${SUPABASE_URL}/rest/v1/cluster_membership?on_conflict=cluster_proposal_id,normalized_tag`, {
          method: 'POST',
          headers: { ...headers, Prefer: 'return=minimal,resolution=ignore-duplicates' },
          body: JSON.stringify([{
            cluster_proposal_id: clusterProposalId,
            candidate_taxonomy_id: candidateId,
            raw_tag: entry.first_raw || norm,
            normalized_tag: norm,
            occurrence_count: entry.occurrence_count,
            is_from_history: entry.is_from_history !== false,
          }]),
        });
        orphansHandled += 1;
        usedNorms.add(norm);
      }
    }

    const duration = Date.now() - startTime;
    console.log('[generate-cluster-proposals] complete', {
      invokeId,
      clusterProposalId,
      tagsAnalyzed: tagOccurrences.size,
      clustersProposed: clusters.length,
      candidatesCreated,
      orphansHandled,
      durationMs: duration,
    });

    return res.status(200).json({
      cluster_proposal_id: clusterProposalId,
      clusters_proposed: clusters.length,
      tags_analyzed: tagOccurrences.size,
      candidates_created: candidatesCreated,
      orphans_handled: orphansHandled,
      duration_ms: duration,
    });
  } catch (e) {
    console.error('[generate-cluster-proposals] FATAL', { invokeId, message: e && e.message, stack: e && e.stack ? e.stack.substring(0, 500) : null });
    return res.status(500).json({ error: (e && e.message) || 'Internal error', invoke_id: invokeId });
  }
}
