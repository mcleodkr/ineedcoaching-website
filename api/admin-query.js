// ADMIN DASHBOARD NOTE: Admin email list is hardcoded for MVP. Move to role-based system before scaling.
// Server-side admin query proxy. The service role key NEVER leaves this file.
// POST { sessionAccessToken, query: { kind, ...args } }
// Verifies caller via Supabase auth, checks admin allowlist, then runs typed queries.

const ADMIN_EMAILS = ['drkmcleod@gmail.com', 'creativeenergytx@gmail.com'];
const MAX_ROWS = 500;
const MRR_PER_COACH = 47;

export default async function handler(req, res) {
  // Same-origin only — rely on Vercel routing; no wildcard CORS here.
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SERVICE_KEY) {
    console.error('[admin-query] SUPABASE_SERVICE_ROLE_KEY not set');
    return res.status(500).json({ error: 'Server not configured' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  const { sessionAccessToken, query } = body || {};
  if (!sessionAccessToken || !query || !query.kind) {
    return res.status(400).json({ error: 'Missing sessionAccessToken or query.kind' });
  }

  // --- 1. Verify caller identity via Supabase auth ---
  let callerEmail = null;
  try {
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${sessionAccessToken}`,
      },
    });
    if (!authRes.ok) {
      return res.status(401).json({ error: 'Invalid session' });
    }
    const user = await authRes.json();
    callerEmail = (user.email || '').toLowerCase();
  } catch (e) {
    console.error('[admin-query] auth check failed:', e.message);
    return res.status(401).json({ error: 'Auth check failed' });
  }

  if (!ADMIN_EMAILS.includes(callerEmail)) {
    return res.status(401).json({ error: 'Not authorized' });
  }

  // --- 2. Dispatch typed query ---
  const sb = makeSupabaseClient(SUPABASE_URL, SERVICE_KEY);
  try {
    switch (query.kind) {
      case 'overview-stats':
        return res.status(200).json({ success: true, data: await overviewStats(sb) });
      case 'attention-needed':
        return res.status(200).json({ success: true, data: await attentionNeeded(sb) });
      case 'recent-activity':
        return res.status(200).json({ success: true, data: await recentActivity(sb) });
      case 'errors-logs':
        return res.status(200).json({ success: true, data: await errorsAndLogs(sb) });
      case 'coaches-list':
        return res.status(200).json({ success: true, data: await coachesList(sb) });
      case 'clients-list':
        return res.status(200).json({ success: true, data: await clientsList(sb) });
      case 'sessions-list':
        return res.status(200).json({ success: true, data: await sessionsList(sb) });
      case 'revenue':
        return res.status(200).json({ success: true, data: await revenue(sb) });
      case 'toggle-published': {
        const { coachId, isPublished } = query;
        if (!coachId || typeof isPublished !== 'boolean') {
          return res.status(400).json({ error: 'coachId and isPublished required' });
        }
        await sb.patch('coach_profiles', `id=eq.${encodeURIComponent(coachId)}`, { is_published: isPublished });
        return res.status(200).json({ success: true });
      }
      case 'rerun-clarity': {
        const { bookingId } = query;
        if (!bookingId) return res.status(400).json({ error: 'bookingId required' });
        const rows = await sb.get(`coach_session_notes?booking_id=eq.${encodeURIComponent(bookingId)}&select=coach_id,client_email,booking_id&limit=1`);
        if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
        const { coach_id, client_email } = rows[0];
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const triggerUrl = `${proto}://${host}/api/generate-post-session-intelligence`;
        const triggerRes = await fetch(triggerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ coachId: coach_id, clientEmail: client_email, bookingId, existingGoals: [] }),
        });
        const ok = triggerRes.ok;
        const detail = await triggerRes.text().catch(() => '');
        return res.status(ok ? 200 : 500).json({ success: ok, detail: detail.slice(0, 500) });
      }
      default:
        return res.status(400).json({ error: `Unknown query kind: ${query.kind}` });
    }
  } catch (e) {
    console.error('[admin-query] query failed:', query.kind, e.message);
    return res.status(500).json({ error: e.message || 'Query failed' });
  }
}

// --- Supabase REST helper ---
function makeSupabaseClient(url, key) {
  const headers = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  async function get(path) {
    const res = await fetch(`${url}/rest/v1/${path}`, { headers });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
    return res.json();
  }
  async function count(table, filter) {
    const q = filter ? `${table}?${filter}&select=id` : `${table}?select=id`;
    const res = await fetch(`${url}/rest/v1/${q}`, {
      headers: { ...headers, 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': '0-0' },
    });
    if (!res.ok) throw new Error(`COUNT ${table} failed: ${res.status}`);
    const cr = res.headers.get('content-range') || '';
    const total = parseInt(cr.split('/')[1], 10);
    return Number.isFinite(total) ? total : 0;
  }
  async function patch(table, filter, payload) {
    const res = await fetch(`${url}/rest/v1/${table}?${filter}`, {
      method: 'PATCH', headers, body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`PATCH ${table} failed: ${res.status}`);
    return true;
  }
  return { get, count, patch };
}

function startOfMonthISO() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}
function daysAgoISO(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

// --- Query implementations ---

async function overviewStats(sb) {
  const somISO = startOfMonthISO();
  const [
    totalCoaches,
    totalClients,
    sessionsThisMonth,
    clarityRunsThisMonth,
    publishedCount,
    aiUsageThisMonth,
  ] = await Promise.all([
    sb.count('coach_profiles'),
    sb.count('explorer_profiles'),
    sb.count('coach_bookings', `scheduled_at=gte.${somISO}`),
    sb.count('coach_session_notes', `post_session_analysis=not.is.null&created_at=gte.${somISO}`),
    sb.count('coach_profiles', `is_published=eq.true`),
    sb.get(`coach_ai_usage_log?select=estimated_cost_cents,created_at&created_at=gte.${somISO}&limit=${MAX_ROWS}`).catch(() => []),
  ]);
  const aiUsageRows = Array.isArray(aiUsageThisMonth) ? aiUsageThisMonth : [];
  const estimatedAiCostThisMonth = aiUsageRows.reduce((sum, r) => sum + (Number(r && r.estimated_cost_cents) || 0), 0) / 100;
  
  const usageRows = await sb.get(`coach_clarity_usage?select=is_regeneration,created_at&created_at=gte.${somISO}&limit=${MAX_ROWS}`).catch(() => []);
  const regenerationsThisMonth = (Array.isArray(usageRows) ? usageRows : []).filter(r => r && r.is_regeneration).length;
  
  return {
    totalCoaches,
    totalClients,
    sessionsThisMonth,
    clarityRunsThisMonth,
    regenerationsThisMonth,
    estimatedAiCostThisMonth: Number(estimatedAiCostThisMonth.toFixed(2)),
    publishedCount,
    estimatedMrr: publishedCount * MRR_PER_COACH,
  };
}

async function fetchAllUsage(sb) {
  try {
    return await sb.get(`coach_clarity_usage?select=session_id,coach_email,is_regeneration&limit=${MAX_ROWS}`);
  } catch (e) {
    console.error('[admin-query] fetchAllUsage failed:', e.message);
    return [];
  }
}

async function attentionNeeded(sb) {
  const now48hAgo = daysAgoISO(2);
  const [
    failedClarity,
    sessionsOld,
    inactive14List,
    zeroAfter7,
  ] = await Promise.all([
    sb.count('coach_session_notes', `post_session_analysis=is.null&raw_transcript=not.is.null`),
    sb.count('coach_bookings', `scheduled_at=lt.${now48hAgo}&status=eq.confirmed`),
    inactiveCoaches(sb, 14),
    zeroSessionsAfter7(sb),
  ]);
  return {
    failedClarity,
    sessionsMissingAnalysis: sessionsOld,
    coachesInactive14: inactive14List.length,
    coachesZeroSessions7: zeroAfter7.length,
  };
}

async function inactiveCoaches(sb, days) {
  const cutoff = daysAgoISO(days);
  const coaches = await sb.get(`coach_profiles?select=id,display_name,user_email,created_at&limit=${MAX_ROWS}`);
  const bookings = await sb.get(`coach_bookings?select=coach_id,scheduled_at&scheduled_at=gte.${cutoff}&limit=${MAX_ROWS}`);
  const notes = await sb.get(`coach_session_notes?select=coach_id,created_at&created_at=gte.${cutoff}&limit=${MAX_ROWS}`);
  const active = new Set([...bookings.map(b => b.coach_id), ...notes.map(n => n.coach_id)]);
  return coaches.filter(c => !active.has(c.id) && new Date(c.created_at) < new Date(cutoff));
}

async function zeroSessionsAfter7(sb) {
  const cutoff = daysAgoISO(7);
  const coaches = await sb.get(`coach_profiles?select=id,display_name,user_email,created_at&created_at=lt.${cutoff}&limit=${MAX_ROWS}`);
  const bookings = await sb.get(`coach_bookings?select=coach_id&limit=${MAX_ROWS}`);
  const withBookings = new Set(bookings.map(b => b.coach_id));
  return coaches.filter(c => !withBookings.has(c.id));
}

async function recentActivity(sb) {
  const [signups, sessions, analyses] = await Promise.all([
    sb.get(`coach_profiles?select=id,display_name,user_email,created_at&order=created_at.desc&limit=10`),
    sb.get(`coach_bookings?select=id,coach_id,client_email,scheduled_at,status&order=scheduled_at.desc&limit=10`),
    sb.get(`coach_session_notes?select=id,coach_id,client_email,booking_id,updated_at&post_session_analysis=not.is.null&order=updated_at.desc&limit=5`),
  ]);
  return { signups, sessions, analyses };
}

async function errorsAndLogs(sb) {
  const cutoff24 = daysAgoISO(1);
  const cutoff7 = daysAgoISO(7);
  const [failedClarity, missingAnalysis, quietProfiles] = await Promise.all([
    sb.get(`coach_session_notes?select=id,booking_id,coach_id,client_email,created_at&post_session_analysis=is.null&raw_transcript=not.is.null&order=created_at.desc&limit=100`),
    sb.get(`coach_bookings?select=id,coach_id,client_email,scheduled_at&scheduled_at=lt.${cutoff24}&status=eq.confirmed&order=scheduled_at.desc&limit=100`),
    sb.get(`explorer_profiles?select=id,email,display_name,created_at&created_at=gte.${cutoff7}&order=created_at.desc&limit=100`),
  ]);
  const coachIds = Array.from(new Set([...failedClarity.map(r => r.coach_id), ...missingAnalysis.map(r => r.coach_id)].filter(Boolean)));
  let coachMap = {};
  if (coachIds.length) {
    const idList = coachIds.map(id => `"${id}"`).join(',');
    const coaches = await sb.get(`coach_profiles?select=id,display_name,user_email&id=in.(${idList})`);
    coachMap = Object.fromEntries(coaches.map(c => [c.id, c]));
  }
  const noteBookingIds = new Set();
  if (missingAnalysis.length) {
    const idList = missingAnalysis.map(b => `"${b.id}"`).join(',');
    const notes = await sb.get(`coach_session_notes?select=booking_id&post_session_analysis=not.is.null&booking_id=in.(${idList})`);
    notes.forEach(n => noteBookingIds.add(n.booking_id));
  }
  const actuallyMissing = missingAnalysis.filter(b => !noteBookingIds.has(b.id));

  return {
    failedClarity: failedClarity.map(r => ({ ...r, coach: coachMap[r.coach_id] || null })),
    missingAnalysis: actuallyMissing.map(r => ({ ...r, coach: coachMap[r.coach_id] || null })),
    quietProfiles,
  };
}

async function coachesList(sb) {
  const somISO = startOfMonthISO();
  const coaches = await sb.get(`coach_profiles?select=id,display_name,full_name,user_email,slug,is_published,created_at&order=created_at.desc&limit=${MAX_ROWS}`);
  const bookings = await sb.get(`coach_bookings?select=coach_id,scheduled_at&limit=${MAX_ROWS}`);
  const notes = await sb.get(`coach_session_notes?select=coach_id,post_session_analysis&limit=${MAX_ROWS}`);
  const usage = await fetchAllUsage(sb);
  
  // NEW: Fetch per-coach AI costs for this month
  const aiUsageThisMonth = await sb.get(`coach_ai_usage_log?select=coach_id,estimated_cost_cents,created_at&created_at=gte.${somISO}&limit=${MAX_ROWS}`).catch(() => []);
  const aiCostByCoach = {};
  (aiUsageThisMonth || []).forEach(u => {
    if (u && u.coach_id) {
      aiCostByCoach[u.coach_id] = (aiCostByCoach[u.coach_id] || 0) + (Number(u.estimated_cost_cents) || 0);
    }
  });
  
  const sessionCountByCoach = {};
  const lastActiveByCoach = {};
  const now = new Date();
  
  bookings.forEach(b => {
    sessionCountByCoach[b.coach_id] = (sessionCountByCoach[b.coach_id] || 0) + 1;
    const scheduledDate = new Date(b.scheduled_at);
    if (scheduledDate <= now) {
      const prev = lastActiveByCoach[b.coach_id];
      if (!prev || scheduledDate > new Date(prev)) {
        lastActiveByCoach[b.coach_id] = b.scheduled_at;
      }
    }
  });
  
  const clarityByCoach = {};
  notes.forEach(n => {
    if (n.post_session_analysis) clarityByCoach[n.coach_id] = true;
  });
  
  const totalRunsByCoach = {};
  const regensByCoach = {};
  const sessionsByCoach = {};
  const regensBySessionCoach = {};
  (usage || []).forEach(u => {
    const email = (u && u.coach_email || '').toLowerCase();
    if (!email) return;
    totalRunsByCoach[email] = (totalRunsByCoach[email] || 0) + 1;
    if (u.is_regeneration) regensByCoach[email] = (regensByCoach[email] || 0) + 1;
    if (!sessionsByCoach[email]) sessionsByCoach[email] = new Set();
    if (u.session_id) sessionsByCoach[email].add(u.session_id);
    if (!regensBySessionCoach[email]) regensBySessionCoach[email] = {};
    if (u.is_regeneration && u.session_id) {
      regensBySessionCoach[email][u.session_id] = (regensBySessionCoach[email][u.session_id] || 0) + 1;
    }
  });
  
  function tierFor(email) {
    const sessions = sessionsByCoach[email];
    if (!sessions || sessions.size === 0) return 'light';
    const perSession = regensBySessionCoach[email] || {};
    let total = 0;
    sessions.forEach(sid => { total += perSession[sid] || 0; });
    const avg = total / sessions.size;
    if (avg <= 1) return 'light';
    if (avg <= 5) return 'moderate';
    return 'heavy';
  }
  
  return coaches.map(c => {
    const email = (c.user_email || '').toLowerCase();
    const aiCostCents = aiCostByCoach[c.id] || 0;
    return {
      ...c,
      sessionCount: sessionCountByCoach[c.id] || 0,
      lastActive: lastActiveByCoach[c.id] || null,
      hasClarity: !!clarityByCoach[c.id],
      totalRuns: totalRunsByCoach[email] || 0,
      regenerations: regensByCoach[email] || 0,
      usageTier: tierFor(email),
      aiCostThisMonth: Number((aiCostCents / 100).toFixed(2)), // NEW: AI cost in dollars
    };
  });
}

async function clientsList(sb) {
  const clients = await sb.get(`explorer_profiles?select=id,email,display_name,created_at,phone&order=created_at.desc&limit=${MAX_ROWS}`);
  const bookings = await sb.get(`coach_bookings?select=coach_id,client_email,scheduled_at&limit=${MAX_ROWS}`);
  const checkins = await sb.get(`explorer_checkins?select=user_email,created_at&limit=${MAX_ROWS}`);
  const coaches = await sb.get(`coach_profiles?select=id,display_name&limit=${MAX_ROWS}`);
  const coachMap = Object.fromEntries(coaches.map(c => [c.id, c.display_name]));

  const byEmail = {};
  bookings.forEach(b => {
    const e = (b.client_email || '').toLowerCase();
    if (!e) return;
    if (!byEmail[e]) byEmail[e] = { coach_id: null, lastSession: null };
    if (!byEmail[e].lastSession || new Date(b.scheduled_at) > new Date(byEmail[e].lastSession)) {
      byEmail[e].lastSession = b.scheduled_at;
      byEmail[e].coach_id = b.coach_id;
    }
  });
  const checkinCount = {};
  const lastCheckin = {};
  checkins.forEach(c => {
    const e = (c.user_email || '').toLowerCase();
    if (!e) return;
    checkinCount[e] = (checkinCount[e] || 0) + 1;
    if (!lastCheckin[e] || new Date(c.created_at) > new Date(lastCheckin[e])) lastCheckin[e] = c.created_at;
  });
  return clients.map(c => {
    const e = (c.email || '').toLowerCase();
    const b = byEmail[e] || {};
    return {
      ...c,
      assignedCoach: b.coach_id ? (coachMap[b.coach_id] || 'Unknown') : null,
      lastSession: b.lastSession || null,
      checkinCount: checkinCount[e] || 0,
      lastActive: lastCheckin[e] || b.lastSession || null,
    };
  });
}

async function sessionsList(sb) {
  const bookings = await sb.get(`coach_bookings?select=id,coach_id,client_email,scheduled_at,status,notes&order=scheduled_at.desc&limit=${MAX_ROWS}`);
  const notes = await sb.get(`coach_session_notes?select=booking_id,raw_transcript,post_session_analysis,notes&limit=${MAX_ROWS}`);
  const noteMap = {};
  notes.forEach(n => { noteMap[n.booking_id] = n; });
  const coaches = await sb.get(`coach_profiles?select=id,display_name&limit=${MAX_ROWS}`);
  const coachMap = Object.fromEntries(coaches.map(c => [c.id, c.display_name]));
  const usage = await fetchAllUsage(sb);
  const regensBySession = {};
  (usage || []).forEach(u => {
    if (u && u.is_regeneration && u.session_id) {
      regensBySession[u.session_id] = (regensBySession[u.session_id] || 0) + 1;
    }
  });

  return bookings.map(b => {
    const n = noteMap[b.id] || {};
    return {
      id: b.id,
      scheduled_at: b.scheduled_at,
      coach_name: coachMap[b.coach_id] || 'Unknown',
      coach_id: b.coach_id,
      client_email: b.client_email,
      session_type: extractServiceName(b.notes),
      has_transcript: !!n.raw_transcript,
      has_clarity: !!n.post_session_analysis,
      has_notes: !!(n.notes || n.post_session_analysis),
      status: b.status,
      regens: regensBySession[b.id] || 0,
    };
  });
}

function extractServiceName(notes) {
  if (!notes) return '—';
  const m = /Service:\s*(.+?)(?:\n|$)/i.exec(notes);
  return m ? m[1].trim() : '—';
}

async function revenue(sb) {
  const publishedCount = await sb.count('coach_profiles', `is_published=eq.true`);
  const inactive = await inactiveCoaches(sb, 14);
  const publishedInactive = inactive.filter(() => true);
  return {
    publishedCount,
    estimatedMrr: publishedCount * MRR_PER_COACH,
    churnRisk: publishedInactive,
  };
}
