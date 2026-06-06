// Client-safe session projection — the single source of truth for turning a
// coach_session_notes row into the client-facing summary. Used by both
// api/client-session-notes.js (the client dashboard read path) and
// api/post-session-email.js (the post-session email), so the email and the
// dashboard always show the same curated, client-safe recap. Never read raw
// post_session_analysis fields outside this module.
//
// Content boundary (load-bearing): the output exposes only curated/derived
// client-safe fields. Coach-only analysis — pattern names, strategic_direction,
// missed_windows, coaching_interventions, diagnostic framing — never appears.

// Rewrite coach-facing third-person into client-facing second person. Coach
// Clarity writes about "the client" / "she" / "they"; the client reads this, so
// pronouns are rewritten before anything is surfaced.
export function toClientVoice(raw) {
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

// Client-safe goal titles touched this session (titles + relevance). Goal
// titles are the client's own goals — safe to surface.
export function goalsFromAnalysis(a) {
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
// the same safe extraction + voicing + clinical-leak guard. Returns null if
// nothing safe can be derived. Note: a derived summary has no headline/closing
// (those exist only on the stored Phase 2a object) — callers must degrade
// gracefully when those are absent.
export function deriveClientSummary(a) {
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

  const goals = goalsFromAnalysis(a);

  if (!recap && !whatStoodOut && practice.length === 0 && commitments.length === 0 && goals.length === 0) {
    return null;
  }
  return { recap, what_stood_out: whatStoodOut, practice, commitments, goals };
}

// The single decision the dashboard and the email share: use the stored
// Phase 2a client_summary when present, otherwise safe-derive from the coach
// analysis. Always carries client-safe goal titles (a stored summary has no
// goals field). Returns the client_summary object or null.
export function buildClientSummary(storedSummary, analysis) {
  const stored = (storedSummary && typeof storedSummary === 'object') ? storedSummary : null;
  let clientSummary = stored || deriveClientSummary(analysis);
  if (clientSummary && !Array.isArray(clientSummary.goals)) {
    clientSummary = { ...clientSummary, goals: goalsFromAnalysis(analysis) };
  }
  return clientSummary;
}
