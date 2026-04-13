// POST { entry_text, reflection_what_became_clearer, reflection_what_still_unresolved, reflection_next_step, client_email }
// Returns { mirror_text, what_i_hear, what_may_be_shifting, question_to_carry }
//
// Generates an AI "mirror" response after a journaling session — a warm reflection
// back to the client that helps them feel seen. Uses OpenAI gpt-4o-mini.
// Never 500s; always returns a graceful fallback so the client journaling flow can continue.
//
// Schema dependency — run this in Supabase SQL Editor if not already applied:
//   ALTER TABLE coach_journal_entries ADD COLUMN IF NOT EXISTS mirror_response text;

const FALLBACK = {
  mirror_text: 'Your words have been received. Take whatever feels right with you from this.',
  what_i_hear: null,
  what_may_be_shifting: null,
  question_to_carry: null,
};

const SYSTEM_PROMPT = "You are a reflective mirror for a coaching client. Your role is not to advise or fix — it is to reflect back what you heard with depth and care. Read the client's reflection and respond in 3–4 sentences. Name what you heard beneath the words. Surface any tension, longing, or shift that seems present. End with one open question that invites them to go deeper — not a therapy question, a growth question. Write in second person, warm and direct.";

async function callOpenAI(apiKey, system, userMessage) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 400,
      temperature: 0.7,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMessage },
      ],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error('OpenAI error ' + res.status + ': ' + errBody.substring(0, 200));
  }
  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return (text || '').trim();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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

    if (!OPENAI_API_KEY) {
      console.error('[generate-journal-mirror] OPENAI_API_KEY not configured; returning fallback');
      return res.status(200).json(FALLBACK);
    }

    // Pass the actual journal entry and reflection answers so the mirror has real content to respond to.
    const userPrompt = 'The client wrote this journal entry:\n\n"' + entryText + '"\n\n'
      + 'Then they answered these reflection questions:\n\n'
      + 'What became clearer: ' + (clearer || '(left blank)') + '\n'
      + 'What still feels unresolved: ' + (unresolved || '(left blank)') + '\n'
      + 'What feels like a next step: ' + (nextStep || '(left blank)') + '\n\n'
      + 'Now write your 3–4 sentence mirror back to them, ending with one open growth question.';

    try {
      const raw = await callOpenAI(OPENAI_API_KEY, SYSTEM_PROMPT, userPrompt);
      if (!raw) {
        return res.status(200).json(FALLBACK);
      }
      // The new prompt returns a flowing 3–4 sentence paragraph, not three labeled
      // sections. The client renderer already falls back to showing mirror_text
      // as a single paragraph when the structured fields are null.
      return res.status(200).json({
        mirror_text: raw,
        what_i_hear: null,
        what_may_be_shifting: null,
        question_to_carry: null,
      });
    } catch (cerr) {
      console.error('[generate-journal-mirror] OpenAI generation failed', cerr);
      return res.status(200).json(FALLBACK);
    }
  } catch (err) {
    console.error('[generate-journal-mirror] fatal', err);
    return res.status(200).json(FALLBACK);
  }
}
