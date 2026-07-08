# Model Apps Plugin — Architecture

The **wiring / flow reference** for both skills, as one page of ASCII diagrams: `/genpage`
(page generation) first, then `/model-app-maker` (intent → whole model-driven app via the headless
`cds-maker-sdk`). For **per-component behavioral specs**, the canonical file tree, conventions, and
build/test, see [`../AGENTS.md`](../AGENTS.md). The App Spec contract is
[`../references/app-spec-schema.md`](../references/app-spec-schema.md); the model-app-maker skill is
[`../skills/model-app-maker/SKILL.md`](../skills/model-app-maker/SKILL.md); the roadmap/TODO is
[`model-app-maker-roadmap.md`](model-app-maker-roadmap.md).

## /genpage — high-level flow

```
                      User invokes /genpage
                              │
                              v
                  ┌────────────────────────┐
                  │   skills/genpage/      │
                  │   SKILL.md             │   <-- orchestrator
                  │   (the "skill")        │
                  └────────────┬───────────┘
                               │
            ┌──────────────────┼──────────────────────────────┐
            v                  v                              v
   ┌────────────────┐  ┌────────────────┐          ┌────────────────────┐
   │ genpage-       │  │ genpage-       │          │ genpage-           │
   │ planner        │  │ entity-builder │          │ page-builder       │
   │ (Task agent)   │  │ (Task agent)   │          │ (Task agent — N×)  │
   └────────────────┘  └────────────────┘          └────────────────────┘
            │                  │                              │
            │                  v                              │
            │      ┌────────────────────────┐                 │
            │      │  scripts/ (Node CLIs)  │                 │
            │      │  check-auth.js         │                 │
            │      │  provision-entities.js │                 │
            │      │ provision-solution.js  │                 │
            │      │  dataverse-request.js  │                 │
            │      │  lib/entity-provision  │                 │
            │      │  lib/provision-input   │                 │
            │      └─────────────┬──────────┘                 │
            │                    │                            │
            │                    v                            │
            │      ┌────────────────────────┐                 │
            │      │  lib/dataverse-auth.js │                 │
            │      │  (az + Web API HTTP)   │                 │
            │      └────────────────────────┘                 │
            │                                                 │
            └──────────────── genpage-plan.md ────────────────┘
                              (machine-readable contract)
```

The orchestrator never inlines planner/builder logic — it dispatches via
`Task` and waits for the agent to return. The plan document is the contract:
the planner writes it; subsequent phases (and other agents) read it.

## /genpage — edit flow

```
                      User invokes /genpage (edit intent)
                              │
                              v
                  ┌────────────────────────┐
                  │   skills/genpage/      │
                  │   SKILL.md             │
                  │   edit-flow.md         │   <-- loaded conditionally
                  └────────────┬───────────┘
                               │
                       pac model list
                       pac model genpage list
                       pac model genpage download
                               │
                               v
                  ┌────────────────────────┐
                  │  <working-dir>/        │
                  │   <page-id>/page.tsx   │
                  │   <page-id>/config.json│
                  │   <page-id>/prompt.txt │
                  └────────────┬───────────┘
                               │
                               v
                  ┌────────────────────────┐
                  │ genpage-edit-planner   │   <-- Task agent
                  │ (writes               │       reads downloaded artifacts
                  │  genpage-edit-plan.md) │
                  └────────────┬───────────┘
                               │
                               v
                  Orchestrator applies edits inline (Edit tool)
                  on <working-dir>/<page-id>/page.tsx
                               │
                               v
                  pac model genpage upload --page-id ...
```

## /genpage — working directory layout

Every `/genpage` run creates a kebab-case working directory with this layout:

```
<working-dir>/
  package.json              <-- Phase 0.5  (generate-page-manifest.js)
  genpage.d.ts              <-- Phase 0.5  (ambient Xrm + window cache types)
  genpage-plan.md           <-- Phase 1    (planner writes; contract for later)
  entity-creation-log.md    <-- Phase 2b   (if entities created)
  RuntimeTypes.ts           <-- Phase 4    (pac model genpage generate-types)
  <page>.tsx                <-- Phase 5    (page-builder writes; one per page)
  workflow-log.md           <-- written incrementally across all phases
```

The deployed artifact is just `<page>.tsx`. Everything else is local-dev
scaffolding that helps the developer keep iterating without re-running the
full skill.

## /genpage — the plan document as a contract

The planner writes `genpage-plan.md` once. Every later phase reads it; nothing
else passes state.

Key sections the orchestrator and other agents rely on:

| Section | Read by | Purpose |
|---------|---------|---------|
| `## Environment` (Solution + Publisher Prefix) | entity-builder | Solution scoping + prefix construction |
| `## Entity Creation Required` | orchestrator (Phase 2 gate) + entity-builder | Whether to invoke entity-builder; what to create |
| `## Existing Entities` | orchestrator (Phase 4) | Which entities feed `pac model genpage generate-types` |
| `## Pages` | orchestrator (Phase 5) | How many builders to dispatch; target filenames |
| `## Per-Page Specifications` | each page-builder | Each builder reads ONLY its own page's spec |
| `## Relevant Samples` | each page-builder | Closest-match sample to read for structural reference |
| `## Localization` | page-builder | Whether to load `references/localization.md` |

The schema is enforced by `references/plan-schema.md` and validated by
`evals/model-apps/genpage/run-layer-1.js`.

## /model-app-maker — build pipeline

Intent → deployed model-driven app. The **authoring flow runs in the main conversation loop** (not a
`Task` subagent — headless agents can't reach the user for `AskUserQuestion` / plan mode), then a
deterministic, idempotent, narrated SDK build. Create and **edit share one path**.

```
                     User invokes /model-app-maker
                              │
                              v
              ┌────────────────────────────┐   runs in the MAIN loop
              │ Phase 1 — authoring        │   references/authoring-flow.md
              │  env select (pac auth/org) │   → spec-lint.js guardrail
              │  App Spec in 2 confirmed   │   → plan-mode approval
              │  levels (data model, then  │
              │  forms/views/charts+data)  │
              └──────────────┬─────────────┘
                             │  app-spec.json (machine contract) + model-app-plan.md
                             v
   ┌───────────────────────────────────────────────────────────────────┐
   │ Phase 2 — build   scripts/build-model-app.js → scripts/lib/sdk-build.js
   │  phases: solution · data-model · sample-data · web-resources ·      │
   │          views · charts · forms · commands · dashboards ·           │
   │          app-shell · pages · ai-features · publish                  │
   │  idempotent (creates only what's missing); --only/--skip/--from/--to;
   │  bounded parallelism; emits [n/total] events + a BuildHalt gate      │
   └──────────────┬────────────────────────────────────────────────────┘
                  │  ALL Dataverse access via the vendored headless SDK
                  v          scripts/vendor/cds-maker-sdk.cjs
   ┌────────────────────────┐   (metadata cached under <app-folder>/.maker-workspace/)
   │ Phase 3 — verify &     │   scripts/verify-model-app.js (read-only reconcile;
   │           iterate      │   exits non-zero on anything missing)
   └────────────────────────┘

   Edit  = same path:  download-model-app.js  pulls a deployed app → editable spec → re-run Phase 2
                       (idempotent: reuses app/tables, updates pages in place, keeps GenPage subareas).
   Cleanup =           teardown-model-app.js  reverse-of-build, classifier-safe, dry-run by default.
```

The plugin owns **judgment** (spec validation, choice/status resolution, candidate selection, prompt
authoring); the vendored SDK owns the **deterministic Dataverse mechanics** (create/query/delete,
`seedRecordGraph`, `enrichDefaultViews`, AI settings/row-summaries, artifact resolve/cascade). Each
script's behavioral spec is in [`../AGENTS.md`](../AGENTS.md); the App Spec shape is
[`../references/app-spec-schema.md`](../references/app-spec-schema.md).

## Eval suite

Three layers, graded against captured fixtures:

```
fixtures/<eval-id>-<slug>/
  *.tsx               <-- Layer 2 grades these (code assertions)
  workflow-log.md     <-- Layer 1 grades this (workflow assertions)
  genpage-plan.md     <-- Layer 1 grades this (plan-schema + Environment)
  entity-creation-log.md  <-- Layer 1 grades this (prefix discipline)
```

Layer 1 (`run-layer-1.js`) and Layer 2 (`run-layer-2.js`) emit TAP v13. Both
runners are stateless — they read fixtures, grep + structural-check, write
results. CI can run both in seconds. Layer 3 (UX rubric) stays manual.

See `evals/model-apps/genpage/EVAL_GUIDE.md` for the full grading flow.
