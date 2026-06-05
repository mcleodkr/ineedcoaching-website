// Client-facing session notes — service role, JWT-gated, column-restricted.
//
// Why this exists: coach_session_notes has a client SELECT policy
// (client_reads_own_session_notes). RLS is row-level, so a logged-in client
// could SELECT * on their own rows and read coach-only columns in the raw
// network response (post_session_analysis, raw_transcript, extraction_data,
// synthesis_data, coaching_signals, dna_manifestations, pre_session_intelligence,
// structured_notes, homework drafts). This endpoint is the only client read
// path: it verifies the caller's Supabase JWT, scopes to that email's own rows,
// and returns ONLY client-safe values. Step 2 drops the direct client policy.
//
// Client-safe output per session — nothing else ever leaves the server:
//   id, booking_id, client_email, created_at
//   client_summary  — the stored Phase 2a object when present; otherwise an
//                     equivalent DERIVED server-side from post_session_analysis
//                     (same safe extraction the browser used to do, so pre-2a
//                     sessions keep working with no regression and no backfill).
//   notes           — only when share_with_client = true, else null.
//   growth_dimensions — names of the growth bars this session matched, computed
//                     server-side from coaching_interventions[].dna_tag. Raw
//                     coach tags never leave the server — only the derived names.
//   continuity_phrase — finished, client-voiced "what's becoming stronger" line.
//
// post_session_analysis is read server-side for derivation but NEVER returned.

// ── Safe-derivation helpers (ported from the old client-side logic so the
//    client-visible output is unchanged, just computed behind the trust
//    boundary). Pure functions, module scope. ─────────────────────────────

// Rewrite coach-facing third-person into client-facing second person. Coach
// Clarity writes about "the client" / "she" / "they"; the client reads this on
// their dashboard, so pronouns are rewritten before anything is returned.
function toClientVoice(raw) {
  if (raw == null) return '';
  let s = String(raw);
  s = s.replace(/\bThe client\b/g, 'You');
  s = s.replace(/\bthe client\b/g, 'you');
  s = s.replace(/\bA client\b/g, 'You');
  s = s.replace(/\ba client\b/g, 'you');
  s = s.replace(/\bClient\b/g, 'You');
  s = s.replace(/\bclient\b/g, 'you');
  s = s.replace(/\bShe\b/g, 'You');
  s = s.replace(/\bshe\b/g, 'you');
  s = s.replace(/\bHe\b/g, 'You');
  s = s.replace(/\bhe\b/g, 'you');
  s = s.replace(/\bHer\b/g, 'Your');
  s = s.replace(/\bher\b/g, 'your');
  s = s.replace(/\bHis\b/g, 'Your');
  s = s.replace(/\bhis\b/g, 'your');
  s = s.replace(/\bHim\b/g, 'You');
  s = s.replace(/\bhim\b/g, 'you');
  s = s.replace(/\bThey\b/g, 'You');
  s = s.replace(/\bthey\b/g, 'you');
  s = s.replace(/\bThem\b/g, 'You');
  s = s.replace(/\bthem\b/g, 'you');
  s = s.replace(/\bTheir\b/g, 'Your');
  s = s.replace(/\btheir\b/g, 'your');
  s = s.replace(/\bherself\b/gi, 'yourself');
  s = s.replace(/\bhimself\b/gi, 'yourself');
  s = s.replace(/\bthemselves\b/gi, 'yourself');
  s = s.replace(/\bYou is\b/g, 'You are');
  s = s.replace(/\byou is\b/g, 'you are');
  s = s.replace(/\bYou was\b/g, 'You were');
  s = s.replace(/\byou was\b/g, 'you were');
  s = s.replace(/\bYou has\b/g, 'You have');
  s = s.replace(/\byou has\b/g, 'you have');
  s = s.replace(/\bYou does\b/g, 'You do');
  s = s.replace(/\byou does\b/g, 'you do');
  return s;
}

function normTag(t) {
  return String(t || '').toLowerCase().trim().replace(/[\s_]+/g, '-');
}

// Growth dimensions — display name → matching dna_tag signal set. Signal sets
// live here (server) so raw tags never reach the browser; the endpoint returns
// only the matched dimension names.
const GROWTH_DIMENSIONS = [
  { name: 'Self-trust', signals: ['self-efficacy-building', 'self-trust'] },
  { name: 'Follow-through', signals: ['behavioral-transfer', 'behavioral-activation'] },
  { name: 'Clarity', signals: ['identity-shift', 'insight-to-action-bridge'] },
  { name: 'Naming what is true', signals: ['suppressed-conviction', 'visibility-avoidance'] },
];

function growthDimensionsForAnalysis(a) {
  if (!a || typeof a !== 'object') return [];
  const interventions = Array.isArray(a.coaching_interventions) ? a.coaching_interventions : [];
  const present = new Set();
  for (const ci of interventions) {
    const tags = ci && Array.isArray(ci.dna_tag) ? ci.dna_tag : [];
    for (const tag of tags) present.add(normTag(tag));
  }
  const matched = [];
  for (const dim of GROWTH_DIMENSIONS) {
    if (dim.signals.some((sig) => present.has(normTag(sig)))) matched.push(dim.name);
  }
  return matched;
}

// Client-safe goals touched this session (titles + relevance). Goal titles are
// the client's own goals — safe to surface. Used for both the per-session view
// and the cross-session "sessions per goal" count.
function goalsFromAnalysis(a) {
  if (!a || typeof a !== 'object') return [];
  let goalsArr = [];
  if (a.goals && typeof a.goals === 'object' && Array.isArray(a.goals.existing)) goalsArr = a.goals.existing;
  else if (Array.isArray(a.goal_review)) goalsArr = a.goal_review;
  const goals = [];
  for (const g of goalsArr) {
    if (!g || typeof g !== 'object') continue;
    const title = g.title || g.goal_title || '';
    if (!title) continue;
    goals.push({ title: toClientVoice(title), relevance: toClientVoice(g.session_relevance || '') });
  }
  return goals;
}

// Derive a client_summary-shaped object from the coach analysis blob, applying
// the same safe extraction + voicing + clinical-leak guard the browser used.
// Returns null if nothing safe can be derived.
function deriveClientSummary(a) {
  if (!a || typeof a !== 'object') return null;

  // recap — prefer session_in_one_line (string), else core_focus.summary.
  const oneLine = typeof a.session_in_one_line === 'string' ? a.session_in_one_line : '';
  const coreSummary = (a.core_focus && typeof a.core_focus.summary === 'string') ? a.core_focus.summary : '';
  const recap = toClientVoice((oneLine || coreSummary).trim());

  // what_stood_out — patterns_and_your_role[0].what_this_means, guarded.
  let whatStoodOut = '';
  if (Array.isArray(a.patterns_and_your_role) && a.patterns_and_your_role.length > 0) {
    const first = a.patterns_and_your_role[0];
    if (first && typeof first.what_this_means === 'string') {
      let transformed = toClientVoice(first.what_this_means);
      const clinicalSignals = /\b(pattern is visible|loses its grip|coaching move|coach analysis|intervention|framework|dysregulat|maladaptive|the coach)\b/i;
      if (clinicalSignals.test(transformed)) {
        transformed = 'Something shifted in this session that is worth sitting with.';
      }
      whatStoodOut = transformed;
    }
  }

  // practice — between_session[].invitation (or .title), strip passive prefixes.
  const between = Array.isArray(a.between_session) ? a.between_session
    : (Array.isArray(a.between_session_practices) ? a.between_session_practices : []);
  const practice = [];
  for (const b of between) {
    let t = '';
    if (typeof b === 'string') t = b;
    else if (b && typeof b === 'object') t = b.invitation || b.title || '';
    if (!t) continue;
    let text = toClientVoice(t)
      .replace(/^\s*[Yy]ou\s+(might|may|could)\s+(consider\s+|try\s+to\s+|try\s+)?/i, '');
    if (text.length > 0) text = text.charAt(0).toUpperCase() + text.slice(1);
    if (text) practice.push(text);
  }

  // commitments — commitments[].text (or .commitment / string).
  const rawCommit = Array.isArray(a.commitments) ? a.commitments
    : (Array.isArray(a.client_commitments) ? a.client_commitments : []);
  const commitments = [];
  for (const c of rawCommit) {
    let t = '';
    if (typeof c === 'string') t = c;
    else if (c && typeof c === 'object') t = c.title || c.commitment || c.text || '';
    if (t) commitments.push(toClientVoice(t));
  }

  // goals — goals.existing[] or goal_review[].
  const goals = goalsFromAnalysis(a);

  if (!recap && !whatStoodOut && practice.length === 0 && commitments.length === 0 && goals.length === 0) {
    return null;
  }
  return { recap, what_stood_out: whatStoodOut, practice, commitments, goals };
}

// "What's becoming stronger" — pick one complete, client-voiced sentence.
// Ported verbatim from the old renderProgressAndContinuity browser logic.
const INCOMPLETE_TAILS = /^(and|but|because|that|which|so|or|to|of|in|with|for|a|an|the|on|at|by|from|as|if|when|while|about|have|has|had|is|are|was|were|be|been|being)$/i;
const FINITE_VERBS = /^(stopped|stood|left|went|came|saw|said|told|noticed|decided|realized|recognized|learned|began|started|felt|found|knew|chose|made|took|gave|brought|got|had|did|was|were|became|built|spoke|wrote)$/i;

function continuityPhrase(clientSummaryObj, a) {
  let rawSource = '';
  if (clientSummaryObj && typeof clientSummaryObj.headline === 'string' && clientSummaryObj.headline) {
    rawSource = clientSummaryObj.headline;
  } else if (a && typeof a.session_in_one_line === 'string' && a.session_in_one_line) {
    rawSource = a.session_in_one_line;
  } else if (a && a.core_focus && typeof a.core_focus.summary === 'string') {
    rawSource = a.core_focus.summary;
  } else if (clientSummaryObj && typeof clientSummaryObj.recap === 'string') {
    rawSource = clientSummaryObj.recap;
  }
  if (!rawSource) return null;

  const source = toClientVoice(String(rawSource).trim());
  if (!source) return null;

  const sentences = source.split(/(?<=[.!?])\s+/);
  let picked = null;
  for (const sentence of sentences) {
    const s = sentence.trim().replace(/^[\s\-–—,;:]+/, '').replace(/\s+/g, ' ');
    if (!s) continue;
    const wc = s.split(/\s+/).length;
    if (wc < 4 || wc > 14) continue;
    if (!/[.!?]$/.test(s)) continue;
    const lastWord = s.replace(/[.!?]$/, '').split(/\s+/).pop() || '';
    if (INCOMPLETE_TAILS.test(lastWord)) continue;
    picked = s;
    break;
  }
  if (!picked) {
    const words = source.split(/\s+/);
    if (words.length >= 4 && words.length <= 12 && !INCOMPLETE_TAILS.test(words[words.length - 1])) {
      const hasMidConj = /\b(and|but|because|that|which|so)\b/i.test(words.slice(0, -1).join(' '));
      if (!hasMidConj) {
        let candidate = words.join(' ').replace(/[,;:\-–—]\s*$/, '').trim();
        if (!/[.!?]$/.test(candidate)) candidate += '.';
        picked = candidate;
      }
    }
  }
  if (!picked) return null;

  const firstWord = picked.split(/\s+/)[0].toLowerCase();
  if (firstWord === 'i' || firstWord === 'we') return null;
  if (firstWord === 'you' || firstWord === 'your' || firstWord === "you're") {
    return picked.charAt(0).toUpperCase() + picked.slice(1);
  }
  if (FINITE_VERBS.test(firstWord)) {
    return picked.charAt(0).toUpperCase() + picked.slice(1);
  }
  return 'You are ' + picked.charAt(0).toLowerCase() + picked.slice(1);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, apikey');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  // ── Auth: verify the caller's Supabase JWT and use ITS email. Never trust a
  //    client-supplied email param. ────────────────────────────────────────
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let email = '';
  try {
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token },
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Unauthorized' });
    const userData = await userRes.json().catch(() => ({}));
    email = (userData && userData.email || '').trim().toLowerCase();
  } catch (authErr) {
    console.error('[client-session-notes] auth verification failed', authErr && authErr.message);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!email) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const readHeaders = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
    const bookingId = (req.query && (req.query.booking_id || req.query.bookingId)) || '';

    // Service-role read scoped to the verified email. post_session_analysis is
    // selected for server-side derivation only — it is never returned.
    let url = `${SUPABASE_URL}/rest/v1/coach_session_notes`
      + `?client_email=eq.${encodeURIComponent(email)}`
      + `&select=id,booking_id,client_email,created_at,client_summary,notes,share_with_client,post_session_analysis`
      + `&order=created_at.desc`;
    if (bookingId) url += `&booking_id=eq.${encodeURIComponent(bookingId)}`;

    const rowsRes = await fetch(url, { headers: readHeaders });
    if (!rowsRes.ok) {
      const errBody = await rowsRes.text().catch(() => '');
      console.error('[client-session-notes] read failed', rowsRes.status, errBody.slice(0, 300));
      return res.status(502).json({ error: 'Failed to load sessions' });
    }
    const rows = await rowsRes.json();
    const safeRows = Array.isArray(rows) ? rows : [];

    const sessions = safeRows.map((row) => {
      const analysis = (row && row.post_session_analysis && typeof row.post_session_analysis === 'object')
        ? row.post_session_analysis : null;
      const storedSummary = (row && row.client_summary && typeof row.client_summary === 'object')
        ? row.client_summary : null;
      let clientSummary = storedSummary || deriveClientSummary(analysis);
      // Always carry client-safe goal titles. A stored Phase 2a summary has no
      // goals field; attach them (derived summaries already include goals).
      if (clientSummary && !Array.isArray(clientSummary.goals)) {
        clientSummary = { ...clientSummary, goals: goalsFromAnalysis(analysis) };
      }

      return {
        id: row.id,
        booking_id: row.booking_id,
        client_email: row.client_email,
        created_at: row.created_at,
        client_summary: clientSummary,
        notes: (row.share_with_client === true && typeof row.notes === 'string') ? row.notes : null,
        growth_dimensions: growthDimensionsForAnalysis(analysis),
        continuity_phrase: continuityPhrase(clientSummary, analysis),
      };
    });

    return res.status(200).json({ sessions });
  } catch (e) {
    console.error('[client-session-notes] Error:', e && e.message);
    return res.status(500).json({ error: 'Failed to load sessions' });
  }
}
