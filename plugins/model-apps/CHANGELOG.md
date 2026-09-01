# Changelog

All notable changes to the **model-apps** plugin.

Entries are deliberately short: what changed and why it matters to you. The reasoning,
evidence and trade-offs behind a change live in its PR, in `docs/`, or in the linked issue.

## [Unreleased] — 2.5.1

SDK uptake. Adds per-form security roles and three column capabilities; **business rules now require
an environment that supports them**.

### Changed

- **Business rules are environment-gated.** The SDK writes a rule only through the bound
  `CreateProcessWithWfomJson` member; the workflow-XAML fallback was removed upstream because it
  silently narrowed a rule into something you did not write. An environment that does not declare
  that member **cannot host business rules at all** — the common case, not an edge case. Such rules
  are **skipped** with a warning; everything else builds normally, and `--verify` reports them as
  *not applicable on this environment* rather than failing the build.

### Added

- **`businessProcessFlows[]` — guided, staged processes on a table.** Author the stage bar users work
  through: ordered stages, each with steps bound to that table's columns. **Every step must bind a
  field** — the platform refuses one without (`datafieldname of ControlStep cannot be null or empty`),
  so bind a Boolean flag for a manual check-off. Deployed as a category-4 flow and activated on
  create, because an inactive flow is invisible rather than merely inert. A flow name must be unique
  across the whole spec (Dataverse derives the stored name from it, ignoring the table), every stage
  needs at least one step or the platform invents one for you, and the SDK's 30-stage / 30-step
  ceilings are enforced up front. Additive on rebuild, torn down with the app (including the backing
  table activation creates), and a new `business-process-flows` build phase (16 now). v1 is
  single-entity and linear — cross-entity stages, branching, stage actions and security-role grants
  ([#513]) are rejected rather than silently dropped, so a flow never deploys as something other than
  what you wrote. Unlike `businessRules[]`, a BPF goes through the SDK's generic artifact surface, so
  it is **not** subject to the bound-member environment gate above.
- **Per-form security roles** — `forms[].securityRoles`: offer a form to named `personas[]` or to
  `everyone`. A form with no assignment is visible to **every** role, so this *restricts* a form;
  undo with `everyone: true`, not by deleting the block. Takes effect after a publish. (AB#6648526)
- **Boolean `defaultValue`, whole-number `integerFormat`, and per-column `isValidForCreate` /
  `isValidForUpdate` / `isValidForRead`** — the last of these is how you make a column read-only.
  ([#495], AB#6648523, AB#6648522, AB#6651276)
- **Twelve more business-rule operators** and **multi-condition rules** (ANDed). Spelling matters:
  `IsGreaterThan`, not `GreaterThan` — the SDK resolves an unknown operator to `Equals`, so the spec
  rejects anything outside its table and suggests the right spelling.
- **A `description` on every artifact that accepts one.** Written at create time and omitted when
  absent, so a rebuild never blanks text typed in the maker.
- **Per-field form control** — `readOnly`, `hidden` and `after` (reposition), via a form-level
  `fieldOptions` map or inline on an explicit layout. `prune: false` edits a subset of a form without
  re-declaring every field, and only the enabled state is written, so a designer edit survives.
- **The AI form-fill family is controllable per capability** — assist toolbar, edit-form predictions,
  smart paste and file upload, instead of one flag that only governed the toolbar.

### Fixed

- **A `businessRules[]`-only edit is no longer treated as "nothing changed."** The spec diff that
  drives `--changed-only` had no entry for the business-rules phase, so an edit to a rule classified
  as a **no-op** and the run did nothing at all. Both it and the new business-process-flows phase now
  diff correctly and force a full build, recording the edit as debt because the additive engine does
  not reapply changes to a rule or flow that already exists.
- **Dashboards survive a download again** — the SDK could not deserialize a dashboard it had
  serialized, so no tiles were recovered and the download failed without `--allow-lossy-download`.
  ([#478])
- **Descriptions converge on existing views and charts** — previously written only at create, so the
  platform's auto-created *"Active &lt;Plural&gt;"* view never got one. ([#496])
- **Downloaded specs preserve deployed descriptions** where the artifact is reconstructed, and list
  the rest in a read-only inventory. ([#494])
- **Teardown removes the activated copy of a business rule**, which previously stranded an
  undeletable row. ([#493])
- **Existing columns honour an explicit `required` change on rebuild**; an omitted `required` still
  leaves the live column alone.
- **Big Integer columns are no longer placed on auto-generated forms** — Big Integer has no Unified
  Interface control, so the field rendered *"Error loading control"* on every record.
- **AI on/off is read with the platform's semantics** — `0` = platform default, `1` = disabled,
  `2` = enabled. Treating any non-zero value as "on" reported a disabled feature as enabled.
- **Presence operators** (`ContainsData` / `DoesNotContainData`) deploy; the compiler bug behind the
  `HTTP 500 — Error generating UiData` failures is gone with the compiler. ([#481])
- **The async-surface guard is AST-based** — a regex could not decide the remaining cases. ([#475])
- **`ai.summaries.default: "off"` no longer discards a per-table `enabled: true`**, and a
  differently-cased `tables[]` key keeps its `instruction` and `columns`.
- **A row summary an environment cannot license is skipped, not fatal** — and the AI model row the
  refused publish leaves behind is swept, so a rebuild does not then fail on a duplicate key.
- **A spec with no `appShell` reports what to add** instead of dying with
  `Cannot read properties of undefined (reading 'areas')` after the app was already half-created.
- **A malformed `businessRules` is a validation error**, not a raw `TypeError`; duplicate-cleanup
  warnings report the real failure instead of asserting a wedged platform row.
- **Column visualizations are cleared on teardown for a table the spec keeps** (`existing: true`).

[#475]: https://github.com/microsoft/power-platform-skills/issues/475
[#478]: https://github.com/microsoft/power-platform-skills/issues/478
[#481]: https://github.com/microsoft/power-platform-skills/issues/481
[#493]: https://github.com/microsoft/power-platform-skills/issues/493
[#494]: https://github.com/microsoft/power-platform-skills/issues/494
[#495]: https://github.com/microsoft/power-platform-skills/issues/495
[#496]: https://github.com/microsoft/power-platform-skills/issues/496
[#513]: https://github.com/microsoft/power-platform-skills/issues/513

## [2.5.0]

Takes up the current maker SDK, adds modern-shell and navigation controls, labels Dataverse
metadata in the organization's own language instead of a hardcoded 1033, makes persona roles
and jobs-to-be-done checkable, and fixes a class of failures that were silent.

### Added
- **`businessRules[]` — declarative form logic, no code.** Show/hide, lock/unlock, set-required and
  set-value, gated on a condition over the record; compiled to classic workflow XAML and activated on
  create. Every field is checked against the rule's own entity, because a rule naming a column that
  does not exist is accepted by the platform and then simply never fires. Operators `Equals` ·
  `DoesNotEqual`. Additive on rebuild, torn down with the app, and a new `business-rules` build
  phase.
- **Custom grid rendering (preview) — `entities[].columns[].visualization`.** Render a column as a
  radial dial, line chart, heat map or star rating in every grid and view that shows it. Per-column,
  so it is declared once rather than per view. Where the platform has not provisioned the preview the
  build skips it and everything else still deploys.
- **`app.newLook` — opt into the modern ("new look") shell.** Writes the per-app
  `NewLookAlwaysOn` setting, so the result is deterministic rather than a per-user preference.
  Scoped to the app and solution so it travels on export/import. Best-effort: a tenant without
  the definition still gets a working app on the classic shell, with a warning.
- **`app.headerNavigationRefresh` — control the Wave 2 header and navigation refresh.** A
  **separate, independent** setting from `app.newLook`; enabling one does not enable the other.
  The platform default is **ON**, so this exists as much to turn the refresh off as on — `false`
  is written actively rather than treated as "do nothing".
- **Labels honour the authoring language everywhere**
  ([#447](https://github.com/microsoft/power-platform-skills/issues/447),
  [#455](https://github.com/microsoft/power-platform-skills/issues/455)). Tables, columns,
  choices, **form, dashboard and sitemap labels** all use one resolved LCID. Previously only the
  data-model phase respected it, so `--language-code 1031` produced German columns and English
  form labels. Precedence: `--language-code` / `--languageCode` → App Spec `languageCode` → the
  organization's base language → 1033. Omit it and behaviour is unchanged.
- **An unprovisioned `languageCode` stops the build before any label is written**
  ([#456](https://github.com/microsoft/power-platform-skills/issues/456)), naming the LCID you
  asked for and the ones the organization actually has. Dataverse otherwise fails *inconsistently*
  here — it accepts an unprovisioned LCID on tables and choices and rejects it on `DateTime` and
  `Memo` — so the build died phases away from the flag that caused it.
- **A hand-pinned `languageCode` survives download.** Download still never reads the LCID from
  Dataverse (that would make the spec non-portable), but a value you wrote is carried over.
- **`directEntry` on `pages[]`.** Every page is a sitemap subarea, so a **detail** page is
  reachable from navigation with no input. A page declaring `pageInput` must now say what happens
  then: `{ "behavior": "selector" }` (show a picker) or `{ "behavior": "emptyState" }`. Every key
  in `pageInput.data` must also be supplied by an incoming `navigatesTo[].data` edge.
- **`verify` proves what a persona security role GRANTS**, not just that the role exists — every
  declared `(entity, access)` is resolved to its Dataverse privilege and checked at **at least**
  the declared depth. A subset check by design; fails closed on an unreadable role or table.
- **`personas[].jobs[].surfaces[]` is checked, not documentary.** `spec-lint` warns when a surface
  matches nothing in the spec, and `verify` reports a deployed failure as the job it broke
  ("persona P can no longer do job J") rather than only "view X is missing".
- **Automatic plugin update notice** — a non-blocking preflight tells you when a newer Model Apps
  version is available, with the update command for your host.

### Fixed
- **Command buttons now actually run.** A JS command was created with no on-click parameters, so the
  function was invoked with no arguments — the near-universal `function doThing(primaryControl)` shape
  threw on its first property access and the button silently did nothing. Nothing server-side showed
  it: the build, the deployed rows and `--verify` all looked correct, and the error appeared only in
  the browser console. Buttons now receive the standard parameters for their location
  (`MainTab` → PrimaryControl; grid/subgrid → SelectedControl), overridable via `parameters`.
- **Business rules no longer mistake the platform's activated copy for a duplicate.** Activating a
  rule makes Dataverse create a second `workflows` row (`type 2`, parented to the definition) — normal
  for any activated process. Build, verify and teardown queried without `type eq 1`, so the build
  tried to delete that copy (which the platform refuses, 405) and warned about a duplicate that did
  not exist, teardown failed on it, and verify would have reported every active rule as duplicated.
  All three now select definitions only.
- **AI preflight no longer reports a running feature as disabled.** The readiness gate and a
  feature's actual setting are different rows, so a gate reading off did not mean the feature was
  off — NL search and NL charts were reported as unavailable while both were in effect. Preflight now
  resolves the effective value (app override → environment → default), says which scope enabled it,
  and stops emitting an admin action for a feature that is already on.
- **Rebuilds no longer duplicate sub-grids or skip field removals.** The vendored SDK's artifact
  surface became **asynchronous** upstream (`getArtifact`, `addElement`, `updateElement`,
  `removeElement`, `moveElement`, `findElements`, `queryTree`). Un-awaited, that fails *silently*:
  a promise is truthy, so guards never fire and the form helpers see a promise instead of a form —
  producing duplicate sub-grids and quick-views, re-added fields, and field removals that never
  land, all behind `2xx` responses and a green build. All 40 call sites are fixed, and two nets now
  guard the class (a source scan, and test mocks that actually yield).
- **Dashboard chart tiles no longer fail the `dashboards` phase.** A tile emitted `ChartId`, which
  the platform's FormXML schema rejects; the correct name is `VisualizationId`. Found by a live
  build — the mock-based test had asserted the wrong name, so the suite agreed with the bug.
- **Publish failures are no longer silent.** The SDK moved `publishArtifact` from throwing to
  reporting by value and all nine call sites discarded the result, so a failed `PublishXml`
  produced `ok: true` with nothing logged — and the transient-retry path for 429 / 503 /
  customization-lock had become unreachable.
- **A partially-wrong push no longer reads as a clean success.** `PushResult.warnings[]` were
  dropped at all eleven sites — including the case where an app's system-administrator role
  assignment fails, which yields an app nobody can open.
- **A 412 version conflict could be swallowed.** The SDK renamed `PushResult.success` to `saved`;
  the guard still read `success === false` and simply stopped firing, dropping a concurrent Maker
  edit with no error. It now reads either spelling and fails closed.
- **A sitemap subarea targeting a custom web resource round-trips**
  ([#430](https://github.com/microsoft/power-platform-skills/issues/430)). `$webresource:<name>`
  was rejected by the URL guard, so the downloaded spec failed validation and **no spec file was
  written at all** — blocking the whole download → edit → rebuild flow over one nav entry.
- **Malformed specs produce validation errors instead of raw `TypeError`s**, and can no longer pass
  validation and then crash mid-build *after* the solution and data model were written. Errors name
  the exact path (`appShell.areas[0].groups must be an array`).
- **`verify-model-app` reports a missing table as a finding**, not a raw Dataverse HTTP 400, and
  prints the failure detail so a failed *read* is distinguishable from a genuinely absent artifact.
- **The live smoke eval asserted an outcome the builder never produces** — it used the one icon
  shape the builder deliberately drops, and the offline test hid it by hand-writing the XML it
  wanted to see.

### Known limitations
- **A classic dashboard does not survive `download-model-app.js`.** Build and teardown work, but the
  vendored SDK's `fetchArtifact('dashboard', …)` throws while deserializing the `<parameters>` block
  it itself serialized, so no tiles are recovered and the dashboard's sitemap subarea is dropped —
  failing the whole download unless `--allow-lossy-download` is passed. Live-verified, and reproduced
  on the previous bundle too, so it is **not** a regression from this release's SDK uptake. Download
  now names the cause instead of dropping the subarea silently. Tracked upstream.

### Changed
- **Business rules are authorable — the vendored SDK now compiles them to classic workflow XAML.**
  They were unauthorable because the supported bound member faults (`400 0x80040216`) on our tenants;
  the SDK now falls back to a plain `workflows` row carrying compiled WWF XAML. The fallback is
  narrow on purpose — only that code, or a `404` — so an ambiguous failure can never write the rule
  twice. Live-verified end to end, and pinned against the shipped bundle in
  `sdk-uptake-contract.test.js`. **The App Spec does not expose business rules yet;** this makes them
  possible, not authorable from a spec.

- **Column data visualizations for grids** (`getColumnVisualization` / `setColumnVisualization`)
  are available on the vendored SDK (preview). Not yet surfaced in the App Spec.

- **An app now requires an image icon.** `appmodule.webresourceid` is required, and the SDK's
  auto-resolve now demands an **image** web resource, failing with `APP_ICON_UNRESOLVED` when the
  environment has none — it previously fell back to any unmanaged web resource, including a
  **JavaScript** file, which the platform then rejected opaquely. No change for `/app-builder`: it
  always generates or resolves an icon and passes it explicitly.

- **Vendored SDK re-taken from its merged `master`, and it now records its provenance.**
  `scripts/vendor/PROVENANCE.json` carries the upstream SHA, build mode and the bundle's own
  sha256, and the bundler **refuses** a stale, dirty or unidentifiable source. "Built from master"
  is not provenance: the previously shipped bundle was built from a stale build output several
  commits behind its nominal source, and nothing in the repo could reveal it.
- **Three SDK contract changes are user-visible**: `deleteAppCascade` no longer deletes generative
  pages (they are *referenced* by an app, not owned by one, so they are reported in `retained[]`);
  unconditional artifact writes are refused (`ARTIFACT_UPDATE_NO_ETAG`); and `pushArtifact` /
  `publishArtifact` report failure by value instead of throwing.
- **`download-model-app.js --app` accepts a display name**, not just an id or `uniquename`, and
  fails closed when a display name matches more than one app.

### Tests
- ~1600 plugin tests + 159 eval tests; 94% line coverage.
- **The mocks no longer lie about the SDK contract.** Every mock returned plain values while the
  real SDK returns promises, so a missing `await` behaved identically under test — leaving ~1500
  tests structurally blind to the class above. They are now `async` *and* yield.
- **Rebuild idempotence is asserted.** Reconcile tests started from an *empty* deployed form, where
  "re-add everything" and "add only what's missing" produce identical call logs.
- **Concurrency stress against the real bundle**, and contract tests that pin the SDK's async
  surface, its serialized sitemap bytes, and the committed bundle against its provenance record.

## [2.4.2]

Fixes a malformed app module: generated apps did not actually contain their tables.

### Fixed
- **Generated apps contained an invalid `entity` table component instead of their real tables**
  (ADO 6612527), which also broke unrelated app-processing paths. The documented `@odata.type`
  shape returns 204 and then records a component pointing at the metadata table literally named
  `entity` (platform defect **AB#39140211**). Tables are now pinned by OData **reference** — the
  only form that can also express an abstract table such as `activitypointer`.
- **An unresolvable table halts the build, naming it.** One bad component fails the whole
  `AddAppComponents` call, so a silently-skipped table used to empty the app's component list.
- **App components are read back and verified after the write** — `AddAppComponents` returned 204
  for every corrupt app, and `ValidateApp` reported success too.

### Changed
- Re-vendored `cds-maker-sdk` with the above.

### Eval harness
- **A value-less or malformed runner flag is rejected** instead of silently changing scope — a bare
  `--tier` became "no tier filter", and the run then reported PASS for a scope nobody asked for.
  The parser is now shared at `evals/model-apps/lib/eval-args.js`.
- **A malformed fixture names the fixture**, tolerates a UTF-8 BOM, and rejects a non-object spec
  up front.

### Known limitations
- **Download still drops entity components not in the sitemap** (ADO 6603388) — the hidden
  component it describes could not be constructed live, so the download-side fix is unverified.

## 2.4.1

Bug fixes for apps built on **out-of-the-box** tables, and the matching SDK uptake. No change to
any skill's public surface.

### Fixed
- **AI app features had no effect on a newly built app** — an app-scope setting write is a no-op
  until the app is published, so the build wrote nothing while reporting success.
- **`--verify` passed when AI features were never applied** — it now proves an app-scope override
  row, because reading the setting back falls through to the environment value.
- **`ai.appFeatures` accepts non-boolean values** such as `2` ("on for everyone").
- **Download invented primary-name columns**, **replaced the solution's publisher prefix with
  `new`**, and **dropped tables with no sitemap entry** — all three now read from Dataverse.
- **Teardown could permanently burn an app's unique name** — an app is two rows with no server-side
  cascade, so deleting only the app module stranded the sitemap and reserved its name forever. Both
  rows are now deleted atomically in one OData `$batch`.

### Changed
- Re-vendored `cds-maker-sdk`. An injected `HttpClient` must now implement `postRaw` for the atomic
  `$batch`.

### Tests
- 1266 → 1340 tests; coverage 92.7 → 93.9% line.
- **model-apps now runs in CI** (ubuntu × windows × macos, Node 20 × 22, plus the offline evals) —
  previously every test workflow was scoped to another plugin, so this suite never ran on a PR.

## 2.4.0

A new **`/app-builder`** skill (Preview) that builds and edits whole model-driven apps, plus
local-dev ergonomics, sample coverage, and an automated eval suite. No breaking changes.

### Added
- **`/app-builder` (Preview)** — natural-language intent → deployed model-driven app: tables,
  columns, relationships, adaptive forms with sub-grids, views, charts, dashboards, generative
  pages, app + sitemap, and sample data, via the headless vendored `cds-maker-sdk`.
- **Jobs-to-be-done drive the design** — authoring starts by asking who uses the app and what each
  of them needs to get done, *before* the data model, and carries those jobs through to the
  surfaces that satisfy them.
- **Security roles per persona (`personas[]`)** — one role per persona, sized to the privileges its
  jobs declare, associated with the app so it opens for non-admins.
- **`model-app-plan.md`** — a readable, regenerable design document rendered from the spec, plus
  design-gap warnings at the lint gate (a job with no covering surface, an app with no pages).
- **Table icons are described before they are drawn** — each table proposes what its glyph will
  *depict* in plain language, shown for approval before any SVG is authored.
- **AI-first features** (`ai` block) — form fill, NL search, NL charts, M365 Copilot and row
  summaries, admin-gated by a preflight.
- **`--changed-only` partial apply (Preview, off by default)** — a page-only `.tsx` edit re-runs
  just the pages phase; anything else falls back to a full build.
- **`scripts/preview-app.js`** to review the whole design before building, and an offline eval
  suite for `/app-builder` alongside the genpage TAP runners.

### Changed
- **Edits are first-class**: forms and views update in place, a form edit can *remove* a field, a
  built main form becomes the entity default, and editing an existing app updates the sitemap for
  page-less apps too.
- **Identity is unambiguous** — forms resolve by `(entity, name, type)`, views by `entity|name`,
  and an app round-trips by its real `uniquename`, so a rebuild cannot duplicate or cross-wire.
- **Page generation reuses the `/genpage` worker** through a plan adapter, so an intent page can no
  longer silently fail to become `.tsx`; untrusted spec text cannot forge plan sections.
- Re-vendored `cds-maker-sdk` (pagination, quick create, idempotent global choice, authored column
  width, shared input-safety boundaries).

### Fixed
- **Teardown removes everything the app owns** — icon and app-icon web resources are removed, cascade
  failures are reported rather than silently orphaning rows, and reused/system tables are skipped
  with a reason. Command-bar teardown is fail-closed. The **publisher** is deliberately left behind:
  it can own other solutions, so removing it is not this app's decision.
- **Exported solutions are self-contained** — the app icon and sitemap are added to the solution.
- **The Dataverse token is never sent to another origin** — the HTTP client refuses any request
  outside the absolute `https` org URL.
- **A lossy download fails instead of reporting success** (`--allow-lossy-download` opts in), and
  **CLI flags fail loudly** — notably `--apply --only` with no phase list used to run a *full* apply.
- Assorted: relationships to system tables, classic dashboard round-trip, AI row summaries, and
  sub-grid `targetEntity`.

### Removed
- Standalone entity/solution scripts, consolidated into `provision-entities.js` and
  `provision-solution.js`.

### Known limitations
- **App EDIT does not re-pin a new chart** as an explicit app component — a chart added to an
  existing app needs a manual pin or a rebuild.

## 2.3.0 — 2026-07-23

Plugin observability and authoring guardrails. No breaking changes.

### Added
- **Anonymous 1DS telemetry** (default-on, ships `disabled` until provisioned) with a local
  diagnostic mirror, a `/model-apps:telemetry on|off|status` control skill, and a CI opt-out via
  `POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT=1`. Fail-closed throughout, and carries **no
  user-level identifier**.
- **PostToolUse validators**, including a `@fluentui/react-icons` allowlist check that blocks a
  hallucinated icon name at write time.
- **PreToolUse write-safety guard** — flags writes outside the cwd during an active genpage
  session only, so a globally-installed plugin never interferes with unrelated work.

### Fixed
- **Generated-page double-fetch / render flash on open.** The webplayer host double-mounts a page,
  and `dataApi` is a new reference each render, so a `useEffect` dep on it re-fires forever.
  Guidance and every exemplar now use an in-flight-promise de-dupe plus a window cache and a
  readiness boolean; `dataApi` is forbidden in any dependency array.
- **Playwright MCP launcher** — exports `launch()` per the `.mcp.json` contract, avoids the npx
  first-run prompt hang, and quotes config paths so Windows paths with spaces work.

## 2.2.0

Local-dev ergonomics, sample coverage, and an automated eval suite. No breaking changes.

### Added
- **Local-dev manifest** — working dirs get `package.json` and `genpage.d.ts`, so `npm install` and
  editor IntelliSense work after generation.
- **Eval suite** — TAP v13 runners for workflow and code assertions, 10 shipping fixtures, and
  `capture-fixture.js` to turn a real `/genpage` run into one.
- **Dialog and overlay guidance** plus samples — portalled Fluent surfaces are confined to the page
  so a modal cannot escape the preview and cover the designer.
- **Feature-flag gate for connectors (default OFF)**, with all connector work owned by a single
  `genpage-connector-builder` agent invoked from both the create and edit flows.

### Fixed
- **`queryTable` returns a `DataTable`, not an array** — 7 samples and fixtures iterated the result
  directly, producing `X.map is not a function` at runtime. A new assertion catches it going forward.

## 2.1.0 — 2026-05-13

Replaces the Dataverse MCP server + Python SDK fallback with Node.js Web API scripts. Adds solution
selection, prefix discipline, and a consolidated auth pre-flight.

### Breaking
- **Azure CLI (`az`) is now required** for entity creation, with access to the target environment.
- **The Dataverse Skills plugin is no longer required.**

### Added
- Node.js Web API scripts under `scripts/` (auth, request, table/column/relationship/record
  creation with `$batch` bulk, solution management).
- Solution selection with prefix-conflict warnings, and a transactional creation log.

### Fixed
- **Prefix drift is structurally impossible** — the plan stores logical-name suffixes only, and the
  full name is constructed from one source of truth.
- **`pac model create` always passes `--solution`** — the CLI's "active solution" fallback errors
  in practice.

### Performance
- ~27K tokens saved per page-builder run (icon list is no longer loaded upfront; reference docs and
  the opt-in browser-verification flow were extracted or trimmed).

### Added (samples)
- Dashboard with D3 charts, a list page using the window-cache pattern, and its paired detail page
  demonstrating `pageInput` and the formatted-value lookup.

### Migration from 2.0
1. `az login` (use the same identity as `pac auth who`).
2. Uninstall the Dataverse Skills plugin if it was only for `/genpage`.
3. No code or page changes needed; existing pages keep working.

---

## 2.0.0 — 2026-05-12

Major refactor of `/genpage` into an agent-orchestrated architecture.

### Breaking
- **PAC CLI ≥ 2.7.0** required.
- Skill output now lives in a per-invocation working directory.
- Plan-mode approval is mandatory; no skip or auto-accept.

### Added
- Four specialist agents (planner, entity-builder, page-builder, edit-planner).
- Multi-page parallel generation with cross-page navigation via `PAGEREF_<filename>` placeholders.
- A plan schema contract, a verified Fluent icon list, and a 16-eval suite across three tiers.

### Migration from 1.x
1. `dotnet tool update --global Microsoft.PowerApps.CLI.Tool` (to ≥ 2.7.0).
2. Existing deployed pages keep working — only the local workflow and layout changed.

---

## 1.0.6 — earlier in 2026

PageInput support, FluentProvider flicker fix, lookup `$select` rule, data caching pattern. See git
history for details.
