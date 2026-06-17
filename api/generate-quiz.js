import { logAIUsage } from '../lib/ai-usage.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const { content, additional_material, num_questions, coach_id } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const lesson = (content || '').toString().trim();
    const extra = (additional_material || '').toString().trim();
    if (!lesson && !extra) return res.status(400).json({ error: 'Missing content' });

    const questionCount = parseInt(num_questions) || 8;
    const model = 'claude-sonnet-4-6';
    const startTime = Date.now();

    // Lesson content is the primary source. An uploaded document, when present,
    // is supplementary material layered in on top of it.
    const userParts = [];
    if (lesson) userParts.push('Lesson material (primary source):\n' + lesson.substring(0, 6000));
    if (extra) userParts.push('Additional course material (supplementary — e.g. a worksheet or external resource):\n' + extra.substring(0, 4000));
    const userMessage = 'Generate quiz questions from the following.\n\n' + userParts.join('\n\n');

    const weighting = extra
      ? ' Draw questions primarily from the lesson material, and incorporate relevant points from the additional course material where they add depth. Keep the lesson as the main source.'
      : '';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        system: `You are a coaching education expert. Generate quiz questions from the provided content. Return ONLY valid JSON with no markdown, no backticks, just raw JSON: { "title": "string", "questions": [ { "type": "multiple_choice" or "true_false", "question": "string", "options": ["string"] (4 options for mc, ["True","False"] for tf), "correct_answer": "string", "explanation": "string" } ] }. Generate exactly ${questionCount} thoughtful practical questions.${weighting}`,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    const data = await response.json().catch(function() { return null; });
    await logAIUsage({
      feature: 'quiz_generation',
      coachId: coach_id || null,
      model: (data && data.model) || model,
      usage: data && data.usage,
      requestId: data && data.id,
      status: response.ok ? 'success' : 'error',
      errorMessage: response.ok ? null : (data && data.error && data.error.message),
      durationMs: Date.now() - startTime,
    });

    if (!response.ok) {
      console.error('Anthropic API error:', response.status, data);
      return res.status(500).json({ error: 'AI generation failed' });
    }

    const text = data && data.content && data.content[0] ? data.content[0].text : '';

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Could not parse AI response' });

    const quiz = JSON.parse(jsonMatch[0]);
    return res.status(200).json(quiz);
  } catch (e) {
    console.error('generate-quiz error:', e);
    return res.status(500).json({ error: e.message });
  }
}
