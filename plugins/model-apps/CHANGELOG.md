# Changelog

All notable changes to the **model-apps** plugin.

## 2.1.0 — 2026-05-13

Replaces the Dataverse MCP server + Python SDK fallback in `genpage-entity-builder`
with a set of plain Node.js scripts that hit the Dataverse Web API directly using
Azure CLI (`az`) for auth. Same approach `power-pages` uses.

### Fixed

- **Bulk-insert partial failure now reports structured JSON instead of
  `[object Object]`.** `emitResult(false, <object>)` previously wrote
  `String(payload)` to stderr, which dropped per-record error detail that the
  entity-builder's sample-data step is supposed to surface. The shared helper
  now emits the JSON payload to stdout (so callers can parse `errors[...]`),
  writes a one-line summary to stderr, and exits 1. Locked behind a regression
  test in `scripts/tests/dataverse-auth.test.js`.
- **`genpage-entity-builder.md` no longer mixes JS template-literal syntax
  into ```bash``` blocks.** Examples now use shell variables (`$ENV_URL`,
  `$SOLUTION`, `$PREFIX`) and pass `--solution "$SOLUTION"` on every
  metadata-create call (matches the "always pass `--solution`" contract that
  was previously stated in prose but contradicted by the snippets).
- **`genpage-planner.md` Solution-Selection no longer shells out to
  `grep`/`awk`/`sed`** to extract the env URL. Those tools aren't reliably
  present on Windows (this plugin's primary platform). The planner now reuses
  the env URL it already discovered earlier from `pac org who`.
- **`--prompt` is now scoped to the upload's role on every `pac model genpage
  upload` call.** First upload of a new page sends the full page description
  (from the plan's `## User Requirements`). Every subsequent upload of an
  existing page — Phase 6.5 PAGEREF resolution, Phase 7.5 fix re-deploy, and
  the edit flow — sends a **delta-only prompt** describing just what changed
  in that upload. Previously every upload re-sent the original full
  description, polluting the page's prompt history. Locked behind a new
  `common_workflow_assertion` so future drift is caught by the eval suite.
- **`pac model create` always passes `--solution`.** The PAC CLI help claims
  `--solution` defaults to "the active solution", but in practice the command
  errors out with `"The given solution name is not valid: ()"` when omitted.
  The plan schema now mandates `Solution:` (default `Default`) and
  `Publisher Prefix:` (default `new`) on every plan, and the orchestrator/
  entity-builder always pass `--solution <name>` to every call. No conditional
  "omit if Default" branch.

### Breaking changes

- **Dataverse Skills plugin is no longer required.** The soft dependency has been
  removed. If you had it installed for `/genpage` entity creation, you can keep
  it (used by other plugins) but `/genpage` no longer talks to it.
- **Azure CLI (`az`) is now required for entity creation.** The `az` identity must
  have access to the target Dataverse env (same account as your active
  `pac auth` profile in most cases). Run `az login` if you haven't.
- **`.env`, `scripts/auth.py`, and any device-code prompts from the Dataverse
  Skills plugin are gone.** Entity-builder no longer reads them and no longer
  shells out to Python.

### Added

- **Node.js Web API scripts under `plugins/model-apps/scripts/`:**
  - `check-auth.js` — consolidated pre-flight that verifies `az` is installed +
    logged in, `pac` has an active env, the two identities match, and `WhoAmI`
    against the env returns 200. Returns one structured JSON object with an
    `ok`, `blocker` code, `message`, and `identitiesMatch` flag. Always exits 0
    so callers can parse stdout to decide whether to proceed.
  - `dataverse-request.js` — general OData wrapper (escape hatch for any one-off call)
  - `create-table.js` — POST to `EntityDefinitions`, builds the primary name attribute
  - `add-column.js` — string, memo, integer, decimal, money, datetime, boolean, picklist
  - `create-relationship.js` — 1:N (lookup) + N:N via `POST /RelationshipDefinitions`
  - `create-record.js` — single record + bulk via OData `$batch` (multipart/mixed, 100 per batch by default)
  - `create-solution.js` — POST `/solutions` with auto-resolved env Default Publisher
  - `add-to-solution.js` — `AddSolutionComponent` action
  - `lib/dataverse-auth.js` — shared auth + HTTP helpers (uses `az account get-access-token`,
    refreshes on 401, backs off on 429/5xx)
- **Solution selection in the planner.** When the build needs metadata work (new
  entities OR a new app), the planner now queries the env for non-managed
  solutions, asks the user via `AskUserQuestion`, and records the choice in
  `genpage-plan.md` under `## Environment` as `Solution: <uniqueName>` and
  `Publisher Prefix: <prefix>`. Options offered: existing custom solutions,
  "Create a new 'genpage-<app>' solution", or "Use Default Solution". The
  question is **skipped entirely** for code-only flows (no new entities, no new
  app). The orchestrator threads `--solution` into `pac model create` and the
  entity-builder threads it into every `create-*` / `add-column` call.
- **Transactional log** (`<working-dir>/entity-creation-log.md`) written by
  entity-builder for every successful operation. On failure, the log gives a
  recovery point so reruns don't duplicate work.
- **`node --test` coverage** at `plugins/model-apps/scripts/tests/` for argument
  parsing, payload shape, and error-path exit codes.

### Changed

- `genpage-entity-builder.md` rewritten end-to-end. No MCP tool references. No
  Python. Step 2 is an `az` + `WhoAmI` connectivity probe instead of an MCP probe.
- `SKILL.md` Phase 2a swapped from "probe Dataverse Skills plugin" to
  "verify `az account show` + `WhoAmI`".
- `AGENTS.md` / `CLAUDE.md` updated to drop the Dataverse Skills plugin
  dependency note and add the `az` requirement.

### Why this change

The Dataverse MCP server has been unreliable in practice:
- `settings.local.json` server-name drift silently disables the MCP entirely
  (we hit this twice in one week)
- `npx`-based stdio servers cold-start slow and don't always handshake cleanly
- The Python SDK fallback required a second plugin to be installed AND
  connected, multiplying setup failure modes

The new path collapses two auth chains into one (`az` only) and is the same
production-hardened pattern that `power-pages` already ships.

### Migration from 2.0

1. `az login` if you haven't (or `az login --username <user>@<tenant>` to match
   the test account on your Dataverse env)
2. You can uninstall the Dataverse Skills plugin if it was only there for
   `/genpage` — `/genpage` no longer uses it
3. No code or page changes needed; existing pages keep working

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
