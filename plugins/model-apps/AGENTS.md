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
.claude-plugin/plugin.json     ← Plugin metadata (name, version, keywords)
.mcp.json                      ← MCP server config (Playwright for browser verification)
AGENTS.md                      ← Plugin guidance for AI agents (this file)
CLAUDE.md                      ← Symlink → AGENTS.md
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
  troubleshooting.md           ← Deployment/runtime/env issues
  verified-icons.txt           ← ~5000 Fluent UI icon names; Grep-validated by page-builder
samples/                       ← Example .tsx files (10 samples)
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
  lib/
    dataverse-auth.js          ← Shared auth + HTTP helpers (uses `az account get-access-token`)
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
3. Test skill invocation with `/genpage`
4. Test with both Dataverse entity pages and mock data pages (smoke + edit)
5. Verify Playwright browser verification works (navigate, snapshot, click, screenshot)
