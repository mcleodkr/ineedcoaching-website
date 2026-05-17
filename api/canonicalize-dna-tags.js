// POST { tags: string[], source_session_id?: uuid, source_endpoint?: string }
// Brief 2a: Canonicalization service for raw dna_tag strings.
//
// Resolves each raw tag to its canonical pattern_taxonomy entry via a
// 4-step algorithm: normalize → existing resolution lookup → exact match
// (canonical_name or alias) → Claude similarity judgment. Unmatched tags
// become new candidates with proposed_* fields populated by Claude for
// later human review in Brief 2b's UI.
//
// Returns one row per input tag, in input order. Service errors degrade to
// fallback_passthrough resolutions (taxonomy_id: null) — the caller is
// expected to treat null taxonomy_id as "store the raw tag as-is."
// This means a canonicalization outage downgrades to today's behavior
// rather than breaking the post-session intelligence pipeline.

import { logAIUsage } from '../lib/ai-usage.js';

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

// PostgREST `in.(...)` filter values need quoting if they contain commas,
// parentheses, or other reserved characters. Wrap each value in double
// quotes and escape any embedded double quotes.
function pgInList(values) {
  return values.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
}

function isValidProposedName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= 60
    && name === name.toLowerCase()
    && name === name.trim()
    && !name.includes('_');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured (Supabase)' });

  const invokeId = Math.random().toString(36).slice(2, 10);
  const startTime = Date.now();
  console.log('[canonicalize-dna-tags] invoked', { invokeId });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const tagsInput = Array.isArray(body && body.tags) ? body.tags : null;
    if (!tagsInput) return res.status(400).json({ error: 'tags must be an array of strings' });

    const sourceSessionId = (body && body.source_session_id) || null;
    const sourceEndpoint = (body && body.source_endpoint) || 'unknown';

    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

    // Normalize + retain raw → normalized mapping. Drop empty/non-string entries.
    const items = [];
    for (const raw of tagsInput) {
      const norm = normalizeTag(raw);
      if (norm) items.push({ raw_tag: raw, normalized_tag: norm });
    }

    if (items.length === 0) {
      console.log('[canonicalize-dna-tags] empty batch', { invokeId });
      return res.status(200).json({ resolutions: [], invoke_id: invokeId, duration_ms: Date.now() - startTime });
    }

    const uniqueNormalized = Array.from(new Set(items.map(i => i.normalized_tag)));

    // ── STEP 1: lookup existing resolutions (idempotency) ─────────────
    const lookupRes = await fetch(
      `${SUPABASE_URL}/rest/v1/dna_tag_resolutions?normalized_tag=in.(${pgInList(uniqueNormalized)})&select=normalized_tag,taxonomy_id,resolution_method,confidence`,
      { headers }
    );
    const existingResolutions = lookupRes.ok ? await lookupRes.json() : [];
    const existingByNorm = {};
    for (const r of existingResolutions) existingByNorm[r.normalized_tag] = r;

    // ── STEP 2: fetch all active pattern_taxonomy rows (used for both
    //   local exact-match scans and as Claude's context if needed) ────
    const taxonomyRes = await fetch(
      `${SUPABASE_URL}/rest/v1/pattern_taxonomy?status=in.(canonical,candidate)&select=id,canonical_name,aliases,domain,definition,status&order=canonical_name`,
      { headers }
    );
    const allTaxonomy = taxonomyRes.ok ? await taxonomyRes.json() : [];

    const canonByName = {};
    const aliasMap = {};
    for (const t of allTaxonomy) {
      canonByName[t.canonical_name] = t;
      if (Array.isArray(t.aliases)) {
        for (const a of t.aliases) {
          if (typeof a === 'string') aliasMap[a] = t;
        }
      }
    }
    const taxonomyById = {};
    for (const t of allTaxonomy) taxonomyById[t.id] = t;

    const resolutionsByNormalized = {};

    // Helper: persist a resolution row (idempotent via on_conflict)
    async function persistResolution(row) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/dna_tag_resolutions?on_conflict=normalized_tag`, {
          method: 'POST',
          headers: { ...headers, Prefer: 'return=minimal,resolution=ignore-duplicates' },
          body: JSON.stringify(row),
        });
      } catch (e) {
        console.warn('[canonicalize-dna-tags] persistResolution failed (non-fatal)', { invokeId, message: e.message });
      }
    }

    // Helper: upsert a candidate row in pattern_taxonomy. Find-then-insert
    // pattern with re-find on insert failure to handle races and the partial
    // unique constraint on canonical_name (active rows only).
    async function upsertCandidate(payload) {
      try {
        const findRes = await fetch(
          `${SUPABASE_URL}/rest/v1/pattern_taxonomy?canonical_name=eq.${encodeURIComponent(payload.canonical_name)}&status=in.(canonical,candidate)&select=id,canonical_name,proposed_canonical_name,proposed_domain,proposed_modalities,proposal_reasoning&limit=1`,
          { headers }
        );
        const found = findRes.ok ? await findRes.json() : [];
        if (Array.isArray(found) && found.length) return found[0];

        const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/pattern_taxonomy`, {
          method: 'POST',
          headers: { ...headers, Prefer: 'return=representation' },
          body: JSON.stringify({
            canonical_name: payload.canonical_name,
            domain: payload.domain,
            modalities: payload.modalities || [],
            status: 'candidate',
            source: payload.source,
            proposed_canonical_name: payload.proposed_canonical_name,
            proposed_domain: payload.proposed_domain,
            proposed_modalities: payload.proposed_modalities,
            proposed_aliases: payload.proposed_aliases,
            proposed_definition: payload.proposed_definition,
            proposal_reasoning: payload.proposal_reasoning,
            proposed_at: new Date().toISOString(),
          }),
        });
        if (insertRes.ok) {
          const rows = await insertRes.json().catch(() => null);
          if (Array.isArray(rows) && rows.length) return rows[0];
        } else {
          // Insert failed (likely unique-index race) — re-find the existing row.
          const refind = await fetch(
            `${SUPABASE_URL}/rest/v1/pattern_taxonomy?canonical_name=eq.${encodeURIComponent(payload.canonical_name)}&status=in.(canonical,candidate)&select=id,canonical_name,proposed_canonical_name,proposed_domain,proposed_modalities,proposal_reasoning&limit=1`,
            { headers }
          );
          const refound = refind.ok ? await refind.json() : [];
          if (Array.isArray(refound) && refound.length) return refound[0];
        }
      } catch (e) {
        console.warn('[canonicalize-dna-tags] upsertCandidate failed (non-fatal)', { invokeId, message: e.message });
      }
      return null;
    }

    // ── STEP 3: resolve each unique normalized tag ─────────────────────
    const needsClaude = [];
    for (const norm of uniqueNormalized) {
      // 3a: existing resolution (idempotent cache)
      const existing = existingByNorm[norm];
      if (existing && taxonomyById[existing.taxonomy_id]) {
        const tax = taxonomyById[existing.taxonomy_id];
        resolutionsByNormalized[norm] = {
          normalized_tag: norm,
          taxonomy_id: existing.taxonomy_id,
          canonical_name: tax.canonical_name,
          resolution_method: existing.resolution_method,
          confidence: existing.confidence,
          is_canonical_promoted: tax.status === 'canonical',
          is_new_candidate: false,
        };
        continue;
      }
      // 3b: exact canonical
      if (canonByName[norm]) {
        const tax = canonByName[norm];
        const row = {
          raw_tag: items.find(i => i.normalized_tag === norm).raw_tag,
          normalized_tag: norm,
          taxonomy_id: tax.id,
          resolution_method: 'exact_canonical',
          confidence: 'exact',
          reasoning: null,
          source_session_id: sourceSessionId,
          source_endpoint: sourceEndpoint,
          resolved_by_run_id: invokeId,
        };
        await persistResolution(row);
        resolutionsByNormalized[norm] = {
          normalized_tag: norm,
          taxonomy_id: tax.id,
          canonical_name: tax.canonical_name,
          resolution_method: 'exact_canonical',
          confidence: 'exact',
          is_canonical_promoted: tax.status === 'canonical',
          is_new_candidate: false,
        };
        continue;
      }
      // 3c: exact alias
      if (aliasMap[norm]) {
        const tax = aliasMap[norm];
        const row = {
          raw_tag: items.find(i => i.normalized_tag === norm).raw_tag,
          normalized_tag: norm,
          taxonomy_id: tax.id,
          resolution_method: 'exact_alias',
          confidence: 'exact',
          reasoning: null,
          source_session_id: sourceSessionId,
          source_endpoint: sourceEndpoint,
          resolved_by_run_id: invokeId,
        };
        await persistResolution(row);
        resolutionsByNormalized[norm] = {
          normalized_tag: norm,
          taxonomy_id: tax.id,
          canonical_name: tax.canonical_name,
          resolution_method: 'exact_alias',
          confidence: 'exact',
          is_canonical_promoted: tax.status === 'canonical',
          is_new_candidate: false,
        };
        continue;
      }
      // 3d: needs Claude
      needsClaude.push(norm);
    }

    // ── STEP 4: Claude similarity judgment for unresolved ──────────────
    if (needsClaude.length > 0) {
      if (!ANTHROPIC_API_KEY) {
        // No Claude → fallback passthrough for all unresolved
        for (const norm of needsClaude) {
          resolutionsByNormalized[norm] = {
            normalized_tag: norm,
            taxonomy_id: null,
            resolution_method: 'fallback_passthrough',
            confidence: 'low',
            error: 'ANTHROPIC_API_KEY not configured; tag stored as-is',
          };
        }
      } else {
        const canonicalsListing = allTaxonomy.map(c => {
          const aliasStr = Array.isArray(c.aliases) && c.aliases.length ? ` (aliases: ${c.aliases.join(', ')})` : '';
          const defStr = c.definition ? ` — ${c.definition.substring(0, 200)}${c.definition.length > 200 ? '...' : ''}` : '';
          return `- ${c.canonical_name} [${c.domain}]${aliasStr}${defStr}`;
        }).join('\n');

        const systemPrompt = `You are evaluating coaching pattern tags against an existing canonical taxonomy.

Existing canonicals:
${canonicalsListing || '(none yet — every input tag will be a new candidate)'}

For each input tag, decide whether it is:
1. alias_of an existing canonical (semantically equivalent — name it in alias_canonical), OR
2. new_candidate (genuinely new pattern not represented above)

If alias_of, return confidence as high / medium / low. Only high will be auto-aliased; medium/low will be treated conservatively as new_candidate.

If new_candidate, propose:
- canonical_name (lowercase, spaces not underscores, 1-4 words, max 60 chars)
- domain (exactly one of: ${VALID_DOMAINS.join(', ')})
- modalities (subset of: ${VALID_MODALITIES.join(', ')})
- aliases (1-4 likely synonyms, lowercase, max 10 entries)
- definition (Gestalt voice: "effective at X, ineffective at Y, protects against Z")
- reasoning (one sentence on why new vs alias)

Return STRICT JSON, no prose, no markdown fences:
{ "verdicts": [ { "raw_tag": "...", "verdict": "alias_of" | "new_candidate", "alias_canonical": "..." | null, "confidence": "high" | "medium" | "low", "proposed_canonical_name": "..." | null, "proposed_domain": "..." | null, "proposed_modalities": [...] | null, "proposed_aliases": [...] | null, "proposed_definition": "..." | null, "reasoning": "..." } ] }`;

        const userPrompt = `Tags to evaluate:\n${needsClaude.map(t => `- "${t}"`).join('\n')}`;

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
              max_tokens: 4000,
              system: systemPrompt,
              messages: [{ role: 'user', content: userPrompt }],
            }),
          });
          claudeOk = claudeRes.ok;
          claudeData = await claudeRes.json().catch(() => null);
        } catch (e) {
          console.error('[canonicalize-dna-tags] claude fetch failed', { invokeId, message: e.message });
        }

        await logAIUsage({
          feature: 'canonicalize_dna_tags',
          model: (claudeData && claudeData.model) || model,
          usage: claudeData && claudeData.usage,
          requestId: (claudeData && claudeData.id) || invokeId,
          status: claudeOk ? 'success' : 'error',
          errorMessage: claudeOk ? null : (claudeData && claudeData.error && claudeData.error.message) || 'Claude call failed',
          durationMs: Date.now() - claudeStart,
        }).catch(() => {});

        let verdicts = [];
        if (claudeOk) {
          const text = (claudeData && claudeData.content && claudeData.content[0] && claudeData.content[0].text) || '';
          try {
            const m = text.match(/\{[\s\S]*\}/);
            const parsed = m ? JSON.parse(m[0]) : JSON.parse(text);
            verdicts = Array.isArray(parsed && parsed.verdicts) ? parsed.verdicts : [];
          } catch (e) {
            console.error('[canonicalize-dna-tags] claude parse failed', { invokeId, message: e.message, head: text.slice(0, 200) });
          }
        }

        const verdictsByNorm = {};
        for (const v of verdicts) {
          const norm = normalizeTag(v && v.raw_tag);
          if (norm) verdictsByNorm[norm] = v;
        }

        for (const norm of needsClaude) {
          const v = verdictsByNorm[norm];
          const rawTag = items.find(i => i.normalized_tag === norm).raw_tag;

          // Decide alias_of vs new_candidate. Medium/low alias confidence
          // is downgraded to new_candidate per Brief 2a spec.
          const isAliasHighMatch = v
            && v.verdict === 'alias_of'
            && v.confidence === 'high'
            && typeof v.alias_canonical === 'string'
            && canonByName[v.alias_canonical];

          if (isAliasHighMatch) {
            const tax = canonByName[v.alias_canonical];
            const currentAliases = Array.isArray(tax.aliases) ? tax.aliases : [];
            if (!currentAliases.includes(norm)) {
              const newAliases = [...currentAliases, norm];
              try {
                await fetch(`${SUPABASE_URL}/rest/v1/pattern_taxonomy?id=eq.${tax.id}`, {
                  method: 'PATCH',
                  headers: { ...headers, Prefer: 'return=minimal' },
                  body: JSON.stringify({ aliases: newAliases }),
                });
                tax.aliases = newAliases;
                aliasMap[norm] = tax;
              } catch (e) {
                console.warn('[canonicalize-dna-tags] alias append failed (non-fatal)', { invokeId, message: e.message });
              }
            }
            await persistResolution({
              raw_tag: rawTag,
              normalized_tag: norm,
              taxonomy_id: tax.id,
              resolution_method: 'similarity_match',
              confidence: 'high',
              reasoning: typeof v.reasoning === 'string' ? v.reasoning : null,
              source_session_id: sourceSessionId,
              source_endpoint: sourceEndpoint,
              resolved_by_run_id: invokeId,
            });
            resolutionsByNormalized[norm] = {
              normalized_tag: norm,
              taxonomy_id: tax.id,
              canonical_name: tax.canonical_name,
              resolution_method: 'similarity_match',
              confidence: 'high',
              is_canonical_promoted: tax.status === 'canonical',
              is_new_candidate: false,
              reasoning: typeof v.reasoning === 'string' ? v.reasoning : null,
            };
            continue;
          }

          // new_candidate path. Validate Claude's proposal; fall back to a
          // minimal candidate if any safeguard rejects (so the pipeline never
          // breaks just because Claude produced an invalid proposal).
          const proposedNameRaw = v && typeof v.proposed_canonical_name === 'string' ? normalizeTag(v.proposed_canonical_name) : null;
          const proposedNameOk = isValidProposedName(proposedNameRaw);
          const proposedDomain = v && VALID_DOMAINS.includes(v.proposed_domain) ? v.proposed_domain : FALLBACK_DOMAIN;
          const proposedModalities = Array.isArray(v && v.proposed_modalities)
            ? v.proposed_modalities.filter(m => VALID_MODALITIES.includes(m))
            : [];
          const proposedAliases = Array.isArray(v && v.proposed_aliases)
            ? v.proposed_aliases.map(a => normalizeTag(a)).filter(a => a && a.length > 0).slice(0, 10)
            : [];
          const proposedDefinition = v && typeof v.proposed_definition === 'string' ? v.proposed_definition.trim() : null;
          const proposalReasoning = v && typeof v.reasoning === 'string' ? v.reasoning : null;

          const finalName = proposedNameOk ? proposedNameRaw : norm;

          // If a candidate already exists with this canonical_name (active),
          // upsertCandidate will return it instead of creating a duplicate.
          const candidateRow = await upsertCandidate({
            canonical_name: finalName,
            domain: proposedDomain,
            modalities: proposedModalities,
            proposed_canonical_name: proposedNameOk ? proposedNameRaw : finalName,
            proposed_domain: proposedDomain,
            proposed_modalities: proposedModalities,
            proposed_aliases: proposedAliases,
            proposed_definition: proposedDefinition,
            proposal_reasoning: proposalReasoning || (v ? null : 'Claude returned no verdict for this tag; minimal fallback candidate created'),
            source: 'canonicalization_service',
          });

          if (candidateRow && candidateRow.id) {
            const confidence = v ? 'high' : 'low';
            await persistResolution({
              raw_tag: rawTag,
              normalized_tag: norm,
              taxonomy_id: candidateRow.id,
              resolution_method: 'new_candidate',
              confidence,
              reasoning: proposalReasoning,
              source_session_id: sourceSessionId,
              source_endpoint: sourceEndpoint,
              resolved_by_run_id: invokeId,
            });
            // Reflect in local lookup tables in case later tags in the same
            // batch resolve to this newly-created candidate.
            canonByName[finalName] = { id: candidateRow.id, canonical_name: finalName, aliases: [], status: 'candidate', domain: proposedDomain };
            taxonomyById[candidateRow.id] = canonByName[finalName];
            resolutionsByNormalized[norm] = {
              normalized_tag: norm,
              taxonomy_id: candidateRow.id,
              canonical_name: finalName,
              resolution_method: 'new_candidate',
              confidence,
              is_canonical_promoted: false,
              is_new_candidate: true,
              proposed_canonical_name: proposedNameOk ? proposedNameRaw : finalName,
              proposed_domain: proposedDomain,
              proposed_modalities: proposedModalities,
              reasoning: proposalReasoning,
            };
          } else {
            resolutionsByNormalized[norm] = {
              normalized_tag: norm,
              taxonomy_id: null,
              resolution_method: 'fallback_passthrough',
              confidence: 'low',
              error: 'Failed to create candidate row',
            };
          }
        }
      }
    }

    // ── STEP 5: build response in input order ──────────────────────────
    const resolutions = items.map(item => {
      const r = resolutionsByNormalized[item.normalized_tag];
      if (!r) {
        return {
          raw_tag: item.raw_tag,
          normalized_tag: item.normalized_tag,
          taxonomy_id: null,
          resolution_method: 'fallback_passthrough',
          confidence: 'low',
        };
      }
      return Object.assign({}, r, { raw_tag: item.raw_tag });
    });

    const duration = Date.now() - startTime;
    console.log('[canonicalize-dna-tags] complete', {
      invokeId,
      inputCount: items.length,
      uniqueCount: uniqueNormalized.length,
      needsClaude: needsClaude.length,
      durationMs: duration,
    });

    return res.status(200).json({ resolutions, invoke_id: invokeId, duration_ms: duration });
  } catch (e) {
    console.error('[canonicalize-dna-tags] FATAL', { invokeId, message: e && e.message, stack: e && e.stack ? e.stack.substring(0, 500) : null });
    return res.status(500).json({ error: (e && e.message) || 'Internal error', invoke_id: invokeId });
  }
}
