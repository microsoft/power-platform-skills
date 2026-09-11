# Changelog

All notable changes to the **model-apps** plugin.

Entries are deliberately short: what changed and why it matters to you. The reasoning,
evidence and trade-offs behind a change live in its PR, in `docs/`, or in the linked issue.

## [Unreleased] — 2.8.0

A dry run that says what an apply would actually do, and sample data that can express a hierarchy.

### Added

- **The dry run resolves create-vs-reuse against the live environment** ([#559]). `build-model-app.js`
  without `--apply` used to print a static, spec-derived listing and exit before any discovery, so
  the identical plan appeared for a spec whose every artifact already exists and for one that would
  create everything from nothing — the one question a dry run exists to answer. Each table, column,
  relationship, view, chart, form and the app module is now marked `+ create` or `= reuse`, with a
  summary line (`2 to create, 6 already present`). A read that fails is reported as `? unknown` and
  never collapsed into either decision. The probe reuses the **build's own** discovery, so the plan
  cannot drift from what the apply then does; it is read-only, and `--no-live-plan` restores the
  offline listing.
- **Sample data can express a hierarchy on one table** ([#544]). A `$parent` may target the row's
  **own** entity — an org tree, a "reports to" chain. Rows are seeded in dependency waves, so
  declaration order does not matter; a cycle is rejected by the lint rather than failing the build
  partway through. Previously any self-reference halted the whole `sample-data` phase.
- **`$parent.lookup` disambiguates which relationship a bind uses** ([#544]). Needed only when two or
  more `OneToMany` relationships connect the same pair — common for a hierarchy table with both a
  "parent org" and a "group ancestor" self-lookup. Without it the bind is now **rejected** rather
  than silently taking the first declared relationship and asserting something false about the data.

### Fixed

- **Teardown no longer reports a false failure for a self-referencing relationship** ([#544]). It is
  removed by the table delete, but teardown also tried to delete it first and got
  `referenced by 2 other components` — so a run that left the environment completely clean printed
  `✗` and exited non-zero. Live-measured; now exits 0.
- **A test file in a `scripts/tests/` subdirectory is no longer silently skipped.** The runner's
  discovery was a flat `readdir`, so a nested suite would be committed, reviewed, reported green and
  never execute. Every suite is top-level today, which is exactly why this needed a test.

[#544]: https://github.com/microsoft/power-platform-skills/issues/544
[#559]: https://github.com/microsoft/power-platform-skills/issues/559

## [Unreleased] — 2.7.0

Multi-language Dataverse labels, granting access on roles this spec does not own, and the
app-builder defects found while rebuilding a real app into a second environment.

### Added

- **Localized Dataverse metadata labels** (AB#6686428, [#537]). Any author-facing name — a table's
  `displayName`/`pluralName`, its primary column's, a column's, a lookup's, an alternate key's, an
  inline Choice option's — may be a map keyed by LCID instead of a string:

  ```jsonc
  "displayName": { "1033": "Project Baseline", "3082": "Línea base del proyecto" }
  ```

  A single-language label stays a plain string, so no existing spec changes shape. Three rules:
  `globalChoices[]` is **rejected** (Dataverse stores only the base language there — use an inline
  Choice on the column); a language **tag** (`"es-ES"`) is rejected rather than guessed; and a
  localized `displayName` requires an explicit `pluralName`, because appending `"s"` is not a plural
  rule outside English. An LCID the organization has not provisioned halts the build.
  See `references/app-spec-schema.md` → *Localized labels*.
- **`roleGrants[]` — extend a security role you did not author** (AB#6686429). Adds privileges to a
  role that already exists, typically the ones an existing solution ships; `personas[]` remains the
  surface for roles the spec owns. **Additive and one-way**: dropping the entry does not revoke, and
  teardown never removes one. An unknown, ambiguous or stale role halts the build rather than
  skipping, because granting on the wrong role is a silent access defect.
- **`businessProcessFlows[].securityRoles` — who may run a flow** ([#513]). Same persona idiom as
  `forms[].securityRoles`. The grant lands on the flow's activation-created backing table, so there
  is no `scope` to author, and `securityRoles` on a **Draft** flow is rejected — the table does not
  exist until activation.

### Fixed

- **AI features are written even when an org readiness gate reads off** (AB#6688904). The gate was a
  precondition, and for four of the seven features that "gate" is the per-app row the write is about
  to set — so a new app looked forbidden and the build reported success having written nothing. Every
  write is now attempted and verified, a gate is read only to explain an absence, and the write is
  re-issued after publish (no app-scope write persists before that).
- **Localized labels were silently discarded on the real build path.** A broad metadata read issued
  immediately before a create makes Dataverse keep only the base-language label, and the request body
  is identical either way, so nothing reported the loss. The three create paths now use narrow reads.
  The column path is the one reached when adding a column to an existing table.
- **A requested row summary that was never created now FAILS verification** (AB#6689110). Build,
  verify and teardown share one selector and one AI opt-in test, so what is verified is exactly what
  was asked for, and a spec with no `ai` block is not checked for summaries at all.
- **Teardown removes a row summary the build created by default.** It planned that removal only for
  an explicit `ai.summaries` block, so for a spec carrying only `ai.appFeatures` the orphaned AI model
  blocked the table delete — teardown finished *with errors* and left the table and its data behind.
- **An SVG in a sitemap subarea's legacy `icon` is flagged** (AB#6688906), naming the `vectorIcon`
  replacement; a raster `icon` beside a vector one stays legal as a deliberate fallback. A sitemap
  attribute you remove from the spec is now removed from the deployed sitemap instead of surviving.
- **A workspace-metadata race no longer halts a multi-form build** (AB#6688905). Wiring form events
  could start before the SDK had persisted that form's metadata file, failing with a bare `UNKNOWN`.
  The read is retried; a persistent failure says it is a local race and that a re-run clears it.
- **`appendTo` no longer reports a false verification failure** — the access token was matched
  case-sensitively against a lower-cased lookup, so a correctly granted role reported it as missing.
- **A download says what it did not bring back** (AB#6686423). `download-model-app` does not
  reconstruct `forms[]`, `views[]`, `charts[]`, `businessRules[]` or `globalChoices[]`, and a spec
  with `"forms": []` was indistinguishable from an app that has none. Runs now name the counts and
  artifacts and return a `notRoundTripped` block. It is a note, not a gate: the loss is real only
  when rebuilding into a *different* environment. Every inventory read that **fails** — a failed
  table-label read, an unreadable business-rule or global-choice list, or a component page that hit
  its cap — is reported as an UNKNOWN class rather than an empty one, so "we could not look" never
  reads as "the app has none".
- **An inactive row-summary model no longer verifies clean.** The AI model row is created before it
  is published, so an environment that does not license the capability leaves a committed but
  unusable row behind; matching on the name alone reported PASS for a summary nobody can run.
- **The Azure CLI identity is checked before any Dataverse read** (AB#6686427). A token from the
  wrong tenant surfaced as an *empty download* — every best-effort read swallowed its 401. A terminal
  401 now names the identity, tenant and environment (AB#6686424); a re-`az login` is the only fix,
  because `az account get-access-token` is MSAL-cached.
- **Default-form promotion is deterministic** (AB#6686426) — building several Main forms in parallel
  could leave whichever finished last as the default. It now honours `forms[].isDefault`.
- **The complete form-id map is signposted** (AB#6686425): `created.formIds`, keyed
  `entity|type|name`. The ids were never lost — `created.forms` is a Main-form-only convenience map.
- **A download no longer emits a raw Dataverse Label object as a column name**; an unlabelled
  synthetic lookup column is omitted instead of failing the spec's own validation.

### Changed

- **SDK uptake `cds-maker-sdk 331b9f56`** — the platform halves of the bugs above: multi-language
  label serialization, `formTypes` on the form listing, the additive `addEntityPrivilegesToRole`,
  `setAppAiFeatures` no longer pre-empting a write, sitemap attribute removal, and retries around the
  workspace file pair.
- **Two label rules relaxed** after they were measured to break specs that build correctly: a blank
  plain-string label is accepted (every create site falls back to the schema name), and a duplicate
  **plain** option label is a warning. A blank entry inside a localized map, and a cross-language
  collision, still fail.
- **The role-privilege read moved onto the SDK's `getEntityPrivileges`**, retiring the last raw-HTTP
  escape hatch in the app-builder scripts. No behaviour change — an unreadable privilege set still
  fails the check closed.

### Known limitations

- **A single-language label loses its LCID on download.** A table labelled only in, say, 3082 comes
  back as a plain string, and a rebuild applies it at the target build's resolved language — correct
  in the same organization, wrong in one with a different base language. Pin `languageCode` in the
  spec before a cross-organization rebuild.

[#537]: https://github.com/microsoft/power-platform-skills/issues/537
[#513]: https://github.com/microsoft/power-platform-skills/issues/513

## [2.6.1]
### Fixed

- **A table key the build cannot honour now fails instead of being dropped** ([#537]).
  `entities[].languageCode` and `entities[].localizedLabels` validated clean and were then silently
  ignored, so asking for one table in Spanish produced a successful build with the request gone.
  Unknown table keys are now rejected and the error names what to write instead. (2.7.0 adds
  multi-language labels as an LCID map on the label field itself.)
- **The `languageCode` error says what to write** — a concrete LCID, and an explicit rejection of a
  language tag, which would otherwise build every label in the wrong language.
- **A non-string `entities[].schemaName` is an error, not a raw `TypeError`** that discarded every
  other problem found so far.

[#537]: https://github.com/microsoft/power-platform-skills/issues/537

## [2.6.0]

Business process flows, plus an SDK uptake that changes how business rules fail on an environment
that cannot host them.

### Added

- **`businessProcessFlows[]` — guided, staged processes on a table.** Ordered stages with steps bound
  to that table's columns, activated on create. v1 is single-entity and linear — branching, stage
  actions and role grants ([#513]) are rejected rather than silently dropped.

### Changed

- **A business rule is validated before it is written.** A rule the SDK's compiler cannot understand
  used to deploy as an empty rule that never fires; the build now runs the designer's own validator
  and fails with its findings.

### Fixed

- **A build no longer halts on an environment that cannot host business rules** — those rules are
  skipped with a warning again, which matters because such environments are the common case.
- **A failed push reports the SDK's own reason** instead of always blaming a concurrent Maker edit,
  and a `VERSION_CONFLICT` still tells you to re-download.
- **Download round-trips `app.newLook` and `app.headerNavigationRefresh`** ([#514]) — a rebuild
  elsewhere previously produced a classic-shell app with nothing reporting the loss.
- **`views[].columns` rejects a non-string entry** ([#525]). An object reached the view's fetchxml as
  `[object object]` and left behind a view row that could not be read or deleted, so every later
  build failed the same way.
- **A business process flow whose derived unique name is already taken is refused up front** — that
  name becomes a *table* name on activation, so a flow named after its own table collided silently.
- **A reused business rule rejoins its solution on every build**, so it travels on export/import.
- **A non-string table reference is rejected instead of coerced** (`charts[].entity`, a subgrid's
  `childEntity`, a sitemap subarea's `entity`, a dashboard tile's `entity`).

[#513]: https://github.com/microsoft/power-platform-skills/issues/513
[#514]: https://github.com/microsoft/power-platform-skills/issues/514
[#525]: https://github.com/microsoft/power-platform-skills/issues/525

## [2.5.1]

SDK uptake. Adds per-form security roles and three column capabilities; **business rules now require
an environment that supports them**.

### Changed

- **Business rules are environment-gated.** An environment that does not declare the SDK's bound
  `CreateProcessWithWfomJson` member **cannot host business rules at all** — the common case. Such
  rules are skipped with a warning, and `--verify` reports them as *not applicable on this
  environment*.

### Added

- **Generated pages can report to the customer's Application Insights** — behind the new default-OFF
  `custom-telemetry` feature flag, via an optional `props.appInsights` surface. The flag is
  permission, not instruction: even with it on, a page is instrumented only when the maker asked to
  measure something, so existing prompts are unaffected. Ships OFF pending the host runtime,
  authoring control, agent prompt and ECS setting. See `references/page-telemetry.md`. Unrelated to
  the plugin's own usage telemetry (`/model-apps:telemetry`).
- **Per-form security roles** — `forms[].securityRoles`: offer a form to named `personas[]` or to
  `everyone`. A form with no assignment is visible to **every** role, so this *restricts* a form; undo
  with `everyone: true`, not by deleting the block. (AB#6648526)
- **Boolean `defaultValue`, whole-number `integerFormat`, and per-column `isValidForCreate` /
  `isValidForUpdate` / `isValidForRead`** — the last is how you make a column read-only.
  ([#495], AB#6648523, AB#6648522, AB#6651276)
- **Twelve more business-rule operators** and **multi-condition rules** (ANDed). Spelling matters:
  `IsGreaterThan`, not `GreaterThan` — the SDK silently resolves an unknown operator to `Equals`, so
  the spec rejects anything outside its table.
- **A `description` on every artifact that accepts one**, written at create time and omitted when
  absent, so a rebuild never blanks text typed in the maker.
- **Per-field form control** — `readOnly`, `hidden` and `after`, via a form-level `fieldOptions` map
  or inline on an explicit layout. `prune: false` edits part of a form without re-declaring it.
- **The AI form-fill family is controllable per capability** — assist toolbar, edit-form predictions,
  smart paste and file upload, instead of one flag that only governed the toolbar.

### Fixed

- **A `businessRules[]`-only edit is no longer treated as "nothing changed"** under `--changed-only`
  ([#478], which also fixes downloads losing dashboard tiles).
- **Descriptions converge on existing views and charts** — previously written only at create, so the
  auto-created *"Active &lt;Plural&gt;"* view never got one ([#496]); **downloaded specs preserve
  deployed descriptions** ([#494]).
- **Teardown removes the activated copy of a business rule**, previously stranding an undeletable
  row ([#493]), and clears column visualizations for a table the spec keeps.
- **Existing columns honour an explicit `required` change on rebuild**; an omitted one leaves the
  live column alone.
- **Big Integer columns are no longer auto-placed on forms** — they have no Unified Interface control
  and rendered *"Error loading control"* on every record.
- **AI on/off is read with the platform's semantics** — `0` = platform default, `1` = disabled,
  `2` = enabled. Treating any non-zero value as "on" reported a disabled feature as enabled.
- **Presence operators** (`ContainsData` / `DoesNotContainData`) deploy ([#481]).
- **`ai.summaries.default: "off"` no longer discards a per-table `enabled: true`**, and a
  differently-cased `tables[]` key keeps its `instruction` and `columns`.
- **A row summary an environment cannot license is skipped, not fatal** — and the row the refused
  publish leaves behind is swept, so a rebuild does not fail on a duplicate key.
- **A spec with no `appShell` reports what to add** instead of dying after the app was half-created.
- **A malformed `businessRules` is a validation error**, not a raw `TypeError`.

[#478]: https://github.com/microsoft/power-platform-skills/issues/478
[#481]: https://github.com/microsoft/power-platform-skills/issues/481
[#493]: https://github.com/microsoft/power-platform-skills/issues/493
[#494]: https://github.com/microsoft/power-platform-skills/issues/494
[#495]: https://github.com/microsoft/power-platform-skills/issues/495
[#496]: https://github.com/microsoft/power-platform-skills/issues/496

## [2.5.0]

Takes up the current maker SDK, adds modern-shell and navigation controls, labels Dataverse
metadata in the organization's own language instead of a hardcoded 1033, and makes persona roles
and jobs-to-be-done checkable.

### Added

- **`businessRules[]` — declarative form logic, no code.** Show/hide, lock/unlock, set-required and
  set-value, gated on a condition over the record, activated on create. Every field is checked
  against the rule's own entity, because a rule naming a column that does not exist is accepted by
  the platform and then simply never fires. Operators `Equals` · `DoesNotEqual`.
- **Custom grid rendering (preview) — `entities[].columns[].visualization`.** Render a column as a
  radial dial, line chart, heat map or star rating in every grid and view that shows it. Where the
  platform has not provisioned the preview the build skips it and everything else still deploys.
- **`app.newLook` — opt into the modern ("new look") shell**, written as the per-app
  `NewLookAlwaysOn` setting so the result is deterministic rather than a per-user preference.
  Best-effort: a tenant without the definition still gets a working app, with a warning.
- **`app.headerNavigationRefresh` — control the Wave 2 header and navigation refresh.** A separate,
  independent setting from `app.newLook`. The platform default is **ON**, so this exists as much to
  turn the refresh off as on — `false` is written actively rather than treated as "do nothing".
- **Labels honour the authoring language everywhere** ([#447], [#455]) — tables, columns, choices,
  **form, dashboard and sitemap labels**. Previously only the data-model phase respected it, so
  `--language-code 1031` produced German columns and English form labels. Precedence:
  `--language-code` → App Spec `languageCode` → the organization's base language → 1033.
- **An unprovisioned `languageCode` stops the build before any label is written** ([#456]), naming
  the LCID you asked for and the ones the organization has. Dataverse otherwise fails
  *inconsistently* — accepting it on tables and choices, rejecting it on `DateTime` and `Memo` — so
  the build died phases away from the flag that caused it.
- **A hand-pinned `languageCode` survives download.**
- **`directEntry` on `pages[]`.** A page declaring `pageInput` must say what a no-input entry
  renders: `{ "behavior": "selector" }` or `{ "behavior": "emptyState" }`. Every key in
  `pageInput.data` must also be supplied by an incoming `navigatesTo[].data` edge.
- **`verify` proves what a persona security role GRANTS**, not just that the role exists — a subset
  check by design, failing closed on an unreadable role or table.
- **`personas[].jobs[].surfaces[]` is checked, not documentary** — `spec-lint` warns when a surface
  matches nothing, and `verify` reports a failure as the job it broke.
- **Automatic plugin update notice** — a non-blocking preflight when a newer version is available.

### Fixed

- **Command buttons now actually run.** A JS command was created with no on-click parameters, so the
  usual `function doThing(primaryControl)` shape threw on its first property access and the button
  silently did nothing — with the build, the deployed rows and `--verify` all looking correct.
  Buttons now receive the standard parameters for their location, overridable via `parameters`.
- **Business rules no longer mistake the platform's activated copy for a duplicate**, which made the
  build warn about a duplicate that did not exist and teardown fail on it.
- **AI preflight no longer reports a running feature as disabled.** The readiness gate and a
  feature's actual setting are different rows; preflight now resolves the effective value and stops
  emitting an admin action for a feature that is already on.
- **Rebuilds no longer duplicate sub-grids or skip field removals.** The SDK's artifact surface became
  asynchronous upstream, and un-awaited that fails *silently* — a promise is truthy, so guards never
  fired, producing duplicate sub-grids, re-added fields and removals that never landed, all behind
  `2xx` responses and a green build.
- **Dashboard chart tiles no longer fail the `dashboards` phase** — the tile emitted `ChartId` where
  the FormXML schema requires `VisualizationId`.
- **Publish failures are no longer silent**, and **a partially-wrong push no longer reads as a clean
  success** — including the case where an app's system-administrator role assignment fails, which
  yields an app nobody can open.
- **A 412 version conflict could be swallowed**, dropping a concurrent Maker edit with no error.
- **A sitemap subarea targeting a custom web resource round-trips** ([#430]) — `$webresource:<name>`
  was rejected by the URL guard, so **no spec file was written at all**, blocking the whole
  download → edit → rebuild flow over one nav entry.
- **Malformed specs produce validation errors instead of raw `TypeError`s**, naming the exact path,
  and can no longer pass validation and then crash *after* the solution and data model were written.
- **`verify-model-app` reports a missing table as a finding**, not a raw Dataverse HTTP 400.

### Changed

- **An app now requires an image icon.** The SDK's auto-resolve demands an **image** web resource,
  failing with `APP_ICON_UNRESOLVED` rather than falling back to any unmanaged web resource
  (including a **JavaScript** file, which the platform then rejected opaquely). No change for
  `/app-builder`, which always passes one explicitly.
- **The vendored SDK records its provenance.** `scripts/vendor/PROVENANCE.json` carries the upstream
  SHA and the bundle's own sha256, and the bundler **refuses** a stale, dirty or unidentifiable
  source. "Built from master" is not provenance: a previously shipped bundle was built from a stale
  build output several commits behind its nominal source, and nothing could reveal it.
- **Three SDK contract changes are user-visible**: `deleteAppCascade` no longer deletes generative
  pages (they are *referenced* by an app, not owned by one, and are reported in `retained[]`);
  unconditional artifact writes are refused (`ARTIFACT_UPDATE_NO_ETAG`); and `pushArtifact` /
  `publishArtifact` report failure by value instead of throwing.
- **`download-model-app.js --app` accepts a display name**, and fails closed when one matches more
  than one app.

### Known limitations

- **A classic dashboard does not survive `download-model-app.js`** — the vendored SDK throws while
  deserializing the `<parameters>` block it itself serialized, so no tiles are recovered and the
  download fails unless `--allow-lossy-download` is passed. Not a regression from this release's SDK
  uptake; tracked upstream.

[#430]: https://github.com/microsoft/power-platform-skills/issues/430
[#447]: https://github.com/microsoft/power-platform-skills/issues/447
[#455]: https://github.com/microsoft/power-platform-skills/issues/455
[#456]: https://github.com/microsoft/power-platform-skills/issues/456

## [2.4.2]

Fixes a malformed app module: generated apps did not actually contain their tables.

### Fixed

- **Generated apps contained an invalid `entity` table component instead of their real tables**
  (ADO 6612527), which also broke unrelated app-processing paths. Tables are now pinned by OData
  **reference** — the only form that can also express an abstract table such as `activitypointer`.
- **An unresolvable table halts the build, naming it.** One bad component fails the whole
  `AddAppComponents` call, so a silently-skipped table used to empty the app's component list.
- **App components are read back and verified after the write** — the write returned 204 for every
  corrupt app, and `ValidateApp` reported success too.

### Known limitations

- **Download still drops entity components not in the sitemap** (ADO 6603388) — the hidden component
  it describes could not be constructed live, so the download-side fix is unverified.

## 2.4.1

Bug fixes for apps built on **out-of-the-box** tables, and the matching SDK uptake. No change to
any skill's public surface.

### Fixed

- **AI app features had no effect on a newly built app** — an app-scope setting write is a no-op
  until the app is published, so the build wrote nothing while reporting success. **`--verify` passed
  when they were never applied**; it now proves an app-scope override row, because reading the
  setting back falls through to the environment value.
- **`ai.appFeatures` accepts non-boolean values** such as `2` ("on for everyone").
- **Download invented primary-name columns**, **replaced the solution's publisher prefix with
  `new`**, and **dropped tables with no sitemap entry** — all three now read from Dataverse.
- **Teardown could permanently burn an app's unique name** — an app is two rows with no server-side
  cascade, so deleting only the app module stranded the sitemap and reserved its name forever. Both
  rows are now deleted atomically in one OData `$batch`.

### Changed

- Re-vendored `cds-maker-sdk`. An injected `HttpClient` must now implement `postRaw` for the atomic
  `$batch`.
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
  of them needs to get done, *before* the data model.
- **Security roles per persona (`personas[]`)** — one role per persona, sized to the privileges its
  jobs declare, associated with the app so it opens for non-admins.
- **`model-app-plan.md`** — a readable, regenerable design document rendered from the spec, plus
  design-gap warnings at the lint gate.
- **Table icons are described before they are drawn** — each table proposes what its glyph will
  *depict* in plain language, shown for approval before any SVG is authored.
- **AI-first features** (`ai` block) — form fill, NL search, NL charts, M365 Copilot and row
  summaries, admin-gated by a preflight.
- **`--changed-only` partial apply (Preview, off by default)** — a page-only `.tsx` edit re-runs just
  the pages phase; anything else falls back to a full build.
- **`scripts/preview-app.js`** to review the whole design before building.

### Changed

- **Edits are first-class**: forms and views update in place, a form edit can *remove* a field, a
  built main form becomes the entity default, and editing an existing app updates the sitemap for
  page-less apps too.
- **Identity is unambiguous** — forms resolve by `(entity, name, type)`, views by `entity|name`, and
  an app round-trips by its real `uniquename`, so a rebuild cannot duplicate or cross-wire.
- **Page generation reuses the `/genpage` worker** through a plan adapter, so an intent page can no
  longer silently fail to become `.tsx`.
- Re-vendored `cds-maker-sdk` (pagination, quick create, idempotent global choice, authored column
  width, shared input-safety boundaries).

### Fixed

- **Teardown removes everything the app owns** — icon and app-icon web resources are removed, cascade
  failures are reported rather than silently orphaning rows, and reused/system tables are skipped
  with a reason. The **publisher** is deliberately left behind: it can own other solutions, so
  removing it is not this app's decision.
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
- **PreToolUse write-safety guard** — flags writes outside the cwd during an active genpage session
  only, so a globally-installed plugin never interferes with unrelated work.

### Fixed

- **Generated-page double-fetch / render flash on open.** The webplayer host double-mounts a page and
  `dataApi` is a new reference each render, so a `useEffect` dep on it re-fires forever. Guidance and
  every exemplar now use an in-flight-promise de-dupe plus a window cache; `dataApi` is forbidden in
  any dependency array.
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
  directly, producing `X.map is not a function` at runtime.


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
