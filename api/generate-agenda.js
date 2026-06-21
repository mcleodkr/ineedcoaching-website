// api/generate-agenda.js
//
// POST /api/generate-agenda — supervisor builds a draft supervision agenda for an
// active relationship. Body: { relationship_id }. Authorization: caller must be the
// supervisor on an ACTIVE relationship (enforced here; cross-coach service-role read).
//
// Snapshot path: if a supervision_snapshots row exists for the relationship, derive
// agenda items deterministically from its practice_context / coach_development /
// supervisor_prompts. Fallback path: no snapshot -> 3 developmental items from Claude
// using the supervisee's coach DNA. Upserts the current DRAFT agenda (regenerate
// overwrites a draft; after a completed session a fresh draft is created).
//
// Returns: { ok:true, agenda } | { ok:false, error }

import { applyCors, parseBody, serviceConfigured, sbHeaders, deriveCoachId, isUuid, SB_URL, getRelationshipById } from '../lib/supervision.js';
import { buildItemsFromSnapshot, normalizeGeneratedItems } from '../lib/agenda.js';
import { logAIUsage } from '../lib/ai-usage.js';

const FAIL = 'Could not build the agenda.';

async function getJson(url) {
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) { const t = await r.text().catch(() => ''); console.error('[generate-agenda] read', r.status, t.slice(0, 160)); return null; }
  return r.json().catch(() => null);
}

function parseModelJson(raw) {
  let s = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(s); } catch (e1) {
    const match = s.match(/\[[\s\S]*\]/) || s.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch (e2) {} }
    return null;
  }
}

const FALLBACK_PROMPT = `You are preparing a coaching supervision agenda.
You have the coach's DNA profile below.
Generate exactly 3 agenda items as a JSON array.
Each item: { "id": "[uuid]", "text": "[agenda item]", "source": "snapshot", "discussed": false, "supervisee_reflection": null }
Items should be developmental questions or focus areas drawn from the coach's growth edges, blind spots, or emerging patterns.
Tone: curious, developmental, non-evaluative.
Return only the JSON array. No preamble, no markdown fences.

Coach DNA:
`;

async function generateFromDna(superviseeId, me) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return null;
  const dnaRows = await getJson(`${SB_URL}/rest/v1/coach_dna_profiles?coach_id=eq.${encodeURIComponent(superviseeId)}&select=declared_orientation,framework_distribution,signal_patterns,growth_edges,session_count&limit=1`);
  const dna = (Array.isArray(dnaRows) && dnaRows[0]) || null;
  const dnaText = dna ? JSON.stringify(dna, null, 2) : 'No DNA profile is available yet for this coach.';

  const model = 'claude-sonnet-4-6';
  const startTime = Date.now();
  let apiRes, data;
  try {
    apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1200, messages: [{ role: 'user', content: FALLBACK_PROMPT + dnaText }] }),
    });
    data = await apiRes.json().catch(() => null);
  } catch (err) {
    await logAIUsage({ feature: 'supervision_agenda', coachId: me, model, status: 'error', errorMessage: err && err.message, durationMs: Date.now() - startTime });
    return null;
  }
  await logAIUsage({
    feature: 'supervision_agenda', coachId: me, model: (data && data.model) || model,
    usage: data && data.usage, requestId: data && data.id,
    status: apiRes.ok ? 'success' : 'error',
    errorMessage: apiRes.ok ? null : (data && data.error && data.error.message),
    durationMs: Date.now() - startTime,
  });
  if (!apiRes.ok) { console.error('[generate-agenda] anthropic', apiRes.status, data && JSON.stringify(data).slice(0, 200)); return null; }
  const rawText = (data && data.content && data.content[0] && data.content[0].text) || '';
  return normalizeGeneratedItems(parseModelJson(rawText));
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!serviceConfigured()) { console.error('[generate-agenda] not configured'); return res.status(500).json({ ok: false, error: FAIL }); }

  try {
    const me = await deriveCoachId(req);
    if (!me) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });

    const body = parseBody(req);
    const relId = body.relationship_id;
    if (!isUuid(relId)) return res.status(400).json({ ok: false, error: 'MISSING_RELATIONSHIP_ID' });

    const rel = await getRelationshipById(relId);
    if (!rel || rel.supervisor_id !== me || rel.status !== 'active') return res.status(403).json({ ok: false, error: 'NOT_SUPERVISING' });
    const superviseeId = rel.supervisee_id;

    // Snapshot path first; fall back to DNA-only generation.
    const snaps = await getJson(`${SB_URL}/rest/v1/supervision_snapshots?relationship_id=eq.${encodeURIComponent(relId)}&select=id,snapshot_text&order=generated_at.desc&limit=1`);
    const snapshot = (Array.isArray(snaps) && snaps[0]) || null;

    let items = [];
    let snapshotId = null;
    if (snapshot) {
      items = buildItemsFromSnapshot(snapshot.snapshot_text);
      snapshotId = snapshot.id;
    }
    if (!items.length) {
      items = await generateFromDna(superviseeId, me);
      snapshotId = null;
      if (!items || !items.length) return res.status(500).json({ ok: false, error: FAIL });
    }

    // Upsert the current draft: overwrite an existing draft, else insert a new one
    // (a completed session leaves its agenda untouched and starts a fresh draft).
    const existing = await getJson(`${SB_URL}/rest/v1/supervision_agendas?relationship_id=eq.${encodeURIComponent(relId)}&select=id,status&order=created_at.desc&limit=1`);
    const latest = (Array.isArray(existing) && existing[0]) || null;

    let agenda = null;
    if (latest && latest.status === 'draft') {
      const upd = await fetch(`${SB_URL}/rest/v1/supervision_agendas?id=eq.${encodeURIComponent(latest.id)}`, {
        method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }),
        body: JSON.stringify({ items, snapshot_id: snapshotId }),
      });
      if (!upd.ok) { const t = await upd.text().catch(() => ''); console.error('[generate-agenda] update', upd.status, t.slice(0, 200)); return res.status(500).json({ ok: false, error: FAIL }); }
      agenda = (await upd.json().catch(() => []))[0];
    } else {
      const ins = await fetch(`${SB_URL}/rest/v1/supervision_agendas`, {
        method: 'POST', headers: sbHeaders({ Prefer: 'return=representation' }),
        body: JSON.stringify({ relationship_id: relId, supervisor_id: me, supervisee_id: superviseeId, snapshot_id: snapshotId, items, status: 'draft' }),
      });
      if (!ins.ok) { const t = await ins.text().catch(() => ''); console.error('[generate-agenda] insert', ins.status, t.slice(0, 200)); return res.status(500).json({ ok: false, error: FAIL }); }
      agenda = (await ins.json().catch(() => []))[0];
    }

    return res.status(200).json({ ok: true, agenda });
  } catch (e) {
    console.error('[generate-agenda]', e && e.message);
    return res.status(500).json({ ok: false, error: FAIL });
  }
}
