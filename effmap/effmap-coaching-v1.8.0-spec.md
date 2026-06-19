# Effectiveness Map — Coaching `coach_facing` Contract (v1.8.0)

Status: shipped. Supersedes the v1.7.x coach layer. This document describes the
coach-facing ("Intelligence Notes") output produced by the coaching synthesis prompt
`lib/effmap-core/prompts/effectiveness-map-synthesis-v1.8.0.json` and rendered by both
`effectiveness-map-panel.html` and `coach-dashboard.html`.

The explorer-facing (client-visible) contract is unchanged by v1.8.0.

## Why this rewrite

The v1.7.x coach layer leaned on `coach_synthesis` + `coach_recommended_focus` +
`cross_domain_tax`, which restated the client Map and blurred the line between what to
read and what to do in session. v1.8.0 restructures the coach layer into a working
brief for the next session: an integrative read, an explicit hypothesis, the one
cross-domain dynamic that matters, the leverage point, a directional stance, three
grounded questions, and a transparent interpretation-support panel.

## Output shape (`raw_output.coach_facing`)

Displayed fields (primary coach layer, in render order):

| Field | Type | Description |
|---|---|---|
| `coach_synthesis` | string, 3–5 sent. | Integrates the five-domain picture; names the central tension/convergence; separates what carries the goal from what creates friction; ends on the coaching implication. Never restates domains in client-Map order; never echoes the client `whole_picture`/`how_this_shows_up`. |
| `working_hypothesis` | string, 2–3 sent. | One hypothesis tied to the client's words. Tentative framing required ("One possibility worth exploring is…", "The Map suggests…", "A working hypothesis for the session is…"). Not a label, not a diagnosis. |
| `cross_domain_dynamic` | string, 2–3 sent. | One consequential 2–3 domain interaction invisible when domains are read separately; why it matters next session. Does not repeat the synthesis. |
| `leverage_point` | string, 3–4 sent. | The one domain/tension where a small move creates broad movement: which, why, what it frees, why it fits the phase. Does not summarize all five. |
| `session_stance` | string, 4–6 sent. | Directional, non-prescriptive: validate / explore / avoid reinforcing / listen for / small experiment. Final sentence exploratory, not interpretive. |
| `session_questions` | string[3] | Q1 lived experience (concrete detail) → Q2 what the pattern protects/costs/maintains → Q3 a small this-week move. |
| `interpretation_support` | object | `{ overall: "strong\|moderate\|limited", rationale: string, by_domain: { <5 domains>: { evidence_strength: "thin\|moderate\|strong", interpretation_confidence: "low\|medium\|high" } } }`. Rendered collapsed. |

Legacy / compat-only fields (still emitted, **not** displayed in the v1.8.0 layer):

| Field | Type | Why retained |
|---|---|---|
| `opener` | string | Fixed coach opener; moved behind a "How this Map works" collapsible in the UI. |
| `dominant_pattern` | `{label, narrative}` | `label` is **required** — it populates the stored `dominant_pattern_label` column used for analytics and longitudinal tracking. `narrative` is legacy only. |
| `coach_recommended_focus` | string | Retained for already-generated rows; not rendered. |
| `cross_domain_tax` | `{present, draining_area, affected_area, narrative}` | Minimal compat stub on new Maps (same shape); the endpoint banned-vocab scan and the legacy render read `cross_domain_tax.narrative`. |
| `domain_phase_misfit` | `{present, narrative}` | Legacy only; retained in shape. |

## Rendering rules

- **Detection:** the new layer renders when any of `leverage_point`, `session_stance`,
  `working_hypothesis`, `cross_domain_dynamic`, `session_questions`, or
  `interpretation_support` is present. Otherwise the **legacy** render runs (opener +
  coach_synthesis + cross_domain_tax + "Dominant pattern" + evidence/confidence table +
  overall evidence). No old Map renders broken.
- **Overall metric (C5):** the displayed "Overall" comes from
  `interpretation_support.overall` (`strong|moderate|limited`). The legacy DB column
  `overall_evidence_strength` (`thin|moderate|strong`) is **not** shown in the new layer
  and is left untouched for old rows / analytics. The two enums intentionally differ.
- **Per-domain table source (C6):** the panel/dashboard derive each domain's
  `evidence_strength` and `interpretation_confidence` from `explorer_facing.domains`,
  **not** from `interpretation_support.by_domain`. The prompt still emits `by_domain`
  (for storage) and must keep it consistent with `explorer_facing.domains`, but the UI
  reads the already-present explorer values to eliminate drift.
- **Dominant pattern (C7):** the "Dominant pattern: …" line is removed from the new UI
  only. `dominant_pattern.label` continues to populate the DB column from the data.

## Migration / backward compatibility

- No data migration. Existing `effectiveness_maps` rows keep their v1.7.x `coach_facing`
  and render via the legacy path.
- The OUTPUT shape retains `dominant_pattern{label,narrative}`, `coach_recommended_focus`,
  `cross_domain_tax{}`, `domain_phase_misfit{}`, and `opener` so old-row reads, the
  `dominant_pattern_label` column, and the endpoint banned-vocab scan never error.
- New Maps (prompt_version `1.8.0`) carry all new fields and render in the new layer.

## Affected files

- `lib/effmap-core/prompts/effectiveness-map-synthesis-v1.8.0.json` (renamed from
  `…-v1.7.4.json`; internal `version` → `1.8.0`).
- `api/generate-effectiveness-map.js` (`require()` path + comment).
- `effectiveness-map-panel.html` and `coach-dashboard.html` (`effmapIntelHtml` /
  `effmapIntelNew`, kept in sync).

> Note: `lib/effmap-core/` is a git subtree shared with the therapy product; prompt
> edits here do not propagate upstream without a separate subtree push.
