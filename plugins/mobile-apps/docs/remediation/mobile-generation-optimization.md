# Mobile Generation Optimization

This change set improves generation speed without relaxing app-quality,
Dataverse, routing, accessibility, or TypeScript gates.

## Context architecture

- `create-mobile-app/SKILL.md` is a compact invariant/index file. Detailed work
  is loaded at the owning phase from `references/phase-*.md`.
- Degraded-host recovery is loaded only after an actual agent-routing failure.
- Screen builders consume one compiled build-pack entry, one screen spec, one
  typed skeleton, one archetype shard, one sample, accessibility guidance, and
  compact code idioms.
- Screen templates and universal patterns are sharded behind compatibility
  indexes.
- Mandatory shared policy is in `shared-instructions-core.md`; memory,
  documentation, safety, CLI, failure, and execution details are topic files.
- Planner, data-model, screen-planner, screen-builder, and offline-profile
  agent prompts have explicit size budgets.

## Preserved quality authority

Important implementation rules removed from repeated builder prose remain
enforced by contracts or validators:

- generated-service results must be checked;
- create/edit routes use `?editId=`;
- dynamic Dataverse record IDs are normalized;
- lookup annotations use exact `@odata.bind` casing;
- safe-area, accessibility, contrast, route, package, Dataverse payload, and
  build-pack validators remain required;
- TypeScript gates remain blocking at scaffold, generated-services,
  navigation/skeleton, every screen wave, and final launch.

## Wall-clock improvements

- TypeScript uses incremental state at `.tmp/tsc.tsbuildinfo`.
- Dataverse planning inventory cache defaults to 30 minutes and supports
  explicit refresh.
- Host agent capability is learned from a real dispatch and cached instead of
  paying for no-op probe agents.
- Independent native-capability writes may run concurrently.
- Screen-builder concurrency is configurable from 1–10 and defaults to 8.
- Edit-app uses the same capability cache and configurable builder waves.
- The compatible Power Apps CLI is pinned directly in the template.
- `check-updates` uses the lower-cost Sonnet tier; judgment-heavy planning and
  design remain on the quality tier pending comparative evidence.

## UX and resume behavior

- Requirement questions are batched.
- `--consolidated-review` provides one review of the same scope, architecture,
  experience, and implementation contracts. `--gated` retains four sequential
  gates.
- Planning ETA uses measured p50, p90, and last-run history and excludes user
  approval latency.
- Safe read-only snapshot work may overlap requirement review without project
  writes before approval.
- `.tmp/pipeline-state.json` records completed steps and artifact hashes so a
  rerun resumes only when approval-bound files and generated source trees are
  unchanged. Approved file hashes are immutable across later checkpoints.
- Generated-service discovery is written to
  `.tmp/generated-services-snapshot.md`; it no longer mutates the approved
  human plan after Gate 4.
- Host capability cache entries are scoped to host/runtime and plugin version
  and expire after 30 minutes, including negative results.

## Regression budgets

CI contract tests enforce:

- create core: at most 40 KiB and 300 lines;
- screen-builder prompt: at most 15 KiB;
- planning/leaf agents: at most 20 KiB each;
- mandatory shared core: at most 3 KiB;
- screen-builder static required-reading set: at most 40 KiB;
- all phase/index shards exist and relative Markdown links resolve.

## Comparative rollout protocol

Before changing quality-sensitive model defaults or removing the gated
compatibility mode, generate matched apps from the baseline and optimized
branches for:

1. field service with offline evidence capture;
2. finance with sensitive review/approval flows;
3. plain productivity with common list/detail/form work.

For each pair record:

| Metric | Source |
|---|---|
| First-emission validator pass rate | mobile validators |
| TypeScript gate failures and retries | gate logs |
| Route-contract failures | `check-routes.js` |
| Planning and screen wall clock | planning timing artifacts |
| Input/output tokens | host usage telemetry |
| Product/visual quality | human review of the same journey preview |

A phase is eligible for default rollout only when quality is not worse and
time or token use improves. These matched reference-app measurements are not
included in this change set and must not be represented as completed.

## Deliberate non-deletions

Reference files that appeared orphaned in an earlier report remain because the
current branch has live inbound links. They can be consolidated only in a
separate change that intentionally migrates every consumer.
