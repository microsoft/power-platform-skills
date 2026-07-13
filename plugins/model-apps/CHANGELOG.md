# Changelog

All notable changes to the **model-apps** plugin.

## [Unreleased] — 2.2.0

A new **`/app-builder`** skill (Preview) that builds and edits whole model-driven apps,
plus local-dev ergonomics, sample coverage, and an automated eval suite with
real and synthetic fixtures. Builds on v2.1; no breaking changes.

### Added
- **Opt-in auto sub-grids (`forms[].autoSubgrids: true`).** Adds a sub-grid to a parent form for every
  child relationship of its entity (each 1:N where it's the parent + each N:N) that isn't already in
  `subgrids[]`, so a hub table's form lists its children without hand-authoring each grid.
- **Parent lookups on the default views too (Gap 6).** 1:N lookups are now included in the built-in
  Active/Inactive default view column set (not just the form + authored views), so the "which parent?"
  column shows in the grid. Teardown resets those un-deletable default views to a lookup-free set
  before deleting the relationship, so cleanup stays 0-leftover (live-verified).
- **Forms & views update in place on edit (`sdk-build.js`).** Re-running the build against a deployed
  app now **reconciles** an existing form (re-applies the spec's fields + sub-grids via the SDK's
  idempotent `addField`/`addSubGrid`, then push + publish) and an existing view (unions its columns
  with the spec's), instead of reusing the artifact unchanged. Editing a deployed form/view layout
  finally lands — the documented "create and edit share one path" now holds for forms and views, not
  just pages. (Chart *definition* edits still aren't applied on rebuild — an existing chart is skipped
  with a visible reason rather than silently reported as rebuilt.)
- **The app shows your form, not the blank stock form (`sdk-build.js`).** After building a table's main
  form, the build marks it the entity **default** (`isdefault`) and deactivates the auto-created blank
  "Information" form (custom tables only) — so a freshly built app opens your authored layout. Teardown
  reverses this (re-activates + re-defaults a stock form) before deleting, so cleanup stays at 0 leftovers.
- **Auto-layout + authored views surface parent lookups** — a 1:N lookup (which lives on
  `relationships[]`, not `columns[]`) is now placed on the child's form auto-layout and honored in
  authored `views[].columns`, so the "which parent?" link is visible without hand-authoring an explicit
  `tabs` layout.
- **`check-auth.js` accepts `--env` and no longer false-blocks on PAC** — the build authenticates with the
  az token, so a missing pac login is a warning (genpage opts back in with `--require-pac`); the env URL
  is read from `--env <url>` or a positional arg (fixing the `envUrl: "--env"` parse bug).

### Fixed
- **Entity subarea `vectorIcon` no longer breaks the app designer (`sdk-build.js` / `spec-lint.js`).**
  A `vectorIcon` (Fluent token) on an **entity** sitemap subarea was written verbatim into the sitemap
  `VectorIcon` attribute, which the modern app designer can't resolve — the property pane failed to
  load for those subareas and the nav showed a fallback icon. An entity's nav icon comes from the
  **table** icon (`entities[].vectorIcon` → `IconVectorName`), so the build now **drops** `vectorIcon`
  from entity subareas (keeping it on `url`/`page`/`dashboard` subareas, where an SVG path/`$webresource`
  is valid). Lint now warns that an entity-subarea `vectorIcon` is ignored (set the table icon instead)
  and that a non-entity subarea/area `vectorIcon` must be an SVG path or `$webresource:` — not a bare
  token. Live-verified: the deployed sitemap emits no invalid `VectorIcon`.
- **Sub-grids are no longer built with an empty target entity (`sdk-build.js`).** Sub-grid options were
  passed with `entity` but the SDK reads `targetEntity`, so every generated sub-grid shipped an empty
  `<TargetEntityType/>`. Dataverse tolerated it on create (POST) but rejected it on edit (PATCH) with
  "Expected non-empty string", and the rendered grid had no target. Now passed as `targetEntity`.

### Added (previously)
- **Table icons** (`entities[].vectorIcon` / `entities[].icon`) — set a custom table's **own** icon
  (what the modern app designer and app nav render for the table) to a **declared web resource**:
  `vectorIcon` → an **SVG** web resource (Dataverse `IconVectorName`, the modern look), `icon` → a
  raster PNG/JPG/GIF/ICO web resource (`IconMediumName`). Applied after the web-resources phase (so
  the image exists + is published first) via the new SDK `setEntityIcon`. **Hard-validated** against
  declared web resources: an unresolvable table icon is exactly what leaves the designer's property
  pane stuck on a glimmer, so the spec now rejects a `vectorIcon` that isn't a real SVG web resource
  (e.g. a Fluent icon token). Table icons are a table property, so teardown removes them with the
  table it created and leaves reused/system tables untouched.
- **`/app-builder` skill (Preview)** — natural-language intent → deployed model-driven app:
  tables/columns/relationships, adaptive forms + sub-grids, views (with enriched default columns),
  Choice-column charts, modern command bars, dashboards, sitemap icons, genpage-first pages, and
  sample data. Deterministic **idempotent** build via the vendored headless `cds-maker-sdk`;
  interactive authoring + `spec-lint` guardrail + plan-mode gate. Create and edit share one path
  (`download-model-app.js` → editable spec); read-only `verify-model-app.js`; classifier-safe
  `teardown-model-app.js`. See `SKILL.md` + `references/app-spec-schema.md`.
- **AI-first features** (`ai` block → `ai-features` phase) — form-fill, NL search, NL charts, M365
  Copilot, and per-table Copilot row summaries with tailored prompts. **Admin-gated** (preflighted
  via `RetrieveSetting`, skips/warns when off, never fails); NL search is environment-gated
  (`EnableNLGridSearch`), not per-app. Standalone reporter `scripts/ai-preflight.js`; helpers
  `lib/ai-candidates.js` + `lib/ai-prompt.js`. Teardown removes the AI records it created.
- **SDK consolidation** — `cds-maker-sdk` now owns the Dataverse mechanics: AI settings/row-summaries,
  `seedRecordGraph` (record-graph seeding: `@odata.bind` parent binds + resolve-by-name idempotency),
  `enrichDefaultViews`, and artifact resolve/find/cascade. Both skills provision through the shared
  `scripts/lib/entity-provision.js` core; the plugin keeps App-Spec judgment.
- **genpage eval suite** — Layer 1/2 TAP runners + `EVAL_GUIDE.md`, 10 fixtures (6 synthetic + 4 real),
  `capture-fixture.js`; local-dev manifest (`package.json` + `genpage.d.ts`) in working dirs; new
  dialog/overlay samples (11, 12) + Dialogs-and-Overlays guidance.

### Removed
- **Consolidated the standalone entity/solution scripts into the SDK.** `create-table.js`,
  `add-column.js`, `create-relationship.js`, `create-record.js`, `create-solution.js`, and
  `add-to-solution.js` (added in 2.1.0) are removed — both `/genpage` and `/app-builder` now
  provision Dataverse through the shared SDK-backed `scripts/lib/entity-provision.js` core (via
  `provision-entities.js` / the build engine), eliminating duplicate metadata logic.

### Changed
- **Re-vendored `cds-maker-sdk` with shared input safety boundaries.** The bundled SDK now
  normalizes GUID-typed ids to lowercase-canonical form (rejecting OData-expression-shaped ids
  before they can reach a `$filter`/`@odata.bind`), routes every OData query through a builder that
  **single-encodes** each option value, and constructs sitemap XML via a factory that validates
  element/attribute **names** while XML-escaping free-text **values**. This is transparent to the
  skill: raw `$filter` strings still round-trip (single-encoded, never double-encoded), name-based
  methods (`resolveArtifact`/`setEntityIcon`/`createRelationship`/`deleteTable`) still accept
  logical/unique/schema names verbatim, and special characters in sitemap titles/URLs still
  serialize instead of throwing. The vendored-SDK `CONTRACT:` regression tests lock all three, so a
  future re-vendor that breaks an invariant fails here.
- Spec tightening so workflow-logs are command-verbatim and `pageInput`
  destructure is required even on mock pages (planner, page-builder,
  SKILL.md Phase 6 + Phase 8).
- 8 runner regex relaxations to accept functionally-equivalent agent
  patterns (typed `(window as any).Xrm` aliases, `pac solution list`,
  local enum mapping, etc.) — no rule loosening.

### Fixed
- **Teardown no longer leaks a table's icon web resource or the generated app icon
  (`sdk-teardown.js`).** Two "0-leftover" gaps found by a full live build→teardown probe:
  - A table's **vector/raster icon web resource** is referenced by the table, so deleting web
    resources *before* tables failed with Dataverse *"referenced by 1 other components"*. Web
    resources are now torn down **after** tables (form JS, referenced by its already-deleted form,
    is unaffected).
  - The build's **generated default app icon** (`<appUnique>_icon`, created in-solution when the
    spec sets no `app.icon`) was never deleted — deleting the solution drops the container, not the
    underlying webresource row — so it orphaned. Teardown now removes it (skipped when `app.icon`
    is an explicit, already-declared web resource).
- **Teardown surfaces cascade cleanup failures instead of silently orphaning rows
  (`sdk-teardown.js`).** The re-vendored SDK's `deleteAppCascade` now returns a structured
  `{ success, deleted, failures }` result (it used to return void and swallow child-cleanup
  errors). The app teardown step now reads `failures`: if the app module is deleted but a cascaded
  sitemap/generative-page row cleanup genuinely fails, the run reports `ok=false` and names the
  orphaned rows rather than claiming a clean delete. An already-gone (not-found) child is still
  tolerated, and a void/clean result is unchanged — so best-effort teardown keeps going.
- **Exported solutions are now self-contained — app icon + sitemap no longer missing
  (`sdk-build.js` app-shell phase; vendored `cds-maker-sdk` `AppApi`).** Two import blockers when
  moving an app to a new environment:
  - The app tile **icon** pointed at an arbitrary **managed/external** web resource the SDK
    auto-picked (e.g. a Field-Service `msdyn_` icon, or a *FormsPro* icon) that isn't in the
    solution → import failed. The build now uses a **self-contained icon in the solution**: a new
    optional `app.icon` (a declared image web resource), or a generated default SVG added to the
    solution. Its id is set at create time (an appmodule's `webresourceid` is effectively
    write-once). The SDK's `resolveAppIcon` fallback is also hardened to only ever pick an
    **unmanaged** web resource.
  - The app's **sitemap** was only in the Default solution (adding the app module doesn't pull it
    in), so export prompted *"missing required unmanaged components: SiteMap"*. The build now adds
    the sitemap (componenttype 62) to the app's solution explicitly.
- **Relationships to a standard/system table no longer halt the build with an invalid
  schema name (`app-spec.js` / `spec-lint.js`).** The relationship schema name defaulted to
  `<referenced>_<referencing>`, which only starts with the publisher prefix when the *referenced*
  table is custom. A 1:N to a **system table** (e.g. `systemuser` — a common "bridge to a real
  user/owner" pattern) produced an unprefixed name like `systemuser_contoso_teammember` that
  Dataverse rejects (`schema name … is invalid … must start with a valid customization prefix`),
  hard-halting the data-model phase at `--apply` time on a lint-clean, dry-run-clean spec. The
  default now **auto-prepends the publisher prefix** (→ `contoso_systemuser_teammember`) for both
  1:N and N:N, so authoring a relationship to a system table just works. `spec-lint` also now
  **errors** on an explicit `schemaName` that lacks the prefix, turning a build-time 400 into an
  authoring-time message. (All-custom relationships are unchanged — backward compatible.)
- **Teardown only deletes tables this build created — never reused/system
  tables (`sdk-teardown.js`).** Declaring an existing CDS table (e.g. a system
  table like `account`/`contact`) for the nav made teardown *try* to delete it,
  surfacing a noisy `Only Custom Entities can be deleted` error. The table step
  now resolves the table first: a **non-custom/system table is skipped** (never
  created by a build, never deletable), and a **reused custom table flagged
  `"existing": true`** in the spec is skipped too. Both are recorded as skips
  with a reason, so a reused table's data survives cleanup.
- **System/standard tables (account, contact, …) keep their default sitemap
  icon (vendored `cds-maker-sdk` `AppAdapter`).** An entity subarea authored
  without an explicit `icon` was serialized with the SDK's transparent-spacer
  placeholder (`Icon="/_imgs/imagestrips/transparent_spacer.gif"`). Because an
  explicit `Icon` attribute **overrides the table's default nav glyph** in a
  model-driven app, adding an existing CDS table to the nav blanked its icon
  (had to be re-set by hand in the app designer). The adapter now **strips the
  placeholder on write** (symmetric with the existing read-side filter), so an
  iconless subarea emits **no** `Icon` and Dataverse falls back to the table's
  own icon. Re-running an edit also cleans a previously-persisted placeholder.
- **Editing an existing app now updates the sitemap for *page-less* apps too
  (`sdk-build.js` app-shell phase).** The app module's sitemap/components were
  effectively **write-once** — only the generative-pages finalizer rewrote them,
  so re-running the build to add/rename/reorder entity, dashboard, or URL
  subareas on an app **without** a generative page was a silent no-op (the build
  printed `✓ app "…"` but the nav never changed; only `verify` surfaced the gap).
  The app-shell phase now **re-syncs any existing app**: fetch → recompute
  sitemap + components from the spec → push → publish, so subarea edits land
  idempotently regardless of whether the app has pages, and `--only app-shell`
  can force the rewrite. The fetch also **hydrates the app into the session
  workspace**, fixing the cross-session `Artifact app/<id> not found in
  workspace` halt on push/publish.
- **Classic DashBoard sitemap subareas now round-trip through download/edit
  (`download-model-app.js` / `hydrate-spec.js`).** Previously `download` dropped
  them (a rebuild lost the dashboard from the app nav). The dashboard is now
  reconstructed into `dashboards[]` with **id-passthrough tiles** (each tile
  carries the deployed view/chart ids), so a rebuild recreates it against the
  existing views/charts without re-declaring them.
- **Dashboard tiles render in a 2-column grid** instead of one stacked
  full-width column (charts were oversized). SDK `DashboardAdapter`.
- **AI row summaries errored on every record (`ai-prompt.js`):** the
  `GptDynamicPrompt` data filter used the entity's primary **name** column
  (`primaryAttribute`, e.g. `new_name`) as the record key, so it filtered
  `new_name eq <record-GUID>` — which matches no rows and the Copilot summary
  card shows an error. Now uses the entity's primary **key** (`<entity>id`).
  Live-verified: removed + rebuilt the row summaries on the test app.
- **PR review round 2–3 (app-builder):** sitemap `verify` checks are now
  element-scoped (`<Area>`/`<SubArea>`) and a dashboard subarea is verified by
  resolving the dashboard id (systemform type 0) and matching the sitemap's
  `DefaultDashboard` — no more false passes from a value reused elsewhere.
  `genpage-cli` spawns `pac` directly with an args array on POSIX (Windows keeps
  cmd-quoting) so quotes in prompts round-trip. `ai-preflight` initializes a temp
  workspace. `run-tests` treats a missing SDK-suite prerequisite as a true SKIP
  (not a failure). `provision-input` accepts underscores in the schemaName suffix
  (`new_ticket_tag`) and dropped a dead variable. `sdk-http-client` backoff
  comment corrected. Teardown now tolerates an already-gone relationship
  (Dataverse 400 *"…but 0 were found"*) as deleted, matching the table not-found case.
- **Synthetic fixtures + sample 11 now follow Rule 11 (queryTable returns
  DataTable, not an array).** 7 files were iterating `result` directly
  (`setTasks(result)`, `result.map(...)`) instead of `result.rows`,
  producing `X.map is not a function` at runtime. Fixed in
  `samples/11-kanban-with-dnd.tsx` and 6 fixture `.tsx` files.
  New Layer 2 assertion catches this pattern going forward: any Dataverse
  file calling `dataApi.queryTable` must access `.rows` somewhere.

### Tests
- Full `scripts/tests/` suite (unit + golden snapshots + journal evals) plus the genpage eval suites
  and the vendored `cds-maker-sdk` Jest suite — all green. `node scripts/run-tests.js --with-sdk <ppux>`
  runs the plugin + SDK suites in one command.
- **Vendored-SDK contract invariants** (`vendor-sdk-smoke.test.js` — the `CONTRACT:` tests) lock the
  behaviors the skill depends on so a future SDK hardening (GUID normalizer, safe DOM element factory,
  percent-encoding OData query builder) can't silently break the skill on re-vendor: raw OData filters
  (quoted + unquoted GUID literals) round-trip without double-encoding; name-based methods
  (`deleteTable` / `setEntityIcon` / `resolveArtifact` / `createRelationship`) accept logical/unique
  names verbatim; sitemap free-text titles/URLs are XML-escaped, not rejected.

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
