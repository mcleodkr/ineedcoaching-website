// POST { coach_id, client_email }
// Synthesizes longitudinal coaching strategy for one client. Reads ALL of the
// client's post_session_analysis rows + their Pattern Map and asks Claude to
// produce a coach-facing game plan: what's worked, what hasn't, where to
// pivot, when to refer out.
//
// Distinction from Pattern Map: Pattern Map is descriptive (third-person
// observation of the client). Coaching Strategy is PRESCRIPTIVE — written
// to the coach, in second person, with concrete moves.
//
// Cost-gating mirrors aggregate-client-pattern-map.js: if a strategy already
// exists and no PSA has created_at > existing.last_analyzed, the endpoint
// returns the existing row as-is with status:'no_changes' — no Claude call,
// no DB write. Synthesis failure returns status:'failed' (200) so the panel
// can render the prior strategy with a retry banner instead of clobbering it.

import { logAIUsage } from '../lib/ai-usage.js';
import { jsonrepair } from 'jsonrepair';

async function callClaudeRaw(apiKey, model, maxTokens, system, userMessage, passName, meta) {
  const startTime = Date.now();
  let res, data;
  // Wrap string system prompts in the cached-content-block form so the
  // (deterministic) system prefix hits the 1h ephemeral cache. Already-array
  // system arguments pass through unchanged.
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
      feature: (meta && meta.feature) || 'coaching_strategy',
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
    feature: (meta && meta.feature) || 'coaching_strategy',
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
  return (data && data.content?.[0]?.text) || '';
}

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

    const enc = encodeURIComponent(client_email);
    const sessionsUrl = `${SUPABASE_URL}/rest/v1/coach_session_notes`
      + `?coach_id=eq.${coach_id}`
      + `&client_email=eq.${enc}`
      + `&post_session_analysis=not.is.null`
      + `&select=id,booking_id,created_at,post_session_analysis`;
    const bookingsUrl = `${SUPABASE_URL}/rest/v1/coach_bookings`
      + `?coach_id=eq.${coach_id}`
      + `&client_email=eq.${enc}`
      + `&select=id,scheduled_at,notes`;
    const patternUrl = `${SUPABASE_URL}/rest/v1/coach_client_patterns`
      + `?coach_id=eq.${coach_id}`
      + `&client_email=eq.${enc}`
      + `&select=pattern_map,session_count,last_analyzed&limit=1`;
    const existingUrl = `${SUPABASE_URL}/rest/v1/coach_client_strategies`
      + `?coach_id=eq.${coach_id}`
      + `&client_email=eq.${enc}`
      + `&select=strategy,session_count,last_analyzed&limit=1`;

    const [sessionsRes, bookingsRes, patternRes, existingRes] = await Promise.all([
      fetch(sessionsUrl, { headers: supaHeaders }),
      fetch(bookingsUrl, { headers: supaHeaders }),
      fetch(patternUrl, { headers: supaHeaders }),
      fetch(existingUrl, { headers: supaHeaders }),
    ]);

    if (!sessionsRes.ok) {
      const errText = await sessionsRes.text();
      console.error('[Coaching Strategy] sessions fetch failed:', errText.substring(0, 500));
      return res.status(500).json({ error: 'Failed to load sessions' });
    }

    const rawSessions = await sessionsRes.json();
    const bookingRows = bookingsRes.ok ? (await bookingsRes.json()) : [];
    const patternRows = patternRes.ok ? (await patternRes.json()) : [];
    const existingRows = existingRes.ok ? (await existingRes.json()) : [];

    const bookingMap = {};
    let displayName = null;
    (Array.isArray(bookingRows) ? bookingRows : []).forEach(function(b) {
      if (!b || !b.id) return;
      bookingMap[b.id] = { scheduled_at: b.scheduled_at || null, notes: b.notes || '' };
      if (!displayName) {
        const n = parseNameFromNotes(b.notes);
        if (n) displayName = n;
      }
    });

    const patternMap = (Array.isArray(patternRows) && patternRows.length) ? patternRows[0].pattern_map : null;
    const existingRow = (Array.isArray(existingRows) && existingRows.length) ? existingRows[0] : null;

    // Locked state: strategy needs at least 3 analyzed sessions before
    // synthesis is meaningful. Mirrors Pattern Map's locked threshold.
    if (!Array.isArray(rawSessions) || rawSessions.length < 3) {
      return res.status(200).json({
        locked: true,
        session_count: Array.isArray(rawSessions) ? rawSessions.length : 0,
        needed: 3,
        display_name: displayName,
      });
    }

    // No-changes short-circuit. If a strategy already exists AND no PSA has
    // created_at > existing.last_analyzed, return it as-is. No Claude call,
    // no DB write. Protects against re-clicks and stale tabs.
    if (existingRow && existingRow.last_analyzed && existingRow.strategy) {
      const lastTs = new Date(existingRow.last_analyzed).getTime();
      const hasNewWork = rawSessions.some(function(s) {
        if (!s || !s.created_at) return false;
        return new Date(s.created_at).getTime() > lastTs;
      });
      if (!hasNewWork) {
        return res.status(200).json({
          status: 'no_changes',
          strategy: existingRow.strategy,
          session_count: existingRow.session_count || rawSessions.length,
          last_analyzed: existingRow.last_analyzed,
          display_name: displayName,
        });
      }
    }

    // Stamp each session with effective_date (booking.scheduled_at when
    // joinable, else PSA created_at) and sort ASC so ordinals are stable.
    const sessions = rawSessions.map(function(s) {
      const bk = s.booking_id ? bookingMap[s.booking_id] : null;
      const effectiveDate = (bk && bk.scheduled_at) ? bk.scheduled_at : s.created_at;
      return Object.assign({}, s, { effective_date: effectiveDate });
    }).sort(function(a, b) {
      const ta = a.effective_date ? new Date(a.effective_date).getTime() : 0;
      const tb = b.effective_date ? new Date(b.effective_date).getTime() : 0;
      return ta - tb;
    });

    const sessionCount = sessions.length;
    const firstDate = sessions[0]?.effective_date ? new Date(sessions[0].effective_date) : null;
    const lastDate = sessions[sessions.length - 1]?.effective_date ? new Date(sessions[sessions.length - 1].effective_date) : null;
    const dateRange = (firstDate && lastDate)
      ? `${fmtDate(firstDate.toISOString())} — ${fmtDate(lastDate.toISOString())}`
      : 'Unknown range';

    const sessionLabels = {};
    sessions.forEach(function(s, i) {
      const dStr = fmtDate(s.effective_date);
      sessionLabels[s.id] = 'session ' + (i + 1) + (dStr ? ' · ' + dStr : '');
    });

    // Compact per-session intervention index for the prompt. Pulls the
    // coach-facing fields the strategy depends on: what moves were used,
    // what theoretical approaches were flagged, what was missed.
    const sessionIndex = sessions.map(function(s, i) {
      const psa = s.post_session_analysis || {};
      const ci = Array.isArray(psa.coaching_interventions) ? psa.coaching_interventions : [];
      const ate = Array.isArray(psa.approaches_to_explore) ? psa.approaches_to_explore : [];
      const mw = Array.isArray(psa.missed_windows) ? psa.missed_windows : [];
      const fp = Array.isArray(psa.friction_points) ? psa.friction_points : [];
      return {
        session_id: s.id,
        ordinal: i + 1,
        date: fmtDate(s.effective_date) || null,
        frameworks: Array.isArray(psa.frameworks) ? psa.frameworks : null,
        session_in_one_line: psa.session_in_one_line || null,
        coaching_interventions: ci.map(function(c) {
          if (!c) return null;
          return {
            move: c.move || c.intervention || c.label || null,
            quote: c.quote || c.coach_quote || c.example || null,
            effect: c.effect || c.what_seemed_effective || c.outcome || null,
            dna_tag: Array.isArray(c.dna_tag) ? c.dna_tag : null,
          };
        }).filter(Boolean),
        approaches_to_explore: ate.map(function(a) {
          if (!a) return null;
          return {
            approach: a.approach || a.name || null,
            rationale: a.rationale || a.why || a.fit || null,
          };
        }).filter(Boolean),
        missed_windows: mw.map(function(m) {
          if (!m) return null;
          return {
            signal_type: m.signal_type || null,
            description: m.description || m.what_happened || m.note || null,
          };
        }).filter(Boolean),
        friction_points: fp.map(function(f) {
          if (!f) return null;
          return {
            signal_type: f.signal_type || null,
            description: f.description || f.what_happened || null,
          };
        }).filter(Boolean),
        pattern: psa.pattern || null,
        breakthrough: psa.breakthrough || null,
      };
    });

    // Slim pattern_map projection for context. The full pattern_map is
    // dense; pulling only the strategy-relevant fields keeps the prompt
    // tight without losing the client-side anchor.
    const patternContext = patternMap ? {
      likely_drivers: Array.isArray(patternMap.likely_drivers)
        ? patternMap.likely_drivers.map(function(d) { return d && d.driver; }).filter(Boolean).slice(0, 6)
        : [],
      what_moves_them_forward: Array.isArray(patternMap.what_moves_them_forward)
        ? patternMap.what_moves_them_forward.map(function(w) { return w && w.condition; }).filter(Boolean).slice(0, 6)
        : [],
      where_they_get_stuck: Array.isArray(patternMap.where_they_get_stuck)
        ? patternMap.where_they_get_stuck.map(function(w) { return w && w.stall_point; }).filter(Boolean).slice(0, 6)
        : [],
      signs_of_growth: Array.isArray(patternMap.signs_of_growth)
        ? patternMap.signs_of_growth.map(function(g) { return g && g.shift; }).filter(Boolean).slice(0, 6)
        : [],
      emotional_style_summary: patternMap.emotional_style && patternMap.emotional_style.summary || null,
    } : null;

    const SYSTEM_PROMPT =
      'You are a senior coaching supervisor preparing a longitudinal strategy memo for a coach about one of their clients.\n\n' +
      'VOICE: Write to the coach, in second person. Concrete and prescriptive. Strategy is coach-facing — UNLIKE Pattern Map (client-only). ' +
      'Use suggestive tone ("you might explore," "one approach worth considering") rather than directive ("you must," "you should"). Tentative but specific.\n\n' +
      'COACHING IDENTITY GUARDRAIL: This is for coaches, not therapists. Do NOT use clinical labels: no "dysregulation," "maladaptive," "pathology," "disorder," "borderline," "trauma" as diagnosis. ' +
      'Translate therapeutic modalities into coaching lenses: DBT → Emotion Regulation + Validation Approach. ACT → Acceptance + Values-Based Action Approach. CBT → Thought Pattern Reframe Approach. MI → Motivation + Change Talk Approach. ' +
      'Describe approaches in terms of how the coach listens, what they prioritize, how they respond, what they are trying to shift.\n\n' +
      'EVIDENCE DISCIPLINE: Every claim must trace to the SESSION INDEX. Cite source_sessions arrays using session_id values. If evidence is thin for a section, return one element with text "Not enough evidence yet — need more sessions to see a clear pattern here." with empty source_sessions. Do NOT fabricate.\n\n' +
      'EFFECTIVE vs INEFFECTIVE APPROACHES: Read coaching_interventions across sessions. An approach is "effective" if its effect field describes movement, insight, or client uptake. An approach is "ineffective" if missed_windows or friction_points show the move did not land. If neither shows up, do not classify the approach.\n\n' +
      'REFERRAL CONDITIONS: Only generate when_to_refer items where evidence in the sessions actually warrants escalation (recurring finality thinking, sustained dysregulation that coaching is not building capacity for, insight-without-behavioral-change across many sessions). Do NOT generate generic referral conditions unsupported by this client\'s record.\n\n' +
      'TONE: Practical, grounded, developmental. No em dashes. Return ONLY raw JSON. No markdown, no preamble.';

    const USER_PROMPT =
      'Coaching Strategy synthesis input — ' + sessionCount + ' analyzed sessions, ' + dateRange + '.\n\n' +
      'PATTERN MAP CONTEXT (client-side anchor — already synthesized):\n' + JSON.stringify(patternContext || {}) + '\n\n' +
      'SESSION INDEX (per-session coach-facing data — use session_id values for source_sessions citations):\n' + JSON.stringify(sessionIndex) + '\n\n' +
      'TOTAL SESSIONS: ' + sessionCount + '\nDATE RANGE: ' + dateRange + '\n\n' +
      'Return ONLY this JSON shape. Every array element with a source_sessions field MUST cite real session_id values from SESSION INDEX:\n' +
      '{\n' +
      '  "effective_approaches": [\n' +
      '    {\n' +
      '      "approach": "Named coaching approach in coaching language (e.g., Cognitive Reframe, Emotional Residency, Live Pattern Naming)",\n' +
      '      "evidence": "Where in the sessions this approach showed up and what landed. 1-2 sentences.",\n' +
      '      "example_intervention": "One concrete example — what you said or did. Pull verbatim from coaching_interventions when available.",\n' +
      '      "why_it_works": "Why this approach fits this client specifically. Trace to a pattern from PATTERN MAP CONTEXT. 1-2 sentences.",\n' +
      '      "source_sessions": ["<session_id>"]\n' +
      '    }\n' +
      '  ],\n' +
      '  "ineffective_approaches": [\n' +
      '    {\n' +
      '      "approach": "Named approach that did not land",\n' +
      '      "evidence": "What you tried and what happened (or did not). 1-2 sentences.",\n' +
      '      "why_it_failed": "Why this approach misfires for this client. Trace to a pattern. 1-2 sentences.",\n' +
      '      "what_to_try_instead": "A specific alternative move grounded in what does work for them. 1 sentence.",\n' +
      '      "source_sessions": ["<session_id>"]\n' +
      '    }\n' +
      '  ],\n' +
      '  "strategic_direction": {\n' +
      '    "current_focus": "2-3 sentences naming the central thread of this client\'s coaching work right now. What are they working on? What is at stake? Tentative voice.",\n' +
      '    "next_3_sessions": "2-3 sentences on where to stay close and what to watch for in the immediate sessions ahead. Concrete.",\n' +
      '    "pivot_signals": [\n' +
      '      "Conditional in the form: \'If X observable signal → consider Y shift in approach.\' 1 sentence each. 2-4 items."\n' +
      '    ]\n' +
      '  },\n' +
      '  "approaches_to_explore": [\n' +
      '    {\n' +
      '      "approach": "Named coaching approach to try (in coaching language, not clinical)",\n' +
      '      "why_it_fits": "Why this fits THIS client now. Trace to evidence from sessions or pattern map. 1-2 sentences.",\n' +
      '      "how_to_introduce": "Concrete: what to do or ask first. 1-2 sentences. Specific enough to use in the next session.",\n' +
      '      "risk": "What could backfire and the early signal that it is. 1 sentence."\n' +
      '    }\n' +
      '  ],\n' +
      '  "when_to_refer": [\n' +
      '    {\n' +
      '      "condition": "Specific observable condition rooted in this client\'s record. NOT generic.",\n' +
      '      "referral": "Type of referral (e.g., DBT skills training, psychiatry consultation, EMDR therapist, behavioral coaching specialist)",\n' +
      '      "why": "Why coaching alone may be insufficient if this condition holds. 1-2 sentences."\n' +
      '    }\n' +
      '  ],\n' +
      '  "what_not_to_do": [\n' +
      '    "Anti-pattern in the form: \'Don\'t X — because Y about this client.\' 1 sentence each. 3-5 items.",\n' +
      '    "another anti-pattern"\n' +
      '  ]\n' +
      '}\n\n' +
      'If a section truly has no evidence, return an empty array []. NEVER invent.';

    let rawSynthesisText = '';
    let aiOutput = null;
    let synthesisFailureReason = null;

    try {
      rawSynthesisText = await callClaudeRaw(
        ANTHROPIC_API_KEY,
        'claude-sonnet-4-6',
        7500,
        SYSTEM_PROMPT,
        USER_PROMPT,
        'Coaching Strategy',
        { feature: 'coaching_strategy', coachId: coach_id }
      );
    } catch (e) {
      synthesisFailureReason = 'synthesis_api_failed';
      console.error('[Coaching Strategy] Claude API failed:', e.message);
    }

    if (!synthesisFailureReason) {
      const extracted = extractJSON(rawSynthesisText);
      try {
        aiOutput = JSON.parse(extracted);
      } catch (parseErr) {
        try {
          aiOutput = JSON.parse(jsonrepair(extracted));
          console.warn('[Coaching Strategy] JSON.parse failed, jsonrepair recovered', {
            parseErr: parseErr.message,
          });
        } catch (repairErr) {
          synthesisFailureReason = 'synthesis_parse_failed';
          console.error('[Coaching Strategy] JSON parse failed (jsonrepair also failed)', {
            parseErr: parseErr.message,
            repairErr: repairErr.message,
            raw: (rawSynthesisText || '').slice(0, 500),
          });
        }
      }
    }

    // Shape validation. Each top-level field must be present in the expected
    // shape; anything off → reject so the panel can render the prior strategy
    // with a retry banner instead of clobbering it with garbage.
    if (!synthesisFailureReason && aiOutput) {
      const arrayFields = ['effective_approaches', 'ineffective_approaches', 'approaches_to_explore', 'when_to_refer', 'what_not_to_do'];
      for (const f of arrayFields) {
        if (aiOutput[f] !== undefined && !Array.isArray(aiOutput[f])) {
          synthesisFailureReason = 'invalid_shape_' + f;
          console.error('[Coaching Strategy] expected array at ' + f);
          break;
        }
      }
      if (!synthesisFailureReason && aiOutput.strategic_direction && typeof aiOutput.strategic_direction !== 'object') {
        synthesisFailureReason = 'invalid_shape_strategic_direction';
      }
    }

    if (synthesisFailureReason || !aiOutput) {
      return res.status(200).json({
        status: 'failed',
        error: synthesisFailureReason || 'synthesis_failed',
      });
    }

    const now = new Date().toISOString();
    const fullResult = {
      effective_approaches: Array.isArray(aiOutput.effective_approaches) ? aiOutput.effective_approaches : [],
      ineffective_approaches: Array.isArray(aiOutput.ineffective_approaches) ? aiOutput.ineffective_approaches : [],
      strategic_direction: aiOutput.strategic_direction || { current_focus: '', next_3_sessions: '', pivot_signals: [] },
      approaches_to_explore: Array.isArray(aiOutput.approaches_to_explore) ? aiOutput.approaches_to_explore : [],
      when_to_refer: Array.isArray(aiOutput.when_to_refer) ? aiOutput.when_to_refer : [],
      what_not_to_do: Array.isArray(aiOutput.what_not_to_do) ? aiOutput.what_not_to_do : [],
      display_name: displayName,
      session_labels: sessionLabels,
      session_count: sessionCount,
      date_range: dateRange,
      last_analyzed: now,
      generator: 'generate-coaching-strategy@v1',
    };

    try {
      const upsertRes = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_client_strategies?on_conflict=coach_id,client_email`,
        {
          method: 'POST',
          headers: { ...supaHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({
            coach_id,
            client_email,
            strategy: fullResult,
            session_count: sessionCount,
            last_analyzed: now,
            updated_at: now,
          }),
        }
      );
      if (!upsertRes.ok) {
        const errText = await upsertRes.text();
        console.warn('[Coaching Strategy] upsert failed (non-fatal):', errText.substring(0, 500));
      }
    } catch (e) {
      console.warn('[Coaching Strategy] upsert error (non-fatal):', e.message);
    }

    return res.status(200).json(fullResult);
  } catch (e) {
    console.error('[generate-coaching-strategy] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
