# AGENTS.md — Model Apps Plugin

This file provides guidance to AI Agents when working with the **model-apps** plugin.

## What This Plugin Is

A plugin for building and deploying Power Apps generative pages (genux) for model-driven apps. Uses React 17 + TypeScript + Fluent UI V9 single-file components, deployed via PAC CLI.

The `/genpage` skill orchestrates specialist agents: a planner (requirements + plan approval), an optional entity builder (Dataverse entity creation via the plugin's own Node.js Web API scripts), and parallel page builders (code generation).

**Requirements:**
- **PAC CLI ≥ 2.7.0** — for app and page deploy operations
- **Azure CLI (`az`)** — used by entity-builder for Dataverse Web API auth; must be logged in with the same identity as the active `pac` profile

No Dataverse Skills plugin or Python dependency.

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
  create-table.js              ← Creates a Dataverse custom table
  add-column.js                ← Adds a column to an existing table
  create-relationship.js       ← Creates 1:N (lookup) or N:N relationships
  create-record.js             ← Creates one or many records (auto-batches via $batch)
  create-solution.js           ← Creates a Dataverse solution with env's Default Publisher
  add-to-solution.js           ← Adds an existing component to a solution
  generate-page-manifest.js    ← Phase 0.5: writes working-dir package.json + genpage.d.ts
  capture-fixture.js           ← Copies /genpage working dir into an eval fixture and runs both runners
  lib/
    dataverse-auth.js          ← Shared auth + HTTP helpers (uses `az account get-access-token`)
    supported-dependencies.js  ← Single source of truth for runtime + dev deps versions
  tests/                       ← node --test coverage for the scripts above
skills/
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
| `genpage-entity-builder` | `genpage` (create flow) | Creates Dataverse tables, columns, relationships, choices, and sample data via the plugin's Node.js Web API scripts (`scripts/`). Bulk inserts use OData `$batch`. Writes a transactional log for recovery |
| `genpage-page-builder` | `genpage` (create flow) | Generates one complete `.tsx` page from the plan and schema; runs in parallel with other builders for multi-page requests |
| `genpage-edit-planner` | `genpage` (edit flow) | Reads the downloaded page artifacts (page.tsx, config.json, prompt.txt), gathers change requirements, presents edit plan, writes `genpage-edit-plan.md`. The orchestrator applies the edit inline. |
| `genpage-connector-builder` | `genpage` (create **and** edit flows) | **Single owner of the connectors feature gate.** Performs connector discovery (connections, connection references, datasets, tables, operations, schema), creates Dataverse connection references, and writes the `## Connector Bindings` contract + `connectors.json`. Both the planner and the edit-planner delegate all connector work to it. |

## Key Concepts

### Genux Pages

Generative pages (genux) are React 17 + TypeScript single-file components that run inside model-driven Power Apps. They use Fluent UI V9 for styling and the DataAPI for Dataverse data access. Each page is a single `.tsx` file with `export default GeneratedComponent`.

### DataAPI

The DataAPI (`props.dataApi`) provides typed CRUD operations against Dataverse tables. It uses RuntimeTypes.ts (generated by `pac model genpage generate-types`) for type safety. Column names must be verified from the generated schema — never guessed.

### RuntimeTypes

TypeScript type definitions generated from Dataverse metadata. Contains entity types, enum registrations, and the `GeneratedComponentProps` interface. Generated via PAC CLI before code generation to ensure correct column names.

## Feature Flags

Unreleased functionality is gated behind committed, **default-OFF** feature flags so
the skill can merge ahead of its cross-repo dependencies. With a flag OFF, the
**deployed page behavior is identical to before the feature existed** — the guarantee
is about runtime/deploy output, not that every authoring artifact is byte-for-byte
unchanged (e.g. plans still carry a `## Connector Bindings: No connector bindings.`
line). The mechanism lives in `scripts/lib/feature-flags.js` with the committed
values in `feature-flags.json` at the plugin root.

- **Source of truth:** `feature-flags.json` (e.g. `{ "connectors": false }`). Flip a
  flag to `true` in a one-line PR once its dependencies are GA in PROD.
- **Precedence (highest first):** env var `GENPAGE_ENABLE_<FLAG>` (e.g.
  `GENPAGE_ENABLE_CONNECTORS=1`) → committed `feature-flags.json` → default `false`
  (fail-closed). This mirrors the telemetry opt-out env-over-config convention.
- **LLM gate:** skill/agent markdown probes a flag with
  `node "${PLUGIN_ROOT}/scripts/lib/feature-flags.js" <flag>` (prints `enabled`/`disabled`,
  exits 0/1) and skips the gated workflow when disabled. `--list` prints every known
  flag's lifecycle **status** (experimental / in-progress / ga), effective state +
  source (env/file/default), summary, how to enable, plus config-validation warnings.
  Flags are catalogued with that metadata in the `FLAGS` map in `feature-flags.js`
  (the committed `feature-flags.json` carries only the on/off value).
- **Script backstop:** connector entrypoints call the shared
  `exitIfConnectorsDisabled()` helper (DRY — no inlined gate) and fail closed with
  exit 3 when OFF: `list-connections.js`, `create-connection-reference.js`, and the
  `--connection-refs` branch of `add-page-to-solution.js`.
- **Validation:** `KNOWN_FLAGS` + `validateFlags()` warn on unknown keys / non-boolean
  values in the committed file (so a typo can't silently do nothing, or — after a flip
  to `true` — accidentally enable the wrong thing).

**Connectors gate — the single owner is `genpage-connector-builder`.** Every connector
entry point must go through it or the helper; the checklist of places that gate:

1. Discovery — `genpage-connector-builder` runs the probe first (planner + edit-planner
   delegate to it; they do not gate inline).
2. Scripts — `list-connections.js` / `create-connection-reference.js` (`exitIfConnectorsDisabled`).
3. Deploy — SKILL Phase 4.5 **re-probes** the flag and treats absent/malformed
   `## Connector Bindings` as no bindings (a plan authored while ON must not deploy
   connectors after OFF).
4. ALM — the `--connection-refs` branch of `add-page-to-solution.js`.
5. Codegen — `genpage-page-builder` emits connector code only when the plan has an
   actual binding table (never on an absent/sentinel section).

The **`connectors`** flag currently ships OFF: GenPage connector support needs the
pac CLI connector verbs (PowerPlatform-Scale-AdminTools), the GenUX authoring control
(power-platform-ux), and the maker/admin ECS setting to all be released first.

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
