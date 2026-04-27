// GET /api/coach-dna-timeline?coachId=...&days=...
// Aggregates pattern frequency over a rolling window from coach_session_notes.synthesis_data
// and compares it to the prior-equivalent window. Returns three classified buckets:
// emerging / stable / declining. No Claude calls — pure SQL + JS aggregation.
//
// v1 source: coaching_interventions[].technique_name BASE CATEGORY (the segment
// before the parenthetical refinement). Why not patterns_and_your_role.pattern_name?
// Because pattern_name is free-form per-session prose ("Anchor at All Costs",
// "Permission Deficit") and never repeats across sessions, so frequency counts
// stay at 1 forever. technique_name is constrained by prompt to a bounded vocab
// (Confrontation, Cognitive Reframe, Activation Prompt, …) with optional
// "(Refinement)" — the base category is what actually accumulates over time.
// v2 will add a Claude clustering pass to surface evolution at the bias-pattern
// level (matching the example output in the original spec).

const NORMALIZE_WS = /\s+/g;
const MIN_OCCURRENCE = 2;          // ignore patterns mentioned in only 1 session across both windows
const STATUS_RATIO = 0.4;          // emerging/declining trigger when ratio < this
const STATUS_FLOOR = 3;            // need at least this many sessions in the dominant window

function classify(prev, curr) {
  if (curr >= STATUS_FLOOR && prev / Math.max(curr, 1) < STATUS_RATIO) return 'emerging';
  if (prev >= STATUS_FLOOR && curr / Math.max(prev, 1) < STATUS_RATIO) return 'declining';
  return 'stable';
}

// Pulls the BASE category from technique_name (everything before " (Refinement)").
// "Confrontation (Authority Alignment)" → "Confrontation". A session contributes
// at most one count per base category, even if multiple refinements of the same
// category appeared in that session — frequency is "how many sessions used this
// technique family", not "how many times did the model name it".
function extractPatternKeys(synth) {
  if (!synth || !Array.isArray(synth.coaching_interventions)) return [];
  const seen = new Set();
  const out = [];
  for (const item of synth.coaching_interventions) {
    const raw = (item && typeof item.technique_name === 'string') ? item.technique_name : '';
    if (!raw) continue;
    // Strip parenthetical refinement and surrounding whitespace.
    const baseRaw = raw.split(' (')[0].trim();
    if (!baseRaw) continue;
    const norm = baseRaw.toLowerCase().replace(NORMALIZE_WS, ' ').trim();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ key: norm, display: baseRaw });
  }
  return out;
}

function countAcross(rows) {
  const counts = new Map();
  for (const row of rows) {
    const patterns = extractPatternKeys(row.synthesis_data);
    for (const p of patterns) {
      if (!counts.has(p.key)) counts.set(p.key, { key: p.key, display: p.display, count: 0 });
      counts.get(p.key).count += 1;
    }
  }
  return counts;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  const coachId = String(req.query.coachId || req.query.coach_id || '');
  const daysRaw = parseInt(req.query.days || '180', 10);
  const days = Number.isFinite(daysRaw) && daysRaw >= 7 && daysRaw <= 3650 ? daysRaw : 180;
  if (!coachId) return res.status(400).json({ error: 'Missing coachId' });

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
  };

  const nowMs = Date.now();
  const winStartMs = nowMs - days * 86400000;
  const priorStartMs = nowMs - 2 * days * 86400000;
  const winStart = new Date(winStartMs).toISOString();
  const priorStart = new Date(priorStartMs).toISOString();
  const winEnd = new Date(nowMs).toISOString();

  try {
    // Pull both windows in one query, bucket in JS.
    const url = `${SUPABASE_URL}/rest/v1/coach_session_notes`
      + `?coach_id=eq.${encodeURIComponent(coachId)}`
      + `&created_at=gte.${encodeURIComponent(priorStart)}`
      + `&synthesis_data=not.is.null`
      + `&select=created_at,synthesis_data`
      + `&order=created_at.asc`;
    const r = await fetch(url, { headers });
    if (!r.ok) {
      const detail = await r.text();
      return res.status(500).json({ error: 'supabase_error', status: r.status, detail });
    }
    const rows = await r.json();

    const currRows = [];
    const prevRows = [];
    for (const row of rows) {
      const t = new Date(row.created_at).getTime();
      if (t >= winStartMs) currRows.push(row);
      else prevRows.push(row);
    }

    // Empty-state: not enough sessions to surface evolution meaningfully.
    if (currRows.length < 4) {
      return res.status(200).json({
        window: { days, start: winStart, end: winEnd, session_count: currRows.length },
        prior: { days, start: priorStart, end: winStart, session_count: prevRows.length },
        patterns: [],
        empty_state: 'needs_more_sessions',
        empty_state_message: 'Coach Clarity needs at least 4 sessions in this window to surface evolution. Keep coaching — patterns will emerge.',
      });
    }

    const currCounts = countAcross(currRows);
    const prevCounts = countAcross(prevRows);

    const keys = new Set([...currCounts.keys(), ...prevCounts.keys()]);
    const patterns = [];
    for (const key of keys) {
      const c = currCounts.get(key);
      const p = prevCounts.get(key);
      const curr = c ? c.count : 0;
      const prev = p ? p.count : 0;
      // Drop noise: a pattern only worth surfacing if it shows up at least twice
      // in either window (single mentions are too easily LLM phrasing variation).
      if (curr < MIN_OCCURRENCE && prev < MIN_OCCURRENCE) continue;
      const display_name = (c && c.display) || (p && p.display) || key;
      patterns.push({
        key,
        display_name,
        prev_count: prev,
        curr_count: curr,
        status: classify(prev, curr),
      });
    }

    const order = { emerging: 0, stable: 1, declining: 2 };
    patterns.sort((a, b) => {
      if (a.status !== b.status) return (order[a.status] ?? 9) - (order[b.status] ?? 9);
      if (a.status === 'stable') return b.curr_count - a.curr_count;
      const ad = Math.abs(a.curr_count - a.prev_count);
      const bd = Math.abs(b.curr_count - b.prev_count);
      return bd - ad;
    });

    return res.status(200).json({
      window: { days, start: winStart, end: winEnd, session_count: currRows.length },
      prior: { days, start: priorStart, end: winStart, session_count: prevRows.length },
      patterns,
    });
  } catch (e) {
    console.error('[coach-dna-timeline] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
