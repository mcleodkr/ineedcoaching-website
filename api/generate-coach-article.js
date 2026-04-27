// POST { coachId }
// Generates a coaching article using Claude based on coach's specialties

import { logAIUsage } from '../lib/ai-usage.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  if (!SUPABASE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { coachId } = body;
    if (!coachId) return res.status(400).json({ error: 'Missing coachId' });

    // Rate limit: 1 successful article per coach per rolling 7-day window.
    // Server-side gate only — no client trust. Filter on status='success'
    // so failed generations don't lock the coach out for a week. If the
    // telemetry query itself fails, fail OPEN — don't block coaches because
    // of a transient coach_ai_usage_log issue.
    const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const limitRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_ai_usage_log`
        + `?coach_id=eq.${coachId}`
        + `&feature=eq.coach_article`
        + `&status=eq.success`
        + `&created_at=gte.${encodeURIComponent(sevenDaysAgoIso)}`
        + `&select=created_at&order=created_at.desc&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (limitRes.ok) {
      const recent = await limitRes.json();
      if (Array.isArray(recent) && recent.length) {
        const lastAt = new Date(recent[0].created_at);
        const nextAt = new Date(lastAt.getTime() + 7 * 24 * 60 * 60 * 1000);
        const nextStr = nextAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        return res.status(429).json({
          error: `You can generate 1 article per week. Your next article will be available on ${nextStr}.`,
          next_available_at: nextAt.toISOString(),
        });
      }
    } else {
      console.warn('[generate-article] rate-limit lookup failed (failing open):', limitRes.status);
    }

    // Fetch coach profile
    const coachRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${coachId}&select=display_name,full_name,headline,bio,specialties`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const coaches = await coachRes.json();
    if (!coaches || !coaches.length) return res.status(404).json({ error: 'Coach not found' });

    const coach = coaches[0];
    const coachName = coach.display_name || coach.full_name || 'Coach';
    const specialties = Array.isArray(coach.specialties) ? coach.specialties.join(', ') : (coach.specialties || 'life coaching');
    const headline = coach.headline || '';

    console.log('[generate-article] Generating for:', coachName, 'specialties:', specialties);

    const model = 'claude-sonnet-4-6';
    const startTime = Date.now();
    let claudeRes, claudeData;
    try {
      claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          system: `You are a content writer for a professional coaching platform. Write articles that are practical, warm, and actionable. Use coaching language — forward-focused, strength-based, empowering. Avoid clinical or academic tone. Write for potential coaching clients who are exploring personal or professional growth.

Return ONLY valid JSON with exactly these keys:
- "title": A compelling, specific article title (not generic)
- "body": The full article in clean HTML (use <h2>, <p>, <ul>, <li> tags). Approximately 600 words. Include a brief introduction, 3-4 practical sections with subheadings, and a closing thought.
- "meta_description": A 150-character SEO description
- "category": One of: Leadership, Wellness, Career, Relationships, Personal Growth, Business, Mindset
- "tags": Array of 3-5 relevant lowercase tags`,
          messages: [{
            role: 'user',
            content: `Write a coaching article for ${coachName}, who specializes in ${specialties}. ${headline ? 'Their tagline is: "' + headline + '".' : ''} Pick a specific, relevant topic that would attract their ideal client. Make it practical and immediately useful.`
          }]
        })
      });
      claudeData = await claudeRes.json().catch(function() { return null; });
    } catch (err) {
      await logAIUsage({ feature: 'coach_article', coachId, model, status: 'error', errorMessage: err && err.message, durationMs: Date.now() - startTime });
      throw err;
    }
    await logAIUsage({
      feature: 'coach_article',
      coachId,
      model: (claudeData && claudeData.model) || model,
      usage: claudeData && claudeData.usage,
      requestId: claudeData && claudeData.id,
      status: claudeRes.ok ? 'success' : 'error',
      errorMessage: claudeRes.ok ? null : (claudeData && claudeData.error && claudeData.error.message),
      durationMs: Date.now() - startTime,
    });

    if (!claudeRes.ok) {
      console.error('[generate-article] Claude error:', claudeRes.status, claudeData);
      return res.status(502).json({ error: 'AI generation failed' });
    }

    const responseText = claudeData && claudeData.content?.[0]?.text || '';

    let article;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      article = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(responseText);
    } catch (parseErr) {
      console.error('[generate-article] JSON parse failed:', parseErr.message);
      return res.status(500).json({ error: 'Failed to parse AI response' });
    }

    // Generate slug
    const slug = (article.title || 'article')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 80);

    // Save to articles table
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/articles`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        author_coach_id: coachId,
        title: article.title,
        slug: slug + '-' + Date.now().toString(36),
        content: article.body,
        meta_description: article.meta_description || null,
        category: article.category || null,
        tags: Array.isArray(article.tags) ? article.tags : null,
        is_published: false,
        site: 'ineedcoaching',
        audience: 'coaching-consumer'
      })
    });

    if (!insertRes.ok) {
      const err = await insertRes.text();
      console.error('[generate-article] Insert failed:', err);
      return res.status(500).json({ error: 'Failed to save article' });
    }

    const saved = await insertRes.json();
    console.log('[generate-article] Article saved:', saved[0]?.id);

    return res.status(200).json({
      success: true,
      articleId: saved[0]?.id,
      title: article.title
    });
  } catch (e) {
    console.error('[generate-article] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
