// Requires MAILTRAP_TOKEN env var in Vercel project settings
// Mailtrap Send API: https://api-docs.mailtrap.io/docs/mailtrap-api-docs/send-email

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const MAILTRAP_TOKEN = process.env.MAILTRAP_TOKEN;
  if (!MAILTRAP_TOKEN) {
    console.error('MAILTRAP_TOKEN env var is not set. Add it in Vercel project settings.');
    return res.status(500).json({ error: 'Email service not configured. MAILTRAP_TOKEN missing.' });
  }

  try {
    const { to, subject, html, text } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    if (!to || !subject || (!html && !text)) {
      return res.status(400).json({ error: 'Missing required fields: to, subject, html or text' });
    }

    const mailRes = await fetch('https://send.api.mailtrap.io/api/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MAILTRAP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: { email: 'noreply@ineedcoaching.org', name: 'ineedcoaching.org' },
        to: [{ email: to }],
        subject: subject,
        html: html || undefined,
        text: text || undefined
      })
    });

    if (!mailRes.ok) {
      const errBody = await mailRes.text();
      console.error('Mailtrap error:', mailRes.status, errBody);
      return res.status(502).json({ error: 'Email delivery failed', details: errBody });
    }

    const result = await mailRes.json();
    return res.status(200).json({ sent: true, message_id: result.message_ids?.[0] });
  } catch (e) {
    console.error('send-email error:', e);
    return res.status(500).json({ error: e.message });
  }
}
