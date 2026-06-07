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
import { logAIUsage } from '../lib/ai-usage.js';

/**
 * Build a 2-block system payload: a shared, cacheable prefix that is byte-
 * identical across every callClaude in this Mirror generation, plus a per-
 * pass instruction block that varies per call. The shared block carries the
 * ephemeral cache_control; only the first call writes the cache and every
 * subsequent call within the 5-minute TTL reads from it.
 *
 * Cache hits require the shared prefix to be identical byte-for-byte across
 * every call. Construct sharedPrefix ONCE in the handler and pass the same
 * string here for every callClaude invocation.
 */
function buildSystem(sharedPrefix, passSpecific) {
  return [
    { type: 'text', text: sharedPrefix, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: passSpecific },
  ];
}

async function callClaude(apiKey, model, maxTokens, system, userMessage, passName, meta) {
  console.log(`[${passName}] Using model: ${model}`);
  const startTime = Date.now();
  let res, data;
  // Callers should pass a pre-built array system (see buildSystem above) so
  // the shared prefix is properly cache-tagged. The string-system fallback
  // below stays for any caller that hasn't been migrated — it still caches,
  // but without the cross-pass cache reuse the array form delivers.
  const systemPayload = typeof system === 'string'
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
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
    await logAIUsage({ feature: (meta && meta.feature) || 'coaching_mirror', coachId: meta && meta.coachId, model, status: 'error', errorMessage: err && err.message, durationMs: Date.now() - startTime });
    throw err;
  }
  await logAIUsage({
    feature: (meta && meta.feature) || 'coaching_mirror',
    coachId: meta && meta.coachId,
    model: (data && data.model) || model,
    usage: data && data.usage,
    requestId: data && data.id,
    status: res.ok ? 'success' : 'error',
    errorMessage: res.ok ? null : (data && data.error && data.error.message),
    durationMs: Date.now() - startTime,
  });

  if (!res.ok) {
    const errBody = data ? JSON.stringify(data).slice(0, 1000) : '(no body)';
    console.error(`[${passName}] Claude API error ${res.status}:`, errBody);
    throw new Error(`${passName} Claude API error ${res.status}: ${errBody.slice(0, 200)}`);
  }

  let rawText = data && data.content && data.content[0] && data.content[0].text || '';

  // Strip markdown code fences if present
  rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    const match = rawText.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : JSON.parse(rawText);
  } catch (e) {
    console.error(`[${passName}] JSON parse failed. Raw response:`, rawText.substring(0, 2000));
    // Attach the raw response to the error so callers can attempt
    // recovery (re-parse with different heuristics, fire a repair call).
    // Other failure paths (network/API errors above) don't carry rawText.
    const err = new Error(`${passName} JSON parse error: ${e.message}`);
    err.rawText = rawText;
    err.parseError = e.message;
    err.passName = passName;
    throw err;
  }
}

/**
 * Best-effort JSON parse with the same heuristics callClaude uses internally:
 * strip markdown fences, slice between first { and last }, parse. Returns
 * null on any failure — does not throw. Used by callers that want to attempt
 * recovery on a callClaude parse failure without re-implementing the cleanup.
 */
function tryParseJson(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  try {
    const stripped = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const match = stripped.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : JSON.parse(stripped);
  } catch (_) {
    return null;
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

    // Fetch transcript and notes from coach_session_notes. Pull
    // post_session_analysis too so we can detect a re-run (vs a first
    // analysis) for the usage-counter increment below.
    const fetchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_session_notes?booking_id=eq.${bookingId}&select=id,raw_transcript,notes,post_session_analysis`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const fetchData = await fetchRes.json();
    const isFirstAnalysis = !(fetchData && fetchData[0] && fetchData[0].post_session_analysis);
    // Phase 1: prior blind-spot verdicts, so a failed verdict pass on a re-run
    // never clobbers a previously-good set (post_session_analysis is rewritten
    // wholesale on every run).
    const priorPSA = (fetchData && fetchData[0] && fetchData[0].post_session_analysis) || null;
    const priorBlindSpotVerdicts = (priorPSA && Array.isArray(priorPSA.blind_spot_verdicts))
      ? priorPSA.blind_spot_verdicts : null;

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

    // ── Load prior pattern map for longitudinal context ─────────────────
    // Pulled once, reused across every meaning-reasoning pass so the model
    // reasons against what's already known about this client instead of
    // treating the session as standalone. Missing map is non-fatal — first
    // sessions and clients who never ran the generator get a null map.
    let priorPatternMap = null;
    if (clientEmail) {
      try {
        const ppmRes = await fetch(
          `${SUPABASE_URL}/rest/v1/coach_client_patterns?coach_id=eq.${coachId}&client_email=eq.${encodeURIComponent(clientEmail)}&select=pattern_map,session_count&limit=1`,
          { headers: supabaseHeaders }
        );
        const ppmRows = await ppmRes.json();
        if (Array.isArray(ppmRows) && ppmRows.length > 0 && ppmRows[0].pattern_map) {
          priorPatternMap = ppmRows[0].pattern_map;
          console.log(`[PostSession] Loaded pattern_map for client ${clientEmail}, session_count ${ppmRows[0].session_count ?? 'unknown'}`);
        } else {
          console.log(`[PostSession] No pattern_map for client ${clientEmail} — proceeding without longitudinal context`);
        }
      } catch (e) {
        console.error('[PostSession] pattern_map lookup failed, proceeding without:', e.message);
      }
    }

    const priorPatternContext = priorPatternMap ? `

PRIOR PATTERN MAP FOR THIS CLIENT (from previous sessions):
${JSON.stringify(priorPatternMap)}

When analyzing this session, reason against this pattern map. For each observation, indicate whether it confirms an existing pattern, extends a pattern with new evidence, contradicts a pattern (the client is moving differently than before), or surfaces something new. Do not repeat the pattern map verbatim — use it as context for fresh observation.` : '';

    // ── Load active goals for the client ────────────────────────────────
    // Used by the synthesis passes (so reasoning can connect to live goals)
    // and by the goal-proposal pass (to score whether status flips are warranted).
    let activeGoals = [];
    if (clientEmail) {
      try {
        const agRes = await fetch(
          `${SUPABASE_URL}/rest/v1/coach_goals?coach_id=eq.${coachId}&client_email=eq.${encodeURIComponent(clientEmail)}&status=in.(active,progressing,stalled,blocked)&select=id,title,description,status,target_date,created_at&order=created_at.desc`,
          { headers: supabaseHeaders }
        );
        const agRows = await agRes.json();
        if (Array.isArray(agRows)) activeGoals = agRows;
        console.log(`[PostSession] Loaded ${activeGoals.length} active goals for client ${clientEmail}`);
      } catch (e) {
        console.error('[PostSession] active goals lookup failed, proceeding without:', e.message);
      }
    }

    const activeGoalsContext = activeGoals.length ? `

ACTIVE GOALS FOR THIS CLIENT (live, not from this session):
${JSON.stringify(activeGoals.map(g => ({ id: g.id, title: g.title, description: g.description, status: g.status, target_date: g.target_date })))}

When you observe evidence in this session, connect it to these goals if a connection exists. Note progress, stalling, or shifts that may warrant a status change — but do not change statuses here. The dedicated goal-proposal pass will surface those.` : '';

    // Shared constraints for all synthesis passes
    const CONCISE = 'Every string value: 1-2 sentences max, under 40 words. Surface the signal, not the essay.';
    const JSON_ONLY = 'Return ONLY raw JSON. No markdown. No explanation. No preamble. Start with { and end with }.';
    const TONE = 'Address coach as "you". Never use: should, must, ask the client, do this. Use: you might explore, this may suggest, one possible direction.';
    // Pronoun guidance — applied to every synthesis pass. Default to they/them
    // when referring to the client unless coach and client both consistently used
    // a specific pronoun set throughout the transcript. Never infer pronouns from
    // names, email addresses, or any demographic cues. Verbatim client quotes are
    // preserved as-is — never rewrite a quote to change pronouns.
    const PRONOUNS = 'PRONOUN DEFAULT: Refer to the client using they/them/their unless the transcript itself shows the client and coach consistently using a different pronoun set. Never infer pronouns from names or any demographic cue. Never alter pronouns inside verbatim client_quotes — quote them exactly as spoken.';
    const CLARITY = 'CLARITY RULES: No sentence fragments. Replace "slow into" with "explore directly". Replace "under visibility pressure" with "when they are required to speak up or be publicly accountable". Replace "legitimacy fear" with "fear of not being taken seriously or seen as wrong". Replace "may hold" with "likely reflects". Replace "embody"/"embodied" with plain behavioral language. Every sentence must make sense read alone. No abstract psychological phrasing without immediate plain-language explanation. If a coach has to interpret meaning, rewrite the sentence.';
    const IDENTITY = 'You are Coach Clarity, a reflective thinking partner for coaches. Your role is to surface patterns and possibilities, not to instruct. Think WITH the coach, not FOR them. All language must be suggestive, not prescriptive.';

    // ── Shared, cacheable prefix used on every callClaude below ─────────
    // This block is identical byte-for-byte across all 10 callClaude
    // invocations in this pipeline. The first call writes it to the
    // ephemeral prompt cache; the remaining 9 calls read it back at ~10%
    // of the input cost. The transcript + context push this comfortably
    // past Sonnet's 1024-token cache minimum even on first-session,
    // no-pattern-map cases.
    //
    // DO NOT interpolate any per-pass-varying value into this prefix.
    // Any drift = no cache reuse.
    const sharedPrefix = `TONE: ${TONE}

PRONOUNS: ${PRONOUNS}

CLARITY: ${CLARITY}

CONCISE: ${CONCISE}

JSON_ONLY: ${JSON_ONLY}

SESSION TRANSCRIPT:
${sessionContent}${priorPatternContext}${activeGoalsContext}`;

    // ── Pass 1: Extraction ──────────────────────────────────────────────
    const extractionOutput = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      1500,
      buildSystem(
        sharedPrefix,
        `You are an evidence extraction engine. Extract only what is explicitly present. Do not interpret. ${CONCISE} ${JSON_ONLY}${priorPatternContext}`
      ),
      `Extract from this session: client_quotes (max 5 verbatim), commitments, emotional_shifts [{before,after}], themes, coach_interventions, tension_points, mentioned_goals. All arrays of short strings.

Also extract homework: any between-session assignment the coach gave (task, practice, reflection, journal entry, experiment, or commitment-to-do). For each:
{ "assignment_verbatim": "the coach's EXACT words assigning it, quoted from the transcript — do not paraphrase or summarize", "type": "journal | reflection | behavioral | other", "client_facing_text": "one clear sentence a client could read as a reminder" }
If no assignment was given, return an empty array. Do not invent. Coaching language only. Add "homework" as an array to the JSON.

${sessionContent}`,
      'Pass 1: Extraction'
    , { feature: 'coaching_mirror', coachId }
      );

    // ── Pass 2a: Core Intelligence ──────────────────────────────────────
    const synthesisSystem = `${IDENTITY} ${TONE} ${PRONOUNS} ${CONCISE} ${CLARITY} ${JSON_ONLY}${priorPatternContext}${activeGoalsContext}`;

    const coreOutput = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      2000,
      buildSystem(sharedPrefix, synthesisSystem),
      `Generate CORE intelligence from this evidence. ${CONCISE}

For these fields, add an optional transition_context string — one sentence max, under 20 words, connecting this section to what came before. Return null if no natural connection exists. Use these starters: strategic_direction: "Because this pattern showed up..." or "Given what emerged..."; early_cues: "If this pattern is still active..."; next_session: "Given what shifted and what remains fragile..."; friction_points: "The most likely place this progress could stall..."; if_stuck: "If that stalling happens...".

Also generate emotional_anchor — one sentence under 20 words capturing the human stakes of this session. Not clinical. Not mechanical. The real weight of what this client is carrying. Return null if nothing meaningful. Examples: "This is not a skill gap — it is a permission shift that has not fully stabilized yet." "Eight months of private certainty is now a public test."

EVIDENCE: ${JSON.stringify(extractionOutput)}

Return ONLY this JSON:
{"key_insights":["what client is doing or avoiding, max 20 words","what shifted this session if anything, max 20 words","what matters most to watch next session, max 20 words"],"core_focus":{"summary":"","why_it_matters":"","transition_context":""},"breakthrough":{"client_quote":"","what_changed":"","why_it_matters":"","reinforcement_suggestion":"","transition_context":""},"pattern":{"name":"","description":"","trigger":"","behavior":"","timeline":{"past":"","present":"","future_risk":""},"next_session_watch":"","next_session_why":"","transition_context":""},"emotional_anchor":"one sentence — the human stakes, not clinical","strategic_direction":{"suggestion":"","why_it_matters":"","what_it_may_reveal":"","use_with_awareness":"","transition_context":""},"early_cues":{"signals":[],"why_it_matters":"","transition_context":""},"opening_question":{"question":"","why_start_here":"","transition_context":""},"next_session":{"focus":"","listen_for":"","explore":"","if_shift":{"options":[],"why_it_matters":""},"transition_context":""},"session_in_one_line":""}`,
      'Pass 2a: Core Intelligence'
    , { feature: 'coaching_mirror', coachId }
      );

    // ── Pass 2a-client: Client-facing summary (Phase 2a) ────────────────
    // An authoritative, client-safe recap written server-side so the client
    // dashboard no longer has to scrape the coach blob and rewrite pronouns
    // with regex. This is a gentle 50-foot recap addressed to the CLIENT as
    // "you" — it must NOT contain coach analysis, patterns, blind spots,
    // technique, or anything diagnostic. To keep coach-only framing out even
    // of the prompt context, we feed ONLY the client-safe slices of the
    // extraction + core output (never strategic_direction, pattern timeline,
    // missed windows, DNA, etc.). Fault-tolerant: on any failure we leave
    // clientSummaryOutput null and the conditional PATCH below preserves any
    // previously-stored client_summary rather than clobbering it.
    let clientSummaryOutput = null;
    try {
      const clientSafeSignals = {
        core_focus: coreOutput?.core_focus?.summary || '',
        session_in_one_line: coreOutput?.session_in_one_line || '',
        breakthrough_quote: coreOutput?.breakthrough?.client_quote || '',
        breakthrough_what_changed: coreOutput?.breakthrough?.what_changed || '',
        client_quotes: Array.isArray(extractionOutput.client_quotes) ? extractionOutput.client_quotes : [],
        commitments: Array.isArray(extractionOutput.commitments) ? extractionOutput.commitments : [],
        themes: Array.isArray(extractionOutput.themes) ? extractionOutput.themes : [],
        emotional_shifts: Array.isArray(extractionOutput.emotional_shifts) ? extractionOutput.emotional_shifts : [],
      };
      const CLIENT_SUMMARY_SYSTEM = `You are Coach Clarity, writing a warm recap FOR THE CLIENT to read on their own dashboard after a coaching session.

WHO YOU ARE WRITING TO: the client. Address them directly as "you". This is the only place "you" means the client — everywhere else in this product "you" means the coach, but here it is the client.

WHAT THIS IS: a gentle, encouraging, 50-foot recap of what the session was about and what they are carrying forward. It helps them stay connected to their own growth between sessions.

HARD CONTENT BOUNDARY — this is read by the client, so NEVER include:
- coach analysis, coaching technique, or anything about what the coach did or could have done
- patterns, blind spots, "what I noticed about you", or psychological interpretation
- diagnostic or clinical language of any kind (no dysregulation, maladaptive, pathology, disorder, trauma-as-diagnosis)
- "missed windows", strategic direction, future-risk framing, or anything that reads like an assessment
If you are unsure whether something is client-safe, leave it out.

LANGUAGE: ${TONE} Use the effectiveness frame — what is becoming clearer, what you are building, what you might carry forward. Never good/bad/right/wrong. Warm, plain, second person. Short sentences. ${CLARITY}

LANGUAGE RULE (NON-NEGOTIABLE): Write every field — headline, recap, what_stood_out, practice, commitments, closing — in plain, concrete second-person. Describe what the client said, named, tried, or noticed, in direct terms. Do NOT use abstract metaphor or figurative language about inner states.
Wrong: "You touched calm for the first time by name."
Wrong: "You arrived at stillness after years of motion."
Right: "You named the anxiety instead of running from it."
Right: "You said you felt relieved when you let yourself stop pushing."
If referencing a feeling, name it directly — not figuratively. Tone should be warm and grounded, like a coach speaking directly to a client the morning after a session. Not reflective narrative. Not poetic.

${JSON_ONLY}`;
      clientSummaryOutput = await callClaude(
        ANTHROPIC_API_KEY,
        'claude-sonnet-4-6',
        800,
        CLIENT_SUMMARY_SYSTEM,
        `Write the client's recap from these client-safe signals only. Do not invent moments that are not present. If a field has nothing meaningful, return an empty string ("") or empty array ([]) — never fabricate.

SIGNALS: ${JSON.stringify(clientSafeSignals)}

Return ONLY this JSON:
{"headline":"a short warm phrase naming the heart of this session, second person, max 10 words","recap":"2-3 warm sentences, second person, a 50-foot view of what you explored this session","what_stood_out":"one gentle sentence naming a meaningful moment for you this session, or empty string","practice":["1-3 short plain invitations to carry into the week"],"commitments":["what you said you would do, in your own voice — empty array if none"],"closing":"one warm, encouraging sentence"}`,
        'Pass 2a-client: Client Summary'
      , { feature: 'coaching_mirror', coachId }
      );
    } catch (e) {
      console.error('[Pass 2a-client: Client Summary] Failed, leaving null (prior value preserved):', e.message);
      clientSummaryOutput = null;
    }

    // ── Pass 2b: Coaching Interventions (isolated to prevent truncation) ─
    const goalsContext = existingGoals && existingGoals.length
      ? '\nGoals: ' + existingGoals.join(', ')
      : '';

    const MIRROR_RULES = `You are Coach Clarity, a reflective partner for professional coaches. Your job is to eliminate ambiguity and show the coach exactly what happened, what they did, why it mattered, and why it worked. CRITICAL RULE: Never describe the client in sections designated for the coach. If a section is about the coach's approach, every sentence must have "you" as the subject. HARD LIMIT: Maximum 2 items per array. Maximum 15 words per string value. Return ONLY raw JSON starting with { and ending with }. ${TONE} ${PRONOUNS} ${CLARITY}${priorPatternContext}`;

    // ── Pass 2b: Interventions + What Stood Out + Reflection ─────────────
    // Two-layer JSON resilience.
    //   Layer 1: defensive re-parse on raw output, then one Claude repair call.
    //   Layer 2: if Layer 1 exhausts, the pipeline continues with an empty-
    //   but-schema-valid stub so subsequent passes + the DB write still
    //   succeed. Pass 2b's prompt is the largest in the pipeline and the
    //   most prone to embedding unescaped quotes/apostrophes inside coach
    //   example utterances; this is where we spend the recovery budget.
    let pass2bOutput;
    try {
      try {
        pass2bOutput = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      6000,
      buildSystem(sharedPrefix, MIRROR_RULES),
      `CRITICAL: You must complete valid JSON. If you are running low on tokens, reduce the depth of later items rather than truncating mid-structure. Never leave an array or object unclosed. Prioritize completing the JSON structure over maximizing depth.

Generate max 2 interventions, max 2 what_stood_out items, and reflection.

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
    , { feature: 'coaching_mirror', coachId }
      );
      } catch (parseErr) {
        // Layer 1 (a): re-attempt parse on raw response with fence-strip
        // + slice heuristics. callClaude already ran this exact cleanup
        // before throwing — so in practice this attempt typically fails
        // the same way the original did. Kept per brief spec; cheap and
        // future-proofs against callClaude changing its parsing path.
        console.warn('[Pass 2b] Initial parse failed:', parseErr.message);
        const rawText = parseErr.rawText || '';
        let recovered = tryParseJson(rawText);

        // Layer 1 (b): one repair call to Sonnet with a generic JSON-
        // repair system prompt. Only fires if Layer 1 (a) returned null
        // AND we have raw output to repair. The repair call uses its own
        // small system prompt (not the shared pipeline prefix) — it is a
        // one-off and does not need cache locality.
        if (!recovered && rawText) {
          console.warn('[Pass 2b] Layer 1a re-parse failed, firing repair call...');
          try {
            recovered = await callClaude(
              ANTHROPIC_API_KEY,
              'claude-sonnet-4-6',
              4000,
              'You are a JSON repair tool. Return only valid JSON, no commentary, no markdown.',
              `Fix syntax errors in this JSON: ${rawText}`,
              'Pass 2b: JSON Repair',
              { feature: 'coaching_mirror', coachId }
            );
            console.log('[Pass 2b] Layer 1b repair succeeded');
          } catch (repairErr) {
            console.error('[Pass 2b] Layer 1b repair also failed:', repairErr.message);
            recovered = null;
          }
        }

        if (recovered) {
          pass2bOutput = recovered;
        } else {
          // Layer 1 (c): typed throw → caught by Layer 2 below.
          const err = new Error(`Pass 2b unrecoverable: ${parseErr.parseError || parseErr.message}`);
          err.code = 'PASS_2B_RECOVERY_EXHAUSTED';
          err.originalParseError = parseErr.parseError || parseErr.message;
          throw err;
        }
      }
    } catch (recoveryErr) {
      // Layer 2: graceful degradation. Log the failure so we can monitor
      // how often it fires, then continue the pipeline with a schema-
      // valid stub. Subsequent passes that consume pass2bOutput.coaching_
      // interventions / commitments / friction_points / if_stuck see
      // empty-but-valid arrays/objects and produce reduced-but-valid
      // output. The DB write at the end then succeeds with partial
      // analysis rather than throwing a 500 to the page.
      console.error('[Pass 2b] All recovery attempts exhausted, using empty stub:', recoveryErr.message);
      try {
        await logAIUsage({
          feature: 'coaching_mirror',
          coachId,
          model: 'claude-sonnet-4-6',
          status: 'error',
          errorMessage: `Pass 2b unrecoverable: ${recoveryErr.originalParseError || recoveryErr.message}`,
          durationMs: 0,
        });
      } catch (_) { /* logging failure must not break degradation */ }
      pass2bOutput = {
        coaching_interventions: [],
        what_stood_out: [],
        reflection_and_growth: null,
        friction_points: { points: [], why_it_matters: '', transition_context: null },
        if_stuck: { scenario: '', explore: '', one_possible_direction: '', transition_context: null },
        commitments: [],
      };
    }

    // ── Pass 2c: Curiosity + Missed Windows ───────────────────────────
    const pass2cOutput = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      1500,
      buildSystem(
        sharedPrefix,
        `${MIRROR_RULES} Feedback style: ${fbStyle}. If reflective: lead with "There was an opening to...", "You might notice...". If direct: lead with "You stayed at the surface.", "You moved past a deeper opening.". Both: never shame, never say "you should have" or "you missed". Anchor in observable behavior. PLAIN LANGUAGE REQUIRED: Never use coaching jargon. Replace "slow into" with "stay with" or "explore more closely". Replace "under visibility pressure" with "in moments where they are being watched". Replace "legitimacy fear" with "fear of not being taken seriously". Every sentence must be complete and standalone. No fragments. No implied subjects. Each field value must make sense when read alone.`
      ),
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
    , { feature: 'coaching_mirror', coachId }
      );

    // ── Pass 2d: Patterns + Goals + Frameworks (fault-tolerant) ────────
    let pass2dOutput = {};
    try {
      pass2dOutput = await callClaude(
        ANTHROPIC_API_KEY,
        'claude-sonnet-4-6',
        900,
        buildSystem(
          sharedPrefix,
          `${MIRROR_RULES} Return ONLY 2 patterns maximum. Every field must be under 12 words. Start with { end with }. No markdown.`
        ),
        `Generate max 2 patterns and goals. Every field under 12 words.
${goalsContext}

EVIDENCE: ${JSON.stringify(extractionOutput)}
CORE: ${JSON.stringify(coreOutput)}

goals: You MUST generate 1-2 suggested goals based on what emerged in this session. Look at: commitments made, patterns surfaced, insights reached, behavioral intentions stated. Every session has something worth tracking. Suggested goals should be actionable and specific to this client. Format: { "existing": [], "suggested": [{ "title": "short actionable goal title", "description": "1 sentence explaining the goal" }] }

Return ONLY:
{"patterns_and_your_role":[{"pattern_name":"","what_client_did":"","status":"surfaced|interrupted|reinforced|stabilizing","what_this_means":"","your_role":"You..."}],"what_this_session_revealed":[{"coach_pattern":"","what_you_tend_to_do":"You...","why_this_is_effective":"","where_to_stay_curious":""}],"goals":{"existing":[{"title":"","status":"","session_relevance":""}],"suggested":[{"title":"","description":""}]},"between_session":[{"title":"","invitation":"","why_it_matters":""}],"frameworks":[{"name":"","presence_level":"","what_was_observed":""}]}`,
        'Pass 2d: Patterns'
      , { feature: 'coaching_mirror', coachId }
      );
      console.log('[Pass 2d] Completed. Goals suggested count:', (pass2dOutput?.goals?.suggested || []).length);
    } catch (e) {
      console.error('[Pass 2d] FAILED:', e.message);
      console.error('[Pass 2d] Stack:', e.stack);
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
        buildSystem(
          sharedPrefix,
          `You are a UX writer for Coach Clarity. Scan every string value. Any directive language — commands, instructions, statements that remove the coach's choice — must be rewritten as a suggestive alternative. Fix: should→you might explore, must→it may be worth, do not→one possible approach. Verify all why_it_matters fields are non-empty. ${JSON_ONLY}`
        ),
        `Fix directive language in this JSON. Return corrected JSON with identical structure: ${preCleaned}`,
        'Pass 3: Formatting'
      , { feature: 'coaching_mirror', coachId }
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
          buildSystem(
            sharedPrefix,
            `You are a coaching reflection system. ${TONE} ${PRONOUNS} ${CONCISE} ${JSON_ONLY}${priorPatternContext}${activeGoalsContext}`
          ),
          `Based on this session evidence, generate a coaching reflection. ${CONCISE}

EVIDENCE: ${JSON.stringify(extractionOutput)}
CORE: ${JSON.stringify(coreOutput)}

Return: {"session_type":"growth|processing|crisis_adjacent","what_stood_out":{"observation":"","why_it_matters":""},"what_seemed_effective":{"observation":"","why_it_matters":""},"one_thing_to_consider":{"suggestion":"You might consider...","why_it_matters":"","use_with_care":""}}
If session_type is processing: set what_seemed_effective and one_thing_to_consider to null.
If crisis_adjacent: return null.`,
          'Pass 3b: Coaching Reflection'
        , { feature: 'coaching_mirror', coachId }
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
          buildSystem(
            sharedPrefix,
            `You are Coach Clarity. Your role is to connect this session's evidence to the coach's established DNA patterns. Do not invent new patterns. Only surface patterns where clear evidence exists in this session. Return ONLY valid JSON.${priorPatternContext}`
          ),
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
        , { feature: 'coaching_mirror', coachId }
      );
      } else {
        console.log('[Pass 3c] No DNA profile found for coach, skipping.');
      }
    } catch (e) {
      console.error('[Pass 3c: DNA Pattern Manifestation] Failed, setting to null:', e.message);
      pass3cOutput = null;
    }

    formattedOutput.dna_manifestations = pass3cOutput?.dna_manifestations || null;

    // ── Pass 3c-bs: Blind-Spot Verdicts (Phase 1, fault-tolerant) ────────
    // Carries the coach's established blind spots into this session's Mirror
    // generation and returns a verdict for EVERY one — more_effective /
    // persisted / not_observed — with a verbatim quote from THIS session as
    // evidence, so the Mirror can show "Last time: X. This session: <verdict>"
    // and trend it. Independent of Pass 3c (which it leaves untouched): its own
    // fetch of coach_dna_profiles.signal_patterns.blind_spots, ALL of them (not
    // sliced), blind_spots only (never growth_edges). On any failure we fall
    // back to the prior verdicts rather than clobbering a good set. Effectiveness
    // language only — never fixed/failed; never fabricate improvement.
    let blindSpotVerdicts = null;
    try {
      const bsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_dna_profiles?coach_id=eq.${coachId}&select=signal_patterns`,
        { headers: supabaseHeaders }
      );
      const bsRows = await bsRes.json();
      const blindSpots = Array.isArray(bsRows?.[0]?.signal_patterns?.blind_spots)
        ? bsRows[0].signal_patterns.blind_spots.filter(b => b && b.pattern_name)
        : [];

      if (blindSpots.length > 0) {
        const verdictRaw = await callClaude(
          ANTHROPIC_API_KEY,
          'claude-sonnet-4-6',
          1200,
          buildSystem(
            sharedPrefix,
            `You are Coach Clarity. The coach has established blind spots — recurring tendencies that can reduce the effectiveness of their work. For EACH blind spot listed, judge how it played out in THIS session (the transcript is above), measured against that blind spot's own description and impact.

status is exactly one of:
- "more_effective": in a moment where this blind spot usually takes over, the coach worked more effectively than the blind spot's usual default this session.
- "persisted": the blind spot showed up the way it usually does this session.
- "not_observed": the situation that triggers this blind spot did not arise this session.

RULES:
- Effectiveness language only. NEVER use fixed, failed, good, bad, right, or wrong.
- evidence_verbatim MUST be an exact quote copied from THIS session's transcript above (coach or client) that substantiates the status. For not_observed use "" — never invent or paraphrase a quote, and never fabricate improvement.
- If you cannot ground more_effective or persisted in a real verbatim quote from this session, use not_observed instead.
- note: one sentence, suggestive, grounded in this session.
- Return a verdict for EVERY blind spot listed, using its exact pattern_name. Return ONLY valid JSON.${priorPatternContext}`
          ),
          `COACH BLIND SPOTS (judge each one):
${JSON.stringify(blindSpots.map(b => ({ pattern_name: b.pattern_name, description: b.description || '', where_it_shows_up: b.where_it_shows_up || '', impact: b.impact || '' })))}

THIS SESSION EVIDENCE:
interventions: ${JSON.stringify((pass2bOutput.coaching_interventions || []).slice(0, 4))}
missed_windows: ${JSON.stringify((pass2cOutput.missed_windows || []).slice(0, 4))}
client_quotes: ${JSON.stringify((extractionOutput.client_quotes || []).slice(0, 6))}

Return ONLY this JSON:
{"blind_spot_verdicts":[{"blind_spot":"<exact pattern_name>","status":"more_effective|persisted|not_observed","evidence_verbatim":"<exact quote from THIS session, or empty string>","note":"<one sentence>"}]}`,
          'Pass 3c-bs: Blind-Spot Verdicts'
        , { feature: 'coaching_mirror', coachId }
        );

        // Anti-hallucination + substantiation guard: one verdict per REAL blind
        // spot (exact pattern_name), valid status, not_observed → empty evidence,
        // and any more_effective/persisted without a verbatim quote is downgraded
        // to not_observed (never claim improvement we cannot ground).
        const allowed = new Set(['more_effective', 'persisted', 'not_observed']);
        const byName = {};
        (Array.isArray(verdictRaw?.blind_spot_verdicts) ? verdictRaw.blind_spot_verdicts : []).forEach(v => {
          if (v && typeof v.blind_spot === 'string') byName[v.blind_spot.trim().toLowerCase()] = v;
        });
        const verdicts = blindSpots.map(bs => {
          const name = bs.pattern_name;
          const m = byName[String(name).trim().toLowerCase()];
          let status = (m && allowed.has(m.status)) ? m.status : 'not_observed';
          let evidence = (m && typeof m.evidence_verbatim === 'string') ? m.evidence_verbatim.trim() : '';
          if (status !== 'not_observed' && !evidence) status = 'not_observed';
          if (status === 'not_observed') evidence = '';
          let note = (m && typeof m.note === 'string') ? m.note.trim() : '';
          if (!note) note = status === 'not_observed'
            ? 'This pattern did not come up in this session.'
            : '';
          return { blind_spot: name, status, evidence_verbatim: evidence, note };
        });
        blindSpotVerdicts = verdicts.length ? verdicts : null;
        console.log(`[Pass 3c-bs] Verdicts for ${verdicts.length} blind spot(s): ${verdicts.map(v => v.status).join(', ')}`);
      } else {
        console.log('[Pass 3c-bs] No coach blind spots on file, skipping.');
      }
    } catch (e) {
      console.error('[Pass 3c-bs: Blind-Spot Verdicts] Failed, preserving prior verdicts:', e.message);
      blindSpotVerdicts = null;
    }
    // Never clobber a prior good set: keep the new verdicts, else fall back to
    // whatever was already stored, else null.
    formattedOutput.blind_spot_verdicts = blindSpotVerdicts || priorBlindSpotVerdicts || null;

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
          buildSystem(
            sharedPrefix,
            `You are Coach Clarity. Suggest 1-2 coaching approach lenses that fit this session and this client. These are not corrections. They are fit-based expansions of the coach's range. Use coaching language only. No clinical labels. Return ONLY valid JSON.`
          ),
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
        , { feature: 'coaching_mirror', coachId }
      );
      } else {
        console.log('[Pass 3d] No missed windows or no clientEmail, skipping.');
      }
    } catch (e) {
      console.error('[Pass 3d: Approaches to Explore Next] Failed, setting to null:', e.message);
      pass3dOutput = null;
    }

    formattedOutput.approaches_to_explore = pass3dOutput?.approaches_to_explore || null;

    // Observability: was a prior pattern_map fed into the meaning-reasoning passes?
    formattedOutput.pattern_map_referenced = !!priorPatternMap;

    // ── Pass 3e: Goal Proposals + Status Updates (fault-tolerant) ───────
    // Generates concrete pending review items: net-new goal candidates and
    // suggested status flips on existing active goals. Output is written to
    // post_session_analysis.goal_proposals / goal_status_updates and stays
    // pending until the coach approves/edits/dismisses via approve-goal-proposal.
    let pass3eOutput = { goal_proposals: [], goal_status_updates: [] };
    if (clientEmail) {
      try {
        const proposalsRaw = await callClaude(
          ANTHROPIC_API_KEY,
          'claude-sonnet-4-6',
          1200,
          buildSystem(
            sharedPrefix,
            `You are Coach Clarity. Propose pending-review goal items for the coach. Two channels:
1. goal_proposals — net-new goal candidates surfaced by THIS session's evidence (commitments, breakthroughs, behavioral intentions). Only propose goals with clear session-grounded justification.
2. goal_status_updates — suggested status flips on existing active goals based on this session's evidence. Only suggest a flip when evidence is concrete.
Allowed status values: proposed, active, progressing, stalled, blocked, revised, completed, archived.
Coaching tone — never directive. Use "you might". No clinical labels. Return ONLY raw JSON.`
          ),
          `Active goals (status updates can only target these): ${JSON.stringify(activeGoals.map(g => ({ id: g.id, title: g.title, status: g.status, target_date: g.target_date })))}
${activeGoals.length === 0 ? 'IMPORTANT: There are zero active goals for this client. goal_status_updates MUST be []. Do not invent goal_ids. Only goal_proposals may be populated.' : 'A goal_status_update is valid ONLY when its goal_id exactly matches one of the ids above. Never invent or guess a goal_id. If no listed goal warrants a flip based on this session, return [].'}

Session extraction: ${JSON.stringify(extractionOutput)}
Session core: ${JSON.stringify({ key_insights: coreOutput?.key_insights, breakthrough: coreOutput?.breakthrough, pattern: coreOutput?.pattern, next_session: coreOutput?.next_session })}

Return ONLY:
{
  "goal_proposals": [
    {
      "title": "short actionable goal title (under 12 words)",
      "description": "1-2 sentences explaining the goal in client-facing terms",
      "reasoning": "1-2 sentences grounding this proposal in specific session evidence",
      "target_date_suggestion": null,
      "session_evidence_quote": "verbatim or near-verbatim client quote from the session, or empty string"
    }
  ],
  "goal_status_updates": [
    {
      "goal_id": "uuid from active goals list",
      "current_status": "exact current status",
      "proposed_status": "one of: active, progressing, stalled, blocked, revised, completed",
      "reasoning": "1-2 sentences grounded in this session's evidence"
    }
  ]
}

Limits: max 3 goal_proposals, max 3 goal_status_updates. Return empty arrays if no concrete evidence exists. Do not invent.`,
          'Pass 3e: Goal Proposals'
        , { feature: 'coaching_mirror', coachId }
      );
        const proposals = Array.isArray(proposalsRaw?.goal_proposals) ? proposalsRaw.goal_proposals : [];
        const rawStatusUpdates = Array.isArray(proposalsRaw?.goal_status_updates) ? proposalsRaw.goal_status_updates : [];
        const validStatuses = ['active','progressing','stalled','blocked','revised','completed'];
        const activeGoalIds = new Set(activeGoals.map(g => String(g.id)));
        const stamped = (arr) => arr.map(item => ({ id: (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2,10)}`), handled: false, ...item }));

        // Hard guard: if there are zero active goals, no status update can be
        // valid — the model has nothing to update against. Drop everything
        // and skip the per-id check entirely. This is the safety net the
        // tightened prompt is supposed to obviate, but never trust the model.
        let acceptedStatusUpdates = [];
        if (activeGoals.length === 0) {
          if (rawStatusUpdates.length > 0) {
            console.warn(`[Pass 3e] Dropped ${rawStatusUpdates.length} status update(s) — client has zero active goals. Hallucinated goal_ids:`, rawStatusUpdates.map(u => u?.goal_id));
          }
        } else {
          const dropped = [];
          acceptedStatusUpdates = rawStatusUpdates.filter(u => {
            const idMatch = u && activeGoalIds.has(String(u.goal_id));
            const statusOk = u && validStatuses.includes(u.proposed_status);
            if (!idMatch || !statusOk) {
              dropped.push({ goal_id: u?.goal_id, proposed_status: u?.proposed_status, reason: !idMatch ? 'goal_id not in active list' : 'invalid proposed_status' });
              return false;
            }
            return true;
          });
          if (dropped.length) {
            console.warn(`[Pass 3e] Dropped ${dropped.length} invalid status update(s):`, dropped);
          }
        }

        pass3eOutput.goal_proposals = stamped(proposals);
        pass3eOutput.goal_status_updates = stamped(acceptedStatusUpdates);
        console.log(`[Pass 3e] Goal proposals: ${pass3eOutput.goal_proposals.length}, status updates: ${pass3eOutput.goal_status_updates.length} (active goals available: ${activeGoals.length})`);
      } catch (e) {
        console.error('[Pass 3e: Goal Proposals] Failed, leaving empty:', e.message);
      }
    } else {
      console.log('[Pass 3e] No clientEmail, skipping goal proposals.');
    }

    formattedOutput.goal_proposals = pass3eOutput.goal_proposals;
    formattedOutput.goal_status_updates = pass3eOutput.goal_status_updates;

    // ── Brief 2a: canonicalize dna_tag arrays before persistence ────────
    // Resolves each raw tag to its pattern_taxonomy canonical entry. On
    // service failure (or any thrown error) we keep the raw tags as-is —
    // the canonicalize endpoint returns taxonomy_id:null fallback rows in
    // its own degraded mode, and the catch block here covers everything
    // outside that. Either way, a canonicalization outage degrades to
    // pre-Brief-2a behavior rather than breaking the pipeline.
    try {
      const allTags = [];
      if (Array.isArray(formattedOutput.coaching_interventions)) {
        for (const intervention of formattedOutput.coaching_interventions) {
          if (Array.isArray(intervention.dna_tag)) {
            for (const tag of intervention.dna_tag) {
              if (typeof tag === 'string' && tag.trim().length > 0) allTags.push(tag);
            }
          }
        }
      }
      if (allTags.length > 0) {
        const selfUrl = req.headers.host ? `https://${req.headers.host}` : 'https://www.ineedcoaching.org';
        const sessionNoteId = (fetchData && fetchData[0] && fetchData[0].id) || null;
        const canonResponse = await fetch(`${selfUrl}/api/canonicalize-dna-tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tags: allTags,
            source_session_id: sessionNoteId,
            source_endpoint: 'generate-post-session-intelligence',
          }),
        });
        if (canonResponse.ok) {
          const canonBody = await canonResponse.json().catch(function() { return null; });
          const resolutions = canonBody && Array.isArray(canonBody.resolutions) ? canonBody.resolutions : [];
          const resolutionMap = {};
          for (const r of resolutions) {
            if (r && r.canonical_name && typeof r.raw_tag === 'string') {
              resolutionMap[r.raw_tag] = r.canonical_name;
            }
          }
          for (const intervention of formattedOutput.coaching_interventions) {
            if (Array.isArray(intervention.dna_tag)) {
              intervention.dna_tag = intervention.dna_tag.map(function(t) {
                return resolutionMap[t] || t;
              });
            }
          }
        } else {
          console.warn('[generate-post-session-intelligence] canonicalization returned non-ok, storing raw tags', { status: canonResponse.status });
        }
      }
    } catch (canonErr) {
      console.error('[generate-post-session-intelligence] canonicalization failed (non-fatal)', { message: canonErr && canonErr.message });
    }

    // ── Homework drafts (Stage A) ───────────────────────────────────────
    // Pass 1 extracts verbatim homework alongside the other evidence. Each
    // draft gets the same {id, handled:false, ...payload} stamp the goal
    // proposals use so approve-homework can flip handled=true on approval.
    // Conditional spread on the PATCH below: an empty extraction must not
    // clobber a previously-stored homework array.
    const stampHw = (arr) => arr.map(item => ({
      id: (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2,10)}`),
      handled: false,
      ...item,
    }));
    const homeworkExtracted = Array.isArray(extractionOutput.homework)
      ? stampHw(extractionOutput.homework.filter(h => h && (h.assignment_verbatim || h.client_facing_text)))
      : [];

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
            ...(homeworkExtracted.length ? { homework: homeworkExtracted } : {}),
            ...(clientSummaryOutput ? { client_summary: clientSummaryOutput } : {}),
          }),
        }
      );
    }

    // ── Usage counter (phase 4b) ────────────────────────────────────────
    // Increment monthly_session_count only on a first-time analysis.
    // Re-runs (regenerate analysis) don't double-count. Best-effort —
    // failures are logged but never break the analysis response.
    if (isFirstAnalysis && coachId) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_coach_usage`, {
          method: 'POST',
          headers: { ...supabaseHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({ p_coach_id: coachId, p_kind: 'session' }),
        });
      } catch (incErr) {
        console.warn('[generate-post-session-intelligence] usage increment failed:', incErr && incErr.message);
      }
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
