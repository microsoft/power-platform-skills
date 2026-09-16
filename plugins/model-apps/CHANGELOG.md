# Changelog

All notable changes to the **model-apps** plugin.

Entries are deliberately short: what changed and why it matters to you. The reasoning,
evidence and trade-offs behind a change live in its PR, in `docs/`, or in the linked issue.

## [Unreleased] — 2.8.0

A dry run that says what an apply would really do, sample data that can express a hierarchy, and
downloads that round-trip Choice columns.

### Added

- **Richer form layouts: multi-column tabs, cell spans, and per-container visibility.** A tab can
  now hold several form-columns (`tabs[].columns[]` with a `width`), a field entry can set
  `colspan`/`rowspan`, and `expanded`/`visible`/`showLabel` are author-controlled. Row packing
  accounts for span, so a full-width field no longer leaves a stray cell beside it. Every new key
  was measured against the vendored SDK first: keys its serializer discards — `showLabel`/
  `labelPosition` on a tab, `labelPosition`/`locked` on a section — are **rejected** rather than
  accepted and dropped, and `tabs[]`/`sections[]`/field entries are now allow-listed, so a typo
  fails instead of silently vanishing. The **form wireframe** renders the new structure — a
  multi-column tab shows its columns and widths, and a collapsed or hidden tab says so — because
  that preview is the approval gate, and one that cannot show a layout would have users approving
  something other than what ships.

- **The dry run resolves create-vs-reuse against the live environment** ([#559]). Without `--apply`
  the plan was a static echo of the spec, identical whether every artifact already existed or none
  did — the one question a dry run exists to answer. Each item is now `+ create` or `= reuse`, with
  a summary (`2 to create, 6 already present`); an unreadable item is `? unknown`, never guessed.
  The probe reuses the build's own discovery, so the plan cannot drift from the apply.
  `--no-live-plan` restores the offline listing.
- **Sample data can express a hierarchy on one table** ([#544]). A `$parent` may target the row's
  own entity (an org tree, a "reports to" chain). Rows are seeded in dependency waves, so
  declaration order does not matter, and a cycle is rejected by the lint rather than failing the
  build partway through. Add `$parent.lookup` to say which relationship a bind uses — required only
  when two or more relationships connect the same pair, and now **rejected** rather than silently
  taking the first declared one.

### Fixed

- **Editing a form with an explicit layout reshapes it, instead of flattening it** ([#575]). Every
  field was appended to the first section of the first tab and no tab or section was ever created or
  resized — while declaring explicit `tabs` simultaneously switched **pruning** on. An author moving
  a deployed form to a two-column layout therefore got the old layout, minus any field they had not
  re-declared, and a green build. Tabs, form-columns and sections are now created when missing,
  patched in place when they differ (including a section's column count), and a field in the wrong
  section is **moved** rather than duplicated — the cell keeps its id and any control state a maker
  edited. Containers match by `name`, then `label`, then position, so a form built by an earlier
  `auto` layout converges instead of gaining a duplicate tab on every rebuild. Two containers can
  never converge on the same live one: an index an earlier section or tab claimed is taken out of the
  running, because the compiler substitutes a default label (`General`, `Details`) for an unlabeled
  container and a whole layout of unlabeled sections used to collapse into the first. Sections the
  **engine** owns — a sub-grid host, the notes/timeline section — are matched only by name, never by
  label or position, so an explicit layout can no longer relabel a sub-grid and inject fields into
  the row holding its grid control; and a notes section keeps its timeline row when created, instead
  of deploying a section header promising a control nothing adds.
- **`--verify` no longer demands a default form the build never promotes.** The build refuses to
  re-point the default form of a reused or stock table (that is an environment-wide side effect on a
  table the spec does not own), but the verifier asserted it anyway — so any spec with a Main form on
  `account`, `contact`, or an `existing: true` table failed verify permanently, with nothing the
  author could do about it. Verify now applies the build's own guard.
- **A tab's `columns` must be a list of form-columns.** `columns` is an integer grid width on a
  *section* and an array of form-columns on a *tab* — the schema's most confusable key. `"columns": 2`
  on a tab validated clean and was then discarded by the compiler, silently shipping a one-column
  form. It is now an error that names the fix.
- **Duplicate sample-data names fail at author time, not halfway through the build.** With no
  single-column alternate key the loader uses the primary name as `matchOn`, and refuses to do so
  when two rows share one — a refusal that landed in the sample-data phase, after tables, forms and
  views were already deployed. Two tickets both called "Printer issue" is ordinary sample data; it is
  now caught by `validateAppSpec`, with the same escape hatches the loader honours (a safe alternate
  key, or an empty primary that omits `matchOn` altogether). The same duplicate rule now also covers
  a single-column **alternate key** when that is what `matchOn` selects — it had the identical hole.
- **Cell spans converge on an existing form, and are clamped where they are written.** `colspan`/
  `rowspan` were create-only: widening a field on a deployed form produced a green build and an
  unchanged cell. A span the author declared is now written to the deployed cell, while a span they
  did *not* declare is still never sent, so a cell a maker widened by hand survives. A `colspan`
  wider than its section is now clamped in the **emitted** cell too, not only in the row arithmetic —
  it previously packed as the clamped width but serialized the original, producing the overrunning
  cell the clamp exists to prevent. A `rowspan` is now rejected unless it is the last field in its
  section: a cell that spans down reserves its column, and the compiler does not yet emit the spacer
  cell needed to place a field beside it (stock account/contact forms only ever use `rowspan`
  terminally, so this matches the platform's own shape). The SDK does serialize a spacer, so the
  restriction is the compiler's rather than the platform's — lifting it is tracked in [#581].
- **A build no longer reports a default form it failed to set.** `result.created.defaultForms`
  recorded the entity even when the `isdefault` write threw.
- **`--verify` proves sort PRECEDENCE, not just membership.** Each authored order was checked for
  existence anywhere in the deployed query, so a deployed `[name asc, createdon desc]` satisfied an
  authored `[createdon desc, name asc]` — two views that return rows in different orders. Authored
  orders must now appear in their declared relative order; extra platform orders are still tolerated.
- **Dashboard id-passthrough tiles are validated per tile type.** `visualizationId` identifies a
  chart and means nothing on a list tile, but one shared test covered both: a list tile carrying a
  stray `visualizationId` skipped the `viewId` requirement entirely, and a chart tile with only a
  `viewId` passed with no visualization to render. The **download** was made consistent in the same
  change: a deployed chart component that carries no `VisualizationId` is now reported and omitted,
  instead of being emitted as a half-tile that fails the spec's own lint.
- **A downloaded relationship that is renamed is no longer reported as lost.** A relationship whose
  deployed schema name sits under a foreign publisher prefix *is* carried into the spec under the
  generated name, but it was also recorded as skipped — so the summary claimed it was "absent from
  the rebuildable spec". It is now reported as a rename. Separately, a parent table whose metadata
  could not be read is reported as undetermined instead of being diagnosed, wrongly, as "a custom
  table this app does not include".
- **Two silent no-ops now report themselves.** A failed default-form promotion was swallowed
  entirely, so a build could record a default form it had not set; it warns with the reason, and
  `--verify` proves the deployed `systemform.isdefault` independently. An **existing** view's
  authored filters/sort are still not reapplied (only columns and description converge) — that is
  now said out loud when the author declared any, rather than reported as success.
- **`_seedKey` in `sampleData` is rejected instead of being sent to Dataverse.** It was never a
  loader sentinel — only `$parent`, `$parents` and `statusReason` are stripped — so it reached the
  API as an attribute no table has. The error names the real mechanism: a single-column alternate
  key. Ambiguous parent binds (a duplicate primary-name fallback resolving several rows) are
  rejected for the same reason rather than binding to an arbitrary one.
- **`--verify` gained three oracles**: the deployed default Main form, a view's authored
  filters/sort parsed from `fetchxml` (a condition with no `value` is correct, not missing — that is
  how current-user and relative-date operators serialize), and app-role associations. Each fails
  closed when its proof cannot be read.
- **A download no longer invents text columns from a polymorphic lookup** ([#574]). Dataverse creates
  shadow attributes for every lookup, and a **polymorphic** one (`Customer`-type, or any multi-target
  lookup) additionally stores them physically — so unlike a single-target lookup's shadows they
  report `IsLogical: false` and slipped past the filter that catches the rest. `<lookup>name` and
  `<lookup>yominame` were emitted as real `Text` columns, and because `relationships[]` cannot express
  a polymorphic lookup either, a rebuild into a fresh environment gained two invented text fields
  where a lookup used to be. The filter now keys on `AttributeOf`, which names the attribute a shadow
  belongs to — positive proof the column was never authored, with no type inference and no
  relationship context needed. An authored column, the lookup included, reports `AttributeOf: null`,
  and an unreadable value keeps the column rather than deleting it.
- **A download no longer invents a Money column's base-currency twin either.** Found by live
  round-trip after the fix above. Dataverse generates a `<money>_base` column beside every `Money`
  column, and it carries **no** `AttributeOf`, is **not** logical, and reports
  `IsCustomAttribute: true` — so all three rules above are blind to it. Live-measured on a real
  table: `cfo_budget` and `cfo_budget_base` differ only in `IsValidForCreate` (`true` vs `false`).
  The downloaded spec therefore declared `cfo_budget_base` as an authored column, and a rebuild into
  a fresh environment would try to **create** it, colliding with the twin the platform generates for
  that table's own Money column. A column the API refuses to create was, by definition, never
  authored, so it is now dropped — and, like every other rule here, an unreadable value keeps the
  column rather than deleting it.
- **A download reconstructs `relationships[]`** ([#567]). The block was absent entirely, and — unlike
  forms, views, charts, business rules and global choices — nothing said so, so a downloaded spec
  looked complete while a rebuild into a fresh environment produced tables with no lookups and no
  hierarchy, reporting success. 1:N and N:N relationships are now read from live metadata, carrying
  the lookup's deployed casing and label. Relationships that App Spec **cannot** express are named
  with a reason instead of vanishing: a **polymorphic** lookup (one column targeting several tables
  — `relationships[]` declares exactly one parent per lookup), a parent that is a custom table the
  app does not include, and an N:N whose partner table is outside the app. A bridge to a standard
  table (`systemuser`, `account`) is kept, since a rebuild target always has one.
- **A downloaded spec no longer fails its own lint** ([#572]). A downloaded dashboard carries
  *ID-passthrough* tiles — the deployed view/chart ids rather than names, because those artifacts
  already exist. `validateAppSpec` and the build both accept that form; the lint did not, so
  `lint-app-spec.js` rejected a freshly downloaded spec with six errors reporting a chart literally
  named `'undefined'`. The lint now understands id-passthrough tiles, still validates name-based
  ones, and reports a missing reference as missing instead of interpolating `undefined` into the
  message.
- **A download round-trips Choice and MultiChoice columns** ([#564]). They were emitted with no
  `type`, so rebuilding into a **fresh** environment created single-line Text while Memo, Money and
  DateTime survived — an asymmetry harder to notice than an outright failure. Option sets are now
  read per table: a local set becomes inline `options[]` (localizations preserved), a shared one a
  `globalChoice` reference plus a `globalChoices[]` declaration. Four related defects went with it:
  a **MultiChoice column was dropped from the spec entirely** (Dataverse types it `Virtual`); a
  lookup's synthetic `<lookup>name` column was emitted as a real Text column, which a fresh rebuild
  then created; a legal multi-language option set could abort the **whole** download; and
  `globalChoices[]` could declare sets nothing referenced. A column whose option set cannot be read
  is still left untyped — but now named, with the reason. Note the App Spec cannot express option
  *values*: labels and order round-trip, and a fresh rebuild re-bases them to `100000000 + index`.
- **`--verify` checks that a sitemap-visible table really belongs to the app.** The sitemap and the
  app module's table list are separate facts and can disagree, so an app could show a table in
  navigation while omitting it from its Tables list — and verify still said PASS, because the table
  existed and the sitemap named it. It now fails by table name, fails **closed** when the component
  list cannot be read, and reports leftover `entity` placeholder components.
- **A multi-line page prompt is no longer flattened on upload** ([#565]). Prompts went to `pac`
  inline, where a newline guard collapsed every line break — so a downloaded conversation transcript
  degraded a little more on each edit-rebuild. They now go through `--prompt-file` /
  `--agent-message-file`. `upload()` also accepts an optional `compiledCodeFile`.
- **`/genpage` Phase 1 is reachable again** ([#541]). Its interactive flow was specified to run
  inside a headless `Task` subagent, so create flows could not complete. Interaction now runs in the
  main loop; the agents are headless workers that return a `needs_input` request when they need a
  decision (`references/agent-interaction-contract.md`).
- **Teardown no longer reports a false failure for a self-referencing relationship** ([#544]). The
  table delete already removes it, so deleting it first returned `referenced by 2 other components`
  and a completely clean run still exited non-zero.
- **A mistyped flag now fails instead of quietly changing what the command does.** An unrecognised
  flag was dropped *and* swallowed the token after it: `--stagee ui` planned all 9 phases instead of
  3 and exited 0 — with `--apply`, a scoped apply became a full one. Every CLI now declares the
  flags it accepts, rejects anything else with a "did you mean", and rejects a value-bearing flag
  passed bare. This also covers `--allow-destructiv` and friends on the destructive tools.
- **A test file in a `scripts/tests/` subdirectory is no longer silently skipped.** Discovery was a
  flat `readdir`, so a nested suite would be committed, reviewed, reported green and never run.

### Changed

- **`/app-builder` is GA.** The preview notice is gone: the App Spec shape, the CLI flags and the
  build phases are now treated as a stable contract rather than one that may change between
  versions. The guidance that outlived the notice stays — review the dry-run plan before approving,
  and use `teardown-model-app.js --apply` to clean up probes. `--changed-only` (partial apply) is
  the one piece still experimental, and remains off by default.
- **Connector authoring is GA and on by default.** SharePoint / weather / Office 365 / SQL /
  custom-REST binding and ALM packaging of connection references work without opting in. The
  `connectors` flag is **flipped to `true` and kept for one release as a rollback switch** —
  `GENPAGE_ENABLE_CONNECTORS=0` restores the old behaviour — and is scheduled for removal next
  release. `custom-api` and `custom-telemetry` are unaffected and still default-OFF.
- **The Phase 4.5 dispatch value is the binding count, not the flag state.** The page-builder gets
  `Connectors: none` or `<n> binding(s)`; a disabled gate and an empty binding table both yield
  `none`, so the dispatch stays stable when the flag is removed.
- **The App Spec schema is split so the always-read half is smaller.** `globalChoices`,
  `webResources`, `commands`, `businessRules`, `businessProcessFlows`, `dashboards` and `roleGrants`
  moved to `app-spec-schema-advanced.md`, leaving a pointer table: 105 KB → 82 KB eagerly read.
- **The CLI flag contract is shared rather than per-script**, so the flag rules and the "did you
  mean" suggestion cannot drift between commands.
- **Deeper tests on the paths connectors GA just made live**, including a connector *edit* eval and
  a contract test pinning the dispatch fields the skills hand to the page-builder.

[#541]: https://github.com/microsoft/power-platform-skills/issues/541
[#544]: https://github.com/microsoft/power-platform-skills/issues/544
[#559]: https://github.com/microsoft/power-platform-skills/issues/559
[#564]: https://github.com/microsoft/power-platform-skills/issues/564
[#565]: https://github.com/microsoft/power-platform-skills/issues/565
[#567]: https://github.com/microsoft/power-platform-skills/issues/567
[#572]: https://github.com/microsoft/power-platform-skills/issues/572
[#574]: https://github.com/microsoft/power-platform-skills/issues/574
[#575]: https://github.com/microsoft/power-platform-skills/issues/575
[#581]: https://github.com/microsoft/power-platform-skills/issues/581

## [2.7.1]

Three defects an author hits before reaching an environment, and a session-start warning.

### Added

- **`scripts/lint-app-spec.js` — lint and validate a spec without touching an environment** ([#560]).
  `validateAppSpec` (the gate `--apply` enforces) and `lintAppSpec` (the authoring guardrails) were
  library exports with no entry point, so a headless author or a CI job had to reach in with
  `node -e`. The CLI runs migrate → validate → lint, tags each finding `schema:` or `lint:`, and
  exits non-zero on errors. `--profile` defaults to `plan` (pages may still be intents), so gate a
  final, deployable spec with `--profile deploy`. `--strict` also fails on warnings; `--json`
  emits the report. Argument handling is deliberately strict — an unknown flag, or `--spec`/
  `--profile` given without a value, is a usage error, never a silent fall back to the default
  profile a CI job did not ask for.

### Fixed

- **A spec that declares `schemaVersion` per page but not at the top level no longer breaks every
  page reference** ([#545]). Migration mints a stable key per page, and it did so *unconditionally* —
  overwriting hand-authored keys with a slug of the page name. The references hold keys, not names,
  so nothing rewrote them and validation reported one "not a known page key" / "unknown page" error
  per page, none of which named the cause. Authored keys now survive migration; a key is minted only
  for a page that has none, and every authored key is reserved first so a minted one cannot steal it.
- **A `//` or `/* */` comment inside a JSX opening tag no longer makes a valid page look truncated**
  ([#542]). `jsxTag` mode had no comment handling, so an apostrophe in the comment prose was read as
  an attribute-value quote — and that scanner does not stop at a newline, because a JSX attribute
  value legitimately may span lines. It ran to end of file, blanking the real `export default` and
  miscounting every bracket after it, so `promote-intent-pages` rejected a complete page as
  truncated. Promotion is transactional, so one such page blocked the whole batch. Block comments
  had the same defect, which the report did not cover.
- **`eq-businessid` / `ne-businessid` are accepted in a view filter** ([#546]). Both are value-less
  FetchXML operators — the business-unit equivalents of `eq-userid` / `ne-userid` — and the lint
  demanded a value they must not carry. The operator list is now the documented value-less set,
  which also adds `eq-userlanguage`, the user-hierarchy operators, and the relative fiscal-period
  ones. The reverse case now warns: a value-less operator that *carries* a value is not rejected by
  Dataverse, it is ignored — so the filter silently does not do what the value says. An operator
  outside the documented set also warns, with a "did you mean" hint, instead of being reported as
  needing a value it cannot take.
- **No more `hooks.json: unknown key "_comment" ignored` at every session start** ([#555], [#558],
  affects `model-apps` and `mobile-apps`). The hooks manifest is validated against a closed schema,
  so the documentation key it carried was reported as a misconfiguration on every launch. The prose
  moved to `hooks/README.md`, and a repo-wide CI check now fails any manifest with an unrecognised
  top-level key — the symptom is otherwise invisible to both tests and review.

[#542]: https://github.com/microsoft/power-platform-skills/issues/542
[#545]: https://github.com/microsoft/power-platform-skills/issues/545
[#546]: https://github.com/microsoft/power-platform-skills/issues/546
[#555]: https://github.com/microsoft/power-platform-skills/issues/555
[#558]: https://github.com/microsoft/power-platform-skills/issues/558
[#560]: https://github.com/microsoft/power-platform-skills/issues/560

## [2.7.0]

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
