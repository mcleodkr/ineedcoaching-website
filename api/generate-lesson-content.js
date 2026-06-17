// POST { coach_id, lesson_title, lesson_summary, module_title, module_description,
//        module_topics, module_outcomes, course_title, course_topic, mode }
// Tier 2 Coach Clarity lesson content generation. Two modes:
//   mode 'lesson'     -> { lesson_body, reflection_prompt }
//   mode 'activities' -> { activities: [string, string, string] }
// Before calling Claude it fetches the coach's DNA + recent client patterns
// (service role) so the copy sounds like the coach, not generic. Degrades
// gracefully: a failed DNA/pattern fetch just drops that context. Writes NO
// tables — the dashboard populates editable fields the coach saves normally.
// Only logs cost to coach_ai_usage_log.

import { logAIUsage } from '../lib/ai-usage.js';
import { sanitizeCopy, cleanStringList } from '../lib/copy-sanitize.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function serviceHeaders() {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
}

// Robust, shape-agnostic stringify for jsonb/text DNA + pattern fields, trimmed
// to a character budget to keep the prompt lean.
function summarizeValue(v, budget) {
  if (v == null) return '';
  let s;
  if (typeof v === 'string') s = v;
  else { try { s = JSON.stringify(v); } catch (e) { s = String(v); } }
  s = (s || '').trim();
  if (s.length > budget) s = s.slice(0, budget) + '...';
  return s;
}

// Fetch coach name + DNA + up to 3 most-recent client pattern maps (coach-wide,
// no client identity reaches the prompt). Every piece degrades to '' on failure
// so generation never blocks on missing context.
async function fetchCoachContext(coachId) {
  const ctx = { coachName: '', dnaSummary: '', patternSummary: '' };
  if (!coachId || !SUPABASE_KEY) return ctx;

  const headers = serviceHeaders();
  const profileUrl = `${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${coachId}&select=display_name,full_name&limit=1`;
  const dnaUrl = `${SUPABASE_URL}/rest/v1/coach_dna_profiles?coach_id=eq.${coachId}&order=last_analyzed.desc&limit=1&select=declared_orientation,framework_distribution,growth_edges,signal_patterns`;
  // Coach-wide, most recent first, pattern_map only — never select client_email.
  const patternsUrl = `${SUPABASE_URL}/rest/v1/coach_client_patterns?coach_id=eq.${coachId}&order=last_analyzed.desc&limit=3&select=pattern_map`;

  const [profileRes, dnaRes, patternsRes] = await Promise.all([
    fetch(profileUrl, { headers }).catch(function () { return null; }),
    fetch(dnaUrl, { headers }).catch(function () { return null; }),
    fetch(patternsUrl, { headers }).catch(function () { return null; }),
  ]);

  try {
    const rows = profileRes && profileRes.ok ? await profileRes.json() : [];
    if (Array.isArray(rows) && rows[0]) ctx.coachName = rows[0].display_name || rows[0].full_name || '';
  } catch (e) { /* degrade */ }

  try {
    const rows = dnaRes && dnaRes.ok ? await dnaRes.json() : [];
    const p = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (p) {
      const parts = [];
      if (p.declared_orientation) parts.push('Orientation: ' + summarizeValue(p.declared_orientation, 200));
      if (p.signal_patterns) parts.push('Signal patterns: ' + summarizeValue(p.signal_patterns, 600));
      if (p.growth_edges) parts.push('Growth edges: ' + summarizeValue(p.growth_edges, 300));
      if (p.framework_distribution) parts.push('Frameworks: ' + summarizeValue(p.framework_distribution, 300));
      ctx.dnaSummary = parts.filter(Boolean).join('\n');
    }
  } catch (e) { /* degrade */ }

  try {
    const rows = patternsRes && patternsRes.ok ? await patternsRes.json() : [];
    if (Array.isArray(rows) && rows.length) {
      ctx.patternSummary = rows
        .map(function (r) { return summarizeValue(r && r.pattern_map, 400); })
        .filter(Boolean)
        .map(function (s) { return '- ' + s; })
        .join('\n');
    }
  } catch (e) { /* degrade */ }

  return ctx;
}

const VOCAB_RULES = `Vocabulary rules (non-negotiable):
- Use: effective, ineffective, aligned with, serving, accomplishing.
- Never use: good, bad, right, wrong, should, must, mistake, failure.
- No em dashes or en dashes anywhere.`;

function coachContextBlock(ctx) {
  const lines = [];
  lines.push('You are writing for: ' + (ctx.coachName || 'this coach') + '.');
  lines.push('Their coaching style and strengths (Coach DNA): ' + (ctx.dnaSummary || 'not available, write in a warm, transformation-focused coaching voice.'));
  lines.push('Client patterns they commonly work with: ' + (ctx.patternSummary || 'not available.'));
  return lines.join('\n');
}

function buildLessonPrompt(ctx, c) {
  const system = `You are Coach Clarity, an AI assistant that helps coaches create course content that sounds like them, not generic content that could come from anyone.

${coachContextBlock(ctx)}

Course: ${c.course_title || ''} ${c.course_topic ? '- ' + c.course_topic : ''}
Module: ${c.module_title || ''} ${c.module_description ? '- ' + c.module_description : ''}
Topics this module covers: ${c.module_topics || 'not specified'}
Learning outcomes: ${c.module_outcomes || 'not specified'}
Lesson: ${c.lesson_title} ${c.lesson_summary ? '- ' + c.lesson_summary : ''}

Write directly to the student in second person ("you", "your"). Warm, direct, transformation-focused coaching voice, not academic, not instructional. 150 to 250 words for the lesson body.

Return ONLY valid JSON, no preamble, no markdown fences:
{
  "lesson_body": "string",
  "reflection_prompt": "string (one open question starting with What, How, or Where)"
}

${VOCAB_RULES}`;
  return { system, user: 'Write this lesson now as JSON.' };
}

function buildActivitiesPrompt(ctx, c) {
  const system = `You are Coach Clarity, an AI assistant that helps coaches create course content that sounds like them, not generic content that could come from anyone.

${coachContextBlock(ctx)}

Course: ${c.course_title || ''} ${c.course_topic ? '- ' + c.course_topic : ''}
Module: ${c.module_title || ''} ${c.module_description ? '- ' + c.module_description : ''}
Topics this module covers: ${c.module_topics || 'not specified'}
Learning outcomes: ${c.module_outcomes || 'not specified'}

Suggest 3 practice activities for this module. Each is action-oriented, 1 to 2 sentences, written directly to the student in second person ("you", "your"). Warm, transformation-focused coaching voice.

Return ONLY valid JSON, no preamble, no markdown fences:
{ "activities": ["string", "string", "string"] }

${VOCAB_RULES}`;
  return { system, user: 'Suggest the 3 activities now as JSON.' };
}

function joinList(v) {
  if (Array.isArray(v)) return v.filter(Boolean).join('; ');
  return typeof v === 'string' ? v : '';
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
    const coachId = body.coach_id || body.coachId || null;

    const ctxFields = {
      lesson_title: (body.lesson_title || '').trim(),
      lesson_summary: (body.lesson_summary || '').trim(),
      module_title: (body.module_title || '').trim(),
      module_description: (body.module_description || '').trim(),
      module_topics: joinList(body.module_topics != null ? body.module_topics : body.topics),
      module_outcomes: joinList(body.module_outcomes != null ? body.module_outcomes : body.learning_outcomes),
      course_title: (body.course_title || '').trim(),
      course_topic: (body.course_topic || '').trim(),
    };

    if (mode === 'lesson' && !ctxFields.lesson_title) {
      return res.status(400).json({ error: 'Missing lesson title.' });
    }

    // Coach DNA + client patterns (graceful: '' on any failure).
    const coachContext = await fetchCoachContext(coachId);

    const prompt = mode === 'lesson'
      ? buildLessonPrompt(coachContext, ctxFields)
      : buildActivitiesPrompt(coachContext, ctxFields);

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
