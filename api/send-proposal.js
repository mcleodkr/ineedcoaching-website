export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { to, coachName, clientName, company, proposalUrl } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!to || !proposalUrl) return res.status(400).json({ error: 'Missing to or proposalUrl' });

    const displayClient = clientName || company || 'there';
    const displayCoach = coachName || 'Your coach';
    const subject = `Your proposal from ${displayCoach}`;

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f7f4ee;font-family:Georgia,'Times New Roman',serif;">
<div style="max-width:580px;margin:0 auto;padding:32px 24px;">

  <div style="text-align:center;margin-bottom:32px;">
    <span style="font-size:1.2rem;color:#1a3a52;font-weight:700;"><span style="color:#c49a3c;font-style:italic;">i</span>need<span style="color:#c49a3c;font-style:italic;">coaching</span>.org</span>
  </div>

  <div style="background:#ffffff;border:1px solid #e0ddd5;border-radius:12px;padding:32px;margin:20px 0;">
    <div style="font-size:1rem;color:#1a3a52;line-height:1.7;margin-bottom:24px;">
      Hi ${esc(displayClient)},<br><br>
      ${esc(displayCoach)} has sent you a proposal. Click below to view the details and respond.
    </div>

    <div style="text-align:center;">
      <a href="${esc(proposalUrl)}" style="display:inline-block;background:#1a3a52;color:#c49a3c;padding:14px 36px;border-radius:8px;font-family:sans-serif;font-size:0.9rem;font-weight:700;text-decoration:none;letter-spacing:0.03em;">View Proposal</a>
    </div>
  </div>

  <div style="text-align:center;margin-top:28px;padding-top:20px;border-top:1px solid #e0ddd5;">
    <span style="font-size:0.8rem;color:#1a3a52;font-weight:700;"><span style="color:#c49a3c;font-style:italic;">i</span>need<span style="color:#c49a3c;font-style:italic;">coaching</span>.org</span>
    <div style="font-size:0.68rem;color:#8a8a9a;margin-top:6px;font-family:sans-serif;">Connecting people with the coaching they need</div>
  </div>

</div>
</body>
</html>`;

    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_API_KEY) {
      console.error('RESEND_API_KEY not set');
      return res.status(500).json({ error: 'Email not configured' });
    }

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'ineedcoaching.org <proposals@ineedcoaching.org>',
        to: [to],
        subject: subject,
        html: html
      })
    });

    const emailData = await emailRes.json();
    if (!emailRes.ok) {
      console.error('Resend error:', emailData);
      return res.status(500).json({ error: 'Email failed to send' });
    }

    return res.status(200).json({ ok: true, to, subject });
  } catch (e) {
    console.error('send-proposal error:', e);
    return res.status(500).json({ error: e.message });
  }
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
