// GET /api/availability-slots?coachId=...&serviceId=...&days=14
//
// Returns bookable slots for the requested coach + service over the next N days
// (default 14, max 60). Pure compute — reads:
//   coach_profiles                (timezone)
//   coach_services                (duration text + slot_increment_minutes for the requested service;
//                                   plus all services for the coach so we know the duration of every
//                                   existing booking for collision checks)
//   coach_weekly_availability     (recurring schedule, day_of_week 0..6)
//   coach_blocked_times           (vacations, all-day or time-range)
//   coach_bookings                (status in confirmed/manual; subtracted as conflicts)
//
// Algorithm:
//   for each date in [today, today+days):
//     dow = date.getDay() in coach-local time
//     for each availability block on dow:
//       step from block.start_time to (block.end_time - serviceDuration) by slot_increment_minutes
//         skip if slot is in the past
//         skip if slot range overlaps any blocked_time on that date
//         skip if slot range overlaps any existing booking
//         else emit { datetime: ISO with coach offset, available: true }
//
// Response: { slots: [...], coach_timezone: 'America/Chicago' }

const DEFAULT_DAYS = 14;
const MAX_DAYS = 60;
const DEFAULT_DURATION_MIN = 60;
const DEFAULT_SLOT_INCREMENT_MIN = 30;

// Parse a free-form duration like "60 minutes" / "1 hour" / "30 min" into minutes.
function parseDurationMinutes(s) {
  if (!s) return DEFAULT_DURATION_MIN;
  const str = String(s).toLowerCase();
  const m = str.match(/(\d+(?:\.\d+)?)/);
  if (!m) return DEFAULT_DURATION_MIN;
  const n = parseFloat(m[1]);
  if (/hour|hr/.test(str)) return Math.max(5, Math.round(n * 60));
  return Math.max(5, Math.round(n));
}

// Returns the offset (in minutes) from UTC for the given timezone at the given UTC instant.
// Positive = ahead of UTC. Used to bridge coach-local clock time ↔ UTC instants for DST safety.
function getTzOffsetMinutes(utcDate, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(utcDate);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const localMs = Date.UTC(
    parseInt(map.year, 10),
    parseInt(map.month, 10) - 1,
    parseInt(map.day, 10),
    parseInt(map.hour, 10) === 24 ? 0 : parseInt(map.hour, 10),
    parseInt(map.minute, 10),
    parseInt(map.second, 10),
  );
  return Math.round((localMs - utcDate.getTime()) / 60000);
}

// Convert (coach-local clock time on a given calendar date) → { utc: Date, isoWithOffset: string }.
// Iterates twice to converge across DST transitions (a slot's offset depends on its own instant).
function coachLocalToInstant(year, month, day, hour, minute, tz) {
  // Initial guess: pretend the local time is UTC.
  let candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  for (let i = 0; i < 2; i++) {
    const off = getTzOffsetMinutes(candidate, tz);
    candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, 0) - off * 60000);
  }
  const offMin = getTzOffsetMinutes(candidate, tz);
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, '0');
  const om = String(abs % 60).padStart(2, '0');
  const localStr =
    String(year).padStart(4, '0') + '-' +
    String(month).padStart(2, '0') + '-' +
    String(day).padStart(2, '0') + 'T' +
    String(hour).padStart(2, '0') + ':' +
    String(minute).padStart(2, '0') + ':00';
  return { utc: candidate, isoWithOffset: localStr + sign + oh + ':' + om };
}

// Coach-local day-of-week (0=Sunday..6=Saturday) for a given UTC instant + tz.
function coachLocalDow(utcDate, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
  const w = dtf.format(utcDate);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[w];
}

// Return YYYY-MM-DD in the coach's local timezone for a given UTC instant.
function coachLocalDateParts(utcDate, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = dtf.formatToParts(utcDate);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return { year: parseInt(map.year, 10), month: parseInt(map.month, 10), day: parseInt(map.day, 10) };
}

// Parse "HH:MM" or "HH:MM:SS" into total minutes-from-midnight.
function timeToMinutes(t) {
  if (!t) return null;
  const parts = String(t).split(':');
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
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
  const serviceId = String(req.query.serviceId || req.query.service_id || '');
  const daysRaw = parseInt(req.query.days || String(DEFAULT_DAYS), 10);
  const days = Number.isFinite(daysRaw) && daysRaw >= 1 && daysRaw <= MAX_DAYS ? daysRaw : DEFAULT_DAYS;
  if (!coachId) return res.status(400).json({ error: 'Missing coachId' });
  if (!serviceId) return res.status(400).json({ error: 'Missing serviceId' });

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
  };

  try {
    // 1. Coach profile (timezone)
    const profRes = await fetch(`${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${coachId}&select=timezone&limit=1`, { headers });
    if (!profRes.ok) return res.status(500).json({ error: 'profile_fetch_failed', status: profRes.status });
    const profRows = await profRes.json();
    if (!profRows.length) return res.status(404).json({ error: 'coach_not_found' });
    const tz = profRows[0].timezone || 'America/Chicago';

    // 2. All active services for this coach (need durations of OTHER services for booking conflict checks)
    const svcRes = await fetch(`${SUPABASE_URL}/rest/v1/coach_services?coach_id=eq.${coachId}&select=id,duration,slot_increment_minutes,is_active`, { headers });
    if (!svcRes.ok) return res.status(500).json({ error: 'services_fetch_failed', status: svcRes.status });
    const services = await svcRes.json();
    const svcMap = new Map();
    for (const s of services) svcMap.set(s.id, s);
    const requested = svcMap.get(serviceId);
    if (!requested) return res.status(404).json({ error: 'service_not_found' });
    if (requested.is_active === false) return res.status(400).json({ error: 'service_inactive' });
    const serviceDuration = parseDurationMinutes(requested.duration);
    const slotIncrement = (Number.isFinite(requested.slot_increment_minutes) && requested.slot_increment_minutes > 0)
      ? requested.slot_increment_minutes
      : DEFAULT_SLOT_INCREMENT_MIN;

    // 3. Weekly availability
    const wkRes = await fetch(`${SUPABASE_URL}/rest/v1/coach_weekly_availability?coach_id=eq.${coachId}&active=eq.true&select=day_of_week,start_time,end_time`, { headers });
    if (!wkRes.ok) return res.status(500).json({ error: 'availability_fetch_failed', status: wkRes.status });
    const weekly = await wkRes.json();
    // Bucket by day_of_week
    const blocksByDow = new Map();
    for (const w of weekly) {
      const list = blocksByDow.get(w.day_of_week) || [];
      list.push({ startMin: timeToMinutes(w.start_time), endMin: timeToMinutes(w.end_time) });
      blocksByDow.set(w.day_of_week, list);
    }

    // 4. Blocked times in window
    const now = new Date();
    const winEnd = new Date(now.getTime() + days * 86400000);
    const startDateIso = coachLocalDateParts(now, tz);
    const endDateIso = coachLocalDateParts(winEnd, tz);
    const startDateStr = `${startDateIso.year}-${String(startDateIso.month).padStart(2, '0')}-${String(startDateIso.day).padStart(2, '0')}`;
    const endDateStr = `${endDateIso.year}-${String(endDateIso.month).padStart(2, '0')}-${String(endDateIso.day).padStart(2, '0')}`;

    const blkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_blocked_times`
      + `?coach_id=eq.${coachId}`
      + `&blocked_date=gte.${startDateStr}`
      + `&blocked_date=lte.${endDateStr}`
      + `&select=blocked_date,start_time,end_time,all_day`,
      { headers });
    if (!blkRes.ok) return res.status(500).json({ error: 'blocked_fetch_failed', status: blkRes.status });
    const blocked = await blkRes.json();
    // Bucket by date string for fast lookup
    const blockedByDate = new Map();
    for (const b of blocked) {
      const list = blockedByDate.get(b.blocked_date) || [];
      list.push({
        allDay: !!b.all_day,
        startMin: b.all_day ? null : timeToMinutes(b.start_time),
        endMin: b.all_day ? null : timeToMinutes(b.end_time),
      });
      blockedByDate.set(b.blocked_date, list);
    }

    // 5. Existing bookings in window — fetch as UTC instants, derive [start, end] in UTC
    const winStartUtcIso = now.toISOString();
    const winEndUtcIso = winEnd.toISOString();
    const bkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_bookings`
      + `?coach_id=eq.${coachId}`
      + `&status=in.(confirmed,manual)`
      + `&scheduled_at=gte.${encodeURIComponent(winStartUtcIso)}`
      + `&scheduled_at=lte.${encodeURIComponent(winEndUtcIso)}`
      + `&select=scheduled_at,service_id`,
      { headers });
    if (!bkRes.ok) return res.status(500).json({ error: 'bookings_fetch_failed', status: bkRes.status });
    const bookings = await bkRes.json();
    // Pre-compute booking [startMs, endMs)
    const bookingRanges = bookings.map((b) => {
      const startMs = new Date(b.scheduled_at).getTime();
      const dur = b.service_id && svcMap.get(b.service_id)
        ? parseDurationMinutes(svcMap.get(b.service_id).duration)
        : DEFAULT_DURATION_MIN;
      return { startMs, endMs: startMs + dur * 60000 };
    });

    // 6. Iterate dates in window, build slots
    const slots = [];
    const nowMs = now.getTime();
    for (let dayOffset = 0; dayOffset <= days; dayOffset++) {
      const cursorMs = now.getTime() + dayOffset * 86400000;
      const cursorUtc = new Date(cursorMs);
      const dateParts = coachLocalDateParts(cursorUtc, tz);
      const dateStr = `${dateParts.year}-${String(dateParts.month).padStart(2, '0')}-${String(dateParts.day).padStart(2, '0')}`;
      const dow = coachLocalDow(cursorUtc, tz);
      const dayBlocks = blocksByDow.get(dow) || [];
      if (!dayBlocks.length) continue;
      const dateBlocks = blockedByDate.get(dateStr) || [];
      const allDayBlocked = dateBlocks.some((b) => b.allDay);
      if (allDayBlocked) continue;
      for (const block of dayBlocks) {
        if (block.startMin === null || block.endMin === null) continue;
        // Step start times such that slotEnd <= block.end
        const lastStart = block.endMin - serviceDuration;
        for (let startMin = block.startMin; startMin <= lastStart; startMin += slotIncrement) {
          const slotEndMin = startMin + serviceDuration;
          const hour = Math.floor(startMin / 60);
          const minute = startMin % 60;
          const inst = coachLocalToInstant(dateParts.year, dateParts.month, dateParts.day, hour, minute, tz);
          const slotStartMs = inst.utc.getTime();
          const slotEndMs = slotStartMs + serviceDuration * 60000;
          if (slotStartMs <= nowMs) continue;
          // Range-block conflict (same date, time overlap)
          let blockedConflict = false;
          for (const b of dateBlocks) {
            if (b.allDay) { blockedConflict = true; break; }
            if (b.startMin === null || b.endMin === null) continue;
            if (b.startMin < slotEndMin && b.endMin > startMin) { blockedConflict = true; break; }
          }
          if (blockedConflict) continue;
          // Booking conflict (UTC range overlap)
          let bookingConflict = false;
          for (const r of bookingRanges) {
            if (r.startMs < slotEndMs && r.endMs > slotStartMs) { bookingConflict = true; break; }
          }
          if (bookingConflict) continue;
          slots.push({ datetime: inst.isoWithOffset, available: true });
        }
      }
    }

    return res.status(200).json({
      slots,
      coach_timezone: tz,
      service_id: serviceId,
      service_duration_minutes: serviceDuration,
      slot_increment_minutes: slotIncrement,
      window: { start: now.toISOString(), end: winEnd.toISOString(), days },
    });
  } catch (e) {
    console.error('[availability-slots] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
