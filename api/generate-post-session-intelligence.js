// POST { coachId, clientEmail, bookingId, existingGoals }
// 3-pass post-session intelligence pipeline: Extraction → Synthesis → Formatting

/**
 * @param {string} apiKey
 * @param {string} model
 * @param {number} maxTokens
 * @param {string} system
 * @param {string} userMessage
 * @returns {Promise<object>}
 */
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
    const fallback = await res.text().catch(() => 'Could not read response');
    console.error(`[${passName}] Response was not valid JSON. Raw:`, fallback.substring(0, 1000));
    throw new Error(`${passName}: API response was not valid JSON`);
  }

  // Strip markdown code fences if present
  rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    const match = rawText.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : JSON.parse(rawText);
  } catch (e) {
    console.error(`[${passName}] JSON parse failed. Raw response:`, rawText.substring(0, 2000));
    throw new Error(`${passName} JSON parse error: ${e.message}`);
  }
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

  if (!SUPABASE_KEY || !ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { coachId, clientEmail, bookingId, existingGoals, feedbackStyle } = body;
    const fbStyle = feedbackStyle || 'reflective';

    if (!coachId || !bookingId) {
      return res.status(400).json({ error: 'Missing required fields: coachId, bookingId' });
    }

    const supabaseHeaders = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    };

    // Fetch transcript and notes from coach_session_notes
    const fetchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_session_notes?booking_id=eq.${bookingId}&select=raw_transcript,notes`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const fetchData = await fetchRes.json();

    let sessionContent = '';
    if (fetchData && fetchData.length > 0) {
      if (fetchData[0].raw_transcript) {
        sessionContent = fetchData[0].raw_transcript;
      }
      if (fetchData[0].notes) {
        sessionContent += '\n\nSTRUCTURED NOTES:\n' + fetchData[0].notes;
      }
    }

    if (!sessionContent.trim()) {
      return res.status(400).json({ error: 'No transcript or notes found for this booking' });
    }

    // Shared constraints for all synthesis passes
    const CONCISE = 'Every string value: 1-2 sentences max, under 40 words. Surface the signal, not the essay.';
    const JSON_ONLY = 'Return ONLY raw JSON. No markdown. No explanation. No preamble. Start with { and end with }.';
    const TONE = 'Address coach as "you". Never use: should, must, ask the client, do this. Use: you might explore, this may suggest, one possible direction.';
    const CLARITY = 'CLARITY RULES: No sentence fragments. Replace "slow into" with "explore directly". Replace "under visibility pressure" with "when she is required to speak up or be publicly accountable". Replace "legitimacy fear" with "fear of not being taken seriously or seen as wrong". Replace "may hold" with "likely reflects". Replace "embody"/"embodied" with plain behavioral language. Every sentence must make sense read alone. No abstract psychological phrasing without immediate plain-language explanation. If a coach has to interpret meaning, rewrite the sentence.';
    const IDENTITY = 'You are Coach Clarity, a reflective thinking partner for coaches. Your role is to surface patterns and possibilities, not to instruct. Think WITH the coach, not FOR them. All language must be suggestive, not prescriptive.';

    // ── Pass 1: Extraction ──────────────────────────────────────────────
    const extractionOutput = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      1500,
      `You are an evidence extraction engine. Extract only what is explicitly present. Do not interpret. ${CONCISE} ${JSON_ONLY}`,
      `Extract from this session: client_quotes (max 5 verbatim), commitments, emotional_shifts [{before,after}], themes, coach_interventions, tension_points, mentioned_goals. All arrays of short strings.

${sessionContent}`,
      'Pass 1: Extraction'
    );

    // ── Pass 2a: Core Intelligence ──────────────────────────────────────
    const synthesisSystem = `${IDENTITY} ${TONE} ${CONCISE} ${CLARITY} ${JSON_ONLY}`;

    const coreOutput = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      2000,
      synthesisSystem,
      `Generate CORE intelligence from this evidence. ${CONCISE}

For these fields, add an optional transition_context string — one sentence max, under 20 words, connecting this section to what came before. Return null if no natural connection exists. Use these starters: strategic_direction: "Because this pattern showed up..." or "Given what emerged..."; early_cues: "If this pattern is still active..."; next_session: "Given what shifted and what remains fragile..."; friction_points: "The most likely place this progress could stall..."; if_stuck: "If that stalling happens...".

Also generate emotional_anchor — one sentence under 20 words capturing the human stakes of this session. Not clinical. Not mechanical. The real weight of what this client is carrying. Return null if nothing meaningful. Examples: "This is not a skill gap — it is a permission shift that has not fully stabilized yet." "Eight months of private certainty is now a public test."

EVIDENCE: ${JSON.stringify(extractionOutput)}

Return ONLY this JSON:
{"key_insights":["what client is doing or avoiding, max 20 words","what shifted this session if anything, max 20 words","what matters most to watch next session, max 20 words"],"core_focus":{"summary":"","why_it_matters":"","transition_context":""},"breakthrough":{"client_quote":"","what_changed":"","why_it_matters":"","reinforcement_suggestion":"","transition_context":""},"pattern":{"name":"","description":"","trigger":"","behavior":"","timeline":{"past":"","present":"","future_risk":""},"next_session_watch":"","next_session_why":"","transition_context":""},"emotional_anchor":"one sentence — the human stakes, not clinical","strategic_direction":{"suggestion":"","why_it_matters":"","what_it_may_reveal":"","use_with_awareness":"","transition_context":""},"early_cues":{"signals":[],"why_it_matters":"","transition_context":""},"opening_question":{"question":"","why_start_here":"","transition_context":""},"next_session":{"focus":"","listen_for":"","explore":"","if_shift":{"options":[],"why_it_matters":""},"transition_context":""},"session_in_one_line":""}`,
      'Pass 2a: Core Intelligence'
    );

    // ── Pass 2b: Coaching Interventions (isolated to prevent truncation) ─
    const goalsContext = existingGoals && existingGoals.length
      ? '\nGoals: ' + existingGoals.join(', ')
      : '';

    const MIRROR_RULES = `You are Coach Clarity, a reflective partner for professional coaches. Your job is to eliminate ambiguity and show the coach exactly what happened, what they did, why it mattered, and why it worked. CRITICAL RULE: Never describe the client in sections designated for the coach. If a section is about the coach's approach, every sentence must have "you" as the subject. HARD LIMIT: Maximum 2 items per array. Maximum 15 words per string value. Return ONLY raw JSON starting with { and ending with }. ${TONE} ${CLARITY}`;

    // ── Pass 2b: Interventions + What Stood Out + Reflection ─────────────
    const pass2bOutput = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      2500,
      MIRROR_RULES,
      `Generate max 2 interventions, max 2 what_stood_out items, and reflection.

WORD LIMITS: 15 words max per field EXCEPT see_why_this_works fields. The see_why_this_works block overrides the 15-word cap — treat those as applied teaching, not glossary entries.

technique_name MUST use recognized categories: Confrontation, Reflective Listening, Cognitive Reframe, Immediacy, Silence, Strategic Questioning, Activation Prompt, Future Self — with parenthetical refinement. Example: "Confrontation (Authority Alignment)". Never invent categories.

Each intervention includes a see_why_this_works block with real teaching depth. No glossary text. No surface labels.

see_why_this_works.mechanism — 3-4 sentences, paragraph depth:
- Explain what the intervention is in practice, not in theory.
- Name what the coach did in THIS session (reference the actual transcript moment).
- Explain why that specific move shifts the client psychologically.
- Stay grounded in the actual transcript. No generic theory.
- End the mechanism explanation with a precise statement of what specifically shifted in the client as a result of this move — not just that something changed, but what changed and why it matters for this client's pattern.

see_why_this_works.model — 3-4 sentences, paragraph depth:
- Name the underlying theory in plain practitioner language.
- Connect the theory directly to what happened in this session.
- Assume the coach is unfamiliar with the term and needs it taught, not name-dropped.
- No textbook abstraction. Concrete, applied, session-grounded.

see_why_this_works.transfer — 3-part structure:
- when_to_use: array of 2-3 short cues (each a brief phrase describing a live session signal — e.g., "When a client loops on blame without ownership")
- what_it_sounds_like: array of 1-2 realistic lines a coach could actually say in-session (full utterances, up to ~25 words each)
- alternative_intervention: an object OR null. Only include if there is strong session-based justification for a real alternative. Prefer null over a generic suggestion. When included:
  - name: the intervention name
  - what_it_is: 2-3 sentences explaining the move in applied terms
  - why_it_fits_this_moment: 1-2 sentences anchored in the exact transcript moment
  - example_lines: array of 1-2 realistic coach utterances

EVIDENCE: ${JSON.stringify(extractionOutput)}
CORE: ${JSON.stringify(coreOutput)}

Return ONLY:
{"coaching_interventions":[{"technique_name":"Category (Refinement)","what_you_did":"You said: [quote]","immediate_effect":"","why_it_mattered":"","signal_strength":"high|medium|low","evidence_anchor":"","dna_tag":[],"consideration":null,"see_why_this_works":{"mechanism":"","model":"","transfer":{"when_to_use":[],"what_it_sounds_like":[],"alternative_intervention":null}}}],"what_stood_out":[{"title":"","what_happened_client":"","what_you_did":"You...","why_it_matters":"","your_impact":""}],"reflection_and_growth":{"what_stood_out_in_your_approach":"You...","what_seemed_effective":"","one_place_to_stay_curious":"You might stay curious about..."},"friction_points":{"points":[],"why_it_matters":"","transition_context":null},"if_stuck":{"scenario":"","explore":"","one_possible_direction":"","transition_context":null},"commitments":[{"text":"","priority":"","follow_up_question":""}]}`,
      'Pass 2b: Interventions'
    );

    // ── Pass 2c: Curiosity + Missed Windows ───────────────────────────
    const pass2cOutput = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      1500,
      `${MIRROR_RULES} Feedback style: ${fbStyle}. If reflective: lead with "There was an opening to...", "You might notice...". If direct: lead with "You stayed at the surface.", "You moved past a deeper opening.". Both: never shame, never say "you should have" or "you missed". Anchor in observable behavior. PLAIN LANGUAGE REQUIRED: Never use coaching jargon. Replace "slow into" with "stay with" or "explore more closely". Replace "under visibility pressure" with "in moments where she is being watched". Replace "legitimacy fear" with "fear of not being taken seriously". Every sentence must be complete and standalone. No fragments. No implied subjects. Each field value must make sense when read alone.`,
      `Generate max 2 curiosity edges and max 2 missed windows. If no meaningful missed window exists return empty array. Every field must be a complete sentence with a clear subject.

Curiosity edges: each is a live question worth holding, not a correction. Max 12 words per field.

Missed windows: each must follow this exact 6-part structure. No generic advice. No instructional tone. Stay grounded in the exact session moment.

For each missed window:
1. what_opened — one sentence describing the moment that surfaced (what the client said or did that created the opening)
2. what_you_did — what the coach did in that moment, written in second person ("You..."). Must include a verbatim or near-verbatim client quote and coach response where possible
3. what_that_did — one sentence describing how the coach's move shifted or closed the moment
4. what_this_cost — precise description of what did not fully develop — emotional, behavioral, or insight-level. Be specific, not generic
5. if_you_stayed — what was available in that exact moment if the coach had stayed with it. Grounded in the specific situation, not general coaching wisdom
6. what_that_might_sound_like — optional, 1-2 example lines that extend the moment naturally. Should feel like a continuation, not a correction. Set to null if forced.
7. alternative_intervention — OPTIONAL. Only include if there is strong session-based justification for a real alternative move at this moment. Prefer null over a generic coaching suggestion. When included, use language that teaches the coach the move. Fields:
   - name: intervention name
   - what_it_is: 2-3 sentences explaining the move in applied terms
   - why_it_fits_here: 1-2 sentences anchored in the exact moment from the transcript
   - example_lines: array of 1-2 realistic coach utterances
   Set the whole alternative_intervention object to null when no strong alternative exists.

Also populate verbatim_evidence with the exact client_quote and coach_response that anchors this missed window. Use empty strings only if no verbatim material exists.

Signal metadata (not displayed to coach — used for DNA tagging):
- signal_type: emotional_mismatch|repetition_without_movement|charged_language|behavioral_contradiction|energy_shift|unprocessed_cost
  - EMOTIONAL_MISMATCH: emotion stronger than event
  - REPETITION_WITHOUT_MOVEMENT: same idea 2-3x without resolution
  - CHARGED_LANGUAGE: trapped/betrayed/invisible/stuck
  - BEHAVIORAL_CONTRADICTION: gap between stated and done
  - ENERGY_SHIFT: sudden relief/tension/tears/flatness
  - UNPROCESSED_COST: client names a pattern or realization without exploring its emotional cost
- signal_strength: Subtle opening|Clear opening|Strong opening

Score each candidate: emotional_signal 1-3, pattern_relevance 1-3, depth_potential 1-3. Each must meet 2+ criteria. Return top 2 by score. Strength: 3-4=Subtle opening, 5-6=Clear opening, 7-9=Strong opening.

EVIDENCE: ${JSON.stringify(extractionOutput)}
CORE: ${JSON.stringify(coreOutput)}

Return ONLY:
{"curiosity_edges":[{"curiosity_note":"","what_to_notice":"","why_this_stands_out":""}],"missed_windows":[{"signal_type":"emotional_mismatch|repetition_without_movement|charged_language|behavioral_contradiction|energy_shift|unprocessed_cost","signal_strength":"Subtle opening|Clear opening|Strong opening","what_opened":"","what_you_did":"You...","verbatim_evidence":{"client_quote":"","coach_response":""},"what_that_did":"","what_this_cost":"","if_you_stayed":"","what_that_might_sound_like":null,"alternative_intervention":null}]}`,
      'Pass 2c: Curiosity + Missed Windows'
    );

    // ── Pass 2d: Patterns + Goals + Frameworks (fault-tolerant) ────────
    let pass2dOutput = {};
    try {
      pass2dOutput = await callClaude(
        ANTHROPIC_API_KEY,
        'claude-sonnet-4-6',
        600,
        `${MIRROR_RULES} Return ONLY 2 patterns maximum. Every field must be under 12 words. Start with { end with }. No markdown.`,
        `Generate max 2 patterns and goals. Every field under 12 words.
${goalsContext}

EVIDENCE: ${JSON.stringify(extractionOutput)}
CORE: ${JSON.stringify(coreOutput)}

Return ONLY:
{"patterns_and_your_role":[{"pattern_name":"","what_client_did":"","status":"surfaced|interrupted|reinforced|stabilizing","what_this_means":"","your_role":"You..."}],"what_this_session_revealed":[{"coach_pattern":"","what_you_tend_to_do":"You...","why_this_is_effective":"","where_to_stay_curious":""}],"goals":{"existing":[{"title":"","status":"","session_relevance":""}],"suggested":[{"title":"","description":""}]},"between_session":[{"title":"","invitation":"","why_it_matters":""}],"frameworks":[{"name":"","presence_level":"","what_was_observed":""}]}`,
        'Pass 2d: Patterns'
      );
    } catch (e) {
      console.error('[Pass 2d] Failed, continuing with empty patterns:', e.message);
      pass2dOutput = { patterns_and_your_role: [], what_this_session_revealed: [], goals: { existing: [], suggested: [] }, between_session: [], frameworks: [] };
    }

    // Merge 2a + 2b + 2c + 2d into one complete synthesis object
    const synthesisOutput = { ...coreOutput, ...pass2bOutput, ...pass2cOutput, ...pass2dOutput };
    synthesisOutput.patterns_and_your_role = synthesisOutput.patterns_and_your_role || [];

    // ── Pass 3: Formatting (fault-tolerant — fall back to synthesis if this fails)
    // Pre-clean directive language via string replacement before AI pass.
    // These target coach-facing instructions only. The former "don't" / "do not"
    // replacements were removed because they corrupted verbatim client quotes
    // (e.g. "I know it's me" / "I don't want that anymore"). Pass 3 still
    // handles directive language via the AI pass with full context awareness.
    let preCleaned = JSON.stringify(synthesisOutput);
    const replacements = [
      [/\bmust\b/gi, 'may want to'], [/\byou should\b/gi, 'you might'],
      [/\bask her\b/gi, 'you might explore with them'], [/\bask him\b/gi, 'you might explore with them'],
      [/\bask them\b/gi, 'you might explore with them'],
      [/\btell her\b/gi, 'you might share with them'], [/\btell him\b/gi, 'you might share with them'],
    ];
    for (const [pat, rep] of replacements) { preCleaned = preCleaned.replace(pat, rep); }

    let formattedOutput;
    try {
      formattedOutput = await callClaude(
        ANTHROPIC_API_KEY,
        'claude-haiku-4-5-20251001',
        2000,
        `You are a UX writer for Coach Clarity. Scan every string value. Any directive language — commands, instructions, statements that remove the coach's choice — must be rewritten as a suggestive alternative. Fix: should→you might explore, must→it may be worth, do not→one possible approach. Verify all why_it_matters fields are non-empty. ${JSON_ONLY}`,
        `Fix directive language in this JSON. Return corrected JSON with identical structure: ${preCleaned}`,
        'Pass 3: Formatting'
      );
    } catch (e) {
      console.error('[Pass 3: Formatting] Failed, falling back to pre-cleaned synthesis:', e.message);
      try { formattedOutput = JSON.parse(preCleaned); } catch (_) { formattedOutput = synthesisOutput; }
    }

    // ── Pass 3b: Coaching Reflection (conditional, fault-tolerant) ──────
    try {
      const exchanges = (extractionOutput.client_quotes || []).length + (extractionOutput.coach_interventions || []).length;
      const hasCrisis = (extractionOutput.tension_points || []).some(t => /crisis|self.harm|suicid|emergenc/i.test(t));
      if (exchanges >= 10 && !hasCrisis) {
        const reflectionOutput = await callClaude(
          ANTHROPIC_API_KEY,
          'claude-sonnet-4-6',
          800,
          `You are a coaching reflection system. ${TONE} ${CONCISE} ${JSON_ONLY}`,
          `Based on this session evidence, generate a coaching reflection. ${CONCISE}

EVIDENCE: ${JSON.stringify(extractionOutput)}
CORE: ${JSON.stringify(coreOutput)}

Return: {"session_type":"growth|processing|crisis_adjacent","what_stood_out":{"observation":"","why_it_matters":""},"what_seemed_effective":{"observation":"","why_it_matters":""},"one_thing_to_consider":{"suggestion":"You might consider...","why_it_matters":"","use_with_care":""}}
If session_type is processing: set what_seemed_effective and one_thing_to_consider to null.
If crisis_adjacent: return null.`,
          'Pass 3b: Coaching Reflection'
        );
        formattedOutput.coaching_reflection = reflectionOutput;
      } else {
        formattedOutput.coaching_reflection = null;
      }
    } catch (e) {
      console.error('[Pass 3b: Coaching Reflection] Failed, setting to null:', e.message);
      formattedOutput.coaching_reflection = null;
    }

    // ── Pass 3c: DNA Pattern Manifestation (conditional, fault-tolerant) ─
    // Connects this session's evidence to the coach's established DNA patterns.
    // Runs only when a DNA profile with bias_profile or pattern_activation_map
    // already exists — never invents patterns. Depends on pass2bOutput + pass2cOutput.
    let pass3cOutput = null;
    try {
      const dnaRes = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_dna_profiles?coach_id=eq.${coachId}&select=signal_patterns`,
        { headers: supabaseHeaders }
      );
      const dnaRows = await dnaRes.json();
      const existingDNA = dnaRows?.[0]?.signal_patterns || null;

      const hasDNA = existingDNA && (
        (Array.isArray(existingDNA.bias_profile) && existingDNA.bias_profile.length > 0) ||
        (Array.isArray(existingDNA.pattern_activation_map) && existingDNA.pattern_activation_map.length > 0)
      );

      if (hasDNA) {
        pass3cOutput = await callClaude(
          ANTHROPIC_API_KEY,
          'claude-sonnet-4-6',
          1000,
          `You are Coach Clarity. Your role is to connect this session's evidence to the coach's established DNA patterns. Do not invent new patterns. Only surface patterns where clear evidence exists in this session. Return ONLY valid JSON.`,
          `Here are this coach's established DNA patterns:
BIAS PROFILE: ${JSON.stringify(existingDNA.bias_profile?.slice(0, 3))}
PATTERN ACTIVATION MAP: ${JSON.stringify(existingDNA.pattern_activation_map?.slice(0, 3))}
BLIND SPOTS: ${JSON.stringify(existingDNA.blind_spots?.slice(0, 3))}

Here is this session's evidence:
INTERVENTIONS: ${JSON.stringify(pass2bOutput.coaching_interventions)}
MISSED WINDOWS: ${JSON.stringify(pass2cOutput.missed_windows)}
EXTRACTION: ${JSON.stringify(extractionOutput.client_quotes?.slice(0, 5))}

Identify which DNA patterns manifested in this session. Limit to 2-4 strongest matches only. For each match include verbatim or near-verbatim evidence from the session.

Return ONLY this JSON:
{
  "dna_manifestations": [
    {
      "pattern_name": "exact name from DNA",
      "pattern_type": "bias|pattern|blind_spot",
      "how_it_showed_up": "one sentence, max 20 words",
      "verbatim_evidence": [
        {
          "speaker": "client|coach",
          "quote": "exact or near-exact quote from session",
          "what_this_reflects": "one sentence explanation, max 15 words"
        }
      ],
      "recurrence_note": "Seen in X of last Y sessions from DNA data"
    }
  ]
}`,
          'Pass 3c: DNA Pattern Manifestation'
        );
      } else {
        console.log('[Pass 3c] No DNA profile found for coach, skipping.');
      }
    } catch (e) {
      console.error('[Pass 3c: DNA Pattern Manifestation] Failed, setting to null:', e.message);
      pass3cOutput = null;
    }

    formattedOutput.dna_manifestations = pass3cOutput?.dna_manifestations || null;

    // ── Pass 3d: Approaches to Explore Next (conditional, fault-tolerant) ─
    // Generates 1-2 fit-based approach lens suggestions based on this session's
    // missed windows and the client's pattern map. Skipped if no missed windows.
    let pass3dOutput = null;
    try {
      const hasMissedWindows = Array.isArray(pass2cOutput?.missed_windows) && pass2cOutput.missed_windows.length > 0;
      if (hasMissedWindows && clientEmail) {
        // Fetch client pattern map for context
        const cpmRes = await fetch(
          `${SUPABASE_URL}/rest/v1/coach_client_patterns?coach_id=eq.${coachId}&client_email=eq.${encodeURIComponent(clientEmail)}&select=pattern_map&limit=1`,
          { headers: supabaseHeaders }
        );
        const cpmRows = await cpmRes.json();
        const clientPatternSummary = cpmRows?.[0]?.pattern_map ? {
          core_patterns: cpmRows[0].pattern_map.core_patterns?.slice(0, 3),
          where_stuck: cpmRows[0].pattern_map.where_they_get_stuck?.slice(0, 2),
          likely_drivers: cpmRows[0].pattern_map.likely_drivers?.slice(0, 2),
        } : null;

        // Growth edges from DNA (if any)
        const dnaGrowthEdges = pass3cOutput?.dna_manifestations ? null :
          (formattedOutput.dna_manifestations ? null : null);
        // Try to pull growth edges from the existing DNA fetch if cached in pass3c flow
        let dnaEdgesForPrompt = null;
        try {
          const dnaRes2 = await fetch(
            `${SUPABASE_URL}/rest/v1/coach_dna_profiles?coach_id=eq.${coachId}&select=signal_patterns&limit=1`,
            { headers: supabaseHeaders }
          );
          const dnaRows2 = await dnaRes2.json();
          const sp = dnaRows2?.[0]?.signal_patterns;
          if (sp && Array.isArray(sp.growth_edges)) dnaEdgesForPrompt = sp.growth_edges.slice(0, 3);
        } catch (_) { dnaEdgesForPrompt = null; }

        pass3dOutput = await callClaude(
          ANTHROPIC_API_KEY,
          'claude-sonnet-4-6',
          800,
          `You are Coach Clarity. Suggest 1-2 coaching approach lenses that fit this session and this client. These are not corrections. They are fit-based expansions of the coach's range. Use coaching language only. No clinical labels. Return ONLY valid JSON.`,
          `Based on this session's missed windows and client patterns, suggest 1-2 approaches to explore.

Missed windows: ${JSON.stringify(pass2cOutput.missed_windows)}
Client patterns: ${clientPatternSummary ? JSON.stringify(clientPatternSummary) : 'not yet generated'}
Coach DNA growth edges: ${dnaEdgesForPrompt ? JSON.stringify(dnaEdgesForPrompt) : 'not yet generated'}

For each suggestion return:
{
  "approach_name": "coaching lens name",
  "why_it_fits_this_client": "2 sentences grounded in client patterns",
  "why_it_fits_this_moment": "1 sentence tied to a specific missed window",
  "how_it_aligns_with_your_style": "1 sentence starting You already...",
  "how_it_stretches_your_range": "1 sentence starting This would stretch you by...",
  "open_in_lab": true
}

Return: { "approaches_to_explore": [...] }
Limit to 2 suggestions max. If no strong fit exists return empty array.`,
          'Pass 3d: Approaches to Explore Next'
        );
      } else {
        console.log('[Pass 3d] No missed windows or no clientEmail, skipping.');
      }
    } catch (e) {
      console.error('[Pass 3d: Approaches to Explore Next] Failed, setting to null:', e.message);
      pass3dOutput = null;
    }

    formattedOutput.approaches_to_explore = pass3dOutput?.approaches_to_explore || null;

    // ── Save results to Supabase ────────────────────────────────────────
    if (bookingId) {
      await fetch(
        `${SUPABASE_URL}/rest/v1/coach_session_notes?booking_id=eq.${bookingId}`,
        {
          method: 'PATCH',
          headers: { ...supabaseHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({
            extraction_data: extractionOutput,
            synthesis_data: synthesisOutput,
            post_session_analysis: formattedOutput,
            pre_session_seed: formattedOutput.core_focus?.summary || null,
            coaching_signals: formattedOutput.coaching_signals || null,
            frameworks_detected: formattedOutput.frameworks || null,
            dna_manifestations: formattedOutput.dna_manifestations,
          }),
        }
      );
    }

    // ── Auto-create action items from commitments ───────────────────────
    const commitments = formattedOutput.commitments;
    if (commitments && commitments.length > 0 && clientEmail) {
      const items = commitments.map((c) => ({
        coach_id: coachId,
        client_email: clientEmail,
        booking_id: bookingId || null,
        title: c.text,
        source: 'ai',
      }));

      await fetch(`${SUPABASE_URL}/rest/v1/coach_action_items`, {
        method: 'POST',
        headers: { ...supabaseHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify(items),
      });
    }

    return res.status(200).json(formattedOutput);
  } catch (e) {
    console.error('[generate-post-session-intelligence] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
