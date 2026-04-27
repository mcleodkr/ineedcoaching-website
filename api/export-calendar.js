// GET /api/export-calendar?coach_id=<uuid>&start=<iso>&end=<iso>
//
// Streams an .ics (iCalendar) file of confirmed + manual bookings in the
// requested window. Used by the Export button in coach-dashboard.html
// (PR 3.A) so coaches can pull their schedule into Google Calendar /
// Apple Calendar / Outlook without giving those apps Supabase access.
//
// Auth: same anon-key model as the rest of the dashboard reads. The endpoint
// is callable with just a coach_id, so it's protected only by 'you must
// know the uuid' — fine for a coach-driven download triggered from the
// authenticated dashboard, NOT for sharing the URL publicly. The link is
// generated client-side at click time, never published in feeds.

const DEFAULT_DURATION_MIN = 60;

function parseDurationMinutes(s) {
  if (!s) return DEFAULT_DURATION_MIN;
  const str = String(s).toLowerCase();
  const m = str.match(/(\d+(?:\.\d+)?)/);
  if (!m) return DEFAULT_DURATION_MIN;
  const n = parseFloat(m[1]);
  if (/hour|hr/.test(str)) return Math.max(5, Math.round(n * 60));
  return Math.max(5, Math.round(n));
}

// RFC 5545 escaping for TEXT property values: backslash, semicolon, comma,
// and newline must be escaped. Carriage returns get stripped.
function escapeIcsText(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/\r/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

// RFC 5545 line folding: lines >75 octets must be wrapped, with continuation
// lines starting with a space. Conservative byte-level approach using TextEncoder.
function foldIcsLine(line) {
  const enc = new TextEncoder();
  const bytes = enc.encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const slice = bytes.slice(i, i + 75);
    out.push(new TextDecoder().decode(slice));
    i += 75;
  }
  return out.join('\r\n ');
}

function formatIcsTimestamp(d) {
  // YYYYMMDDTHHMMSSZ — UTC, no separators.
  const pad = (n, w) => String(n).padStart(w, '0');
  return pad(d.getUTCFullYear(), 4)
    + pad(d.getUTCMonth() + 1, 2)
    + pad(d.getUTCDate(), 2)
    + 'T'
    + pad(d.getUTCHours(), 2)
    + pad(d.getUTCMinutes(), 2)
    + pad(d.getUTCSeconds(), 2)
    + 'Z';
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return res.status(200).end();
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  try {
    const coachId = String(req.query.coach_id || req.query.coachId || '');
    if (!coachId) return res.status(400).json({ error: 'Missing coach_id' });
    const start = req.query.start ? String(req.query.start) : '';
    const end = req.query.end ? String(req.query.end) : '';

    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
    let query = `${SUPABASE_URL}/rest/v1/coach_bookings`
      + `?coach_id=eq.${encodeURIComponent(coachId)}`
      + `&status=in.(confirmed,manual)`
      + `&select=id,client_name,client_email,service_name,scheduled_at,zoom_link,notes,coach_services(duration),coach_profiles(display_name,full_name,timezone)`;
    if (start) query += `&scheduled_at=gte.${encodeURIComponent(start)}`;
    if (end) query += `&scheduled_at=lte.${encodeURIComponent(end)}`;
    query += `&order=scheduled_at.asc`;

    const lookup = await fetch(query, { headers });
    if (!lookup.ok) return res.status(500).json({ error: 'lookup_failed', status: lookup.status });
    const bookings = await lookup.json();

    const now = new Date();
    const dtstamp = formatIcsTimestamp(now);
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//ineedcoaching.org//Scheduler//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Coaching Sessions',
    ];

    let coachTz = '';
    (bookings || []).forEach(function (b) {
      if (!b || !b.scheduled_at) return;
      const startDate = new Date(b.scheduled_at);
      if (Number.isNaN(startDate.getTime())) return;
      const durationText = (b.coach_services && b.coach_services.duration) || '60 minutes';
      const endDate = new Date(startDate.getTime() + parseDurationMinutes(durationText) * 60000);
      if (b.coach_profiles && b.coach_profiles.timezone) coachTz = b.coach_profiles.timezone;

      const clientLabel = b.client_name || b.client_email || 'Client';
      const summary = (b.service_name || 'Session') + ' — ' + clientLabel;
      const descParts = [];
      if (b.client_email) descParts.push('Client: ' + clientLabel + ' (' + b.client_email + ')');
      else descParts.push('Client: ' + clientLabel);
      if (b.zoom_link) descParts.push('Zoom: ' + b.zoom_link);
      if (b.notes) descParts.push('Notes: ' + b.notes);
      const description = descParts.join('\n');

      lines.push('BEGIN:VEVENT');
      lines.push(foldIcsLine('UID:booking-' + b.id + '@ineedcoaching.org'));
      lines.push('DTSTAMP:' + dtstamp);
      lines.push('DTSTART:' + formatIcsTimestamp(startDate));
      lines.push('DTEND:' + formatIcsTimestamp(endDate));
      lines.push(foldIcsLine('SUMMARY:' + escapeIcsText(summary)));
      lines.push(foldIcsLine('DESCRIPTION:' + escapeIcsText(description)));
      if (b.zoom_link && /^https?:\/\//.test(b.zoom_link)) {
        lines.push(foldIcsLine('URL:' + b.zoom_link));
      }
      lines.push('STATUS:CONFIRMED');
      lines.push('END:VEVENT');
    });

    if (coachTz) {
      // X-WR-TIMEZONE is a soft hint; importers that respect it (Google
      // Calendar) will display the events in the coach's local zone even
      // though DTSTART is UTC.
      lines.splice(6, 0, 'X-WR-TIMEZONE:' + coachTz);
    }
    lines.push('END:VCALENDAR');

    const icsContent = lines.join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="coaching-sessions.ics"');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(icsContent);
  } catch (e) {
    console.error('[export-calendar] error', e);
    return res.status(500).json({ error: e.message });
  }
}
