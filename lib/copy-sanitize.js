// Shared copy sanitizer for Coach Clarity generated content. Belt-and-suspenders
// over the system prompt: strip em/en dashes (collapse a spaced dash to a comma
// so sentences stay readable) and reframe banned vocabulary into the Gestalt
// frame, so the rules hold even when the model slips. Used by the outline and
// lesson-content generators.
//
// Whole-word, case-insensitive; first-letter case preserved so titles stay
// title-cased. \b protects substrings ("bright", "rights", "goodness").
const VOCAB_REFRAME = {
  good: 'effective',
  bad: 'ineffective',
  right: 'effective',
  wrong: 'ineffective',
  should: 'can',
  must: 'can',
  mistake: 'misstep',
  failure: 'setback',
};
const BANNED_RE = new RegExp('\\b(' + Object.keys(VOCAB_REFRAME).join('|') + ')\\b', 'gi');

function matchCase(replacement, original) {
  if (original[0] === original[0].toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

export function sanitizeCopy(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(BANNED_RE, function (m) { return matchCase(VOCAB_REFRAME[m.toLowerCase()], m); })
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function cleanStringList(arr) {
  return (Array.isArray(arr) ? arr : [])
    .map(function (s) { return sanitizeCopy(typeof s === 'string' ? s : ''); })
    .filter(function (s) { return s.length > 0; });
}
