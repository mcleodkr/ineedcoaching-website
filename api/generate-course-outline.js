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
const MAX_MODULES = 12;

// Belt-and-suspenders: strip em/en dashes from generated copy so the output
// can never violate the no-em-dash rule even if the model slips. Collapse a
// spaced dash into a comma so sentences stay readable.
function stripDashes(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cleanOutline(outline) {
  return {
    course_title: stripDashes(outline.course_title || ''),
    course_description: stripDashes(outline.course_description || ''),
    modules: (Array.isArray(outline.modules) ? outline.modules : []).map(function (m) {
      return {
        title: stripDashes(m && m.title ? m.title : ''),
        summary: stripDashes(m && m.summary ? m.summary : ''),
        lessons: (m && Array.isArray(m.lessons) ? m.lessons : []).map(function (l) {
          return {
            title: stripDashes(l && l.title ? l.title : ''),
            description: stripDashes(l && l.description ? l.description : ''),
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
    { "title": "string", "summary": "string",
      "lessons": [ { "title": "string", "description": "string" } ] }
  ]
}

Structure rules:
- Produce exactly ${numModules} module(s), in a logical progression from foundation to integration.
- Give each module 3 to 5 lessons.
- "course_description" is 2 to 3 sentences. "summary" is one sentence per module. "description" is one sentence per lesson.

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
      throw err;
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
      return res.status(502).json({ error: 'Outline generation failed. Please try again.' });
    }

    const responseText = (claudeData && claudeData.content && claudeData.content[0] && claudeData.content[0].text) || '';

    // Defensive parse: strip any ```json fences, then take the first JSON object.
    let outline;
    try {
      const unfenced = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
      const jsonMatch = unfenced.match(/\{[\s\S]*\}/);
      outline = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(unfenced);
    } catch (parseErr) {
      console.error('[generate-course-outline] JSON parse failed:', parseErr.message);
      return res.status(500).json({ error: 'Could not read the generated outline. Please try again.' });
    }

    if (!outline || !Array.isArray(outline.modules) || !outline.modules.length) {
      return res.status(500).json({ error: 'The generated outline was incomplete. Please try again.' });
    }

    return res.status(200).json({ success: true, outline: cleanOutline(outline) });
  } catch (e) {
    console.error('[generate-course-outline] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
