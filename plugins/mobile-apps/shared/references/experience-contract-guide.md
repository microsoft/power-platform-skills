# Product Experience Contract

The Product Experience Contract is the one machine-readable source of truth
for product decisions that must survive planning, design, screen generation,
mock data generation, refinement, and visual QA. It is created from a normal
one-line or few-line brief; a screenshot, HTML page, or image is optional.

## Artifacts

| Artifact | Owner | Purpose |
|---|---|---|
| `.tmp/experience-contract.json` | foreground creation workflow | Brief-derived product experience |
| `.tmp/experience-screen-contract.json` | foreground creation workflow, from the return-only `screen-planner` contract | Canonical primary-screen composition and runtime anchors |
| `.tmp/experience-foundation-contract.json` | foreground creation workflow, from the return-only `screen-planner` contract | Hash-bound ownership of the 2-5 reusable motif components |
| `.tmp/screen-build-pack.json` | compiler/orchestrator | Compact revision-bound assembly sheet for builders, mocks, refiner, and validation |
| `native-app-plan.md` → `## Design` | foreground creation workflow, from the return-only `native-app-planner` bundle | Human-reviewable Product Experience Contract mirror |
| `brand/design-system.md` → `## Product Experience Primitives` | `/design-system` | Token/component translation of motifs and hierarchy |
| `.tmp/experience-visual-review.json` | native review/refiner | Native evidence for the product experience |

## Required Contract Shape

`schemaVersion` is `1`. The core fields are:

```json
{
  "audience": "consumer | employee | mixed",
  "primaryJob": "What a person is trying to accomplish",
  "interactionMode": "discover | browse | operate | decide | create | track | communicate | learn",
  "contentModel": ["products | categories | cart | people | tasks | media | records | locations | documents | messages"],
  "primarySurface": "product-led-discovery | task-led-workflow | availability-led-discovery | other",
  "assetPolicy": {
    "connectivity": "offline-preferred | network-optional | unknown",
    "media": "local-first | remote-allowed | not-applicable"
  },
  "promptEvidence": {
    "audience": [{ "signal": "passenger", "text": "passengers", "start": 0, "end": 10 }],
    "primaryJob": [{ "signal": "commerce", "text": "selling", "start": 11, "end": 18 }],
    "interactionMode": [{ "signal": "commerce", "text": "selling", "start": 11, "end": 18 }],
    "entryMode": [{ "signal": "discovery", "text": "showcasing", "start": 19, "end": 29 }],
    "contentModel": [{ "signal": "product", "text": "products", "start": 30, "end": 38 }],
    "primarySurface": [{ "signal": "product", "text": "products", "start": 30, "end": 38 }],
    "assetPolicy": [{ "signal": "offline", "text": "in flight", "start": 39, "end": 48 }]
  },
  "entryMode": "discovery | workflow | overview | inbox | feed | detail-first | capture | onboarding",
  "navigationModel": "tabs-stack | stack | modal-flow | drawer | other",
  "primaryScreen": {
    "route": "/(app)/home",
    "file": "app/(app)/home.tsx",
    "compositionKind": "<entryMode>"
  },
  "firstViewport": {
    "focalPoint": "...",
    "regionOrder": ["context", "feature", "primary-action", "supporting-content"],
    "primaryAction": "...",
    "contentDensity": "sparse | balanced | dense"
  },
  "signatureMotifs": ["2-5 intentional motifs"],
  "forbiddenDefaults": ["hard negatives"],
  "visualCharacter": "quiet-editorial | confident-utility | warm-friendly | energetic | playful | minimal-refined | other",
  "confidence": "high | medium | low"
}
```

Prompt evidence records exact source spans for major decisions, so a semantic
inference can be reviewed without treating one matching keyword as product
strategy. `confidence: low` permits one focused clarification about the first
user outcome. It does not justify an industry picker or a generic visual preset.

## Composition Rules

`/(app)/home` is a fixed Expo Router route, not a dashboard requirement. The
entry mode chooses the primary composition:

| Entry mode | Required primary emphasis |
|---|---|
| `discovery` | Featured choice or collection and a guided path into options |
| `workflow` | The next meaningful step and a clear continuation action |
| `overview` | A prioritized signal and decision context |
| `inbox` | The conversation or queue that needs attention |
| `feed` | A meaningful content sequence and contextual follow-up |
| `detail-first` | A relevant object or decision directly in context |
| `capture` | The capture action/surface before history or dashboards |
| `onboarding` | Value preview and a focused start action |

List, Detail, and Form are implementation shells. They are added only when the
primary job needs browsing, a focused object decision, or structured input.
Persistent data entities do not imply a List/Detail/Form trio.

`home-dashboard` is allowed only for `overview` when it is not forbidden. It
is prohibited for discovery and capture.

## Runtime Anchors

The primary screen must render these literal `testID` values in visual source
order:

```text
experience-region-<normalized-region>
experience-primary-action
experience-motif-<normalized-motif>
```

The screen contract contains the exact required markers. Builders must not
replace them with dynamic/generated names because static gates inspect the
source file.

## Foundation Ownership

`plan-experience-foundation.js` materializes one manifest primitive per
signature motif. The screen planner selects it, `/design-system` writes its
visual recipe under `## Product Experience Primitives`, and the Step 10.8
scaffold creates the exact component file under `src/components/experience/`.
Screen builders import those files; they do not recreate signature motif UI in
parallel screen files. The manifest is capped at five primitives to avoid a
universal component library.

## Screen Build Pack

After the experience, screen, foundation, design, and data-intent sources are
available, compile one immutable execution pack:

```bash
node scripts/compile-screen-build-pack.js --project-root <project>
node scripts/validate-screen-build-pack.js --project-root <project>
```

The pack contains source hashes, a deterministic revision, compact experience
and design pointers, navigation initial/key-flow routes, fixture adapter and
entities, per-screen first viewport/action/states/dependencies/test IDs, build
order, and targeted invalidation dependencies. It is not a second strategy:
planners/design systems still make rich decisions; builders consume the pack.

Parallel screen builders, prototype mock generation, the React Native refiner,
and final validators read the same revision. They never mutate it. A legacy
fallback is compatibility-only, must be explicitly logged, and must never
invent dashboard/CRUD behavior when a field is absent. Recompile after a
relevant source hash changes; the validator reports only affected screen,
fixture, and validator targets as stale.

## Reference Overrides

Reference input is optional. When a directional reference exists, it refines
the contract. High and strict-structural references become a binding override
for hierarchy, normalized geometry, navigation silhouette, motifs, and
forbidden drift. The override can change generated composition details but does
not make image/HTML input a prerequisite for normal briefs.

## Validation

Run static validation after planning and after screen construction:

```bash
node scripts/validate-experience-contract.js --project-root <project> --phase plan
node scripts/validate-experience-contract.js --project-root <project> --phase build
```

The screen contract also declares a non-primary `keyFlow` route/outcome. Native
visual review requires normal and large-text native captures for both the
primary screen and key flow, with screenshot paths or non-testID automation
capture IDs. Evidence-backed checks cover focal point, region order, primary
action, task fit, content realism, motifs, forbidden defaults, contrast, touch
targets, safe areas, keyboard behavior (or reasoned N/A), offline state,
screen-reader order, responsive/compact layout, and localized/long content.
Every check scopes both `primary` and `key-flow`:

```bash
node scripts/validate-experience-visual-evidence.js \
  --project-root <project> \
  --manifest .tmp/experience-visual-review.json
```

If native capture is unavailable, record `DONE_WITH_CONCERNS: native experience visual capture unavailable`. A static HTML/browser preview is not
native evidence.