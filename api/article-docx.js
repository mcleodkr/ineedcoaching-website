// GET /api/article-docx?slug=X
//
// Exports a published article as a polished, branded .docx the coach can hand a
// client or print to PDF. Built server-side with the `docx` library. Mirrors
// /api/article-render's fetch + audience/site guards so only renderable articles
// export. Article `content` is mixed (sometimes HTML, sometimes plain text with
// blank-line paragraph breaks), so node-html-parser converts the HTML branch.

import {
  Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle, ExternalHyperlink,
} from 'docx';
import { parse } from 'node-html-parser';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFyb2l6eWdrbnhkanNzdGtlenNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MTQ3MTEsImV4cCI6MjA5MDI5MDcxMX0.ZnSxf8LIDe_HPedgMPTwRpVE_VJmYSSFecwqrlNvjQ4';
// ineedcoaching articles use these audience tags — coach-authored content is
// 'coaching-consumer' / 'coaching_consumer', so the narrower {consumer,coach}
// set (copied from article-render) 404'd every coach's own article on export.
const ALLOWED_AUDIENCES = new Set(['consumer', 'coach', 'coaching-consumer', 'coaching_consumer']);
const ALLOWED_SITES = new Set(['ineedcoaching']);

// Brand palette (CLAUDE.md): navy primary, gold accent, muted body.
const NAVY = '1A3A52';
const GOLD = 'C49A3C';
const MUTED = '6B6B60';
const INK = '2A2A2A';
const HEAD_FONT = 'Georgia';   // echoes Cormorant Garamond (serif display)
const BODY_FONT = 'Calibri';   // safe sans stand-in for DM Sans

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&rsquo;/g, '’');
}

// Inline runs from an element's children (bold/italic/links/breaks).
function inlineRuns(node, opts) {
  opts = opts || {};
  let runs = [];
  (node.childNodes || []).forEach((child) => {
    if (child.nodeType === 3) {
      const t = decode(child.text || '');
      if (t.trim()) runs.push(new TextRun({ text: t, bold: opts.bold, italics: opts.italics, color: opts.color || INK, font: BODY_FONT, size: 22 }));
      return;
    }
    const tag = (child.rawTagName || '').toLowerCase();
    if (tag === 'strong' || tag === 'b') runs = runs.concat(inlineRuns(child, { ...opts, bold: true }));
    else if (tag === 'em' || tag === 'i') runs = runs.concat(inlineRuns(child, { ...opts, italics: true }));
    else if (tag === 'br') runs.push(new TextRun({ break: 1 }));
    else if (tag === 'a') {
      const href = child.getAttribute('href') || '';
      const text = decode(child.text || '');
      if (href && /^https?:/i.test(href)) {
        runs.push(new ExternalHyperlink({ link: href, children: [new TextRun({ text, color: GOLD, underline: {}, font: BODY_FONT, size: 22 })] }));
      } else {
        runs.push(new TextRun({ text, color: GOLD, font: BODY_FONT, size: 22 }));
      }
    } else {
      runs = runs.concat(inlineRuns(child, opts)); // span / unknown inline
    }
  });
  return runs;
}

function headingPara(node, halfPts) {
  return new Paragraph({
    spacing: { before: 280, after: 120 },
    children: [new TextRun({ text: decode(node.text || '').trim(), bold: true, color: NAVY, font: HEAD_FONT, size: halfPts })],
  });
}

function bodyParagraph(runs, isQuote) {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { after: 160, line: 300 },
    indent: isQuote ? { left: 360 } : undefined,
    border: isQuote ? { left: { color: GOLD, style: BorderStyle.SINGLE, size: 18, space: 12 } } : undefined,
    children: runs.length ? runs : [new TextRun({ text: '', font: BODY_FONT, size: 22 })],
  });
}

function walkBlocks(node, out) {
  (node.childNodes || []).forEach((child) => {
    if (child.nodeType === 3) {
      const t = decode(child.text || '').trim();
      if (t) out.push(bodyParagraph([new TextRun({ text: t, color: INK, font: BODY_FONT, size: 22 })]));
      return;
    }
    const tag = (child.rawTagName || '').toLowerCase();
    if (tag === 'h1' || tag === 'h2') out.push(headingPara(child, 30));
    else if (tag === 'h3' || tag === 'h4') out.push(headingPara(child, 26));
    else if (tag === 'p') out.push(bodyParagraph(inlineRuns(child, {})));
    else if (tag === 'blockquote') out.push(bodyParagraph(inlineRuns(child, { italics: true, color: MUTED }), true));
    else if (tag === 'ul' || tag === 'ol') {
      (child.childNodes || []).forEach((li) => {
        if ((li.rawTagName || '').toLowerCase() === 'li') {
          out.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 100, line: 300 }, children: inlineRuns(li, {}) }));
        }
      });
    } else if (tag === 'div' || tag === 'section' || tag === 'article') {
      walkBlocks(child, out);
    } else {
      const runs = inlineRuns(child, {});
      if (runs.length) out.push(bodyParagraph(runs));
    }
  });
}

function bodyParagraphs(content) {
  const out = [];
  if (!content) return out;
  const isHtml = /<(p|h1|h2|h3|h4|ul|ol|li|strong|em|a|blockquote|br|div)\b/i.test(content);
  if (!isHtml) {
    content.split(/\n\s*\n/).forEach((para) => {
      const text = para.trim();
      if (text) out.push(bodyParagraph([new TextRun({ text, color: INK, font: BODY_FONT, size: 22 })]));
    });
    return out;
  }
  walkBlocks(parse(content), out);
  if (!out.length) {
    const txt = decode(parse(content).text || '').trim();
    if (txt) out.push(bodyParagraph([new TextRun({ text: txt, color: INK, font: BODY_FONT, size: 22 })]));
  }
  return out;
}

function rule(color) {
  return new Paragraph({
    spacing: { before: 60, after: 200 },
    border: { bottom: { color: color || GOLD, style: BorderStyle.SINGLE, size: 8, space: 1 } },
    children: [new TextRun({ text: '', size: 2 })],
  });
}

// Brand wordmark as styled text (no logo asset): gold "i", navy "need",
// gold "coaching", navy ".org".
function wordmark(alignment) {
  return new Paragraph({
    alignment: alignment || AlignmentType.LEFT,
    spacing: { after: 40 },
    children: [
      new TextRun({ text: 'i', bold: true, italics: true, color: GOLD, font: HEAD_FONT, size: 28 }),
      new TextRun({ text: 'need', bold: true, color: NAVY, font: HEAD_FONT, size: 28 }),
      new TextRun({ text: 'coaching', bold: true, italics: true, color: GOLD, font: HEAD_FONT, size: 28 }),
      new TextRun({ text: '.org', bold: true, color: NAVY, font: HEAD_FONT, size: 28 }),
    ],
  });
}

async function resolveAuthor(article) {
  if (!article.author_coach_id) return '';
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${encodeURIComponent(article.author_coach_id)}&select=display_name,full_name&limit=1`,
      { headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY } }
    );
    if (!res.ok) return '';
    const rows = await res.json();
    const c = Array.isArray(rows) && rows[0];
    return c ? (c.display_name || c.full_name || '') : '';
  } catch (e) {
    return '';
  }
}

export default async function handler(req, res) {
  const slug = (req.query && req.query.slug) || '';
  if (!slug) return res.status(400).json({ error: 'Missing slug' });

  try {
    const fetchUrl = `${SUPABASE_URL}/rest/v1/articles?slug=eq.${encodeURIComponent(slug)}&select=*&limit=1`;
    const response = await fetch(fetchUrl, { headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY } });
    if (!response.ok) throw new Error('Supabase fetch failed: ' + response.status);
    const rows = await response.json();
    const article = Array.isArray(rows) && rows[0];
    if (!article) return res.status(404).json({ error: 'Article not found' });
    if (!ALLOWED_AUDIENCES.has(article.audience)) return res.status(404).json({ error: 'Not found' });
    if (article.site && !ALLOWED_SITES.has(article.site)) return res.status(404).json({ error: 'Not found' });

    const author = await resolveAuthor(article);
    const dateStr = article.published_at
      ? new Date(article.published_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : '';

    const bylineRuns = [];
    if (author) bylineRuns.push(new TextRun({ text: 'By ' + author, color: NAVY, bold: true, font: BODY_FONT, size: 20 }));
    if (author && dateStr) bylineRuns.push(new TextRun({ text: '   •   ', color: MUTED, font: BODY_FONT, size: 20 }));
    if (dateStr) bylineRuns.push(new TextRun({ text: dateStr, color: MUTED, font: BODY_FONT, size: 20 }));

    const children = [wordmark(), rule(GOLD)];

    if (article.category) {
      children.push(new Paragraph({
        spacing: { after: 60 },
        children: [new TextRun({ text: String(article.category).toUpperCase(), color: GOLD, bold: true, font: BODY_FONT, size: 18, characterSpacing: 40 })],
      }));
    }

    // Title
    children.push(new Paragraph({
      spacing: { after: 80 },
      children: [new TextRun({ text: article.title || 'Untitled', bold: true, color: NAVY, font: HEAD_FONT, size: 48 })],
    }));

    // Meta description as subtitle
    if (article.meta_description) {
      children.push(new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun({ text: article.meta_description, italics: true, color: MUTED, font: HEAD_FONT, size: 26 })],
      }));
    }

    if (bylineRuns.length) children.push(new Paragraph({ spacing: { after: 120 }, children: bylineRuns }));
    children.push(rule(NAVY));

    // Body
    bodyParagraphs(article.content || '').forEach((p) => children.push(p));

    // Footer
    children.push(rule(GOLD));
    children.push(new Paragraph({
      spacing: { before: 60 },
      children: [
        new TextRun({ text: 'Published on ', color: MUTED, font: BODY_FONT, size: 18 }),
        new TextRun({ text: 'ineedcoaching.org', color: GOLD, bold: true, font: BODY_FONT, size: 18 }),
        new TextRun({ text: `   ·   https://www.ineedcoaching.org/article?slug=${slug}`, color: MUTED, font: BODY_FONT, size: 16 }),
      ],
    }));

    const doc = new Document({
      creator: 'ineedcoaching.org',
      title: article.title || 'Article',
      description: article.meta_description || '',
      sections: [{
        properties: { page: { margin: { top: 1080, bottom: 1080, left: 1200, right: 1200 } } },
        children,
      }],
    });

    const buffer = await Packer.toBuffer(doc);
    const safeSlug = String(slug).replace(/[^a-z0-9-_]+/gi, '-').slice(0, 80) || 'article';
    res.status(200);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${safeSlug}.docx"`);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');
    return res.send(buffer);
  } catch (e) {
    console.error('[article-docx] error', e);
    return res.status(500).json({ error: e && e.message ? e.message : 'Export failed' });
  }
}
