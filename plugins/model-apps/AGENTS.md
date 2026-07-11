# AGENTS.md — Model Apps Plugin

This file provides guidance to AI Agents when working with the **model-apps** plugin.

## What This Plugin Is

A plugin for building Power Apps for **model-driven apps**, via two user-invocable skills:

- **`/genpage`** — build and deploy standalone **generative pages** (genux): React 17 + TypeScript +
  Fluent UI V9 single-file components, deployed via PAC CLI. Orchestrates specialist agents (planner,
  optional entity builder, parallel page builders).
- **`/app-builder`** *(Preview)* — build and edit a **whole model-driven app** (tables, columns,
  relationships, adaptive forms, views, charts, generative pages, app + sitemap, sample data, and
  admin-gated AI features) from a natural-language intent, via the vendored headless `cds-maker-sdk`.

Plus **`/report-issue`** to file bugs against this repo. All Dataverse mutation flows through the
shared, vendored SDK (`scripts/vendor/cds-maker-sdk.cjs`) — see `## Building & Testing`.

**Requirements:**
- **PAC CLI ≥ 2.7.0** — for app and generative-page deploy operations
- **Azure CLI (`az`)** — Dataverse Web API auth (SDK + entity builder); must be logged in with the
  same identity as the active `pac` profile

No Dataverse Skills plugin or Python dependency.

## Documentation Map

Keep these in sync — **update the relevant doc(s) in the same PR as the change** (a reviewer should be
able to tell what moved from the docs alone):

| Doc | What it holds | Update when… |
|-----|---------------|--------------|
| `AGENTS.md` (this file — `CLAUDE.md` symlinks to it) | Per-component behavioral specs, the canonical file tree, conventions, build/test | You add/rename a script, change a component's behavior, or change how to build/test |
| [`docs/architecture.md`](docs/architecture.md) | Wiring / flow **diagrams** for both skills (`/genpage` + `/app-builder`) | You change the orchestration, phase pipeline, or how the pieces connect |
| [`docs/app-builder-roadmap.md`](docs/app-builder-roadmap.md) | `/app-builder` **roadmap / TODO** (Complete + Pending by phase) | You ship or reprioritize an app-builder capability |
| [`CHANGELOG.md`](CHANGELOG.md) | Keep-a-Changelog — concise bullets (detail lives in PRs/docs) | Any user-visible change |
| [`references/app-spec-schema.md`](references/app-spec-schema.md) | The App Spec contract | You change the App Spec shape or validation |

Don't duplicate content across these — **cross-link instead** (a second copy only drifts, as the file
tree and teardown order both did before).

## app-builder — intent → model-driven app

A second skill (`/app-builder`) builds a whole **model-driven app** (tables, columns,
relationships, adaptive forms with sub-grids, views, Choice-column charts, app module +
sitemap) from a natural-language intent — distinct from `/genpage`, which builds generative
*pages*. The **entire flow runs in the main conversation loop** (not via a `Task` subagent):
subagents are headless, so `AskUserQuestion` and plan mode can't reach the user from one, and
the whole point is the multi-turn, propose-then-confirm authoring + the live build narration.

- **`references/authoring-flow.md`** — the Phase-1 authoring playbook the skill executes itself:
  validate prereqs, select the env via PAC (`pac auth list` / `pac org who`), detect existing
  tables/apps, author the **App Spec** in two confirmed levels (data model first, then
  forms/views/charts + sample data), run the `spec-lint.js` guardrail, get plan-mode approval.
  Writes `app-spec.json` (the machine contract) + `model-app-plan.md`.
- **`scripts/lib/spec-lint.js`** — pure App Spec guardrail (`lintAppSpec → { ok, errors,
  warnings }`): errors block the plan gate (e.g. the relationship-name-vs-lookup-name
  collision Dataverse rejects), warnings teach.
- **`scripts/build-model-app.js` → `scripts/lib/sdk-build.js`** — the deterministic, **idempotent**
  build engine, run after approval. Discovers existing tables/columns/relationships via the SDK
  (`findTables`/`findColumns`/`fetchEntityMetadata`) and creates only what's missing
  (`createSolution`/`createTable`/`createColumn`/`createRelationship`), seeds sample data via
  `seedRecordGraph` (SDK-owned parent-bind + resolve-by-name idempotency), enriches default
  Active/Inactive views via `enrichDefaultViews`, then
  `createWebResource` for form JS, `createArtifact`+`pushArtifact` for views/charts/forms/app,
  `addSubGrid` for sub-grids, `addFormEventHandler` for form events) — so new, existing, and mixed
  envs all work. The data model is **complete** (all column types, global choices, status reasons,
  alternate keys, N:N). It also builds **quick-create/quick-view forms** (`formType`) with **quick-view
  placement** (`forms[].quickViews[]` — embed a QuickView form via a lookup), **modern command-bar
  buttons** (`commands[]` — functional JS on-click + static hidden/disabled, incl. **flyout/split-button
  menus** via `type`+`children[]`), and **dashboards** (`dashboards[]` — chart/list/iframe/webresource
  tiles) with **sitemap placement** (a `dashboard` subarea auto-pins the dashboard as an app component).
  Following a **genpage-first policy**, overview/dashboard/analytics surfaces are authored as **generative
  pages** (`pages[]`) rather than classic dashboards — the build's `pages` phase uploads each via
  `pac model genpage upload` (no `--add-to-sitemap`) and the SDK finalizes the sitemap with `GenPage`
  subareas; classic `dashboards[]` are opt-in.
  **All Dataverse access is via the SDK**, so metadata is persisted under
  `<app-folder>/.maker-workspace/` for reuse/edits. Phases
  (`solution·data-model·sample-data·web-resources·views·charts·forms·commands·dashboards·app-shell·pages·ai-features·publish`) are
  selectable with `--only`/`--skip`/`--from`/`--to`; independent ops run with bounded parallelism.
  Emits `[n/total]` events the orchestrator narrates + a `BuildHalt` it gates on. Dry-run by
  default; `--apply` writes, `--sample-data` / `--publish` opt-in.
- **`scripts/teardown-model-app.js` → `scripts/lib/sdk-teardown.js`** — the first-class, **classifier-safe**
  teardown (reverse of the build), for cleaning up live-verification probes or a failed build. Deletes
  exactly the artifacts a given App Spec declares, in dependency-safe order (**app → dashboards →
  commands → forms → charts → views → relationships → AI row summaries → tables
  [reverse-topological, children-first] → web-resources → global choices → solution**). Forms/charts/views/relationships
  are deleted **explicitly before tables** (a table delete does not reliably cascade cross-references; it
  does remove the table's own columns). **Web resources are deleted after tables**: a table's vector/raster
  **icon** web resource is referenced by the table itself, so Dataverse refuses to delete it until the table
  is gone (form JS, referenced by its already-deleted form, is safe either way). Teardown also removes the
  build's **generated default app icon** (`<appUnique>_icon`, created in-solution when the spec sets no
  `app.icon`) so it doesn't leak as an orphan. The empty solution container goes last. Command teardown
  removes the whole command bar for an entity the spec authored commands on (the SDK models a command bar
  per entity, not per button). Every id is resolved from a spec-declared name/logical/uniquename via an
  exact-match OData filter, so it can never wildcard-scan an org. **Dry-run by default** (`--apply`
  writes); best-effort continue (a failed step is recorded, teardown proceeds). A not-found (already-gone)
  error is treated as deleted, the table delete's **not-found-on-success** is tolerated (`tolerateNotFound`),
  and system/managed artifacts that cannot be deleted are recorded as `skipped` rather than failing.
  `--clear-workspace` prunes `.maker-workspace/` after a clean apply. `planTeardown(spec)` is pure (dry-run +
  unit-test surface); reuses `appUniqueName`/`commandsByEntity`/`topoOrderEntities` from the build engine (DRY).
- **`scripts/download-model-app.js` → `scripts/lib/hydrate-spec.js`** — the **edit flow**: pulls a
  *deployed* app back into a complete App Spec + page code (sitemap → `appShell` with icons, **every**
  generative page via `pac model genpage download`, referenced entities, icon web resources, solution).
  Edit the downloaded spec and re-run the build (idempotent) — create and edit share one path. Always
  pull fresh at the start of an edit session (the build reads an etag; a write against an artifact
  changed in Maker throws a version conflict → re-pull, never clobber). **Limitation (Preview):** classic
  DashBoard subareas are not yet round-tripped — download prints a `WARNING` and a rebuild drops them, so
  re-add a classic dashboard to the spec before rebuilding (genpage/entity/URL subareas round-trip losslessly).
- **`scripts/verify-model-app.js` → `scripts/lib/verify-spec.js`** — read-only reconcile of the App Spec
  against what actually deployed (entities/columns/views/charts/forms + sitemap subareas + icons); exits
  non-zero and lists anything missing, catching silent partial builds.
- **`scripts/ai-preflight.js`** — standalone preflight report: prints each AI feature's on/off status
  and the exact admin action needed (Power Platform Admin Center → Environments → Settings → Product →
  Features) for anything off. Never fails. The `ai-features` build phase calls this logic internally and
  uses `RetrieveSetting`/`SaveSettingValue` (SDK) for app-level feature flags and `AIModelPublish` +
  `aiskillconfigs` for per-table row summaries. All AI features are **admin-gated**: the skill preflights
  and skips/warns; it cannot flip admin or tenant switches. `scripts/lib/ai-candidates.js` selects
  good-candidate tables for auto row-summary mode; `scripts/lib/ai-prompt.js` generates tailored summary
  prompts. The `ai` block in the App Spec configures the full set; see
  [`references/app-spec-schema.md`](../../references/app-spec-schema.md) → `## ai`.
- **`scripts/preview-form.js` → `scripts/lib/form-preview.js`** — renders an ASCII **form
  wireframe** (tabs, sections, fields with widget hints, the Notes/timeline block, sub-grids, form
  JS) from the App Spec, so the user can review a form visually during authoring before approving.
- **`scripts/vendor/cds-maker-sdk.cjs`** — the SDK vendored as a self-contained headless bundle
  (rebuild via `scripts/_vendor-build/`); **`scripts/lib/sdk-http-client.js`** injects an
  `az`-token HttpClient. No browser, no relay — the SDK reuses the designer's own serializers.
- The build log is **phase-grouped with per-step status** (`▶ phase` / `[n/total] ✓ created` /
  `⊘ skipped` / `✗ failed`) + a closing summary; dry-run lists the same plan with a `▢` marker.

The end-to-end flow (Phase 0 working dir → Phase 1 author **in the main loop** per
`references/authoring-flow.md` → Phase 2 narrated SDK build → Phase 3 verify & iterate; **edit** an
existing app via the same path — `download-model-app.js` pulls it back into a spec, then re-run Phase 2
idempotently) is diagrammed in [`docs/architecture.md`](docs/architecture.md) → *`/app-builder` —
build pipeline*. **Upcoming:** shippable-defaults provisioning (security role / quick-create / standard views).

## Local Development

Test this plugin locally:

```bash
claude --plugin-dir /path/to/plugins/model-apps
```

## File Tree

The canonical layout of the plugin (architecture **diagrams** live in
[`docs/architecture.md`](docs/architecture.md)):

```
.plugin/plugin.json            ← Open Plugins metadata (name, version, keywords)
.mcp.json                      ← MCP server config (Playwright for browser verification)
AGENTS.md                      ← Plugin guidance for AI agents (this file)
CLAUDE.md                      ← Symlink → AGENTS.md
README.md                      ← User-facing intro and prereqs
CHANGELOG.md                   ← Keep-a-Changelog
docs/
  architecture.md              ← Wiring/flow diagrams for BOTH skills (/genpage + /app-builder)
  app-builder-roadmap.md   ← /app-builder roadmap / TODO (Complete + Pending by phase)
agents/                        ← Agent definitions (invoked by skills via Task tool)
  genpage-planner.md           ← Requirements, discovery, plan doc, user approval (create flow)
  genpage-entity-builder.md    ← DV entity creation via plugin's Web API scripts (create flow)
  genpage-page-builder.md      ← Writes one .tsx file; runs in parallel for multi-page (create flow)
  genpage-edit-planner.md      ← Reads download artifacts, plans edits, writes edit plan (edit flow)
references/                    ← Shared reference docs
  rules.md                     ← Full code-gen rules, DataAPI types, layout patterns, common errors
  plan-schema.md               ← Schema contract for genpage-plan.md
  data-caching.md              ← Rule 15 list/detail caching pattern (loaded conditionally)
  localization.md              ← Multi-language + RTL pattern (loaded conditionally)
  supported-dependencies.md    ← Versioned package list for generated pages
  troubleshooting.md           ← Deployment/runtime/env issues
  verified-icons.txt           ← ~5000 Fluent UI icon names; Grep-validated by page-builder
samples/                       ← Example .tsx files (12 samples)
scripts/
  launch-playwright-mcp.js     ← Playwright MCP server launcher (detects system browser)
  regenerate-verified-icons.js ← Regenerates references/verified-icons.txt from npm
  check-auth.js                ← Pre-flight: az present + logged in, pac identity, WhoAmI, identity match
  dataverse-request.js         ← General Dataverse Web API wrapper (escape hatch)
  provision-entities.js        ← CLI wrapper for entity provisioning (solution + data-model + sample-data)
  provision-solution.js        ← Creates a Dataverse solution via the SDK
  build-model-app.js           ← app-builder: narrated, idempotent SDK build (dry-run default)
  download-model-app.js        ← app-builder: pull a deployed app into an editable spec (edit flow)
  teardown-model-app.js        ← app-builder: classifier-safe reverse-of-build teardown
  verify-model-app.js          ← app-builder: reconcile the spec against the deployed app
  preview-form.js              ← app-builder: ASCII form wireframe for authoring review
  ai-preflight.js              ← app-builder: preflight AI feature availability (admin-gate report)
  run-tests.js                 ← one-command plugin + SDK regression runner
  smoke-eval.js                ← scripted live smoke eval (build → assert → teardown)
  generate-page-manifest.js    ← Phase 0.5: writes working-dir package.json + genpage.d.ts
  capture-fixture.js           ← Copies /genpage working dir into an eval fixture and runs both runners
  lib/
    entity-provision.js        ← Shared entity-provisioning core (solution + data-model + sample-data)
    provision-input.js         ← Input validation for entity provisioning
    dataverse-auth.js          ← Shared auth + HTTP helpers (uses `az account get-access-token`)
    supported-dependencies.js  ← Single source of truth for runtime + dev deps versions
    sdk-build.js               ← app-builder build engine (idempotent; incl. the pages phase)
    sdk-teardown.js            ← app-builder teardown engine (planTeardown is pure)
    sdk-http-client.js         ← az-token HttpClient for the vendored SDK
    spec-lint.js / app-spec.js ← App Spec guardrail lint + validation
    genpage-cli.js             ← pac model genpage upload/list/download wrapper
    hydrate-spec.js            ← reconstruct an App Spec from a deployed app (edit flow)
    verify-spec.js             ← spec-vs-deployed reconciliation core
    build-journal.js           ← durable JSONL build journal (resume diagnostics)
    form-preview.js            ← form wireframe renderer
    ai-candidates.js           ← selects good-candidate tables for auto row-summary mode
    ai-prompt.js               ← generates tailored Copilot row-summary prompts
    _graph.js                  ← entity topological ordering (shared by build + teardown)
  vendor/cds-maker-sdk.cjs     ← headless vendored SDK bundle (rebuilt via _vendor-build/)
  _vendor-build/               ← esbuild vendoring tooling (build.js + pinned deps)
  tests/                       ← node --test coverage for the scripts above
skills/
  app-builder/
    SKILL.md                   ← intent → model-driven app (create + edit); **Preview**
  genpage/
    SKILL.md                   ← Orchestrator skill (delegates to agents)
    edit-flow.md               ← Edit flow steps (loaded only on edit path)
    verify-flow.md             ← Playwright browser verification (loaded only when user opts in)
```

## Skills

| Skill | Description |
|-------|-------------|
| `/genpage` | Build and deploy generative pages for a model-driven Power App |
| `/app-builder` | **(Preview)** Build and edit a whole model-driven app — tables, columns, relationships, adaptive forms, views, Choice-column charts, generative pages, app + sitemap, sample data, and admin-gated AI features — from a natural-language intent, via the vendored `cds-maker-sdk` |
| `/report-issue` | File a bug/issue about the model-apps plugin to the GitHub repository |

## Agents

Agents are invoked by skills via the `Task` tool — they are not user-invocable.

| Agent | Invoked By | Description |
|-------|-----------|-------------|
| `genpage-planner` | `genpage` (create flow) | Validates prereqs, gathers requirements, detects entity/app existence, presents plan for approval, writes `genpage-plan.md` |
| `genpage-entity-builder` | `genpage` (create flow) | Provisions Dataverse tables, columns, relationships, choices, and sample data via `scripts/provision-entities.js` (the shared SDK-backed core). Bulk inserts use OData `$batch`. Writes a transactional log for recovery |
| `genpage-page-builder` | `genpage` (create flow) | Generates one complete `.tsx` page from the plan and schema; runs in parallel with other builders for multi-page requests |
| `genpage-edit-planner` | `genpage` (edit flow) | Reads the downloaded page artifacts (page.tsx, config.json, prompt.txt), gathers change requirements, presents edit plan, writes `genpage-edit-plan.md`. The orchestrator applies the edit inline. |

## Key Concepts

### Genux Pages

Generative pages (genux) are React 17 + TypeScript single-file components that run inside model-driven Power Apps. They use Fluent UI V9 for styling and the DataAPI for Dataverse data access. Each page is a single `.tsx` file with `export default GeneratedComponent`.

### DataAPI

The DataAPI (`props.dataApi`) provides typed CRUD operations against Dataverse tables. It uses RuntimeTypes.ts (generated by `pac model genpage generate-types`) for type safety. Column names must be verified from the generated schema — never guessed.

### RuntimeTypes

TypeScript type definitions generated from Dataverse metadata. Contains entity types, enum registrations, and the `GeneratedComponentProps` interface. Generated via PAC CLI before code generation to ensure correct column names.

## Development Standards

- **React 17 + TypeScript** — all generated code
- **Fluent UI V9** — `@fluentui/react-components` exclusively (DatePicker from `@fluentui/react-datepicker-compat`, TimePicker from `@fluentui/react-timepicker-compat`)
- **Single file architecture** — all components, utilities, styles in one `.tsx` file
- **No external libraries** — only React, Fluent UI V9, approved Fluent icons, D3.js for charts
- **Type-safe DataAPI** — use RuntimeTypes when Dataverse entities are involved
- **Responsive design** — flexbox, relative units, never `100vh`/`100vw`
- **Accessibility** — WCAG AA, ARIA labels, keyboard navigation, semantic HTML
- **Complete code** — no placeholders, TODOs, or ellipses in final output

## Skill Authoring Guidelines

- Keep SKILL.md under 500 lines
- Use short, descriptive `name` field (e.g., `genpage`)
- Write descriptions in third person ("Creates X" not "This skill guides you through creating X")
- Use progressive disclosure: SKILL.md for workflow, reference files for details
- Link to references inline: `See [troubleshooting.md](../../references/troubleshooting.md)`

## Building & Testing

**One-command regression gate (run before every commit)** — from `plugins/model-apps/`:

```bash
# Plugin unit suite only (node:test):
node scripts/run-tests.js

# Plugin suite + the vendored SDK's Jest suite (Node 20):
NODE20_BIN=/path/to/node20/bin node scripts/run-tests.js --with-sdk /path/to/power-platform-ux
```

- `run-tests.js` runs the full `scripts/tests/*.test.js` suite and prints a combined PASS/FAIL.
- The SDK's Jest suite needs **Node 20** (its `canvas` native module is built for the Node-20 ABI).
  Set `NODE20_BIN` to a Node-20 bin dir; without it the SDK suite is skipped (plugin suite still runs).
- genpage evals: `node --test evals/model-apps/genpage/tests/*.test.js`, plus the Layer 1/2 runners
  (`node evals/model-apps/genpage/run-layer-{1,2}.js --tier smoke`). See `## Eval Suite` below.

**The vendored SDK lives in a separate repo.** The Dataverse mechanics are in
`power-platform-ux` (Azure DevOps `msazure/OneAgile`), package `packages/cds-maker-sdk`. This plugin
ships a **self-contained bundle** at `scripts/vendor/cds-maker-sdk.cjs` (NOT the SDK source). The SDK
owns deterministic wire formats (create/query/delete, AI settings/row-summaries, `seedRecordGraph`,
`enrichDefaultViews`, artifact resolve/cascade); the plugin owns judgment (spec validation, candidate
selection, prompt authoring). To change SDK behavior:

```bash
# 1. Build the SDK (emits lib/) — from <ppux>/packages/cds-maker-sdk:
npm run build          # tsc/ppux-build
npm test               # Jest (Node 20)
npm run lint           # ppux-lint (Node 20)

# 2. Rebuild the vendored bundle here (reads the SDK's lib/, so build the SDK first) — from repo root:
node plugins/model-apps/scripts/_vendor-build/build.js --sdk /path/to/power-platform-ux
# → rewrites scripts/vendor/cds-maker-sdk.cjs (~540 KB). COMMIT the rebuilt bundle.
```

Only the SDK `src/` is committed in the SDK repo (`lib/` is gitignored). A type-only/whitespace SDK
edit produces a byte-identical `lib/*.js`, so the bundle only needs rebuilding when SDK **runtime**
changes.

**Vendored-SDK contract invariants (regression net).** When you bump the SDK and re-vendor, the
skill relies on behaviors that must survive. `scripts/tests/vendor-sdk-smoke.test.js` locks them
(the `CONTRACT:` tests) — run them against every rebuilt bundle:
- **Raw OData filters pass through, single-encoded** — the skill builds raw `$filter` strings
  (quoted string literals via `lib/odata.js`, and **unquoted GUID literals** like `objectid eq <guid>`);
  a query builder may transport-encode them but must not double-encode.
- **Name-based methods accept logical/unique/schema names verbatim** — `deleteTable`, `setEntityIcon`,
  `resolveArtifact({uniqueName}/{name}/{entity})`, `createRelationship({referencedEntity,…})`. A GUID
  normalizer must apply to GUID params ONLY, never to these names.
- **Sitemap free-text (titles/URLs/descriptions) is XML-escaped, not rejected** — a "safe DOM factory"
  must escape attribute/text VALUES while only validating element/attribute NAMES.
- **`deleteAppCascade` returns a structured `{ success, deleted, failures }` result** — teardown
  reads `failures` to report orphaned sitemap/genpage rows instead of claiming a clean delete; the
  bundle must keep returning the result (not void) after a re-vendor.

**Live end-to-end (app-builder — writes to a real Dataverse env; optional).** All build/verify/
teardown scripts are **dry-run by default**; add `--apply` to write.

```bash
az account set --subscription <sub-id>
node scripts/check-auth.js <envUrl>          # az + pac identity match + WhoAmI preflight
node scripts/build-model-app.js   --env <envUrl> --spec @<dir>/app-spec.json [--sample-data --publish] --apply
node scripts/verify-model-app.js  --env <envUrl> --spec @<dir>/app-spec.json
node scripts/teardown-model-app.js --env <envUrl> --spec @<dir>/app-spec.json --apply
```

AI features are **admin-gated** — preflight readiness with `node scripts/ai-preflight.js --env <envUrl>`.
Prefer a scratch env; always tear down probes (`teardown-model-app.js --apply`) to leave 0 leftovers.

**After modifying the plugin also:** run `claude --debug` to confirm the plugin loads, exercise the
skill (`/genpage` or `/app-builder`), and for genpage verify Playwright browser checks
(navigate/snapshot/click/screenshot).

## Eval Suite

The plugin has a 3-layer eval suite under `evals/model-apps/genpage/`. Two
layers are automated (TAP v13 runners); Layer 3 is manual.

- **Comprehensive guide:** `evals/model-apps/genpage/EVAL_GUIDE.md` — what
  we evaluate, the 3 layers, tiers (smoke/full/stress), fixture types
  (synthetic vs real captures), runner output, capture flow, cadence,
  diagnosing failures, adding evals and assertions.
- **Eval definitions:** `evals/model-apps/genpage/evals.json` — 16 evals
  with prompts, answers, and expectations.
- **Fixtures:** `evals/model-apps/genpage/fixtures/<eval-id>-<slug>/` —
  one folder per captured or synthetic run. Each contains the `.tsx`,
  `workflow-log.md`, `genpage-plan.md`, and (when applicable)
  `entity-creation-log.md` and `RuntimeTypes.ts`.

Run on every PR that touches the skill, agents, rules, or evals:

```bash
node evals/model-apps/genpage/run-layer-1.js --tier smoke
node evals/model-apps/genpage/run-layer-2.js --tier smoke
```
