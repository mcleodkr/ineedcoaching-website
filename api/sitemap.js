// /api/sitemap.js
// Dynamic sitemap.xml. Routed via vercel.json rewrite from /sitemap.xml.
// Lists static pages + 9 category landing pages + every published article
// (consumer + coach audiences). Excludes therapist/recovery articles
// (those belong to the sister sites' sitemaps).

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFyb2l6eWdrbnhkanNzdGtlenNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MTQ3MTEsImV4cCI6MjA5MDI5MDcxMX0.ZnSxf8LIDe_HPedgMPTwRpVE_VJmYSSFecwqrlNvjQ4';
const SITE_BASE = 'https://www.ineedcoaching.org';

const STATIC_PAGES = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/articles.html', changefreq: 'daily', priority: '0.9' },
  { path: '/coaches.html', changefreq: 'weekly', priority: '0.8' },
  { path: '/sessions.html', changefreq: 'weekly', priority: '0.7' },
  { path: '/coach-courses.html', changefreq: 'weekly', priority: '0.7' },
  { path: '/coaching-commons.html', changefreq: 'weekly', priority: '0.6' },
  { path: '/coach-signup.html', changefreq: 'monthly', priority: '0.6' },
  { path: '/welcome.html', changefreq: 'monthly', priority: '0.5' },
  { path: '/signup.html', changefreq: 'monthly', priority: '0.5' }
];

const CATEGORY_SLUGS = [
  'coaching-growth', 'finding-support', 'anxiety-overthinking',
  'relationships-boundaries', 'burnout-exhaustion', 'self-discovery-identity',
  'sobriety-recovery', 'depression-low-mood', 'trauma-healing'
];

function escapeXml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function urlEntry(loc, lastmod, changefreq, priority) {
  return '  <url>\n'
    + '    <loc>' + loc + '</loc>\n'
    + '    <lastmod>' + lastmod + '</lastmod>\n'
    + '    <changefreq>' + changefreq + '</changefreq>\n'
    + '    <priority>' + priority + '</priority>\n'
    + '  </url>\n';
}

export default async function handler(req, res) {
  const today = new Date().toISOString().slice(0, 10);
  let articles = [];
  try {
    // Pull every consumer + coach article. is_published filter covers
    // unpublished drafts; if the column is missing on some rows the eq.true
    // filter just excludes them which is the safe default.
    const fetchUrl = SUPABASE_URL
      + '/rest/v1/articles?or=(audience.eq.consumer,audience.eq.coach)'
      + '&is_published=eq.true&select=slug,created_at,published_at'
      + '&order=created_at.desc&limit=1000';
    const response = await fetch(fetchUrl, {
      headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY }
    });
    if (response.ok) {
      const rows = await response.json();
      if (Array.isArray(rows)) articles = rows;
    } else {
      console.error('sitemap: articles fetch failed', response.status);
    }
  } catch (e) {
    console.error('sitemap: articles fetch error', e);
  }

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

  for (const p of STATIC_PAGES) {
    xml += urlEntry(SITE_BASE + p.path, today, p.changefreq, p.priority);
  }
  for (const slug of CATEGORY_SLUGS) {
    xml += urlEntry(SITE_BASE + '/category/' + slug + '.html', today, 'weekly', '0.8');
  }
  for (const a of articles) {
    if (!a.slug) continue;
    const lastmod = ((a.published_at || a.created_at || '') + '').slice(0, 10) || today;
    xml += urlEntry(
      SITE_BASE + '/article.html?slug=' + escapeXml(a.slug),
      lastmod,
      'monthly',
      '0.7'
    );
  }

  xml += '</urlset>\n';

  res.status(200);
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  return res.send(xml);
}
