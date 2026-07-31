# Changelog

All notable changes to the **model-apps** plugin.

## 2.3.0 — 2026-07-23

Plugin observability + authoring guardrails: default-on (but ship-disabled)
anonymous telemetry with a local diagnostic log, PostToolUse validators, and a
hardened Playwright launcher. No breaking changes.

### Added
- **Anonymous 1DS telemetry (default-on, ships `disabled` until provisioned).**
  Copied the shared telemetry library into `scripts/lib/telemetry/lib` with a
  plugin-owned `ikey.json` (Tier-1 static key; ships `disabled: true` until go-live).
  Emits `skill_started` via PreToolUse(Skill) + UserPromptSubmit hooks and writes
  a local diagnostic mirror at
  `~/.power-platform-skills/telemetry/model-apps/sessions/<id>/events.jsonl`. New
  `/model-apps:telemetry on|off|status` control skill; CI/automation opt-out via
  `POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT=1`. Fail-closed throughout —
  never changes a skill's exit code. Carries **no user-level identifier** (no Entra
  object id) — only org/tenant GUIDs when signed in.
- **PostToolUse validators (`hooks/hooks.json`).** A per-skill validator runner
  plus an `@fluentui/react-icons` allowlist check that validates every genpage
  `.tsx` write against `references/verified-icons.txt`, automating the
  page-builder's manual icon-grep step (hallucinated or sized icon names are
  blocked at write time).
- **PreToolUse write-safety guard.** **Flags (non-blocking, exit 1)**
  Write/Edit/MultiEdit outside the cwd, and only during an active genpage session
  (a `genpage-plan.md` at/under cwd) — so a globally-installed plugin never blocks
  or interferes with unrelated work. Silence with `MODEL_APPS_SKIP_WRITE_GUARD=1`.

### Fixed
- **Generated-page double-fetch / render flash on open.** Generated data pages
  could fetch twice and re-flash the spinner because (1) the webplayer host
  double-mounts the page on open (a cache-bypassing app relaunch ~300ms after
  the first mount re-runs the data effect — confirmed via network capture: two
  `POST .../powerapps/apps/<app>/launch`, the second `bypass-cache=true`), and
  (2) `dataApi` is a new reference each render, so listing it in a `useEffect`
  dep array re-fires the effect every render. Reworked the data-fetch guidance
  (`references/data-caching.md`, `rules.md` Rule 15) and every exemplar
  (samples 3/9/10/11, `localization.md`) to use an **in-flight-promise de-dupe +
  `window` cache** (concurrent mounts share one round-trip; later mounts paint
  from cache with no spinner) and a **readiness boolean** dependency —
  `dataApi` is now forbidden in any dependency array. The de-dupe applies to any
  page that fetches on mount, including single-visit overviews/dashboards
  (previously excluded from caching); `Needs caching:` in the plan schema now
  means "fetches on mount." The host relaunch itself is a platform-side issue
  tracked separately.
- **Playwright MCP launcher.** `scripts/launch-playwright-mcp.js` now exports
  `launch()` — satisfying the `.mcp.json` contract instead of relying on a
  require-time side-effect — adds `-y` (avoids the npx first-run prompt hang),
  opens the browser fullscreen via `playwright-mcp-fullscreen.config.json`, and
  quotes the config path so Windows paths with spaces work. Browser detection
  extracted to the reusable `scripts/lib/detect-browser.js`.
- Eval fixture `18-sharepoint-connectors-on`: relabel the connector-only page
  `Data mode: mock + connectors` to match the page-builder contract (connectors
  are orthogonal to the Dataverse axis).

### Tests
- New `node:test` coverage for the launcher, `modelapps-hook-utils`, the
  icon-import and write-safety validators, and the telemetry pretool hook.

## 2.2.0

Local-dev ergonomics, sample coverage, and an automated eval suite with
real and synthetic fixtures. Builds on v2.1; no breaking changes.

### Added
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
- **Feature-flag gate for connectors (default OFF).** `feature-flags.json` at the
  plugin root plus `scripts/lib/feature-flags.js` gate connector support so the
  skill can ship ahead of its cross-repo dependencies (pac connector verbs, the
  GenUX authoring control, and the maker/admin setting) reaching PROD. When OFF,
  the planner skips connector discovery and records `No connector bindings.`, and
  the connector scripts (`list-connections.js`, `create-connection-reference.js`)
  fail closed with exit 3. Precedence: env `GENPAGE_ENABLE_CONNECTORS` overrides
  the committed file; default is OFF (fail-closed). Flip the file to `true` once
  the dependencies are GA.
- **`genpage-connector-builder` agent — single owner of connector work.** Connector
  discovery, connection-reference creation, the feature gate, and the
  `## Connector Bindings` contract now live in one agent invoked from **both** the
  create flow (planner) and the edit flow (edit-planner) — so edits can add/replace
  connectors (previously only preserve/clear worked) and the gate can't drift across
  markdown. Hardened per review: deploy (SKILL Phase 4.5) **re-probes** the flag and
  treats an absent/malformed `## Connector Bindings` as no bindings; the page-builder
  emits connector code only for an actual binding table; the `--connection-refs`
  branch of `add-page-to-solution.js` is gated; scripts share `exitIfConnectorsDisabled()`;
  and `feature-flags.js` gains `--list`, `describe()`, and config validation.

### Changed
- GenPage create, edit, and navigation-fix uploads now send structured
  `Agent Thoughts` and `Summary` sections through `--agent-message` using
  PAC-safe escaped line breaks. A Layer 1 assertion rejects plain descriptions
  in any initial upload or re-upload. Agent Thoughts follow the OOB-style
  step-by-step implementation summary with bold numbered headings and bulleted
  Summary items; blank lines keep each numbered heading on its own rendered line
  while excluding private chain-of-thought.
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
- 215 passing across `scripts/tests/` + `evals/.../tests/`.

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
