// POST { entry_text, reflection_what_became_clearer, reflection_what_still_unresolved, reflection_next_step, client_email }
// Returns { mirror_text, what_i_hear, what_may_be_shifting, question_to_carry }
//
// Generates an AI "mirror" response after a journaling session — a warm reflection
// back to the client that helps them feel seen. Uses OpenAI gpt-4o-mini.
// The model returns a strict JSON object with three fields; we parse and return them.
// Never 500s; always returns a graceful fallback so the client journaling flow can continue.
//
// Schema dependency — run this in Supabase SQL Editor if not already applied:
//   ALTER TABLE coach_journal_entries ADD COLUMN IF NOT EXISTS mirror_response text;

const FALLBACK = {
  mirror_text: 'Your reflection has been captured.',
  what_i_hear: null,
  what_may_be_shifting: null,
  question_to_carry: null,
};

const SYSTEM_PROMPT = [
  "You are a reflective mirror for a coaching client. Your role is not to advise or fix — it is to reflect back what you heard with depth and care.",
  "",
  "Before generating the mirror, infer the client's state from their writing: MOVING (decisive, action taken), STUCK (looping, hesitating), OVERWHELMED (scattered, unclear), or BREAKTHROUGH (naming a pattern, new awareness). Adjust tone accordingly — reinforce for MOVING, gently interrupt for STUCK, stabilize for OVERWHELMED, anchor for BREAKTHROUGH. Do not label the state to the client.",
  "",
  "Keep language grounded and specific. Avoid poetic or abstract language. Prefer concrete phrasing over inspirational tone. The mirror should feel like recognition, not motivation. Never say generic fillers like 'your words have been received' or 'thank you for sharing'.",
  "",
  "Write in second person (you/your), warm and direct. Stay rooted in the client's actual words and experience. Do not interpret beyond the evidence.",
  "",
  "Return ONLY a valid JSON object in this exact shape — no markdown, no preamble, no explanation, no code fences:",
  "",
  '{',
  '  "what_i_hear": "1-2 sentences reflecting back what the client wrote using their own language patterns. Specific, not generic.",',
  '  "what_may_be_shifting": "1 sentence naming a pattern, tension, or emerging awareness in the writing. Feels like recognition, not analysis.",',
  '  "question_to_carry": "One open question that invites the client to go deeper or take one step. Not advice. Not multiple questions."',
  '}',
].join('\n');

async function callOpenAI(apiKey, system, userMessage) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 500,
      temperature: 0.7,
      response_format: { type: 'json_object' },
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

// Robust JSON parse — handles stray whitespace, markdown code fences, or
// trailing commentary. Returns null if no valid JSON object can be extracted.
function safeParseJSON(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  // Strip ```json ... ``` or ``` ... ``` code fences
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(s);
  } catch (e1) {
    // Extract first top-level JSON object via brace matching
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(s.substring(first, last + 1));
      } catch (e2) { /* fall through */ }
    }
  }
  return null;
}

function clean(s) {
  if (!s || typeof s !== 'string') return null;
  const trimmed = s.replace(/\s+/g, ' ').trim();
  return trimmed || null;
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

    const userPrompt = 'The client wrote this journal entry:\n\n"' + entryText + '"\n\n'
      + 'Then they answered these reflection questions:\n\n'
      + 'What became clearer: ' + (clearer || '(left blank)') + '\n'
      + 'What still feels unresolved: ' + (unresolved || '(left blank)') + '\n'
      + 'What feels like a next step: ' + (nextStep || '(left blank)') + '\n\n'
      + 'Return the JSON object now. No preamble, no markdown, no explanation.';

    try {
      const raw = await callOpenAI(OPENAI_API_KEY, SYSTEM_PROMPT, userPrompt);
      if (!raw) {
        return res.status(200).json(FALLBACK);
      }
      const parsed = safeParseJSON(raw);
      if (!parsed || typeof parsed !== 'object') {
        console.error('[generate-journal-mirror] failed to parse JSON from model output:', raw.substring(0, 300));
        // Return the raw text as mirror_text so the client can still show something.
        return res.status(200).json({
          mirror_text: raw,
          what_i_hear: null,
          what_may_be_shifting: null,
          question_to_carry: null,
        });
      }
      const whatIHear = clean(parsed.what_i_hear);
      const whatShifting = clean(parsed.what_may_be_shifting);
      const questionToCarry = clean(parsed.question_to_carry);
      // Build a readable mirror_text from the three structured fields so
      // mirror_response persists meaningfully in the DB and coaches can read it.
      const mirrorText = [
        whatIHear ? 'What I\u2019m hearing: ' + whatIHear : null,
        whatShifting ? 'What may be shifting: ' + whatShifting : null,
        questionToCarry ? 'A question to carry: ' + questionToCarry : null,
      ].filter(Boolean).join('\n\n') || raw;

      return res.status(200).json({
        mirror_text: mirrorText,
        what_i_hear: whatIHear,
        what_may_be_shifting: whatShifting,
        question_to_carry: questionToCarry,
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
