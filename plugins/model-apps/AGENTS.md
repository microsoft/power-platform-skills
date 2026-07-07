# AGENTS.md — Model Apps Plugin

This file provides guidance to AI Agents when working with the **model-apps** plugin.

## What This Plugin Is

A plugin for building and deploying Power Apps generative pages (genux) for model-driven apps. Uses React 17 + TypeScript + Fluent UI V9 single-file components, deployed via PAC CLI.

The `/genpage` skill orchestrates specialist agents: a planner (requirements + plan approval), an optional entity builder (Dataverse entity creation via the plugin's own Node.js Web API scripts), and parallel page builders (code generation).

**Requirements:**
- **PAC CLI ≥ 2.7.0** — for app and page deploy operations
- **Azure CLI (`az`)** — used by entity-builder for Dataverse Web API auth; must be logged in with the same identity as the active `pac` profile

No Dataverse Skills plugin or Python dependency.

## model-app-maker — intent → model-driven app

A second skill (`/model-app-maker`) builds a whole **model-driven app** (tables, columns,
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
  (`createSolution`/`createTable`/`createColumn`/`createRelationship`/`createRecordsBulk`, then
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
  (`solution·data-model·sample-data·web-resources·views·charts·forms·commands·dashboards·app-shell·pages·publish`) are
  selectable with `--only`/`--skip`/`--from`/`--to`; independent ops run with bounded parallelism.
  Emits `[n/total]` events the orchestrator narrates + a `BuildHalt` it gates on. Dry-run by
  default; `--apply` writes, `--sample-data` / `--publish` opt-in.
- **`scripts/teardown-model-app.js` → `scripts/lib/sdk-teardown.js`** — the first-class, **classifier-safe**
  teardown (reverse of the build), for cleaning up live-verification probes or a failed build. Deletes
  exactly the artifacts a given App Spec declares, in dependency-safe order (**app → dashboards →
  commands → web-resources → tables [reverse-topological, children-first] → solution**); a table delete
  cascades its forms/views/charts/relationships/columns and the empty solution container goes last. Every
  id is resolved from a spec-declared name/logical/uniquename via an exact-match OData filter, so it can
  never wildcard-scan an org. **Dry-run by default** (`--apply` writes); best-effort continue (a failed
  step is recorded, teardown proceeds), and it absorbs the EntityDefinitions **cosmetic 404** (confirms
  via a follow-up GET) + the appaction **cascade 404**. `--clear-workspace` prunes `.maker-workspace/`
  after a clean apply. `planTeardown(spec)` is pure (dry-run + unit-test surface); reuses
  `appUniqueName`/`commandsByEntity`/`topoOrderEntities` from the build engine (DRY).
- **`scripts/download-model-app.js` → `scripts/lib/hydrate-spec.js`** — the **edit flow**: pulls a
  *deployed* app back into a complete App Spec + page code (sitemap → `appShell` with icons, **every**
  generative page via `pac model genpage download`, referenced entities, icon web resources, solution).
  Edit the downloaded spec and re-run the build (idempotent) — create and edit share one path. Always
  pull fresh at the start of an edit session (the build reads an etag; a write against an artifact
  changed in Maker throws a version conflict → re-pull, never clobber).
- **`scripts/verify-model-app.js` → `scripts/lib/verify-spec.js`** — read-only reconcile of the App Spec
  against what actually deployed (entities/columns/views/charts/forms + sitemap subareas + icons); exits
  non-zero and lists anything missing, catching silent partial builds.
- **`scripts/preview-form.js` → `scripts/lib/form-preview.js`** — renders an ASCII **form
  wireframe** (tabs, sections, fields with widget hints, the Notes/timeline block, sub-grids, form
  JS) from the App Spec, so the user can review a form visually during authoring before approving.
- **`scripts/vendor/cds-maker-sdk.cjs`** — the SDK vendored as a self-contained headless bundle
  (rebuild via `scripts/_vendor-build/`); **`scripts/lib/sdk-http-client.js`** injects an
  `az`-token HttpClient. No browser, no relay — the SDK reuses the designer's own serializers.
- The build log is **phase-grouped with per-step status** (`▶ phase` / `[n/total] ✓ created` /
  `⊘ skipped` / `✗ failed`) + a closing summary; dry-run lists the same plan with a `▢` marker.

Flow: Phase 0 (working dir) → Phase 1 (author the spec interactively, **in the main loop**,
per `references/authoring-flow.md`) → Phase 2 (narrated SDK build) → Phase 3 (verify & iterate).
**Edit** an existing app the same way: `scripts/download-model-app.js` pulls a deployed app back into a
complete spec (+ page code); edit it and re-run Phase 2 (idempotent — reuses the app/tables, updates pages
in place, preserves `GenPage` subareas). **Upcoming:** shippable-defaults
provisioning (security role / quick-create / standard views).

## Local Development

Test this plugin locally:

```bash
claude --plugin-dir /path/to/plugins/model-apps
```

## Architecture

```
.plugin/plugin.json            ← Open Plugins metadata (name, version, keywords)
.mcp.json                      ← MCP server config (Playwright for browser verification)
AGENTS.md                      ← Plugin guidance for AI agents (this file)
CLAUDE.md                      ← Symlink → AGENTS.md
README.md                      ← User-facing intro and prereqs
CHANGELOG.md                   ← Keep-a-Changelog
docs/
  architecture.md              ← One-page architecture overview with diagrams
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
  build-model-app.js           ← model-app-maker: narrated, idempotent SDK build (dry-run default)
  download-model-app.js        ← model-app-maker: pull a deployed app into an editable spec (edit flow)
  teardown-model-app.js        ← model-app-maker: classifier-safe reverse-of-build teardown
  verify-model-app.js          ← model-app-maker: reconcile the spec against the deployed app
  preview-form.js              ← model-app-maker: ASCII form wireframe for authoring review
  run-tests.js                 ← one-command plugin + SDK regression runner
  smoke-eval.js                ← scripted live smoke eval (build → assert → teardown)
  generate-page-manifest.js    ← Phase 0.5: writes working-dir package.json + genpage.d.ts
  capture-fixture.js           ← Copies /genpage working dir into an eval fixture and runs both runners
  lib/
    entity-provision.js        ← Shared entity-provisioning core (solution + data-model + sample-data)
    provision-input.js         ← Input validation for entity provisioning
    dataverse-auth.js          ← Shared auth + HTTP helpers (uses `az account get-access-token`)
    supported-dependencies.js  ← Single source of truth for runtime + dev deps versions
    sdk-build.js               ← model-app-maker build engine (idempotent; incl. the pages phase)
    sdk-teardown.js            ← model-app-maker teardown engine (planTeardown is pure)
    sdk-http-client.js         ← az-token HttpClient for the vendored SDK
    spec-lint.js / app-spec.js ← App Spec guardrail lint + validation
    genpage-cli.js             ← pac model genpage upload/list/download wrapper
    hydrate-spec.js            ← reconstruct an App Spec from a deployed app (edit flow)
    verify-spec.js             ← spec-vs-deployed reconciliation core
    build-journal.js           ← durable JSONL build journal (resume diagnostics)
    form-preview.js            ← form wireframe renderer
    _graph.js                  ← entity topological ordering (shared by build + teardown)
  vendor/cds-maker-sdk.cjs     ← headless vendored SDK bundle (rebuilt via _vendor-build/)
  _vendor-build/               ← esbuild vendoring tooling (build.js + pinned deps)
  tests/                       ← node --test coverage for the scripts above
skills/
  model-app-maker/
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

## Testing Changes

After modifying this plugin:

1. Run `claude --debug` to see plugin loading details
2. Run `node --test plugins/model-apps/scripts/tests/*.test.js` (must pass)
3. Run `node --test evals/model-apps/genpage/tests/*.test.js` (must pass)
4. Run both eval-suite runners against shipping fixtures (Layer 1 + Layer 2):
   - `node evals/model-apps/genpage/run-layer-1.js --tier smoke`
   - `node evals/model-apps/genpage/run-layer-2.js --tier smoke`
5. Test skill invocation with `/genpage`
6. Test with both Dataverse entity pages and mock data pages (smoke + edit)
7. Verify Playwright browser verification works (navigate, snapshot, click, screenshot)

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
