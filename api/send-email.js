// Requires RESEND_API_KEY env var in Vercel project settings

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY env var is not set. Add it in Vercel project settings.');
    return res.status(500).json({ error: 'Email not configured. RESEND_API_KEY missing.' });
  }

  try {
    const { to, subject, html, text } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    if (!to || !subject || (!html && !text)) {
      return res.status(400).json({ error: 'Missing required fields: to, subject, html or text' });
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'ineedcoaching.org <noreply@ineedcoaching.org>',
        to: to,
        subject: subject,
        html: html || undefined,
        text: text || undefined
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Resend error:', response.status, JSON.stringify(data));
      return res.status(500).json({ error: data });
    }

    return res.status(200).json({ success: true, id: data.id });
  } catch (e) {
    console.error('send-email error:', e);
    return res.status(500).json({ error: e.message });
  }
}
