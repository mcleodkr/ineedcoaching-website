// Daily intervention cron — gentle, suggestive nudges that sound like Kimberly
// wrote them personally. Scheduled via vercel.json crons entry at 09:00 UTC.
//
// Required migration (run once in Supabase SQL Editor):
//
// CREATE TABLE IF NOT EXISTS platform_nudges (
//   id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   recipient_email text,
//   nudge_type text,
//   sent_at timestamptz DEFAULT now(),
//   metadata jsonb
// );
// CREATE INDEX IF NOT EXISTS platform_nudges_recipient_type_idx
//   ON platform_nudges(recipient_email, nudge_type, sent_at DESC);
//
// FUTURE AUTOMATIONS TO ADD:
// - Coach upgrade nudge when heavy usage detected (6+ regens/session)
// - Client re-engagement after 14 days no login
// - Coach celebration email after first Coach Clarity run
// - Weekly digest for admin (you) with platform health summary
// - Stripe upgrade prompt for heavy users

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const DASHBOARD_COACH = 'https://www.ineedcoaching.org/coach-dashboard.html';
const DASHBOARD_CLIENT = 'https://www.ineedcoaching.org/client-dashboard.html';

const NUDGE = {
  COACH_NO_SESSION_5D: 'coach_no_session_5d',
  COACH_INACTIVE_10D: 'coach_inactive_10d',
  SESSION_MISSING_CLARITY_24H: 'session_missing_clarity_24h',
  CLIENT_NO_BOOKING_48H: 'client_no_booking_48h',
  COACH_CLIENT_NUDGE_COURTESY: 'coach_client_nudge_courtesy',
};

// ---------- helpers ----------

function firstName(displayOrFull) {
  if (!displayOrFull) return 'there';
  const first = String(displayOrFull).trim().split(/\s+/)[0];
  return first || 'there';
}

function sbHeaders() {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase GET failed (${res.status}): ${err.substring(0, 200)}`);
  }
  return res.json();
}

async function sbPost(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase POST failed (${res.status}): ${err.substring(0, 200)}`);
  }
  return true;
}

async function alreadyNudged(email, type, windowDays = 7) {
  if (!email) return true;
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const url =
    `platform_nudges?recipient_email=eq.${encodeURIComponent(email.toLowerCase())}` +
    `&nudge_type=eq.${encodeURIComponent(type)}` +
    `&sent_at=gte.${encodeURIComponent(cutoff)}` +
    `&limit=1&select=id`;
  try {
    const rows = await sbGet(url);
    return Array.isArray(rows) && rows.length > 0;
  } catch (err) {
    console.error('alreadyNudged failed (treating as already nudged to be safe):', err.message);
    return true;
  }
}

async function logNudge(email, type, metadata) {
  try {
    await sbPost('platform_nudges', {
      recipient_email: email ? email.toLowerCase() : null,
      nudge_type: type,
      metadata: metadata || {},
    });
  } catch (err) {
    console.error('logNudge failed (non-fatal):', err.message);
  }
}

function wrapHtml(bodyText, linkUrl, linkLabel) {
  const paragraphs = bodyText
    .split('\n\n')
    .map((p) => `<p style="margin: 0 0 16px 0; font-family: 'DM Sans', Arial, sans-serif; font-size: 16px; line-height: 1.6; color: #1a3a52;">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
  const button = linkUrl
    ? `<p style="margin: 24px 0;"><a href="${linkUrl}" style="display: inline-block; background: #c49a3c; color: #ffffff; padding: 12px 22px; text-decoration: none; border-radius: 6px; font-family: 'DM Sans', Arial, sans-serif; font-size: 15px;">${linkLabel}</a></p>`
    : '';
  return `<div style="max-width: 560px; padding: 24px; background: #f7f5f1;">${paragraphs}${button}</div>`;
}

async function sendEmail({ to, subject, text, linkUrl, linkLabel }) {
  if (!RESEND_KEY) throw new Error('RESEND_API_KEY not set');
  const html = wrapHtml(text, linkUrl, linkLabel || 'Open your dashboard');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'hello@ineedcoaching.org',
      to,
      reply_to: 'drkmcleod@gmail.com',
      subject,
      html,
      text,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend failed (${res.status}): ${err.substring(0, 200)}`);
  }
  return res.json();
}

// ---------- interventions ----------

async function intervention1CoachNoSession5d() {
  const summary = { checked: 0, nudged: 0, skipped: 0 };
  const cutoff = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const coaches = await sbGet(
    `coach_profiles?created_at=lt.${encodeURIComponent(cutoff)}&select=id,user_email,display_name,full_name,created_at`
  );
  if (!Array.isArray(coaches)) return summary;

  for (const coach of coaches) {
    summary.checked += 1;
    try {
      if (!coach || !coach.user_email) {
        summary.skipped += 1;
        continue;
      }
      const bookings = await sbGet(
        `coach_bookings?coach_id=eq.${encodeURIComponent(coach.id)}&limit=1&select=id`
      );
      if (Array.isArray(bookings) && bookings.length > 0) {
        summary.skipped += 1;
        continue;
      }
      if (await alreadyNudged(coach.user_email, NUDGE.COACH_NO_SESSION_5D, 7)) {
        summary.skipped += 1;
        continue;
      }
      const name = firstName(coach.display_name || coach.full_name);
      const text =
        `Hi ${name},\n\n` +
        `I noticed you joined ineedcoaching.org a few days ago and haven't run your first session yet. If there's anything slowing you down, I'd love to know — even the smallest friction helps me make this better. When you're ready, you might start by uploading a recent session and letting Coach Clarity give you a full breakdown.\n\n` +
        `Warmly,\nKimberly`;
      await sendEmail({
        to: coach.user_email,
        subject: 'Getting started with Coach Clarity',
        text,
        linkUrl: DASHBOARD_COACH,
        linkLabel: 'Open your coach dashboard',
      });
      await logNudge(coach.user_email, NUDGE.COACH_NO_SESSION_5D, { coach_id: coach.id });
      summary.nudged += 1;
    } catch (err) {
      console.error('intervention1 error for coach:', coach && coach.id, err.message);
      summary.skipped += 1;
    }
  }
  return summary;
}

async function intervention2CoachInactive10d() {
  const summary = { checked: 0, nudged: 0, skipped: 0 };
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  // Coaches older than 10 days — we compare recent booking activity per coach.
  const coaches = await sbGet(
    `coach_profiles?created_at=lt.${encodeURIComponent(tenDaysAgo)}&select=id,user_email,display_name,full_name,created_at`
  );
  if (!Array.isArray(coaches)) return summary;

  for (const coach of coaches) {
    summary.checked += 1;
    try {
      if (!coach || !coach.user_email) {
        summary.skipped += 1;
        continue;
      }
      const recentBookings = await sbGet(
        `coach_bookings?coach_id=eq.${encodeURIComponent(coach.id)}&scheduled_at=gte.${encodeURIComponent(tenDaysAgo)}&limit=1&select=id`
      );
      if (Array.isArray(recentBookings) && recentBookings.length > 0) {
        summary.skipped += 1;
        continue;
      }
      // Guard: skip coaches with zero total bookings (intervention 1 handles the first 5 days;
      // once past 10 days with zero bookings they still belong here as "inactive").
      if (await alreadyNudged(coach.user_email, NUDGE.COACH_INACTIVE_10D, 7)) {
        summary.skipped += 1;
        continue;
      }
      const name = firstName(coach.display_name || coach.full_name);
      const text =
        `Hi ${name},\n\n` +
        `Just checking in — it's been a little while since your last session on the platform. Is there anything getting in the way of using Coach Clarity? If it'd help to talk through how you're using it (or why you're not), I'm one reply away.\n\n` +
        `Warmly,\nKimberly`;
      await sendEmail({
        to: coach.user_email,
        subject: 'Checking in',
        text,
        linkUrl: DASHBOARD_COACH,
        linkLabel: 'Open your coach dashboard',
      });
      await logNudge(coach.user_email, NUDGE.COACH_INACTIVE_10D, { coach_id: coach.id });
      summary.nudged += 1;
    } catch (err) {
      console.error('intervention2 error for coach:', coach && coach.id, err.message);
      summary.skipped += 1;
    }
  }
  return summary;
}

async function intervention3SessionMissingClarity24h() {
  // Dedup strategy: global (recipient_email, nudge_type) with a 24h window.
  // Simpler than JSONB filtering through PostgREST and still avoids hourly spam.
  // A coach with multiple pending transcripts receives one nudge per day max.
  const summary = { checked: 0, nudged: 0, skipped: 0 };
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const notes = await sbGet(
    `coach_session_notes?raw_transcript=not.is.null&post_session_analysis=is.null&created_at=lt.${encodeURIComponent(cutoff)}&select=id,coach_id,created_at`
  );
  if (!Array.isArray(notes)) return summary;

  const seenCoaches = new Set();
  for (const note of notes) {
    summary.checked += 1;
    try {
      if (!note || !note.coach_id || seenCoaches.has(note.coach_id)) {
        summary.skipped += 1;
        continue;
      }
      seenCoaches.add(note.coach_id);
      const coachRows = await sbGet(
        `coach_profiles?id=eq.${encodeURIComponent(note.coach_id)}&select=id,user_email,display_name,full_name&limit=1`
      );
      const coach = Array.isArray(coachRows) && coachRows[0];
      if (!coach || !coach.user_email) {
        summary.skipped += 1;
        continue;
      }
      if (await alreadyNudged(coach.user_email, NUDGE.SESSION_MISSING_CLARITY_24H, 1)) {
        summary.skipped += 1;
        continue;
      }
      const name = firstName(coach.display_name || coach.full_name);
      const text =
        `Hi ${name},\n\n` +
        `You uploaded a transcript but haven't run Coach Clarity yet. It takes about 2 minutes and gives you a full post-session breakdown — the patterns you noticed, the moves you made, and where your client opened up. You might head to your dashboard whenever you have a quiet minute.\n\n` +
        `— The Coach Clarity team`;
      await sendEmail({
        to: coach.user_email,
        subject: 'You have a session ready for Coach Clarity',
        text,
        linkUrl: DASHBOARD_COACH,
        linkLabel: 'Open your coach dashboard',
      });
      await logNudge(coach.user_email, NUDGE.SESSION_MISSING_CLARITY_24H, {
        session_id: note.id,
      });
      summary.nudged += 1;
    } catch (err) {
      console.error('intervention3 error for note:', note && note.id, err.message);
      summary.skipped += 1;
    }
  }
  return summary;
}

async function intervention4ClientNoBooking48h() {
  const summary = { checked: 0, nudged: 0, skipped: 0 };
  const courtesy = { checked: 0, nudged: 0, skipped: 0 };
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const clients = await sbGet(
    `explorer_profiles?created_at=lt.${encodeURIComponent(cutoff)}&select=id,email,display_name,created_at,referral_source,referral_utm`
  );
  if (!Array.isArray(clients)) return { summary, courtesy };

  for (const client of clients) {
    summary.checked += 1;
    try {
      if (!client || !client.email) {
        summary.skipped += 1;
        continue;
      }
      const email = client.email.toLowerCase();
      const bookings = await sbGet(
        `coach_bookings?client_email=eq.${encodeURIComponent(email)}&limit=1&select=id,coach_id`
      );
      if (Array.isArray(bookings) && bookings.length > 0) {
        summary.skipped += 1;
        continue;
      }
      if (await alreadyNudged(email, NUDGE.CLIENT_NO_BOOKING_48H, 7)) {
        summary.skipped += 1;
        continue;
      }
      const name = firstName(client.display_name);
      const text =
        `Hi ${name},\n\n` +
        `Welcome to ineedcoaching.org — your coaching space is ready and waiting. Coaching here is about building continuity between sessions so the work actually sticks. Whenever you're ready, you might reach out to your coach or explore your dashboard to see what's there.\n\n` +
        `Warmly,\nKimberly`;
      await sendEmail({
        to: email,
        subject: 'Your coaching space is ready',
        text,
        linkUrl: DASHBOARD_CLIENT,
        linkLabel: 'Open your dashboard',
      });
      await logNudge(email, NUDGE.CLIENT_NO_BOOKING_48H, { explorer_id: client.id });
      summary.nudged += 1;

      // Courtesy notification: try to resolve an assigned coach.
      // explorer_profiles has no coach FK; zero bookings already filtered out; so
      // the only remaining signal is referral_source / referral_utm — expected to
      // encode a coach slug when present. If we can't resolve, skip silently.
      courtesy.checked += 1;
      try {
        const slug = (client.referral_source || client.referral_utm || '').trim();
        if (!slug) {
          courtesy.skipped += 1;
          continue;
        }
        const coachRows = await sbGet(
          `coach_profiles?slug=eq.${encodeURIComponent(slug)}&select=id,user_email,display_name,full_name&limit=1`
        );
        const coach = Array.isArray(coachRows) && coachRows[0];
        if (!coach || !coach.user_email) {
          courtesy.skipped += 1;
          continue;
        }
        if (await alreadyNudged(coach.user_email, NUDGE.COACH_CLIENT_NUDGE_COURTESY, 7)) {
          courtesy.skipped += 1;
          continue;
        }
        const coachFirst = firstName(coach.display_name || coach.full_name);
        const clientFull = client.display_name || email;
        const clientFirst = firstName(client.display_name || email);
        const ctext =
          `Hi ${coachFirst},\n\n` +
          `Just a heads up — we sent ${clientFull} a warm welcome email encouraging them to book their first session with you. You may want to reach out personally as well.\n\n` +
          `— The ineedcoaching team`;
        await sendEmail({
          to: coach.user_email,
          subject: `We sent ${clientFirst} a welcome note`,
          text: ctext,
          linkUrl: DASHBOARD_COACH,
          linkLabel: 'Open your coach dashboard',
        });
        await logNudge(coach.user_email, NUDGE.COACH_CLIENT_NUDGE_COURTESY, {
          client_email: email,
          explorer_id: client.id,
        });
        courtesy.nudged += 1;
      } catch (cerr) {
        console.error('courtesy error for client:', client && client.id, cerr.message);
        courtesy.skipped += 1;
      }
    } catch (err) {
      console.error('intervention4 error for client:', client && client.id, err.message);
      summary.skipped += 1;
    }
  }
  return { summary, courtesy };
}

// ---------- handler ----------

export default async function handler(req, res) {
  // Auth: if CRON_SECRET is set, require matching Bearer token.
  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret) {
    const auth = req.headers && req.headers.authorization;
    if (auth !== `Bearer ${expectedSecret}`) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  } else {
    console.warn('CRON_SECRET not set — accepting unauthenticated cron invocation');
  }

  if (!SERVICE_KEY) {
    return res.status(500).json({ ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY missing' });
  }
  if (!RESEND_KEY) {
    return res.status(500).json({ ok: false, error: 'RESEND_API_KEY missing' });
  }

  const summary = {
    intervention1: { checked: 0, nudged: 0, skipped: 0 },
    intervention2: { checked: 0, nudged: 0, skipped: 0 },
    intervention3: { checked: 0, nudged: 0, skipped: 0 },
    intervention4: { checked: 0, nudged: 0, skipped: 0 },
    courtesyNotifications: { checked: 0, nudged: 0, skipped: 0 },
  };

  try {
    summary.intervention1 = await intervention1CoachNoSession5d();
  } catch (err) {
    console.error('intervention1 top-level failed:', err.message);
  }
  try {
    summary.intervention2 = await intervention2CoachInactive10d();
  } catch (err) {
    console.error('intervention2 top-level failed:', err.message);
  }
  try {
    summary.intervention3 = await intervention3SessionMissingClarity24h();
  } catch (err) {
    console.error('intervention3 top-level failed:', err.message);
  }
  try {
    const { summary: s4, courtesy } = await intervention4ClientNoBooking48h();
    summary.intervention4 = s4;
    summary.courtesyNotifications = courtesy;
  } catch (err) {
    console.error('intervention4 top-level failed:', err.message);
  }

  return res.status(200).json({ ok: true, summary });
}
