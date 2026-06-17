// POST { topic, audience?, outcome?, num_modules?, coachId? }
// Tier 1 AI Course Outline Generator. Topic-in -> outline-out only.
// Returns a structured course outline (title, description, modules, lessons)
// that the coach dashboard populates into the existing syllabus builder as
// fully editable fields. Does NOT touch session data, Coach DNA, or client
// patterns (that is Tier 2). Does NOT write any course tables — the client
// persists through the existing insert path. This endpoint only calls Claude
// and logs cost to coach_ai_usage_log.

import { logAIUsage } from '../lib/ai-usage.js';

const DEFAULT_MODULES = 5;
const MIN_MODULES = 1;
// Capped at 8: a single generation stays reliable (fully-populated modules) at
// this size. Larger counts let the model thin out later modules.
const MAX_MODULES = 8;

// Gestalt vocabulary reframe. The system prompt asks the model to avoid these
// words, but it occasionally slips (e.g. "Finding the Right Rhythm"). Acceptance
// requires the banned words appear NOWHERE, so reframe deterministically into
// the effective/ineffective + suggestive vocabulary as a hard guarantee. Whole
// word, case-insensitive; case of the first letter is preserved so titles stay
// title-cased. Substrings are safe (\b protects "bright", "rights", "goodness").
const VOCAB_REFRAME = {
  good: 'effective',
  bad: 'ineffective',
  right: 'effective',
  wrong: 'ineffective',
  should: 'can',
  must: 'can',
};
const BANNED_RE = new RegExp('\\b(' + Object.keys(VOCAB_REFRAME).join('|') + ')\\b', 'gi');

function matchCase(replacement, original) {
  if (original[0] === original[0].toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

// Belt-and-suspenders sanitizer for all generated copy: strip em/en dashes
// (collapse a spaced dash to a comma so sentences stay readable) and reframe
// any banned vocabulary, so the output can never violate the rules even when
// the model slips.
function sanitizeCopy(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(BANNED_RE, function (m) { return matchCase(VOCAB_REFRAME[m.toLowerCase()], m); })
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cleanStringList(arr) {
  return (Array.isArray(arr) ? arr : [])
    .map(function (s) { return sanitizeCopy(typeof s === 'string' ? s : ''); })
    .filter(function (s) { return s.length > 0; });
}

// A module is usable only when it carries the structural backbone: at least one
// topic, one learning outcome, and one lesson. Guards against the model leaving
// later modules thin or empty at higher module counts.
function moduleComplete(m) {
  return !!m
    && Array.isArray(m.topics) && m.topics.length >= 1
    && Array.isArray(m.learning_outcomes) && m.learning_outcomes.length >= 1
    && Array.isArray(m.lessons) && m.lessons.length >= 1;
}

function completeModuleCount(outline) {
  if (!outline || !Array.isArray(outline.modules)) return 0;
  return outline.modules.filter(moduleComplete).length;
}

function outlineComplete(outline) {
  return !!outline
    && Array.isArray(outline.modules)
    && outline.modules.length >= 1
    && outline.modules.every(moduleComplete);
}

function cleanOutline(outline) {
  return {
    course_title: sanitizeCopy(outline.course_title || ''),
    course_description: sanitizeCopy(outline.course_description || ''),
    modules: (Array.isArray(outline.modules) ? outline.modules : []).map(function (m) {
      return {
        title: sanitizeCopy(m && m.title ? m.title : ''),
        summary: sanitizeCopy(m && m.summary ? m.summary : ''),
        topics: cleanStringList(m && m.topics),
        learning_outcomes: cleanStringList(m && m.learning_outcomes),
        lessons: (m && Array.isArray(m.lessons) ? m.lessons : []).map(function (l) {
          return {
            title: sanitizeCopy(l && l.title ? l.title : ''),
            description: sanitizeCopy(l && l.description ? l.description : ''),
          };
        }),
      };
    }),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const topic = (body.topic || '').trim();
    const audience = (body.audience || '').trim();
    const outcome = (body.outcome || '').trim();
    const coachId = body.coachId || null;

    if (!topic) return res.status(400).json({ error: 'Please enter a course topic.' });

    let numModules = parseInt(body.num_modules, 10);
    if (!Number.isFinite(numModules)) numModules = DEFAULT_MODULES;
    numModules = Math.max(MIN_MODULES, Math.min(MAX_MODULES, numModules));

    const system = `You are Coach Clarity, the intelligence layer of a professional coaching platform. You draft a clear, well-structured course outline that a coach will then shape and edit. This is a starting draft, never a finished product.

Return ONLY valid JSON. No preamble, no explanation, no markdown code fences. The JSON must match this exact shape:
{
  "course_title": "string",
  "course_description": "string",
  "modules": [
    {
      "title": "string",
      "summary": "string",
      "topics": ["string"],
      "learning_outcomes": ["string"],
      "lessons": [ { "title": "string", "description": "string" } ]
    }
  ]
}

Structure rules:
- Produce exactly ${numModules} module(s), in a logical progression from foundation to integration.
- Give each module 3 to 5 entries in "topics" (the subjects that module covers).
- Give each module 2 to 4 entries in "learning_outcomes" (what the student can do differently by the end of that module).
- Give each module 3 to 5 lessons.
- "course_description" is 2 to 3 sentences. "summary" is one sentence per module. Each "topics" and "learning_outcomes" entry is a short phrase. "description" is one sentence per lesson.
- EVERY module must be fully populated. Do not leave any module's "topics", "learning_outcomes", or "lessons" empty, including the last module. Give the final modules the same depth as the first.

Language rules (follow exactly):
- Use coaching language: forward-focused, strength-based, suggestive, never directive.
- Frame quality as effective/ineffective and aligned/serving. Never use the words good, bad, should, must, right, or wrong.
- Never use em dashes or en dashes. Use commas or periods instead.
- This platform is for coaches, not therapists. Never use clinical or diagnostic language (no terms like disorder, trauma, dysregulation, pathology, intervention). Describe observable patterns and behavioral tendencies instead.`;

    const userParts = [`Course topic: ${topic}.`];
    if (audience) userParts.push(`Who it is for: ${audience}.`);
    if (outcome) userParts.push(`What learners will be able to do differently by the end: ${outcome}.`);
    userParts.push(`Draft a ${numModules}-module course outline as JSON.`);

    const model = 'claude-sonnet-4-5-20250929';

    // One generation attempt: call Claude, log usage, defensively parse, clean.
    // Returns a cleaned outline or null (API error / parse failure).
    async function attemptOutline() {
      const startTime = Date.now();
      let claudeRes, claudeData;
      try {
        claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            max_tokens: 8192,
            system,
            messages: [{ role: 'user', content: userParts.join(' ') }],
          }),
        });
        claudeData = await claudeRes.json().catch(function () { return null; });
      } catch (err) {
        await logAIUsage({ feature: 'course_outline', coachId, model, status: 'error', errorMessage: err && err.message, durationMs: Date.now() - startTime });
        return null;
      }

      await logAIUsage({
        feature: 'course_outline',
        coachId,
        model: (claudeData && claudeData.model) || model,
        usage: claudeData && claudeData.usage,
        requestId: claudeData && claudeData.id,
        status: claudeRes.ok ? 'success' : 'error',
        errorMessage: claudeRes.ok ? null : (claudeData && claudeData.error && claudeData.error.message),
        durationMs: Date.now() - startTime,
      });

      if (!claudeRes.ok) {
        console.error('[generate-course-outline] Claude error:', claudeRes.status, claudeData);
        return null;
      }

      const responseText = (claudeData && claudeData.content && claudeData.content[0] && claudeData.content[0].text) || '';
      // Defensive parse: strip any ```json fences, then take the first JSON object.
      try {
        const unfenced = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
        const jsonMatch = unfenced.match(/\{[\s\S]*\}/);
        const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(unfenced);
        if (!parsed || !Array.isArray(parsed.modules) || !parsed.modules.length) return null;
        return cleanOutline(parsed);
      } catch (parseErr) {
        console.error('[generate-course-outline] JSON parse failed:', parseErr.message);
        return null;
      }
    }

    // Consistency pass: try up to twice and keep the most complete result. The
    // second attempt only runs when the first leaves a module thin, so the
    // common (already-complete) case stays a single call.
    let best = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const candidate = await attemptOutline();
      if (!candidate) continue;
      if (outlineComplete(candidate)) { best = candidate; break; }
      if (!best || completeModuleCount(candidate) > completeModuleCount(best)) best = candidate;
      console.warn('[generate-course-outline] attempt', attempt, 'incomplete:', completeModuleCount(candidate), 'of', candidate.modules.length, 'modules fully populated');
    }

    if (!best) {
      return res.status(502).json({ error: 'Outline generation failed. Please try again.' });
    }

    // Final guarantee: never hand the builder an empty module. Drop any module
    // still missing its backbone so the coach only sees fully-populated cards.
    const dropped = best.modules.length - completeModuleCount(best);
    const outline = { ...best, modules: best.modules.filter(moduleComplete) };
    if (!outline.modules.length) {
      return res.status(502).json({ error: 'The generated outline was incomplete. Please try again.' });
    }
    if (dropped > 0) {
      console.warn('[generate-course-outline] dropped', dropped, 'incomplete module(s) after retry');
    }

    return res.status(200).json({ success: true, outline });
  } catch (e) {
    console.error('[generate-course-outline] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
