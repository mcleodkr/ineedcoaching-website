# ineedcoaching.org — Claude Code Rules

## Design System
- Colors: Navy #1a3a52 (primary), Gold #c49a3c (accent), Cream #f7f4ee (background), Dark green #1a2e1a (courses only)
- Fonts: Cormorant Garamond (headlines, display), DM Sans 18px (body)
- All UI must use these fonts — never Inter, Arial, or system fonts
- Page background: #f7f5f1. Card backgrounds: #ffffff. Borders: #e8e4dc.
- All text on dark backgrounds must be white or #f0f0f0 minimum — never dark grey on dark

## UI/UX Standards (Pro Max)
- Every UI component must be production-grade — not a skeleton, not a placeholder
- Sidebar navigation over horizontal tab bars for dashboards with more than 5 items
- Active nav state: gold left border + gold tinted background
- Buttons must have visual hierarchy: gold filled = primary, navy outlined = secondary, muted = tertiary
- All buttons: cursor pointer, transition all 0.15s ease, DM Sans 0.85rem
- Cards: white background, 1px solid #e8e4dc border, 10px border-radius, subtle box-shadow
- Section headers: Cormorant Garamond 1.15rem 600 navy, border-bottom 1px solid #e8e4dc
- Tab bars: pill-in-bar pattern (background container, white active tab with shadow)
- No component ships without hover states, loading states, and empty states

## Architecture Rules
- Never use Vercel CLI — always deploy via git push
- Empty git commits for force redeploy: git commit --allow-empty
- Supabase schema changes: generate SQL for manual execution in SQL Editor
- Single-quote escaping in SQL: use '' not \'
- emailRedirectTo always hardcoded to ineedcoaching.org in all 8 authenticated pages

## Code Quality
- Never break existing functionality when adding new features
- All global variables must be declared at script top level
- notesByBooking must always be globally accessible
- Null guards on every array iteration in render functions
- Every API response wrapped in try/catch with readable error messages

## Tone and Language (AI outputs)
- Never directive — always suggestive
- Never say: should, must, ask her, do this, don't
- Always say: you might explore, one possible direction, it may be worth
- Coach Clarity is the AI identity — never say "the system" or "AI generated"
- All coaching intelligence output must include why it matters

## Intelligence Architecture (DO NOT DRIFT FROM THIS)
- Mirror (generate-post-session-intelligence.js) = per-session learning. What happened, what you did, what you missed.
- DNA (generate-coach-dna.js) = pattern-level identity. Derived ONLY from Mirror outputs, never from raw transcripts.
- Approach Lab = future build. Not yet implemented.
- Mirror teaches what happened. DNA teaches who the coach is becoming. Approach Lab teaches how they could evolve.
- DNA requires post_session_analysis field from coach_session_notes. Never analyze frameworks_detected arrays directly.

## Coaching Identity Guardrail (ENFORCE ALWAYS)
This platform is for coaches, not therapists. All AI outputs must reflect coaching identity.

DO NOT use:
- diagnostic language or clinical labeling
- mental health disorder framing or condition names
- terms like: dysregulation, maladaptive, pathology, borderline, disorder, trauma (as diagnosis)

DO use:
- observable patterns and behavioral tendencies
- client language and repeated phrases
- emotional responses as experienced, not diagnosed
- patterns that may be driving behavior (fear of loss, need for approval, avoidance of discomfort)

Translate therapeutic modalities into coaching lenses:
- DBT → Emotion Regulation + Validation Approach
- ACT → Acceptance + Values-Based Action Approach
- CBT → Thought Pattern Reframe Approach
- MI → Motivation + Change Talk Approach

Always explain approaches in terms of:
- how the coach listens
- what the coach prioritizes
- how the coach responds
- what the coach is trying to shift in the client

Language replacements (always):
- "emotional dysregulation" → "difficulty staying with emotion"
- "avoidant behavior" → "tendency to step away from discomfort"
- "maladaptive pattern" → "pattern that isn't working for them"
- "intervention" → "move" or "approach"
- "client profile" → "client pattern map"
