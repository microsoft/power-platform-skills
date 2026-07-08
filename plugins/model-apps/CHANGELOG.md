# Changelog

All notable changes to the **model-apps** plugin.

## [Unreleased] — 2.2.0

A new **`/model-app-maker`** skill (Preview) that builds and edits whole model-driven apps,
plus local-dev ergonomics, sample coverage, and an automated eval suite with
real and synthetic fixtures. Builds on v2.1; no breaking changes.

### Added
- **`/model-app-maker` AI-first features.** The new `ai-features` build phase (runs after
  `app-shell`/`pages`, before `publish`) activates AI capabilities declared in the App Spec's
  `ai` block. App-level features: **form-fill assist** (data entry), **natural-language grid/view
  search** (data exploration), **NL chart / AI data visualization**, and **M365 Copilot** (opt-in,
  defaults off). **Per-table Copilot row summaries** (Insight Cards) with tailored prompts —
  auto-selected for good-candidate tables (`default: "auto"`) and skipping lookup-only / config /
  junction tables and the D365-owned `incident`/`lead`/`opportunity`. All features are
  **admin-gated**: the phase preflights via `RetrieveSetting` (SDK) and skips/warns for anything
  the environment admin has not enabled — never fails the build. Standalone preflight:
  `scripts/ai-preflight.js` (prints on/off status + exact admin action for each feature). Teardown
  removes AI records (`AIModelPublish` + `aiskillconfigs`) created by the phase.
- **SDK AI + artifact-resolve methods.** `cds-maker-sdk` now exposes `RetrieveSetting`,
  `SaveSettingValue`, `AIModelPublish`, and `aiskillconfigs` CRUD — used by the `ai-features`
  phase — plus new artifact-resolve helpers used internally by the build engine.
- **`scripts/ai-preflight.js`**, **`scripts/lib/ai-candidates.js`**, **`scripts/lib/ai-prompt.js`**
  — standalone preflight reporter, candidate-table selector, and tailored-prompt generator for the
  AI-first features.
- **`ai` block documented** in `references/app-spec-schema.md`: full `appFeatures` + `summaries`
  shape, admin-gate notes, candidate-skip policy, and prompt authoring guidelines.
- **`/model-app-maker` skill (Preview).** Turns a natural-language intent into a deployed
  **model-driven app** — tables/columns/relationships, sample data, views (with enriched default
  Active/Inactive columns), Choice-column charts, adaptive forms with sub-grids, quick-create/quick-view
  forms, modern command-bar buttons, dashboards, sitemap icons, and — genpage-first — **generative pages**
  for overview/dashboard surfaces. Deterministic, **idempotent** build via the vendored headless
  `cds-maker-sdk` (`scripts/build-model-app.js`); interactive two-level authoring + `spec-lint` guardrail +
  plan-mode gate. **Create and edit share one path** (`scripts/download-model-app.js` pulls a deployed app
  back into an editable spec); read-only `scripts/verify-model-app.js` reconciles spec vs deployed;
  classifier-safe `scripts/teardown-model-app.js`. Durable build journal + transient auto-retry.
- **Phase 0.5 — local-dev manifest.** Working dirs now get `package.json`
  and `genpage.d.ts` so `npm install` + editor IntelliSense work after
  generation. Versions in `references/supported-dependencies.md`.
- **Eval suite runners.** `run-layer-1.js` (workflow assertions) and
  `run-layer-2.js` (code assertions) emit TAP v13. `EVAL_GUIDE.md` covers
  types, tiers, capture flow.
- **10 fixtures** under `evals/.../fixtures/` (6 synthetic + 4 real
  captures; all green under the tightened v2.2 spec).
- `scripts/capture-fixture.js` — copies `/genpage` working dirs into
  fixtures and runs both layers.
- `samples/11-kanban-with-dnd.tsx` — native HTML5 drag-and-drop sample.
- `samples/12-dialog-form-overlay.tsx` + **Dialogs and Overlays** guidance
  (rules.md rules 16–18 and Special Patterns section, plus a troubleshooting
  entry): confine portalled Fluent surfaces (`Dialog`, `Popover`, `Menu`,
  `Tooltip`, `Combobox`/`Dropdown`) to the page via `mountNode` +
  `contain: layout`, default dialogs to `modalType="non-modal"`, and never nest
  dialogs — so a modal can't escape the preview and cover the designer /
  coding-agent panel.

### Removed
- **Consolidated the standalone entity/solution scripts into the SDK.** `create-table.js`,
  `add-column.js`, `create-relationship.js`, `create-record.js`, `create-solution.js`, and
  `add-to-solution.js` (added in 2.1.0) are removed — both `/genpage` and `/model-app-maker` now
  provision Dataverse through the shared SDK-backed `scripts/lib/entity-provision.js` core (via
  `provision-entities.js` / the build engine), eliminating duplicate metadata logic.

### Changed
- Spec tightening so workflow-logs are command-verbatim and `pageInput`
  destructure is required even on mock pages (planner, page-builder,
  SKILL.md Phase 6 + Phase 8).
- 8 runner regex relaxations to accept functionally-equivalent agent
  patterns (typed `(window as any).Xrm` aliases, `pac solution list`,
  local enum mapping, etc.) — no rule loosening.

### Fixed
- **Synthetic fixtures + sample 11 now follow Rule 11 (queryTable returns
  DataTable, not an array).** 7 files were iterating `result` directly
  (`setTasks(result)`, `result.map(...)`) instead of `result.rows`,
  producing `X.map is not a function` at runtime. Fixed in
  `samples/11-kanban-with-dnd.tsx` and 6 fixture `.tsx` files.
  New Layer 2 assertion catches this pattern going forward: any Dataverse
  file calling `dataApi.queryTable` must access `.rows` somewhere.

### Tests
- **317 passing** across `scripts/tests/` (unit + golden snapshots + journal evals) plus the genpage
  eval suites; the vendored `cds-maker-sdk` ships its own Jest suite. `scripts/run-tests.js
  --with-sdk <ppux>` runs both in one command.

## 2.1.0 — 2026-05-13

Replaces the Dataverse MCP server + Python SDK fallback with Node.js Web API
scripts. Adds solution selection, prefix discipline, and a consolidated auth
pre-flight. Trim of ~27K tokens on hot-path page-builder runs.

### Breaking
- **Azure CLI (`az`) is now required** for entity creation. The `az` identity
  must have access to the target Dataverse env (same as the active `pac` profile).
- **Dataverse Skills plugin is no longer required.** Soft dep removed.
- `.env`, `scripts/auth.py`, and device-code prompts from the Dataverse Skills
  plugin no longer used.

### Added
- Node.js Web API scripts under `plugins/model-apps/scripts/`:
  `check-auth.js`, `dataverse-request.js`, `create-table.js`, `add-column.js`,
  `create-relationship.js`, `create-record.js` (with `$batch` bulk),
  `create-solution.js`, `add-to-solution.js`, `lib/dataverse-auth.js`.
- Solution selection in planner with prefix-conflict warnings.
- Transactional log at `<working-dir>/entity-creation-log.md`.
- `node --test` coverage under `scripts/tests/` (47 tests).

### Fixed
- **Prefix drift made structurally impossible.** Plan stores logical-name
  suffixes only; entity-builder constructs `${prefix}_${suffix}` from the
  single `Publisher Prefix:` source of truth.
- **`pac model create` always passes `--solution`.** Default value is `Default`.
  The CLI's "active solution" fallback errors in practice.
- **`--prompt` is now scoped per upload role**: full description on create,
  delta only on every subsequent upload (PAGEREF, fix re-deploy, edit flow).
- **Bulk-insert partial failure** emits structured JSON to stdout (not
  `[object Object]`).
- entity-builder bash snippets no longer mix JS template literals.
- planner no longer shells `grep`/`awk`/`sed` (Windows-incompatible).

### Performance
- Page-builder no longer loads `verified-icons.txt` upfront (~26K tokens
  saved per run). Validation switched to post-write `Grep` only.
- `rules.md` trimmed −98 lines: dropped duplicated DataAPI
  type definitions (canonical source is `RuntimeTypes.ts`); tightened usage
  examples.
- `rules.md` Page Input section trimmed −25 lines: pure prose tighten.
- Phase 7 (browser verification) extracted to `skills/genpage/verify-flow.md`,
  loaded only when the user opts in. SKILL.md trimmed an additional −95 lines.
- Reference docs renamed for consistency:
  `genpage-rules-reference.md` → `rules.md`,
  `genpage-plan-schema.md` → `plan-schema.md`,
  `genpage-localization-reference.md` → `localization.md`,
  `data-caching-pattern.md` → `data-caching.md`.
- Removed stale `samples/3-poa-revocation-wizard.tsx` (327 lines, redundant
  with `2-wizard-multi-step.tsx` for the wizard pattern; the DataGrid /
  file-upload / multiselect patterns it composed are covered by other
  samples). Renumbered 4–8 → 3–7 to close the gap.

### Added (samples)
- `samples/8-dashboard-with-charts.tsx` — KPI cards + two D3 charts (area +
  donut) with the animation guard from rules.md. Covers the dashboard page
  type and the D3 chart pattern that evals 2 and 6 expect.
- `samples/9-list-with-caching.tsx` — list page using Rule 15's window cache
  + inline async IIFE pattern. Cross-page navigation to the detail sample via
  `PAGEREF_` placeholder.
- `samples/10-detail-with-pageinput.tsx` — detail page paired with the list.
  Receives `pageInput.recordId` synchronously, initial `loading: true` on
  frame 0, `Map<recordId, row>` cache on `window`. Demonstrates the
  formatted-value lookup for `_parentcustomerid_value`.
- Added scope headers to `rules.md` "Common Errors" (generation-time
  anti-patterns) and `troubleshooting.md` (deployment/runtime/env) so readers
  can pick the right one without scanning.

### Migration from 2.0
1. `az login` (use the same identity as `pac auth who`).
2. Uninstall the Dataverse Skills plugin if it was only for `/genpage`.
3. No code/page changes needed; existing pages keep working.

---

## 2.0.0 — 2026-05-12

Major refactor of `/genpage` into an agent-orchestrated architecture.

### Breaking
- **PAC CLI ≥ 2.7.0** required (for `pac model create`, `pac model list-tables --search`).
- Skill output now lives in a per-invocation working directory
  (`genpage-plan.md`, `RuntimeTypes.ts`, one `.tsx` per page, `workflow-log.md`).
- Plan-mode approval is mandatory; no skip/auto-accept.

### Added
- Four specialist agents: `genpage-planner`, `genpage-entity-builder`,
  `genpage-page-builder`, `genpage-edit-planner`.
- Multi-page parallel generation; cross-page navigation via `PAGEREF_<filename>`
  placeholders resolved in Phase 6.5.
- `pac model create` inline app provisioning.
- Plan schema contract at `references/plan-schema.md`.
- Verified Fluent icon list at `references/verified-icons.txt` (~5000 names).
- Eval suite: 16 evals across smoke/full/stress tiers + runbook.

### Changed
- Entity detection uses native `pac model list-tables --search` with exact
  logical-name match.
- Component template destructures `pageInput` in addition to `dataApi`.
- Rules reference adds Rule 14 (batched async state) and Rule 15 (data-fetching
  IIFE + cache guard).

### Migration from 1.x
1. `dotnet tool update --global Microsoft.PowerApps.CLI.Tool` (to ≥ 2.7.0).
2. Existing deployed pages keep working — only local workflow/layout changed.

---

## 1.0.6 — earlier in 2026

PageInput support, FluentProvider flicker fix, lookup `$select` rule, data
caching pattern. See git history for details.
