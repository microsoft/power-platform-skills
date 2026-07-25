# Model Apps Plugin — Architecture

The **wiring / flow reference** for both skills, as one page of ASCII diagrams: `/genpage`
(page generation) first, then `/app-builder` (intent → whole model-driven app via the headless
`cds-maker-sdk`). For **per-component behavioral specs**, the canonical file tree, conventions, and
build/test, see [`../AGENTS.md`](../AGENTS.md). The App Spec contract is
[`../references/app-spec-schema.md`](../references/app-spec-schema.md); the app-builder skill is
[`../skills/app-builder/SKILL.md`](../skills/app-builder/SKILL.md); the roadmap/TODO is
[`app-builder-roadmap.md`](app-builder-roadmap.md).

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

## /app-builder — build pipeline

Intent → deployed model-driven app. The **authoring flow runs in the main conversation loop** (not a
`Task` subagent — headless agents can't reach the user for `AskUserQuestion` / plan mode), then a
deterministic, idempotent, narrated SDK build. Create and **edit share one path**.

```
                     User invokes /app-builder
                              │
                              v
              ┌────────────────────────────┐   STAGE: author  (main loop)
              │ Phase 1 — authoring        │   references/authoring-flow.md
              │  env select (pac auth/org) │   DESIGN-ONLY: App Spec in 2 confirmed
              │  Level 1: data model       │   levels — no .tsx emitted here.
              │  Level 2: artifacts +      │   → early + full spec-lint gates
              │    page-intents + design   │   → plan-mode approval (single build gate)
              └──────────────┬─────────────┘
                             │  app-spec.json (machine contract) + model-app-plan.md
                             │
                             v
              ┌────────────────────────────┐   STAGE: data  (engine run 1)
              │ Data pre-build             │   build-model-app.js --stage data --apply
              │  solution + data-model     │   → tables exist for type-gen
              │  (NOT sample-data yet)     │   13 phases unchanged; this run covers:
              │                            │     solution · data-model
              └──────────────┬─────────────┘
                             │
                             v
              ┌────────────────────────────┐   STAGE: generate-pages  (main loop + agents)
              │ Generate pages             │   pac model genpage generate-types → RuntimeTypes.ts
              │  generate-types +          │   headless page-builder agents fill each intent
              │  page-builder agents       │   page's .tsx; PAGEREF_<key> for cross-page nav
              │  (Task — parallel)         │   <app>_pagemanifest carries semantics durably
              └──────────────┬─────────────┘
                             │  all pages: source { kind:"tsx", codeFile }
                             v
   ┌───────────────────────────────────────────────────────────────────┐
   │ Full idempotent build  build-model-app.js --apply --verify        │  STAGES: ui · app · publish · verify
   │  (engine run 2 — full; rediscovers data-model, then continues)   │
   │  13 phases:                                                        │
   │    solution · data-model · sample-data                (data)      │
   │    web-resources · views · charts · forms ·                       │
   │    commands · dashboards                               (ui)        │
   │    app-shell · pages [upload + PAGEREF_ resolve +                  │
   │      sitemap finalize] · ai-features                  (app)       │
   │    publish                                             (publish)   │
   │  bounded parallelism; emits [n/total] events + BuildHalt gate     │
   │  --verify: auto-reconciles spec vs deployed after apply           │
   └──────────────┬────────────────────────────────────────────────────┘
                  │  ALL Dataverse access via the vendored headless SDK
                  v          scripts/vendor/cds-maker-sdk.cjs
   ┌────────────────────────┐   (metadata cached under <app-folder>/.maker-workspace/)
   │ Verify & iterate       │   STAGE: verify — verify-model-app.js re-checks
   │                        │   (read-only; non-zero on anything missing)
   └────────────────────────┘

   Edit  = same path:  download-model-app.js  pulls a deployed app → editable spec → re-run full build
                       (sitemap-authoritative enumeration: MEMBERSHIP = app sitemap GenPageId set;
                        each page's pageId kept in the downloaded spec — edit-snapshot;
                        fetches <app>_pagemanifest fail-closed, reverse-normalizes PAGEREF_ placeholders).
   Cleanup =           teardown-model-app.js  reverse-of-build, classifier-safe, dry-run by default.
```

**Stage → engine-phase legend:**

| Stage | Executes in | Engine phases |
|---|---|---|
| **author** | main loop | *(none — design-only)* |
| **data** | run 1 (schema) + run 2 (rows) | `solution` · `data-model` (run 1); `sample-data` (run 2) |
| **generate-pages** | main loop + agents | *(none — writes .tsx files)* |
| **ui** | run 2 | `web-resources` · `views` · `charts` · `forms` · `commands` · `dashboards` |
| **app** | run 2 | `app-shell` · `pages` · `ai-features` |
| **publish** | run 2 | `publish` |
| **verify** | run 2 or standalone | *(reconcile pass)* |

`--stage <data|ui|app|publish>` on `build-model-app.js` maps a stage to its phase range.
**Apply-safe only for `data`** — the full build (run 2) is always a full idempotent run, not a
`--from/--to` range.

**Safety:** destructive ops fail-closed without `--allow-destructive` (`op-diff.js`).
`--non-interactive`/autopilot mode suppresses prompts only — it never bypasses safety gates.
The durable `<app>_pagemanifest` web resource carries page semantics across download and rebuild.

**Three-authority page identity (pages phase):** generative-page management consults three
authorities — all matching by id, never by display name:
(1) **IDENTITY** — the `<app>_pagemanifest` (`key → pageId`); a downloaded spec's own
`pages[].pageId` outranks it. (2) **EXISTENCE** — env-wide `pac model genpage list` (no
`--app-id`): decides create-vs-reuse; enables crash-safe convergence (a page present in the env
after a crash is reused, never re-created). (3) **MEMBERSHIP** — the app's sitemap `GenPageId`
set, read via `fetchSitemap` (`scripts/lib/sitemap-pages.js`, fail-closed and discriminated: a
valid-but-page-less sitemap is `{ ok:true, ids:[] }`; a missing component or unreadable XML is
`{ ok:false, reason }` — never collapsed to empty). Membership alone drives placement, download
enumeration, and verify. The build halts on safety violations (`pages-removed`,
`pages-shared-across-apps`, `pages-identity-conflict`, `pages-manifest-corrupt`,
`pages-existence-failed`, `pages-sitemap-read-failed`, `pages-shared-check-failed`) rather than
proceeding with potentially wrong state. See
[`references/app-spec-schema.md`](../references/app-spec-schema.md) → `## pages[]`.

The plugin owns **judgment** (spec validation, choice/status resolution, candidate selection, prompt
authoring); the vendored SDK owns the **deterministic Dataverse mechanics** (create/query/delete,
`seedRecordGraph`, `enrichDefaultViews`, AI settings/row-summaries, artifact resolve/cascade). Each
script's behavioral spec is in [`../AGENTS.md`](../AGENTS.md); the App Spec shape is
[`../references/app-spec-schema.md`](../references/app-spec-schema.md).

## Eval suite

### /genpage — 3-layer suite

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

### /app-builder — offline structural harness

A data-driven, **offline** eval harness under `evals/model-apps/app-builder/`
(sibling of `genpage/`). It grades **structural per-stage facts** — not `.tsx`
snapshots — using the plugin's own pure primitives and requires no live env.

```
evals/model-apps/app-builder/
  evals.json                     <-- data-driven cases + per-stage assertions
  fixtures/<n>-<slug>/
    app-spec.json                <-- the spec under test
  lib/
    fixture-loader.js            <-- loads each fixture's app-spec.json
    facts.js                     <-- per-stage fact computation (schema-facts.js etc.)
    assertions.js                <-- assertion text → check function registry
  run-app-builder.js             <-- TAP v13 runner (run from repo root)
  EVAL_GUIDE.md                  <-- grading guide (companion to genpage/EVAL_GUIDE.md)
  tests/
    facts.test.js                <-- offline unit tests
    run-app-builder.test.js      <-- e2e harness tests
```

Per-stage oracles: `author` (`validateAppSpec`+`lintAppSpec`), `plan` (`planFor`),
`data` (`schema-facts.js` — normalized tables/columns/relationships), `ui`
(view/chart/form intent facts), `app` (`appDef` sitemap facts + nav graph),
`verify` (`verifySpec` reconcile). Run from the repo root:

```bash
node evals/model-apps/app-builder/run-app-builder.js
```

See [`evals/model-apps/app-builder/EVAL_GUIDE.md`](../../evals/model-apps/app-builder/EVAL_GUIDE.md)
for the full grading flow.
