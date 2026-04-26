// POST { client_email }
// Returns { prompt_title, prompt_text, source_type }
// Source priority: coach_assigned → ai_session → ai_goal → default
// Never 500s — always falls back to a warm default prompt.

const DEFAULT_PROMPT = {
  prompt_title: 'A moment to reflect',
  prompt_text: "Start wherever you are. What's on your mind right now?",
  source_type: 'default',
};

// Lowercase the first letter of a dynamic value that will land mid-sentence.
function lc(str) {
  if (!str || typeof str !== 'string') return str;
  return str.charAt(0).toLowerCase() + str.slice(1);
}

// Clean up prompt text before returning. Fixes stray capitals after
// prepositions (toward/about/on/for/of), collapses double periods, trims.
function cleanPromptText(str) {
  if (!str || typeof str !== 'string') return str;
  let s = str.trim();
  // Lowercase the first letter after a mid-sentence preposition when it's
  // NOT the start of a new sentence (i.e. not preceded by . ! ?).
  s = s.replace(/(\s(?:toward|about|on|for|of|around|with|through|into)\s)([A-Z])/g, function(_m, pre, ch) {
    return pre + ch.toLowerCase();
  });
  // Collapse any double (or more) periods into a single period
  s = s.replace(/\.{2,}/g, '.');
  // Collapse stray " ." into "."
  s = s.replace(/\s+\./g, '.');
  // Tidy double spaces
  s = s.replace(/ {2,}/g, ' ');
  return s.trim();
}

import { logAIUsage } from '../lib/ai-usage.js';

async function callClaude(apiKey, system, userMessage, meta) {
  const model = 'claude-sonnet-4-6';
  const startTime = Date.now();
  let res, data;
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
        max_tokens: 300,
        system,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    data = await res.json().catch(function() { return null; });
  } catch (err) {
    await logAIUsage({ feature: 'journal_prompt', coachId: meta && meta.coachId, model, status: 'error', errorMessage: err && err.message, durationMs: Date.now() - startTime });
    throw err;
  }
  await logAIUsage({
    feature: 'journal_prompt',
    coachId: meta && meta.coachId,
    model: (data && data.model) || model,
    usage: data && data.usage,
    requestId: data && data.id,
    status: res.ok ? 'success' : 'error',
    errorMessage: res.ok ? null : (data && data.error && data.error.message),
    durationMs: Date.now() - startTime,
  });
  if (!res.ok) {
    const errBody = data ? JSON.stringify(data).slice(0, 200) : '(no body)';
    throw new Error('Claude error ' + res.status + ': ' + errBody);
  }
  return (data && data.content && data.content[0] && data.content[0].text || '').trim();
}

async function sbGet(supabaseUrl, serviceKey, path) {
  const res = await fetch(supabaseUrl + '/rest/v1/' + path, {
    headers: {
      'apikey': serviceKey,
      'Authorization': 'Bearer ' + serviceKey,
    },
  });
  if (!res.ok) return [];
  return await res.json().catch(() => []);
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
    if (!clientEmail) {
      return res.status(200).json(DEFAULT_PROMPT);
    }

    // Auth check — verify the bearer token belongs to client_email
    const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
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
      console.error('Auth verification failed', authErr);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!SUPABASE_KEY) {
      return res.status(200).json(DEFAULT_PROMPT);
    }

    const encEmail = encodeURIComponent(clientEmail);

    // 1) Coach-assigned pending prompt
    try {
      const assignments = await sbGet(
        SUPABASE_URL,
        SUPABASE_KEY,
        'coach_prompt_assignments?client_email=eq.' + encEmail + '&status=eq.pending&order=created_at.desc&limit=1'
      );
      if (Array.isArray(assignments) && assignments.length > 0) {
        const a = assignments[0];
        if (a && a.prompt_text) {
          return res.status(200).json({
            prompt_title: a.prompt_title || 'From your coach',
            prompt_text: cleanPromptText(a.prompt_text),
            source_type: 'coach_assigned',
          });
        }
      }
    } catch (e) { console.error('assignment lookup failed', e); }

    // 2) AI from latest session analysis
    try {
      const sessions = await sbGet(
        SUPABASE_URL,
        SUPABASE_KEY,
        'coach_session_notes?client_email=eq.' + encEmail + '&order=created_at.desc&limit=1&select=post_session_analysis,booking_id,created_at'
      );
      if (Array.isArray(sessions) && sessions.length > 0 && sessions[0].post_session_analysis && ANTHROPIC_API_KEY) {
        const a = sessions[0].post_session_analysis || {};
        const summary = {
          core_focus: a.core_focus || null,
          breakthrough: a.breakthrough || null,
          commitments: a.commitments || null,
          existing_goals: (a.goals && a.goals.existing) || null,
          between_session: a.between_session || null,
        };
        const system = 'You are Coach Clarity writing a warm, second-person journal prompt for a client based on their most recent session. Never mention Mirror, DNA, frameworks, or coaching analysis. The prompt must be 1-2 sentences, warm, suggestive, and invite reflection — never directive. Do not use words like "should", "must", or "do this". Use language like "you might", "it may be worth", "what feels".';
        const user = 'Recent session highlights:\n' + JSON.stringify(summary, null, 2) + '\n\nWrite the journal prompt now. Return only the prompt text, no preamble or quotes.';
        try {
          const generated = await callClaude(ANTHROPIC_API_KEY, system, user);
          if (generated && generated.length > 0) {
            return res.status(200).json({
              prompt_title: 'A moment to reflect',
              prompt_text: cleanPromptText(generated.replace(/^["']|["']$/g, '')),
              source_type: 'ai_session',
            });
          }
        } catch (cerr) {
          console.error('Claude generation failed', cerr);
        }
      }
    } catch (e) { console.error('session lookup failed', e); }

    // 3) Goal-based static prompt
    try {
      const goals = await sbGet(
        SUPABASE_URL,
        SUPABASE_KEY,
        'coach_goals?client_email=eq.' + encEmail + '&status=eq.in_progress&limit=1&select=title'
      );
      if (Array.isArray(goals) && goals.length > 0 && goals[0].title) {
        const title = goals[0].title.trim().replace(/\.+$/, '');
        return res.status(200).json({
          prompt_title: 'A moment to reflect',
          prompt_text: cleanPromptText("You're working toward " + lc(title) + '. What has felt like movement this week — even a small one?'),
          source_type: 'ai_goal',
        });
      }
    } catch (e) { console.error('goal lookup failed', e); }

    // 4) Default
    return res.status(200).json(DEFAULT_PROMPT);
  } catch (err) {
    console.error('generate-journal-prompt fatal', err);
    return res.status(200).json(DEFAULT_PROMPT);
  }
}
