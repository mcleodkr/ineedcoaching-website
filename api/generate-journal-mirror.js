// POST { entry_text, reflection_what_became_clearer, reflection_what_still_unresolved, reflection_next_step, client_email }
// Returns { mirror_text, what_i_hear, what_may_be_shifting, question_to_carry }
//
// Generates an AI "mirror" response after a journaling session — a warm reflection
// back to the client that helps them feel seen. Never 500s; always returns a
// graceful fallback so the client journaling flow can continue.
//
// Schema dependency — run this in Supabase SQL Editor if not already applied:
//   ALTER TABLE coach_journal_entries ADD COLUMN IF NOT EXISTS mirror_response text;

const FALLBACK = {
  mirror_text: 'Your words have been received. Take whatever feels right with you from this.',
  what_i_hear: null,
  what_may_be_shifting: null,
  question_to_carry: null,
};

const SYSTEM_PROMPT = "You are a warm, grounded coaching presence. A client has just written a journal entry and answered reflection prompts. Your job is to briefly mirror their experience back to them in a way that helps them feel seen and recognized — not analyzed, not advised, not diagnosed.\n\nGenerate a response with exactly three parts:\n\nWHAT I'M HEARING: 1-2 sentences that reflect the emotional truth or pattern you notice in what they wrote. Stay close to their actual words and experience. Do not interpret beyond the evidence.\n\nWHAT MAY BE SHIFTING: 1 sentence that names something that seems to be moving or becoming clearer. Frame it as possibility, not conclusion.\n\nA QUESTION TO CARRY: One gentle, open question that invites them forward. Not advice. Not a task. Just an opening.\n\nRules:\n- Never use clinical language, diagnosis terms, or therapy framing\n- Never say 'it seems like' or 'perhaps you' — be more direct and grounded\n- Never be longer than 6 sentences total\n- Always speak in second person (you/your)\n- Stay rooted in what they actually wrote — do not project or over-interpret\n- The tone should feel like a thoughtful human coach who is fully present\n\nReturn the response formatted exactly as:\n\nWHAT I'M HEARING: <text>\n\nWHAT MAY BE SHIFTING: <text>\n\nA QUESTION TO CARRY: <text>";

async function callClaude(apiKey, system, userMessage) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error('Claude error ' + res.status + ': ' + errBody.substring(0, 200));
  }
  const data = await res.json();
  return (data.content && data.content[0] && data.content[0].text || '').trim();
}

function parseMirrorSections(raw) {
  if (!raw || typeof raw !== 'string') {
    return { what_i_hear: null, what_may_be_shifting: null, question_to_carry: null };
  }
  // Match "WHAT I'M HEARING: <text>" up until next header or end.
  // Case-insensitive; tolerant of curly/straight apostrophes and extra whitespace.
  const hearRe = /what\s*['’]?\s*m\s*hearing\s*:\s*([\s\S]*?)(?=\n\s*(?:what\s+may\s+be\s+shifting|a\s+question\s+to\s+carry)\s*:|$)/i;
  const shiftRe = /what\s+may\s+be\s+shifting\s*:\s*([\s\S]*?)(?=\n\s*(?:a\s+question\s+to\s+carry)\s*:|$)/i;
  const questionRe = /a\s+question\s+to\s+carry\s*:\s*([\s\S]*?)$/i;

  const hearMatch = raw.match(hearRe);
  const shiftMatch = raw.match(shiftRe);
  const questionMatch = raw.match(questionRe);

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim() || null;

  return {
    what_i_hear: clean(hearMatch && hearMatch[1]),
    what_may_be_shifting: clean(shiftMatch && shiftMatch[1]),
    question_to_carry: clean(questionMatch && questionMatch[1]),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const clientEmail = (body.client_email || '').trim().toLowerCase();
    const entryText = (body.entry_text || '').toString();
    const clearer = (body.reflection_what_became_clearer || '').toString();
    const unresolved = (body.reflection_what_still_unresolved || '').toString();
    const nextStep = (body.reflection_next_step || '').toString();

    // Auth check — verify the bearer token belongs to client_email
    const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token || !clientEmail) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
        headers: {
          'apikey': SUPABASE_KEY || token,
          'Authorization': 'Bearer ' + token,
        },
      });
      if (!userRes.ok) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const userData = await userRes.json().catch(() => ({}));
      const userEmail = (userData && userData.email || '').trim().toLowerCase();
      if (!userEmail || userEmail !== clientEmail) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    } catch (authErr) {
      console.error('[generate-journal-mirror] auth verification failed', authErr);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!ANTHROPIC_API_KEY) {
      console.error('[generate-journal-mirror] ANTHROPIC_API_KEY not configured; returning fallback');
      return res.status(200).json(FALLBACK);
    }

    const userPrompt = 'Journal entry: ' + entryText + '\n\n'
      + 'What became clearer: ' + clearer + '\n'
      + 'What still feels unresolved: ' + unresolved + '\n'
      + 'Next step named: ' + nextStep;

    try {
      const raw = await callClaude(ANTHROPIC_API_KEY, SYSTEM_PROMPT, userPrompt);
      if (!raw) {
        return res.status(200).json(FALLBACK);
      }
      const parsed = parseMirrorSections(raw);
      return res.status(200).json({
        mirror_text: raw,
        what_i_hear: parsed.what_i_hear,
        what_may_be_shifting: parsed.what_may_be_shifting,
        question_to_carry: parsed.question_to_carry,
      });
    } catch (cerr) {
      console.error('[generate-journal-mirror] Claude generation failed', cerr);
      return res.status(200).json(FALLBACK);
    }
  } catch (err) {
    console.error('[generate-journal-mirror] fatal', err);
    return res.status(200).json(FALLBACK);
  }
}
