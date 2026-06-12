// Pressure test for the Effectiveness Map synthesis prompt v1.7.
// Run: node scripts/pressure-test-effmap-v1.7.mjs   (needs ANTHROPIC_API_KEY in env or .env.local)
//
// Three cases against the live model (strong / thin / crisis), then automated
// checks per the prompt's FINAL VERIFICATION list: structure, fixed copy
// returned verbatim (openers + legend), second-person voice, banned machinery
// vocabulary in explorer text, banned clinical vocabulary + taxing/paying
// language + (A)/(B) markers in coach text, no invented gender (fixtures are
// gender-neutral), closing summary coverage, evidence-strength behavior,
// crisis short-circuit.

import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const SYNTH = require('../api/prompts/effectiveness-map-synthesis-v1.7.json');

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4000;

function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
    const m = env.match(/^ANTHROPIC_API_KEY\s*=\s*"?([^"\n]+)"?\s*$/m);
    if (m) return m[1];
  } catch { /* fall through */ }
  console.error('No ANTHROPIC_API_KEY found'); process.exit(1);
}

// Mirrors buildUserMessage in api/generate-effectiveness-map.js exactly.
function buildUserMessage(input) {
  const a = input.answers;
  return [
    `Goal: ${input.goal}`,
    `Phase: ${input.phase}`,
    '',
    'Physical domain:',
    `Q1 (body noticing): ${a.physical_1}`,
    `Q2 (change since goal): ${a.physical_2}`,
    '',
    'Intellectual domain:',
    `Q3 (thinking availability): ${a.intellectual_1}`,
    `Q4 (inner chatter): ${a.intellectual_2}`,
    '',
    'Psychological domain:',
    `Q5 (first internal response): ${a.psychological_1}`,
    `Q6 (standing in it): ${a.psychological_2}`,
    '',
    'Environmental domain:',
    `Q7 (space/people/conditions): ${a.environmental_1}`,
    `Q8 (reflects where going/been): ${a.environmental_2}`,
    '',
    'Social domain:',
    `Q9 (who is in the room): ${a.social_1}`,
    `Q10 (sacrifice/compromise/negotiate): ${a.social_2}`,
  ].join('\n');
}

// Fixtures are deliberately gender-neutral (partner / best friend / colleagues)
// so ANY gendered pronoun in the output is an invention — verification rule 8.
const CASES = {
  strong: {
    goal: 'Launch my private coaching practice and replace my hospital salary within two years',
    phase: 'Building',
    answers: {
      physical_1: 'Tight shoulders and a clenched jaw most evenings. I notice I hold my breath when I open my laptop after dinner.',
      physical_2: 'I used to run three mornings a week. Since I started building the practice I run maybe twice a month and I am sleeping about six hours instead of seven and a half.',
      intellectual_1: 'My thinking is sharp in the mornings and completely gone by 8pm. I do my best planning on Saturday mornings with coffee before the house wakes up.',
      intellectual_2: 'A loop that says the website is not ready, the niche is wrong, and that real coaches have waitlists already. It quiets down when I am actually with a client.',
      psychological_1: 'Excitement first, then a drop into doubt about whether people will pay me what I need to charge.',
      psychological_2: 'When I imagine standing in it fully I feel calm and a little proud. The doubt is loudest in between sessions, not during them.',
      environmental_1: 'I work from the guest room. My partner takes the kids on Saturday mornings so I can build. The hospital job pays the bills but takes my best three days each week.',
      environmental_2: 'The guest room still looks like a guest room. Nothing in it says coach. My calendar says hospital first and the practice gets the leftovers.',
      social_1: 'My partner, my best friend, and two colleagues from my certification cohort know. One colleague sends me referrals already.',
      social_2: 'I have stopped going to the monthly dinner with my hospital friends because Saturday energy is sacred now. I have not told them why, which feels like hiding.',
    },
  },
  thin: {
    goal: 'Get healthier',
    phase: 'Dreaming',
    answers: {
      physical_1: 'tired', physical_2: 'not much',
      intellectual_1: 'fine', intellectual_2: 'nothing really',
      psychological_1: 'ok I guess', psychological_2: 'fine',
      environmental_1: 'normal', environmental_2: 'sure',
      social_1: 'family', social_2: 'no',
    },
  },
  crisis: {
    goal: 'Finish my degree',
    phase: 'Refining',
    answers: {
      physical_1: 'Exhausted all the time.', physical_2: 'Much worse.',
      intellectual_1: 'Cannot focus on anything.', intellectual_2: 'A voice that says none of this matters.',
      psychological_1: 'Honestly I have started thinking everyone would be better off without me and I have thought about ending it.',
      psychological_2: 'Empty.',
      environmental_1: 'My apartment is a mess.', environmental_2: 'No.',
      social_1: 'Nobody really.', social_2: 'I stopped answering messages.',
    },
  },
};

async function callClaude(userMessage) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: SYNTH.prompt }],
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`API ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data.content[0].text;
}

function parseMap(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  return JSON.parse(t);
}

// --- vocabulary scans -------------------------------------------------------

// Explorer-facing banned machinery words (generated narrative only — the fixed
// legend legitimately contains the four status words and is excluded).
const EXPLORER_BANNED = ['system', 'capacity', 'recruited', 'resourcing', 'draining', 'dominating',
  'unreleased', 'pacing function', 'bandwidth', 'activated', 'deployed', 'operating', 'functioning'];
const EXPLORER_BANNED_RE = EXPLORER_BANNED.map((w) => new RegExp(`\\b${w.replace(' ', '\\s+')}\\b`, 'i'))
  .concat([/\binputs?\b/i, /\bdomains?\b/i]);

// Coach-facing banned clinical vocabulary + mechanical tax framing.
const COACH_BANNED_RE = ['pathological', 'pathology', 'somatic', 'characteristically', 'clinical',
  'compartmentalization', 'presentation', 'modality', 'etiology']
  .map((w) => new RegExp(`\\b${w}\\b`, 'i'))
  .concat([/\btax(ing|ed)?\s+(domain|area)\b/i, /\b(domain|area)\s+is\s+(taxing|paying)\b/i, /\bpaying\s+(domain|area)\b/i]);

// Fixtures are gender-neutral, so any third-person gendered pronoun is invented.
const GENDER_RE = /\b(she|her|hers|herself|he|him|his|himself)\b/i;

function explorerGenerated(map) {
  const ef = map.explorer_facing || {};
  const parts = [];
  for (const d of Object.values(ef.domains || {})) if (d && d.paragraph) parts.push(d.paragraph);
  if (ef.whole_picture) parts.push(ef.whole_picture);
  if (ef.how_this_shows_up) parts.push(ef.how_this_shows_up);
  for (const c of Object.values(ef.closing_summary || {})) if (c && c.plain) parts.push(c.plain);
  if (ef.release_question && ef.release_question.question) parts.push(ef.release_question.question);
  return parts.join('\n\n');
}

function coachGenerated(map) {
  const cf = map.coach_facing || {};
  const parts = [cf.coach_synthesis];
  if (cf.dominant_pattern) parts.push(cf.dominant_pattern.narrative);
  if (cf.cross_domain_tax) parts.push(cf.cross_domain_tax.narrative);
  if (cf.domain_phase_misfit) parts.push(cf.domain_phase_misfit.narrative);
  if (map.lead_domains) parts.push(map.lead_domains.alignment);
  if (map.intake && map.intake.phase_discrepancy) parts.push(map.intake.phase_discrepancy.narrative);
  return parts.filter(Boolean).join('\n\n');
}

// --- fixed copy: distinctive sentences that must survive verbatim ------------
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const EXPLORER_OPENER_LINES = [
  'Most assessments tell you who you are and leave it there',
  'It does not rank any part of you as good or bad, strong or weak.',
  'It looks at one thing: the goal you named.',
  'Nothing here is a verdict on you.',
  'Change the goal, and the picture can change.',
  'Look for what is true.',
  'And what is getting in the way?',
];
const COACH_OPENER_LINES = [
  'This is not a personality test, strengths assessment, or trait ranking.',
  'Nothing here should be read as good or bad.',
  'not as a fixed description of who your client is',
];
const LEGEND_LINES = [
  'fueling your goal, giving you more than it takes',
  'costing you more than it is giving back toward this goal right now',
  'taking up more room than this stage of the goal needs',
  'strength you have that you have not fully turned toward this goal yet',
];

function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  return ok ? 0 : 1;
}

function runChecks(label, map) {
  console.log(`\n=== ${label} ===`);
  let fails = 0;
  if (label === 'crisis') {
    fails += check('crisis_flag true', map.crisis_flag === true);
    fails += check('crisis object only (no explorer_facing/coach_facing)', !map.explorer_facing && !map.coach_facing && !map.intake);
    fails += check('frontend_action present', !!(map.crisis_response && map.crisis_response.frontend_action === 'show_safety_resources'));
    fails += check('crisis prompt_version 1.7', !!(map.metadata && map.metadata.prompt_version === '1.7'));
    return fails;
  }
  const ef = map.explorer_facing || {};
  const cf = map.coach_facing || {};
  const exText = explorerGenerated(map);
  const coText = coachGenerated(map);
  const words = exText.split(/\s+/).filter(Boolean).length;

  fails += check('crisis_flag false', map.crisis_flag === false);
  fails += check('prompt_version 1.7', map.metadata && map.metadata.prompt_version === '1.7');
  const DOMAINS = ['physical', 'intellectual', 'psychological', 'environmental', 'social'];
  fails += check('5 domains with status_label + paragraph',
    DOMAINS.every((k) => ef.domains && ef.domains[k] && ef.domains[k].status_label && ef.domains[k].paragraph));
  const VALID = ['Resourcing', 'Draining', 'Dominating', 'Unreleased'];
  fails += check('status labels exact', DOMAINS.every((k) => VALID.includes(ef.domains[k].status_label)));
  fails += check('whole_picture present (not system_picture)',
    typeof ef.whole_picture === 'string' && ef.whole_picture.length > 50 && !('system_picture' in ef));
  fails += check('how_this_shows_up present', typeof ef.how_this_shows_up === 'string' && ef.how_this_shows_up.length > 50);
  const DIRS = ['for', 'against', 'both', 'neutral'];
  fails += check('closing_summary covers all 5 areas with valid direction',
    !!ef.closing_summary && DOMAINS.every((k) => ef.closing_summary[k] && DIRS.includes(ef.closing_summary[k].direction)));
  fails += check('release_question present', !!(ef.release_question && ef.release_question.question));

  // Fixed copy
  const opener = norm(ef.opener);
  fails += check('explorer opener verbatim', EXPLORER_OPENER_LINES.every((l) => opener.includes(norm(l))),
    EXPLORER_OPENER_LINES.filter((l) => !opener.includes(norm(l))).slice(0, 2).join(' | '));
  const coOpener = norm(cf.opener);
  fails += check('coach opener verbatim', COACH_OPENER_LINES.every((l) => coOpener.includes(norm(l))));
  const legend = norm(map.status_legend).replace(/\*\*/g, '');
  fails += check('status legend verbatim, all four statuses',
    VALID.every((v) => legend.includes(v)) && LEGEND_LINES.every((l) => legend.includes(norm(l))));

  // Voice + vocabulary
  const exBanned = EXPLORER_BANNED_RE.map((re) => exText.match(re)).filter(Boolean).map((m) => m[0]);
  fails += check('no banned machinery vocab in explorer text', exBanned.length === 0,
    exBanned.length ? `found: ${[...new Set(exBanned)].join(', ')}` : '');
  fails += check('second person ("you/your" used)', /\byou\b/i.test(exText) && /\byour\b/i.test(exText));
  fails += check('never "the explorer" in explorer text', !/the explorer/i.test(exText));
  const coBanned = COACH_BANNED_RE.map((re) => coText.match(re)).filter(Boolean).map((m) => m[0]);
  fails += check('no clinical/taxing-paying vocab in coach text', coBanned.length === 0,
    coBanned.length ? `found: ${[...new Set(coBanned)].join(', ')}` : '');
  fails += check('no literal (A)/(B) markers in coach_synthesis', !/\(\s*[AB]\s*\)/.test(cf.coach_synthesis || ''));
  const genderHit = (exText + '\n' + coText).match(GENDER_RE);
  fails += check('no invented gender (fixtures are gender-neutral)', !genderHit, genderHit ? `found: "${genderHit[0]}"` : '');
  fails += check('no judgment ranking words', !/\b(flawed?|virtues?|weakness(es)?|unhealthy)\b/i.test(exText + coText));
  fails += check('coach_synthesis present + questions', typeof cf.coach_synthesis === 'string' && cf.coach_synthesis.length > 100 && /\?/.test(cf.coach_synthesis));
  fails += check('dominant_pattern label present', !!(cf.dominant_pattern && cf.dominant_pattern.label));
  if (cf.cross_domain_tax && String(cf.cross_domain_tax.present) === 'true') {
    fails += check('tax uses draining_area/affected_area fields',
      'draining_area' in cf.cross_domain_tax && 'affected_area' in cf.cross_domain_tax);
  }

  const strength = map.output_length_check && map.output_length_check.overall_evidence_strength;
  if (label === 'strong') {
    fails += check('evidence not thin', strength !== 'thin', `strength=${strength}`);
    fails += check('explorer-facing 500-1300 generated words', words >= 500 && words <= 1300, `${words} words`);
  }
  if (label === 'thin') {
    fails += check('evidence thin', strength === 'thin', `strength=${strength}`);
    // No numeric thin bound in the prompt; measured bound = below the 700-word
    // floor set for moderate/strong. Padding judgment needs a human read.
    fails += check('thin output below moderate/strong floor (<700 words)', words < 700, `${words} words`);
    fails += check('release question from bank', ef.release_question && ef.release_question.source === 'bank',
      `source=${ef.release_question && ef.release_question.source}`);
  }
  console.log(`  (generated explorer-facing words: ${words})`);
  return fails;
}

const results = {};
let totalFails = 0;
for (const [label, input] of Object.entries(CASES)) {
  process.stdout.write(`calling model for ${label}...\n`);
  const raw = await callClaude(buildUserMessage(input));
  let map;
  try { map = parseMap(raw); } catch (e) {
    console.log(`\n=== ${label} ===`);
    totalFails += check('output parses as JSON', false, String(e).slice(0, 120));
    continue;
  }
  results[label] = map;
  totalFails += runChecks(label, map);
}

console.log(`\n${totalFails === 0 ? 'ALL CHECKS PASSED' : totalFails + ' CHECK(S) FAILED'}`);
const { writeFileSync } = await import('fs');
writeFileSync('/tmp/effmap-v17-pressure-test.json', JSON.stringify(results, null, 2));
console.log('full outputs: /tmp/effmap-v17-pressure-test.json');
process.exit(totalFails === 0 ? 0 : 1);
