# Mobile Prototype Post-PR1 UX Quality Iteration

Status: implemented

## Outcome

The prompt-only `/create-mobile-prototype` path now has one lossless authority
from compact semantic planning through a statically validated, Metro-ready
native vertical slice:

```text
semantic product structure + capability ownership
-> final Journey, Screen, and Navigation contracts
-> automatic native recipe, tokens, and signature components
-> validated domain and design foundations
-> one immutable screen build pack
-> real Home plus complete critical-flow canary
-> static gates, TypeScript, and Metro HTTP readiness
```

Supporting-screen fan-out remains deferred. No environment, Dataverse,
connector, authentication, deployment, or other external mutation is
performed.

## Checkpoint A: Product Structure

The semantic plan independently records:

- permanent primary screen and semantic product role;
- launch screen and rationale;
- concrete or dynamic resume route and policy;
- key-flow entry and ordered key-flow screens;
- durable destination IDs and independent jobs;
- bounded flows and their owning destinations;
- evidence-backed intentional equalities;
- single-purpose immersive evidence when applicable;
- native capability job, operation, screen, presentation, permission, fallback,
  failure, offline, and primary-product bindings.

Cross-field validation rejects unknown IDs/evidence, missing bounded-flow
coverage, duplicate ownership, unsupported Home roles, unsupported capabilities,
and generation-order dependence. The final Navigation Contract owns launch and
resume routing. The final Screen Contract and build pack retain product roles.
Reversing planner screen order produces byte-identical Screen and Navigation
contracts.

## Checkpoint B: Automatic Design

`skills/design-system/SKILL.md` is a thin dispatcher. Prompt-only prototypes
load only the dispatcher and `automatic-native.md`; all 24 design references
have one optional owner in `reference-ownership.json`. The automatic receipt
records loaded files, exact bytes, zero optional references, and zero design
model calls.

The deterministic design compiler produces and atomically owns:

- strict recipe and path-level source bindings;
- native semantic tokens and Tamagui platform mapping;
- Foundation and signature components plus registry;
- navigation chrome, sticky-surface, media/offline, state, motion, and
  accessibility contracts;
- byte-stable outputs and an ownership manifest.

The Flight Shop and fictional field-receiving goldens remain visually and
structurally distinct.

## Checkpoint C: Native Canary

The build pack declares `nativeCanary` as the permanent primary screen plus the
complete smallest critical flow. `prepare-native-canary.js` emits one aggregate
in-memory dispatch using the existing `screenWorkOrder` and skeleton hashes.
Each screen builder returns the existing `mobile-screen-artifact`; the
foreground validates and atomically writes only the authorized target.

`validate-native-canary.js` rechecks:

- completed native source rather than a hash-only skeleton;
- exact ScreenShell/header/region/action/domain-hook contracts;
- product role, journey, continuity, capability, media, state, accessibility,
  semantic color, layout, and design runtime rules;
- pack/source fingerprints and project TypeScript.

A successful receipt is required before Metro. `start-prototype-metro.js`
probes an available port immediately before launch, starts non-interactively,
and reports `metro-ready` only after the Metro `/status` endpoint responds. A
failed startup preserves the canary and returns the exact manual command.

## Performance Evidence

`record-prototype-performance.js` is an evidence recorder, not a phase
controller. It records:

- planner request/response bytes, attempts, repairs, model calls, and zero
  planner tool calls;
- automatic design instruction files/bytes and model calls;
- foreground tool count and canary builder model calls;
- planning, domain, design, canary, Metro, and total workflow durations;
- time to validated Home and time to Metro-ready key flow;
- truthful manual-Metro status when health never passes.

Both golden fixtures exercise the evidence shape with their actual semantic
response bytes and critical-flow screen IDs.

## Validation

Focused gates cover product-role/capability failures, bounded onboarding,
single-purpose capture, order independence, design reference ownership,
byte-stable design output, final-pack preservation, real Home/key-flow artifact
writes, canary static validation, TypeScript compilation, stale canary
rejection, Metro HTTP readiness, and both-golden performance evidence.

Native screenshots remain opportunistic host evidence. Without them, the only
allowed completion claim is `statically validated + Metro ready`, never
`visually complete`.
