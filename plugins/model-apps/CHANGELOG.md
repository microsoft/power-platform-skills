# Changelog

All notable changes to the **model-apps** plugin.

## 2.0.0 — 2026-05-12

Major refactor of the `/genpage` skill into an agent-orchestrated architecture.
**Contains breaking prerequisite changes** — see Migration below.

### Breaking changes

- **PAC CLI requirement bumped from 2.3.1 to >= 2.7.0.** Required for the new
  `pac model create` (used to provision a model-driven app inline when none exists)
  and `pac model list-tables --search` (used by the planner for entity-existence
  detection). Older versions will fail prerequisite validation in Phase 1.
- **Skill output structure changed.** Previously the skill produced a single `.tsx`
  in the current directory. The skill now creates a kebab-case working directory
  per invocation that holds `genpage-plan.md`, `RuntimeTypes.ts` (if Dataverse),
  one `.tsx` per page, and `workflow-log.md`. Scripts that scraped the previous
  flat layout need to be updated.
- **Plan-mode approval is mandatory.** The planner agent enters plan mode and
  waits for user approval before any code is generated. There is no skip/auto-accept.

### Added

- **Agent architecture.** `/genpage` is now a slim orchestrator that delegates to
  four specialist agents:
  - `genpage-planner` — prerequisites, auth, requirements gathering, entity/app
    detection, plan-mode approval, writes `genpage-plan.md`
  - `genpage-entity-builder` — creates Dataverse tables/columns/relationships/
    choices/sample data via the Dataverse Skills plugin (soft dependency)
  - `genpage-page-builder` — generates one complete `.tsx` per page; fans out in
    parallel for multi-page builds
  - `genpage-edit-planner` — reads downloaded page artifacts (page.tsx,
    config.json, prompt.txt), gathers change requirements, writes
    `genpage-edit-plan.md` for inline application by the orchestrator
- **Dataverse entity creation** via a soft dependency on the
  [Dataverse Skills plugin](https://github.com/microsoft/Dataverse-skills).
  When the planner detects entities that don't exist, the orchestrator probes
  the Dataverse MCP availability and either invokes the entity-builder or asks
  the user to install/connect the Dataverse plugin.
- **Model-driven app creation** via `pac model create` when no app exists or
  the user picks "create new".
- **Multi-page parallel generation.** Plans with multiple pages fan out N
  parallel page-builders in a single Task message.
- **Cross-page navigation** using `PAGEREF_<filename>` placeholders resolved in
  a Phase 6.5 fix-up after all GUIDs are known.
- **Verified icon list** shipped at `references/verified-icons.txt` (~5000
  unsized Fluent UI V9 icon names). The page-builder cross-checks every icon
  import against this list to eliminate hallucinated icon names.
- **Plan document schema** at `references/genpage-plan-schema.md` defines the
  machine-readable contract between planner and downstream agents.
- **Eval suite rebuilt** with 16 evals across smoke/full/stress tiers, shared
  workflow + code assertions, and a manual runbook at
  `evals/model-apps/genpage/eval-runbook.md`.

### Changed

- **Entity detection** uses native `pac model list-tables --search` with exact
  logical-name match (no longer dependent on the Dataverse MCP for detection).
- **Component template** now destructures `pageInput` in addition to `dataApi`.
- **Rules reference** expanded with new rules: Rule 14 (batched async state for
  React 17), Rule 15 (data-fetching IIFE + cache guard), and updated Rule 9
  (icon name validation against `verified-icons.txt`).

### Migration from 1.x

1. Upgrade PAC CLI to >= 2.7.0:
   ```
   dotnet tool update --global Microsoft.PowerApps.CLI.Tool
   ```
2. Optional but recommended: install the
   [Dataverse Skills plugin](https://github.com/microsoft/Dataverse-skills) if you
   want the skill to create entities for you. Without it, the skill works with
   existing entities only.
3. Existing pages built by 1.x deploy without changes — the deployed page format
   is unchanged. Only the local workflow and source layout are different.

### Fixed

- Entity detection no longer relies on the Dataverse MCP for read-only existence
  checks (works in any environment with PAC CLI installed).
- The planner no longer hallucinates page or app names — Edit Flow Phase 1
  discovers them via `pac model list` + `pac model genpage list`.
- Localization detection runs only when the user is creating a new page (not on
  edit flow), saving an unnecessary `pac model list-languages` call.

---

## 1.0.6 — earlier in 2026

PageInput support, FluentProvider flicker fix, lookup `$select` rule, data
caching pattern. See git history for details.
