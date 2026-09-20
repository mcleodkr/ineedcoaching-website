# ineedcoaching.org — Claude Code Rules

## Design System

Palette. Plum and lime. These are the only brand colors. Do not introduce
new hues, gradients, or tints without asking.

  Plum deep       #2E0F26   hero bands, closing bands, dark cards
  Plum mid        #4C1F41   secondary dark bands
  Plum ink        #1A0A15   footer, signed-in app chrome
  Plum surface    #3A1330   raised surfaces on dark ground
  Lime            #D4F048   single accent: primary buttons, rules,
                            active states, numerals, eyebrows
  Paper           #F7F3F5   default light ground
  Paper shade     #EFE6EB   alternate light band, muted cards
  Ink             #241019   body text on light
  Ink muted       #7D5C6E   secondary text on light
  Line            #E2D4DB   hairlines and borders on light
  On-dark text    #F7F3F5   headings and body on plum
  On-dark muted   #C6AAB9   secondary text on plum

Lime is an accent, never a ground. Never set lime as a page or section
background. Text on lime is always #2E0F26.

Typography.
  Display: Fraunces, Georgia, serif. Headings only. Weight 500 to 600,
           letter-spacing -0.015em to -0.02em.
  Body:    Schibsted Grotesk, system-ui, sans-serif. Weight 400 to 700.
  Load:    https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..800&family=Schibsted+Grotesk:wght@400..700&display=swap

Do not use Inter, Roboto, Arial, Cormorant Garamond, DM Sans, Playfair, or
Instrument Serif anywhere.

Banned visual patterns.
  No gradient washes or glows.
  No handwritten or script-face overlays on photography.
  No generic line icons for category tiles. Use a lime rule plus a label.
  No pill-shaped buttons. Border radius is 0 to 3px.
  No emoji in UI.

Buttons.
  Primary:   background lime, text #2E0F26, radius 2px, weight 700.
  Secondary: transparent, 1px border in #241019 on light or #7A4568 on
             dark, weight 600.
  Minimum touch target 44px.

Contrast. Body text meets 4.5:1. Large text at 24px and above meets 3:1.
Never place #9C7F90 or lighter on #F7F3F5 for body copy.

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

## PENDING BUILDS — DO NOT FORGET
- Predictive risk signals: client drop-off detection, product adoption risk, first session funnel tracking
- Stripe usage-based billing tiers based on coach_clarity_usage data
- User self-signup flow on ineedcoaching.org homepage (clients need a way to create accounts)
- Supabase Auth redirect URL allowlist — add ineedcoaching.org/client-dashboard.html and /dashboard.html
- Mobile hamburger nav on all three sites
- SPRIXLE_TRANSFER.md — document intelligence architecture before handoff
