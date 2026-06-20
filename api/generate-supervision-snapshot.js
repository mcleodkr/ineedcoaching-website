// api/generate-supervision-snapshot.js
//
// POST /api/generate-supervision-snapshot — on-demand supervision snapshot for one
// active supervision relationship. Body: { relationship_id }. Authorization: the caller
// must be the supervisor on that relationship and the relationship must be active
// (enforced here, since this assembles cross-coach data via the service role — those
// tables' RLS only admits the owning coach).
//
// Window logic (reads actual session dates from coach_session_notes.created_at):
//   1. supervision_relationships.last_supervision_contact set  -> sessions since that date
//   2. else any sessions in the last 30 days                   -> last 30 days
//   3. else                                                    -> last 10 sessions
//
// Assembles DNA + windowed session notes + client pattern maps, sends them to Claude
// Sonnet with the verbatim supervision prompt, parses the JSON, and upserts one row per
// relationship into supervision_snapshots (overwrite on regenerate).
//
// Returns: { ok:true, snapshot } | { ok:false, error } | 500 { ok:false, error, raw }

import { applyCors, parseBody, serviceConfigured, sbHeaders, deriveCoachId, isUuid, SB_URL } from '../lib/supervision.js';
import { logAIUsage } from '../lib/ai-usage.js';

const FAIL = 'Could not build this snapshot.';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const LAST_N_SESSIONS = 10;

async function getJson(url) {
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) { const t = await r.text().catch(() => ''); console.error('[snapshot] read', r.status, t.slice(0, 160)); return null; }
  return r.json().catch(() => null);
}

// Decide which sessions fall in the supervision window. `sessions` is newest-first.
function selectWindow(sessions, lastContactIso) {
  const now = Date.now();
  const valid = sessions.filter((s) => s && s.created_at && !isNaN(new Date(s.created_at).getTime()));
  if (!valid.length) return { windowed: [], windowStart: new Date(now).toISOString(), windowEnd: new Date(now).toISOString() };

  const windowEnd = new Date(now).toISOString();
  const lastContact = lastContactIso ? new Date(lastContactIso) : null;

  if (lastContact && !isNaN(lastContact.getTime())) {
    const windowed = valid.filter((s) => new Date(s.created_at).getTime() >= lastContact.getTime());
    return { windowed, windowStart: lastContact.toISOString(), windowEnd };
  }

  const recent = valid.filter((s) => now - new Date(s.created_at).getTime() <= THIRTY_DAYS_MS);
  if (recent.length) return { windowed: recent, windowStart: new Date(now - THIRTY_DAYS_MS).toISOString(), windowEnd };

  const windowed = valid.slice(0, LAST_N_SESSIONS);
  const oldest = windowed[windowed.length - 1];
  return { windowed, windowStart: new Date(oldest.created_at).toISOString(), windowEnd };
}

// The supervision prompt — passed to Claude verbatim, with the four {{placeholders}}
// substituted. Do not paraphrase or compress.
function buildPrompt({ windowStart, windowEnd, sessionCount, clientCount }) {
  return `You are a clinical and coaching supervision intelligence tool. Your job is not to summarize what happened. Your job is to answer one question:

"What does this supervisor need to notice, ask about, and support next?"

You have been given:
- A set of recent coaching sessions from a coach you are supporting in supervision
- The coach's DNA profile (patterns, tendencies, growth edges, blind spots)
- Client pattern maps for clients seen in this window

The time window is: ${windowStart} to ${windowEnd}
Sessions reviewed: ${sessionCount} across ${clientCount} clients

Your output must be a JSON object with exactly these fields:

{
  "practice_context": "string — 3-4 sentences. Cover: number of sessions, number of clients, dominant client themes appearing across sessions, any acuity or risk context (crisis mentions, relapse, self-worth collapse, grief, transition), and the types of coaching work showing up. Be specific to what is actually in the data. Do not generalize.",

  "coach_development": "string — 3-5 sentences. Cover: coaching strengths showing up repeatedly in this window, one or two growth edges that are visible in the session data, how the coach's tendencies may be interacting with the client patterns they are encountering, and what the supervisor may want to ask, observe, or support next. This is the synthesis paragraph. Name the interaction between client complexity and coach development — not just what the coach did, but how their tendencies are meeting this particular body of work.",

  "supervisor_prompts": ["string", "string", "string"] — exactly 3 questions. These are conversation-openers for the supervision session itself. They should be grounded in what is actually visible in the data. They should invite reflection, not evaluation. They should open territory the coach may not have named themselves. Examples of the register: 'Where did you feel pulled to move quickly in a session this period?' / 'Which client theme activated the most uncertainty or urgency for you?' / 'Where did you notice your strongest framework landing well — and where did it feel like it might be working against you?'"
}

Tone: developmental, non-punitive, curious. Write as a thoughtful senior supervisor preparing to meet a colleague, not as an evaluator writing a report. The coach may eventually read parts of this.

Do not use the words good, bad, right, wrong, should, must, mistake, or failure. Use: effective, ineffective, aligned with, serving, not yet serving, worth exploring.

Return only the JSON object. No preamble, no explanation, no markdown fences.`;
}

// Robust JSON extraction from a model response (mirrors generate-coach-dna.js).
function parseModelJson(raw) {
  let s = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(s); } catch (e1) {
    const match = s.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch (e2) {} }
    for (let i = s.length; i > s.length * 0.5; i--) {
      const trimmed = s.substring(0, i);
      const lastBrace = trimmed.lastIndexOf('}');
      if (lastBrace === -1) continue;
      try { return JSON.parse(trimmed.substring(0, lastBrace + 1)); } catch (e3) { continue; }
    }
    return null;
  }
}

function normalizeSnapshot(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const pc = typeof parsed.practice_context === 'string' ? parsed.practice_context.trim() : '';
  const cd = typeof parsed.coach_development === 'string' ? parsed.coach_development.trim() : '';
  let prompts = Array.isArray(parsed.supervisor_prompts) ? parsed.supervisor_prompts : [];
  prompts = prompts.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim()).slice(0, 3);
  if (!pc || !cd || prompts.length !== 3) return null;
  return { practice_context: pc, coach_development: cd, supervisor_prompts: prompts };
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!serviceConfigured() || !ANTHROPIC_API_KEY) { console.error('[snapshot] not configured'); return res.status(500).json({ ok: false, error: FAIL }); }

  try {
    const me = await deriveCoachId(req);
    if (!me) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });

    const body = parseBody(req);
    const relId = body.relationship_id;
    if (!isUuid(relId)) return res.status(400).json({ ok: false, error: 'MISSING_RELATIONSHIP_ID' });

    // Authorize: caller is the supervisor and the relationship is active.
    const rels = await getJson(`${SB_URL}/rest/v1/supervision_relationships?id=eq.${encodeURIComponent(relId)}&select=id,supervisor_id,supervisee_id,status,last_supervision_contact&limit=1`);
    const rel = Array.isArray(rels) ? rels[0] : null;
    if (!rel || rel.supervisor_id !== me || rel.status !== 'active') return res.status(403).json({ ok: false, error: 'NOT_SUPERVISING' });

    const superviseeId = rel.supervisee_id;
    const enc = encodeURIComponent(superviseeId);

    // All session notes (newest-first) drive the window; DNA + client patterns enrich it.
    const [sessions, dnaRows, clients] = await Promise.all([
      getJson(`${SB_URL}/rest/v1/coach_session_notes?coach_id=eq.${enc}&select=id,client_email,created_at,post_session_analysis,coaching_signals,dna_manifestations&order=created_at.desc`),
      getJson(`${SB_URL}/rest/v1/coach_dna_profiles?coach_id=eq.${enc}&select=*&limit=1`),
      getJson(`${SB_URL}/rest/v1/coach_client_patterns?coach_id=eq.${enc}&select=client_email,pattern_map,session_count,last_analyzed`),
    ]);

    const allSessions = Array.isArray(sessions) ? sessions : [];
    const { windowed, windowStart, windowEnd } = selectWindow(allSessions, rel.last_supervision_contact);
    if (!windowed.length) return res.status(200).json({ ok: false, error: 'No sessions yet for this supervisee — there is nothing to build a snapshot from.' });

    const clientEmails = Array.from(new Set(windowed.map((s) => (s.client_email || '').toLowerCase()).filter(Boolean)));
    const sessionCount = windowed.length;
    const clientCount = clientEmails.length;

    const dna = (Array.isArray(dnaRows) && dnaRows[0]) || null;
    const windowClientPatterns = (Array.isArray(clients) ? clients : [])
      .filter((c) => c && c.client_email && clientEmails.includes(String(c.client_email).toLowerCase()))
      .map((c) => ({ client: c.client_email, pattern_map: c.pattern_map }));

    const assembled = {
      window: { start: windowStart, end: windowEnd, session_count: sessionCount, client_count: clientCount },
      sessions: windowed.map((s) => ({
        date: s.created_at,
        client: s.client_email || null,
        post_session_analysis: s.post_session_analysis || null,
        coaching_signals: s.coaching_signals || null,
        dna_manifestations: s.dna_manifestations || null,
      })),
      coach_dna_profile: dna,
      client_pattern_maps: windowClientPatterns,
    };

    const system = buildPrompt({ windowStart, windowEnd, sessionCount, clientCount });
    const userMessage = 'Here is the supervision data for this window. Build the snapshot from exactly what is present — do not invent specifics.\n\n'
      + JSON.stringify(assembled, null, 2);

    const model = 'claude-sonnet-4-6';
    const startTime = Date.now();
    let apiRes, data;
    try {
      apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 2000, system, messages: [{ role: 'user', content: userMessage }] }),
      });
      data = await apiRes.json().catch(() => null);
    } catch (err) {
      await logAIUsage({ feature: 'supervision_snapshot', coachId: me, model, status: 'error', errorMessage: err && err.message, durationMs: Date.now() - startTime });
      console.error('[snapshot] anthropic fetch', err && err.message);
      return res.status(500).json({ ok: false, error: FAIL });
    }
    await logAIUsage({
      feature: 'supervision_snapshot', coachId: me, model: (data && data.model) || model,
      usage: data && data.usage, requestId: data && data.id,
      status: apiRes.ok ? 'success' : 'error',
      errorMessage: apiRes.ok ? null : (data && data.error && data.error.message),
      durationMs: Date.now() - startTime,
    });
    if (!apiRes.ok) {
      console.error('[snapshot] anthropic', apiRes.status, data && JSON.stringify(data).slice(0, 200));
      return res.status(500).json({ ok: false, error: FAIL });
    }

    const rawText = (data && data.content && data.content[0] && data.content[0].text) || '';
    const parsed = parseModelJson(rawText);
    const snapshotText = normalizeSnapshot(parsed);
    if (!snapshotText) {
      console.error('[snapshot] malformed model JSON', rawText.slice(0, 300));
      return res.status(500).json({ ok: false, error: 'The snapshot came back in an unexpected format. Please try again.', raw: rawText.slice(0, 2000) });
    }

    // Upsert one snapshot per relationship (overwrite on regenerate, refresh generated_at).
    const nowIso = new Date().toISOString();
    const row = {
      relationship_id: relId,
      supervisor_id: me,
      supervisee_id: superviseeId,
      window_start: windowStart,
      window_end: windowEnd,
      session_count: sessionCount,
      client_count: clientCount,
      snapshot_text: snapshotText,
      generated_at: nowIso,
    };
    const up = await fetch(`${SB_URL}/rest/v1/supervision_snapshots?on_conflict=relationship_id`, {
      method: 'POST',
      headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=representation' }),
      body: JSON.stringify(row),
    });
    if (!up.ok) {
      const t = await up.text().catch(() => '');
      console.error('[snapshot] upsert', up.status, t.slice(0, 200));
      return res.status(500).json({ ok: false, error: FAIL });
    }
    const saved = await up.json().catch(() => null);
    const snapshot = (Array.isArray(saved) && saved[0]) || row;

    return res.status(200).json({ ok: true, snapshot });
  } catch (e) {
    console.error('[snapshot]', e && e.message);
    return res.status(500).json({ ok: false, error: FAIL });
  }
}
