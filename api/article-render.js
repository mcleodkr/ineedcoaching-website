// /api/article-render.js
// Server-rendered article page. Replaces the static /article.html — the same URL
// (/article.html?slug=X) is rewritten to this function via vercel.json.
//
// What's server-rendered (visible to AI crawlers that don't run JS):
//   - <title>, <meta description>, OG/Twitter tags, canonical
//   - Article schema (schema.org/Article), BreadcrumbList, optional FAQPage
//   - Article body: tag, title, meta, toolbar, quick_answer, if_this_is_you,
//     content, key_insights, faq, audience-conditional CTAs
//
// What hydrates client-side (progressive enhancement):
//   - Hero image (uses /api/generate-hero-image for missing image_url)
//   - Quiz embed (lazy-loaded by article id)
//   - Related articles ("Keep Reading" — audience-scoped)
//   - Save button, share menu, mobile hamburger drawer
//
// All client JS reads from window.__ARTICLE__ which is hydrated server-side.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFyb2l6eWdrbnhkanNzdGtlenNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MTQ3MTEsImV4cCI6MjA5MDI5MDcxMX0.ZnSxf8LIDe_HPedgMPTwRpVE_VJmYSSFecwqrlNvjQ4';
const SITE_BASE = 'https://www.ineedcoaching.org';

// Audiences this site is allowed to render. Anything else (recovery,
// therapy_consumer, future values) 404s — keeps content scoped to ineedcoaching.
// Coach-authored ineedcoaching articles are tagged 'coaching-consumer' /
// 'coaching_consumer'; the narrower {consumer,coach} set 404'd ~123 published
// articles on the public reader (broken SEO + broken coach-profile article links).
const ALLOWED_AUDIENCES = new Set(['consumer', 'coach', 'coaching-consumer', 'coaching_consumer']);

// Sites whose articles this deploy may render. The articles table is shared
// across ineedtherapy and ineedcoaching; the site column gates which surface
// each article belongs to. Articles tagged for ineedtherapy (or any unknown
// future site) 404 here.
const ALLOWED_SITES = new Set(['ineedcoaching']);

// Category slugs for landing pages under /category/<slug>.html.
// Keep in sync with /scripts/build-category-pages.cjs and the inline copy in /api/article-render.js (this file).
const CATEGORY_SLUGS = {
  'Coaching & Growth': 'coaching-growth',
  'Finding Support': 'finding-support',
  'Anxiety & Overthinking': 'anxiety-overthinking',
  'Relationships & Boundaries': 'relationships-boundaries',
  'Burnout & Exhaustion': 'burnout-exhaustion',
  'Self-Discovery & Identity': 'self-discovery-identity'
};

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// JSON-LD must guard against </script> breakout. JSON.stringify already
// escapes quotes/backslashes/newlines; we only need to neutralize the
// closing-tag sequence and Unicode line separators.
function jsonLdSafe(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// Wrap bare http(s) URLs in <a> tags. Stops at whitespace or `<` so it can't
// run into an HTML tag boundary; trailing punctuation is stripped so a URL at
// the end of a sentence doesn't capture the period. Only run on text segments
// that haven't been wrapped in HTML yet (i.e. in the markdown-build branch
// below) — skipping the already-HTML branch avoids double-wrapping content
// the author hand-anchored.
function autoLinkify(text) {
  if (!text) return '';
  return String(text).replace(/(https?:\/\/[^\s<]+)/g, function(url) {
    const cleaned = url.replace(/[.,;:!?)]+$/, '');
    const trailing = url.slice(cleaned.length);
    return '<a href="' + cleaned + '" target="_blank" rel="noopener noreferrer">' + cleaned + '</a>' + trailing;
  });
}

// Same content-formatting logic the browser used to run, lifted to Node so
// the article body can be inlined into the response.
function formatContent(content) {
  if (!content) return '';
  if (content.includes('<p>') || content.includes('<h2>')) return content;
  let pCount = 0;
  return content.split('\n\n').map(function(para) {
    if (para.startsWith('# ')) return '<h1>' + para.slice(2) + '</h1>';
    if (para.startsWith('## ')) return '<h2>' + para.slice(3) + '</h2>';
    if (para.startsWith('### ')) return '<h3>' + para.slice(4) + '</h3>';
    if (para.startsWith('> ')) return '<blockquote>' + para.slice(2) + '</blockquote>';
    if (para.trim()) {
      pCount++;
      let html = '<p>' + autoLinkify(para.replace(/\n/g, '<br>')) + '</p>';
      if (pCount > 1 && pCount % 3 === 0) {
        const sentence = para.split(/[.!?]/)[0].trim();
        if (sentence.length > 20 && sentence.length < 200) {
          html += '<div class="pull-quote"><p>' + sentence + '.</p></div>';
        }
      }
      return html;
    }
    return '';
  }).join('');
}

function buildArticleSchema(article, articleUrl) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title || '',
    description: article.meta_description || '',
    url: articleUrl,
    datePublished: article.published_at || article.created_at || undefined,
    dateModified: article.updated_at || article.created_at || undefined,
    publisher: {
      '@type': 'Organization',
      name: 'ineedcoaching.org',
      url: SITE_BASE
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': articleUrl }
  };
  if (article.image_url) schema.image = article.image_url;
  return schema;
}

function buildBreadcrumbSchema(article, articleUrl) {
  const items = [
    { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_BASE + '/' },
    { '@type': 'ListItem', position: 2, name: 'Articles', item: SITE_BASE + '/articles.html' }
  ];
  const categorySlug = CATEGORY_SLUGS[article.category];
  if (categorySlug) {
    items.push({
      '@type': 'ListItem',
      position: 3,
      name: article.category,
      item: SITE_BASE + '/category/' + categorySlug + '.html'
    });
    items.push({ '@type': 'ListItem', position: 4, name: article.title || '' });
  } else {
    items.push({ '@type': 'ListItem', position: 3, name: article.title || '' });
  }
  return { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items };
}

// Only emit FAQPage when faq is a non-empty array of {question, answer}.
// Empty/malformed data → return null (don't emit a worthless schema block).
function buildFaqSchema(faqArray) {
  if (!Array.isArray(faqArray) || faqArray.length === 0) return null;
  const validItems = faqArray.filter(function(item) {
    return item && typeof item.question === 'string' && typeof item.answer === 'string'
      && item.question.trim() && item.answer.trim();
  });
  if (validItems.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: validItems.map(function(item) {
      return {
        '@type': 'Question',
        name: item.question,
        acceptedAnswer: { '@type': 'Answer', text: item.answer }
      };
    })
  };
}

// Build the inlined HTML for <div class="article-wrap"> — from the article-tag
// at the top down to the closing CTA banner at the bottom. Single banner on
// both audiences (Find Your Person therapist match) — see hotfix notes.
function buildArticleBody(article) {
  const tagCategory = article.category || 'Coaching';
  const tagSlug = CATEGORY_SLUGS[tagCategory];
  const tagHtml = tagSlug
    ? '<a class="article-tag" href="/category/' + tagSlug + '.html">' + escapeHtml(tagCategory) + '</a>'
    : '<div class="article-tag">' + escapeHtml(tagCategory) + '</div>';

  // Toolbar: save + share. saveArticle/toggleShare/copyLink/shareLinkedIn/shareX
  // are defined in the inlined client JS below.
  const slugEsc = (article.slug || '').replace(/'/g, "\\'");
  const titleEsc = (article.title || '').replace(/'/g, "\\'");
  const toolbarHtml =
    '<div class="article-toolbar">' +
      '<button class="save-article-btn" id="save-btn" onclick="saveArticle(\'' + slugEsc + '\', \'' + titleEsc + '\')">Save</button>' +
      '<a class="share-btn" style="text-decoration:none;" href="/api/article-docx?slug=' + encodeURIComponent(article.slug || '') + '">Download</a>' +
      '<div class="share-wrap"><button class="share-btn" onclick="toggleShare()">Share</button>' +
        '<div class="share-menu" id="share-menu">' +
          '<button onclick="copyLink()">Copy link</button>' +
          '<a href="#" onclick="shareLinkedIn();return false;">Share on LinkedIn</a>' +
          '<a href="#" onclick="shareX();return false;">Share on X</a>' +
        '</div>' +
      '</div>' +
    '</div>';

  let html = '';
  html += tagHtml;
  html += '<h1 class="article-title">' + escapeHtml(article.title || '') + '</h1>';
  html += '<div class="article-meta">' + escapeHtml(article.meta_description || '') + '</div>';
  html += toolbarHtml;

  if (article.quick_answer) {
    html += '<div class="quick-answer"><div class="quick-answer-label">Quick Answer</div><p>'
      + escapeHtml(article.quick_answer) + '</p></div>';
  }

  if (article.if_this_is_you) {
    const items = article.if_this_is_you.split('|').map(function(s) { return s.trim(); }).filter(Boolean);
    if (items.length) {
      html += '<div class="if-this-is-you"><div class="if-this-is-you-label">If This Is You</div><ul>'
        + items.map(function(item) { return '<li>' + escapeHtml(item) + '</li>'; }).join('')
        + '</ul></div>';
    }
  }

  // Quiz embed slot — populated client-side by loadQuizEmbed()
  html += '<div id="quiz-embed-slot"></div>';

  // formatContent is intentionally NOT escaped — content may contain HTML
  // (the existing template stored content as raw HTML in many rows).
  html += '<div class="article-body">' + formatContent(article.content) + '</div>';

  if (article.key_insights && article.key_insights.length) {
    html += '<div class="key-insights"><div class="key-insights-label">Key Insights</div><ul>'
      + article.key_insights.map(function(ki) { return '<li>' + escapeHtml(ki) + '</li>'; }).join('')
      + '</ul></div>';
  }

  // FAQ visible block. Source field: faq_schema (preferred) → faq (legacy)
  const faqSource = Array.isArray(article.faq_schema) && article.faq_schema.length
    ? article.faq_schema
    : (Array.isArray(article.faq) ? article.faq : null);
  if (faqSource && faqSource.length) {
    const validFaq = faqSource.filter(function(item) {
      return item && typeof item.question === 'string' && typeof item.answer === 'string';
    });
    if (validFaq.length) {
      html += '<div class="faq-section"><div class="faq-section-label">Frequently Asked Questions</div>';
      validFaq.forEach(function(item) {
        html += '<details class="faq-item"><summary>' + escapeHtml(item.question)
          + '</summary><div class="faq-answer">' + escapeHtml(item.answer) + '</div></details>';
      });
      html += '</div>';
    }
  }

  // Related articles slot — populated client-side, audience-scoped via Phase 1 fix
  html += '<div id="related-articles-slot"></div>';

  // Closing CTA — single Find Your Person banner on both audiences.
  // ineedcoaching.org's own dashboard journal covers what Sprixle did
  // externally, and Burnout Reset is an external program; both were
  // competing with in-house features. Find Your Person points to a
  // complementary service (therapist matching) that ineedcoaching.org
  // doesn't offer, so it's safe to surface to readers of either audience.
  html +=
    '<div class="closing-cta-band">' +
      '<div class="closing-cta-eyebrow">Need a therapist instead?</div>' +
      '<div class="closing-cta-heading">Find Your Person</div>' +
      '<div class="closing-cta-desc">Post what you need anonymously and let providers reach out directly.</div>' +
      '<a href="https://www.ineedtherapy.org/find-a-match.html" class="closing-cta-btn" target="_blank">Find Your Person &rarr;</a>' +
    '</div>';

  return html;
}

// All page CSS, lifted verbatim from /article.html. Updates here must be
// mirrored back to the static template if it's restored.
const STYLES = `
:root {
  --terracotta: #B8654A;
  --gold: #c49a3c;
  --dark-green: #1a3a52;
  --parchment: #f7f3ee;
  --warm-bg: #faf8f4;
  --dark-brown: #3a2a1a;
  --text-dark: #2a2220;
  --text-body: #3d3530;
  --text-muted: #7a706a;
  --white: #ffffff;
  --border-light: rgba(0,0,0,0.08);
  --r: 12px;
  --r-sm: 8px;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  font-family: 'DM Sans', sans-serif;
  font-size: 18px;
  line-height: 1.8;
  background: var(--warm-bg);
  color: var(--text-body);
}
nav {
  position: fixed; top: 0; left: 0; right: 0; z-index: 300;
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 52px;
  background: rgba(250,248,244,0.92);
  backdrop-filter: blur(16px);
  border-bottom: 1px solid var(--border-light);
}
.nav-logo { font-family: 'Cormorant Garamond', serif; font-size: 1.3rem; font-weight: 700; color: var(--text-dark); text-decoration: none; }
.nav-logo-i { color: var(--terracotta); font-style: italic; }
.nav-logo-coaching { color: var(--terracotta); font-style: italic; }
.nav-links { display: flex; align-items: center; gap: 24px; }
.nav-links a { font-size: 0.76rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text-muted); text-decoration: none; transition: color 0.2s; }
.nav-links a:hover { color: var(--terracotta); }
.nav-links .nav-cta { background: var(--terracotta); color: var(--white); padding: 8px 20px; border-radius: 50px; }
.nav-links .nav-cta:hover { background: #a05840; }

.article-hero { position: relative; width: 100%; height: 460px; margin-top: 54px; overflow: hidden; display: none; }
.article-hero img { width: 100%; height: 100%; object-fit: cover; object-position: center; display: block; }
.article-hero-overlay { position: absolute; bottom: 0; left: 0; right: 0; height: 50%; background: linear-gradient(to bottom, transparent 0%, var(--warm-bg) 100%); pointer-events: none; }

.article-wrap { max-width: 740px; margin: 0 auto; padding: 140px 40px 80px; }
.article-wrap.has-hero { padding-top: 40px; }

.article-tag {
  display: inline-block; font-family: 'DM Sans', sans-serif;
  font-size: 0.65rem; font-weight: 700;
  letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--terracotta); background: rgba(184,101,74,0.1);
  padding: 5px 14px; border-radius: 20px; margin-bottom: 24px;
  text-decoration: none;
}
a.article-tag { transition: background 0.15s ease, color 0.15s ease; }
a.article-tag:hover { background: rgba(184,101,74,0.2); color: var(--terracotta); }

.article-title { font-family: 'Cormorant Garamond', serif; font-size: clamp(2rem, 5vw, 3.2rem); font-weight: 700; line-height: 1.12; letter-spacing: -0.02em; color: var(--text-dark); margin-bottom: 20px; }
.article-meta { font-size: 0.88rem; color: var(--text-muted); margin-bottom: 28px; padding-bottom: 24px; border-bottom: 1px solid var(--border-light); line-height: 1.7; }

.article-toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 40px; flex-wrap: wrap; }
.save-article-btn { display: inline-flex; align-items: center; gap: 8px; background: var(--terracotta); color: var(--white); padding: 10px 24px; border-radius: 50px; border: none; font-family: 'DM Sans', sans-serif; font-size: 0.82rem; font-weight: 700; cursor: pointer; transition: all 0.2s; }
.save-article-btn:hover { background: #a05840; }
.save-article-btn.saved { background: var(--parchment); color: var(--terracotta); pointer-events: none; }
.share-wrap { position: relative; }
.share-btn { display: inline-flex; align-items: center; gap: 8px; background: transparent; color: var(--text-body); padding: 10px 24px; border-radius: 50px; border: 1.5px solid var(--border-light); font-family: 'DM Sans', sans-serif; font-size: 0.82rem; font-weight: 700; cursor: pointer; transition: all 0.2s; }
.share-btn:hover { border-color: var(--terracotta); color: var(--terracotta); }
.share-menu { display: none; position: absolute; top: 44px; left: 0; background: var(--white); border: 1px solid var(--border-light); border-radius: var(--r-sm); box-shadow: 0 8px 32px rgba(0,0,0,0.08); min-width: 220px; z-index: 100; overflow: hidden; }
.share-menu.open { display: block; }
.share-menu a, .share-menu button { display: flex; align-items: center; gap: 10px; width: 100%; padding: 12px 16px; border: none; background: none; font-family: 'DM Sans', sans-serif; font-size: 0.82rem; font-weight: 600; color: var(--text-body); cursor: pointer; text-decoration: none; text-align: left; transition: background 0.15s; }
.share-menu a:hover, .share-menu button:hover { background: rgba(184,101,74,0.06); }

.quick-answer { border-left: 4px solid var(--terracotta); background: var(--parchment); border-radius: 0 var(--r) var(--r) 0; padding: 28px 32px; margin-bottom: 40px; }
.quick-answer-label { font-family: 'DM Sans', sans-serif; font-size: 0.65rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--terracotta); margin-bottom: 12px; }
.quick-answer p { font-size: 0.95rem; line-height: 1.75; color: var(--text-dark); }

.if-this-is-you { background: rgba(184,101,74,0.04); border-radius: var(--r); padding: 28px 32px; margin-bottom: 40px; }
.if-this-is-you-label { font-family: 'DM Sans', sans-serif; font-size: 0.65rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--terracotta); margin-bottom: 16px; }
.if-this-is-you ul { list-style: none; display: flex; flex-direction: column; gap: 10px; }
.if-this-is-you li { display: flex; align-items: flex-start; gap: 12px; font-size: 0.92rem; color: var(--text-dark); line-height: 1.7; }
.if-this-is-you li::before { content: '\\2713'; color: var(--terracotta); font-weight: 700; flex-shrink: 0; margin-top: 3px; }

.key-insights { background: var(--parchment); border-radius: var(--r); padding: 32px; margin-bottom: 40px; border-left: 4px solid var(--gold); }
.key-insights-label { font-family: 'Cormorant Garamond', serif; font-size: 1.1rem; font-weight: 700; font-style: italic; color: var(--terracotta); margin-bottom: 16px; letter-spacing: 0.02em; }
.key-insights ul { list-style: none; display: flex; flex-direction: column; gap: 12px; }
.key-insights li { display: flex; align-items: flex-start; gap: 12px; font-size: 0.92rem; color: var(--text-dark); line-height: 1.7; }
.key-insights li::before { content: '\\2726'; color: var(--gold); flex-shrink: 0; margin-top: 3px; }

.quiz-embed { margin: 44px 0; border: 1.5px solid var(--border-light); border-radius: var(--r); overflow: hidden; background: var(--white); }
.quiz-embed-header { background: var(--parchment); padding: 28px 32px; border-bottom: 1px solid var(--border-light); }
.quiz-embed-eyebrow { font-size: 0.63rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--terracotta); margin-bottom: 8px; }
.quiz-embed-title { font-family: 'Cormorant Garamond', serif; font-style: italic; font-size: 1.4rem; color: var(--text-dark); line-height: 1.2; }
.quiz-embed-desc { font-size: 0.85rem; color: var(--text-muted); margin-top: 8px; line-height: 1.6; }
.quiz-embed-body { padding: 32px; }
.qe-progress { height: 3px; background: rgba(0,0,0,0.06); border-radius: 2px; margin-bottom: 28px; overflow: hidden; }
.qe-progress-fill { height: 100%; background: var(--terracotta); border-radius: 2px; transition: width 0.4s ease; width: 0%; }
.qe-question { font-family: 'Cormorant Garamond', serif; font-size: 1.2rem; font-style: italic; color: var(--text-dark); margin-bottom: 20px; line-height: 1.4; }
.qe-options { display: flex; flex-direction: column; gap: 8px; }
.qe-opt { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border: 2px solid rgba(0,0,0,0.08); border-radius: var(--r-sm); cursor: pointer; background: transparent; font-family: 'DM Sans', sans-serif; font-size: 0.9rem; font-weight: 500; color: var(--text-body); transition: all 0.15s; text-align: left; width: 100%; }
.qe-opt:hover { border-color: var(--terracotta); background: rgba(184,101,74,0.04); }
.qe-opt.selected { border-color: var(--terracotta); background: rgba(184,101,74,0.08); font-weight: 700; }
.qe-opt-dot { width: 18px; height: 18px; border-radius: 50%; border: 2px solid rgba(0,0,0,0.12); flex-shrink: 0; transition: all 0.15s; }
.qe-opt.selected .qe-opt-dot { background: var(--terracotta); border-color: var(--terracotta); }
.qe-nav { display: flex; align-items: center; justify-content: space-between; margin-top: 20px; padding-top: 18px; border-top: 1px solid rgba(0,0,0,0.06); }
.qe-counter { font-size: 0.75rem; color: var(--text-muted); font-weight: 600; }
.qe-btn-next { background: var(--terracotta); color: var(--white); padding: 10px 24px; border-radius: 50px; border: none; cursor: pointer; font-family: 'DM Sans', sans-serif; font-size: 0.85rem; font-weight: 700; transition: all 0.2s; }
.qe-btn-next:hover { background: #a05840; }
.qe-btn-next:disabled { opacity: 0.4; cursor: not-allowed; }

.qe-result-card { background: var(--parchment); border: 1px solid var(--border-light); border-radius: var(--r); padding: 36px; margin-top: 4px; position: relative; overflow: hidden; }
.qe-result-bg-char { position: absolute; top: -10px; right: 10px; font-size: 7rem; line-height: 1; opacity: 0.08; pointer-events: none; user-select: none; }
.qe-result-type { font-size: 0.63rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--terracotta); margin-bottom: 10px; }
.qe-result-name { font-family: 'Cormorant Garamond', serif; font-size: clamp(1.4rem, 3vw, 2rem); font-style: italic; color: var(--text-dark); margin-bottom: 16px; line-height: 1.15; }
.qe-result-desc { font-size: 0.88rem; line-height: 1.75; color: var(--text-muted); margin-bottom: 24px; }
.qe-prompt-label { font-size: 0.63rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--terracotta); margin-bottom: 8px; }
.qe-prompt-text { font-family: 'Cormorant Garamond', serif; font-style: italic; font-size: 1.05rem; color: var(--text-dark); line-height: 1.5; padding: 14px 18px; border-left: 3px solid var(--terracotta); background: rgba(184,101,74,0.05); border-radius: 0 var(--r-sm) var(--r-sm) 0; margin-bottom: 18px; }
.qe-journal { width: 100%; min-height: 110px; padding: 14px; background: var(--white); border: 1px solid rgba(0,0,0,0.1); border-radius: var(--r-sm); color: var(--text-body); font-family: 'DM Sans', sans-serif; font-size: 0.9rem; resize: vertical; outline: none; transition: border-color 0.2s; line-height: 1.6; }
.qe-journal::placeholder { color: var(--text-muted); }
.qe-journal:focus { border-color: var(--terracotta); }
.qe-privacy { font-size: 0.72rem; color: var(--text-muted); margin-bottom: 10px; }
.qe-retake button { background: none; border: none; font-size: 0.78rem; color: var(--text-muted); cursor: pointer; font-family: inherit; text-decoration: underline; transition: color 0.2s; margin-top: 14px; }
.qe-retake button:hover { color: var(--terracotta); }

.article-body { font-size: 1.125rem; line-height: 1.85; color: var(--text-body); }
.article-body h1, .article-body h2 { font-family: 'Cormorant Garamond', serif; font-size: 1.6rem; font-weight: 700; margin: 48px 0 18px; color: var(--text-dark); line-height: 1.2; }
.article-body h3 { font-family: 'Cormorant Garamond', serif; font-size: 1.25rem; font-weight: 600; margin: 36px 0 14px; color: var(--text-dark); line-height: 1.3; }
.article-body p { margin-bottom: 22px; }
.article-body p:first-of-type::first-letter { font-family: 'Cormorant Garamond', serif; float: left; font-size: 4.2rem; line-height: 0.75; font-weight: 700; color: var(--terracotta); padding: 6px 10px 0 0; }
.article-body ul, .article-body ol { margin: 0 0 22px 28px; }
.article-body li { margin-bottom: 10px; line-height: 1.75; }
.article-body strong { font-weight: 700; color: var(--text-dark); }
.article-body em { font-style: italic; }
.article-body blockquote { border-left: 3px solid var(--gold); padding: 16px 24px; margin: 32px 0; background: rgba(196,154,60,0.06); border-radius: 0 var(--r-sm) var(--r-sm) 0; font-style: italic; color: var(--text-dark); }

.pull-quote { border-left: 4px solid var(--terracotta); padding: 24px 0 24px 28px; margin: 40px 0; }
.pull-quote p { font-family: 'Cormorant Garamond', serif; font-style: italic; font-size: 1.5rem; line-height: 1.45; color: var(--terracotta); margin: 0; }

.faq-section { margin: 48px 0; }
.faq-section-label { font-family: 'Cormorant Garamond', serif; font-size: 1.6rem; font-weight: 700; color: var(--text-dark); margin-bottom: 24px; }
.faq-item { border-bottom: 1px solid var(--border-light); padding: 20px 0; }
.faq-item summary { font-family: 'DM Sans', sans-serif; font-size: 1rem; font-weight: 700; color: var(--text-dark); cursor: pointer; list-style: none; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.faq-item summary::-webkit-details-marker { display: none; }
.faq-item summary::after { content: '+'; font-size: 1.4rem; color: var(--terracotta); flex-shrink: 0; transition: transform 0.2s; }
.faq-item[open] summary::after { content: '\\2212'; }
.faq-item .faq-answer { padding-top: 12px; font-size: 0.95rem; line-height: 1.75; color: var(--text-body); }

.closing-cta-band { background: var(--dark-green); margin: 60px -40px 0; padding: 56px 48px; border-radius: var(--r); text-align: center; position: relative; overflow: hidden; }
.closing-cta-band::before { content: ''; position: absolute; inset: 0; background: radial-gradient(ellipse at 30% 50%, rgba(184,101,74,0.12) 0%, transparent 60%); pointer-events: none; }
.closing-cta-eyebrow { font-family: 'DM Sans', sans-serif; font-size: 0.65rem; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: var(--terracotta); margin-bottom: 14px; position: relative; }
.closing-cta-heading { font-family: 'Cormorant Garamond', serif; font-size: clamp(1.6rem, 3.5vw, 2.4rem); font-weight: 700; line-height: 1.2; color: var(--white); margin-bottom: 14px; position: relative; }
.closing-cta-desc { font-size: 1rem; line-height: 1.7; color: #f0f0f0; max-width: 520px; margin: 0 auto 28px; position: relative; }
.closing-cta-btn { display: inline-flex; align-items: center; gap: 8px; background: var(--white); color: var(--dark-green); padding: 14px 32px; border-radius: 50px; font-family: 'DM Sans', sans-serif; font-size: 0.9rem; font-weight: 700; text-decoration: none; transition: all 0.2s; position: relative; }
.closing-cta-btn:hover { background: #f0f0f0; transform: translateY(-2px); }

.related-section { margin: 52px 0; }
.related-section-label { font-family: 'Cormorant Garamond', serif; font-size: 1.6rem; font-weight: 700; color: var(--text-dark); margin-bottom: 24px; }
.related-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 20px; }
.related-card { background: var(--white); border: 1px solid var(--border-light); border-radius: var(--r); padding: 24px 20px; text-decoration: none; transition: all 0.25s; display: block; }
.related-card:hover { border-color: var(--terracotta); transform: translateY(-3px); box-shadow: 0 8px 24px rgba(0,0,0,0.06); }
.related-card-tag { font-size: 0.6rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--terracotta); margin-bottom: 8px; }
.related-card-title { font-family: 'Cormorant Garamond', serif; font-size: 1.05rem; font-weight: 700; color: var(--text-dark); line-height: 1.3; margin-bottom: 8px; }
.related-card-desc { font-size: 0.78rem; color: var(--text-muted); line-height: 1.55; }


footer { background: var(--dark-green); padding: 32px 52px; display: flex; justify-content: space-between; align-items: center; margin-top: 80px; }
.f-logo { font-family: 'Cormorant Garamond', serif; font-size: 1.1rem; font-weight: 700; color: var(--white); text-decoration: none; }
.f-note { font-size: 0.72rem; color: #f0f0f0; }

.error-wrap { text-align: center; padding: 80px 40px; }
.error-wrap h2 { font-family: 'Cormorant Garamond', serif; font-size: 1.8rem; margin-bottom: 12px; color: var(--text-dark); }
.error-wrap p { color: var(--text-muted); margin-bottom: 24px; }
.btn-cta { display: inline-flex; align-items: center; gap: 8px; background: var(--terracotta); color: var(--white); padding: 12px 28px; border-radius: 50px; font-family: 'DM Sans', sans-serif; font-size: 0.9rem; font-weight: 700; text-decoration: none; transition: all 0.2s; }
.btn-cta:hover { background: #a05840; }

@keyframes fadeUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }

@media (max-width: 768px) {
  nav { padding: 12px 20px; }
  .nav-links { gap: 12px; flex-wrap: wrap; }
  .nav-links a { font-size: 0.68rem; }
  .article-wrap { padding: 100px 20px 60px; }
  .related-grid { grid-template-columns: 1fr; }
  .article-hero { height: 280px; }
  .closing-cta-band { margin: 48px -20px 0; padding: 40px 24px; }
  .pull-quote { padding: 18px 0 18px 20px; }
  .pull-quote p { font-size: 1.25rem; }
  footer { padding: 24px 20px; flex-direction: column; gap: 10px; text-align: center; }
}
@media (max-width: 480px) {
  .nav-links a:not(.nav-cta) { display: none; }
  .article-body p:first-of-type::first-letter { font-size: 3.4rem; }
}
`;

// Client-side JS, lifted from /article.html. The original loadArticle() is
// removed — content is server-rendered. The hydrate entry point reads
// window.__ARTICLE__ and wires up the interactive bits.
const CLIENT_JS = `
const SUPABASE_URL = '${SUPABASE_URL}';
const ANON_KEY = '${ANON_KEY}';

const CATEGORY_SLUGS = ${JSON.stringify(CATEGORY_SLUGS)};

// Quiz state
var qeQuestions = [], qeCurrent = 0, qeScore = 0, qeSelected = null, qeCurrentResult = null;
var _quizResults = [];

function qeInit(questions) { qeQuestions = questions; qeCurrent = 0; qeScore = 0; qeRender(); }

function qeRender() {
  var q = qeQuestions[qeCurrent];
  document.getElementById('qe-q').textContent = q.question;
  document.getElementById('qe-counter').textContent = (qeCurrent + 1) + ' of ' + qeQuestions.length;
  document.getElementById('qe-progress').style.width = ((qeCurrent / qeQuestions.length) * 100) + '%';
  qeSelected = null;
  var nextBtn = document.getElementById('qe-next');
  nextBtn.disabled = true;
  nextBtn.textContent = qeCurrent === qeQuestions.length - 1 ? 'See my result \\u2192' : 'Next \\u2192';
  document.getElementById('qe-opts').innerHTML = q.answers.map(function(a, i) {
    return '<button class="qe-opt" onclick="qeSelect(this, ' + q.scores[i] + ')"><span class="qe-opt-dot"></span>' + a + '</button>';
  }).join('');
}

function qeSelect(btn, score) {
  document.querySelectorAll('#quiz-embed .qe-opt').forEach(function(b) { b.classList.remove('selected'); });
  btn.classList.add('selected');
  qeSelected = score;
  document.getElementById('qe-next').disabled = false;
}

function qeNext() {
  if (qeSelected === null) return;
  qeScore += qeSelected;
  qeCurrent++;
  if (qeCurrent < qeQuestions.length) { qeRender(); return; }
  document.getElementById('qe-progress').style.width = '100%';
  document.getElementById('qe-question-wrap').style.display = 'none';
  var maxScore = qeQuestions.length * 3;
  var pct = qeScore / maxScore;
  var bucket = pct < 0.35 ? 'low' : pct < 0.65 ? 'mid' : 'high';
  if (_quizResults && _quizResults.length > 0) {
    qeCurrentResult = _quizResults.find(function(r) { return r.range === bucket; }) || _quizResults[1] || _quizResults[0];
  } else {
    qeCurrentResult = { name: 'Your Result', bg: '\\u2726', desc: 'Thank you for completing this self-assessment.', prompt: 'What stood out to you most?' };
  }
  document.getElementById('qe-result-wrap').style.display = 'block';
  document.getElementById('qe-result-wrap').innerHTML =
    '<div class="qe-result-card">' +
      '<div class="qe-result-bg-char">' + (qeCurrentResult.bg || '\\u2726') + '</div>' +
      '<div class="qe-result-type">Your result</div>' +
      '<div class="qe-result-name">' + qeCurrentResult.name + '</div>' +
      '<div class="qe-result-desc">' + qeCurrentResult.desc + '</div>' +
      '<div class="qe-prompt-label">A prompt to sit with</div>' +
      '<div class="qe-prompt-text">' + qeCurrentResult.prompt + '</div>' +
      '<div class="qe-privacy">Your response is private and not saved.</div>' +
      '<textarea class="qe-journal" placeholder="Write whatever comes to mind. Take your time."></textarea>' +
      '<div class="qe-retake"><button onclick="qeRetake()">Take this quiz again</button></div>' +
    '</div>';
  document.getElementById('qe-result-wrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function qeRetake() {
  document.getElementById('qe-result-wrap').style.display = 'none';
  document.getElementById('qe-question-wrap').style.display = 'block';
  qeCurrent = 0; qeScore = 0; qeSelected = null;
  document.getElementById('qe-progress').style.width = '0%';
  qeRender();
}

function renderQuizEmbed(quiz) {
  var questions = quiz.questions || [];
  if (!questions.length) return '';
  if (quiz.results) _quizResults = quiz.results;
  return '<div style="margin-bottom:12px;"><p style="font-size:0.88rem;color:var(--text-muted);line-height:1.65;">Take this 2-minute check-in to see where you actually are right now.</p></div>' +
    '<div class="quiz-embed" id="quiz-embed">' +
      '<div class="quiz-embed-header">' +
        '<div class="quiz-embed-eyebrow">Self-Assessment</div>' +
        '<div class="quiz-embed-title">' + quiz.title + '</div>' +
        '<div class="quiz-embed-desc">' + (quiz.description || 'A quick check-in \\u2014 takes about 2 minutes.') + '</div>' +
      '</div>' +
      '<div class="quiz-embed-body">' +
        '<div class="qe-progress"><div class="qe-progress-fill" id="qe-progress"></div></div>' +
        '<div id="qe-question-wrap">' +
          '<div class="qe-question" id="qe-q"></div>' +
          '<div class="qe-options" id="qe-opts"></div>' +
          '<div class="qe-nav"><span class="qe-counter" id="qe-counter"></span><button class="qe-btn-next" id="qe-next" disabled onclick="qeNext()">Next \\u2192</button></div>' +
        '</div>' +
        '<div id="qe-result-wrap" style="display:none;"></div>' +
      '</div>' +
    '</div>';
}

async function saveArticle(slug, title) {
  var token = localStorage.getItem('sb_access_token');
  if (!token) { window.location.href = '/welcome.html'; return; }
  try {
    var userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'Authorization': 'Bearer ' + token, 'apikey': ANON_KEY }
    });
    if (!userRes.ok) { window.location.href = '/welcome.html'; return; }
    var user = await userRes.json();
    var email = user.email;
    await fetch(SUPABASE_URL + '/rest/v1/saved_articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ user_email: email, article_slug: slug, article_title: title, source: 'ineedcoaching.org' })
    });
    var btn = document.getElementById('save-btn');
    if (btn) { btn.textContent = '\\u2713 Saved'; btn.classList.add('saved'); }
  } catch(e) { /* silent */ }
}

function toggleShare() {
  var menu = document.getElementById('share-menu');
  menu.classList.toggle('open');
}
function copyLink() {
  navigator.clipboard.writeText(window.location.href);
  document.getElementById('share-menu').classList.remove('open');
  var btn = document.querySelector('.share-btn');
  btn.textContent = 'Copied!';
  setTimeout(function() { btn.textContent = 'Share'; }, 2000);
}
function shareLinkedIn() {
  window.open('https://www.linkedin.com/sharing/share-offsite/?url=' + encodeURIComponent(window.location.href), '_blank');
  document.getElementById('share-menu').classList.remove('open');
}
function shareX() {
  window.open('https://twitter.com/intent/tweet?url=' + encodeURIComponent(window.location.href) + '&text=' + encodeURIComponent(document.title), '_blank');
  document.getElementById('share-menu').classList.remove('open');
}

document.addEventListener('click', function(e) {
  if (!e.target.closest('.share-wrap')) {
    var menu = document.getElementById('share-menu');
    if (menu) menu.classList.remove('open');
  }
});

async function loadRelatedArticles(category, currentSlug, audience) {
  var slot = document.getElementById('related-articles-slot');
  if (!slot) return;
  try {
    var url = SUPABASE_URL + '/rest/v1/articles?category=eq.' + encodeURIComponent(category) + '&slug=neq.' + encodeURIComponent(currentSlug) + '&select=title,slug,meta_description,category&limit=3&order=created_at.desc';
    if (audience) url += '&audience=eq.' + encodeURIComponent(audience);
    var res = await fetch(url, {
      headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY }
    });
    var articles = await res.json();
    if (!articles || !articles.length) { slot.style.display = 'none'; return; }
    slot.innerHTML = '<div class="related-section">' +
      '<div class="related-section-label">Keep Reading</div>' +
      '<div class="related-grid">' +
        articles.map(function(a) {
          return '<a class="related-card" href="/article.html?slug=' + encodeURIComponent(a.slug) + '">' +
            '<div class="related-card-tag">' + (a.category || 'Coaching') + '</div>' +
            '<div class="related-card-title">' + a.title + '</div>' +
            (a.meta_description ? '<div class="related-card-desc">' + a.meta_description.substring(0, 100) + '</div>' : '') +
          '</a>';
        }).join('') +
      '</div></div>';
  } catch(e) { slot.style.display = 'none'; }
}

function showHeroImage(article) {
  var heroEl = document.getElementById('article-hero');
  var heroImg = document.getElementById('hero-img');
  if (!heroEl || !heroImg) return;
  function reveal(url) {
    heroImg.src = url;
    heroImg.alt = article.title;
    heroEl.style.display = 'block';
    document.getElementById('article-wrap').classList.add('has-hero');
  }
  if (article.image_url) {
    reveal(article.image_url);
  } else {
    var origin = window.location.origin;
    fetch(origin + '/api/generate-hero-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ article_id: article.id, title: article.title, category: article.category || 'Coaching' })
    })
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) { if (data && data.image_url) reveal(data.image_url); })
    .catch(function() { /* no hero image, page still works */ });
  }
}

async function loadQuizEmbed(article) {
  var slot = document.getElementById('quiz-embed-slot');
  if (!slot) return;
  try {
    var res = await fetch(SUPABASE_URL + '/rest/v1/quizzes?related_article_id=eq.' + article.id + '&select=id,title,slug,description,questions,results,category&limit=1', {
      headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY }
    });
    var quizzes = await res.json();
    if ((!quizzes || !quizzes.length) && article.content) {
      var match = article.content.match(/<!--\\s*QUIZ_SLUG:\\s*(\\S+)\\s*-->/);
      if (match) {
        var slugRes = await fetch(SUPABASE_URL + '/rest/v1/quizzes?slug=eq.' + match[1] + '&select=id,title,slug,description,questions,results,category&limit=1', {
          headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY }
        });
        quizzes = await slugRes.json();
      }
    }
    if (quizzes && quizzes.length) {
      slot.innerHTML = renderQuizEmbed(quizzes[0]);
      qeInit(quizzes[0].questions);
    }
  } catch(e) { /* no quiz, that's fine */ }
}

function hydrateArticle() {
  var a = window.__ARTICLE__;
  if (!a) return;
  showHeroImage(a);
  // Quiz embed needs the raw content (for QUIZ_SLUG comment fallback) — pass it through
  loadQuizEmbed(a);
  if (a.category) loadRelatedArticles(a.category, a.slug, a.audience);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', hydrateArticle);
} else {
  hydrateArticle();
}
`;

function buildHtmlResponse(article) {
  const articleUrl = SITE_BASE + '/article.html?slug=' + encodeURIComponent(article.slug);
  const titleText = (article.title || 'Article') + ' | ineedcoaching.org';
  const metaDesc = article.meta_description
    || article.quick_answer
    || ((article.title || 'Article') + ' — read on ineedcoaching.org');

  const articleSchema = buildArticleSchema(article, articleUrl);
  const breadcrumbSchema = buildBreadcrumbSchema(article, articleUrl);
  const faqSchema = buildFaqSchema(article.faq_schema || article.faq);

  const ogImageTag = article.image_url
    ? '<meta property="og:image" content="' + escapeHtml(article.image_url) + '">'
    : '';
  const twitterCard = article.image_url ? 'summary_large_image' : 'summary';
  const twitterImageTag = article.image_url
    ? '<meta name="twitter:image" content="' + escapeHtml(article.image_url) + '">'
    : '';

  // Hydration payload: only pass what client JS actually reads
  const hydrationPayload = {
    id: article.id,
    slug: article.slug,
    title: article.title,
    category: article.category,
    audience: article.audience,
    image_url: article.image_url || null,
    content: article.content || ''
  };

  const articleBody = buildArticleBody(article);

  // The CLIENT_JS template literal interpolates SUPABASE_URL and ANON_KEY; we
  // must call it as a function-style template at request time so those values
  // are baked. Since CLIENT_JS is already a string, just inject directly.
  const clientJsBlock = CLIENT_JS;

  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n'
    + '<meta charset="UTF-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
    + '<title>' + escapeHtml(titleText) + '</title>\n'
    + '<meta name="description" content="' + escapeHtml(metaDesc) + '">\n'
    + '<link rel="canonical" href="' + articleUrl + '">\n'
    + '<meta property="og:title" content="' + escapeHtml(article.title || '') + '">\n'
    + '<meta property="og:description" content="' + escapeHtml(metaDesc) + '">\n'
    + '<meta property="og:type" content="article">\n'
    + '<meta property="og:url" content="' + articleUrl + '">\n'
    + '<meta property="og:site_name" content="ineedcoaching.org">\n'
    + ogImageTag + (ogImageTag ? '\n' : '')
    + '<meta name="twitter:card" content="' + twitterCard + '">\n'
    + '<meta name="twitter:title" content="' + escapeHtml(article.title || '') + '">\n'
    + '<meta name="twitter:description" content="' + escapeHtml(metaDesc) + '">\n'
    + twitterImageTag + (twitterImageTag ? '\n' : '')
    + '<script type="application/ld+json">' + jsonLdSafe(articleSchema) + '</script>\n'
    + '<script type="application/ld+json">' + jsonLdSafe(breadcrumbSchema) + '</script>\n'
    + (faqSchema ? '<script type="application/ld+json">' + jsonLdSafe(faqSchema) + '</script>\n' : '')
    + '<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500;1,600;1,700&family=DM+Sans:ital,wght@0,400;0,500;0,700;1,400&display=swap" rel="stylesheet">\n'
    + '<style>' + STYLES + '</style>\n'
    + '</head>\n<body>\n'
    + '<nav>\n'
    + '  <a class="nav-logo" href="/"><span class="nav-logo-i">i</span>need<span class="nav-logo-coaching">coaching</span>.org</a>\n'
    + '  <div class="nav-links">\n'
    + '    <a href="/coaches.html">Coaches</a>\n'
    + '    <a href="/sessions.html">Sessions</a>\n'
    + '    <a href="/coach-courses.html">Courses</a>\n'
    + '    <a href="/articles.html">Articles</a>\n'
    + '    <a href="/coaching-commons.html">Commons</a>\n'
    + '    <a href="/coach-dashboard.html">Dashboard</a>\n'
    + '    <a href="/coach-signup.html" class="nav-cta">List Your Practice</a>\n'
    + '  </div>\n'
    + '</nav>\n'
    + '<div class="article-hero" id="article-hero">\n'
    + '  <img id="hero-img" src="" alt="" width="1792" height="1024" loading="eager" fetchpriority="high">\n'
    + '  <div class="article-hero-overlay"></div>\n'
    + '</div>\n'
    + '<div class="article-wrap" id="article-wrap">\n' + articleBody + '\n</div>\n'
    + '<footer>\n'
    + '  <a class="f-logo" href="/"><span style="color:var(--terracotta);font-style:italic;">i</span>need<span style="color:var(--terracotta);font-style:italic;">coaching</span>.org</a>\n'
    + '  <span class="f-note">Not a crisis service — In crisis? Call or text 988</span>\n'
    + '</footer>\n'
    + '<script>window.__ARTICLE__ = ' + jsonLdSafe(hydrationPayload) + ';</script>\n'
    + '<script>' + clientJsBlock + '</script>\n'
    + '</body>\n</html>\n';
}

function notFoundHtml() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
    + '<title>Article not found | ineedcoaching.org</title>'
    + '<meta name="robots" content="noindex">'
    + '<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:80px auto;padding:0 24px;color:#3d3530;}h1{font-family:serif;}a{color:#B8654A;}</style>'
    + '</head><body><h1>Article not found</h1>'
    + '<p>This article may have moved or been updated.</p>'
    + '<p><a href="/articles.html">&larr; Browse all articles</a></p>'
    + '</body></html>';
}

function errorHtml() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
    + '<title>Something went wrong | ineedcoaching.org</title>'
    + '<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:80px auto;padding:0 24px;color:#3d3530;}h1{font-family:serif;}a{color:#B8654A;}</style>'
    + '</head><body><h1>Something went wrong</h1>'
    + '<p>Please try again shortly.</p>'
    + '<p><a href="/">&larr; Home</a></p>'
    + '</body></html>';
}

export default async function handler(req, res) {
  const slug = (req.query && req.query.slug) || '';
  if (!slug) {
    res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send('<!DOCTYPE html><title>Bad Request</title><p>Missing slug parameter.</p>');
  }

  try {
    const fetchUrl = SUPABASE_URL + '/rest/v1/articles?slug=eq.'
      + encodeURIComponent(slug) + '&select=*&limit=1';
    const response = await fetch(fetchUrl, {
      headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY }
    });
    if (!response.ok) {
      throw new Error('Supabase fetch failed: ' + response.status);
    }
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(notFoundHtml());
    }

    // Audience guard: this site only renders consumer + coach articles.
    // recovery → ineedrecovery.org, therapy_consumer → future ineedtherapy.org
    // consumer surface. Anything else (current or future) safely 404s here.
    // Site guard: the articles table is shared with ineedtherapy. An article
    // tagged for another site (or missing the column on a fresh row) 404s so
    // direct-slug navigation can't pull content across deploys.
    const article = rows[0];
    if (!ALLOWED_AUDIENCES.has(article.audience)) {
      res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(notFoundHtml());
    }
    if (article.site && !ALLOWED_SITES.has(article.site)) {
      res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(notFoundHtml());
    }

    const html = buildHtmlResponse(article);
    res.status(200);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');
    return res.send(html);
  } catch (e) {
    console.error('article-render error:', e);
    res.status(500).setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(errorHtml());
  }
}
