// Bug report intake endpoint.
//
// Accepts POST { description, reporter_email, page_url, posted_from_site,
//                user_agent, screen_size, logged_in_email }
// from any of the ineedcoaching / ineedtherapy / ineedrecovery origins
// (cross-origin enabled via Origin allowlist below). Writes to the
// bug_reports table with a service-role insert, then fires a Resend
// email to admin@sprixle.com with reporter_email as reply_to when
// the explorer left one.
//
// If the DB insert succeeds but the email fails we still return 200 —
// the row is the source of truth. DB failure returns 500.

export default async function handler(req, res) {
  // CORS: allowlist real production + Vercel previews. Omit the header
  // entirely when the origin doesn't match so the browser rejects.
  const allowedOrigins = [
    'https://www.ineedcoaching.org',
    'https://www.ineedtherapy.org',
    'https://www.ineedrecovery.org',
    'https://ineedcoaching.org',
    'https://ineedtherapy.org',
    'https://ineedrecovery.org'
  ];
  const origin = req.headers.origin || '';
  let originAllowed = false;
  if (allowedOrigins.indexOf(origin) !== -1) {
    originAllowed = true;
  } else if (origin === 'null') {
    originAllowed = true;
  } else if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) {
    originAllowed = true;
  }
  if (originAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured: SUPABASE_SERVICE_ROLE_KEY missing' });
  if (!RESEND_API_KEY) return res.status(500).json({ error: 'Server not configured: RESEND_API_KEY missing' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const raw = body || {};

    const description = (raw.description || '').toString().trim();
    if (!description) return res.status(400).json({ error: 'description required' });
    if (description.length > 1500) return res.status(400).json({ error: 'description too long (max 1500 chars)' });

    const allowedSites = ['coaching', 'therapy', 'recovery', 'unknown'];
    let site = (raw.posted_from_site || '').toString().toLowerCase();
    if (allowedSites.indexOf(site) === -1) site = 'unknown';

    const reporterEmail = (raw.reporter_email || '').toString().trim() || null;
    const pageUrl = (raw.page_url || '').toString().trim() || null;
    const userAgent = (raw.user_agent || '').toString().trim() || null;
    const screenSize = (raw.screen_size || '').toString().trim() || null;
    const loggedInEmail = (raw.logged_in_email || '').toString().trim() || null;

    const insertPayload = {
      description: description,
      reporter_email: reporterEmail,
      page_url: pageUrl,
      posted_from_site: site,
      user_agent: userAgent,
      screen_size: screenSize,
      logged_in_email: loggedInEmail
    };

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/bug_reports`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify(insertPayload)
    });
    if (!insertRes.ok) {
      const errText = await insertRes.text().catch(() => '');
      console.error('[submit-bug-report] insert failed', insertRes.status, errText);
      return res.status(500).json({ error: 'DB insert failed', detail: errText });
    }
    const inserted = await insertRes.json().catch(() => []);
    const row = Array.isArray(inserted) && inserted[0] ? inserted[0] : null;
    const rowId = row && row.id ? row.id : null;

    // Email send — best-effort. Failure here doesn't roll back the DB row.
    let emailed = false;
    try {
      const emailValidPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const replyTo = reporterEmail && emailValidPattern.test(reporterEmail) ? reporterEmail : null;

      const subject = '🐛 Bug report from ' + site + '.org';
      const html = buildEmailHtml({
        description,
        reporterEmail,
        loggedInEmail,
        pageUrl,
        userAgent,
        screenSize,
        site,
        rowId,
        createdAt: (row && row.created_at) || new Date().toISOString()
      });

      const resendBody = {
        from: 'ineedcoaching.org <hello@ineedcoaching.org>',
        to: ['admin@sprixle.com'],
        subject: subject,
        html: html
      };
      if (replyTo) resendBody.reply_to = replyTo;

      const sendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(resendBody)
      });
      if (sendRes.ok) {
        emailed = true;
      } else {
        const err = await sendRes.text().catch(() => '');
        console.error('[submit-bug-report] Resend error', sendRes.status, err);
      }
    } catch (e) {
      console.error('[submit-bug-report] email send threw:', e);
    }

    return res.status(200).json({ ok: true, id: rowId, emailed });
  } catch (e) {
    console.error('submit-bug-report error:', e);
    return res.status(500).json({ error: e.message });
  }
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildEmailHtml(ctx) {
  const dash = '<span style="color:#bbb;">—</span>';
  const row = function(label, val, opts) {
    opts = opts || {};
    const cell = val
      ? '<td style="padding:6px 0;' + (opts.mono ? 'font-family:ui-monospace,Menlo,monospace;font-size:0.72rem;' : '') + (opts.break ? 'word-break:break-all;' : '') + '">' + (opts.html || val) + '</td>'
      : '<td style="padding:6px 0;">' + dash + '</td>';
    return '<tr><td style="padding:6px 16px 6px 0;color:#6b6b60;width:130px;font-size:0.78rem;">' + label + '</td>' + cell + '</tr>';
  };
  const safeUrl = ctx.pageUrl ? escapeHtml(ctx.pageUrl) : '';
  return ''
    + '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#1a1a2e;">'
    + '<h1 style="font-family:\'Cormorant Garamond\',Georgia,serif;font-size:1.5rem;font-weight:600;margin:0 0 6px;color:#1a3a52;">🐛 New bug report</h1>'
    + '<p style="font-size:0.85rem;color:#6b6b60;margin:0 0 20px;">From ' + escapeHtml(ctx.site) + '.org · ' + escapeHtml(ctx.createdAt) + '</p>'
    + '<div style="background:#f7f4ee;border-left:3px solid #1a3a52;padding:16px 20px;border-radius:6px;margin-bottom:22px;">'
    + '<div style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#6b6b60;margin-bottom:8px;">What happened</div>'
    + '<div style="font-size:0.95rem;line-height:1.6;white-space:pre-wrap;">' + escapeHtml(ctx.description) + '</div>'
    + '</div>'
    + '<table style="width:100%;border-collapse:collapse;font-size:0.82rem;color:#1a1a2e;">'
    + row('Page', safeUrl, { html: safeUrl ? '<a href="' + safeUrl + '" style="color:#1a3a52;text-decoration:underline;word-break:break-all;">' + safeUrl + '</a>' : null, break: true })
    + row('Reporter', ctx.reporterEmail ? escapeHtml(ctx.reporterEmail) : null)
    + row('Logged in as', ctx.loggedInEmail ? escapeHtml(ctx.loggedInEmail) : null)
    + row('Site', ctx.site ? escapeHtml(ctx.site) : null)
    + row('Screen size', ctx.screenSize ? escapeHtml(ctx.screenSize) : null)
    + row('User agent', ctx.userAgent ? escapeHtml(ctx.userAgent) : null, { break: true })
    + row('Row ID', ctx.rowId ? escapeHtml(ctx.rowId) : null, { mono: true })
    + '</table>'
    + '</div>';
}
