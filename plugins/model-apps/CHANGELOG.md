# Changelog

All notable changes to the **model-apps** plugin.

Entries are deliberately short: what changed and why it matters to you. The reasoning,
evidence and trade-offs behind a change live in its PR, in `docs/`, or in the linked issue.

## [2.14.0]

The Notes timeline renders, a related-records grid can be placed where you want it, lookups are labelled with the table
they point to, and view filters resolve choice labels against the environment. Generative pages are checked for style
shorthands their styling engine drops, their `pac` calls are time-bounded, and more navigation-call shapes build while a
few that were misread are now refused. The bundled SDK is current, an unchanged rebuild sends a fraction of the writes it
used to, builds send fewer requests, and verify, download and `check-auth` do more of their work in parallel.

### Added

- **`subgrids[]` placement** (AB#6651699). An entry takes `tab`, `column`, `after` and `before`, to put a related-records
  grid between sections, in a tab of its own, or in a form column. A rebuild moves a grid an earlier release appended
  after the Notes section so it sits beside its section; only the grid moves, and fields the same build adds still land
  in their own sections. `--verify` checks the placement, and the wireframe and the plan show it. Listing a table twice
  in `subgrids[]` is an error when an entry places it, and a warning otherwise (only one grid per relationship is built).
- **`primaryAttribute.maxLength`** (a whole number from 1 to 850) sets a new table's name column; it was ignored before.
  Without it the table is created exactly as before, asking 100 characters for the name column, so the name column comes
  out as it did before on every environment. An existing table's name column is never changed; a length the platform did
  not apply is set as the last step of the data model, or reported as a failed step.

### Changed

- **The bundled cds-maker-sdk is current.** Through it:
  - a Main form create whose answer was lost on the network is recognised when the retry is answered 412, and adopted
    when it is exactly what the build sent, instead of halting with "already exists" until the workspace is reset (other
    form types, and a retry answered otherwise, still halt as before);
  - a form, publisher or view create that a database deadlock rolled back is re-sent by the SDK as well, beyond the
    build's own re-sends, and so is an app delete that met the platform's search-index race;
  - a form or dashboard id that belongs to the other kind of record is refused when it is read, written or deleted, with
    a message that says what it found, and a push can no longer change a form's type;
  - the routing description of an existing app is saved only on top of the version the build read, so a failed read can
    no longer overwrite someone else's change (the app's name, description and icon are set when it is created);
  - reads of tables, columns, relationships and choices ask Dataverse for its latest definition (`Consistency: Strong`),
    which costs each such read about 10% more;
  - removing a row summary whose AI model another component still uses keeps the model and succeeds.
- **`/genpage` finds the environment's languages with a plugin script.** Instead of `pac model list-languages` it reads
  the base language and every provisioned language with your Azure CLI sign-in and reports each language's code and
  whether it is written right-to-left; a language the plugin does not recognise keeps its number and is flagged, never
  guessed. Without a usable Azure CLI sign-in, `/genpage` falls back to `pac model list-languages`, now pinned to the
  environment it plans for with `--environment` (2.13.0 asked pac's active environment), and says so.
- **An app folder stays with the environment it was built against.** A build from a folder built against another
  environment stops before writing anything, names both environments and lists the ways forward, including the folder a
  teardown would clear. The same environment under its `.api.` host name is reported as such, with the host to run again
  with. A dry run never takes over the folder, and verifying an app on its own (`verify-model-app.js`) no longer opens the
  app folder's workspace, so it can check any environment the app is deployed to and leaves the folder untouched.
- **AI features saved before the app is published** are published and then proved, instead of written twice; one still
  not in force is reported `NOT YET PUBLISHED`, never applied.
- **An unchanged rebuild sends far fewer writes.** Views and forms the spec authors are no longer re-sent when they have
  not changed, the solution's membership is read once so only the components it lacks are added, and with `--publish` the
  tables a rebuild touched are published together instead of once per view and form (on a sample app with every
  artifact type: 25 writes instead of 59, 3 publishes instead of 10; the generated default views, the default form, app
  settings, role privileges and the app's navigation are still written on every rebuild). The tables of the existing
  views and forms a rebuild reconciles are published before the app is, because publishing the app first would leave
  any new labels on them unpublished; if that publish is refused, the build stops before writing the app (and runs again
  at once when the refusal is transient). When a publish fails or cannot be confirmed, the warning names the views,
  forms and charts on each table that are saved but not live — the generated default views and what a first build
  created included — instead of a bare form, view or chart id.
- **Faster runs.** Verify runs its checks four at a time and downloads page code in one `pac` run per 25 pages;
  `check-auth --env` runs its probes together; download reads each table's labels, option sets and relationships in
  parallel (the files it writes are the ones a read of one table at a time writes); teardown publishes all default-view
  resets once; a new table's ordinary columns (up to 25) are created in one request after the table instead of one
  request each, column for column as before — if the platform refuses that request nothing is created by it and the
  build creates them one by one, with a warning that says why; a request refused because the table is still busy (HTTP
  429) is sent again first, and one whose answer was lost is checked against the table before anything is created again.
  A verify that fails ends any `pac` run it started and removes its temporary download folder.
- **Generative-page `pac` calls are time-bounded, and a page upload whose outcome is unknown is not retried.** A `pac model genpage`
  call (list, download, upload) that outlives its budget (`POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS`) is stopped together
  with everything it started — on Linux and macOS each process only after its start time is read again, which makes ending an
  unrelated process that took over the id of one that exited far less likely (not impossible). A timed-out update says it may
  have landed and how to check; so does an update that fails, which is no longer retried — `pac` can fail while publishing,
  after it has written the page and recorded its prompt, so a retry could record the prompt a second time — unless `pac`
  refused its own arguments or files. A timed-out create says the page may exist, or that it was created as `<id>` when `pac`
  printed the id, and how to finish it. A create whose outcome is not known to be nothing — it timed out, failed after
  `pac` printed its id, or left a page in the listing — is never sent again, not even by the build's own retry of a
  transient failure; a create that failed outright and left nothing behind is retried as before.
- **Updating a generative page also checks the other apps' unpublished navigation** — each app's saved navigation and
  apps that were never published, including a sitemap linked to an app by its name. A page one of them holds stops the
  update and names the app; a never-published app with no navigation does not. The check runs again right before the
  first page is written in place and once after the last: a page another app takes in while the build runs stops it
  before any page it began with is updated in place, or, if it lands while the pages upload, is reported with the app that holds it.
  A page the build itself created is left out of both.
- **The record of what a build applied is the page source it read and checked**, so a page saved while a build runs is
  checked by the next build instead of being found unchanged.
- **More pages with a hint in parentheses resolve their navigation calls.** JSX text in parentheses that holds an `=`, a
  `[` or an `@` followed by a `/`, a `<` or a back-tick — `<p>(a = b/c)</p>`, ``<p>(x = y, `code`)</p>``,
  `<p>(@user/repo)</p>` — or that has a link on the next line, is read as the element it is in, so the navigation call
  after it resolves where 2.13.0 refused the page; such text no longer needs the expression container 2.13.0 suggested.
  `return (navigateTo)({ … })` builds too.
- **A few pages that 2.13.0 resolved are now refused, naming the guess `generic`.** This happens where such a hint stands
  where a member of a type could also begin — after `return`, `?` or another keyword, or after a separator — and one of
  its lines ends unfinished before a `//` note (an open bracket, an `=` or an operator), with a later line that starts
  with `/`: the text up to that `/` can also start a type whose regular expression holds the element's closing tag.
  2.13.0 took the end of the note for the token before the `/`; the build now refuses instead of guessing. Moving the
  navigation call before the hint, or ending the line with a word before the `//`, avoids the refusal. The same applies
  to an element whose text holds a nested element with a quote, a back-tick or `//`, followed by a string that holds the
  element's closing tag.

### Fixed

- **The Notes timeline renders** ([#680]). It is written the way Dynamics shows it — control id `notescontrol` in a tall
  cell over the empty rows it spans — instead of a one-row cell that published but never appeared. A full build (not
  `--changed-only`) repairs an older Notes section in place, after taking out of it any field the layout removes or places
  elsewhere; a timeline you resized is left alone, and a section still holding a control the build does not move is left
  and reported. `--verify` fails a form whose timeline would not render and says what to do: run a full build where the
  build takes the stray fields out itself, which control to move in the maker where it does not — and where it cannot
  tell (a field placed on the form more than once, or anchored to one) it says so.
- **Lookup columns are labelled with the parent table's display name** (AB#6691205). A relationship with no
  `lookup.displayName` now labels the lookup column — and the form field that carries it — "Project" instead of the
  logical name `new_project`: from the declared parent table, else from the environment (an `existing: true` `incident`
  is "Case"), in every language the label is written in. A rebuild relabels a column or form field still carrying the old
  default — each cell of a field the form holds more than once; it never changes a label you set. A download leaves out a
  label equal to that default.
- **View filters resolve choice labels against the environment** (AB#6691114), including a column of an existing table
  the spec does not declare (`account.industrycode`) and a global choice that already existed, instead of being sent to
  Dataverse as text or as the spec's own position number. A label that matches no option stops the build, listing the
  valid ones, before any view is written (and before anything is written where the environment already shows it; a spec
  with a localized label is checked after its tables and columns are written). An option a maker renamed still resolves
  to the spec's number, as in 2.13.0, now with a warning; the build stops instead where the environment shows the options
  are numbered otherwise — for example options inserted into the spec after the column was built, which 2.13.0 silently
  bound to whichever option held that number — and says why. A view that already exists keeps its filters; where 2.13.0
  built one on an option the environment numbers otherwise, `--verify` now reports it.
- **Quick View sections stay one column**, as Quick Create sections already did. A field-heavy Quick View section got two
  columns, which the platform refuses for this form type, and the build failed part-way.
- **A page keyed like a Windows device name** (`con`, `nul`, `aux`, `com1`, …) is handed to `pac` as a file: the build's
  copy of each page it uploads is named `page-<key>.tsx`, which Windows never reads as a device, where 2.13.0 named a
  navigation page's copy `<key>.tsx`.
- **Generative pages are checked for the style shorthands Griffel drops** (AB#6691124): `all`, `borderColor`,
  `borderStyle`, `borderWidth`, `borderBlock*` and `borderInline*` in `makeStyles`, which deployed silently without their
  style. A build stops before the pages phase writes anything for a page it creates or whose source changed since the
  last recorded build, and only warns for a page it sends again unchanged; `/genpage` refuses a create, or an update that
  adds such a key or changes its value. `node scripts/check-griffel-styles.js --file <page.tsx>` lists each key and the
  longhands to write. A style object the check cannot see — passed in (`makeStyles(styles)`), given to a slot or a
  selector as a variable, or spread in (`...base`) — is reported too, and so are a key computed from an expression
  (`[key]: …`) and a getter that runs on a style object (`get color() { … }`), whose code the check does not read;
  all are held like a call the check cannot read, and Fluent's own `shorthands.*(…)` helpers and
  `typographyStyles.*` entries may be spread (`shorthands.transition` with one argument only as an array, a string or
  a number written in place). What is uploaded is what was checked: the build sends every page from a copy of
  the bytes it checked, and `genpage-upload.js` reads the page once and uploads a copy of those bytes, so a save to the
  file while either runs is not sent unchecked. `genpage-upload.js` no longer takes `--compiled-code-file`, whose
  JavaScript `pac` would deploy instead of the checked page.
- **A `PAGEREF_` token in a string, template or regular expression of a page's types is no longer rewritten** in shapes
  2.13.0 misread: a nested element in a parameter default or a computed name whose text holds a quote, a back-tick or
  `//` (two on one line included); a regular expression on the line after a `//` note that follows an open bracket, an
  `=` or an operator in a type; and an accessor whose computed name holds one (`get [a, // note`, a line break, then
  `/…/]()`). Such a page is now refused, naming the guess, instead of being deployed with the string changed.
- **Connector discovery reads `pac connection list` as `pac` prints it**: an environment with no connections reads as
  empty, and output the reader does not recognise is refused instead of being read as empty.
- **`dataverse-request.js` keeps its path under the Web API root** ([#705]). A path whose `..` segments — written
  plainly, percent-encoded or joined by an encoded slash — would leave `/api/data/v9.2/` is refused before a token is
  read.

[#680]: https://github.com/microsoft/power-platform-skills/issues/680
[#705]: https://github.com/microsoft/power-platform-skills/issues/705

## [2.13.0]

An app's hidden tables and its list of Main forms now survive a download and rebuild, and
relationships that share a name are caught. A generative page edited in the maker portal is no longer
overwritten silently, and page cleanup removes only pages this workspace can prove it created. Spec
sources and output files stay inside the folders you name, and a few transient platform responses
are now retried without risking a duplicate. A generative page's navigation tokens are rewritten only
where the build reads its code for certain.

### Added

- **`app.tables`** — tables that belong to the app outside its navigation (AB#6603388). A download
  writes them, so a rebuild keeps them. A build adds them as app components, and `--verify` checks
  the published app. A hidden table owned by another solution is listed here only, never in
  `entities[]`.
- **`app.mainForms`** — for each navigation table, the Main forms the app offers, by name. The build
  resolves each name before any app write, and refuses one that is ambiguous, inactive or missing. The
  platform only adds forms to an app, so an existing app keeps a form it already offered: the build
  warns, and `--verify` names the form and the Maker step that removes it. A download writes the list
  when the app offers only some of a table's forms.
- A download that writes either field sets `minimumPluginVersion` to 2.13.0, and lint warns when a
  spec uses one without that floor.

### Changed

- **A generative page update checks the deployed page first** ([#673]). An upload records a base
  marker beside the code file (hashes and ids only). An update stops when there is no base, when the
  deployed page changed since the base (it writes a copy and a line summary), or when the deployed
  page cannot be read. Pass `--overwrite-deployed` only after choosing to replace the maker's changes;
  `/genpage` asks first and stops when nobody can answer.
- **Page cleanup acts only on pages this app can prove are its own**: a local receipt written when
  the build created the page, or the app's navigation, published or saved. A page that only the stored
  page manifest lists is kept and reported; when the proof cannot be read, the app is left intact for a
  re-run. `--clear-workspace` refuses while a receipt remains. A rebuild updates a page only when the
  app's published navigation or a receipt proves it; a page only in the saved navigation asks you to
  publish the app first.
- **An uncertain page create stops.** When a create fails or reports no page id but a new page
  appeared, the build lists each candidate's name and creation time instead of adopting one. A create
  that left no page is retried as before.
- **A business rule or AI model that only shares a name is reported, not deleted.** Cleanup removes
  only the records this build created.
- **Edit plans treat earlier prompts as data.** The edit planner no longer copies them into the plan,
  and the written plan must carry the same ordered change list the user approved.
- **Navigation tokens are rewritten only where the build reads the code for certain.** A `PAGEREF_`
  token is allowed only as the double-quoted `pageId` of a `navigateTo` call whose options object is
  written inline, optionally followed by `as const`, `as Name` or `satisfies Name`. A token anywhere
  else — a comment included — halts the build with the rule quoted. Where code before a call can be
  read two ways (a `/` or `<` that may begin a regular expression, a JSX element or a type), calls after
  it are not rewritten: the build halts naming the line, the reason and what to change. A page that
  still holds a token after resolution is refused before anything is uploaded.
- **Download writes a `PAGEREF_` token back only where a rebuild accepts it.** Otherwise the page
  keeps its ids, and the download warns, naming each line.
- **Build and download skip an unused identity read** after a successful sign-in check: one cold
  Azure CLI start less per run.

### Fixed

- **Relationships that share a schema name are caught.** A 1:N and an N:N between the same two tables
  derived the same name, so the N:N was skipped as if it existed and `--verify` passed. Validation now
  asks for an explicit `schemaName`. The build reuses an existing name only for the same type, ends and
  lookup, and `--verify` checks a relationship's type and ends. A download keeps a deployed name that
  differs from the default.
- **A field placed with `fieldOptions.after` no longer overflows its row.** A row that would be too
  wide moves its trailing cells to rows directly below, and a row an earlier release left overfull is
  repaired once. A new field lands at its listed position. All moves of one placement are written in
  one update, so a failure leaves the old layout, never half of the new one. `--verify` fails a form
  that repeats a cell or control id.
- **A view rejected for a lookup the build just created is retried.** Right after a relationship is
  created, a view that uses its lookup can be refused for a column the server cannot see yet. The build
  now retries that, but only for columns it creates; an undeclared column still stops at once.
- **A parallel phase that fails waits for its other writes** before it reports. The retry used to run
  while a write was still pending, created the same view again, and then stopped on the duplicate.
- **A response cut off mid-way is never re-sent as a create.** It used to leave the request waiting
  forever, or be retried; a create in that state is now reported as possibly applied rather than sent
  again and duplicated.
- **Output files stay in the folders you name.** Download, build, verify and the spec document refuse
  a link or junction at an output name and write through a temporary file and a rename.
- **Spec sources stay in the app folder.** A web resource's `contentPath` and a page's code file must
  be a regular file inside the app folder; a link that leads out is refused before anything is written.
  A `contentPath` behind inline content is not read, so it is not checked, and teardown accepts an
  older spec's path.
- **An app missing from its solution is re-added.** A build that stopped after creating its app left
  the app outside its solution, and a re-run did not add it back. The app now joins its solution right
  after it is created, and every rebuild re-adds it.
- **A navigation literal inside an expression is no longer rewritten.** A `pageId` such as
  `"PAGEREF_detail".slice(8)` halts as malformed instead of having its literal replaced, which changed
  what the expression computes.
- **A string continued with a backslash at a CRLF line end** is read as one string, so a valid page is
  no longer refused.
- **A `PAGEREF_` token inside a regular expression, a string or a comment is no longer rewritten in
  rare shapes the check used to misread.** These are:
  - an element right after a `/`;
  - an element whose text opens with a parenthesis and whose attribute value ends in a backslash;
  - an element written as an attribute value (`x=<B/>`);
  - a self-closing tag with white space between its `/` and `>` (`<B / >`);
  - a closing tag that holds a comment with a `>` in it;
  - a regular expression whose flags spell a keyword (`/x/in`);
  - an `if` or `while` whose keyword is separated from its `(` by U+0085 or U+200B, which TypeScript
    treats as white space;
  - a generic generator function, `function* <T>(…)`;
  - a generic call signature with no return type (`interface I { <T>(x) }`);
  - a generic call signature followed by a member name quoted right after `public`, `private` or
    `protected` (`public'…'`), or by a regular expression right after `implements`;
  - a generic call signature whose parameter list holds a default value, a computed name, a decorator,
    an import type, an accessor's body or a type parameter's constraint (`<T>(a = /[)]/)`), or a
    template nested in another or holding JSX;
  - a type parameter whose constraint is a regular expression (`<T extends /…/>`), which begins like
    the self-closing tag `<T extends />`;
  - a `#!` line at the start of the page.

  Such a page now halts, naming the line. So does an attribute value written after white space that
  follows its `=` and holds a backslash, which TypeScript and other compilers end in different places;
  an element whose first attribute is named `extends` and closes at once (`<T extends />`); and JSX
  text that opens with a parenthesis and holds an `=`, a `[` or an `@` (or, rarely, a type keyword
  such as `import`) followed by a `/`, a `<` or a back-tick before its `)`
  (`<p>(a = b/c)</p>`), which a call signature's parameter list can share; write such text inside an
  expression container (`<p>{"(a = b/c)"}</p>`) to keep the page building.
- **A navigation call after a generic generator function (`function* <T>(…)`) is now found.** The build
  refused such a page with a navigation parity mismatch.
- **Connector discovery refuses output it cannot read.** Text on stderr after a successful exit, a
  line before the table header other than PAC's sign-in banner, a header that is not a known column
  set, a lone carriage return, or a row whose id is not a connection id no longer reads as an empty
  or extra connection.
- **Packaging checks a connection reference's id before any write.** A `connectionreferenceid` that is
  not a GUID is refused before anything is added to the solution.
- **Nested navigation calls are read in linear time.** 512 nested calls took 0.55 s to check and now
  take 5 ms; 8,192 nested malformed values took 143 s and now take about 0.1 s.
- Samples 9 and 10 use the double-quoted `PAGEREF_` form the build accepts.

[#673]: https://github.com/microsoft/power-platform-skills/issues/673

## [2.12.1]

- **Usage telemetry is on.** The plugin sends a `skill_started` event when a skill starts, routed to
  the collector for your cloud; an unrecognised cloud sends nothing. Org and tenant ids are sent, never
  the user's id. Turn it off with `/model-apps:telemetry off`, or set
  `POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT=1` for automation.

## [2.12.0]

Fixes from a retest of 2.11.0: an existing form converges to its layout's order and `--verify` checks
more of it, a generative page keeps its name and model on update, and several readers refuse output
they cannot read instead of guessing. A `--publish` build publishes in fewer requests, with the refreshed
vendored SDK.

### Added

- **`pages[].model`** — the model id a generative page was generated with. A download writes it and
  the build sends it with every upload.
- **`POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS`** — how long an Azure CLI call may take (default 60 s).

### Changed

- **Faster `--publish` builds.** The final publish sends every table and the app in one request,
  and the enriched default views wait for it instead of publishing each table on the way: on a
  three-table app, 8 publishes became 3 and the build took 152 s instead of 172 s. A build that stops
  before its end still publishes the default views it had enriched, once no automatic retry follows.
  A failed publish of them is now a warning naming the re-run, like any other, rather than a stop
  before the forms are built; a default view someone edits while the build writes it now stops the
  build, as any concurrent edit does, instead of being skipped.
- **The vendored SDK is refreshed.** A build that changes an app's routing description no longer
  stops with `app-header-unpublished` when the app holds an unpublished change to its name or
  descriptions: it saves alongside that change. Only a never-published app must be published first,
  and a concurrent edit is reported as one. On an org whose base language is not English, a new app
  gets its System Administrator role, and the inactive default view is enriched too.

### Fixed

- **A field moved into a narrower section fits it.** Moved without a `colspan`, a two-column field
  kept its width in a one-column section, and the build wrote a layout `--verify` then failed. It
  keeps its width only where it fits, and is narrowed — and reported — where it does not.
- **Tabs and sections are put in the layout's order** on an existing form, with the fewest moves. A
  build used to create and move them but never reorder them, and a new tab placed between existing
  ones took over the next one, which then came back as a duplicate.
- **`--verify` checks more of a form**: tab expanded and visible state, form-column widths, section
  visibility and label display, fields' `hidden` and `readOnly` (an auto layout's too, failing a
  flagged field the form no longer carries), and the order of tabs and sections. A form that differed
  in any of these passed. It also reads a field's state, span and section from the field itself, never
  from a quick view bound to the same lookup. Lint warns when an auto layout flags a field it does not
  place, since the build never applies that flag.
- **A generative page keeps its name and model on update.** An update without a name renamed the
  page to its navigation title, and one without `--model` stored the model empty. `genpage-upload`
  now reads both from the deployed page and sends them again (a name a `pac.cmd` shim cannot receive
  is left out, with a warning), and a download → rebuild keeps the model. A name with a straight
  double quote is refused — pac stores each one as `\"`, in the navigation title too — and
  `/app-builder` lints one in `pages[].name`. A download no longer copies pac's backslashes into
  `pages[].name`, where each rebuild added another.
- **Generative-page navigation parsing** is linear — a 2.5 KB page of nested template literals took
  1.4 s, and a long comment inside one navigation call seconds more — and no longer rewrites a name
  that only resembles a navigation call, misses an optional call (`?.`), misreads a property override
  or a Unicode line terminator, or reads a word in a comment as a property.
- **Adding pages to a solution checks every id first.** A malformed page id was refused only after
  the app had been added; nothing is added now until the app and page ids are valid, and a repeated
  id is sent once.
- **Connector discovery refuses output it cannot read** — a warning, a changed format — instead of
  reporting no connections, rejects malformed identifiers, and no longer reads a table's dashed
  separator as a connection. The connector agent never creates a connection after a failed discovery.
- **A slow Azure CLI or PAC is reported as slow.** A token request that ran out of time was reported
  as `az` missing or signed out; it is now `az_timeout`, with the time it was given and a longer budget
  to try — never more than the 15-minute maximum. A `pac org who` slower than its fixed 60 s is
  `pac_timeout`, to retry, not `pac_not_logged_in`.
- **Lint no longer warns about a view, chart or form name used on two tables** — only a repeat on
  one table collides.
- **A re-run of a failed teardown finds the generative pages it left.** When teardown could not delete
  a page, or could not read which pages the app authored, it still deleted the page manifest — the
  only record of them — so a re-run reported success and the pages stayed behind. The manifest and the
  solution are now kept until the pages step succeeds.
- **`capture-fixture.js` no longer passes an eval it could not verify.** A runner that exited with an
  error but no failing assertion, or reported no assertions at all, was summarized as clean; each is
  now listed as a failure, with the runner's exit code.

## [2.11.0]

AI features are written with each setting's own values, rebuilding an existing app no longer
rewrites its navigation, a table opens with the form the spec makes its default, and the vendored
SDK is refreshed.

### Added

- **`entities[].mainFormOrder`** (AB#6736948) — a table's Main forms in the order they are offered,
  first to last; the first is the one the table opens with. Works on existing tables.

### Fixed

- **A table opens with its default form** (AB#6736948). What opens is decided by the order of a
  table's Main forms, not the default flag, and new forms all share one position — so a table with
  several Main forms could open with an alternate one. The build now also puts the default form
  first, and `--verify` checks the order. `isDefault` on an existing table used to be ignored; a form
  the build adds to an existing table now goes after its other Main forms.
- **A teardown no longer stops when Dataverse is busy.** A delete refused with 429 (another
  customization still running) is re-sent like other throttled requests; the solution delete that
  ends a teardown used to fail and leave the solution behind.
- **Download reads what is deployed.** It no longer reads through the folder's `.maker-workspace`,
  where a copy an interrupted build left could make it fail or return edits never deployed.
- **Rebuilding an existing app keeps its navigation as it is** (AB#6726727). Every nav entry was
  rewritten as a new one, so an unrelated edit turned a designer-made dashboard entry's icon into a
  placeholder and dropped its other settings. Entries now keep their id and everything the spec does
  not describe; dashboard entries carry the designer's launcher Url, and `--verify` fails one without
  it.
- **A nav title or icon changed in the designer after a download is kept**, with a warning, instead of
  being reverted by the stale spec. Download records the spec as a baseline for that environment.
- **A dashboard renamed in the designer** is reused by the id a download now records
  (`dashboards[].dashboardId`); it used to be recreated under the old name.
- **AI feature values** (AB#6714731). `true` wrote `1` outside the form-fill family: *Off* for
  natural-language grid search and M365 Copilot, *Auto* for NL charts, and `--verify` expected the
  same. `true` now writes `2` (*On*) for every feature, so the next build of an AI-enabled app turns
  NL grid search back on. `false` writes that setting's *Off*: `1`, or `0` for NL charts.
- **`ai-preflight`** no longer shows ✓ for an app with M365 Copilot off, and reports NL charts' *Auto*
  as the platform default rather than on.
- **`appShell` keys the build does not read are errors** ([#631]). A `title` on an area or group (they
  take `label`) used to deploy an untitled one while lint, the build and `--verify` passed.
- **A SQL deadlock no longer fails a delete or a build.** A request SQL rolled back as a deadlock
  victim is re-sent (up to three times): a record delete, or an app delete's change set, by the
  plugin; a read, an app create or a publish by the refreshed SDK. A build that halts on one runs
  again like one that halts on a SQL timeout; a teardown used to stop on it.

### Changed

- **The vendored SDK is refreshed.** A workspace saved by an earlier version is re-read on the next
  build; a copy an interrupted build left holding unpushed edits halts it and names the step to take.
  A remedy that asks you to clear `.maker-workspace` now says to stop other runs on it first and to
  keep `last-applied.json` and `destructive-approval.json`.
- **An explicit `false` for NL grid search or M365** now writes *Off* (`1`) instead of the platform
  default (`0`). A spec that omits `m365` still leaves it at `0`.

[#631]: https://github.com/microsoft/power-platform-skills/issues/631

## [2.10.0]

Connector authoring loses its feature flag, `--allow-destructive` removes only what a maker was
shown, and the vendored SDK is refreshed.

### Changed

- **The `connectors` feature flag is removed**, with `GENPAGE_ENABLE_CONNECTORS`: it was on by default
  for a release with no rollback needed. Connector authoring stays in public preview. An unknown flag
  now stays off even when a matching env var is set.
- **Faster preflight and `/genpage` updates.** `check-auth` overlaps its CLI cold starts (24–32 s →
  16–19 s on Windows), scripts reuse one `az` token per process, and an update's two target checks
  run together (10.6 s → 5.6 s).
- **The vendored SDK is refreshed.** *Contains data* and *does not contain data* conditions in
  business rules are sent in the shape the platform's designer writes, and the bundle stays under 1 MB.

### Fixed

- **`--allow-destructive` removes only what a maker was shown.** A refusal records its list in
  `.maker-workspace/destructive-approval.json`; the approved re-run halts, naming the new ones, if
  anything else would now be removed.
- **`prune: false` forms** no longer report, or demand approval for, removals that never happen.
- **Switching a table's default Main form** clears the old default; verify fails while two hold it.
- **Row-spanning cells** count wherever the build fits a layout, and a removed field no longer leaves
  an empty form row.
- **A `/genpage` update must name the page's own app**; another app's id used to rename the page.
- **Non-ASCII text** split across response or hook chunks is no longer turned into U+FFFD.
- **pac on Windows**: a path ending in `\` no longer swallows the next argument, and a malformed page
  listing or page id is no longer trusted.
- **Navigation keys**: a quoted key resolves like a bare one, a duplicated key counts where it takes
  effect, and a target a later spread could replace is refused.
- **Downloads** refuse a malformed page `dataSources`, keep a page prompt's exact text, and read past
  1,000 components.
- **The version check** no longer fetches your project's repository.

### Removed

- Dead helpers, and duplicate copies of shared ones.

### Documentation

- Corrected what a rebuild re-applies to existing artifacts, what `--verify` proves (it does not catch
  a removed view column), and BPF security-role grants. A page's connector and Custom API bindings
  survive only a same-environment rebuild. The telemetry disclosure matches its shared source again.

## [2.9.0]

A dry run that says what an apply would really do, sample data that can express a hierarchy, and
downloads that round-trip Choice columns.

### Added

- **`app.aiDescription`**, a routing description agents read to choose between sibling apps
  ([#583]). It is written, downloaded and verified; leave it out and the deployed value is untouched.
- **`personas[].excludes[]`** records what an app deliberately leaves out ([#583]).
- **Richer form layouts**: multi-column tabs, cell `colspan`/`rowspan`, and
  `expanded`/`visible`/`showLabel`.
- **A live dry run** marks each item create, reuse or unknown ([#559]); `--no-live-plan` keeps the
  offline listing.
- **Hierarchies in sample data**: `$parent` may target the row's own table ([#544]), and
  `$parent.lookup` is now required when two relationships connect the same pair.
- **`minimumPluginVersion`** refuses a spec newer than the plugin.
- **The vendored SDK uses injected storage** (`createNodeWorkspaceStorage`), a breaking change only
  for library callers.

### Changed

- **`/app-builder` is GA**; `--changed-only` stays experimental and off by default.
- **Connector authoring is on by default** (public preview); the `connectors` flag stays for one
  release as a rollback switch.
- **The App Spec schema is split** (the always-read half is 82 KB, down from 105 KB), and every script
  shares one CLI flag contract.
- **`write-page-plan.js` no longer takes `--out`**; it writes only a plain file in the working
  directory.

### Fixed

- **Forms**: an explicit layout reshapes a form instead of flattening it ([#575]); a named section
  moves to the tab the spec puts it in; spans converge against the live grid ([#581]) without breaking
  a maker's row-spanning layout; the wireframe shows `hidden` and `readOnly` fields ([#591]).
- **Business rules**: `dataType` reaches Dataverse as a real type. Rebuild any app whose
  `businessRules[]` were built on an earlier release.
- **Verify** checks form layout, sort precedence, sitemap-table membership, the default Main form,
  view filters and app roles, and judges spans by the build's own rules.
- **`/genpage`** deploys through the quoting-safe upload path ([#589]), keeps multi-line prompts
  ([#565]) and a page's bindings on update, refuses to update a page that does not exist, runs only
  the approved plan ([#585]), catches truncated pages, and checks page file names before any worker
  writes ([#588]).
- **Page listings, page ids and PAC errors** are parsed strictly, so a page name cannot forge a
  listing and PAC's real error is reported.
- **Icons and navigation calls are checked from code, not prose** ([#585], [#588]), and right-to-left
  layout follows PAC's RTL column rather than a fixed list of languages ([#585]).
- **Downloads** round-trip Choice columns ([#564]), relationships ([#567]) and page table bindings,
  invent no columns ([#574]), pass their own lint ([#572]), and pick an app's solution
  deterministically ([#587]).
- **Dashboards**: same-named charts on different tables no longer cross-wire a tile, and a dashboard
  belongs to an app through its solution ([#586]).
- **Teardown and workspaces**: `--clear-workspace` deletes only a real workspace; teardown stops when
  the app delete fails, keeps a downloaded spec's relationships and choices and any security role whose
  sharing check cannot be read, and fences in-flight `--changed-only` runs ([#587]).
- **Links**: `generate-page-manifest --force` refuses to write through a symlink or hard link, and
  `genpage-upload.js` refuses an input file that is a link, a hard link or a folder.
- **Writes**: a slow one is waited for (up to 5 minutes) rather than re-sent.
- **Validation**: a mistyped flag fails instead of changing the command, and sample data is checked
  before anything deploys.
- **The vendored SDK is refreshed** (including `@xmldom/xmldom` 0.8.15); an app with an unpublished
  sitemap edit can now be torn down.

### Known limitations

- **Choice option values do not round-trip**: labels and order do, and a fresh rebuild re-bases the
  values to `100000000 + index`.
- **An existing view's authored filters and sort are not re-applied** by a rebuild.

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
- **The role-privilege read uses the SDK's `getEntityPrivileges`**, with no behaviour change.

### Known limitations

- **A single-language label loses its LCID on download.** Pin `languageCode` before a
  cross-organization rebuild.

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
