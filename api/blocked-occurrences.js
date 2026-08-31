// GET /api/blocked-occurrences?coachId=...&start=YYYY-MM-DD&end=YYYY-MM-DD
//
// Expands coach_blocked_times into concrete dated occurrences over [start, end)
// so the coach dashboard calendar can shade them. Recurrence math is imported
// from ./_lib/blocks.js, the same module /api/availability-slots uses, so the
// calendar can never disagree with what clients are actually offered.
//
// Deliberately does NOT return `reason`. Which times are unbookable is already
// inferable from the public booking page; the coach's private note for why is
// not, and this endpoint is unauthenticated.
//
// Response: { occurrences: [{ date, all_day, start_time, end_time }] }

import { BLOCK_SELECT, blockWindowFilter, normalizeBlockRows, blockCoversDate } from './_lib/blocks.js';

const MAX_RANGE_DAYS = 120;

function timeToMinutes(t) {
  if (!t) return null;
  const parts = String(t).split(':');
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

function addDays(dateStr, n) {
  const p = String(dateStr).split('-');
  const d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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
  const start = String(req.query.start || '');
  const end = String(req.query.end || '');
  if (!coachId) return res.status(400).json({ error: 'Missing coachId' });
  if (!isIsoDate(start) || !isIsoDate(end)) return res.status(400).json({ error: 'start and end must be YYYY-MM-DD' });
  if (end <= start) return res.status(400).json({ error: 'end must be after start' });

  const spanDays = Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000);
  if (spanDays > MAX_RANGE_DAYS) return res.status(400).json({ error: `Range exceeds ${MAX_RANGE_DAYS} days` });

  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

  try {
    const url = `${SUPABASE_URL}/rest/v1/coach_blocked_times`
      + `?coach_id=eq.${coachId}`
      + blockWindowFilter(start, end)
      + `&select=${BLOCK_SELECT}`;
    const r = await fetch(url, { headers });
    if (!r.ok) return res.status(502).json({ error: 'Upstream error' });
    const rows = await r.json();
    const spans = normalizeBlockRows(rows, timeToMinutes);

    const occurrences = [];
    for (let dateStr = start; dateStr < end; dateStr = addDays(dateStr, 1)) {
      for (const b of spans) {
        if (!blockCoversDate(b, dateStr)) continue;
        occurrences.push({
          date: dateStr,
          all_day: b.allDay,
          start_time: b.allDay ? null : b.startTime,
          end_time: b.allDay ? null : b.endTime,
        });
      }
    }

    return res.status(200).json({ occurrences });
  } catch (e) {
    console.error('[blocked-occurrences] failed', e);
    return res.status(500).json({ error: 'Failed to load blocked times' });
  }
}
