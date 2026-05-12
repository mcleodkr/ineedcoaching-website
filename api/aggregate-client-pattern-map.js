// POST { coach_id, client_email }
// Aggregates coach_session_notes.post_session_analysis (PSA) into a Client
// Pattern Map. PSA is the source of truth — this endpoint never reads raw
// transcripts and never re-analyzes. SQL/JS does the counting; one Claude
// pass synthesizes the cross-session picture from already-distilled material.
//
// Field names in the output JSONB are PRESERVED EXACTLY for backward
// compatibility with downstream consumers that read pattern_map:
//   - api/generate-approach-lab.js                       (core_patterns, where_they_get_stuck, likely_drivers)
//   - api/generate-post-session-intelligence.js          (core_patterns, where_they_get_stuck, likely_drivers)
//   - api/generate-intervention-plan.js                  (whole pattern_map)
//   - api/regenerate-intervention-plan-from-scratch.js   (whole pattern_map)
//
// Required top-level fields (any rename here silently degrades the four
// consumers above — they use optional chaining and 200 without complaint):
//   core_patterns, where_they_get_stuck, likely_drivers, emotional_style,
//   what_moves_them_forward, signs_of_growth
//
// New for this revision: canonical_patterns — synonym-consolidated, domain-
// grouped pattern dictionary produced by the synthesis pass. The panel
// renders from this; downstream consumers continue reading core_patterns
// (raw, unconsolidated) so nothing breaks. Domain values are validated
// against VALID_DOMAINS — invalid → synthesis rejected, no DB write,
// retry banner. Coach DNA (a separate construct about the coach) lives
// elsewhere; "DNA" terminology has been removed from this file's UI-facing
// labels to keep the two surfaces from bleeding into each other.
//
// Boundary rule (architecture audit): Pattern Map is client-only. No
// coach-facing reflection. Coach-side material (missed_windows, what was
// "left on the table", coaching_reflection) lives in Coach Mirror. The
// synthesis prompt below explicitly forbids that vocabulary.

const STUCK_LABELS = {
  unprocessed_cost: 'Names losses without staying with them',
  behavioral_contradiction: 'States goals that contradict current behavior',
  emotional_mismatch: 'Emotional response stronger than the stated situation',
  repetition_without_movement: 'Returns to the same theme without resolution',
  charged_language: 'Uses language that signals deeper weight',
  energy_shift: 'Noticeable shifts in energy during session',
};

// Locked taxonomy for canonical_patterns.domain. Anything outside this set
// fails validation and the synthesis is rejected (no DB write, retry banner
// renders) — better to surface "regenerate failed" than to persist a
// pattern with an unmappable domain that would render as a UI orphan.
const VALID_DOMAINS = new Set([
  'recovery_health',
  'self_identity',
  'emotional',
  'behavioral',
  'leadership_work',
  'relational',
  'decision_agency',
]);

import { logAIUsage } from '../lib/ai-usage.js';
import { jsonrepair } from 'jsonrepair';

async function callClaudeRaw(apiKey, model, maxTokens, system, userMessage, passName, meta) {
  const startTime = Date.now();
  let res, data;
  // Wrap string system prompts in the cached-content-block form so the
  // Pattern Map system prompt (large, deterministic across calls) hits the
  // 1h ephemeral cache. Already-array system arguments are passed through
  // unchanged — they're presumed to carry their own cache_control.
  const systemPayload = typeof system === 'string'
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } }]
    : system;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemPayload,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    data = await res.json().catch(function() { return null; });
  } catch (err) {
    await logAIUsage({
      feature: (meta && meta.feature) || 'pattern_map',
      coachId: meta && meta.coachId,
      model,
      status: 'error',
      errorMessage: err && err.message,
      durationMs: Date.now() - startTime,
    });
    throw err;
  }
  const durationMs = Date.now() - startTime;
  await logAIUsage({
    feature: (meta && meta.feature) || 'pattern_map',
    coachId: meta && meta.coachId,
    model: (data && data.model) || model,
    usage: data && data.usage,
    requestId: data && data.id,
    status: res.ok ? 'success' : 'error',
    errorMessage: res.ok ? null : (data && data.error && data.error.message),
    durationMs,
  });
  if (!res.ok) {
    const errBody = data ? JSON.stringify(data).slice(0, 1000) : '(no body)';
    console.error(`[${passName}] Claude API error ${res.status}:`, errBody);
    throw new Error(`${passName} Claude API error ${res.status}`);
  }
  return data && data.content?.[0]?.text || '';
}

// Defensive JSON extractor for Claude synthesis output.
// Claude's shape is non-deterministic — sometimes raw {...}, sometimes
// fenced ```json{...}```, sometimes prefixed with "Here is the Pattern Map:".
// This strips fences and slices between the first { and the last } so any
// lead-in / outro prose is dropped. Throws if no JSON object is present.
function extractJSON(text) {
  let s = (text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) {
    throw new Error('No JSON object found in synthesis response');
  }
  return s.slice(first, last + 1);
}

function fmtDate(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (_) { return null; }
}

// Same regex coach-dashboard.html:4107 and api/coach-mirror.js use to derive
// the client display name. Keeping the three surfaces on one source means a
// dashboard rename of "candy apple" propagates to both panels automatically.
function parseNameFromNotes(notes) {
  if (typeof notes !== 'string' || !notes) return null;
  const m = notes.match(/^Name:\s*(.+)/m);
  return m ? m[1].trim() : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SUPABASE_KEY || !ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { coach_id, client_email } = body;
    if (!coach_id || !client_email) {
      return res.status(400).json({ error: 'Missing required fields: coach_id, client_email' });
    }

    const supaHeaders = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    };

    // Fetch PSA-analyzed sessions, this client's bookings, AND the existing
    // pattern_map row in parallel. The existing row enables the no-changes
    // short-circuit below — if no session has created_at > last_analyzed,
    // we return the row as-is and skip the Claude call entirely (the
    // primary AI cost leak this commit closes).
    const enc = encodeURIComponent(client_email);
    const sessionsUrl = `${SUPABASE_URL}/rest/v1/coach_session_notes`
      + `?coach_id=eq.${coach_id}`
      + `&client_email=eq.${enc}`
      + `&post_session_analysis=not.is.null`
      + `&select=id,booking_id,created_at,post_session_analysis,extraction_data`;
    const bookingsUrl = `${SUPABASE_URL}/rest/v1/coach_bookings`
      + `?coach_id=eq.${coach_id}`
      + `&client_email=eq.${enc}`
      + `&select=id,scheduled_at,notes`;
    const existingUrl = `${SUPABASE_URL}/rest/v1/coach_client_patterns`
      + `?coach_id=eq.${coach_id}`
      + `&client_email=eq.${enc}`
      + `&select=pattern_map,session_count,last_analyzed&limit=1`;

    const [sessionsRes, bookingsRes, existingRes] = await Promise.all([
      fetch(sessionsUrl, { headers: supaHeaders }),
      fetch(bookingsUrl, { headers: supaHeaders }),
      fetch(existingUrl, { headers: supaHeaders }),
    ]);
    if (!sessionsRes.ok) {
      const errText = await sessionsRes.text();
      console.error('[Pattern Map] sessions fetch failed:', errText.substring(0, 500));
      return res.status(500).json({ error: 'Failed to load sessions' });
    }
    const rawSessions = await sessionsRes.json();

    let bookingRows = [];
    if (bookingsRes.ok) {
      const parsed = await bookingsRes.json();
      if (Array.isArray(parsed)) bookingRows = parsed;
    } else {
      // Bookings fetch failure is non-fatal — we'll fall back to PSA created_at
      // for date sourcing and leave display_name null. Don't block synthesis.
      console.warn('[Pattern Map] bookings fetch failed (non-fatal):', bookingsRes.status);
    }

    // bookingId → { scheduled_at, notes }; first matching notes entry wins
    // for displayName (matches Coach Mirror's behavior).
    const bookingMap = {};
    let displayName = null;
    bookingRows.forEach(function(b) {
      if (!b || !b.id) return;
      bookingMap[b.id] = { scheduled_at: b.scheduled_at || null, notes: b.notes || '' };
      if (!displayName) {
        const n = parseNameFromNotes(b.notes);
        if (n) displayName = n;
      }
    });

    // Read the existing pattern_map row (if any) — used both for the
    // no-changes short-circuit and for failure-path preservation.
    let existingRow = null;
    if (existingRes && existingRes.ok) {
      const parsed = await existingRes.json();
      if (Array.isArray(parsed) && parsed.length) existingRow = parsed[0];
    }

    if (!Array.isArray(rawSessions) || rawSessions.length < 3) {
      return res.status(200).json({
        locked: true,
        session_count: Array.isArray(rawSessions) ? rawSessions.length : 0,
        needed: 3,
        display_name: displayName,
      });
    }

    // No-changes short-circuit — the heart of the cost-leak fix. If a row
    // already exists AND no session has created_at > existing last_analyzed,
    // there's no new material for Claude to synthesize. Return the existing
    // pattern_map untouched: NO Claude call, NO upsert, NO last_analyzed
    // update. This protects against accidental re-clicks, stale tabs,
    // automation, or duplicate POSTs from re-firing the model.
    if (existingRow && existingRow.last_analyzed && existingRow.pattern_map) {
      const lastAnalyzedTs = new Date(existingRow.last_analyzed).getTime();
      const hasNewWork = rawSessions.some(function(s) {
        if (!s || !s.created_at) return false;
        return new Date(s.created_at).getTime() > lastAnalyzedTs;
      });
      if (!hasNewWork) {
        return res.status(200).json({
          status: 'no_changes',
          pattern_map: existingRow.pattern_map,
          session_count: existingRow.session_count || rawSessions.length,
          last_analyzed: existingRow.last_analyzed,
          display_name: displayName,
        });
      }
    }

    // Stamp each session with effective_date (booking.scheduled_at when joinable,
    // else PSA created_at). Then sort by effective_date ASC so ordinals are
    // stable oldest=1 even if PSA rows were written out of session order.
    const sessions = rawSessions.map(function(s) {
      const bk = s.booking_id ? bookingMap[s.booking_id] : null;
      const effectiveDate = (bk && bk.scheduled_at) ? bk.scheduled_at : s.created_at;
      return Object.assign({}, s, { effective_date: effectiveDate });
    }).sort(function(a, b) {
      const ta = a.effective_date ? new Date(a.effective_date).getTime() : 0;
      const tb = b.effective_date ? new Date(b.effective_date).getTime() : 0;
      return ta - tb;
    });

    // ── Aggregation pass — counts + source_session tracking ───────────────
    // Maps each pattern element back to the session_ids that contributed.
    const tagSessions = {};       // dna_tag → Set(session_id)
    const stuckSessions = {};     // signal_type → Set(session_id)
    const quoteSet = new Set();
    const standoutByCategory = {}; // (rough bucket key) → array of { what_happened_client, source_session }

    sessions.forEach(function(s) {
      if (!s || !s.post_session_analysis) return;
      const psa = s.post_session_analysis;
      const sid = s.id;

      // Per-session client behavioral tags → core_patterns / behavioral_tendencies.
      // PSA's coaching_interventions[].dna_tag is the upstream field name
      // (kept for schema compat); these are CLIENT behavioral patterns, not
      // Coach DNA. Synthesis pass consolidates synonyms into canonical_patterns.
      const ci = Array.isArray(psa.coaching_interventions) ? psa.coaching_interventions : [];
      ci.forEach(function(c) {
        if (!c || !Array.isArray(c.dna_tag)) return;
        c.dna_tag.forEach(function(t) {
          if (!t) return;
          if (!tagSessions[t]) tagSessions[t] = new Set();
          tagSessions[t].add(sid);
        });
      });

      // Friction-point signal_types → recurring_stuck_points.
      // These are the signal_type tags from PSA's friction_points OR
      // missed_windows; reading signal_type only (not the coach-facing
      // "what was left on the table" body) keeps the boundary intact.
      const friction = Array.isArray(psa.friction_points) ? psa.friction_points : [];
      friction.forEach(function(f) {
        if (!f || !f.signal_type) return;
        if (!stuckSessions[f.signal_type]) stuckSessions[f.signal_type] = new Set();
        stuckSessions[f.signal_type].add(sid);
      });
      const mw = Array.isArray(psa.missed_windows) ? psa.missed_windows : [];
      mw.forEach(function(w) {
        if (!w || !w.signal_type) return;
        if (!stuckSessions[w.signal_type]) stuckSessions[w.signal_type] = new Set();
        stuckSessions[w.signal_type].add(sid);
      });

      // Client-side quotes only. extraction_data.client_quotes is the
      // canonical source; PSA.what_stood_out[].what_happened_client is
      // additional client-side observation safe to surface.
      const ext = s.extraction_data || psa.extraction || null;
      if (ext && Array.isArray(ext.client_quotes)) {
        ext.client_quotes.forEach(function(q) {
          const clean = typeof q === 'string' ? q : (q && q.text) || '';
          if (clean && clean.length > 8) quoteSet.add(clean.trim());
        });
      }
      const ws = Array.isArray(psa.what_stood_out) ? psa.what_stood_out : [];
      ws.forEach(function(item) {
        if (item && item.what_happened_client) {
          if (!standoutByCategory.all) standoutByCategory.all = [];
          standoutByCategory.all.push({ text: item.what_happened_client, session_id: sid });
        }
      });
    });

    function tallyToArray(map, threshold) {
      return Object.keys(map)
        .filter(function(k) { return map[k].size >= threshold; })
        .map(function(k) {
          const ids = Array.from(map[k]);
          return { tag: k, count: ids.length, source_sessions: ids };
        })
        .sort(function(a, b) { return b.count - a.count; });
    }

    const corePatterns = tallyToArray(tagSessions, 2);
    const behavioralTendencies = Object.keys(tagSessions)
      .filter(function(t) { return tagSessions[t].size === 1; })
      .map(function(t) { return { tag: t, count: 1, source_sessions: Array.from(tagSessions[t]) }; });

    const recurringStuckPoints = Object.keys(stuckSessions)
      .filter(function(k) { return stuckSessions[k].size >= 2; })
      .map(function(k) {
        const ids = Array.from(stuckSessions[k]);
        return {
          signal_type: k,
          label: STUCK_LABELS[k] || k,
          count: ids.length,
          source_sessions: ids,
        };
      })
      .sort(function(a, b) { return b.count - a.count; });

    const allClientQuotes = Array.from(quoteSet).slice(0, 10);

    // Date range and per-session ordinals come from effective_date (booking
    // scheduled_at when joinable, else PSA created_at) — see the sort above.
    const firstDate = sessions[0]?.effective_date ? new Date(sessions[0].effective_date) : null;
    const lastDate = sessions[sessions.length - 1]?.effective_date ? new Date(sessions[sessions.length - 1].effective_date) : null;
    const dateRange = (firstDate && lastDate)
      ? `${fmtDate(firstDate.toISOString())} — ${fmtDate(lastDate.toISOString())}`
      : 'Unknown range';
    const sessionCount = sessions.length;

    // Per-session label map for source-citation chips on the panel:
    //   session_id → "session N · Apr 21, 2026"
    // Built server-side so the panel doesn't need a separate query and so
    // chips always agree with what the synthesis prompt saw.
    const sessionLabels = {};
    sessions.forEach(function(s, i) {
      const dStr = fmtDate(s.effective_date);
      sessionLabels[s.id] = 'session ' + (i + 1) + (dStr ? ' · ' + dStr : '');
    });

    // Compact session index passed to the synthesis prompt: ordinal + date +
    // the client-facing fields only. No missed_windows, no
    // coaching_reflection. Keeps the prompt small and the boundary tight.
    const sessionIndex = sessions.map(function(s, i) {
      const psa = s.post_session_analysis || {};
      return {
        session_id: s.id,
        ordinal: i + 1,
        date: fmtDate(s.effective_date) || null,
        pattern: psa.pattern || null,
        frameworks: Array.isArray(psa.frameworks) ? psa.frameworks : null,
        emotional_anchor: psa.emotional_anchor || null,
        breakthrough: psa.breakthrough || null,
        commitments: Array.isArray(psa.commitments) ? psa.commitments : null,
        between_session: psa.between_session || null,
        // what_stood_out: keep ONLY what_happened_client per element (drops the
        // coach-facing what_happened_for_you sibling, which is Mirror material).
        what_stood_out_client: Array.isArray(psa.what_stood_out)
          ? psa.what_stood_out.map(function(it) { return it && it.what_happened_client ? it.what_happened_client : null; }).filter(Boolean)
          : null,
      };
    });

    const SYSTEM_PROMPT =
      'You are aggregating Coach Clarity outputs from multiple sessions to produce a Client Pattern Map.\n\n' +
      'STRICT BOUNDARY: every output field describes the CLIENT only — their drivers, their language, their patterns, their growth, what moves them forward, where they get stuck. ' +
      'You are writing a forensic-psychologist-style profile of the person being coached.\n\n' +
      'OUTPUT VOICE: third-person observation only. Every sentence describes the client. ZERO sentences address the coach. ' +
      'Do NOT use second-person "you" or "your" referring to the coach. Do NOT include prescriptive language about what to do, watch for, or attend to. ' +
      'Forbidden phrases that signal a coach-facing leak — never include any of these in any output text:\n' +
      '- "As a coach"  /  "as a coach:"\n' +
      '- "You may need to" / "You might" / "You should" / "Watch for" / "Notice when"\n' +
      '- "In these moments" / "In this moment"\n' +
      '- "The stall is the signal" or any aphorism aimed at the coach\n' +
      '- "Staying with the feeling before moving to insight" or any prescriptive direction\n' +
      'If a sentence would only make sense if a coach were reading it as instruction, that sentence does not belong in Pattern Map. Coach-facing reflection lives in Coach Mirror.\n\n' +
      'NEVER include coach-facing reflection. Specifically:\n' +
      '- Do NOT write "what the coach didn\'t explore" or "what was left on the table"\n' +
      '- Do NOT write "missed windows" content or critique coaching choices\n' +
      '- Do NOT write "why this mattered to the coach" or anything from the coach\'s point of view\n' +
      '- Do NOT name what the coach should have done differently\n\n' +
      'NO PREAMBLE on any field. Forbidden opening phrases on driver / stall_point / shift / condition / summary text:\n' +
      '- "This client\'s patterns suggest:"\n' +
      '- "It appears that"\n' +
      '- "There is a tendency to"\n' +
      '- "What we see here is"\n' +
      'State the observation directly. The driver IS the first words. The stall point IS the first words.\n\n' +
      'Diagnostic framing is also forbidden. Words you must NEVER use: dysregulation, maladaptive, pathology, borderline, disorder, trauma (as diagnosis), intervention (use "move" or "approach"). ' +
      'Use coaching language. Ground every statement in the supplied PSA evidence — sessions, quotes, observed patterns. ' +
      'If evidence is thin for a section, say so honestly: "Not enough sessions yet to see a clear pattern here." Do NOT invent patterns.\n\n' +
      'Cite source_sessions on every output element using the session_id values from the SESSION INDEX. Use evidence_quote when you have a verbatim client quote that grounds the claim.\n\n' +
      'CANONICAL PATTERNS — produce a deduplicated, domain-grouped pattern dictionary in the canonical_patterns array.\n' +
      'CONSOLIDATION RULE: When producing canonical_patterns, consolidate synonyms aggressively. If two per-session tags refer to the same construct (e.g., "pattern disruption" and "pattern interruption"; "identity integration" and "identity shift"; "self-awareness" and "self-accountability" when both refer to recognizing one\'s own patterns), merge them under a single canonical_name and combine their session_ids. Preserve the original labels in original_labels for audit. session_count MUST equal session_ids.length.\n' +
      'DOMAIN ASSIGNMENT: Each canonical pattern must be assigned exactly one domain from this LOCKED list. Do NOT invent new domains. Anything outside this list will be rejected:\n' +
      '  - recovery_health — recovery process, health behaviors, addiction patterns, relapse dynamics\n' +
      '  - self_identity — self-relationship, self-accountability, identity, shame, self-talk\n' +
      '  - emotional — emotional regulation, processing patterns, affect tolerance, grief\n' +
      '  - behavioral — action tendencies, defensive moves, pattern interruption, behavioral transfer\n' +
      '  - leadership_work — professional self-worth, leadership presence, role dynamics\n' +
      '  - relational — interpersonal patterns, attachment, communication moves\n' +
      '  - decision_agency — decision-making style, agency, conscious choice, ownership\n\n' +
      'Tone: practical, grounded, non-clinical, developmental. Return ONLY raw JSON. No markdown, no preamble.';

    const USER_PROMPT =
      'Client Pattern Map aggregation input — ' + sessionCount + ' sessions, ' + dateRange + '.\n\n' +
      'RECURRING TAGS (per-session client behavioral tags appearing in 2+ sessions, with session counts):\n' + JSON.stringify(corePatterns) + '\n\n' +
      'SINGLE-SESSION TAGS (per-session client behavioral tags appearing in exactly 1 session):\n' + JSON.stringify(behavioralTendencies) + '\n\n' +
      'RECURRING STUCK POINTS (signal_types appearing in 2+ sessions):\n' + JSON.stringify(recurringStuckPoints) + '\n\n' +
      'CLIENT QUOTES (verbatim from sessions, max 10):\n' + JSON.stringify(allClientQuotes) + '\n\n' +
      'SESSION INDEX (per-session client-facing summaries — use session_id values for source_sessions citations):\n' + JSON.stringify(sessionIndex) + '\n\n' +
      'TOTAL SESSIONS: ' + sessionCount + '\nDATE RANGE: ' + dateRange + '\n\n' +
      'Return ONLY this JSON shape. Every array element MUST include source_sessions: [session_id,...] from the SESSION INDEX above:\n' +
      '{\n' +
      '  "likely_drivers": [\n' +
      '    { "driver": "Name the driver directly. Begin with the driver itself — NO preamble like \\"This client\'s patterns suggest:\\" or \\"It appears that\\". Third-person description of the client.", "evidence_quote": "verbatim or near-verbatim client language", "frequency": "observed in X of ' + sessionCount + ' sessions", "source_sessions": ["<session_id>"] }\n' +
      '  ],\n' +
      '  "emotional_style": {\n' +
      '    "summary": "1-2 sentences in third-person describing how the CLIENT moves through emotional territory. Description, not prescription. NO sentences directed at the coach. NO \\"As a coach\\", \\"You may\\", \\"Watch for\\", \\"In these moments\\".",\n' +
      '    "patterns": ["observable client pattern 1 — third-person observation only", "observable client pattern 2 — third-person observation only"],\n' +
      '    "client_language": ["verbatim or near-verbatim quote showing emotional style"],\n' +
      '    "source_sessions": ["<session_id>"]\n' +
      '  },\n' +
      '  "what_moves_them_forward": [\n' +
      '    { "condition": "what creates real movement for this client — third-person observation, no prescription", "evidence_quote": "session example or quote", "source_sessions": ["<session_id>"] }\n' +
      '  ],\n' +
      '  "where_they_get_stuck": [\n' +
      '    { "stall_point": "Specific client-side stall condition in third-person. NO sentences directed at the coach. NO \\"In these moments\\", \\"The stall is the signal\\", \\"Staying with the feeling\\" — those are coach-facing aphorisms.", "evidence_quote": "session evidence or quote", "frequency": "observed in X of ' + sessionCount + ' sessions", "source_sessions": ["<session_id>"] }\n' +
      '  ],\n' +
      '  "signs_of_growth": [\n' +
      '    { "shift": "observable change in client language, behavior, or awareness — third-person", "from": "what it looked like before", "to": "what it looks like now", "evidence_quote": "session reference", "source_sessions": ["<session_id>"] }\n' +
      '  ],\n' +
      '  "canonical_patterns": [\n' +
      '    {\n' +
      '      "canonical_name": "deduplicated pattern name in coaching language (e.g., \\"pattern interruption\\", \\"self-accountability\\")",\n' +
      '      "domain": "<EXACTLY ONE of: self_identity | behavioral | recovery_health | emotional | leadership_work | relational | decision_agency>",\n' +
      '      "session_ids": ["<session_id from SESSION INDEX>"],\n' +
      '      "session_count": 2,\n' +
      '      "original_labels": ["pattern disruption", "pattern interruption"]\n' +
      '    }\n' +
      '  ]\n' +
      '}\n\n' +
      'If a section lacks evidence, return one element where the descriptive text is "Not enough sessions yet to see a clear pattern here." with empty evidence_quote and empty source_sessions array. Do NOT fabricate. ' +
      'For canonical_patterns specifically: if no patterns to consolidate, return an empty array []. Never invent patterns to fill the array.';

    // Synthesis: call → extract JSON → parse. Any failure here returns 200
    // {status:'failed', error} and DOES NOT write to coach_client_patterns,
    // so a failed regenerate never clobbers a previously-successful row.
    let rawSynthesisText = '';
    let aiOutput = null;
    let synthesisFailureReason = null;

    try {
      // max_tokens=7500 — adding canonical_patterns adds ~2000-3500 tokens
      // to the output for typical clients; 5000 truncated mid-array. 7500
      // gives headroom on dense profiles without inflating cost on sparser ones.
      rawSynthesisText = await callClaudeRaw(
        ANTHROPIC_API_KEY,
        'claude-sonnet-4-6',
        7500,
        SYSTEM_PROMPT,
        USER_PROMPT,
        'Pattern Map',
        { feature: 'pattern_map', coachId: coach_id }
      );
    } catch (e) {
      synthesisFailureReason = 'synthesis_api_failed';
      console.error('[Pattern Map] Claude API failed:', e.message);
    }

    if (!synthesisFailureReason) {
      // Two-step parse. JSON.parse first for the fast path on clean output;
      // on failure, run jsonrepair() to fix Claude's common drift modes
      // (missing/trailing commas, unescaped chars, single quotes, partial
      // truncation) and parse again. The 7 production failures we
      // investigated were all "Expected ',' or ']' after array element" at
      // column 6 — missing comma between objects in a long array, which
      // jsonrepair handles directly. Repair attempts are logged so we can
      // tell genuine recoveries from cases where output drift is getting
      // worse.
      const extracted = extractJSON(rawSynthesisText);
      try {
        aiOutput = JSON.parse(extracted);
      } catch (parseErr) {
        try {
          aiOutput = JSON.parse(jsonrepair(extracted));
          console.warn('[Pattern Map] JSON.parse failed, jsonrepair recovered', {
            parseErr: parseErr.message,
          });
        } catch (repairErr) {
          synthesisFailureReason = 'synthesis_parse_failed';
          console.error('[Pattern Map] JSON parse failed (jsonrepair also failed)', {
            parseErr: parseErr.message,
            repairErr: repairErr.message,
            raw: (rawSynthesisText || '').slice(0, 500),
          });
        }
      }
    }

    // Hard-validate canonical_patterns. A bogus domain renders as a UI
    // orphan ("undefined" group); better to reject the synthesis and show
    // the retry banner than persist garbage. Empty array is fine.
    if (!synthesisFailureReason && aiOutput) {
      if (aiOutput.canonical_patterns !== undefined && !Array.isArray(aiOutput.canonical_patterns)) {
        synthesisFailureReason = 'invalid_canonical_patterns_shape';
        console.error('[Pattern Map] canonical_patterns is not an array', { type: typeof aiOutput.canonical_patterns });
      } else if (Array.isArray(aiOutput.canonical_patterns)) {
        for (const cp of aiOutput.canonical_patterns) {
          if (!cp || typeof cp !== 'object'
              || typeof cp.canonical_name !== 'string' || !cp.canonical_name
              || !VALID_DOMAINS.has(cp.domain)
              || !Array.isArray(cp.session_ids)
              || !Array.isArray(cp.original_labels)
              || typeof cp.session_count !== 'number') {
            synthesisFailureReason = 'invalid_canonical_pattern_entry';
            console.error('[Pattern Map] invalid canonical_pattern entry', {
              canonical_name: cp && cp.canonical_name,
              domain: cp && cp.domain,
              has_session_ids: Array.isArray(cp && cp.session_ids),
              has_original_labels: Array.isArray(cp && cp.original_labels),
            });
            break;
          }
        }
      }
    }

    if (synthesisFailureReason || !aiOutput) {
      // Hand off to panel with a status flag. Panel renders the prior row
      // (if any) plus a retry banner — the empty-defaults UI must NOT show.
      return res.status(200).json({
        status: 'failed',
        error: synthesisFailureReason || 'synthesis_failed',
      });
    }

    const now = new Date().toISOString();

    // Final JSONB shape — top-level field names match the prior generator's
    // schema exactly so downstream consumers (approach-lab, post-session-
    // intelligence, intervention-plan, regenerate) read the expected fields.
    const fullResult = {
      // Synthesis output (same field names as before)
      likely_drivers: Array.isArray(aiOutput.likely_drivers) ? aiOutput.likely_drivers : [],
      emotional_style: aiOutput.emotional_style || { summary: '', patterns: [], client_language: [], source_sessions: [] },
      what_moves_them_forward: Array.isArray(aiOutput.what_moves_them_forward) ? aiOutput.what_moves_them_forward : [],
      where_they_get_stuck: Array.isArray(aiOutput.where_they_get_stuck) ? aiOutput.where_they_get_stuck : [],
      signs_of_growth: Array.isArray(aiOutput.signs_of_growth) ? aiOutput.signs_of_growth : [],
      // SQL-aggregated fields (same field names as before — kept for
      // downstream consumers: approach-lab, post-session-intelligence,
      // intervention-plan, regenerate-intervention-plan-from-scratch).
      core_patterns: corePatterns,
      behavioral_tendencies: behavioralTendencies,
      recurring_stuck_points: recurringStuckPoints,
      // canonical_patterns: synonym-consolidated, domain-grouped pattern
      // dictionary produced by the synthesis pass. The panel renders from
      // this; downstream consumers continue reading core_patterns above.
      canonical_patterns: Array.isArray(aiOutput.canonical_patterns) ? aiOutput.canonical_patterns : [],
      // Header / source-citation data — persisted into pattern_map JSONB so
      // the panel doesn't need separate queries on subsequent loads.
      display_name: displayName,
      session_labels: sessionLabels,
      // Metadata
      session_count: sessionCount,
      date_range: dateRange,
      last_analyzed: now,
      generator: 'aggregate-client-pattern-map@v1',
    };

    // Upsert. coach_client_patterns has a unique constraint on (coach_id, client_email).
    try {
      const upsertRes = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_client_patterns?on_conflict=coach_id,client_email`,
        {
          method: 'POST',
          headers: { ...supaHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({
            coach_id,
            client_email,
            pattern_map: fullResult,
            session_count: sessionCount,
            last_analyzed: now,
          }),
        }
      );
      if (!upsertRes.ok) {
        const errText = await upsertRes.text();
        console.warn('[Pattern Map] upsert failed (non-fatal):', errText.substring(0, 500));
      }
    } catch (e) {
      console.warn('[Pattern Map] upsert error (non-fatal):', e.message);
    }

    return res.status(200).json(fullResult);
  } catch (e) {
    console.error('[aggregate-client-pattern-map] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
