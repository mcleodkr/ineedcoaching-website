export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const { content, num_questions } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!content) return res.status(400).json({ error: 'Missing content' });

    const questionCount = parseInt(num_questions) || 8;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: `You are a coaching education expert. Generate quiz questions from the provided content. Return ONLY valid JSON with no markdown, no backticks, just raw JSON: { "title": "string", "questions": [ { "type": "multiple_choice" or "true_false", "question": "string", "options": ["string"] (4 options for mc, ["True","False"] for tf), "correct_answer": "string", "explanation": "string" } ] }. Generate exactly ${questionCount} thoughtful practical questions.`,
        messages: [{ role: 'user', content: 'Generate quiz questions from this content:\n\n' + content.substring(0, 6000) }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.status(500).json({ error: 'AI generation failed' });
    }

    const data = await response.json();
    const text = data.content && data.content[0] ? data.content[0].text : '';

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Could not parse AI response' });

    const quiz = JSON.parse(jsonMatch[0]);
    return res.status(200).json(quiz);
  } catch (e) {
    console.error('generate-quiz error:', e);
    return res.status(500).json({ error: e.message });
  }
}
