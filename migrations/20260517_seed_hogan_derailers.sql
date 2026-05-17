-- Seed the 11 Hogan Development Survey derailers as initial canonical patterns.
-- Source: Hogan Development Survey overview guide (hoganassessments.com)
-- All seeded with modality ['executive'], status 'canonical'.
-- Definitions translated into Gestalt voice (effective_at / ineffective_at) per
-- platform vocabulary commitment. Hogan's original strength/derailer framings
-- preserved in behavioral_markers for coaches trained on Hogan instruments.
--
-- IMPORTANT: approved_by is set to Kim McLeod's coach_id
-- ('8c5fb4de-2ff0-45fd-a543-4e1b149527ee'). Verified pre-apply via:
--   SELECT id FROM coach_profiles WHERE user_email = 'drkmcleod@gmail.com';

INSERT INTO pattern_taxonomy
  (canonical_name, aliases, domain, modalities, definition, behavioral_markers,
   status, source, created_by, approved_by, approved_at)
VALUES

-- MOVING AWAY cluster: managing insecurity by avoiding others
(
  'excitable',
  ARRAY['emotional volatility', 'reactive under pressure', 'mood-driven leadership'],
  'emotional_regulation',
  ARRAY['executive'],
  'Emotional response amplifies under pressure, with mood shifts that may feel disorienting to colleagues. Effective at conveying urgency and genuine investment in stable conditions; ineffective when sustained reactivity erodes psychological safety in teams. The pattern protects against feeling unheard or dismissed by ensuring the leader is impossible to ignore.',
  jsonb_build_object(
    'effective_at', ARRAY['conveying urgency', 'expressing genuine investment', 'signaling stakes clearly'],
    'ineffective_at', ARRAY['holding steady under sustained pressure', 'creating psychological safety in teams', 'separating reactivity from accurate signal'],
    'hogan_strength_framing', 'Great charisma and excitement for projects and people',
    'hogan_derailer_framing', 'Moodiness, sensitivity to criticism, and volatile emotional displays',
    'cluster', 'moving_away'
  ),
  'canonical',
  'hogan_hds_seed',
  '8c5fb4de-2ff0-45fd-a543-4e1b149527ee',
  '8c5fb4de-2ff0-45fd-a543-4e1b149527ee',
  NOW()
),
(
  'skeptical',
  ARRAY['cynical interpretation', 'threat scanning', 'distrust by default'],
  'cognitive_patterns',
  ARRAY['executive'],
  'Interprets ambiguous signals as evidence of threat, deception, or hidden agendas. Effective at navigating environments where political awareness and reading subtext matters; ineffective when neutral interactions are read as adversarial, eroding the relationships the leader needs to do the work. The pattern protects against being naive or blindsided by maintaining vigilance.',
  jsonb_build_object(
    'effective_at', ARRAY['navigating organizational politics', 'spotting genuine deception', 'reading subtext under high stakes'],
    'ineffective_at', ARRAY['building trust with new collaborators', 'extending good faith on incomplete information', 'releasing grudges once they no longer serve'],
    'hogan_strength_framing', 'Excellent navigators of organizational politics',
    'hogan_derailer_framing', 'Cynical, distrustful, and quick to doubt others'' intentions',
    'cluster', 'moving_away'
  ),
  'canonical',
  'hogan_hds_seed',
  '8c5fb4de-2ff0-45fd-a543-4e1b149527ee',
  '8c5fb4de-2ff0-45fd-a543-4e1b149527ee',
  NOW()
),
(
  'cautious',
  ARRAY['decision avoidance', 'risk aversion', 'analysis paralysis', 'fear of mistakes'],
  'decision_making',
  ARRAY['executive'],
  'Delays decisions in pursuit of more information, certainty, or risk reduction. Effective at preventing impulsive errors in high-stakes contexts; ineffective when the cost of delay exceeds the cost of imperfect decisions, or when caution becomes indistinguishable from avoidance. The pattern protects against the visible failure of a wrong decision by preferring the invisible cost of no decision.',
  jsonb_build_object(
    'effective_at', ARRAY['preventing impulsive errors', 'gathering sufficient information', 'identifying overlooked risks'],
    'ineffective_at', ARRAY['moving decisions through when time-bound', 'distinguishing real risk from imagined risk', 'tolerating visible imperfection in service of speed'],
    'hogan_strength_framing', 'Careful, conscientious corporate citizens',
    'hogan_derailer_framing', 'Unwilling to take risks or offer opinions, sometimes paralyzed by fear of failure',
    'cluster', 'moving_away'
  ),
  'canonical',
  'hogan_hds_seed',
  '8c5fb4de-2ff0-45fd-a543-4e1b149527ee',
  '8c5fb4de-2ff0-45fd-a543-4e1b149527ee',
  NOW()
),
(
  'reserved',
  ARRAY['emotional unavailability', 'withdrawal under stress', 'aloofness'],
  'interpersonal_dynamics',
  ARRAY['executive'],
  'Creates distance from others under stress, becoming hard to read or reach. Effective at maintaining independent judgment and working through complex problems without social interference; ineffective when the team needs presence, signal, or warmth and receives silence instead. The pattern protects against feeling depleted by social demand by withdrawing the demand.',
  jsonb_build_object(
    'effective_at', ARRAY['independent deep work', 'maintaining composure in chaotic environments', 'preserving judgment under social pressure'],
    'ineffective_at', ARRAY['conveying warmth or care when team needs it', 'reading the room and responding to others'' emotional states', 'staying present when withdrawal would feel safer'],
    'hogan_strength_framing', 'Strong, independent, and comfortable working alone',
    'hogan_derailer_framing', 'Aloof, detached, and disinterested in the feelings of others',
    'cluster', 'moving_away'
  ),
  'canonical',
  'hogan_hds_seed',
  '8c5fb4de-2ff0-45fd-a543-4e1b149527ee',
  '8c5fb4de-2ff0-45fd-a543-4e1b149527ee',
  NOW()
),
(
  'leisurely',
  ARRAY['passive resistance', 'covert non-compliance', 'public agreement private dissent'],
  'interpersonal_dynamics',
  ARRAY['executive'],
  'Appears agreeable and cooperative on the surface while quietly following one''s own agenda or resisting authority. Effective at maintaining autonomy in environments that punish open disagreement; ineffective when the gap between surface compliance and private action erodes trust, predictability, or accountability. The pattern protects against direct confrontation by routing disagreement underground.',
  jsonb_build_object(
    'effective_at', ARRAY['maintaining autonomy under controlling leadership', 'preserving one''s own priorities in misaligned systems', 'avoiding pointless confrontation'],
    'ineffective_at', ARRAY['voicing disagreement directly when it would serve the work', 'aligning actions to stated commitments', 'building trust that survives the gap between surface and substance'],
    'hogan_strength_framing', 'Agreeable and pleasant to work with',
    'hogan_derailer_framing', 'Overtly cooperative but privately irritable, stubborn, and uncooperative',
    'cluster', 'moving_away'
  ),
  'canonical',
  'hogan_hds_seed',
  '8c5fb4de-2ff0-45fd-a543-4e1b149527ee',
  '8c5fb4de-2ff0-45fd-a543-4e1b149527ee',
  NOW()
),

-- MOVING AGAINST cluster: managing self-doubt by dominating
(
  'bold',
  ARRAY['inflated self-confidence', 'arrogance', 'overestimation', 'dismissal of feedback'],
  'self_concept',
  ARRAY['executive'],
  'Operates from a self-assessment that exceeds external evidence, particularly under pressure. Effective at projecting confidence in ambiguous situations where conviction itself moves outcomes; ineffective when the gap between self-assessment and reality produces decisions that overpromise, underdeliver, or dismiss correctives. The pattern protects against the felt experience of inadequacy by treating it as a signal to amplify rather than examine.',
  jsonb_build_object(
    'effective_at', ARRAY['projecting confidence under ambiguity', 'taking visible risks others would avoid', 'moving organizations through inertia'],
    'ineffective_at', ARRAY['receiving feedback that contradicts self-assessment', 'distinguishing earned confidence from defensive overestimation', 'apologizing without rationalizing'],
    'hogan_strength_framing', 'Confident and self-assured',
    'hogan_derailer_framing', 'Overly self-confident, arrogant, with inflated feelings of self-worth',
    'cluster', 'moving_against'
  ),
  'canonical',
  'hogan_hds_seed',
  '8c5fb4de-2ff0-45fd-a543-4e1b149527ee',
  '8c5fb4de-2ff0-45fd-a543-4e1b149527ee',
  NOW()
),
(
  'mischievous',
  ARRAY['rule bending', 'limit testing', 'risk seeking', 'exception making'],
  'navigating_systems',
  ARRAY['executive'],
  'Treats rules, norms, and constraints as negotiable or applicable to others. Effective at finding novel paths through systems that punish conformity, or at recognizing when a rule has outlived its purpose; ineffective when the pattern erodes the trust, predictability, or institutional standing that the leader depends on. The pattern protects against the felt experience of being constrained by treating constraint as evidence of insufficient cleverness.',
  jsonb_build_object(
    'effective_at', ARRAY['finding paths around outdated constraints', 'reading systems for genuine flexibility', 'finding the negotiable space in apparently rigid structures'],
    'ineffective_at', ARRAY['recognizing when rules are protecting something important', 'distinguishing creative exception from self-serving exemption', 'accepting consequences when boundaries are tested too far'],
    'hogan_strength_framing', 'Charming, risk-taking, and excitement-seeking',
    'hogan_derailer_framing', 'Manipulating, bending, or breaking the rules — or believing the rules don''t apply to you',
    'cluster', 'moving_against'
  ),
  'canonical',
  'hogan_hds_seed',
  '8c5fb4de-2ff0-45fd-a543-4e1b149527ee',
  '8c5fb4de-2ff0-45fd-a543-4e1b149527ee',
  NOW()
),
(
  'colorful',
  ARRAY['attention seeking', 'performative expression', 'dominating airspace', 'theatrical presence'],
  'self_expression',
  ARRAY['executive'],
  'Expression amplifies in proportion to the size of the audience or stakes of the moment. Effective at energizing groups, drawing attention to neglected issues, and making invisible work visible; ineffective when expression becomes about the expresser rather than the substance, or crowds out other voices that the work needs. The pattern protects against the felt experience of being unseen by ensuring visibility.',
  jsonb_build_object(
    'effective_at', ARRAY['energizing rooms and audiences', 'drawing attention to overlooked issues', 'inhabiting public moments with presence'],
    'ineffective_at', ARRAY['listening when the room needs to be heard', 'distinguishing substance from performance in one''s own contributions', 'making space for less visible voices'],
    'hogan_strength_framing', 'Energetic and engaging',
    'hogan_derailer_framing', 'Dramatic, attention-seeking, interruptive, and poor listening skills',
    'cluster', 'moving_against'
  ),
  'canonical',
  'hogan_hds_seed',
  '8c5fb4de-2ff0-45fd-a543-4e1b149527ee',
  '8c5fb4de-2ff0-45fd-a543-4e1b149527ee',
  NOW()
),
(
  'imaginative',
  ARRAY['unusual thinking', 'eccentric framing', 'unpredictable conceptual moves'],
  'cognitive_patterns',
  ARRAY['executive'],
  'Generates conceptual moves that diverge from conventional framing — sometimes brilliantly, sometimes confusingly. Effective at producing genuine creative breakthroughs and seeing past inherited assumptions; ineffective when the unusual framing makes the leader hard to follow, undermines credibility with operational teams, or substitutes novelty for accuracy. The pattern protects against the felt constraint of conventional thinking by routinely escaping it.',
  jsonb_build_object(
    'effective_at', ARRAY['seeing past inherited assumptions', 'generating genuinely novel framings', 'noticing what conventional thinking misses'],
    'ineffective_at', ARRAY['translating novel ideas into language others can follow', 'maintaining credibility with operational teams', 'distinguishing creative insight from off-track tangent'],
    'hogan_strength_framing', 'Creative and imaginative',
    'hogan_derailer_framing', 'Thinking and acting in unusual or eccentric ways, unpredictable',
    'cluster', 'moving_against'
  ),
  'canonical',
  'hogan_hds_seed',
  '8c5fb4de-2ff0-45fd-a543-4e1b149527ee',
  '8c5fb4de-2ff0-45fd-a543-4e1b149527ee',
  NOW()
),

-- MOVING TOWARD cluster: managing insecurity by building alliances
(
  'diligent',
  ARRAY['perfectionism', 'micromanagement', 'standards inflation', 'inability to delegate'],
  'action_followthrough',
  ARRAY['executive'],
  'Holds standards of execution that exceed what the situation requires, applied both to self and to others. Effective at producing high-quality work in contexts where precision genuinely matters; ineffective when the cost of the standard exceeds the value it produces, or when delegation requires accepting work the leader would do differently. The pattern protects against the felt risk of being judged inadequate by ensuring everything meets a standard no one can fairly criticize.',
  jsonb_build_object(
    'effective_at', ARRAY['producing precise high-quality work', 'catching errors before they propagate', 'maintaining standards in contexts that genuinely require them'],
    'ineffective_at', ARRAY['delegating work that others will do differently', 'distinguishing necessary precision from defensive over-investment', 'allowing good-enough to be enough'],
    'hogan_strength_framing', 'Meticulous and precise',
    'hogan_derailer_framing', 'Hard to please, tends to micromanage',
    'cluster', 'moving_toward'
  ),
  'canonical',
  'hogan_hds_seed',
  '8c5fb4de-2ff0-45fd-a543-4e1b149527ee',
  '8c5fb4de-2ff0-45fd-a543-4e1b149527ee',
  NOW()
),
(
  'dutiful',
  ARRAY['conforming', 'deference to authority', 'avoidance of disagreement', 'eager to please'],
  'interpersonal_dynamics',
  ARRAY['executive'],
  'Defers to authority and avoids the experience of being in conflict with people whose approval matters. Effective at building alliances, navigating hierarchical systems, and absorbing the work of holding relationships together; ineffective when deference prevents the leader from voicing necessary disagreement, advocating for direct reports, or holding ground against pressure from above. The pattern protects against the felt threat of disapproval by removing the conditions that would produce it.',
  jsonb_build_object(
    'effective_at', ARRAY['building alliances upward and across', 'absorbing the relational labor of hierarchical systems', 'reading what authority figures want before they ask'],
    'ineffective_at', ARRAY['voicing disagreement with authority when the work requires it', 'advocating for direct reports against pressure from above', 'distinguishing genuine alignment from compliance under threat'],
    'hogan_strength_framing', 'Loyal and eager to please',
    'hogan_derailer_framing', 'Conforming, deferential to authority, reluctant to disagree',
    'cluster', 'moving_toward'
  ),
  'canonical',
  'hogan_hds_seed',
  '8c5fb4de-2ff0-45fd-a543-4e1b149527ee',
  '8c5fb4de-2ff0-45fd-a543-4e1b149527ee',
  NOW()
);
