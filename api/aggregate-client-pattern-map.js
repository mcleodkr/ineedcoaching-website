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

async function callClaude(apiKey, model, maxTokens, system, userMessage, passName) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[${passName}] Claude API error ${res.status}:`, errBody.substring(0, 1000));
    throw new Error(`${passName} Claude API error ${res.status}`);
  }
  const data = await res.json();
  let rawText = data.content?.[0]?.text || '';
  rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    const match = rawText.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : JSON.parse(rawText);
  } catch (e) {
    console.error(`[${passName}] JSON parse failed. Raw:`, rawText.substring(0, 2000));
    throw new Error(`${passName} JSON parse error: ${e.message}`);
  }
}

function fmtDate(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (_) { return null; }
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

    // Fetch all PSA-analyzed sessions for this client (ascending so session
    // ordinals are stable: oldest = 1, newest = N).
    const enc = encodeURIComponent(client_email);
    const sessionsUrl = `${SUPABASE_URL}/rest/v1/coach_session_notes`
      + `?coach_id=eq.${coach_id}`
      + `&client_email=eq.${enc}`
      + `&post_session_analysis=not.is.null`
      + `&select=id,booking_id,created_at,post_session_analysis,extraction_data`
      + `&order=created_at.asc`;
    const sessionsRes = await fetch(sessionsUrl, { headers: supaHeaders });
    if (!sessionsRes.ok) {
      const errText = await sessionsRes.text();
      console.error('[Pattern Map] sessions fetch failed:', errText.substring(0, 500));
      return res.status(500).json({ error: 'Failed to load sessions' });
    }
    const sessions = await sessionsRes.json();

    if (!Array.isArray(sessions) || sessions.length < 3) {
      return res.status(200).json({
        locked: true,
        session_count: Array.isArray(sessions) ? sessions.length : 0,
        needed: 3,
      });
    }

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

      // DNA tags → core_patterns / behavioral_tendencies
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

    const firstDate = sessions[0]?.created_at ? new Date(sessions[0].created_at) : null;
    const lastDate = sessions[sessions.length - 1]?.created_at ? new Date(sessions[sessions.length - 1].created_at) : null;
    const dateRange = (firstDate && lastDate)
      ? `${fmtDate(firstDate.toISOString())} — ${fmtDate(lastDate.toISOString())}`
      : 'Unknown range';
    const sessionCount = sessions.length;

    // Compact session index passed to the synthesis prompt: ordinal + date +
    // the client-facing fields only. No missed_windows, no
    // coaching_reflection. Keeps the prompt small and the boundary tight.
    const sessionIndex = sessions.map(function(s, i) {
      const psa = s.post_session_analysis || {};
      return {
        session_id: s.id,
        ordinal: i + 1,
        date: fmtDate(s.created_at) || null,
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
      'NEVER include coach-facing reflection. Specifically:\n' +
      '- Do NOT write "what the coach didn\'t explore" or "what was left on the table"\n' +
      '- Do NOT write "missed windows" content or critique coaching choices\n' +
      '- Do NOT write "why this mattered to the coach" or anything from the coach\'s point of view\n' +
      '- Do NOT name what the coach should have done differently\n' +
      'Coach-facing reflection lives in a separate surface called Coach Mirror; Pattern Map does not duplicate that material.\n\n' +
      'Diagnostic framing is also forbidden. Words you must NEVER use: dysregulation, maladaptive, pathology, borderline, disorder, trauma (as diagnosis), intervention (use "move" or "approach"). ' +
      'Use coaching language. Ground every statement in the supplied PSA evidence — sessions, quotes, observed patterns. ' +
      'If evidence is thin for a section, say so honestly: "Not enough sessions yet to see a clear pattern here." Do NOT invent patterns.\n\n' +
      'Cite source_sessions on every output element using the session_id values from the SESSION INDEX. Use evidence_quote when you have a verbatim client quote that grounds the claim.\n\n' +
      'Tone: practical, grounded, non-clinical, developmental. Return ONLY raw JSON. No markdown, no preamble.';

    const USER_PROMPT =
      'Client Pattern Map aggregation input — ' + sessionCount + ' sessions, ' + dateRange + '.\n\n' +
      'CORE PATTERNS (DNA tags appearing in 2+ sessions, with session counts):\n' + JSON.stringify(corePatterns) + '\n\n' +
      'BEHAVIORAL TENDENCIES (DNA tags appearing in exactly 1 session):\n' + JSON.stringify(behavioralTendencies) + '\n\n' +
      'RECURRING STUCK POINTS (signal_types appearing in 2+ sessions):\n' + JSON.stringify(recurringStuckPoints) + '\n\n' +
      'CLIENT QUOTES (verbatim from sessions, max 10):\n' + JSON.stringify(allClientQuotes) + '\n\n' +
      'SESSION INDEX (per-session client-facing summaries — use session_id values for source_sessions citations):\n' + JSON.stringify(sessionIndex) + '\n\n' +
      'TOTAL SESSIONS: ' + sessionCount + '\nDATE RANGE: ' + dateRange + '\n\n' +
      'Return ONLY this JSON shape. Every array element MUST include source_sessions: [session_id,...] from the SESSION INDEX above:\n' +
      '{\n' +
      '  "likely_drivers": [\n' +
      '    { "driver": "plain language description", "evidence_quote": "verbatim or near-verbatim client language", "frequency": "observed in X of ' + sessionCount + ' sessions", "source_sessions": ["<session_id>"] }\n' +
      '  ],\n' +
      '  "emotional_style": {\n' +
      '    "summary": "how this client moves through emotional territory — 2-3 sentences, coaching language only",\n' +
      '    "patterns": ["observable client pattern 1", "observable client pattern 2"],\n' +
      '    "client_language": ["verbatim or near-verbatim quote showing emotional style"],\n' +
      '    "source_sessions": ["<session_id>"]\n' +
      '  },\n' +
      '  "what_moves_them_forward": [\n' +
      '    { "condition": "what creates real movement for this client", "evidence_quote": "session example or quote", "source_sessions": ["<session_id>"] }\n' +
      '  ],\n' +
      '  "where_they_get_stuck": [\n' +
      '    { "stall_point": "specific stall condition in coaching language (CLIENT-SIDE only)", "evidence_quote": "session evidence or quote", "frequency": "observed in X of ' + sessionCount + ' sessions", "source_sessions": ["<session_id>"] }\n' +
      '  ],\n' +
      '  "signs_of_growth": [\n' +
      '    { "shift": "observable change in language, behavior, or awareness", "from": "what it looked like before", "to": "what it looks like now", "evidence_quote": "session reference", "source_sessions": ["<session_id>"] }\n' +
      '  ]\n' +
      '}\n\n' +
      'If a section lacks evidence, return one element where the descriptive text is "Not enough sessions yet to see a clear pattern here." with empty evidence_quote and empty source_sessions array. Do NOT fabricate.';

    let aiOutput;
    try {
      aiOutput = await callClaude(
        ANTHROPIC_API_KEY,
        'claude-sonnet-4-6',
        2500,
        SYSTEM_PROMPT,
        USER_PROMPT,
        'Pattern Map'
      );
    } catch (e) {
      console.error('[Pattern Map] AI synthesis failed:', e.message);
      aiOutput = {
        likely_drivers: [],
        emotional_style: { summary: 'Pattern Map generation failed. Try again shortly.', patterns: [], client_language: [], source_sessions: [] },
        what_moves_them_forward: [],
        where_they_get_stuck: [],
        signs_of_growth: [],
      };
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
      // SQL-aggregated fields (same field names as before)
      core_patterns: corePatterns,
      behavioral_tendencies: behavioralTendencies,
      recurring_stuck_points: recurringStuckPoints,
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
