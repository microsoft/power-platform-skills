# Automatic Native Design

Use this complete path when `CODE_APPS_NATIVE_ORCHESTRATING=1`, the V3
contracts exist, and the maker did not explicitly request brand/reference,
gallery, comparison, refresh, reskin, theme, history, sibling-app, or Power
Pages work. Do not ask brand, cost, style, HTML, or screenshot questions and do
not dispatch a second design-model task.

## Read budget

Read only:

- `.tmp/experience-contract.json`;
- `.tmp/experience-foundation-contract.json`;
- `.tmp/experience-screen-contract.json`;
- `.tmp/navigation-contract.json` when present;
- the `## Design` section of `native-app-plan.md` only when a required value is
  absent from structured contracts.

Do not read `optional-modes.md`, extraction references, style-picker files,
brand examples, galleries, or named direction files. Write
`.tmp/design-context-evidence.json` containing `mode: automatic-native`, the
relative files read, exact byte counts, and `designModelCalls: 1`.

## Authority

Preserve the approved primary job, Home role, launch/resume route, durable
destinations, nested ownership, first-viewport order, primary action, context,
media policy, capability placement, states, signature components, and
forbidden defaults. Industry vocabulary may refine copy or status semantics;
it cannot choose a palette, dashboard, card anatomy, or navigation model.

## Design decisions

Use the combined audience, job, interaction mode, visual character, content
density, focal point, media role, and real fixture examples to choose:

- an accessible palette direction with distinct brand, primary action,
  selection, warning, error, destructive, success, and information roles;
- expressive but readable display/body/utility typography intent;
- spacing, shape, elevation, and surface rhythm appropriate to the product;
- media prominence, aspect ratio, crop/containment, loading, and fallback;
- reduced-motion-safe transitions and state feedback;
- 2-5 app-specific signature components from the Foundation Contract.

Do not use a fixed blue, brown, inspection green, airline palette, or generic
operational preset. A named organization influences the host palette only when
the brief clearly identifies it as the app owner; products and integrations
remain content context.

## First viewport

Keep exactly one dominant region and one visually primary action. Preserve the
contract region order and useful context near the top. The focal region must
not exceed its viewport budget, and the next meaningful content remains
visible. Avoid repeated headings, empty decorative height, KPI grids, generic
CRUD triads, card walls, and decorative media that displaces the job.

Choose anatomy by product mode:

- discovery/commerce: contextual header, curated media focus, category path,
  visible browse/shop action;
- operations: current priority or resumable work, status/context, continue;
- capture: scanner/camera focus, task context, manual fallback;
- tracking: meaningful current status/progress and next action;
- communication: attention-worthy conversation/inbox;
- learning: continue-learning item and progress;
- onboarding: current step, value preview, forward action.

## Component recipes

Document these reusable recipes in `brand/design-system.md` and map them to the
matching Screen Contract patterns. Do not render every section as a card.

| Recipe | Required anatomy |
|---|---|
| `FeatureCard` | one focal media/status region, context, title, supporting copy, one CTA |
| `ProductCard` | image, category/name, price, availability, one action |
| `RecordRow` | dense identifier, status, metadata, disclosure |
| `ResumeCard` | current work, progress/saved state, continue action |
| `CategoryTile` | semantic icon or image plus a short label |
| `StatusSummary` | semantic status, decision context, next action |

All recipes use dynamic height, at most one primary CTA, bounded title lines,
responsive minimum width, and consistent media ratio within a collection.
Operational products prefer dense rows; consumer discovery uses purposeful
media cards rather than database rows.

## Media

Use fixture/domain media interfaces only; screens never own literal URLs.
`local-first` requires bundled assets. `remote-cdn-cached` requires an approved
URL, stable cache key, bundled fallback, alt text, aspect-ratio intent, loading,
and error fallback. Icons supplement required imagery and never replace it.

## Native behavior

Navigation styling follows the Navigation Contract. Preserve one header and
safe-area owner. Sticky actions clear tabs, keyboard, and device bottom inset;
the last content item scrolls fully above them. Preserve Dynamic Type,
screen-reader order/labels/values, 44-point targets, non-color status cues,
keyboard avoidance, long strings, modal containment, and reduced motion.

## Outputs

Write:

1. `brand/design-system.md` with Brand (inferred/none), Palette, Status Palette,
   Typography, Spacing, Components, Product Experience Primitives, Motion,
   Negatives, and Provenance;
2. `brand/tokens.ts` with complete Tamagui-compatible semantic tokens;
3. `.tmp/design-context-evidence.json` with the bounded read/model-call record.

Do not render a gallery on this path. Validate required sections, semantic role
separation, contrast, 2-5 primitives, contract/navigation consistency, and
changed-file safety. Return `DONE` only after both design artifacts validate.
