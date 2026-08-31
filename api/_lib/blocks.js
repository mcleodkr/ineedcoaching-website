// Shared recurrence logic for coach_blocked_times.
//
// Both /api/availability-slots (what a client may book) and
// /api/blocked-occurrences (what the coach sees shaded on the dashboard
// calendar) must agree on which dates a block rule covers. Two copies of this
// math would eventually drift, and the symptom would be a calendar showing a
// slot as blocked while the booking page still sells it. One copy, imported by
// both, makes that impossible.

// Columns every consumer needs. Keep the two callers in sync by selecting this.
export const BLOCK_SELECT = 'blocked_date,end_date,start_time,end_time,all_day,repeat_freq,repeat_until,repeat_exceptions';

// PostgREST filter that returns every block relevant to [startDateStr, endDateStr]:
// spans overlapping the window, single days inside it, and every recurring rule
// (rules are cheap to over-fetch; blockCoversDate rejects expired ones).
export function blockWindowFilter(startDateStr, endDateStr) {
  return `&blocked_date=lte.${endDateStr}`
    + `&or=(end_date.gte.${startDateStr},and(end_date.is.null,blocked_date.gte.${startDateStr}),repeat_freq.neq.never)`;
}

// "YYYY-MM-DD" -> whole days since the epoch, via UTC so no timezone drift.
export function isoToUtcDays(d) {
  const p = String(d).split('-');
  return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000;
}

// Raw PostgREST rows -> the shape blockCoversDate expects.
export function normalizeBlockRows(rows, timeToMinutes) {
  return (Array.isArray(rows) ? rows : []).map((b) => ({
    startDate: b.blocked_date,
    endDate: b.end_date || b.blocked_date,
    repeatFreq: b.repeat_freq || 'never',
    repeatUntil: b.repeat_until || null,
    repeatExceptions: Array.isArray(b.repeat_exceptions) ? b.repeat_exceptions : [],
    allDay: !!b.all_day,
    startTime: b.all_day ? null : b.start_time,
    endTime: b.all_day ? null : b.end_time,
    startMin: b.all_day ? null : timeToMinutes(b.start_time),
    endMin: b.all_day ? null : timeToMinutes(b.end_time),
  }));
}

// Does this block cover the given coach-local ISO date?
// repeat_freq 'never' -> covers [startDate, endDate] inclusive (endDate collapses
// to startDate for single-day blocks). Otherwise the block is a rule anchored on
// startDate: it covers dates on or after the anchor that match the frequency,
// stopping at repeatUntil when set, minus any explicit exception dates.
export function blockCoversDate(b, dateStr) {
  if (b.repeatFreq === 'never') {
    return dateStr >= b.startDate && dateStr <= b.endDate;
  }
  if (dateStr < b.startDate) return false;
  if (b.repeatUntil && dateStr > b.repeatUntil) return false;
  if (b.repeatExceptions.indexOf(dateStr) !== -1) return false;
  const diffDays = isoToUtcDays(dateStr) - isoToUtcDays(b.startDate);
  switch (b.repeatFreq) {
    case 'daily': return true;
    case 'weekly': return diffDays % 7 === 0;
    case 'biweekly': return diffDays % 14 === 0;
    case 'monthly': return dateStr.slice(8, 10) === b.startDate.slice(8, 10);
    case 'yearly': return dateStr.slice(5, 10) === b.startDate.slice(5, 10);
    default: return false;
  }
}
