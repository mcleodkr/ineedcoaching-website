export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_ROLE_KEY' });
  if (!OPENAI_API_KEY) return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { article_id, title, category } = body;
    if (!article_id || !title) return res.status(400).json({ error: 'Missing article_id or title' });

    const SB_HEADERS = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    };

    // 1. Generate image via OpenAI dall-e-3
    const prompt = `Editorial hero image for an article titled '${title}' about ${category || 'coaching'}. Warm professional photography style. Color palette: navy blue #1a3a52, gold #c49a3c, and cream. No text, no words, no letters in the image. Cinematic lighting, high quality.`;

    const openaiRes = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt,
        n: 1,
        size: '1792x1024',
        quality: 'standard',
      }),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error('OpenAI image error:', openaiRes.status, errText);
      return res.status(502).json({ error: 'Failed to generate image' });
    }

    const openaiData = await openaiRes.json();
    const imageItem = openaiData.data[0];

    let publicUrl = '';

    // 2. Upload to Supabase Storage for permanent hosting
    if (imageItem.b64_json) {
      const imageBuffer = Buffer.from(imageItem.b64_json, 'base64');
      const filePath = `heroes/${article_id}.png`;

      const uploadRes = await fetch(
        `${SUPABASE_URL}/storage/v1/object/article-images/${filePath}`,
        {
          method: 'POST',
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'image/png',
            'x-upsert': 'true',
          },
          body: imageBuffer,
        }
      );

      if (uploadRes.ok) {
        publicUrl = `${SUPABASE_URL}/storage/v1/object/public/article-images/${filePath}`;
      } else {
        console.error('Storage upload failed:', await uploadRes.text());
        // Fall back to temporary OpenAI URL if available
        publicUrl = imageItem.url || '';
      }
    } else if (imageItem.url) {
      // If OpenAI returned a URL, download and re-upload for persistence
      const imgFetch = await fetch(imageItem.url);
      if (imgFetch.ok) {
        const imgBuffer = Buffer.from(await imgFetch.arrayBuffer());
        const filePath = `heroes/${article_id}.png`;

        const uploadRes = await fetch(
          `${SUPABASE_URL}/storage/v1/object/article-images/${filePath}`,
          {
            method: 'POST',
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'image/png',
              'x-upsert': 'true',
            },
            body: imgBuffer,
          }
        );

        if (uploadRes.ok) {
          publicUrl = `${SUPABASE_URL}/storage/v1/object/public/article-images/${filePath}`;
        } else {
          console.error('Storage upload failed:', await uploadRes.text());
          publicUrl = imageItem.url;
        }
      } else {
        publicUrl = imageItem.url;
      }
    }

    if (!publicUrl) {
      return res.status(500).json({ error: 'No image URL produced' });
    }

    // 3. Save image_url to articles table
    await fetch(
      `${SUPABASE_URL}/rest/v1/articles?id=eq.${article_id}`,
      {
        method: 'PATCH',
        headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
        body: JSON.stringify({ image_url: publicUrl }),
      }
    );

    console.log(`[OK] Hero image generated for article ${article_id}`);
    return res.status(200).json({ image_url: publicUrl });
  } catch (e) {
    console.error('generate-hero-image error:', e);
    return res.status(500).json({ error: e.message });
  }
}
