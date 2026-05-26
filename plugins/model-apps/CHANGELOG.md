# Changelog

All notable changes to the **model-apps** plugin.

## [Unreleased] — 2.2.0

Local-dev ergonomics (the "Three Asks"), additional sample coverage, full
contributor docs, and an automated eval suite with real and synthetic
fixtures. Builds on v2.1; no breaking changes.

### Added — Three Asks (local-dev ergonomics)
- **Phase 0.5 — local-dev manifest.** Every working dir now gets a
  `package.json` (Ask 2) and `genpage.d.ts` (Ask 3) written right after
  Phase 0. Run `npm install` once and VSCode IntelliSense, type-checking,
  and "go to definition" work for `window.Xrm`, the window cache key
  pattern, and React / Fluent / D3 imports.
- `references/supported-dependencies.md` — versioned package list (Ask 1)
  with confidence levels. `@fluentui/react-icons@2.0.326` is pinned to
  match the verified-icons regeneration; React 17 is pinned to runtime;
  other packages are `compatible` defaults pending upstream confirmation.
- `scripts/lib/supported-dependencies.js` — single source of truth used by
  both the reference doc and the manifest generator.
- `scripts/generate-page-manifest.js` — idempotent CLI; `--features
  charts,datepicker,timepicker` adds optional deps; `--force` overwrites.

### Added — Eval suite (automated grading + capture)
- `evals/model-apps/genpage/run-layer-1.js` — TAP v13 runner for the 15
  `common_workflow_assertions` + per-eval `Phase`/`Edit Phase` expectations.
  Reads `workflow-log.md`, `genpage-plan.md`, and (when present)
  `entity-creation-log.md`.
- `evals/model-apps/genpage/run-layer-2.js` — TAP v13 runner for the 18
  `common_code_assertions` + per-eval `Phase 5` expectations. Reads every
  `.tsx` in the fixture (excluding `RuntimeTypes.ts`).
- `evals/model-apps/genpage/lib/` — assertion-mapping libraries
  (`assertions-layer-1.js`, `assertions-layer-2.js`), fixture loader, and
  TAP reporter. Each assertion text maps to a check function.
- `scripts/capture-fixture.js` — copies a `/genpage` working dir into a
  fixture folder, skipping Phase 0.5 scaffolding (`package.json`,
  `genpage.d.ts`) and noise (`node_modules`, `*.log`), then runs both
  layers and reports pass/fail with named offenders.
- `evals/model-apps/genpage/EVAL_GUIDE.md` — comprehensive guide to the
  3-layer model, eval tiers, fixture types, runner output, capture flow,
  and procedures for adding evals / assertions.
- `evals/model-apps/genpage/fixtures/` — **10 fixtures**:
  - 6 synthetic (v2.2-compliant): evals 1, 2, 4, 7, 11, 13
  - 4 real captures: 2 pre-v2.2-spec (red, documented), 2 v2.2-spec
    (green) — eval 11 and eval 15
- Each fixture has its own `README.md` documenting source, status, and
  (for red fixtures) the path to remediation.

### Added — Samples + docs
- `samples/11-kanban-with-dnd.tsx` — kanban board with native HTML5
  drag-and-drop (`onDragStart` / `onDragOver` / `onDrop`), no external DnD
  library; `dataApi.updateRow` on drop with optimistic update + rollback.
- `docs/architecture.md` — one-page architecture overview with ASCII
  diagrams of the create + edit flows + working-dir layout.
- `plugins/model-apps/CONTRIBUTING.md` — how to add samples, rules, evals,
  scripts, fixtures; PR checklist; style guide.

### Changed — Spec tightening (drives green captures)
- `agents/genpage-planner.md`: new "Workflow-log requirements" section
  before Step 1 requires command-verbatim entries (`node --version`,
  `pac auth list`, `AskUserQuestion: <text> → <answer>`,
  `EnterPlanMode called`).
- `agents/genpage-page-builder.md`: promoted `pageInput` destructure to the
  first Mandatory Rule with explicit "even on mock-data pages" emphasis
  and forbidden form (`void props;`).
- `skills/genpage/SKILL.md` Phase 6: required template echoes the full
  `pac model genpage upload` command including `--prompt` and all flags.
- `skills/genpage/SKILL.md` Phase 8: structured per-phase log format
  replaces the prior "summarizing the run" template; lists the exact grep
  tokens the runner looks for.

### Fixed — Runner false positives (8 patterns)
These were surfaced by real captures and accept *functionally-equivalent*
alternatives only (no rule loosening):
- `[^]*?` lazy-quantifier regex tightened to `[\s\S]*?` (works reliably
  with trailing anchors in Node)
- Forbidden-pattern checks now strip JS/TS comments before matching so
  rule-documentation comments don't trip the regex
- `pac auth list` active-env detection accepts any Dataverse env URL near
  the auth-list output (real captures don't put the literal word
  "environment" before the URL)
- New-or-edit question detection accepts implicit-new flag via plan's
  `## Pages` section
- `newAppNeeded` plan detection accepts `App: create new:` wording in the
  plan's `## Environment` section
- Solution enumeration accepts `pac solution list` as an alternative to
  `dataverse-request.js /solutions` (both functionally enumerate solutions)
- Multi-page parallel dispatch detection accepts singular "page-builder"
  alongside plural "page-builders"
- `Xrm.Navigation.navigateTo` detection accepts optional chaining and
  alias patterns (`xrm?.Navigation?.navigateTo` with `(window as any).Xrm`)
- `check-auth.js ok:true` detection accepts `ok=true` (equals form) in
  addition to `ok: true` and `"ok": true`
- Window cache detection accepts `(window as any).__cache` paren-cast and
  `window as any` typed-alias patterns
- Choice column display detection accepts local enum mapping with
  `100000000+` constants alongside `dataApi.getChoices()` and
  `FormattedValue` annotations

### Test coverage
- **200 tests passing** across `scripts/tests/` (97) + `evals/.../tests/`
  (103). Each runner has parameterized unit tests covering pass / fail /
  skip cases plus CLI integration tests.

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
