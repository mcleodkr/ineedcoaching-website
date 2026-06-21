// lib/agenda.js
//
// Helpers for the Supervision Agenda Builder (Ticket 4). Agenda items are stored as a
// jsonb array on supervision_agendas.items. Each item:
//   { id, text, source: 'snapshot'|'supervisor'|'supervisee', discussed, supervisee_reflection }

import { randomUUID } from 'crypto';

export const ITEM_SOURCES = ['snapshot', 'supervisor', 'supervisee'];
const TEXT_MAX = 1000;
const REFLECTION_MAX = 2000;

function isUuidStr(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());
}

// Normalize one item from untrusted input. defaultSource is used when the incoming
// source is missing/invalid (a freshly-added supervisor item). Returns null when the
// item has no text (so empty rows get dropped).
export function sanitizeItem(raw, defaultSource) {
  if (!raw || typeof raw !== 'object') return null;
  const text = String(raw.text == null ? '' : raw.text).trim().slice(0, TEXT_MAX);
  if (!text) return null;
  const source = ITEM_SOURCES.includes(raw.source) ? raw.source : (defaultSource || 'supervisor');
  const reflection = typeof raw.supervisee_reflection === 'string'
    ? raw.supervisee_reflection.trim().slice(0, REFLECTION_MAX) || null
    : null;
  return {
    id: isUuidStr(raw.id) ? raw.id : randomUUID(),
    text,
    source,
    discussed: !!raw.discussed,
    supervisee_reflection: reflection,
  };
}

export function sanitizeItems(rawItems, defaultSource) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems.map((r) => sanitizeItem(r, defaultSource)).filter(Boolean).slice(0, 40);
}

function newItem(text, source) {
  return { id: randomUUID(), text: String(text).trim().slice(0, TEXT_MAX), source, discussed: false, supervisee_reflection: null };
}

function firstSentence(s) {
  const str = String(s || '').trim();
  if (!str) return '';
  const m = str.match(/^(.*?[.?!])(\s|$)/);
  return (m ? m[1] : (str.length > 160 ? str.slice(0, 157) + '…' : str)).trim();
}

function splitSentences(s) {
  return String(s || '').split(/(?<=[.?!])\s+/).map((x) => x.trim()).filter(Boolean);
}

// Deterministically derive agenda items from a snapshot's snapshot_text jsonb:
//   practice_context -> one context-setting item
//   coach_development -> 1-2 focus items (sentences naming a growth edge)
//   supervisor_prompts[] -> one item each
const EDGE_CUES = /(growth edge|edge|tendency|tendencies|not yet serving|worth exploring|blind spot|interacting|meeting this|may want to|could (?:explore|deepen)|pattern)/i;

export function buildItemsFromSnapshot(snapshotText) {
  const t = snapshotText && typeof snapshotText === 'object' ? snapshotText : {};
  const items = [];

  if (typeof t.practice_context === 'string' && t.practice_context.trim()) {
    items.push(newItem('Review recent practice: ' + firstSentence(t.practice_context), 'snapshot'));
  }

  if (typeof t.coach_development === 'string' && t.coach_development.trim()) {
    const sentences = splitSentences(t.coach_development);
    let focus = sentences.filter((s) => EDGE_CUES.test(s)).slice(0, 2);
    if (!focus.length && sentences.length) focus = [sentences[0]];
    focus.forEach((s) => items.push(newItem(s, 'snapshot')));
  }

  if (Array.isArray(t.supervisor_prompts)) {
    t.supervisor_prompts.forEach((p) => {
      if (typeof p === 'string' && p.trim()) items.push(newItem(p, 'snapshot'));
    });
  }

  return items;
}

// Normalize a model-generated array (fallback path) into valid agenda items.
export function normalizeGeneratedItems(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((r) => {
      const text = r && typeof r === 'object' ? r.text : r;
      if (typeof text !== 'string' || !text.trim()) return null;
      return newItem(text, 'snapshot');
    })
    .filter(Boolean)
    .slice(0, 5);
}
