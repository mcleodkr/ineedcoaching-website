// POST { coachId, recommenderEmail, recommenderName, recommenderTitle, recommenderCompany, relationship, personalNote }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { coachId, recommenderEmail, recommenderName, recommenderTitle, recommenderCompany, relationship, personalNote } = body;
    if (!coachId || !recommenderEmail) return res.status(400).json({ error: 'Missing coachId or recommenderEmail' });

    const coachRes = await fetch(`${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${coachId}&select=display_name,full_name`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    const coaches = await coachRes.json();
    const coachName = (coaches && coaches[0]) ? (coaches[0].display_name || coaches[0].full_name) : 'A Coach';

    const token = 'rc_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 12);

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/coach_recommendations`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({
        coach_id: coachId, recommender_email: recommenderEmail, recommender_name: recommenderName || null,
        recommender_title: recommenderTitle || null, recommender_company: recommenderCompany || null,
        relationship: relationship || null, personal_note: personalNote || null, token, status: 'pending'
      })
    });
    if (!insertRes.ok) { const err = await insertRes.text(); return res.status(500).json({ error: err }); }

    const origin = req.headers.host ? `https://${req.headers.host}` : 'https://www.ineedcoaching.org';
    const recUrl = `${origin}/recommendation.html?token=${token}`;
    const noteHtml = personalNote ? `<div style="background:#f7f4ee;border-radius:8px;padding:16px 20px;margin:16px 0;font-size:0.92rem;line-height:1.6;color:#1a3a52;font-style:italic;">"${personalNote}"</div>` : '';

    await fetch(`${origin}/api/send-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: recommenderEmail,
        subject: `${coachName} is requesting a professional recommendation`,
        html: `<div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#1a3a52;">
          <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:1.6rem;color:#1a3a52;margin-bottom:16px;">${coachName} values your perspective</h1>
          <p style="font-size:0.95rem;line-height:1.6;color:#6b6b60;">Hi ${recommenderName || 'there'},</p>
          <p style="font-size:0.95rem;line-height:1.6;color:#6b6b60;">${coachName} would be honored to have your professional recommendation. Would you take a moment to share your experience?</p>
          ${noteHtml}
          <div style="margin:24px 0;"><a href="${recUrl}" style="display:inline-block;background:#c49a3c;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:0.95rem;">Write a Recommendation &rarr;</a></div>
          <p style="font-size:0.82rem;color:#6b6b60;margin-top:24px;">&mdash; <a href="https://www.ineedcoaching.org" style="color:#c49a3c;text-decoration:none;font-weight:600;">ineedcoaching.org</a></p>
        </div>`
      })
    });

    return res.status(200).json({ success: true, token, recUrl });
  } catch (e) {
    console.error('[request-recommendation] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
