# Changelog

All notable changes to the **model-apps** plugin.

Entries are deliberately short: what changed and why it matters to you. The reasoning,
evidence and trade-offs behind a change live in its PR, in `docs/`, or in the linked issue.

## [2.18.0]

The bundled SDK is updated to power-platform-ux a3443479. An app whose sitemap's unique name is not the app's — first-party apps
such as Sales Hub have one — is now read with its navigation (#746), and a web resource write is confirmed by reading back what was
published. A new app whose navigation holds only generative pages can now be built, a download carries each page's connector and
Custom API bindings and much more of each table's schema into the App Spec, and verify checks declared status reasons and alternate
keys. Supported public Custom APIs are discovered by default. The HTTP client no longer re-sends a publish the customization lock
refused, a web resource or dashboard that a stopped build left behind is finished by the next build instead of made again, and an
unknown key in a form's `fieldOptions` is refused instead of ignored. An access token is now also kept out of bytes, out of its
other spellings, and out of text cut short or split between two writes.

### Added

- **A new app whose navigation holds only generative pages is built.** Dataverse refuses to create a sitemap with no entry, so the
  build refused such a spec before writing anything (`app-navigation-empty`), and lint warned about it. The build now creates the
  pages first and then the app, with the pages already in its first sitemap — the order `apps.js create --page-id` uses: the app step
  says `created after its pages`, and the app's create is reported in the app-shell phase. A build that stops between the pages and
  the app is finished by running it again (the pages are adopted by their creation receipts, not created twice), and a teardown
  removes the pages it made. An app that exists is not affected, and its requests are unchanged. A run that cannot create the pages
  first — no pages phase, a `--changed-only` re-upload, a page entry whose page the run does not build — still refuses, and says
  which.
- **A download writes each generative page's connector and Custom API bindings into the App Spec, and a rebuild writes them back**
  (`pages[].connectorBindings`, `pages[].actionBindings`). A copy of a spec rebuilt in another environment used to create its pages
  without them. A list is written into the spec only whole, and only when every property is a documented one and every value has a
  shape known to be safe — an identifier, a GUID, a plain name or label, a canonical `http(s)` URL with no user-info, query or
  fragment, nothing shaped like a token, and for a Custom API only the ten primitive parameter kinds the runtime binds. Any other list
  is left out of the spec, named by page, list, entry and property (never by a value), and stays on the page; a spec that states one
  is refused. A secret written as plain words in a label cannot be told from a label. A list the spec does not state is not sent, so
  the page keeps its own, and `[]` clears it. When a page already holds what the spec states and this workspace has a usable record
  of its last publish, the build neither writes nor publishes it; a record from before the spec stated the lists counts only once
  the page's published copy is read and found to hold them, and with no usable record the page is published (not written), as an
  unchanged page always was. Before it writes anything (and in a dry run), a build reads the target environment's connection
  references and Custom APIs, and the definition of a custom connector whose operations a binding calls: it stops
  (`pages-binding-reference-conflict`, never retried) at a connection reference of that name for another connector; it names a
  reference or Custom API that is not there, a reference with no connection, an operation the custom connector there does not
  define, and a Custom API of the other kind or bound to another table. A read that fails, a reference row that does not say — in a
  form the build can read — its connector, its connection or its custom connector, and a definition it cannot read are reported as
  not checked, never as compatible; a Custom API row is taken as it reads (a kind it does not state counts as an Action, a table it
  does not state as Global). A throttle wait the run's budget refuses during these reads stops the build before it writes. The
  download's `pageBindings` result and a `NOTE:` on stderr list what the target must already have: the connection references and
  their connections, the Custom APIs and the service resources the bindings point at.
- **A download keeps much more of each table's schema**: Text format and length, Memo length, Integer range and format, Decimal and
  Double range and precision, Money range, Boolean labels, DateTime format, AutoNumber masks, and the primary name column's length
  (written even at 100, so a fresh build corrects an environment that overrides it; a lookup to that table made before the correction
  keeps the overridden length on its name column) and mask; custom unmanaged Active and Inactive status reasons with their values and
  colors, labelled in the download's authoring language; alternate keys with their columns and labels; solution and global-choice
  display names; dashboard tile sizes; and a table's own unmanaged SVG icon, carried as `external: true` so a teardown of the
  downloaded spec never deletes it. Values equal to the build's defaults are left out. A Money column's precision is kept only when it
  follows the transaction currency, the only kind the build creates; for another source the download says so and leaves it out. A
  detail it cannot read is named on stderr without dropping the column or table or guessing a default, and a status reason with no
  label in the authoring language is named and left out. It is still not a clone: Boolean defaults, column capabilities, BigInt
  ranges, DateTime behavior, script resources, raster, foreign or managed table icons, `roleGrants[]` and `sampleData` are not
  carried. The download reads once more per table for its status reasons, once per column type present (Text, Memo, Integer, Decimal,
  Double, DateTime) and once per icon it captures, plus one lookup of the web-resource table's entity set name before the first icon
  when that name is not yet known.
- **Verification checks declared status reasons and alternate keys** — `verify-model-app.js`, and the verification a build runs (with
  `--verify`, and on every build that applies a spec's generative pages). A status reason passes when the table holds its label
  under the state the build gives it and at the value the spec pins, if it pins one; a state the answer does not give readably
  fails. An alternate key passes when a key of its name is over exactly its columns, in any order. Each is one read, made only for a
  table that declares one. A build therefore now fails its verification, as it does for any other artifact, when the environment
  holds a declared reason or key differently — a reason renamed in Maker, say, which a rebuild does not rename back — or the read
  fails.

### Changed

- **The bundled SDK is updated (power-platform-ux a3443479).** What a maker can see of it:
  - a web resource create, and an update that writes content, read the published content back once their publish succeeds (one
    read), and fail with `WEB_RESOURCE_UNVERIFIED`, naming the row (which exists), when the publish fails (nothing is read back then)
    or the content read back is missing, unreadable or not what was written (see Fixed for how a build recovers);
  - a publish is never sent again by the SDK, except when SQL rolled it back as a deadlock victim;
  - an edit of an Active business process flow that the customization lock refuses is sent again, unchanged and with its original
    version check, for up to three minutes of waits, where it failed at once: another maker's edit in between makes it fail rather
    than be overwritten;
  - an app's sitemap is found by the SiteMap component on the app's current layer, not by the app's unique name (see Fixed). The link
    is checked when an app is read — before and after its sitemap is read — and again before the app is written; each check is two
    reads (the app's current layer and its SiteMap component) where a read of an app made one name lookup, and deleting an app also
    reads which apps use its sitemap;
  - an app create whose rollback the customization lock is shown to have refused or interrupted now names the lock as the reason — the
    partial app kept because its rollback deleted nothing, or its removal unconfirmed because the rollback may not have run — and says
    to check, once the lock frees, that its rows exist and are the create's own before removing them; a rollback answer that does not
    show the lock, and other rollback outcomes, read as before.
- **The HTTP client sends a publish (`PublishXml`, `PublishAllXml`) once.** It sent one again after a 429, 500, 502, 503 or 504 or a
  reset or timed-out connection, up to six sends; measured under the customization lock, a refused publish is no proof that nothing
  changed, and an accepted re-send published old content. A publish is still sent again after a 401 (with a new token) and after a
  429 of the service protection limits, waited out as before. A deadlock victim is sent again by one layer only — the SDK for its own
  publishes, the plugin for its table and app publishes — after 1, 2 and 4 seconds, four sends at most. pcf's copy of the client
  changes the same way.
- **Supported public Custom APIs are discovered by default** (`GENPAGE_ENABLE_CUSTOM_API=0` opts out for a run; a missing or
  unreadable flag configuration still turns it off). `list-custom-apis.js` returns, in one request, the public Global APIs and the
  public APIs bound to the page's tables; it leaves out private APIs, APIs bound to a table collection, and APIs with an Entity or
  EntityCollection input or output. It refuses, rather than returning an empty or partial list, an API list, privacy flag, parameter
  or response type, or lookup detail it cannot read — the metadata its eligibility checks need — and an answer or expansion whose
  completeness it cannot prove (a continuation, or the platform's 5,000-row cap); the other fields of an API's own row are not
  checked. This is Custom API discovery, not support for other Dataverse actions and functions. The page builders invoke a Function
  automatically only when its read semantics are known — GET alone does not prove it harmless — and otherwise only on the user's
  action.
- **A rebuild no longer re-sends a status reason, an alternate key or an Integer format the environment already holds.** It reads a
  table's status reasons once — after every labelled create, so the read cannot strip a later create's other-language labels — and
  inserts only a reason whose value, state, label and color are not all there; it takes the keys from the table read it already
  makes; and it reads an existing Integer column's format before updating it. Anything it cannot prove is written as before. A table
  icon is still assigned and its table published on every build, as before: a saved name does not prove its last publish completed.
- **Teardown says it keeps the publisher.** It never deletes the solution's publisher (the build reuses one by prefix, and other
  solutions may share it); its closing summary now says so in one line.
- **The design document shows a role grant the build refuses as refused.** A `roleGrants[]` entry that does not name exactly one
  role (`role` and `roleId` both, or neither) is shown in `model-app-plan.md` and the `write-app-spec-doc.js` warnings in lint's
  words, instead of as privileges the build would add.
- **Lint warns on `ai.summaries.tables.<table>.prompt`**, a key the build never reads, and names the one that holds a row summary's
  prompt (`instruction`); renaming it does not enable a summary.
- **The genpage eval's offline Custom API check follows the new contract.** It accepts a lookup passed as `{ entityName, id }` with
  no declared kind when its id is a string the page already holds, and refuses an invented or numeric id, a missing required lookup
  and a parameter discovery did not return; a binding an edited page already held is accepted unchanged only for that same page.

### Fixed

- **A download of an app whose sitemap's unique name is not the app's no longer fails on its sitemap** (#746). The SDK looked the
  sitemap up by the app's unique name, found none, and the download failed with advice to publish the app, which did not help. The
  sitemap is now the one the app's SiteMap component names. An app with no such component falls back to the sitemap of its name
  only when no other live app uses that sitemap; otherwise the download returns `ok: false` and writes nothing. Deleting an app
  whose sitemap another live app uses is refused, and so is a push of an app that was linked to another sitemap since it was read
  (read it again). A build still adds a sitemap to the spec's solution only when it carries the app's unique name, as the sitemaps
  the build creates do.
- **A web resource whose publication could not be confirmed is recovered by its id on the next build**, not reused with stale
  content or created a second time. At each place the build writes one — the spec's web resources, the generated app icon and the
  page manifest — it records the row's id in the workspace (`web-resource-unconfirmed.*.json`), adds the row to the solution, and
  stops saying the write is unconfirmed, not lost. The next run on that workspace — or the build's own retry — writes a spec web
  resource's or the icon's content again by that id, publishes it and checks what was published; it writes the page manifest again
  only when the manifest's published copy is not already what the run wants, and otherwise keeps it as it is. Either way the row
  joins the solution and the record is cleared, and pages already created are adopted, not created twice. A row of that name the
  record does not hold is reused as before, and a recorded id now under another name, or a recorded name now under another id,
  stops recovery without touching the other row. When the record cannot be saved, the build does not retry on its own. The
  workspace-reset advice keeps these records. Not covered: a process killed while the SDK publishes, and another workspace.
- **A dashboard a build created and then stopped before adding to the app's solution joins the solution on the next build.** A build
  killed between the create and the add, one whose create's answer was lost, or one whose add and undo both failed left a row outside
  the solution. The next build reused that row without adding it to the solution — or created a second dashboard if its name lookup
  missed the row — and teardown kept it. The build now records the id it creates the dashboard with (`dashboard-creation.*.json`)
  before the create; the next build reads that id in the saved layer and adds the same dashboard to the solution. Anything it cannot
  prove — another kind of row, a rename, both the sent and the reported id answering, an add refused — stops the step with nothing
  added, deleted or created, and it never asks to delete a dashboard that may be another app's. The record never adopts a namesake,
  teardown never reads it, and the workspace-reset advice keeps it; a first build and an unchanged rebuild send what they sent
  before. Not covered: a dashboard created before this release or from another workspace.
- **An unknown key in a form's `fieldOptions` entry is refused instead of ignored.** A misspelling such as `readOnlyy` or `colSpan`
  passed validation and was dropped by the build, so the option was never applied. Lint, a dry run and a build now refuse it before
  any write, naming the form, table, field and key, the option it most likely meant, and the keys an entry takes (`readOnly`,
  `hidden`, `after`, `colspan`, `rowspan`); an entry takes no `name`, because its key names the field. A spec an earlier release
  built with such a key can still be torn down and previewed, and `verify-model-app.js` verifies it with a warning.
- **A Custom API with a lookup parameter is no longer bound in a way the runtime drops.** Discovery declared a lookup as
  `EntityReference`, a kind the runtime does not take, so it dropped the whole binding. A lookup is now passed as
  `{ entityName, id }` and kept out of the declared kinds; its name, whether it is required and its table are kept for the author in
  a separate `lookupParameters` list, which is never written to the page.
- **A teardown run again no longer reports what was already gone as deleted.** A default-view reset with no default view, a
  relationship the SDK does not find, a table its read did not list and a global choice answered 404 now read `(not found)` and are
  counted so. In any teardown, a relationship from a table to itself, which its table's delete takes with it, now reads
  `(not found)` on its own step. The deletes sent and the exit status are unchanged.
- **A download no longer carries the relationship a File or Image column brings** (`FileAttachment_<table>_<column>`), nor warns
  that its name lacks the publisher prefix, nor reads the `fileattachment` table for it: the column makes it again on a rebuild.
  Other relationships of those tables are kept.
- **An access token the process obtained is also kept out of bytes, out of its other spellings, and out of text cut short or split
  between two writes.** Bytes a script writes to stdout or stderr (a Buffer, or text written as base64 or hex) are read too, and a
  token there is masked with `*` byte for byte, so framed output keeps its length. The token's base64 (standard and URL-safe),
  percent-encoded and HTML spellings are taken out like the token itself. A piece of the token of 24 characters or more is taken out
  where `util.inspect`'s `... N more characters` or an ellipsis cut the text, at the end of a write that begins the token, and at the
  start of one that ends it; an escape split between two writes stays whole, so JSON written in two pieces is still JSON. Still left:
  a piece shorter than 24 characters, the middle piece of a token written in three or more writes, a piece shorter than 24 characters
  on the far side of an escape split between two writes, base64 of a part of the token, and bytes written to a file. pcf's copy of
  the module changes the same way.
- The capabilities document no longer says that a download leaves `relationships[]` out (#567).
- **A rebuild no longer stops at something that already exists when the platform answers in another language, nor at a 1:N
  relationship it did not see before creating it.** The build read only English words in an "already exists" answer, and the platform
  can word that answer in the caller's language: on a Spanish environment the refusal of an alternate key the build could not prove
  from its table read came back in Spanish, and the data-model phase stopped. A status reason, a column of a table whose columns could
  not be read, or a table found only after its create stopped the same way wherever its refusal was worded in another language (on
  that environment those came back in English). Each of those creates now also recognises the answer by its error code, which is the
  same in every language (`0x80060893` key, `0x80044310` status reason, `0x80047013`/`0x80060304` column,
  `0x80044363`/`0x8009050d`/`0x8004700b` table); a table is still reused only when it is read back. The create of an existing 1:N
  relationship was answered `0x80072551` ("NavigationPropertyName … is not unique within an entity"), which no release recognised, so
  a 1:N the build did not see before creating it stopped the build in every language. The build now reads that relationship and reuses
  it only when the read proves it is the declared one; another relationship, or one the read cannot prove, still stops the build (the
  reference's code for a taken relationship name, `0x8004432B`, leads to the same read). The codes add to the existing rules — a 409
  and the English wording are still recognised whatever code the answer carries — and a code of another create, a generic code or a
  code the message only quotes does not count by itself.
- **Teardown removes a published app whose navigation names a sitemap that no longer exists, once it reaches the app.** Before 2.18.0,
  tearing down one app could delete a sitemap another app shared, leaving that app's SiteMap component pointing at nothing. 2.17.0
  then deleted such an app on its own (no sitemap had the app's name); the component-aware delete in 2.18.0 refused it with "… was not
  returned by the unpublished-aware read … Retry.", which no retry could pass. Teardown now reads the app's row version, proves that
  sitemap gone — by its id, in the published and the saved layer, with no other app's navigation naming it and the link unchanged —
  and deletes the app on its own: the delete is conditioned on that version and touches no sitemap, and the app is then read back
  gone. When it cannot prove that, or when the app was never published, it refuses with what it found and asks you to delete the app
  in Power Apps and run the teardown again; when the app changed while it was proving it, it deletes nothing and asks you to run the
  teardown again. An app with live generative pages still stops earlier, at the page check, because its pages are proven from the
  navigation that is gone; delete such an app in Power Apps, then run the teardown again.

## [2.17.0]

The bundled SDK is updated to power-platform-ux d603c799. Dashboard tiles the spec does not size now show their charts and lists, a
download keeps File and Image columns and a table's plural, and an alternate key in several languages over a new table's name column
no longer stops the first build. A relationship is reused or verified only when the environment states its whole identity, an import
refused because another import or a publish was running is sent again when its job proves nothing started, and the five minutes a run
allows itself for a throttled service now bound all of its waiting. An access token is kept out of everything a script writes, and a
large result is no longer cut short on Linux and macOS. `--verify` settles a form's captions in another language from one translation
export and puts its warnings in its result JSON, and lint no longer calls an app with no personas administrator-only.

### Added

- **A cross-feature regression matrix.** One App Spec with every feature an offline fake can model faithfully (all column types, a
  Customer column, a global choice, status reasons, an alternate key, 1:N, self and N:N relationships, views, a chart, Main, Quick
  Create and Quick View forms, a dashboard, web resources, commands, a generative page, navigation, app settings, sample data, a
  persona and a role grant) is built, rebuilt unchanged, downloaded, verified and torn down over the bundled SDK and a stateful fake
  Dataverse that refuses every read it does not model and applies every query option it accepts. Every phase's writes and publishes
  are pinned, its reads are under a budget, the download is compared with the authored spec, and every phase is proven to leave the
  content of everything that was already in the environment as it was. Beside it, tests pin that dry runs and the teardown preview
  write nothing, downloads are stable, a rebuild without `--publish`, rebuilding a downloaded spec in place, verify naming what was
  deleted in Maker and a rebuild restoring it, a build or a teardown that fails part way finishing when run again, and a teardown of a
  downloaded spec keeping every table, relationship, global choice and row. The three files take about 7–12 s each.

### Changed

- **The bundled SDK is updated (power-platform-ux d603c799).** What a maker can see of it:
  - an app's header write carries only the texts that changed: an edit of the description does not send the name again (and the
    reverse), and a routing-description edit sends neither text — another writer's unpublished description is no longer sent again;
  - a row-summary lookup that answers something that cannot be read as a list of rows is an error: a first row that is no row, or a
    template row without a GUID id, stops the build (it used to read as "no row summary yet" and publish a model, or as "no
    template"), and teardown says the lookup failed instead of reporting "nothing to remove";
  - the Command Designer change merged since ccf2c1a1 does not reach the plugin: the commands phase writes what it wrote. The SDK's
    PCF control registration, which the plugins never called, is no longer in the bundle.
- **A name or description that is localized (or otherwise not plain text) holds back only its own edit.** The other text and an
  `app.aiDescription` are now applied and written alone, where one such text held the whole header back and a changed plain text
  beside it was reported as not applied. The text is taken off the app copy before it is pushed, so it is never sent — even when the
  SDK's own read of the header fails, which used to stop the build with `APP_HEADER_NOT_PLAIN_TEXT`.
- **An environment without the row-summary AI template skips the row summaries on the SDK's answer alone.** The build no longer reads
  the template list a second time before it skips (one warning, nothing written, as before); an answer the SDK cannot read stops the
  build with the SDK's own error, and a throttled or interrupted read is still run again.
- **Teardown reports a row summary from what the SDK says it did**: `✓ row summary <table> (1 deleted)` when one was removed,
  `⊘ … (not found)` when the table had none (also an environment with no AI skill table), `kept` with the SDK's words when the removal
  or its lookup failed — with no read of the plugin's own.
- **`verify-model-app.js` puts its warnings in the result JSON, and prints the result as pure ASCII.** Every `WARNING:` line it prints on
  stderr is now also in an optional `warnings` array of the result — the same messages, in the order printed, left out when there is
  none — when the verification passes, fails, or the spec is refused; it changes neither `ok` nor the exit status. A refused spec now
  prints the warnings it also has. A character beyond ASCII in the result (an em dash, a Spanish label) is a `\uXXXX` escape that any
  JSON parser reads back as the original text, so Windows PowerShell 5.1 can no longer garble it. stderr is unchanged.
- **A new table that no persona and no `roleGrants[]` entry grants a privilege on is a warning** ("no access declared", in lint and in
  the design document's `warnings`); a covering grant satisfies it, and `--strict` fails on it like on any warning.
- **`write-app-spec-doc.js --env` reads, read-only, the roles the app has associated with it** and lists them beside the privileges the
  spec grants. It finds an app that was saved and never published, matches a role to a persona or a `roleGrants[]` entry by id where
  the spec gives one and otherwise by name as "may be" (role names repeat across business units; every candidate is listed), and says
  "not checked" — never "no roles" — for a refused read or an answer that is no list of roles. It calls an app administrator-only
  only when the environment shows it and no persona gets the app. The command never fails because of the read.
- **A build that is throttled for more than five minutes in all now stops with `throttle-budget-exhausted`** once the five minutes are
  spent and it has something left to write (it used to finish after waiting out the HTTP client's own re-sends on top of the budget);
  running the same command again later continues from there. See Fixed.
- **`/genpage`, `/app-builder` and the six `genpage-*` agents say what they are not for**: a generic or standalone React or web app,
  Power Pages, canvas apps, Power Automate, and a request that rules out Power Platform, Dataverse and model-driven apps.
  `/app-builder`'s description lost process detail no request routes on, to stay under GitHub Copilot's 1,024-character limit; every
  capability and trigger phrase stayed.
- **The routing eval has 35 cases (15 added)** — requests that say outright they are not for Power Platform, a plain web app in the
  stack `/genpage` is written in, a Power Apps code app, and positives that carry a "not" about the other skill — and **reports the
  decision of the agent's first turn beside its grade** (`first turn: … · later: …`; `initial` / `delayed` / `turn` in `--out`). The
  grade is unchanged: the first model-apps skill the agent asks for, at any turn.
- `references/agent-interaction-contract.md` explains that declaring a tool in both naming schemes makes a host recognize it, not
  deliver it, and a test fails an agent that names `TaskCreate`/`TaskUpdate` without saying what to do when there is no task tool.
- A download's warning for a failed label read now says which read failed — the table's own, or its columns' — and only what that read
  carries; the table read's warning also says the table's plural is not written.

### Fixed

- **Dashboard tiles show their charts and lists.** A tile the spec did not size was built one row tall, which the app draws as the
  tile's title bar alone. An unsized tile is now one column by 12 rows, the most common height of the platform's own chart and list
  tiles, so two of them share a row; a tile's `colspan` and `rowspan` still win. A rebuild reuses a dashboard that exists and does not
  resize its tiles: re-create one an earlier version built under a new `name`, or resize its tiles in the dashboard designer. The App
  Spec reference said the default was 1x4; it now states the size and how tiles fill the dashboard's two-column grid.
- **A relationship is no longer taken for the declared one on its name alone.** The build skips the create of an existing relationship
  — and the dry run says `= reuse`, and `verify-model-app.js` passes it — only when the environment's answer states its whole identity:
  schema name, type, both tables and, for a 1:N, the lookup column, for an N:N the intersect table and the column each table has in it.
  An answer that left a part out used to count as "nothing contradicts". Now the build reads the relationship itself and halts, leaving
  it as it is, when that read is incomplete too; the dry run shows `? unknown`; verify fails the check and names what the answer
  lacked. An N:N whose spec names an `intersectEntityName` is refused (`relationship-name-taken`, with the way to reuse it) when the
  relationship under that name sits on another intersect table. Complete answers behave as before.
- **The five minutes a run allows itself for a throttled service now bound all the waiting it does for a throttle.** The HTTP client's
  own re-sends of a throttled read, publish, delete or column create kept a schedule of their own outside the budget; the client now
  draws every wait it takes after an HTTP 429 from the same budget in the build and the page upload. It waits what `Retry-After` asks,
  counts requests throttled together once, and announces a wait of more than five seconds on stderr. A wait that does not fit is not
  taken: the throttled answer comes back as it came, and the build stops with `throttle-budget-exhausted`, which says what the service
  asked, before its next write. A 5xx, a reset connection and the re-send of a deadlock victim are not throttling and keep their own
  schedule; every other script (and the pcf plugin's copy of the client) waits as it always did.
- **A refused throttle wait stops the build before it writes again, not only the request.** No later step that would write starts — a
  refused column change set is no longer followed by one request per column — and the build stops with `throttle-budget-exhausted`
  instead of finishing as a success. A step that only reads to find it has nothing to do still runs, so a rebuild that has nothing left
  to write after a refused best-effort read finishes, with the refusal's warning on stderr. A throttled read before an update, or of a
  page an earlier build started creating, that the budget has no room for is the throttle's refusal, not "could not read page" and not
  a conflict that asks the maker to delete a record. The client's stderr line for such a request no longer says to run the same
  command again; after a page upload's create, the result names the page and the command (`--page-id <id>`) that finishes it.
- **A refused throttle wait no longer leaves a new table's name column at the platform's default length.** The build skipped the
  length update of the next table owed one and forgot it, so a later run could not set it and an alternate key over that column was
  refused for its size on every run. Every owed length is now set whatever the budget has refused; a key waiting for it is made by the
  next run, which the halt asks for.
- **Verify no longer calls a published dashboard "not published" for a user whose own UI language is the organization's second one.**
  When the published read carries more than one language and the saved and published rows answer the same `@odata.etag`, the two reads
  are compared in everything but their captions; any other difference is still a change. A dashboard saved and not published, a row
  that answers no token, and a base-language user's read are decided as before.
- **A generative page whose class has a class expression for its base, and one that has a field named `new` before a method, are read
  instead of refused** (2.15.0 refused them with the guess `generic`). Still refused, naming the guess: a function expression or an
  object literal for the base, type arguments after a class expression, more than four class expressions nested in each other's heads,
  and a `new` that no member of a class begins; parenthesise the base, as before.
- **Lint and the design document no longer call an app administrator-only because `personas[]` is empty** (AB#6770008). A spec that
  authors no role says nothing about who can open an app that already exists — an extension of such an app leaves `personas[]` out on
  purpose — yet lint said the app "opens only for system administrators", steering authors to redefine their existing roles. Both now
  say what the spec authors; a spec that carries what a download writes (`app.uniqueName`, a page or dashboard id) is told the app
  already exists and keeps its roles. The document follows each persona's `appAccess`.
- A rebuild of an app whose name (or description) is held as one text per language writes a changed description (or name) instead of
  reporting it as not applied.
- **`solution-settings.js import` sends an import again that the platform refused because another import or a publish was running.**
  The platform answers such an import with HTTP 429 and `0x80071151` ("Cannot start another [Import] because there is a previous
  [Import] running …"), which the retry did not know, so the maker had to run it again by hand. The code alone does not say that nothing
  started, so the refused send's import job is read once, and the import is sent again — after waits of 10, 20, 40 and 60 seconds (or a
  longer `Retry-After`), at most five sends in five minutes, the budget checked again after each wait — only when the job does not exist
  or is finished and its log says the import failed with that error before it processed the solution or any component. A job that
  proves nothing is not sent again: the failure says why and to look the import job up (`importjobs(<id>)` or the solution history)
  before importing again. A resend's output says how each refusal was proven (`importRefusals[].proof`). When the fifth send is refused
  too, the failure no longer says to run the import again; it says what to check first. The retry for the lock codes is unchanged.
- **`--verify` no longer lists a form's tab and section captions as unverified just because the form read does not return their
  language** (Spanish captions in an English-language organization): they are read from one translation export of the app's solution,
  matched by the id of each tab and section, so a right caption passes and a stale, missing or empty one is reported. The export is one
  request (several seconds, more as the solution grows), made only when such a caption exists, shared by every form of the run and never
  sent twice. When it fails or cannot be read with certainty — its archive must be self-consistent and its labels sheet exactly the
  platform's shape — the captions stay unverified, with the reason, as before.
- **An alternate key labelled in several languages over a new table's name column and another column no longer stops the first
  build** where the platform makes the name column 850 characters long (HTTP 400 `0x80060895`, "Index size exceeded the size limit of
  1700 bytes"). For such a key only, the build reads the column's length once (a typed `MaxLength` read, no labels); where the key cannot
  fit beside it but can at the length the spec asks, it is made after the length step, with both labels, instead of in the run after.
  The key's size is counted from its columns as the build creates them (an `AutoNumber` column, like one with no `type`, is created 100
  characters long whatever `maxLength` it carries). Every other key keeps its place. The warnings and the stop
  (`alt-key-name-length-not-set`) now name the platform's measured limit of 1,700 bytes (they said 900) and no longer promise that
  running the build again creates a key: a key proven too large at the asked length is said to be so, with its size and what to change;
  otherwise they say a run again may create it, that this is not certain, and what to compare if it is refused again. They no longer
  suggest labelling the key in one language. The stop's code, retry behaviour and exit status are unchanged.
- **An access token the process obtained no longer reaches anything a script writes, whatever text carries it.** A service that rejects a
  token may repeat it — whole or by a part, folded onto several lines, with a JSON escape or a backslash left in it — in a diagnostic,
  and a change set refused as a whole is answered HTTP 200, so the token could reach an error message, a warning, the journal or a file.
  Every token the process obtains is now kept out of stdout and stderr (colour output included), what Node prints when an error ends a
  script, the build's journal and status file, the baseline and snapshot, downloads and generated files, and every file of the SDK's
  workspace; the token reads `<token>` and the text around it is unchanged. Answers themselves are never rewritten, so the strict
  `$batch` readers decide a page write's resend on the same bytes as before. A text that could not be checked is not written.
- **pcf: the push receipt no longer carries the access token** a refused confirmation read quoted, and every file the SDK writes into a
  push's workspace goes through the same guard.
- **A download keeps File and Image columns.** Both report the Dataverse type "Virtual", so every download left them out without a word
  and a rebuild elsewhere lost them. They now come back typed, with `maxSizeKb` when it is not the build's default (10240 KB) and
  `isPrimaryImage` for a table's primary image. The table's own image and the platform's companion columns are not written, a column of
  another type the App Spec cannot express is named in a warning, and a size read that fails or answers short is reported — per read, and
  per column for a short answer. Only a table with such a column costs a read more (one per type).
- **A download keeps a table's plural when a rebuild would not derive it**: "Tag Catalog" for "Tag" was left out, so a rebuild into
  another environment named the table "Tags". A plural that is the display name plus "s" is still left out, so the download of an
  ordinary table is unchanged.
- **A large result or message is no longer cut short on Linux and macOS when a script prints it and exits at once.** Node writes to a
  pipe asynchronously there and `process.exit` did not wait, so an agent could receive a multi-megabyte answer, listing, auth check,
  validation report or error as a text that ended mid-string. Every printer that ends the process — `emitResult`, the printer of an
  uncaught error, each script's own result printer (`check-auth.js`, `dataverse-request.js`, `genpage-plan-provenance.js`,
  `promote-intent-pages.js`, `check-page-files.js`, …), usage errors, last-resort error handlers, the hooks' messages and the warnings
  a script prints right before its result — now makes its writes blocking first. What is printed and every exit status are unchanged,
  and Windows was never affected; as on Windows, a reader that stops reading now holds the script at its last write instead of
  receiving a truncated text.
- The page-builder worker, the planners and the entity builder no longer tell the agent to call `TaskCreate` with no alternative: a
  host can hand a subagent no task tool, so the agent tracks its task with `TaskCreate`/`TaskUpdate` or `todo` when it has one, and
  otherwise says so and tracks it in plain words; `/genpage` does not treat a worker without a task tool as a failed worker.
- The routing eval no longer ends a trial before the agent it killed has exited (an `EBUSY` on Windows), and two tests no longer
  assert a time limit that failed on a busy machine (the shared telemetry spawn test, and the test that ending a verify pass's page
  reads does not wait for a read in flight).

## [2.16.0]

The bundled SDK is updated to power-platform-ux ccf2c1a1, and a new table's primary (name) column is now created required when the
spec says so. The spec gate refuses two values the build used to misread — an `AutoNumber` column without a format and a `required`
that is not `true`, `false` or `"recommended"` — before anything is written, and `--verify` of an app an earlier release built only
warns about them. Navigation titles survive a download and rebuild on an environment whose base language is not English. Teardown
keeps what only a kept table blocks instead of reporting the platform's refusals, and a run cut short removes its temporary folders.

### Changed

- **A download reads the environment's base language** (one more read, made only when the spec on disk pins no `languageCode` and
  `--language-code` — new on `download-model-app.js`, read-time only — is not given) and reads the navigation titles in that
  language. When it cannot establish the language it stops without writing anything (`navigation-language-unknown`) instead of
  guessing 1033: run it again, or pass `--language-code <lcid>`. A language other than the base language given that way must be
  given to the build and to `verify-model-app.js` too, or pinned as the spec's `languageCode`. On a bilingual environment whose base
  language is not 1033, dashboard tile names are read in the base language.

- **The bundled SDK is updated (power-platform-ux ccf2c1a1).** What a maker can see of it:
  - a business process flow edit the flow cannot hold (a binding with no value, `required` on a step that has no slot for it) fails
    with a message instead of reporting success, and a flow's security that names an access level its table cannot grant is
    refused before any role is written;
  - a command bar control copied with another control's id fails the push instead of overwriting that control;
  - a generative page whose source holds text that only looks like an import of `./RuntimeTypes` (in a string, a template or a
    comment) is refused with a message that names that text's line and column;
  - an answer that lacks the rows or the record it should carry is an error, not an empty result;
  - a workspace copy that an interrupted build of an earlier release left with edits it never pushed is refused at its next push
    and asks for the documented reset (a copy without such edits is simply read again);
  - a dashboard tile that hosts a custom control (the Power Apps grid control, say) is still left out of a download, named in its
    warning, and out of `--verify`: the SDK now reads such a tile as a list or a chart, and the plugin tells it apart by its
    control, so it is never written into `dashboards[]` as a plain tile.
- **An `AutoNumber` column without a usable `autoNumberFormat` is refused when the spec is validated** — by the build and by the
  input gate of `provision-entities.js` that `/genpage` and `/app-builder` go through — before anything is written. The SDK no longer
  creates such a column (it made a plain text column), so the build would have stopped at it after the solution and the tables were
  made. The error names the table and the column and both ways out: a format such as `"C-{SEQNUM:5}"`, or `type: "Text"` for a
  plain text column — which is also what such a column an earlier release built is. A blank format, or one that is not a string, is
  refused the same way. A primary name column without `autoNumberFormat` is still a plain text name column.
- **A column's — or the primary name column's — `required` must be `true`, `false` or `"recommended"`.** Every other value
  (`"ApplicationRequired"`, `"true"`, `"required"`, `"Recommended"`, `1`, `null`) was read as "not required": a new column was
  created not required, and an existing column was written down to None, demoting one a maker had made Business Required. It is now
  refused at validation, naming the table, the column and the value and what to write instead; leaving `required` out still leaves
  an existing column as it is. Both rules are warnings, not errors, for `verify-model-app.js` — which creates and changes nothing —
  so an app built from a spec an earlier release accepted can still be verified, and teardown still accepts such a spec.
- **The forms phase writes the order of every Main form it orders, the first of a table included.** The SDK now creates a form with
  no form order (it wrote `Order="0"`), so on the build that creates a table's Main forms the first of them is written once more. A
  rebuild finds every order in place and writes none.
- **An environment without the row-summary AI template skips the row summaries with one warning.** The SDK now looks the template
  up before it writes anything and refuses an environment that has none (it published a model that named no template and let the
  platform answer). The build confirms that the template list is empty with one read of its own before it skips — a list it
  cannot read as a list of templates stops the build as before — and a throttled or interrupted confirmation read is retried like any
  other read the build makes.

### Fixed

- **A `required` on a new table's primary (name) column is applied when the table is created.** The create sent the name column as
  not required — a plain text name column is stored not required whatever the create asks — and the build still reported
  `required <table>.<column> (applied on create)`; only a rebuild set it. The table's create now asks for the level, the SDK reads
  it back and sets it with one update, and the build says it was applied only when the SDK confirms it for a table the build saw
  created. When the level cannot be confirmed the table still exists: the build stops once (or, for a table found after the answer
  to its create was lost, or whose columns could not be read, warns and goes on), and running it again finds the table and sets the
  level. The table is never created twice.
- **Navigation titles survive a download and rebuild on an environment whose base language is not 1033** (a Spanish-only one, say).
  The download read every title in 1033, a language such an environment does not hold, so it wrote an empty `label`/`title` for every
  area, group and entry, and a rebuild of that spec cleared the titles; on a bilingual environment with another base language it
  wrote the English titles, which a rebuild then wrote over the base-language ones. The download now reads them in the language a
  rebuild resolves (see Changed).
- **A rebuild never clears a navigation title the spec does not state.** An area or a group without a title in the spec keeps the
  title it has, and so does an entry, unless the baseline shows the spec used to state one (then the title is removed, as before); a
  stated title is applied as before. An empty group (or area) of a spec an earlier release wrote is matched to the environment's one
  empty group; where more than one could be meant, none is paired by position and the build names each title it does not keep.
- **Teardown no longer reports a row summary it did not delete.** A table with none reads `⊘ row summary <table> (not found)`
  instead of `✓ … (1 deleted)`, and the closing counts follow. A lookup or a removal that fails is said on the step's line and
  counted as kept, never as a deletion; it still does not fail the teardown.
- **Teardown keeps what only a kept table blocks, instead of reporting the platform's refusals.** When a business rule could not be
  deleted, teardown keeps its table until a re-run (the rule's activated copy can only be deleted while the table exists), but it
  still tried the deletes that follow the tables — the table's icon web resource and a global choice one of its columns binds,
  which the platform refuses while the table exists, and a relationship from the table to itself, which it refuses while the table
  still holds something that refers to its lookup — so one failure was reported as up to four. Those steps are
  now kept with the table, each a `(kept — …)` skip that names it, and the re-run deletes them once the table goes. The run still
  ends as a failure and keeps the solution. The dependency is read from the spec, so an icon or a binding made by hand in the
  environment is still tried and refused as before. A rule whose deactivation succeeded and whose delete failed stays deactivated
  until the re-run.
- **A run cut short by `process.exit` or an error nothing catches removes the workspaces it made and did not lend, and then the
  plugin's temporary folder (`power-platform-skills-model-apps`) when it is empty**, instead of leaving both for the next run. A
  POSIX signal still ends a run as before, and the next run's sweep removes what it left.
- The plan document shows a `"recommended"` column as recommended, not required.
- The test suite no longer leaves `plugins/model-apps/.maker-workspace` behind, and `scripts/run-tests.js` fails a run that makes
  one there (removing it only when it is empty).

## [2.15.0]

Generative pages, the environment's apps and tables, connections, connector metadata and deployment settings now go through the
bundled SDK instead of the PAC CLI, so `az` is needed for every Dataverse call, pages included. `pac` is left for signing in and
choosing the environment, a tabular connector's tables and their columns, and the fallbacks where the SDK has no route or refuses
— connections, connector metadata and deployment settings — which say so in their output. A page can be created before the app
that holds it, a rebuild publishes only the pages that changed, and teardown finds a page that was never published. A rebuild now
also applies a changed app name and description and a business process flow's stage edits, the build's automatic retry follows what
the service answered, not the names a maker chose, and the next run releases the pages lock and removes the temporary folders a
killed run leaves behind.

### Added

- **`scripts/apps.js list` and `scripts/list-tables.js`: the environment's apps and tables through the bundled SDK, in place of
  `pac model list` and `pac model list-tables`.** `apps.js list` prints every model-driven app, drafts included, with its id, name,
  unique name, description and two facts, apart: whether it is published (users can open it) and whether it has unpublished changes
  — `pac model list`'s "(Saved - Not Published)" was neither (a managed app an import brought in carried it although it is live; a
  published app with a saved edit did not). Its name and description are the app's saved layer's, what a maker sees in the designer:
  a published app with a rename not yet published is listed by its new name, which users see only after a publish (`pac model list`
  printed the published name). `list-tables.js` prints the tables a comma-separated `--search` names — the same tables
  as `pac model list-tables` — with `--exact`, only those whose logical name is a
  term, listing the terms that have no table, and with `--type custom|standard|all` only the custom or the standard ones.
- **`scripts/apps.js create` makes an app that opens on generative pages, in place of `pac model create`.** It takes the pages
  (`--page-id`, required: Dataverse refuses an app whose navigation group is empty, and an empty group is what `pac model create`
  made), as one area "Main" and one group "Pages" with a sub-area per page, pins the default public view of each table the pages
  read, adds the app and its sitemap to the solution, and publishes only with `--publish`. Every check — no page, a page or a
  solution that does not exist, a managed solution, a unique name already taken — refuses before anything is written, and says why;
  a run that fails after the push began reads the platform back and says what is actually left. Titles are written in the
  environment's base language, the icon is the system's default one, and the app gets the new header and navigation setting, which
  `pac model create` did not write.
- **`scripts/genpage.js`: the page verbs the skills ran through `pac model genpage` — `list`, `download`, `types` (the type
  generator), `add-to-app` — and two they had no verb for, `remove-from-app` and `delete`.** One pure-ASCII JSON line per command,
  exit 0 or 1; a mistake in the command line is a usage error with nothing on stdout. `list` shows every page of the environment,
  drafts included (with `--app-id`, an app's published navigation, or its saved one with `--include-unpublished`). `download` reads
  every page before it writes, so a page that cannot be read leaves the folder as it was, and writes the page's own bytes — no byte
  order mark, no line break appended, no `page.js`, all of which `pac` wrote; `--app-id` is optional. `types` is the SDK's
  RuntimeTypes generator, so its file is not byte for byte `pac`'s; a table the environment does not have is
  `GENPAGE_TABLE_NOT_FOUND`. `add-to-app` puts the page in an app's navigation with the default views of its tables, publishes the
  app and checks the page shows in it; run again, it finishes a placement that was saved and never published. `remove-from-app`
  takes the entry out, publishes the app (an app that was never published too, with a warning) and checks the page is gone, and
  refuses to leave an app with no navigation entry unless `--allow-empty-navigation` says that is meant. Neither adds anything else
  to the app: the SDK's push of an app also adds every active Main form, public view and chart of each table its navigation opens —
  those a maker took out of the app included — so the plugin limits that push to the views the edit pins. `delete` says what it
  would remove — the page, its file rows, its conversation messages (`GENPAGE_DELETE_NOT_CONFIRMED`) — and removes it, with its
  conversation, only when `--allow-destructive` says that is meant; it refuses while any app's navigation, published or saved, names
  the page, naming the apps (`GENPAGE_IN_APP`). The build's and the upload's messages that sent you to Maker or to a `pac` command
  (a page another app holds, a page that could not be placed) now print the `genpage.js` command that does it.
- **`scripts/connector.js` and `scripts/solution-settings.js`, in place of the `pac model genpage` connector verbs and
  `pac solution create-settings` / `import --settings-file`.** `connector.js` lists a connector's operations, and reads one
  operation's parameters and response or a tabular connector's table columns. `solution-settings.js template` writes the
  deployment-settings file for a solution or a package, in `pac`'s own format, so settings files you already have keep working;
  `import` imports a package and applies the settings in the same import. Both print one JSON line that says whether the bundled SDK
  or `pac` answered.

### Changed

- **Every generative-page operation goes through the SDK** (`scripts/lib/genpage-sdk.js`): `genpage-upload.js`, the build's pages
  phase, verify, download and teardown. No script runs a page verb of `pac model genpage` any more, so there is no `pac` process to
  time out or parse for a page (`POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS` is no longer read), and **`az` is now needed to deploy a
  page**, not only to create entities. Verify reads page code in-process, four pages at a time; a command that could not remove the
  temporary folder it read page source into says so instead of reporting success.
- **A page is compiled by the bundled SDK, with the TypeScript 5.8.3 compiler the plugin now ships**, in place of the transpile `pac`
  made when it uploaded one. The compiler is the official `typescript` package's `lib/typescript.js`, minified and brotli-compressed
  (`scripts/vendor/typescript/`, ~0.8 MB, with its Apache-2.0 license and notices): the SDK compiles a page itself whenever a push
  changes it and accepts only the TypeScript version the maker portal compiles with, and a plugin install has no `node_modules`. It is
  unpacked and run (about 0.2 s) only when a page is compiled, and its bytes are checked against the recorded hash first. As in the
  portal this is a transpile, not a type check — a page with a type error still deploys — and a page that does not parse, has no
  default export or imports a value `RuntimeTypes` does not hold is refused by the SDK before anything is written.
- **A page write is one atomic change set, and says what it did and nothing more.** A create mints its id first, so an unknown
  outcome is settled by reading that id (sent once more under the same id only when nothing landed: never a second page); "nothing
  was written" is said only when the SDK refused the write before sending it or the service answered 4xx, and any other failure at
  or after the send is `unknown`, the error carrying `outcome` and `pageId`. A write the service throttles (HTTP 429) has written
  nothing: it is waited out and sent again — up to six sends, on the HTTP client's schedule or, when the answer's `Retry-After` asks
  for longer, for the whole of that wait, as long as it fits the run's five-minute throttle budget — and an edited page that someone
  saved during the wait is refused, not overwritten; one that outlasts the waits ends the write, and the build runs it again like
  any transient failure, within the same budget. A change set the service refuses as a whole is read by the part that failed — a 429
  is waited out, a 400, 403 or 404 is final — but only when the answer is complete and every part in it is accounted for; any other
  answer proves nothing and stays `unknown`. An update writes only what differs, so leaving out `--model`, `--name` or
  `--data-sources` keeps the page's own (`pac` blanked the model and renamed the page to its navigation title; 2.14.0 re-sent both
  and warned when it could not), and a page whose content is unchanged is written nowhere and records no prompt (the upload script
  still publishes it).
- **A page is stored exactly as written**: nothing is appended, one leading BOM is dropped, a file that is not UTF-8 is refused, and
  a `"` in a page name is kept (`genpage-upload.js` no longer refuses it; spec-lint still warns about one, and now says why: a page
  an earlier release created holds it as `\"` until a build rewrites its name).
- **`genpage-upload.js` creates a page without `--app-id`** — a page needs no app, and a new app cannot be created empty, so the
  first page comes first (`genpage-base.js record` takes a page with no app too). Such a create adds the page to no app and its base
  marker names none; the first update that names the app the page was placed in goes ahead once that app's navigation lists the
  page. `--add-to-sitemap` and updates still need `--app-id`, and with it the default views of the tables the page reads are pinned
  into the app (as `pac` did). The entry `--add-to-sitemap` adds to the navigation is titled in the environment's base language, as
  `genpage.js add-to-app` titles it. A page it created but could not finish (its publish failed, or the placement it was asked for
  did) is finished by running the same command again with `--page-id` added. A failed write reports the page's id, `outcome` and the
  SDK's `code`, and a placement that was saved with only its app publish left is reported as that.
- **A rebuild does not publish a page that is already up to date.** 2.14.0 re-uploaded and re-published every page of a full rebuild
  (through `pac`), a `PublishXml` of several seconds per page each time. A page that already holds what the spec asks for is not
  written, but the server cannot say whether an earlier run's publish of it finished, so the build keeps a record in its workspace
  (`page-published.<hash>.json`) of the content each page was published with and of the versions of its file rows and of the page's
  own row, which holds its name. The versions are recorded only once the build has read the page's published copy back — its source,
  settings and compiled output — between two reads of them that agree, so a page another writer published over in the moments after
  the build's own publish is not recorded as the build's. A page's publish is skipped only while it holds that content and its rows,
  read now, are exactly the recorded set at the recorded versions. Anything else publishes: a new or changed page, one saved by a
  run whose publish failed or was not proven, one changed or published from another workspace, machine or Maker since, a failed read
  of the versions, a missing or damaged record (so the first build in a workspace publishes each page once). What the proof cannot
  see is a file other than the source, the settings and the compiled output — the first prompt, say — changed and published from
  elsewhere just before the build first reads the versions.
- **A create the build could not account for is remembered, and what it finds is checked against what was sent.** The build writes
  down the id it minted for a page, with its name and a hash of the source it sends (a `pending` record in the workspace), before it
  sends the create. If the answer never arrived and the page could not be read back, the next build resumes that create under the
  same id — never a second page — and adopts a page it finds only when it holds a name and a source a create under the id sent;
  anything else is a conflict. A record is kept until evidence settles it (the page adopted, or deleted by teardown), never because
  a listing did not show the page, so a page that lands late is reported and found by teardown, and teardown's `--clear-workspace`
  refuses while one is unsettled. A request still in flight when its page is deleted can make the page again, and nothing names it
  (no client can cancel one). A halt that asks for a manual workspace reset now says to keep the `page-ownership.*.json` records
  beside `last-applied.json` and `destructive-approval.json`: they are the only trace of a page that may still land.
- **The build pins the default views of the tables its pages read** into the app's components once the pages are written (`pac` did
  this on every upload): one app operation for all of them, which adds those views and nothing else (the SDK's push of an app would
  also put back every active Main form, public view and chart of the tables its navigation opens, those a maker took out of the app
  included), nothing written when every view is already pinned, and a failure to pin is a warning.
- **Waiting out a throttled service has one budget per run: five minutes.** The page writes and the build's own re-runs of a phase
  share it. The wait the service asks for (`Retry-After`) is honoured whole and carried from a page write to the build, a wait of
  more than five seconds is announced on stderr, and a wait that does not fit stops the build with a `throttle-budget-exhausted`
  halt that says what the service asked: running the same command again later continues. The HTTP client's own re-sends of a
  throttled read or publish keep their own schedule and are not counted in it.
- **Connections, connector metadata and deployment settings are read through the bundled SDK**, with your Azure CLI sign-in
  (connections and connector metadata also use an Azure CLI token for the Power Apps service, sent only to that service's hosts and
  never printed). `pac` is asked only where the SDK has
  no route or refuses: an environment in the Test cloud or any other cloud the SDK does not read connections in (these go to `pac`
  with no SDK attempt first), a token the service refused (401 or 403), an environment the service does not tie to the organization,
  a service that has been switched off, a connector definition the SDK does not project, a package whose staging answer the SDK
  cannot read (`template` also when the platform will not stage it; an import it will not stage fails, naming the dependencies it
  is missing, and is not retried by `pac`), a settings file that uses a feature only `pac` applies, no Azure CLI token for the
  Power Apps service, a settings template of a package with no `--env` (nothing to stage it in, so `pac` reads the zip offline), and
  a tabular connector's table columns (`connector.js schema --dataset --table`; the SDK reads them only through a client the plugin
  cannot build). The output says so (`connectionsSource` and `connectionsFallback` in `list-connections.js`; `source` and
  `fallback` in the others; the last two of these say `source: "pac"` and carry no `fallback`); any other failure is reported with
  the SDK's own code and never answered by `pac`. A tabular connector's tables are still listed by `pac` itself; no script does it.
  A connector whose Swagger puts parameters on a path item now reads through the SDK, with them merged into each operation's own.
- **A `pac` fallback is time-bounded and prints only why it failed.** A read gets three minutes and an import an hour (fixed;
  `pac connection list` had no limit in 2.14.0). A call that runs out of time ends `pac` and the processes in its tree and says what
  it confirmed — "`pac` and every process that held its output were stopped", or that something `pac` started "may still be running"
  — and a failure shows `pac`'s error without its sign-in banner and version lines. The folder a fallback works in (the package the
  SDK exported, `pac`'s template, a copy of the settings) is removed with the retries a Windows lock needs; one that stays is a
  warning that names it, with the files in it that can hold values emptied first (`emptied, so it keeps no value`, or
  `it could not be emptied either, so it may still hold values`). What the SDK warned of before it refused — a staged copy it could
  not delete — stays in `warnings` whether `pac` then succeeds or fails, and also when `template`'s final write of `--out` fails.
- **`list-connections.js` checks the environment URL before it runs anything, and prints one JSON line for every failure**, as
  `connector.js` and `solution-settings.js` do: `{ ok: false, error, code }` in pure ASCII on stdout, the message still on stderr,
  exit 1 (in 2.14.0 a failure was a message on stderr alone). `code` is there when the error has one (the SDK's errors do; a `pac`
  failure and a bad environment URL do not). A `pac` listing that fails after the SDK refused carries the SDK's reason as
  `connectionsFallback`, as a listing `pac` gave does. A usage error (no URL, an unknown flag) is still the problem on stderr alone.
- **The `solution-settings.js import` defaults are `pac`'s**: nothing unmanaged is overwritten, no workflows or plug-ins are
  activated, nothing is published afterwards. The solution actions that can run for minutes (`ExportSolution`, `StageSolution`,
  `ImportSolution`) get an hour and are sent once: a gateway's 502, 504 or 401 for an import the platform accepted is not answered
  with a second import. The one exception is an import the platform refused to start because a publish or another import holds the
  environment's customization lock (HTTP 429 with one of the codes `0x8004F061` to `0x8004F064` and `0x8004F067`): it is sent again
  under a new import job id once `importjobs(<id>)` of the refused send answers 404, which proves it never started, after 10, 20, 40
  and 60 seconds or the longer `Retry-After` the platform asks for — at most five sends within five minutes of the first refusal,
  never one early — and the output names the job that ran (`importJobId`), `importAttempts` and each refused send (`importRefusals`).
  Every other answer is sent once, the solution-concurrency `0x80071151` included. That is the answer measured for an import that met
  another import or a publish (its words begin "Cannot start the requested operation [Import]"), and that import's job existed by
  then, so nothing proves it did not start: the maker runs it again once the other operation has finished. A failed import names its
  job and, when the request was sent, the reason the job's log gives. When `pac` does the import it is given a copy of the settings
  the run read, not the file's path, so a file saved while the package stages is neither applied nor printed; the copy is in a folder
  only the current user can read, checked before a byte is written (`PAC_SETTINGS_COPY_FAILED` otherwise), and is removed on every
  outcome and when the run is ended by Ctrl+C, a closed terminal or an uncaught error — a cancelled run still ends as cancelled (on
  Windows with `0xC000013A`, not 1).
  `template` does not replace an existing `--out` file unless `--force` is given (`pac` replaced it silently, and every value
  already filled in with it) — not even one that appears while it works — so it needs a file system that can make a hard link (NTFS,
  ext4, APFS): on one that cannot (a FAT or exFAT volume, some network shares) it refuses with `IO_ERROR` and says that `--force`,
  which needs no link, writes there. If the temporary name it wrote the file under cannot be removed, the run still succeeds, with a
  warning that names the leftover (the next run refuses the file as a hard link).
- **What the settings file holds is kept out of what `solution-settings.js` prints** — an error, a warning, a job log, a message
  `pac` printed — wherever a text quotes it as written or in a JSON, XML or URL escape, with white space collapsed and in any case.
  A text that quotes a secret is withheld whole, whatever its length; a connection id and a value the package defines as not secret
  are replaced by `<redacted>`. A variable counts as a secret when the package defines it as one (a `TypeId` of Secret in the file
  can only add that, never take it away). For a variable the package was not read for (`pac` importing, an entry the package does
  not define) a value of six characters or more is treated as a secret, and a shorter one withholds a text only where the text has
  it as a whole word. What is not caught: a value quoted in part, hashed, base64-encoded, written as an HTML entity beyond XML's
  five, normalized in its Unicode by a service, or nested in more than three levels of encoding; a value of fewer than six
  characters that is known not to be a secret, which is printed wherever a text quotes it; and a value of fewer than six characters
  with no recorded type that a text glues to letters, digits, marks or underscores or writes inside an escape the sanitizer does not
  read. A token the run sent is never printed or written — it is taken out of both output streams, the file `template` writes and
  the note a process that is ending leaves — and a variable's value is passed through exactly as written, white space included.
- **The bundled cds-maker-sdk is current.** Through it: a business-rule or classic-workflow delete the platform rolled back (HTTP
  500, transaction not started) is re-sent, bound to the version the build read; a business process flow write waits out the
  platform's lock on the flow instead of failing; a choice read that returns options with no label is treated as incomplete metadata
  (`genpage.js types` stops and says to retry); a business rule with no action step is refused for that (`business-rule-NO_ACTION`)
  before anything is written; and a table's metadata comes back in one order on every read and every machine — columns by logical
  name; relationships one-to-many, then many-to-one, then many-to-many, each by schema name, related table and related column — so
  the copy the build keeps in its workspace no longer changes just because the platform listed the same relationships in another
  order.
- **Two rare page shapes that 2.14.0 resolved are now refused, naming the guess `generic`**: a class whose base is itself a class
  expression, used as a value before a method (`{ a: class extends class {} {}, m() { … } }`), and a class field named `new` with a
  method on the next line. Both are refused, never misread. Parenthesising the class expression (`extends (class {})`), or ending
  the field with `;` or naming it otherwise, avoids the refusal.
- **The eval graders read the new scripts the way the scripts read their arguments.** A run of `apps.js`, `genpage.js` or
  `solution-settings.js` is read with its verb where the script takes it — after its flags too (`apps.js --env <url> create` is a
  `create`) — and every run in one shell call counts, so a read followed by a write is graded as the write;
  `solution-settings.js import` is a write. The graders still read recorded text, not a shell: a command line handed to a wrapper
  (`bash -c '…'`), a here-document and variables are documented limits.

### Removed

- `scripts/lib/genpage-cli.js`, the wrapper around the `pac model genpage` page verbs, with its time limits.
- **`/genpage`'s fallback to `pac model list-languages`.** Every `/genpage` page operation goes through the SDK and needs the Azure
  CLI, so a failed language read now ends language detection instead of being retried with `pac`.

### Fixed

- **Teardown deletes a generative page that was created and never published, with its conversation.** 2.14.0 read pages from the
  published layer only, so a page its build created and no publish ever finished (a build stopped after the create, a publish that
  was refused) was "not found": teardown kept the page and its conversation and dropped its record. It also deleted only the page
  row, and the conversation messages, which do not cascade, stayed behind for every page it did delete. Teardown now reads the saved
  layer, deletes the conversation with the page (a history it cannot fully remove is a warning that names the messages) and matches
  a page the build made by the name its receipt recorded as well as by the spec's current name.
- **Teardown deletes the pages of an app that was created and never published, and proves a page by the entries of the app's
  navigation.** 2.14.0 read the app's navigation from its published layer, and an app nobody published (a build stopped before its
  publish, an app saved and left) has none, so its pages were proven by this workspace's records alone: a page only the app's
  navigation named was kept, and the app and its sitemap — the only proof of it — were then deleted. Teardown now reads such an
  app's saved navigation. A page is proven by an entry of the navigation, never by the text of the XML, read by one strict XML
  reader: a page named only in a comment, a CDATA section, a processing instruction or another attribute's value is not proven, a
  single-quoted `GenPageId` is, and a sitemap that is not one well-formed XML document keeps every page, and the app, for a re-run.
  A page another app still references is refused by the platform and kept.
- **Teardown keeps a table whose business rule it could not delete.** A rule is two rows — its definition and the activated copy the
  platform makes of it — and the copy can be deleted only while its table exists. When a rule's delete failed (an HTTP 500 "There is
  no active transaction.", say), 2.14.0 went on and deleted the table, which left the copy behind for good, and the re-run reported
  success. The table is now kept — `table <name> (kept — business rule(s) on it could not be deleted (…), …)`, counted as kept in the
  summary — until a re-run deletes the rule first, then the table. Teardown deactivates a rule before it deletes it, so a rule whose
  deactivation succeeded and whose delete failed stays deactivated until then; one whose deactivation failed too stays as it was. A
  reused or system table keeps its own reason, and the failed delete is still sent once. What depends on the
  kept table — its icon web resource, a global choice its columns bind, a relationship to itself — can fail to delete in the same run
  and is reported too, until the re-run removes the table.
- **The connection list and the connector commands are pinned to the environment.** 2.14.0 ran `pac connection list`, and told the
  agent to run `list-connector-operations` and `get-connector-schema`, without `--environment`, so they answered for the active
  organization of `pac`'s auth profile — not necessarily the environment being built — and a settings import bound to one of those
  connections failed with `ConnectionNotFound`. `list-connections.js` and the `pac` fallbacks now pass `--environment`, and
  `/genpage` is told to pass it to `list-connector-tables` too.
- **A read that spans more than one page follows the platform's continuation link.** The link is absolute and was requested as a
  path under the API root (HTTP 404), so a result longer than one page — an app's components, the saved sitemaps, the apps never
  published — was reported as unverifiable instead of read. A refused read now names the URL and carries the platform's own message.
- **A new app whose navigation Dataverse would refuse stops the build before it writes anything.** A new app is created before its
  pages exist, with its navigation minus the `page` entries, and Dataverse refuses to create a sitemap with no non-empty area
  holding a non-empty group, so a spec whose navigation was only pages, or had `areas: []`, an area with no group, a group with no
  entry or no `appShell` at all, passed validation and stopped at the app step, after the solution, tables, views and forms were
  written. The build now refuses such a spec for a new app up front: the dry run marks the app step as one that would stop the build
  and asks for the steps marked `?` to be fixed rather than applied, and `--apply` halts (`app-navigation-empty`) before its first
  write, saying what to add — a new app needs one entry that is not a page. An existing app is not refused for a navigation of pages
  only (its pages are written into it once they exist) or for one with no entry at all: Dataverse accepts an empty navigation when
  an app's sitemap is updated, so the build goes on and warns that the app is left with none. A spec with no `appShell.areas` is
  refused for every app. `lint-app-spec` warns about a navigation a new app cannot be built from; validation is unchanged.
- **An alternate key over a new table's name column is made after the column's length is set, so the first build succeeds.** Some
  environments make a new name column 850 characters long whatever length the table's create asks for, and Dataverse refuses a key
  over it (a key holds at most 900 bytes, 2 for each character of text); 2.14.0 set the length as the last step of the data model,
  after the key, so only a second run made the key. A key over the name column of a table the build creates, in a spec that gives
  `primaryAttribute.maxLength`, whose label goes out in one language (a string, or a map that names one language), now waits for
  that step — the dry run lists it there — and is not sent when the step failed: the build stops with a message that names the
  length and the cause (`alt-key-name-length-not-set`) instead of the platform's refusal. The build runs that stop again exactly when
  the length step's failure is one it runs again — a throttled or unavailable service, a timeout or a reset, or a lock, a SQL timeout,
  a concurrent operation or a deadlock the service names by its code — and never because of the key's name; the warning for the length
  says the build stops at that key. A key labelled in several languages is still made before the length is set — setting it reads the
  column with its labels, which would cost a multi-language create its other languages — so where the platform refuses it the build
  warns, naming the key and its languages, and says to run the build again (the length is set as it stops) or to label the key in one
  language. A key in a spec that gives no length keeps its place: give `maxLength` for a name column you key.
- **After the build's automatic retry of a transient failure, a table the failed attempt created gets the name column length that
  attempt could not set — and only that table.** When the attempt's own length step failed too, 2.14.0's retry found the table and
  left its name column as it was, without a word. The length is now carried to the retry, as the publishes an attempt owes are, set
  at the end of the retry's data-model phase and reported as owed (`owed by the attempt that created the table`). It is read and
  written by the MetadataIds of the table and of its name column, so a table another maker deleted and made again while the build
  waited is left as it is, with a warning, never shortened. A length no attempt got as far as setting is tried once more when no
  retry follows. A later run still leaves an existing table's name column alone.
- **An unreadable table list is a failure in every script, not "no tables".** The bundled SDK reads a 2xx answer with no `value` list
  — a sign-in or proxy page, `{}`, `null` — as an environment with no tables, and the scripts turned that into decisions: the build
  created a table that exists, the teardown skipped its system-table check (and, where every answer was such a page, reported a table
  deleted that nothing deleted), the flow name check saw no clash, the verifier reported every declared table missing, and
  `list-tables.js --exact` named every searched table missing. The table-list read is now held to being a list for every SDK the
  plugin makes (`TABLES_UNREADABLE`), so each fails with that reason: the build, which reads each table by name and turns to the list
  only when that read is not conclusive, stops at the first table whose existence it cannot establish instead of creating it
  (`table-list-unreadable`, which it does not run again: a run a moment later reads the same answer), keeping what its earlier steps
  wrote (the solution, a global choice, the tables before it), and its dry run says `unknown`; the teardown deletes no table (its
  other steps still run), the flow name check warns that it could not be made, the verify fails, and `list-tables.js`
  exits 1. `{ "value": [] }` is still an empty answer, and no request is added or changed.
- **A rebuild applies a changed app name and description.** 2.14.0 set them when the app was created and never again. A rebuild now
  writes a changed, non-blank `app.name` / `app.description` to the existing app on the push it already makes for the navigation;
  nothing is written when they already match, a spec that leaves them out never blanks them, and the unique name never changes. The
  icon is still set only when the app is created: a different `app.icon` is reported as not applied. Two cases keep the existing
  text and warn that it was not applied while the rest of the build goes ahead: an app that was never published (publish it in Power
  Apps and re-run), and a name or description held as one text per language — the SDK writes both in one request, so while either is
  held that way the header is not edited at all, and a changed plain text beside it and an `app.aiDescription` are reported as not
  applied too. Nothing that is not plain text is ever sent: the SDK also writes the header it holds whenever its own read of it
  fails, so the plugin's HTTP client refuses that write and the build stops with `APP_HEADER_NOT_PLAIN_TEXT` before anything is
  sent; running it again normally succeeds.
- **A rebuild applies the business process flow stage edits that cannot move a record.** 2.14.0 reused an existing flow as it was. A
  stage added or renamed, and a step added, renamed, rebound to another column, made required or optional, or moved, are now written
  in place in one push (an active flow stays active; every stage keeps its id). An edit that would remove a stage or a step, reorder
  the stages, or that cannot be told from a removal, is refused with the reason and the ways forward: no stage or step edit is
  applied, and the requested Active/Draft state is handled independently. An edit the SDK refuses — adding, removing or reordering
  the stages of a flow that holds a branch, or the steps of a stage that holds an action — is reported as not applied.
- **`readOnly` and `hidden` reach every cell of a field.** A field a deployed form holds more than once — in two sections, or in the
  form's header, footer or a tab's own header or footer — got the flag on its first cell only, so the other stayed editable or
  visible. Each cell now gets it, with the rest of the cell left as it was, and `--verify` checks each one.
- **`--verify` compares tab and section labels, per language, in the language the build wrote them.** 2.14.0 used a label only to
  find its tab or section and never compared it, so a relabel that never reached the published form passed. A tab or section label
  the spec writes is now compared with the published form in the build's authoring language (a label map at each language it
  declares); a relabel that never reached the published form, or a caption the published form lacks, fails the check, and a
  translation in another language never stands in for it. `verify-model-app.js` takes the build's `--language-code` (and the build's
  own `--verify` is told the language it used), so a form built in a language other than the organization's verifies. What cannot be
  compared is listed as `unverified`, neither passed nor failed, with the reason and what to do (`unverified` changes neither `ok`
  nor the exit status): a label whose language cannot be established (the organization cannot be read, and nothing else says it),
  and a label in a language that no label of the form's read is in, when the read carries labels in other languages (a form whose
  read carries no label at all still fails the captions the spec declares). The platform decides which languages' labels the form
  read returns: a form built and published with Spanish captions in an English-language organization reads back with every label in
  English, so its stored Spanish captions are listed, to be checked in Power Apps with that language, not failed. A label map is
  compared at the languages the read carries and listed for the others; a caption in a language the read carries is compared
  strictly, and a stale one fails.
- **Verify no longer calls a published dashboard "not published" in an environment with a second language.** `verify-model-app.js`
  and the build's `--verify` check a dashboard's tiles only when the saved layer they are read from is the published dashboard, and
  2.14.0 compared the two FormXML reads as text. Where another language is provisioned beside the base one, the saved read carries a
  label in it in every cell and the published read does not, so a dashboard nothing had changed since its publish was listed as
  having changes that are not published (unverified), and every job whose surface it is failed with it. The two reads are now
  compared without the labels of a language the published read carries none of; a tile, a cell, an attribute, any other text, a
  label in a language it carries, and a FormXML that is not one well-formed XML document are still changes. That is what a user whose
  own language is the organization's base language reads. For a user whose language is the other one, the platform's published read
  carries both languages and can word a caption differently from the saved read, so the dashboard stays unverified for that user, as
  before: never passed without being proven.
- **A label saved and not published on a form the app holds, or is about to hold, is no longer held back by the app's publish.**
  Dataverse leaves a saved form's label changes out of the published form when a publish that names only the app comes first,
  whoever saved them, and 2.14.0 published before the app only the tables whose existing views and forms the build reconciled. With
  `--publish` the build now publishes, in one request before the first thing that writes or publishes the app — its create, its
  sitemap or routing-description push, the pages finalizer, the repair of a default view the app lost (which a changed-only
  re-upload of a page can make on its own) and the publish phase — the tables whose views and forms it reconciled, the tables of the
  charts it wrote, the tables whose Main forms its write adds to the app and, for an app that already exists, the tables of the form
  and chart components the app's saved component list names, whether or not the spec names them (a form a maker added in the
  designer and never published included). The tables whose Main forms a write adds are those of the navigation it sends: the spec's
  for the build's own create and sitemap pushes, so the first build and the build that first pins a form are covered too; the app's
  own on the server for a push that only carries the routing description; none for the repair of a default view, whose push adds the
  view and no form. A table the app is not known to hold a form or chart of — one only declared, only the target of a lookup column,
  only read by a page, or only pinned in `app.tables` — is not published by it, so what a maker left unfinished there stays
  unfinished. If the app's components cannot be read completely and unambiguously, the build publishes only the tables it changed
  and those its write adds forms of, and says which read failed. A rebuild of an app whose views or forms exist still sends the same
  three publishes; a build that reconciled nothing — a first build, say — sends one more when it has something to name, and so does
  a changed-only re-upload that has to put a default view back (the tables, before the app). A chart's description now goes out with
  its table before the app's publish instead of after it.
- **A refused publish before the app, and a build that stops before its publish phase, say what they leave unpublished.** When the
  request above is refused the build goes on — a refusal of the publish of the tables it reconciled still stops it before the app,
  as in 2.14.0 — and says that its protection did not apply, what it saved on those tables (a chart's description included, which
  Dataverse may or may not hold back: that was not measured), and, apart from that, that a label saved on a form the app holds there
  may have been left out by the app's publish and may need to be saved again. A build that stops before its publish phase, after
  publishing what it had deferred, reads the saved layer of the forms, views and charts of the spec's tables (the tables its pages
  read included) and lists those still saved and not published, or says it could not read them and names the tables to publish.
  Columns and other kinds of change are not read, and a halt after the publish phase says nothing of the kind.
- **The build runs itself again for what the service answered, not for the names a maker chose.** 2.14.0 decided whether a halt was
  transient from its whole message, and a message quotes what a maker named, so a page, view, role, flow or table called "SQL
  Timeout …" (or `contoso_customizationlockexception`) made a halt the build cannot change — a navigation-parity or `PAGEREF_` halt,
  a 403 — run every earlier phase again, up to three more times. The decision now reads the failure's structure: a throttle (429),
  an unavailable service (502, 503, 504), a timeout or a reset of the connection, and the conditions the service names by the error
  code of its answer — a customization or solution lock, a SQL timeout, a concurrent operation, the lag of a column the spec
  creates, and a SQL deadlock (the generic SQL error whose last SQL number is 1205) — are run again; any other status (a 400, 401,
  403, 404, 409, 412 or 500), a refusal of the spec, an identity or ownership conflict, a removal that needs approval, a
  prerequisite, a held pages lock and a local file error are reported once, whatever the answer's words. A failed publish of a
  table's default views is judged by the status of the answer it embeds, not by the table's name.
- **The HTTP client sends a failed request again only for a failure that can pass.** 2.14.0's client sent a request that got no
  answer up to six times whatever the reason, so a certificate that does not verify, an unknown host or a refused connection cost
  six attempts and their back-off before the error. It now sends again only for a reset, a timeout, an aborted connection, an answer
  cut off or a temporary failure of name resolution, read from Node's own error code (from the failure's words only when there is
  none), and never for a certificate that does not verify, whatever names it quotes.
- **A build that was killed while it wrote pages no longer leaves its pages lock in the way.** A build killed outright ("End task",
  an agent's timeout, a power cut) cannot remove its `pages-<app>.lock`, and 2.14.0 stopped every later build of that app at the
  pages phase (`pages-locked`) until the file was deleted by hand. The lock now records who took it — the process, the machine and,
  on Linux, the pid namespace and the process's start time — and the next build releases it, and says so, when it can prove that
  owner is gone: on this machine, no such process or one that started at another time (on Linux only when both pid namespaces can be
  read and are the same). A lock whose owner may be running, is on another machine or has a record that cannot be read is refused as
  before, and no lock is ever taken for its age.
- **A killed run's temporary workspace no longer stays in the OS temp folder.** The workspaces the page backend and the other
  scripts make for the SDK hold the source of every page read and the environment's address, and were removed only when the run
  ended normally. They are now made, with a record of who made them, in one folder of the plugin's own in the temp folder
  (`power-platform-skills-model-apps`, with `-<uid>` after it on Linux and macOS), and the first workspace a later run makes removes
  those of runs that are provably gone, saying on stderr what they held, and finishes a removal a killed run began. A run looks at
  no more than 500 entries of that folder and the next one carries on where it stopped, so entries that must be kept never hide the
  ones behind them. A workspace given to `pac` is marked as lent when it is made and is taken only once its maker is gone and it has
  not been written to for a week. On Windows the plugin's folder is given an access list of its own — this user, the system and the
  administrators — and a folder that was already there is used only when no one else can change it; where that cannot be shown, the
  workspace is made in the temp folder as before: the plugin's folder is never a reason for a run to fail. A normal run leaves the
  temp folder as it found it.
- **A Dataverse failure can no longer carry the access token into what a script prints.** The Azure CLI-token client takes the token
  (whole, or any of its segments of 24 characters or more) out of every answer that is not a success, and out of a transport
  failure's text, before the SDK quotes it; `dataverseRequest()` takes it out of what a failure repeats. A successful answer is
  never altered.
- **`/genpage`'s upload counts a style shorthand as already deployed only where the deployed page had it.** 2.14.0 counted a key as
  inherited when the deployed page had the same key and value anywhere, so an edit that moved `borderColor: red` to another slot,
  hook or arm of a condition — where Griffel drops it just the same — was only warned about. A key is now inherited only with the
  same value in the same slot of the same `makeStyles` hook (proved by the name it is bound to) and the same arm of every condition;
  anything else is new, and refused as one. A key in a hook the page does not prove by name (written inside a function, passed as an
  argument, exported as the default, or bound to a name two hooks share) is new on an edit too: delete it, or write the longhands.
- **A rebuild no longer warns about the icon the platform gives a page entry.** A generative page entry the spec gives no icon gets
  the platform's default page icon, and every rebuild of an app with a page then said it had kept the environment's `vectorIcon`
  because it had changed there since the spec was last applied. That default is no longer taken for a maker's change; an icon a
  maker chose is still kept and reported, and an icon the spec names is written over the default.
- **A type whose members start like an element's head no longer has the data after it rewritten.** `<in U>(y)`, `<public U>(y)`,
  `<const in U>(y)` and `<>(y)` in an interface, an object type or a function type (`callback: <in U>(y: U) => void`), and a method
  named `delete`, `typeof`, `void` or `instanceof` that has type parameters (`delete<T>(url: string): Promise<T>`) — also after a
  modifier or an accessor word, a decorator or a line break, with a type parameter written with a Unicode escape, and in the braces
  of a class or an interface whose heritage ends in a call — were read as JSX elements whose text ran on to the next closing tag, so
  a `navigateTo({… PAGEREF_…})` text in a later string, template, comment or regular expression could be rewritten. They are now
  read as the type parameters they are wherever the text after the list shows it. Where a string, template, comment or regular
  expression could hide the closing tag, so that the two readings may end the head in different places, the page is refused naming
  the guess (`generic`), like any call signature; so is a page whose syntax the reader cannot read with confidence — a function
  type's parameter list it cannot read to its end (`generic`), or a name written with an escape (`identifier`). An element after
  `void`, `typeof` or `delete`, and one whose text starts with a parenthesis and holds a comment (`return <>(y); // note</>;`), is
  read for certain in more places — the bodies of functions, methods and decorated members, after `return`, after a `,` in
  parentheses, after a word that takes an operand and a line break — so those pages resolve.
- **More pages that 2.13.0 resolved and 2.14.0 refused resolve again: JSX text whose line before a `//` note is left open
  (`[ // note`, `m? = // note`, `f(a = // note`) and a later line that starts with a `/`.** The regular expression that line would
  open is read: where it does not close on its line, ends at the closing tag's own `/` with nothing after the tag that an operand
  could start, or closes right before it, no type can have the text and only the element compiles. A closing tag that an operand may
  follow, and a path with a `/` of its own and text after it, are still refused (both readings compile, or only a parser tells them
  apart): put the call before the text, or write the line with one name before the `//`.
- **A download writes the same files for the same app, and keeps each page's key.** 2.14.0 wrote the pages and several lists in the
  order the file system or Dataverse gave them, and sorted others by the host's locale, so two downloads of one app could differ;
  and a page's key was minted in that order, so two pages whose names make one slug (`Work_Order`, `Work Order`) could swap keys
  between downloads, and a copy of the spec deployed to another environment then updated the wrong pages. The pages, the description
  inventory, the tables an app holds beyond its navigation, the Main-form names of `app.mainForms` and the `notRoundTripped` notes
  are now written in a fixed order, compared by code units and never by the host's locale (the pages by name, then id). A page's key
  comes from the app's page manifest, then from the key an earlier download of the same app gave it (the `app-spec.json` already in
  `--out`, used only when its `app.uniqueName` is this app's), and only a page with neither gets a fresh key, minted in page-id
  order. When that earlier spec gives one key to two pages, or one page two keys, for a page the manifest does not bind, the
  download stops before it writes anything (`page-keys-ambiguous`, naming the pages and keys): correct the file and download again,
  or pass the new `--reset-page-keys` to give exactly those pages fresh keys. Download into the same working folder every time.
- **The eval graders count `pac solution import` as a write, and read a listing kept as text.** 2.14.0's graders did not count
  `pac solution import` as a write, so an import escaped the auth-gate and refusal checks, and read a listing recorded as the JSON
  text a command printed — a string result, or a log's `Result:` line — as a PAC table, one row named after the start of the JSON.
  Such a listing is now read as the data it is, and a PAC table still goes to the table reader.

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
