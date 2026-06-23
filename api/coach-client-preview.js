// Coach-side "Preview Client Experience" — read-only, client-safe projection.
//
// The coach is authenticated as THEMSELVES (not the client). This endpoint takes
// the client identifier explicitly, verifies the requesting coach owns an ACTIVE
// coaching relationship to that client (coach_clients), and then returns ONLY the
// client-facing content the client's own dashboard would show — using the same
// client-safe field discipline as api/client-session-notes.js. It never returns
// raw coach_session_notes rows or any of the nine coach-only columns
// (post_session_analysis, raw_transcript, extraction_data, synthesis_data,
// coaching_signals, dna_manifestations, pre_session_intelligence, structured_notes,
// homework drafts), and never touches journal / AI companion / coach-intelligence.
//
// Scope mirrors what client-dashboard.html actually renders today:
//   sessions (bookings + client-safe recap), goals, homework (status=assigned),
//   check-ins (status only — no reflection bodies), courses (enrollments).
import { buildClientSummary, toClientVoice } from '../lib/client-session-projection.js';

// ── Growth dimensions + continuity phrase ───────────────────────────────────
// Duplicated (pure) from api/client-session-notes.js on purpose: keeping them
// here means the live client read path is not modified by this feature. Signal
// sets stay server-side; only derived names/phrases ever leave.
function normTag(t) {
  return String(t || '').toLowerCase().trim().replace(/[\s_]+/g, '-');
}
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

async function sb(url, key) {
  const r = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`read ${r.status} ${t.slice(0, 200)}`);
  }
  return r.json();
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

  // ── Auth: verify the COACH's JWT and use ITS email. Never trust a body/param. ──
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let coachEmail = '';
  try {
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token },
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Unauthorized' });
    const userData = await userRes.json().catch(() => ({}));
    coachEmail = (userData && userData.email || '').trim().toLowerCase();
  } catch (authErr) {
    console.error('[coach-client-preview] auth failed', authErr && authErr.message);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!coachEmail) return res.status(401).json({ error: 'Unauthorized' });

  const clientEmail = ((req.query && req.query.client_email) || '').toString().trim().toLowerCase();
  if (!clientEmail) return res.status(400).json({ error: 'Missing client_email' });

  try {
    const enc = encodeURIComponent;
    // Resolve coach_profiles.id from the verified coach email.
    const coachRows = await sb(
      `${SUPABASE_URL}/rest/v1/coach_profiles?user_email=eq.${enc(coachEmail)}&select=id&limit=1`,
      SUPABASE_KEY,
    );
    const coachId = Array.isArray(coachRows) && coachRows[0] && coachRows[0].id;
    if (!coachId) return res.status(403).json({ error: 'Not a coach' });

    // ── Ownership gate: an ACTIVE coach_clients link to this client. ──
    const links = await sb(
      `${SUPABASE_URL}/rest/v1/coach_clients`
        + `?coach_id=eq.${enc(coachId)}&client_email=ilike.${enc(clientEmail)}`
        + `&status=eq.active&select=id&limit=1`,
      SUPABASE_KEY,
    );
    if (!Array.isArray(links) || links.length === 0) {
      return res.status(403).json({ error: 'No active coaching relationship with this client' });
    }

    // ── Client-safe reads (mirror client-dashboard.html), scoped coach_id+client_email. ──
    const [notes, bookings, goals, homework, checkins, enrollments] = await Promise.all([
      sb(`${SUPABASE_URL}/rest/v1/coach_session_notes?coach_id=eq.${enc(coachId)}&client_email=eq.${enc(clientEmail)}`
        + `&select=id,booking_id,client_email,created_at,client_summary,notes,share_with_client,post_session_analysis`
        + `&order=created_at.desc`, SUPABASE_KEY),
      sb(`${SUPABASE_URL}/rest/v1/coach_bookings?coach_id=eq.${enc(coachId)}&client_email=eq.${enc(clientEmail)}`
        + `&select=id,status,scheduled_at,created_at&order=scheduled_at.desc`, SUPABASE_KEY),
      sb(`${SUPABASE_URL}/rest/v1/coach_goals?client_email=eq.${enc(clientEmail)}`
        + `&select=id,title,description,status,progress_marker,target_date,completed_by,created_at`
        + `&order=created_at.desc`, SUPABASE_KEY),
      sb(`${SUPABASE_URL}/rest/v1/client_homework?client_email=eq.${enc(clientEmail)}&status=eq.assigned`
        + `&select=id,assignment_text,type,status,completed,completed_at,shared_with_coach,created_at`
        + `&order=created_at.desc`, SUPABASE_KEY),
      // explorer_checkins rows are completed submissions; select only the
      // non-reflection fields (id, created_at). mood/one_word/pattern_response are
      // client reflections and are deliberately never selected.
      sb(`${SUPABASE_URL}/rest/v1/explorer_checkins?user_email=eq.${enc(clientEmail)}`
        + `&select=id,created_at&order=created_at.desc`, SUPABASE_KEY),
      sb(`${SUPABASE_URL}/rest/v1/coach_course_enrollments?student_email=eq.${enc(clientEmail)}`
        + `&select=id,enrolled_at,completed_at,course_id,coach_courses(id,title,status)`
        + `&order=enrolled_at.desc`, SUPABASE_KEY),
    ]);

    // Sessions: client-safe summary per note. post_session_analysis is used for
    // derivation ONLY and never returned.
    const safeNotes = Array.isArray(notes) ? notes : [];
    const summaryByBooking = {};
    const sessions = safeNotes.map((row) => {
      const analysis = (row && row.post_session_analysis && typeof row.post_session_analysis === 'object')
        ? row.post_session_analysis : null;
      const stored = (row && row.client_summary && typeof row.client_summary === 'object')
        ? row.client_summary : null;
      const clientSummary = buildClientSummary(stored, analysis);
      if (row.booking_id) summaryByBooking[row.booking_id] = clientSummary;
      return {
        id: row.id,
        booking_id: row.booking_id,
        created_at: row.created_at,
        client_summary: clientSummary,
        notes: (row.share_with_client === true && typeof row.notes === 'string') ? row.notes : null,
        growth_dimensions: growthDimensionsForAnalysis(analysis),
        continuity_phrase: continuityPhrase(clientSummary, analysis),
      };
    });

    // Sessions list (bookings) annotated with whether a client-safe recap exists.
    const safeBookings = (Array.isArray(bookings) ? bookings : []).map((b) => ({
      id: b.id,
      status: b.status,
      scheduled_at: b.scheduled_at,
      created_at: b.created_at,
      has_summary: !!summaryByBooking[b.id],
    }));

    // Check-ins: each row is a completed submission. Surface only the date —
    // never the reflection bodies (mood/one_word/pattern_response).
    const safeCheckins = (Array.isArray(checkins) ? checkins : []).map((c) => ({
      id: c.id,
      status: 'completed',
      completed_at: c.created_at || null,
      created_at: c.created_at || null,
    }));

    const safeCourses = (Array.isArray(enrollments) ? enrollments : []).map((e) => {
      const course = e && e.coach_courses && typeof e.coach_courses === 'object' ? e.coach_courses : null;
      return {
        enrollment_id: e.id,
        title: course ? course.title : null,
        status: course ? course.status : null,
        enrolled_at: e.enrolled_at || null,
        completed_at: e.completed_at || null,
      };
    });

    return res.status(200).json({
      client_email: clientEmail,
      sessions,
      bookings: safeBookings,
      goals: Array.isArray(goals) ? goals : [],
      homework: Array.isArray(homework) ? homework : [],
      checkins: safeCheckins,
      courses: safeCourses,
    });
  } catch (e) {
    console.error('[coach-client-preview] Error:', e && e.message);
    return res.status(500).json({ error: 'Failed to load preview' });
  }
}
