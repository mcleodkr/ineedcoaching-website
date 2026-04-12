// POST { coach_id, client_email }
// Generates a Client Pattern Map from all post_session_analysis rows for a client.
//
// ===================================================================
// SUPABASE MIGRATION — RUN THIS IN THE SQL EDITOR BEFORE DEPLOYING
// ===================================================================
//
// CREATE TABLE IF NOT EXISTS coach_client_patterns (
//   id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   coach_id uuid NOT NULL,
//   client_email text NOT NULL,
//   pattern_map jsonb,
//   session_count integer,
//   last_analyzed timestamptz DEFAULT now(),
//   created_at timestamptz DEFAULT now(),
//   UNIQUE(coach_id, client_email)
// );
//
// ===================================================================
// PATTERN MAP AI GUARDRAIL
// You are building a Client Pattern Map for a coach, not a therapist.
// This is not a diagnostic profile. Do not infer conditions, disorders, or
// clinical presentations. Use only what is observable: patterns in the client's
// language, behavioral tendencies, emotional responses as described, and
// recurring themes across sessions. Every statement must be grounded in
// session evidence. If you cannot tie a pattern to specific session data,
// do not include it. Tone: practical, coaching-grounded, non-clinical,
// developmental.
// ===================================================================

const STUCK_LABELS = {
  'unprocessed_cost': 'Names losses without staying with them',
  'behavioral_contradiction': 'States goals that contradict current behavior',
  'emotional_mismatch': 'Emotional response stronger than the stated situation',
  'repetition_without_movement': 'Returns to the same theme without resolution',
  'charged_language': 'Uses language that signals deeper weight',
  'energy_shift': 'Noticeable shifts in energy during session'
};

async function callClaude(apiKey, model, maxTokens, system, userMessage, passName) {
  console.log(`[${passName}] Using model: ${model}`);
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
    throw new Error(`${passName} Claude API error ${res.status}: ${errBody.substring(0, 200)}`);
  }

  let rawText;
  try {
    const data = await res.json();
    rawText = data.content?.[0]?.text || '';
  } catch (e) {
    throw new Error(`${passName}: API response was not valid JSON`);
  }

  rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    const match = rawText.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : JSON.parse(rawText);
  } catch (e) {
    console.error(`[${passName}] JSON parse failed. Raw:`, rawText.substring(0, 2000));
    throw new Error(`${passName} JSON parse error: ${e.message}`);
  }
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
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { coach_id, client_email } = body || {};

    if (!coach_id || !client_email) {
      return res.status(400).json({ error: 'Missing required fields: coach_id, client_email' });
    }

    const supabaseHeaders = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    };

    // ── Fetch all analyzed sessions for this client ─────────────────────
    const sessionsUrl =
      `${SUPABASE_URL}/rest/v1/coach_session_notes` +
      `?coach_id=eq.${coach_id}` +
      `&client_email=eq.${encodeURIComponent(client_email)}` +
      `&post_session_analysis=not.is.null` +
      `&select=post_session_analysis,extraction_data,created_at,booking_id` +
      `&order=created_at.asc`;

    const sessionsRes = await fetch(sessionsUrl, { headers: supabaseHeaders });
    if (!sessionsRes.ok) {
      const errText = await sessionsRes.text();
      console.error('[Pattern Map] session fetch failed:', errText.substring(0, 500));
      return res.status(500).json({ error: 'Failed to load sessions' });
    }
    const sessions = await sessionsRes.json();

    // ── Locked state — too few sessions ─────────────────────────────────
    if (!Array.isArray(sessions) || sessions.length < 3) {
      return res.status(200).json({
        locked: true,
        session_count: Array.isArray(sessions) ? sessions.length : 0,
        needed: 3,
      });
    }

    // ── Server-side aggregation ─────────────────────────────────────────
    const tagCounts = {};
    const missedTypeCounts = {};
    const allOpenings = [];
    const quoteSet = new Set();
    const whatStoodOut = [];

    sessions.forEach((s) => {
      if (!s || !s.post_session_analysis) return;
      const psa = s.post_session_analysis;
      const dt = s.created_at ? new Date(s.created_at) : null;
      const dateStr = dt ? dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Date unknown';

      // DNA tags
      const ci = Array.isArray(psa.coaching_interventions) ? psa.coaching_interventions : [];
      ci.forEach((c) => {
        if (!c || !Array.isArray(c.dna_tag)) return;
        c.dna_tag.forEach((t) => {
          if (!t) return;
          tagCounts[t] = (tagCounts[t] || 0) + 1;
        });
      });

      // Missed windows
      const mw = Array.isArray(psa.missed_windows) ? psa.missed_windows : [];
      mw.forEach((w) => {
        if (!w) return;
        if (w.signal_type) {
          missedTypeCounts[w.signal_type] = (missedTypeCounts[w.signal_type] || 0) + 1;
        }
        const opening = w.what_opened || w.moment;
        if (opening) {
          allOpenings.push({
            text: opening,
            date: dateStr,
            cost: w.what_this_cost || null,
          });
        }
      });

      // What stood out — client-side of the moment
      const ws = Array.isArray(psa.what_stood_out) ? psa.what_stood_out : [];
      ws.forEach((item) => {
        if (item && item.what_happened_client) whatStoodOut.push(item.what_happened_client);
      });

      // Client quotes — from extraction_data if present
      const ext = s.extraction_data || psa.extraction || null;
      if (ext && Array.isArray(ext.client_quotes)) {
        ext.client_quotes.forEach((q) => {
          const clean = typeof q === 'string' ? q : (q && q.text) || '';
          if (clean && clean.length > 8) quoteSet.add(clean.trim());
        });
      }
    });

    const corePatterns = Object.keys(tagCounts)
      .filter((t) => tagCounts[t] >= 2)
      .map((t) => ({ tag: t, count: tagCounts[t] }))
      .sort((a, b) => b.count - a.count);

    const behavioralTendencies = Object.keys(tagCounts)
      .filter((t) => tagCounts[t] === 1)
      .map((t) => ({ tag: t, count: 1 }));

    const recurringStuckPoints = Object.keys(missedTypeCounts)
      .filter((k) => missedTypeCounts[k] >= 2)
      .map((k) => ({
        signal_type: k,
        label: STUCK_LABELS[k] || k,
        count: missedTypeCounts[k],
      }))
      .sort((a, b) => b.count - a.count);

    const allClientQuotes = Array.from(quoteSet).slice(0, 10);

    const firstDate = sessions[0]?.created_at ? new Date(sessions[0].created_at) : null;
    const lastDate = sessions[sessions.length - 1]?.created_at ? new Date(sessions[sessions.length - 1].created_at) : null;
    const dateRange = (firstDate && lastDate)
      ? `${firstDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} — ${lastDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
      : 'Unknown range';

    const sessionCount = sessions.length;

    // ── AI generation — sections 5-9 only ───────────────────────────────
    const SYSTEM_PROMPT =
      'You are building a Client Pattern Map for a coach. This is not a diagnostic profile. ' +
      'You are a coaching intelligence assistant helping a coach understand their client\'s ' +
      'observable patterns, behavioral tendencies, and movement across sessions.\n\n' +
      'DO NOT: use diagnostic language, infer mental health conditions, name disorders, use clinical framing. ' +
      'Words you must never use: dysregulation, maladaptive, pathology, borderline, disorder, trauma (as diagnosis), ' +
      'intervention (use "move" or "approach"), client profile (use "pattern map").\n\n' +
      'DO: use coaching language, ground every statement in session evidence, use the client\'s own words where possible. ' +
      'Every claim must be tied to specific sessions, specific quotes, or specific observed frequencies from the aggregated data below.\n\n' +
      'If evidence is thin for any section, say so honestly: "Not enough sessions yet to see a clear pattern here." ' +
      'Do NOT invent patterns to fill a section.\n\n' +
      'Tone: practical, grounded, non-clinical, developmental. ' +
      'You are Coach Clarity, a reflective thinking partner for coaches — suggestive, not prescriptive. ' +
      'Return ONLY raw JSON. No markdown. No preamble.';

    const USER_PROMPT =
      `Client Pattern Map aggregated data (${sessionCount} sessions analyzed, ${dateRange}):\n\n` +
      `CORE PATTERNS (appearing in 2+ sessions):\n${JSON.stringify(corePatterns)}\n\n` +
      `BEHAVIORAL TENDENCIES (single-session):\n${JSON.stringify(behavioralTendencies)}\n\n` +
      `RECURRING STUCK POINTS (plain-language labels + counts):\n${JSON.stringify(recurringStuckPoints)}\n\n` +
      `UNMET OPENINGS (moments that surfaced but weren't explored):\n${JSON.stringify(allOpenings.slice(0, 15))}\n\n` +
      `CLIENT QUOTES (verbatim from sessions, max 10):\n${JSON.stringify(allClientQuotes)}\n\n` +
      `WHAT STOOD OUT (client-side moments across sessions, max 10):\n${JSON.stringify(whatStoodOut.slice(0, 10))}\n\n` +
      `TOTAL SESSIONS ANALYZED: ${sessionCount}\n` +
      `DATE RANGE: ${dateRange}\n\n` +
      `Generate sections 5-9 of the Client Pattern Map. Return ONLY this JSON:\n` +
      `{\n` +
      `  "likely_drivers": [\n` +
      `    {\n` +
      `      "driver": "plain language description — fear of X, need for Y, avoidance of Z",\n` +
      `      "evidence": "grounded in specific session pattern or verbatim quote",\n` +
      `      "frequency": "observed in X of ${sessionCount} sessions"\n` +
      `    }\n` +
      `  ],\n` +
      `  "emotional_style": {\n` +
      `    "summary": "how this client moves through emotional territory — 2-3 sentences, coaching language only",\n` +
      `    "patterns": ["observable pattern 1", "observable pattern 2"],\n` +
      `    "client_language": ["verbatim or near-verbatim quote showing emotional style"]\n` +
      `  },\n` +
      `  "what_moves_them_forward": [\n` +
      `    {\n` +
      `      "condition": "what creates real movement for this client",\n` +
      `      "evidence": "specific session example or quote"\n` +
      `    }\n` +
      `  ],\n` +
      `  "where_they_get_stuck": [\n` +
      `    {\n` +
      `      "stall_point": "specific stall condition in coaching language",\n` +
      `      "evidence": "session evidence or quote",\n` +
      `      "frequency": "observed in X of ${sessionCount} sessions"\n` +
      `    }\n` +
      `  ],\n` +
      `  "signs_of_growth": [\n` +
      `    {\n` +
      `      "shift": "observable change in language, behavior, or awareness",\n` +
      `      "from": "what it looked like before",\n` +
      `      "to": "what it looks like now",\n` +
      `      "evidence": "session reference"\n` +
      `    }\n` +
      `  ]\n` +
      `}\n\n` +
      `If any section lacks evidence, return an array with one item where driver/condition/stall_point/shift is the honest note ` +
      `"Not enough sessions yet to see a clear pattern here." and evidence is empty string. ` +
      `Emotional style summary falls back to the same note if you cannot ground it.`;

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
      console.error('[Pattern Map] AI generation failed:', e.message);
      aiOutput = {
        likely_drivers: [],
        emotional_style: { summary: 'Pattern Map generation failed. Try again shortly.', patterns: [], client_language: [] },
        what_moves_them_forward: [],
        where_they_get_stuck: [],
        signs_of_growth: [],
      };
    }

    const now = new Date().toISOString();

    const fullResult = {
      ...aiOutput,
      core_patterns: corePatterns,
      behavioral_tendencies: behavioralTendencies,
      recurring_stuck_points: recurringStuckPoints,
      unmet_openings: allOpenings,
      session_count: sessionCount,
      date_range: dateRange,
      last_analyzed: now,
    };

    // ── Upsert to coach_client_patterns ─────────────────────────────────
    // Uses Prefer: resolution=merge-duplicates on the (coach_id, client_email) unique constraint.
    try {
      const upsertRes = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_client_patterns?on_conflict=coach_id,client_email`,
        {
          method: 'POST',
          headers: {
            ...supabaseHeaders,
            Prefer: 'resolution=merge-duplicates,return=minimal',
          },
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
    console.error('[generate-client-pattern-map] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
