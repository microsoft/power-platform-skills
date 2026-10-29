# Changelog

All notable changes to the **model-apps** plugin.

Entries are deliberately short: what changed and why it matters to you. The reasoning,
evidence and trade-offs behind a change live in its PR, in `docs/`, or in the linked issue.

## [2.20.5]

The bundled SDK is updated (power-platform-ux 59ae2d72e2a8).

### Fixed

- **Pages that loop over or spread a `Map`, `Set`, iterator or generator now show their values**; an existing page takes
  the fix at its next upload that changes its source or data sources.
- **Where the environment refuses every business rule** (HTTP 400 `0x80040216`, common on production), a build warns once,
  skips the rules and builds the rest of the app.
- **`check-auth` rejects an account Dataverse reports as having no security role** (`0x80042f09`) instead of calling it ready.
- **Teardown never deletes a table after an incomplete table listing.**
- **Date and Time columns state their behaviour (User local, as before)**, so later columns on the table are not refused.
- **A page too deep to compile is refused as `PAGE_NESTING_TOO_DEEP` with nothing written**, also when the SDK's
  compiler catches it.

### Changed

- **Eligible app rebuilds check the app's version before adding components** (one read, two more on a match, more when results
  page); missing components then use one version-guarded change set. Publication is unchanged.
- **Adding a page to an app, or removing it, reads the app more**; it keeps its plain, limited component add, and `pinnedViews`
  lists only views the app holds afterwards.
- **Every view update names its table**, as the maker portal does.
- **Workspaces from an earlier release refresh on the first build**; interrupted, unpushed edits still need the build's reset.
- **A page update's version checkpoint is named after its conversation turn.**
- **Page compilation reads array-destructuring elements before their defaults run**; if a default changes a later element, split
  those assignments as the page rules show.
- **A Date and Time column without a behaviour stops the build**, naming the columns to set to User local.

## [2.20.4]

The bundled SDK is unchanged (power-platform-ux a3443479).

### Fixed

- **A page whose elements nest too deeply to compile is refused with `PAGE_NESTING_TOO_DEEP`**, naming the page; the refused
  page is not written to the service. It used to fail with a misleading error.

### Changed

- **The README recommends a general-purpose coding or advanced reasoning model for `/app-builder` and `/genpage`.** On a
  lightweight model, each skill says so once in its first message and continues.

## [2.20.3]

The bundled SDK is unchanged (power-platform-ux a3443479).

### Fixed

- **Lookup discovery takes only strings as table, column and id names.** A malformed metadata answer (a null, true/false or a
  list) now fails the read instead of becoming a name such as "null".
- **On Windows with Node 20, a build that meets an app lock being released or taken over reports another build**, naming the
  file it could not inspect, instead of a file-safety or raw EPERM error.
- **On Windows, a script that starts while another is still making the plugin's temp folder private asks again**, instead of
  putting every workspace of its run in the plain temp folder. This happened where the temp folder lets other users write.
- **On Windows, a script that cannot make its new plugin temp folder private retries removing it for up to ten seconds**; it
  used to leave it, sending every later script to the plain temp folder. A timeout or killed script can still leave it.
- **Pages that use `of` as a variable or type name are read correctly by the build's page checks** wherever its context rules
  out a `for…of` keyword; where it could be one, the earlier cautious reading stays.

## [2.20.2]

The bundled SDK is unchanged (power-platform-ux a3443479).

### Fixed

- **Scripts run side by side on Windows keep their temporary workspaces where cleanup finds them.** A race could leave an
  interrupted run's workspace outside the plugin's temp folder, where it was never removed.

## [2.20.1]

The bundled SDK is unchanged (power-platform-ux a3443479).

### Fixed

- **Pages convert a Map, Set or iterator with `Array.from` before spreading or looping over it.** Pages compile to ES5, where
  `[...map.values()]` or `for (const x of set)` silently yields nothing; the page rules and the `/genpage` and `/app-builder`
  agents now teach the safe form.

## [2.20.0]

The bundled SDK is unchanged (power-platform-ux a3443479).

### Added

- **`/genpage` can offer WhoAmI and RetrieveVersion** (flag `dataverse-operations`, off by default), bound only by explicit
  selection and called only from a button; `list-dataverse-operations.js` does not check the environment.
- **Plans keep what you asked for apart from what the planner assumed** (`## Assumptions`, shown first at approval) and ask
  when a relationship or filter is unclear (#671).
- **Lookups to more than one table** (Customer, Owner, Regarding): plans record each lookup's targets; pages normalize bare or
  table-qualified values (#672).
- **Pages report errors one way**: one reporter, a localized Fluent message bar and a render boundary; manual retry only for safe
  reads (#674).

### Changed

- **Custom API support has no feature flag**; `GENPAGE_ENABLE_CUSTOM_API` is ignored.
- **An edit asks before clearing built-in bindings, ahead of planning**, and a create that adds none stops offering them.
- **Rebuilds and downloads tell built-in operations apart from Custom APIs.**
- **A style you ask for replaces the default look** (AB#6320143).
- **`primaryAttribute` refuses a key the build does not read**, naming the key it meant.
- **Verify fails when an owned web resource's deployed content differs or is missing**; rebuilds report it without overwriting.

### Fixed

- `/genpage` adds pages to the solution you chose (AB#6443257), documents `setPageOutput` (AB#6757591) and finds the
  inputs another page accepts (AB#6247727).
- An app with no tables downloads and builds; a one-language label keeps its language; options labelled alike keep their column's
  type; the loss report names command-bar buttons.
- The entity-builder writes Choice options as labels.
- The page check reads more valid pages; teardown still deletes a page a form embeds (now documented).
- Evals: an ungraded fixture is not counted as passed; the label check reads comments and character references.
## [2.19.0]

The bundled SDK is unchanged (power-platform-ux a3443479, as in 2.18.0).

### Changed

- **The genpage evals grade 17 of the 23 expectations their coverage baseline recorded as ungraded** (#688); the six still ungraded
  have their reason in the baseline.

### Fixed

- **A `--changed-only` apply no longer stops over the bindings of a deployed page it leaves alone**
  (`pages-binding-reference-conflict`), a regression of 2.18.0.
- **Two applies of one app no longer run at once in one workspace**: a second `--apply` is refused before any request
  (`build-locked`, exit 1); rerun once the first finishes. The pages lock now ignores the app name's case.
- **A new table's column or status reason refused just after the table's create no longer stops the first build**
  (`0x80040216`, `0x80090457`): it is sent again only once a read proves it missing.
- **An alternate key over another key's columns (`0x80060894`) stops the build whatever language the platform answers in**, unless
  the existing key is the declared one; in English it was skipped, never created.
- **Built-in JavaScript property names (`__proto__`, `constructor`, `toString`, …) work like any other name** for a dashboard,
  persona, business process flow or status reason, and `constructor` for a page key.
- **A generated page whose default export is a generic arrow function is accepted.** The `async` forms of two rare return types
  that 2.18.0 let through are now refused; name such a type with a type alias.
- The stop for an unconfirmed page manifest now says correctly what the next build does.
- **A token the process obtained is also kept out of the base64 of each part of 24 or more characters and of bytes given to the
  plugin's file writers** (#757), unless split between two appends; pcf's copy of the module covers the same spellings.

## [2.18.0]

The bundled SDK is updated to power-platform-ux a3443479.

### Added

- **A new app whose navigation holds only generative pages is built** (no longer `app-navigation-empty`).
- **A download writes a generative page's `pages[].connectorBindings` and `pages[].actionBindings` into the App Spec; a
  rebuild writes them back**; a conflicting connection reference stops the build (`pages-binding-reference-conflict`).
- **A download keeps much more table schema** (formats, ranges, status reasons, alternate keys, icons), still not a clone.
- **Verification checks declared status reasons and alternate keys**; a build now fails verification when the environment holds one
  differently.

### Changed

- **Bundled SDK**: a web resource write is read back once published (`WEB_RESOURCE_UNVERIFIED` if not confirmed).
- **The HTTP client sends a publish once**; a 401 and a service-protection 429 still retry. pcf's copy matches.
- **Supported public Custom APIs are discovered by default**; `GENPAGE_ENABLE_CUSTOM_API=0` opts out for a run.

### Fixed

- **A download of an app whose sitemap's unique name is not the app's no longer fails on its sitemap** (#746).
- **A web resource or dashboard a stopped build left behind is finished by the workspace's next build**
  (`web-resource-unconfirmed.*.json`, `dashboard-creation.*.json`).
- **An unknown key in a form's `fieldOptions` entry is refused instead of ignored.**
- **A Custom API lookup parameter is passed as `{ entityName, id }`.**
- **A token the process obtained is also kept out of bytes written to stdout or stderr, its base64, percent-encoded and HTML
  spellings, and pieces of 24 or more characters cut by an ellipsis or split between two writes**; pcf's module copy matches.
- **A rebuild no longer stops at something that already exists when answered in another language, nor at an unseen 1:N
  relationship** (`0x80072551`).
- **Teardown removes a published app whose navigation names a sitemap that no longer exists.**

## [2.17.0]

The bundled SDK is updated to power-platform-ux d603c799.

### Changed

- **Bundled SDK (d603c799)**: an app header write sends only changed texts, and an unreadable row-summary lookup is an error. A
  localized app name or description holds back only its own edit.
- `verify-model-app.js` also returns its warnings in the result JSON, printed as pure ASCII.
- Lint warns when no persona or `roleGrants[]` entry grants a new table; `write-app-spec-doc.js --env` lists the app's associated roles.
- `/genpage`, `/app-builder` and the `genpage-*` agents say what they are not for.

### Fixed

- **Dashboard tiles show their charts and lists**: an unsized tile is now 1 column × 12 rows; a rebuild does not resize existing
  tiles.
- A relationship is reused or verified only when the environment states its whole identity; an N:N name on another intersect table
  is refused (`relationship-name-taken`).
- All throttle waits share the run's five-minute budget; past it, the build stops with `throttle-budget-exhausted` before its next
  write — run it again to continue.
- `solution-settings.js import` resends an import refused with `0x80071151` (another import or publish running) when its job proves
  nothing started.
- `--verify` checks localized tab and section captions from one translation export.
- A multilingual alternate key over a new table's name column no longer stops the first build (`0x80060895`).
- **An access token the process obtained no longer reaches the text a script writes**: output, the journal, files, the SDK
  workspace. pcf: the push receipt no longer carries one a refused read quoted, and push-workspace files are guarded too.
- A download keeps File and Image columns (`maxSizeKb`, `isPrimaryImage`) and a table's plural.
- Large results are no longer cut short on Linux and macOS.
- Lint no longer calls an app with no personas administrator-only (AB#6770008).

## [2.16.0]

The bundled SDK is updated to power-platform-ux ccf2c1a1. A new table's primary column is created required when the spec says so,
and navigation titles survive a download and rebuild in any base language.

### Changed

- **A download reads the environment's base language** for navigation titles: `download-model-app.js --language-code <lcid>` is
  new, and a language it cannot establish stops it with `navigation-language-unknown`.
- **Bundled SDK (ccf2c1a1)**: a business process flow edit the flow cannot hold, or a command bar control copied with another
  control's id, fails instead of passing; an answer missing its rows is an error.
- **An `AutoNumber` column without a usable `autoNumberFormat` is refused when the spec is validated**: give a format such as
  `"C-{SEQNUM:5}"`, or use `type: "Text"`.
- **A column's `required` must be `true`, `false` or `"recommended"`**; any other value is refused (`verify-model-app.js` only
  warns).
- The forms phase writes the order of every Main form it orders; an environment without the row-summary AI template skips row
  summaries with one warning.

### Fixed

- A `required` primary name column is applied when its table is created.
- Navigation titles survive a download and rebuild when the base language is not 1033, and a rebuild never clears a title the spec
  does not state unless the baseline shows the spec used to state one.
- Teardown no longer reports a row summary it did not delete, and keeps what only a kept table blocks instead of reporting the
  platform's refusals.
- A run ended by `process.exit` or an uncaught error removes the workspaces it made and did not lend, then the plugin's temporary
  folder (`power-platform-skills-model-apps`) if empty; after a POSIX signal, the next run's sweep does.
- The plan shows a `"recommended"` column as recommended, and the test suite leaves no `.maker-workspace` behind.

## [2.15.0]

Most `pac` commands move to the bundled SDK, which needs `az`.

### Added

- `scripts/apps.js list`/`create` and `scripts/list-tables.js` (`--search`, `--exact`, `--type`) replace
  `pac model list`/`create`/`list-tables`; `create` needs `--page-id`; `--publish` publishes.
- `scripts/genpage.js` replaces `pac model genpage`: `list` (`--include-unpublished`), `download`, `types`
  (`GENPAGE_TABLE_NOT_FOUND`), `add-to-app`, and new `remove-from-app` (`--allow-empty-navigation`) and `delete`
  (`--allow-destructive`; `GENPAGE_DELETE_NOT_CONFIRMED`, `GENPAGE_IN_APP`).
- `scripts/connector.js` (`schema --dataset --table` still asks `pac`) and `scripts/solution-settings.js` (`template`,
  `import`) replace `pac`'s connector and settings commands.

### Changed

- `POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS` is no longer read.
- `genpage-upload.js` creates pages without `--app-id` (not for `--add-to-sitemap` or updates); updates omitting `--model`,
  `--name` or `--data-sources` keep the page's own; workspace resets should keep `page-ownership.*.json`,
  `last-applied.json`, `destructive-approval.json`.
- Throttling waits stop after five minutes per run (`throttle-budget-exhausted`).
- `solution-settings.js import` keeps `pac`'s defaults and reports `importJobId`, `importAttempts`, `importRefusals`; a
  settings copy not made private fails (`PAC_SETTINGS_COPY_FAILED`). `template` overwrites `--out` only with `--force`
  (`IO_ERROR` without hard links); output redacts quoted settings values.
- **Not redacted**: values partly quoted, hashed, base64-encoded, Unicode-normalized, nested over three encodings or written with
  HTML entities beyond XML's five; non-secret values under six characters; untyped ones under six glued to letters, digits,
  marks or underscores or inside an undecoded escape.
- `pac` fallbacks are time-bounded and labelled (`source`/`fallback`, `connectionsSource`/`connectionsFallback`);
  `list-connections.js` failures print `{ok: false, error, code}`.
- Bundled cds-maker-sdk updated; it refuses a rule with no action (`business-rule-NO_ACTION`). Two rare page shapes are
  refused (`generic`, `identifier`).

### Removed

- `scripts/lib/genpage-cli.js`; `/genpage`'s fallback to `pac model list-languages`.

### Fixed

- New apps need a non-page navigation entry (`app-navigation-empty`); a new table's single-language
  name-column keys wait for `primaryAttribute.maxLength` (`alt-key-name-length-not-set`); unreadable table lists fail
  (`TABLES_UNREADABLE`, `table-list-unreadable`).
- Rebuilds apply changed `app.name`/`app.description` (re-run if `APP_HEADER_NOT_PLAIN_TEXT` halts); `--verify` compares
  tab/section labels (`verify-model-app.js --language-code`).
- Dataverse failures no longer carry the access token into script output.
- Downloads keep page keys (`page-keys-ambiguous`, `--reset-page-keys`).

## [2.14.0]

The Notes timeline renders and unchanged rebuilds send far fewer writes.

### Added

- **`subgrids[]` placement** (AB#6651699): `tab`, `column`, `after` and `before` place a related-records grid; a rebuild moves grids
  earlier releases appended after Notes.
- **`primaryAttribute.maxLength`** (1–850) sets a new table's name column; it was ignored before.

### Changed

- The bundled cds-maker-sdk is current.
- **A build stops before writing when the app folder was built against another environment.**
- An AI feature not yet in force is reported `NOT YET PUBLISHED`.
- **`/genpage` reads languages with your Azure CLI sign-in**, falling back to `pac model list-languages --environment`.
- **Generative-page `pac` calls are time-bounded** (`POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS`); an upload with an unknown
  outcome is not retried; an update stops if another app's unpublished navigation holds the page.
- **Parenthesised JSX text no longer needs 2.13.0's expression container**, but a few pages 2.13.0 resolved are
  refused, naming the guess `generic`: move the navigation call before the text or end its unfinished line with a word
  before `//`.

### Fixed

- **The Notes timeline renders** ([#680]); a full build (not `--changed-only`) repairs an older Notes section.
- **Lookup labels default to the parent table's display name** (AB#6691205) without `lookup.displayName`; a rebuild relabels only
  the old default.
- **View filters resolve choice labels against the environment** (AB#6691114); unknown labels or numbering mismatches stop the build.
- **Style shorthands Griffel drops** (`all`, `borderColor`, `borderStyle`, `borderWidth`, `borderBlock*`,
  `borderInline*`) stop the build and `/genpage` for a new or changed page (AB#6691124);
  `node scripts/check-griffel-styles.js --file <page.tsx>` lists the longhands.
- **`genpage-upload.js` no longer takes `--compiled-code-file`.**
- **`dataverse-request.js` refuses a path whose `..` segments, plain or encoded, would leave `/api/data/v9.2/`**
  ([#705]).
- A `PAGEREF_` token 2.13.0 misread in a page's types refuses the page; connector discovery refuses unrecognised
  `pac connection list` output.

## [2.13.0]

Hidden tables and Main forms survive a download and rebuild.

### Added

- **`app.tables`** (AB#6603388): the app's tables outside its navigation; a hidden table another solution owns goes only here, never
  in `entities[]`.
- **`app.mainForms`**: each navigation table's Main forms, by name. An existing app keeps forms it already offers;
  `--verify` names the Maker step that removes one.
- A download writing either field sets `minimumPluginVersion` to 2.13.0.

### Changed

- **A generative page update stops** when there is no base marker, the deployed page changed, or it cannot be read
  ([#673]); `--overwrite-deployed` replaces the maker's changes.
- **Cleanup removes only pages proven this app's own** (a receipt or its navigation) **and records this build
  created**; `--clear-workspace` refuses while a receipt remains. Publish the app before a rebuild updates a page only
  in its saved navigation.
- An uncertain page create stops, and edit plans treat earlier prompts as data.
- **A `PAGEREF_` token is allowed only as the double-quoted `pageId` of a `navigateTo` call with inline options**
  (optionally `as const`, `as Name` or `satisfies Name`); anywhere else, comments included, it halts the build.

### Fixed

- **Relationships that would share a schema name** (a 1:N and an N:N between the same tables) need an explicit
  `schemaName`.
- **Spec sources and outputs stay in your folders**: `contentPath` and page code files must be regular files in the app
  folder; links and junctions at output names are refused.
- **`fieldOptions.after` no longer overflows a row**; `--verify` fails a form that repeats a cell or control id.
- A rebuild re-adds an app missing from its solution.
- JSX text such as `<p>(a = b/c)</p>` halts; write it as `<p>{"(a = b/c)"}</p>`.
- Packaging refuses a non-GUID `connectionreferenceid`, and connector discovery refuses output it cannot read.

## [2.12.1]

- **Usage telemetry is on**: a `skill_started` event when a skill starts, routed to your cloud's
  collector (an unrecognised cloud sends nothing). Org and tenant ids are sent, never the user's id.
  Turn it off with `/model-apps:telemetry off`, or `POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT=1`
  for automation.

## [2.12.0]

Fixes from a retest of 2.11.0, faster `--publish` builds, and a refreshed vendored SDK.

### Added

- **`pages[].model`**: the model a generative page was generated with; a download writes it and
  every upload sends it.
- **`POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS`**: how long an Azure CLI call may take (default 60 s).

### Changed

- **Faster `--publish` builds**: tables and the app publish in one final request. A failed
  default-view publish is a warning naming the re-run, not a stop; a default view edited mid-build
  stops the build.
- **The vendored SDK is refreshed**: an unpublished name or description change no longer stops a
  build with `app-header-unpublished` (a never-published app must still be published first), and a
  new app on a non-English org gets its System Administrator role.

### Fixed

- **Forms converge to their layout**: a moved field is narrowed, and reported, where it does not fit
  its new section; an existing form's tabs and sections follow the layout's order.
- **`--verify` checks more of a form**: tab and section state and order, column widths, and fields'
  `hidden` and `readOnly`.
- **A generative page keeps its name and model on update**: `genpage-upload` re-sends both from the
  deployed page. A name with a straight double quote is refused, and a download no longer adds
  backslashes to `pages[].name`.
- **Stricter readers**: generative-page navigation parsing is linear and misreads less, adding pages
  to a solution checks every id first, and connector discovery refuses output it cannot read.
- **Timeouts are named**: a slow token request is `az_timeout`, a slow `pac org who` is
  `pac_timeout`, not a sign-in error.
- **A re-run of a failed teardown finds the generative pages it left**, and lint no longer flags a
  name reused on another table.
- **`capture-fixture.js` no longer passes an eval it could not verify.**

## [2.11.0]

AI feature values, navigation and default-form fixes, and a refreshed SDK.

### Added

- **`entities[].mainFormOrder`** (AB#6736948): a table's Main forms in offer order; the table opens
  with the first. Works on existing tables.

### Fixed

- **A table opens with its default form** (AB#6736948): the build puts the default form first,
  honours `isDefault` on an existing table, and `--verify` checks the order.
- **Rebuilding an existing app keeps its navigation** (AB#6726727): entries keep their id and
  everything the spec does not describe, and dashboard entries carry the designer's launcher Url.
- **Designer edits after a download are kept**: a changed nav title or icon stays (with a warning),
  and a renamed dashboard is reused by `dashboards[].dashboardId`.
- **AI feature values** (AB#6714731): `true` now writes `2` (*On*) for every feature; rebuilding an
  AI-enabled app turns NL grid search back on.
- **`ai-preflight`** no longer shows ✓ with M365 Copilot off, and reports NL charts' *Auto* as the
  platform default.
- **`appShell` keys the build does not read are errors** ([#631]), e.g. a `title` on an area or
  group, which take `label`.
- **Busy and deadlocked requests are re-sent**: a 429 on a delete no longer stops a teardown, and a
  SQL deadlock (up to three retries) no longer fails a delete or build.
- **Download reads what is deployed**, not a copy an interrupted build left in `.maker-workspace`.

### Changed

- **The vendored SDK is refreshed.** A leftover copy with unpushed edits halts the build; a remedy
  to clear `.maker-workspace` says to stop other runs first and keep `last-applied.json` and
  `destructive-approval.json`.
- **An explicit `false`** writes that setting's *Off*: `1` (for NL grid search and M365, instead of
  the platform default `0`), or `0` for NL charts. A spec that omits `m365` still leaves it at `0`.

## [2.10.0]

Connector authoring loses its flag, `--allow-destructive` removes only what was shown, and the SDK
is refreshed.

### Changed

- **The `connectors` feature flag is removed**, with `GENPAGE_ENABLE_CONNECTORS`; connector
  authoring stays in public preview. An unknown flag now stays off even when a matching env var is
  set.
- **Faster preflight and `/genpage` updates** (overlapped CLI cold starts, one `az` token per
  process).
- **The vendored SDK is refreshed**: business-rule *contains data* and *does not contain data*
  conditions are sent in the designer's shape.

### Fixed

- **`--allow-destructive` removes only what a maker was shown**: a refusal records its list in
  `.maker-workspace/destructive-approval.json`; an approved re-run halts if anything else would be
  removed.
- **Forms**: `prune: false` no longer reports or demands approval for removals that never happen;
  switching the default Main form clears the old one; row-spanning cells count in every layout fit,
  and a removed field leaves no empty row.
- **A `/genpage` update must name the page's own app**; another app's id used to rename the page.
- **pac on Windows**: a path ending in `\` no longer swallows the next argument, and a malformed page
  listing or id is not trusted.
- **Navigation keys**: a quoted key resolves like a bare one, a duplicate counts where it takes
  effect, and a target a later spread could replace is refused.
- **Downloads** refuse a malformed page `dataSources`, keep a page prompt's exact text, and read past
  1,000 components.
- **Non-ASCII text** split across chunks no longer becomes U+FFFD, and the version check no longer
  fetches your repository.

### Removed

- Dead helpers, and duplicate copies of shared ones.

### Documentation

- Corrected what a rebuild re-applies, what `--verify` proves, and BPF security-role grants; a
  page's connector and Custom API bindings survive only a same-environment rebuild.

## [2.9.0]

### Added

- **`app.aiDescription`** routes agents between sibling apps; **`personas[].excludes[]`** records what
  an app leaves out ([#583]).
- **Form layouts**: multi-column tabs, cell `colspan`/`rowspan`, `expanded`/`visible`/`showLabel`.
- **A live dry run** marks items create, reuse or unknown ([#559]); `--no-live-plan` keeps the
  offline listing.
- **Sample-data hierarchies**: `$parent` may target the row's own table ([#544]); `$parent.lookup` is
  now required when two relationships connect the same pair.
- **`minimumPluginVersion`** refuses a spec newer than the plugin.
- **The vendored SDK uses injected storage** (`createNodeWorkspaceStorage`): breaking for library
  callers only.

### Changed

- **`/app-builder` is GA**; `--changed-only` stays experimental, off by default. **Connector
  authoring is on by default** (public preview); the `connectors` flag stays one release.
- **`write-page-plan.js` no longer takes `--out`**: it writes only a plain working-directory file.

### Fixed

- **Business rules**: `dataType` reaches Dataverse as a real type; rebuild any app whose
  `businessRules[]` were built before 2.9.0.
- **Forms** take an explicit layout's shape ([#575]) and spans ([#581]); the wireframe shows `hidden`
  and `readOnly` fields ([#591]).
- **`/genpage`** uses the quoting-safe upload path ([#589]), keeps multi-line prompts ([#565]) and
  bindings on update, runs only the approved plan ([#585]) and checks page file names first ([#588]).
- **Downloads** round-trip Choice columns ([#564]) and relationships ([#567]), invent no columns
  ([#574]) and pass their own lint ([#572]).
- **Dashboards** belong to an app through its solution ([#586]).
- **Safety**: `--clear-workspace` deletes only a real workspace; teardown stops when the app delete fails ([#587]) and keeps
  a downloaded spec's relationships and choices and any security role whose sharing check cannot be read;
  `generate-page-manifest --force` and `genpage-upload.js` refuse links.
- **The vendored SDK is refreshed** (`@xmldom/xmldom` 0.8.15).

### Known limitations

- **Choice option values do not round-trip** (a rebuild re-bases them to `100000000 + index`); a
  rebuild skips existing views' authored filters and sort.

## [2.7.1]

Three defects an author hits before reaching an environment, and a session-start warning.

### Added

- **`scripts/lint-app-spec.js`** lints and validates a spec without an environment ([#560]). Use
  `--profile deploy` for a final spec, `--strict` to fail on warnings, and `--json` for a report.

### Fixed

- **A per-page `schemaVersion` no longer breaks page references** ([#545]): migration keeps
  authored page keys.
- **A comment inside a JSX tag** no longer makes a valid page look truncated ([#542]).
- **Value-less FetchXML operators** such as `eq-businessid` are accepted ([#546]), and one given a
  value now warns.
- **No more `hooks.json: unknown key "_comment"` warning** at session start ([#555], [#558]).

## [2.7.0]

Multi-language Dataverse labels, granting access on roles this spec does not own, and app-builder
fixes from rebuilding a real app into a second environment.

### Added

- **Localized labels** (AB#6686428, [#537]): an author-facing name may be a map keyed by LCID, e.g.
  `{ "1033": "Project Baseline", "3082": "Línea base del proyecto" }`. Not for `globalChoices[]`;
  see `references/app-spec-schema.md` → *Localized labels*.
- **`roleGrants[]`** adds privileges to an existing role the spec does not own (AB#6686429). It is
  additive and one-way.
- **`businessProcessFlows[].securityRoles`** chooses who may run a flow ([#513]).

### Fixed

- **AI features are written and verified even when a readiness gate reads off** (AB#6688904).
- **Localized labels are no longer discarded** when a table or column is created.
- **Row summaries**: a missing one fails verification (AB#6689110), an inactive model no longer
  verifies clean, and teardown removes one the build created by default.
- **Sitemap**: an SVG in a legacy `icon` is flagged (AB#6688906), and a removed attribute is removed.
- **A multi-form build no longer halts on a workspace-metadata race** (AB#6688905).
- **`appendTo` grants** no longer fail verification on letter case.
- **A download names what it did not bring back** (AB#6686423), and a failed read never reads as
  "none".
- **The Azure CLI identity is checked before any Dataverse read** (AB#6686427), and a 401 names it
  (AB#6686424).
- **Default-form promotion is deterministic** (AB#6686426), and `created.formIds` maps every form
  (AB#6686425).
- **A download no longer emits a raw Label object** as a column name.

### Changed

- **SDK uptake `cds-maker-sdk 331b9f56`** for the platform halves of these fixes.
- **Two label rules are relaxed**: a blank plain label is accepted, and a duplicate plain option
  label warns.

### Known limitations

- **A single-language label loses its LCID on download.** Pin `languageCode` before a
  cross-organization rebuild.

## [2.6.1]

### Fixed

- **A table key the build cannot honour now fails instead of being dropped** ([#537]):
  `entities[].languageCode` and `entities[].localizedLabels` used to validate clean and then be
  silently ignored. Unknown table keys are rejected, and the error names what to write instead.
- **The `languageCode` error says what to write** — a concrete LCID, and an explicit rejection of a
  language tag, which would otherwise build every label in the wrong language.
- **A non-string `entities[].schemaName` is an error, not a raw `TypeError`** that discarded every
  other problem found so far.

## [2.6.0]

Business process flows, plus an SDK uptake that changes how business rules fail on an environment
that cannot host them.

### Added

- **`businessProcessFlows[]`: guided, staged processes on a table.** Ordered stages with steps bound
  to that table's columns, activated on create. v1 is single-entity and linear; branching, stage
  actions and role grants ([#513]) are rejected rather than silently dropped.

### Changed

- **A business rule is validated before it is written.** One the SDK's compiler cannot understand
  used to deploy as an empty rule that never fires; the build now runs the designer's own validator
  and fails with its findings.

### Fixed

- **A build no longer halts on an environment that cannot host business rules**: those rules are
  skipped with a warning again.
- **A failed push reports the SDK's own reason** instead of always blaming a concurrent Maker edit,
  and a `VERSION_CONFLICT` still tells you to re-download.
- **Download round-trips `app.newLook` and `app.headerNavigationRefresh`** ([#514]); a rebuild
  elsewhere used to produce a classic-shell app without reporting the loss.
- **`views[].columns` rejects a non-string entry** ([#525]), which used to leave a view row that
  could not be read or deleted, so every later build failed.
- **A business process flow whose derived unique name is already taken is refused up front**: that
  name becomes a *table* name on activation.
- **A reused business rule rejoins its solution on every build**, so it travels on export/import.
- **A non-string table reference is rejected instead of coerced** (`charts[].entity`, a subgrid's
  `childEntity`, a sitemap subarea's `entity`, a dashboard tile's `entity`).

## [2.5.1]

SDK uptake. Adds per-form security roles and three column capabilities; **business rules now require
an environment that supports them**.

### Changed

- **Business rules are environment-gated.** Where the environment cannot host them they are skipped
  with a warning, and `--verify` reports them as not applicable.

### Added

- **Page telemetry to the customer's Application Insights**, behind the default-OFF
  `custom-telemetry` flag; see `references/page-telemetry.md`.
- **Per-form security roles**: `forms[].securityRoles` (AB#6648526).
- **Column options**: boolean `defaultValue`, whole-number `integerFormat`, and
  `isValidForCreate`/`isValidForUpdate`/`isValidForRead` ([#495], AB#6648523, AB#6648522, AB#6651276).
- **Twelve more business-rule operators**, and multi-condition rules.
- **A `description` on every artifact that accepts one**; leaving it out never blanks text typed in
  the maker.
- **Per-field form control**: `readOnly`, `hidden`, `after`, and `prune: false`.
- **AI form fill is controllable per capability.**

### Fixed

- **`--changed-only` notices a `businessRules[]`-only edit** ([#478]).
- **Descriptions converge** on existing views and charts ([#496]) and survive a download ([#494]).
- **Teardown removes a business rule's activated copy** ([#493]).
- **Rebuilds honour an explicit `required` change**, and Big Integer columns are no longer
  auto-placed on forms.
- **AI on/off settings are read with the platform's semantics.**
- **Presence operators deploy** ([#481]).
- **Row summaries**: per-table settings survive `default: "off"`, and one the environment cannot
  license is skipped.
- **A missing `appShell` or a malformed `businessRules`** is a validation error, not a crash.

## [2.5.0]

Takes up the current maker SDK, adds modern-shell and navigation controls, labels Dataverse
metadata in the organization's own language instead of a hardcoded 1033, and makes persona roles
and jobs-to-be-done checkable.

### Added

- **`businessRules[]`**: declarative show/hide, lock, require and set-value form logic.
- **Custom grid rendering (preview)** with `entities[].columns[].visualization`.
- **`app.newLook`** and **`app.headerNavigationRefresh`** settings.
- **Labels honour the authoring language everywhere** ([#447], [#455]), and an unprovisioned
  `languageCode` stops the build before any label is written ([#456]).
- **`directEntry` on `pages[]`** says what a page with `pageInput` shows without input.
- **`verify` checks persona role grants and `personas[].jobs[].surfaces[]`.**
- **An automatic plugin update notice.**

### Fixed

- **Command buttons run**: they now receive their standard parameters.
- **Rebuilds no longer duplicate sub-grids or skip field removals.**
- **Dashboard chart tiles, publish failures, 412 conflicts and a failed admin-role assignment** are
  no longer silent.
- **A `$webresource:` sitemap subarea round-trips** ([#430]).
- **Malformed specs and missing tables** are reported as findings, not crashes.
- **AI preflight and business-rule duplicate detection** no longer misreport.

### Changed

- **An app requires an image icon** (`APP_ICON_UNRESOLVED` otherwise).
- **The vendored SDK records its provenance** in `scripts/vendor/PROVENANCE.json`.
- **SDK contract changes**: `deleteAppCascade` keeps generative pages, unconditional writes are
  refused, and push and publish report failure by value.
- **`download-model-app.js --app` accepts a display name.**

### Known limitations

- **A classic dashboard's tiles are not recovered on download**; the download fails unless
  `--allow-lossy-download` accepts that loss.

## [2.4.2]

Fixes a malformed app module: generated apps did not actually contain their tables.

### Fixed

- **Generated apps contained an invalid `entity` table component instead of their real tables**
  (ADO 6612527), which also broke unrelated app-processing paths. Tables are now pinned by OData
  **reference**.
- **An unresolvable table halts the build, naming it**; a silently skipped one used to empty the
  app's component list.
- **App components are read back and verified after the write**; the write and `ValidateApp` both
  reported success for a corrupt app.

### Known limitations

- **Download still drops entity components not in the sitemap** (ADO 6603388); the download-side
  fix is unverified.

## 2.4.1

Bug fixes for apps built on **out-of-the-box** tables, and the matching SDK uptake. No change to
any skill's public surface.

### Fixed

- **AI app features had no effect on a newly built app**: an app-scope setting write is a no-op
  until the app is published, yet the build reported success. **`--verify` passed anyway**; it now
  proves an app-scope override row.
- **`ai.appFeatures` accepts non-boolean values** such as `2` ("on for everyone").
- **Download invented primary-name columns**, **replaced the solution's publisher prefix with
  `new`**, and **dropped tables with no sitemap entry** — all three now read from Dataverse.
- **Teardown could permanently burn an app's unique name** by stranding its sitemap; the app module
  and its sitemap are now deleted atomically in one OData `$batch`.

### Changed

- Re-vendored `cds-maker-sdk`. An injected `HttpClient` must now implement `postRaw` for the atomic
  `$batch`.
- **model-apps now runs in CI** (ubuntu × windows × macos, Node 20 × 22, plus the offline evals).

## 2.4.0

A new **`/app-builder`** skill (Preview) that builds and edits whole model-driven apps, plus
local-dev ergonomics, sample coverage, and an automated eval suite. No breaking changes.

### Added

- **`/app-builder` (Preview)**: natural-language intent → deployed model-driven app (tables, forms,
  views, charts, dashboards, generative pages, app + sitemap, sample data) via the headless vendored
  `cds-maker-sdk`.
- **Security roles per persona (`personas[]`)**, sized to each persona's jobs and associated with the
  app so it opens for non-admins.
- **`model-app-plan.md`**, a design document rendered from the spec, and **`scripts/preview-app.js`**
  to review the design before building.
- **AI-first features** (`ai` block): form fill, NL search, NL charts, M365 Copilot and row
  summaries, admin-gated by a preflight.
- **`--changed-only` partial apply (Preview, off by default)**: a page-only `.tsx` edit re-runs just
  the pages phase.

### Changed

- **Edits are first-class**: forms and views update in place, a form edit can *remove* a field, and
  a built main form becomes the entity default.
- **Identity is unambiguous**: forms resolve by `(entity, name, type)`, views by `entity|name`, and
  an app by its real `uniquename`, so a rebuild cannot duplicate or cross-wire.
- Re-vendored `cds-maker-sdk`; page generation reuses the `/genpage` worker.

### Fixed

- **Teardown removes everything the app owns** and reports cascade failures; reused/system tables
  are skipped. The **publisher** is deliberately left behind: it can own other solutions.
- **Exported solutions are self-contained**, and **the Dataverse token is never sent to another
  origin**.
- **A lossy download fails** (`--allow-lossy-download` opts in), and **CLI flags fail loudly**:
  `--apply --only` with no phase list used to run a *full* apply.

### Removed

- Standalone entity/solution scripts, consolidated into `provision-entities.js` and
  `provision-solution.js`.

### Known limitations

- **App EDIT does not re-pin a new chart**: a chart added to an existing app needs a manual pin or a
  rebuild.

## 2.3.0 — 2026-07-23

Plugin observability and authoring guardrails. No breaking changes.

### Added

- **Anonymous 1DS telemetry** (default-on, ships `disabled` until provisioned) with a local
  diagnostic mirror, a `/model-apps:telemetry on|off|status` control skill, and a CI opt-out via
  `POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT=1`. Fail-closed, with **no user-level
  identifier**.
- **PostToolUse validators**, including a `@fluentui/react-icons` allowlist check that blocks a
  hallucinated icon name at write time.
- **PreToolUse write-safety guard**: flags writes outside the cwd, only during an active genpage
  session.

### Fixed

- **Generated-page double-fetch / render flash on open**: guidance and every exemplar de-dupe
  in-flight fetches with a window cache, and `dataApi` is forbidden in any dependency array.
- **Playwright MCP launcher** exports `launch()` per the `.mcp.json` contract, avoids the npx
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

[#680]: https://github.com/microsoft/power-platform-skills/issues/680
[#705]: https://github.com/microsoft/power-platform-skills/issues/705
[#673]: https://github.com/microsoft/power-platform-skills/issues/673
[#631]: https://github.com/microsoft/power-platform-skills/issues/631
[#544]: https://github.com/microsoft/power-platform-skills/issues/544
[#559]: https://github.com/microsoft/power-platform-skills/issues/559
[#564]: https://github.com/microsoft/power-platform-skills/issues/564
[#565]: https://github.com/microsoft/power-platform-skills/issues/565
[#567]: https://github.com/microsoft/power-platform-skills/issues/567
[#572]: https://github.com/microsoft/power-platform-skills/issues/572
[#574]: https://github.com/microsoft/power-platform-skills/issues/574
[#575]: https://github.com/microsoft/power-platform-skills/issues/575
[#581]: https://github.com/microsoft/power-platform-skills/issues/581
[#583]: https://github.com/microsoft/power-platform-skills/issues/583
[#585]: https://github.com/microsoft/power-platform-skills/issues/585
[#586]: https://github.com/microsoft/power-platform-skills/issues/586
[#587]: https://github.com/microsoft/power-platform-skills/issues/587
[#588]: https://github.com/microsoft/power-platform-skills/issues/588
[#589]: https://github.com/microsoft/power-platform-skills/issues/589
[#591]: https://github.com/microsoft/power-platform-skills/issues/591
[#542]: https://github.com/microsoft/power-platform-skills/issues/542
[#545]: https://github.com/microsoft/power-platform-skills/issues/545
[#546]: https://github.com/microsoft/power-platform-skills/issues/546
[#555]: https://github.com/microsoft/power-platform-skills/issues/555
[#558]: https://github.com/microsoft/power-platform-skills/issues/558
[#560]: https://github.com/microsoft/power-platform-skills/issues/560
[#537]: https://github.com/microsoft/power-platform-skills/issues/537
[#513]: https://github.com/microsoft/power-platform-skills/issues/513
[#514]: https://github.com/microsoft/power-platform-skills/issues/514
[#525]: https://github.com/microsoft/power-platform-skills/issues/525
[#478]: https://github.com/microsoft/power-platform-skills/issues/478
[#481]: https://github.com/microsoft/power-platform-skills/issues/481
[#493]: https://github.com/microsoft/power-platform-skills/issues/493
[#494]: https://github.com/microsoft/power-platform-skills/issues/494
[#495]: https://github.com/microsoft/power-platform-skills/issues/495
[#496]: https://github.com/microsoft/power-platform-skills/issues/496
[#430]: https://github.com/microsoft/power-platform-skills/issues/430
[#447]: https://github.com/microsoft/power-platform-skills/issues/447
[#455]: https://github.com/microsoft/power-platform-skills/issues/455
[#456]: https://github.com/microsoft/power-platform-skills/issues/456
