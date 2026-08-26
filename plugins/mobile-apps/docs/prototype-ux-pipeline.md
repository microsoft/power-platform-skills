# Prototype UX Pipeline

`/create-mobile-prototype` builds an Expo/React Native prototype with local
typed data and no Power Platform environment mutation. It deliberately keeps
the same human-readable planner and app-facing service contracts used by the
real-app workflow so a later `/prototype-to-real-app` can replace integration
layers without redesigning the product.

## Authority

The prototype uses the existing artifacts:

| Artifact | Owner | Purpose |
|---|---|---|
| `brief.md` | foreground workflow | Confirmed maker request |
| `native-app-plan.md` | planner + maker approval | Human source of truth for product, data, capabilities, design, and screens |
| `.tmp/experience-contract.json` | experience extractor | Audience, primary job, composition, evidence, media/connectivity policy |
| `.tmp/experience-screen-contract.json` | screen planner | Primary composition and complete ordered key flow |
| `.tmp/experience-foundation-contract.json` | screen planner | Two to five reusable signature primitives |
| `.tmp/dataverse-schema-contract.json` | data-model architect | Non-executable logical prototype schema |
| `.tmp/screen-build-pack.json` | deterministic compiler | Compact immutable builder inputs and execution order |

No replacement planner response or whole-plan JSON bundle is used.

## Flow

```text
brief
-> experience extraction
-> original Markdown plan and sidecars
-> one consolidated local approval
-> logical data contract
-> typed runtime data || automatic native design
-> validated join
-> compact screen build pack
-> Home + complete ordered key flow
-> static and TypeScript gates
-> Metro terminal readiness
-> bounded supporting-screen waves
-> changed-file-aware final validation
```

The automatic design lane writes `brand/`, optional design preview output, and
`.tmp/design-execution-evidence.json`. The data lane writes `src/generated/`
and `assets/experience/`. They may run concurrently only after the logical data
intent is approved because their write sets do not overlap. The shared token,
native-wrapper, and TypeScript steps run after both lanes finish.

## Product Rules

- Home is selected from the primary user outcome, not screen order, entities,
  or capability prominence.
- Every explicit job receives a durable destination, nested surface, bounded
  step, or a justified independent region.
- Screen count follows coherent coverage rather than a global minimum or cap.
- A scanner or camera supports a job; it becomes Home only for an explicitly
  single-purpose immersive capture utility.
- Persistent navigation follows independently revisited jobs and records.
  Bounded onboarding and immersive utilities may remain stack-only.
- Profile is always reachable, but it need not be a tab. It uses local app
  context and does not imply remote identity storage.

## Offline Evidence

Offline-first behavior requires direct evidence such as `offline`, `limited
connectivity`, `no network`, `save on device`, or `sync later`. Terms such as
`flight`, `field`, `scanner`, `warehouse`, `inspection`, and `task` do not
provide that evidence by themselves.

Without direct evidence, the app remains network-optional and may show
ordinary unavailable/retry states. It must not promise cached records, queued
writes, pending sync, saved-on-device completion, or offline readiness. With
direct evidence, local draft, resume, recovery, media, and pending-sync behavior
remain part of the approved product.

## Builder Input

The build pack is compiled only after plan, screen/foundation contracts,
logical data intent, runtime data manifest, and design foundations exist. It
contains approved navigation, screen role, target route/file, presentation,
screen-local data entities, native capability intent, shell/header ownership,
states, stable test IDs, and invalidation hashes.

`execution.canary` contains Home followed by every ordered key-flow route. A
simple product-detail flow has one key-flow route; a receiving or inspection
transaction may have several. Metro cannot start until every canary route is
real TSX and route, shell, experience, media, accessibility, and TypeScript
gates pass. Independent supporting screens then run in waves of at most five.

## Maker Workspace

`_prototype_workspace.html` is a responsive local build console generated from
existing artifacts. It shows phase progress, editable review fields, screen
and data tables, capability/connector proposals, validation status, project
path, and Metro handoff. Review edits are exposed as a JSON payload for the
existing plan/edit workflow to apply.

The workspace is not the React Native app, does not authorize mutations, and
does not count as native visual evidence.

## Reliability

- Host capability differences use foreground textual/delegation fallbacks with
  the same artifacts and validators.
- Harmless casing, whitespace, optional-empty, and conventional prototype-ID
  defaults may be normalized only when meaning is unambiguous. Repairs are
  listed in `.tmp/prototype-seed-regeneration.json`.
- Missing requirements, unresolved relationships, unsupported mandatory native
  capabilities, unsafe mutations, and uncompilable source still block.
- Final validation may skip a duplicate phase only when its passing fingerprint
  matches exact file bytes, dependencies, phase, and validator identities.
- Metro ports are probed immediately before startup. Session metadata requires
  current foreground terminal-banner verification before reuse.

## Evidence Boundary

Static validation proves contract, source, navigation, shell, media, and type
correctness. Metro readiness proves only that the native bundle server is ready
for a compatible development client. Visual completion requires real native
captures of Home and every key-flow route at normal and large text, with the
experience evidence checks passing. When capture is unavailable, report the
prototype as statically validated and Metro-ready with a visual-evidence
concern.