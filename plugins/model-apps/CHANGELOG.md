# Changelog

All notable changes to the **model-apps** plugin.

## [Unreleased] — 2.4.4

Adds plugin update notices, proves what persona roles actually grant, makes
jobs-to-be-done surfaces checkable, fixes four crash paths, and corrects a
smoke-eval assertion that could never pass live.

### Added
- **The data-model phase now labels everything in the organization's own language
  instead of a hardcoded `1033`.** `createColumn` in the SDK falls back to LCID
  1033 when the caller supplies none, and `columnOptions()` never supplied one —
  so in an organization that does not have 1033 provisioned, Dataverse rejected
  the label and `data-model` halted with
  `The language code 1033 is not a valid language for this organization`
  ([#447](https://github.com/microsoft/power-platform-skills/issues/447)). The
  build now resolves `organization.languagecode` **once per run** and threads it
  into every label-emitting call — tables, columns, customer columns, global
  choices, status reasons, alternate keys and relationships. Precedence is
  `--language-code` / `--languageCode` → App Spec `languageCode` → the
  organization's base language → 1033.

  The failure was confusing to diagnose because it was **not** all-or-nothing:
  Dataverse silently accepts an unprovisioned LCID on `EntityMetadata` and on
  `PicklistAttributeMetadata` (so the table and its Choice columns were created,
  with labels coming back in the org language) but hard-rejects it on
  `DateTimeAttributeMetadata` and `MemoAttributeMetadata` — so a build showed
  several green steps before failing and read like an environment problem.

  Every fallback to 1033 now emits a warning naming the reason and the
  `--language-code` escape hatch; previously only a thrown read was reported, and
  an empty result or a null `languagecode` degraded to 1033 in silence.

- **`languageCode` (App Spec, optional) and `--language-code` / `--languageCode`
  (CLI).** Overrides the organization's base language for a build. Validated as a
  positive integer LCID at all three entry points through one shared normalizer,
  so a JSON `true` (which `Number()` coerces to the invalid LCID `1`) is rejected
  up front rather than failing deep in the data-model phase. `provision-entities.js`
  (the genpage create flow's data-model path) accepts the same flag and an
  `input.languageCode`, and reports language fallbacks on the same channel — it
  shares the resolver, so both paths behave identically.

- **`verify` now proves what a persona security role GRANTS, not just that it
  exists.** The `role` check only asserted a role row carrying the SDK ownership
  marker, so a role built with the wrong access — or one whose privilege write
  failed after the row landed — verified clean. The new `role-privileges` check
  resolves every declared `(entity, access)` to its Dataverse `PrivilegeId` from
  the same metadata source the SDK writes against, and asserts the role holds it
  at **at least** the declared depth. A **subset** check by design: extra
  privileges are never a finding, because `appAccess` injects `appmodule` read,
  unioned jobs escalate a shared entity+access to the max declared scope, and
  distinct entities can share one Dataverse privilege. Fails **closed** on an
  unreadable role or table. Reader-gated, so existence-only callers are unchanged.
- **`personas[].jobs[].surfaces[]` is checked instead of documentary.** Each entry
  is now resolved against the spec's own views, forms, pages, dashboards, tables
  and sitemap titles. `spec-lint` **warns** when a surface matches nothing — a
  warning, not an error, because a surface may legitimately name an out-of-the-box
  artifact this spec never authors. `verify` adds a `job-surface` rollup that
  reports a deployed failure as the job it broke ("persona P can no longer do job
  J"), rather than only "view X is missing".
- **Automatic plugin update notice.** Every user-invocable skill now runs the
  non-blocking `scripts/check-version.js` preflight, which compares the installed
  Model Apps version with `origin/main` and shows update commands for the active
  GitHub Copilot CLI or Claude Code host when a newer version is available.

### Fixed
- **Malformed specs now produce validation errors instead of raw `TypeError`s.** `validateAppSpec()`
  and `lintAppSpec()` crashed on a `null` spec, an object- or string-shaped collection
  (`entities: {}`), and `null` entries inside a collection; `preview-app` crashed when a persona
  privilege's `access` was a scalar rather than an array. These are work-in-progress shapes an author
  hits constantly, and a crash killed the authoring flow instead of reporting the problem. Coverage
  is now a single recursive descriptor shared by both gates (`lib/spec-shape.js`), reaching nested
  collections too — `entities[].columns`, `views[].filters`, `forms[].tabs[].sections`,
  `pages[].dataSources`, `commands[].buttons[].children`, and the `appShell.areas → groups →
  subAreas` chain — and errors name the exact path (`appShell.areas[0].groups must be an array`).
- **A malformed collection can no longer pass validation and then crash mid-build.** Validation
  inspects a normalized copy while the caller keeps the original, so a silently-repaired
  `appShell.areas: [null]` reported PASS and then threw inside the build — *after* the solution and
  data model had been written to Dataverse. A null entry is now a blocking error, so the failure
  happens at the gate with nothing deployed.
- **`migrateAppSpec` no longer crashes ahead of the gate.** Every CLI entry point migrates the spec
  it just read *before* validating it, so a malformed collection threw a raw `TypeError` before the
  validator that exists to report it ever ran. Migration is now defensive but does **not** repair —
  repairing would hand the gate a clean spec and the real problem would vanish.
- **`verify-model-app` no longer surfaces a raw Dataverse HTTP 400 for a missing table.** A declared
  table that does not exist makes the saved-view query 400 (`returnedtypecode` names an unknown
  entity); the read error is now captured and reported as a structured missing-artifact finding.
  Both the verify CLI and the build's verify step now print the failure `detail`, so a read that
  failed (throttling, auth expiry, a 5xx) is distinguishable from an artifact that is genuinely
  absent instead of both rendering as a bare `✗ view: <name>`.
- **The live smoke eval asserted an outcome the builder never produces.** Its spec put a bare Fluent
  `vectorIcon` ("Grid") on an *entity* subarea — the one shape the builder deliberately drops,
  because it breaks the modern app-designer property pane — while asserting the deployed sitemap
  contained `VectorIcon="Grid"`. The offline test hid it by hand-writing the sitemap XML it wanted to
  see. The spec now uses an emittable `/WebResources/<name>.svg` reference and keeps the bare token
  as a negative control; assertions are scoped to the `<SubArea>` that declared the icon (the spec
  reuses one icon on the parent `<Area>`, which a document-wide scan let satisfy every subarea check)
  and their expected values stay independent of the builder, so a builder that stops emitting the
  icon makes the eval FAIL rather than silently invert into an absence check.

### Changed
- **`download-model-app.js --app` now accepts a display name**, not just an id or `uniquename`. It
  resolves in identity order (id → `uniquename` → display name) and **fails closed** when a display
  name matches more than one app, listing the candidate unique names instead of guessing. A display
  name previously hit a dead-end "app 'x' not found", even though that is the only name the maker
  portal shows.

### Tests
- A contract test drives the **real vendored SDK** and asserts the serialized sitemap bytes: a
  platform-ref `VectorIcon` reaches the XML on an Entity subarea, and the bundle does **not** filter a
  bare Fluent token — pinning that `appDef` is the only guard, so the drop cannot be delegated to the
  SDK.

## [2.4.2]

Fixes a malformed app module: generated apps did not actually contain their tables.

### Fixed
- **Generated apps contained invalid `entity` table components instead of their real tables**
  (ADO 6612527). An exported app read `<AppModuleComponent type="1" schemaName="entity" />` where it
  should have listed `account`, `contact`, `activitypointer` — and the malformed app then broke
  unrelated app-processing and metadata-discovery paths. Tables are now pinned by OData **reference**
  (`{ '@odata.id': '<EntitySetName>(<MetadataId>)' }`) instead of as an `@odata.type` instance:
  `Microsoft.Dynamics.CRM.entity` names a real Dataverse table (metadata-as-data), so the old payload
  pinned the `entity` table exactly as asked. The reference form is also the only one that can express
  an abstract EDM table such as `activitypointer`.
- **A table that cannot be resolved now halts the build, naming it.** One bad component fails the
  whole `AddAppComponents` call, so a silently-skipped table previously emptied the app's component
  list rather than degrading it.
- **App components are read back and verified after the write.** `AddAppComponents` returned 204 for
  every corrupt app — a 2xx means the request was accepted, not which rows it wrote — and
  `ValidateApp` reported success too. The build now asserts every declared table has a
  `componenttype: 1` row carrying that table's MetadataId, and fails closed if it cannot check.

### Changed
- **Re-vendored `cds-maker-sdk`** with the above.

### Tests
- `app-entity-components-real-bundle.test.js` drives the shipped bundle: tables sent as references,
  an unresolvable table refused, the read-back catching both a missing component and the exact
  6612527 corruption (rows present but pointing at `entity`). 6 of its 7 tests fail against the
  previous bundle.

### Known limitations
- **ADO 6603388 (download drops entity components not in the sitemap) is still open.** A live attempt
  to construct the hidden component it describes did not succeed — pinning a table with no sitemap
  entry returned 204 but wrote no row, before or after publish — so the download-side change cannot
  be verified end to end yet.

### Eval harness
- **A value-less or malformed runner flag is now rejected instead of silently changing scope.**
  `argv[++i]` is `undefined` for a trailing flag and `undefined` is falsy, so `--tier` alone became
  "no tier filter" and `--fixtures` alone fell back to the built-in fixtures — the run then reported
  PASS for a scope the caller never asked for. `--eval 1.5` was truncated to fixture `1` and graded
  the wrong one; an unknown `--tier` produced "no fixtures matched the filter", blaming the fixtures
  rather than the argument. All three runners (app-builder + genpage layers 1/2) shipped a
  byte-identical copy of this parser, so it is now shared at `evals/model-apps/lib/eval-args.js`.
- **A malformed fixture names the fixture.** A bare `JSON.parse` reported only a character offset,
  which tells an operator running a corpus nothing about which fixture to fix. A UTF-8 BOM (the
  Windows editor default) no longer fails an otherwise-valid file, and a spec that is `null`, an
  array, a string or a number is rejected up front instead of surfacing later as an opaque
  stage-facts error.

## 2.4.1

Bug fixes for apps built on **out-of-the-box** tables, and the matching `cds-maker-sdk` uptake.
No change to any skill's public surface.

### Fixed
- **AI app features had no effect on a newly built app** — an app-scope setting write is a no-op
  until the app is published, so the build wrote nothing while reporting success. The write is now
  re-issued after publish.
- **`--verify` PASSed when AI features were skipped or never applied** — it now proves an app-scope
  override row in `appsettings`. Reading the setting back is unsound: `RetrieveSetting` falls back
  to the environment value when an app has no override.
- **`ai.appFeatures` could not express non-boolean values** such as `2` ("on for everyone") — a
  value may now be a boolean or an integer `0..1000000`.
- **Download invented primary-name columns** (`account_name`, `contact_name` — neither exists) —
  now read from Dataverse metadata, never synthesized. Because a spec *requires* `primaryAttribute`,
  a table whose metadata does not supply one can no longer be emitted: a table reached from the app's
  **navigation** now **fails** the download naming it (`--allow-lossy-download` drops it instead),
  while a table found only as a hidden component is dropped with a warning.
- **Download replaced the solution's publisher prefix with `new`** — now read from the solution's
  owning publisher.
- **Download dropped tables with no sitemap entry** — the entity set is now the sitemap set unioned
  with tables owned by the app's view/chart/form components.
- **Teardown could permanently burn an app's unique name** — an app is two rows (`appmodule` +
  `sitemaps`) with no server-side cascade, so deleting only the app module stranded the sitemap and
  reserved its name forever. Both rows are now deleted atomically in one OData `$batch`, and any
  delete that cannot be proven refuses rather than guessing.
- **An unreadable app produced a raw SDK throw** instead of the download's documented
  `{ ok: false, error }`.

### Changed
- **Re-vendored `cds-maker-sdk`.** An injected `HttpClient` must now implement `postRaw` (verbatim
  multipart body out, raw response string back) for the atomic `$batch`; without it app deletion
  fails with `APP_DELETE_NOT_ATOMIC`. The plugin's client implements it and does not retry a
  `$batch` — it carries record deletes, and a racing retry wedges the row.

### Tests
- 1266 → 1340 tests; coverage 92.7 → 93.9% line, 82.7 → 83.6% branch.
- **model-apps now runs in CI** (`model-apps-script-tests`, ubuntu × windows × macos, Node 20 × 22,
  plus the offline evals) — previously every test workflow was scoped to `plugins/power-pages/**`,
  so this suite never ran on a PR.
- Real-bundle suites (`ai-app-features-real-bundle`, `app-delete-real-bundle`) drive the shipped
  vendored bundle, including one test that wires the real HTTP transport to it — the SDK's own Jest
  suite cannot run here (Node-20-ABI `canvas`).

### Known limitations
- **Table (`entity`) app components cannot be pinned via `AddAppComponents`** — the documented shape
  returns 204 but records a component pointing at the metadata table named `entity`. Platform defect
  **AB#39140211**; until it is fixed a table with no sitemap entry cannot be added to an app.

## 2.4.0

A new **`/app-builder`** skill (Preview) that builds and edits whole model-driven apps,
plus local-dev ergonomics, sample coverage, and an automated eval suite. Builds on v2.3;
no breaking changes.

### Added
- **Table icons are described before they are drawn** — each custom table proposes what its glyph
  will **depict** in plain language (`entities[].iconDescription`, e.g. "an outlined clipboard with
  a checkmark"), shown in `model-app-plan.md` for approval before any SVG is authored. A Fluent
  token name is rejected: the SVG is drawn fresh, so a token the user has never seen describes
  nothing. Also valid on sitemap areas, groups and non-entity subareas.
- **Jobs-to-be-done drive the design** — authoring now starts at Level (a0) by asking who uses the
  app and what each of them needs to get done, *before* the data model, and carries those jobs
  through to the surfaces that satisfy them (`personas[].jobs[].surfaces[]`). Previously jobs were
  only asked for at the end, to size security roles — and the playbook contradicted the skill by
  declaring roles out of scope, so they were never enumerated at all.
- **`scripts/write-app-spec-doc.js`** — renders `model-app-plan.md`, a readable design document
  (jobs → surfaces traceability, data model, every surface, navigation, access model, sample data)
  from the spec. It replaces a hand-written counts summary, so it is complete, always agrees with
  what will build, and is regenerable after any edit.
- **Design-gap warnings at the lint gate** — jobs with no covering surface, an app with no
  generative pages, or no personas at all are now surfaced as warnings instead of passing silently.
- **`/app-builder` skill (Preview)** — natural-language intent → deployed model-driven app: tables,
  columns, relationships, adaptive forms with sub-grids, views, Choice-column charts, dashboards,
  generative pages, app + sitemap, and sample data, via the headless vendored `cds-maker-sdk`.
- **Security roles per persona (`personas[]`)** — one role per persona, sized to the privileges its
  jobs declare (unioned, max scope wins). Injects `appmodule` read and associates the app so it opens
  for non-admins (`appAccess: false` opts out). Idempotent and converging; fail-closed on a same-name
  role the builder did not author.
- **`--changed-only` partial apply (Preview, off by default)** — after a fresh baseline, a page-only
  `.tsx` edit re-runs just the pages phase; any other change falls back to a full build.
- **AI-first features** (`ai` block → `ai-features` phase) — form fill, NL search, NL charts, M365
  Copilot and row summaries, admin-gated via `ai-preflight.js`.
- **Table icons** (`entities[].vectorIcon` / `icon`), plus a semantic default icon per table from the
  authoring flow instead of the stock cube.
- **Opt-in auto sub-grids** (`forms[].autoSubgrids: true`) — a sub-grid on the parent form per 1:N child.
- **Form edits can REMOVE a field**, not just add one; forms and views now update in place on edit.
- **The app shows your form, not the blank stock form** — a built main form becomes the entity default.
- **Parent lookups surface in views** — 1:N lookups appear in auto-layout, authored, and built-in
  default views.
- **Fail-closed page deployment + verification** — `PAGEREF_<key>` navigation is resolved to real page
  ids before upload and an unresolved token halts the build; a manifest-aware download round-trips pages.
- **`scripts/preview-app.js`** — renders the whole app design (data model, sitemap, forms, page intents)
  for review before building.
- **Page generation reuses the `/genpage` worker via a plan adapter** — `write-page-plan.js`
  projects the App Spec into the `genpage-plan.md` the page-builder actually reads, so an intent page
  can no longer silently fail to become `.tsx`. Untrusted spec text (including download-derived) is
  neutralised so it cannot forge plan sections.
- **`promote-intent-pages.js`** — validates every generated page (written, structurally a module,
  `PAGEREF_` tokens in exact parity with `navigatesTo`) and flips them all `intent → tsx` in one
  atomic write, or exits 3 leaving the spec untouched.
- **Eval suites** — an offline `/app-builder` structural harness (`evals/model-apps/app-builder/`) and
  the genpage Layer 1/2 TAP runners with shipping fixtures.
- **`check-auth.js --env` support** — SDK builds accept `--env <url>` or a positional URL, treat a
  missing PAC login as a warning, and reserve `--require-pac` for genpage.
- **`/app-builder` is covered by the v2.3 hooks + telemetry** — tracked-skill discovery is derived from
  `skills/*/SKILL.md`, and the write-safety and icon-import guards now recognise app-builder working dirs.
- **Docs + marketplace metadata cover both skills** — `/app-builder` is documented as Preview in the
  plugin and repository READMEs.

### Changed
- **The connectors feature flag is re-probed before code generation** — the result is passed as
  `Connectors: enabled|disabled` in every page-builder dispatch and overrides the plan, so a plan
  authored while the flag was ON can no longer emit connector calls the run never binds.
- **Surface classification is explicit** — the authoring flow now enumerates every surface each job
  needs and classifies it (record CRUD → form + view; overview/dashboard/analytics/wizard/composite
  → generative page), and states each call out loud. Pages were previously one item in a long list
  behind a "never force-add it" hedge, so they were routinely skipped.
- **Forms resolve by `(entity, name, type)`** — a table's same-named Main/Quick View/Card forms no
  longer block an edit, and teardown no longer over-deletes them.
- **Views are identified by `entity|name`** — same-named views on different tables no longer cross-wire
  a dashboard tile, sub-grid, or snapshot entry to the wrong view.
- **App identity round-trips by its real uniquename** — no duplicate app on rebuild.
- **Nav icons round-trip** — custom icon web resources are re-declared on download (portable across
  environments) and entity-subarea sitemap icons survive a download→build cycle.
- **Pre-existing duplicate page names no longer block an unrelated build** — the check only errors when
  a new page collides.
- **Staged-flow authoring** — design-only authoring, an explicit generate-pages step, a `--stage`
  selector, and fewer approval gates with checks run earlier and automatically.
- **Sample-data idempotency is explicit** (`seedRecordGraph.matchOn`), and every artifact push is
  verified (`requireSuccessfulPush`).
- **Re-vendored `cds-maker-sdk`** — backlog capability fills (pagination, quick create, idempotent
  global choice, authored column width), shared input-safety boundaries, and the `hardening-2` bundle.

### Fixed
- **Teardown leaves nothing behind** — the table icon and generated app-icon web resources are removed
  (web resources delete after tables), cascade cleanup failures are reported instead of silently
  orphaning rows, and reused/system tables are skipped with a reason rather than erroring.
- **Command-bar teardown is fail-closed** — only the bar for a table this spec created is deleted, so a
  command on an existing table can never remove another app's buttons.
- **Exported solutions are self-contained** — the app icon and sitemap are added to the solution, so
  import no longer fails on missing components.
- **Relationships to a standard/system table no longer halt the build** — the schema name auto-prepends
  the publisher prefix.
- **System tables keep their default sitemap icon** — the transparent-spacer placeholder is stripped.
- **Editing an existing app updates the sitemap for page-less apps too.**
- **Sub-grids pass `targetEntity` to the SDK** — prevents empty `<TargetEntityType/>` output and
  edit-time validation failures.
- **Classic dashboards round-trip** through download/edit with id-passthrough tiles, and dashboard tiles
  render in a 2-column grid.
- **AI row summaries errored on every record** — the prompt filtered on the primary name column instead
  of the primary key.
- **CLI flags fail loudly instead of silently** — a value-less flag no longer passes the usage guard;
  notably `--apply --only` (with no phase list) used to run a *full* apply.
- **The Dataverse token is never sent to another origin** — the HTTP client requires an absolute
  `https` org URL and refuses any request outside it.
- **A lossy download fails instead of reporting success** — unmapped sitemap subareas are named and the
  spec is validated before it is written (`--allow-lossy-download` opts in).
- **Assorted robustness** — temp workspaces cannot leak on a failed SDK init, `%` in prompts survives
  cmd.exe, an omitted column `type` defaults to `Text`, `vectorIcon` is verified in the sitemap, and
  entity-subarea `vectorIcon` no longer breaks the app designer.

### Tests
- Plugin unit tests (+ optional vendored SDK suite): `node scripts/run-tests.js --with-sdk <ppux>`
  from `plugins/model-apps/`.
- Eval fixtures run separately, from the repo root: `node evals/model-apps/genpage/run-layer-1.js`,
  `node evals/model-apps/genpage/run-layer-2.js`, `node evals/model-apps/app-builder/run-app-builder.js`.
- **Vendored-SDK contract tests** lock OData filter encoding, name-based identifiers, and sitemap
  free-text XML escaping.

### Removed
- **Standalone entity/solution scripts, consolidated into the SDK** — `create-table.js`,
  `add-column.js`, `create-relationship.js`, `create-record.js`, `create-solution.js` and
  `add-to-solution.js` are replaced by `provision-entities.js` and `provision-solution.js`.

### Known limitations
- **App EDIT does not re-pin a new chart** as an explicit app component — a chart added to an existing
  app needs a manual pin or a rebuild.

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
