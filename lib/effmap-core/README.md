# effmap-core

Shared core for the **Effectiveness Map** feature, vendored into both product repos via **git subtree** (not npm — these are buildless static + Vercel-functions repos).

## Contents
- `effmap-limits.js` — tier limits + monthly Map count (single source of truth for the usage gate).
- `map-link.js` — HMAC sign/verify for coach-assigned intake links.
- `prompts/` — versioned Map synthesis prompts (`effectiveness-map-synthesis-v*.json`). `v1.7.2` is the active coaching prompt.

## Consumed by
- `mcleodkr/ineedcoaching-website` at `lib/effmap-core/`
- `mcleodkr/ineedtherapy-website` at `lib/effmap-core/` (added when therapy endpoints land)

## Sync (from a consuming repo)
```
# pull updates
git subtree pull --prefix=lib/effmap-core https://github.com/mcleodkr/effmap-core.git main --squash
# push changes made in the consuming repo back upstream
git subtree push --prefix=lib/effmap-core https://github.com/mcleodkr/effmap-core.git main
```

Edit the shared modules **here** (or via subtree push), never by hand-editing one vendored copy — that's how the two repos drift.
