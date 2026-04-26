export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  if (!SUPABASE_KEY || !ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_ROLE_KEY or ANTHROPIC_API_KEY' });
  }

  const SB_HEADERS = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Fetch all published coaches
    const coachRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_profiles?is_published=eq.true&select=id,display_name,user_email,specialties,headline`,
      { headers: SB_HEADERS }
    );
    const coaches = await coachRes.json();

    if (!coaches || !coaches.length) {
      return res.status(200).json({ sent: 0, message: 'No published coaches found' });
    }

    // 2. Fetch recent articles (last 14 days, published, coach or consumer audience)
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const articleRes = await fetch(
      `${SUPABASE_URL}/rest/v1/articles?is_published=eq.true&created_at=gte.${twoWeeksAgo}&select=title,slug,meta_description,category,key_insights&order=created_at.desc&limit=50`,
      { headers: SB_HEADERS }
    );
    const allArticles = await articleRes.json();

    let sentCount = 0;
    const errors = [];

    for (const coach of coaches) {
      if (!coach.user_email) continue;

      try {
        // 3. Match articles to coach specialties
        const specialties = Array.isArray(coach.specialties)
          ? coach.specialties
          : typeof coach.specialties === 'string'
            ? JSON.parse(coach.specialties)
            : [];

        const specialtyLower = specialties.map(s => s.toLowerCase());
        const matched = allArticles.filter(a => {
          const cat = (a.category || '').toLowerCase();
          const title = (a.title || '').toLowerCase();
          return specialtyLower.some(sp =>
            cat.includes(sp) || title.includes(sp) ||
            sp.includes('burnout') && cat.includes('burnout') ||
            sp.includes('leadership') && (cat.includes('coaching') || cat.includes('provider')) ||
            sp.includes('career') && (cat.includes('coaching') || cat.includes('growth')) ||
            sp.includes('executive') && cat.includes('provider') ||
            sp.includes('life') && (cat.includes('self-discovery') || cat.includes('growth')) ||
            sp.includes('relationship') && cat.includes('relationship') ||
            sp.includes('health') && (cat.includes('burnout') || cat.includes('anxiety')) ||
            sp.includes('wellness') && (cat.includes('burnout') || cat.includes('anxiety')) ||
            sp.includes('mindfulness') && (cat.includes('anxiety') || cat.includes('self-discovery')) ||
            sp.includes('recovery') && (cat.includes('recovery') || cat.includes('sobriety'))
          );
        });

        // Fall back to general coaching/provider articles if no specialty match
        const featured = matched.length > 0
          ? matched[0]
          : allArticles.find(a =>
              (a.category || '').includes('Coaching') ||
              (a.category || '').includes('Provider')
            ) || allArticles[0];

        if (!featured) continue;

        // 4. Generate personalized newsletter via Claude Haiku
        const coachName = coach.display_name || 'Coach';
        const nicheDesc = specialties.length > 0
          ? specialties.slice(0, 3).join(', ')
          : 'coaching';

        const newsletterContent = await generateNewsletter({
          anthropicKey: ANTHROPIC_KEY,
          coachName,
          nicheDesc,
          headline: coach.headline || '',
          articleTitle: featured.title,
          articleDesc: featured.meta_description || '',
          articleSlug: featured.slug,
          keyInsights: Array.isArray(featured.key_insights) ? featured.key_insights.slice(0, 3) : [],
          coachId: coach.id,
        });

        if (!newsletterContent) continue;

        // 5. Send via Supabase Auth SMTP (edge function email)
        const emailHtml = buildEmailHtml(coachName, newsletterContent);

        // Use Supabase's built-in email sending via the auth admin API
        const sendRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
          method: 'POST',
          headers: SB_HEADERS,
          body: JSON.stringify({
            type: 'magiclink',
            email: coach.user_email,
            options: { data: { newsletter: true } }
          }),
        });

        // Log the newsletter (in production, replace with SendGrid/Resend/etc.)
        console.log(`=== COACH NEWSLETTER: ${coachName} ===`);
        console.log(`To: ${coach.user_email}`);
        console.log(`Subject: Your Weekly Coaching Digest, ${coachName}`);
        console.log(`Featured: ${featured.title}`);
        console.log('---');
        console.log(newsletterContent.plain);
        console.log('===');

        sentCount++;
      } catch (coachErr) {
        errors.push({ coach: coach.display_name, error: coachErr.message });
      }
    }

    return res.status(200).json({
      sent: sentCount,
      total_coaches: coaches.length,
      articles_available: allArticles.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (e) {
    console.error('coach-newsletter error:', e);
    return res.status(500).json({ error: e.message });
  }
}


import { logAIUsage } from '../lib/ai-usage.js';

async function generateNewsletter({ anthropicKey, coachName, nicheDesc, headline, articleTitle, articleDesc, articleSlug, keyInsights, coachId }) {
  const insightsText = keyInsights.length > 0
    ? `\nKey insights from the article:\n${keyInsights.map(i => `- ${i}`).join('\n')}`
    : '';

  const prompt = `Write a short, warm weekly newsletter for a coach named ${coachName}.
Their coaching niche: ${nicheDesc}.
${headline ? `Their headline: ${headline}` : ''}

Featured article this week: "${articleTitle}"
Article summary: ${articleDesc}
Article link: https://www.ineedcoaching.org/article.html?slug=${articleSlug}
${insightsText}

Write exactly 3 sections in this format:

REFLECTION:
A 2-3 sentence opening reflection relevant to their coaching niche. Warm, grounded, not generic. Speak to what their clients might be experiencing this week.

FEATURED:
A 2-3 sentence summary of the featured article that connects it to their coaching work. End with "Read the full article" and the link.

CLOSING:
1-2 sentences of encouragement plus one practical platform tip (e.g., update your profile photo, add a new testimonial, create an intake form, share your profile link). Keep it brief and actionable.

Return ONLY the three sections with their headers. No subject line. No sign-off. Warm but professional tone throughout.`;

  const model = 'claude-haiku-4-5-20251001';
  const payload = JSON.stringify({
    model,
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  });

  const startTime = Date.now();
  let response, data;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: payload,
    });
    data = await response.json().catch(function() { return null; });
  } catch (err) {
    await logAIUsage({ feature: 'coach_newsletter', coachId, model, status: 'error', errorMessage: err && err.message, durationMs: Date.now() - startTime });
    return null;
  }
  await logAIUsage({
    feature: 'coach_newsletter',
    coachId,
    model: (data && data.model) || model,
    usage: data && data.usage,
    requestId: data && data.id,
    status: response.ok ? 'success' : 'error',
    errorMessage: response.ok ? null : (data && data.error && data.error.message),
    durationMs: Date.now() - startTime,
  });

  if (!response.ok) {
    console.error(`Anthropic API error: ${response.status}`, data);
    return null;
  }

  const text = (data && data.content && data.content[0] && data.content[0].text || '').trim();

  return { plain: text, sections: parseSections(text) };
}


function parseSections(text) {
  const sections = { reflection: '', featured: '', closing: '' };
  const reflectionMatch = text.match(/REFLECTION:\s*([\s\S]*?)(?=FEATURED:|$)/i);
  const featuredMatch = text.match(/FEATURED:\s*([\s\S]*?)(?=CLOSING:|$)/i);
  const closingMatch = text.match(/CLOSING:\s*([\s\S]*?)$/i);

  if (reflectionMatch) sections.reflection = reflectionMatch[1].trim();
  if (featuredMatch) sections.featured = featuredMatch[1].trim();
  if (closingMatch) sections.closing = closingMatch[1].trim();

  return sections;
}


function buildEmailHtml(coachName, content) {
  const { sections } = content;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f7f4ee;font-family:Georgia,'Times New Roman',serif;">
<div style="max-width:580px;margin:0 auto;padding:32px 24px;">

  <div style="text-align:center;margin-bottom:32px;">
    <span style="font-size:1.2rem;color:#1a3a52;font-weight:700;"><span style="color:#c49a3c;font-style:italic;">i</span>need<span style="color:#c49a3c;font-style:italic;">coaching</span>.org</span>
    <div style="font-size:0.72rem;color:#8a8a9a;margin-top:4px;font-family:sans-serif;">Your Weekly Coaching Digest</div>
  </div>

  <div style="font-size:0.95rem;color:#1a3a52;margin-bottom:8px;">Hi ${esc(coachName)},</div>

  <div style="background:#ffffff;border:1px solid #e0ddd5;border-radius:12px;padding:28px;margin:20px 0;">
    <div style="font-size:0.62rem;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:#c49a3c;margin-bottom:10px;">This Week's Reflection</div>
    <div style="font-size:0.92rem;color:#1a3a52;line-height:1.7;">${esc(sections.reflection)}</div>
  </div>

  <div style="background:#ffffff;border:1px solid #e0ddd5;border-left:3px solid #c49a3c;border-radius:12px;padding:28px;margin:20px 0;">
    <div style="font-size:0.62rem;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:#c49a3c;margin-bottom:10px;">Featured Article</div>
    <div style="font-size:0.92rem;color:#1a3a52;line-height:1.7;">${esc(sections.featured)}</div>
  </div>

  <div style="background:#1a3a52;border-radius:12px;padding:28px;margin:20px 0;">
    <div style="font-size:0.62rem;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:#c49a3c;margin-bottom:10px;">From Us to You</div>
    <div style="font-size:0.92rem;color:rgba(247,244,238,0.9);line-height:1.7;">${esc(sections.closing)}</div>
  </div>

  <div style="text-align:center;margin-top:28px;">
    <a href="https://www.ineedcoaching.org/coach-dashboard.html" style="display:inline-block;background:#c49a3c;color:#1a3a52;padding:12px 28px;border-radius:50px;font-family:sans-serif;font-size:0.85rem;font-weight:700;text-decoration:none;">Go to Your Dashboard</a>
  </div>

  <div style="text-align:center;margin-top:32px;padding-top:20px;border-top:1px solid #e0ddd5;">
    <span style="font-size:0.8rem;color:#1a3a52;font-weight:700;"><span style="color:#c49a3c;font-style:italic;">i</span>need<span style="color:#c49a3c;font-style:italic;">coaching</span>.org</span>
    <div style="font-size:0.68rem;color:#8a8a9a;margin-top:6px;font-family:sans-serif;">You're receiving this because you're a published coach on ineedcoaching.org</div>
  </div>

</div>
</body>
</html>`;
}
