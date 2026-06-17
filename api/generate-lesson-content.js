// POST { mode, ...context, coachId? }
// Tier 2 Coach Clarity lesson content generation. Two modes:
//   mode 'lesson'     -> { lesson_body, reflection_prompt }
//   mode 'activities' -> { activities: [string, string, string] }
// Topic/title context in, student-facing draft copy out. Writes NO tables — the
// coach dashboard populates editable fields and the coach saves normally. Only
// logs cost to coach_ai_usage_log.

import { logAIUsage } from '../lib/ai-usage.js';

// Gestalt vocabulary reframe + em/en dash stripping, identical policy to the
// outline generator. Guarantees the rules even when the model slips.
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

function sanitizeCopy(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(BANNED_RE, function (m) { return matchCase(VOCAB_REFRAME[m.toLowerCase()], m); })
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function cleanStringList(arr) {
  return (Array.isArray(arr) ? arr : [])
    .map(function (s) { return sanitizeCopy(typeof s === 'string' ? s : ''); })
    .filter(function (s) { return s.length > 0; });
}

const VOICE_RULES = `Voice and language rules (follow exactly):
- Write directly to the student in second person ("you will explore", "reflect on", "consider").
- Coaching voice: warm, direct, transformation-focused. Not academic, not instructional, not clinical.
- Frame quality as effective/ineffective and aligned/serving. Never use the words good, bad, should, must, right, or wrong.
- Never use em dashes or en dashes. Use commas or periods instead.`;

function buildLessonPrompt(ctx) {
  const system = `You are Coach Clarity, the intelligence layer of a professional coaching platform. You write a single lesson's content for a coach's course, drafted for the coach to refine.

Return ONLY valid JSON. No preamble, no markdown code fences. Match this exact shape:
{ "lesson_body": "string", "reflection_prompt": "string" }

Content rules:
- "lesson_body" is 150 to 250 words, structured but conversational, in plain sentences (no headings or markdown).
- "reflection_prompt" is one open question that starts with "What", "How", or "Where".

${VOICE_RULES}`;

  const parts = [];
  if (ctx.course_title) parts.push(`Course: ${ctx.course_title}.`);
  if (ctx.course_topic) parts.push(`Course topic: ${ctx.course_topic}.`);
  if (ctx.module_title) parts.push(`Module: ${ctx.module_title}.`);
  if (ctx.module_description) parts.push(`Module overview: ${ctx.module_description}.`);
  parts.push(`Lesson title: ${ctx.lesson_title}.`);
  if (ctx.lesson_summary) parts.push(`Lesson summary: ${ctx.lesson_summary}.`);
  parts.push('Write this lesson body and reflection prompt as JSON.');
  return { system, user: parts.join(' ') };
}

function buildActivitiesPrompt(ctx) {
  const system = `You are Coach Clarity, the intelligence layer of a professional coaching platform. You suggest practice activities for one module of a coach's course, drafted for the coach to refine.

Return ONLY valid JSON. No preamble, no markdown code fences. Match this exact shape:
{ "activities": ["string", "string", "string"] }

Content rules:
- Provide exactly 3 activities.
- Each activity is action-oriented and 1 to 2 sentences.

${VOICE_RULES}`;

  const parts = [];
  if (ctx.course_title) parts.push(`Course: ${ctx.course_title}.`);
  parts.push(`Module: ${ctx.module_title || 'this module'}.`);
  if (ctx.module_description) parts.push(`Module overview: ${ctx.module_description}.`);
  if (Array.isArray(ctx.topics) && ctx.topics.length) parts.push(`Topics covered: ${ctx.topics.join('; ')}.`);
  if (Array.isArray(ctx.learning_outcomes) && ctx.learning_outcomes.length) parts.push(`Learning outcomes: ${ctx.learning_outcomes.join('; ')}.`);
  parts.push('Suggest 3 practice activities as JSON.');
  return { system, user: parts.join(' ') };
}

function parseJson(responseText) {
  const unfenced = (responseText || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const jsonMatch = unfenced.match(/\{[\s\S]*\}/);
  return jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(unfenced);
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
    const mode = body.mode === 'activities' ? 'activities' : 'lesson';
    const coachId = body.coachId || null;

    let prompt;
    if (mode === 'lesson') {
      const lessonTitle = (body.lesson_title || '').trim();
      if (!lessonTitle) return res.status(400).json({ error: 'Missing lesson title.' });
      prompt = buildLessonPrompt({
        lesson_title: lessonTitle,
        lesson_summary: (body.lesson_summary || '').trim(),
        module_title: (body.module_title || '').trim(),
        module_description: (body.module_description || '').trim(),
        course_title: (body.course_title || '').trim(),
        course_topic: (body.course_topic || '').trim(),
      });
    } else {
      prompt = buildActivitiesPrompt({
        module_title: (body.module_title || '').trim(),
        module_description: (body.module_description || '').trim(),
        course_title: (body.course_title || '').trim(),
        topics: Array.isArray(body.topics) ? body.topics : [],
        learning_outcomes: Array.isArray(body.learning_outcomes) ? body.learning_outcomes : [],
      });
    }

    const model = 'claude-sonnet-4-5-20250929';
    const feature = mode === 'activities' ? 'lesson_activities' : 'lesson_content';
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
          max_tokens: 1500,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }],
        }),
      });
      claudeData = await claudeRes.json().catch(function () { return null; });
    } catch (err) {
      await logAIUsage({ feature, coachId, model, status: 'error', errorMessage: err && err.message, durationMs: Date.now() - startTime });
      throw err;
    }

    await logAIUsage({
      feature,
      coachId,
      model: (claudeData && claudeData.model) || model,
      usage: claudeData && claudeData.usage,
      requestId: claudeData && claudeData.id,
      status: claudeRes.ok ? 'success' : 'error',
      errorMessage: claudeRes.ok ? null : (claudeData && claudeData.error && claudeData.error.message),
      durationMs: Date.now() - startTime,
    });

    if (!claudeRes.ok) {
      console.error('[generate-lesson-content] Claude error:', claudeRes.status, claudeData);
      return res.status(502).json({ error: 'Generation failed. Please try again.' });
    }

    const responseText = (claudeData && claudeData.content && claudeData.content[0] && claudeData.content[0].text) || '';
    let parsed;
    try {
      parsed = parseJson(responseText);
    } catch (parseErr) {
      console.error('[generate-lesson-content] JSON parse failed:', parseErr.message);
      return res.status(500).json({ error: 'Could not read the generated content. Please try again.' });
    }

    if (mode === 'lesson') {
      const lessonBody = sanitizeCopy(parsed && parsed.lesson_body ? parsed.lesson_body : '');
      const reflectionPrompt = sanitizeCopy(parsed && parsed.reflection_prompt ? parsed.reflection_prompt : '');
      if (!lessonBody) return res.status(500).json({ error: 'The generated lesson was incomplete. Please try again.' });
      return res.status(200).json({ success: true, lesson_body: lessonBody, reflection_prompt: reflectionPrompt });
    }

    const activities = cleanStringList(parsed && parsed.activities).slice(0, 3);
    if (!activities.length) return res.status(500).json({ error: 'No activities were generated. Please try again.' });
    return res.status(200).json({ success: true, activities });
  } catch (e) {
    console.error('[generate-lesson-content] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
