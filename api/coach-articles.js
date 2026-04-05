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
      `${SUPABASE_URL}/rest/v1/coach_profiles?is_published=eq.true&select=id,display_name,specialties,headline,bio`,
      { headers: SB_HEADERS }
    );
    const coaches = await coachRes.json();

    if (!coaches || !coaches.length) {
      return res.status(200).json({ generated: 0, message: 'No published coaches found' });
    }

    // 2. Fetch existing article slugs to prevent duplicates
    const existRes = await fetch(
      `${SUPABASE_URL}/rest/v1/articles?site=eq.ineedcoaching&select=slug&limit=500`,
      { headers: SB_HEADERS }
    );
    const existing = await existRes.json();
    const existingSlugs = new Set((existing || []).map(a => a.slug));

    let generated = 0;
    const errors = [];

    for (const coach of coaches) {
      try {
        const specialties = normalizeArray(coach.specialties);
        const primaryNiche = specialties[0] || 'Life Coaching';
        const coachName = coach.display_name || 'Coach';

        // 3. Generate article via Claude Haiku
        const article = await generateArticle({
          anthropicKey: ANTHROPIC_KEY,
          coachName,
          primaryNiche,
          allSpecialties: specialties,
          headline: coach.headline || '',
          bio: (coach.bio || '').slice(0, 300),
        });

        if (!article) {
          errors.push({ coach: coachName, error: 'Generation returned null' });
          continue;
        }

        // Deduplicate slug
        let slug = article.slug;
        const ts = Date.now().toString(36);
        slug = slug + '-' + ts;
        if (existingSlugs.has(slug)) {
          slug = slug + '-' + Math.random().toString(36).slice(2, 6);
        }

        // 4. Save to Supabase as draft
        const payload = {
          title: article.title,
          slug: slug,
          meta_description: article.meta_description,
          content: article.content,
          quick_answer: article.quick_answer || '',
          key_insights: article.key_insights || [],
          faq_schema: article.faq_schema || [],
          seo_keywords: article.focus_keyword || primaryNiche,
          category: 'Coaching & Growth',
          audience: 'coaching_consumer',
          author_coach_id: coach.id,
          site: 'ineedcoaching',
          is_published: false,
          source_trend: `weekly-coach-article:${primaryNiche}`,
        };

        const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/articles`, {
          method: 'POST',
          headers: { ...SB_HEADERS, Prefer: 'return=representation' },
          body: JSON.stringify(payload),
        });

        if (insertRes.ok) {
          existingSlugs.add(slug);
          generated++;
          console.log(`[OK] Draft article for ${coachName}: ${article.title}`);
        } else {
          const errText = await insertRes.text();
          errors.push({ coach: coachName, error: errText });
          console.log(`[FAIL] ${coachName}: ${errText}`);
        }
      } catch (coachErr) {
        errors.push({ coach: coach.display_name, error: coachErr.message });
      }
    }

    return res.status(200).json({
      generated,
      total_coaches: coaches.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (e) {
    console.error('coach-articles error:', e);
    return res.status(500).json({ error: e.message });
  }
}


function normalizeArray(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch (_) { return [val]; }
  }
  return [];
}


function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70);
}


async function generateArticle({ anthropicKey, coachName, primaryNiche, allSpecialties, headline, bio }) {
  const specialtiesList = allSpecialties.slice(0, 4).join(', ');

  const prompt = `You are a ghostwriter for ${coachName}, a coach specializing in ${specialtiesList}.
${headline ? `Their professional headline: "${headline}"` : ''}
${bio ? `About them: ${bio}` : ''}

Write a thought leadership article in their voice — warm, knowledgeable, grounded. Not generic. Not preachy. Like a coach writing for potential clients who are considering coaching for the first time.

The article should relate to ${primaryNiche} and speak to the kind of person who would seek this type of coaching.

Return ONLY valid JSON with these exact fields:
{
  "title": "SEO-optimized title (50-65 characters)",
  "slug": "url-friendly-slug-max-60-chars",
  "meta_description": "Compelling meta description with direct answer (150-160 characters)",
  "focus_keyword": "primary SEO keyword phrase for this article",
  "quick_answer": "2-3 sentence direct answer to the article's core question. Written to be quoted by AI search engines.",
  "key_insights": ["insight 1", "insight 2", "insight 3", "insight 4", "insight 5"],
  "content": "Full article HTML. Structure: intro paragraph, 3-5 sections with <h2> headings as questions people actually search, practical advice under each, then an FAQ section with 3-4 Q&As in <h2>FAQ</h2> format. Use <h2>, <p>, <ul>, <li>, <blockquote> tags only. No <h1>. 600-800 words.",
  "faq_schema": [
    {"question": "...", "answer": "..."},
    {"question": "...", "answer": "..."},
    {"question": "...", "answer": "..."}
  ]
}

key_insights: REQUIRED. 3-5 short, quotable sentences capturing the article's core truths.

faq_schema: REQUIRED. 3 question-answer pairs formatted for AI search engine extraction. Each answer should be 1-2 sentences, direct and factual.

Voice rules:
- Write as if ${coachName} is speaking from experience
- Conversational and direct, not clinical or corporate
- Every section should have actionable takeaways
- Never start with "In today's" or "As a coach"
- No em dashes

IMPORTANT: Return ONLY valid JSON. No markdown code fences. No extra text.`;

  const payload = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: payload,
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`Anthropic API error: ${response.status} ${errText}`);
    return null;
  }

  const data = await response.json();
  let raw = data.content[0].text.trim();

  // Strip markdown fences if present
  raw = raw.replace(/^```(?:json)?\s*/g, '').replace(/\s*```$/g, '');

  try {
    const article = JSON.parse(raw);
    // Ensure slug is clean
    article.slug = slugify(article.slug || article.title);
    return article;
  } catch (parseErr) {
    console.error('JSON parse failed:', parseErr.message);
    return null;
  }
}
