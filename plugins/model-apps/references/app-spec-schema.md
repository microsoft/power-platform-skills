# App Spec schema (app-builder)

The **App Spec** is the reviewable JSON contract between the interactive authoring flow and the
deterministic builder (`scripts/build-model-app.js`). Author it to this shape, lint it
(`scripts/lib/spec-lint.js`), then build it — **never hand-write a builder.**

> **Canonical example:** [`samples/app-spec.support-desk.json`](../samples/app-spec.support-desk.json)
> — 3 tables, 2 relationships, 3 views, 2 charts, 3 forms (with sub-grids), relational sample
> data. Read it first; it shows every section in use. `app-spec.project-tracker.json` shows an
> **explicit form layout** (`tabs`).
>
> **Review the whole spec** (data model + sitemap + form wireframes + page-intents + design contract)
> before approving the build: `node scripts/preview-app.js @<dir>/app-spec.json`. For a single
> form wireframe: `node scripts/preview-form.js @<dir>/app-spec.json <entityName>`.
> The eval harness uses the same spec to grade per-stage structural facts offline — see
> [`evals/model-apps/app-builder/EVAL_GUIDE.md`](../../../evals/model-apps/app-builder/EVAL_GUIDE.md)
> and [`docs/architecture.md`](../docs/architecture.md) → *`/app-builder` — build pipeline*.

## Modeling cheatsheet — read this before exploring anything else

This doc is the **single source**; everything the builder supports is here, so you should NOT need
to read the SDK, the lint, or the engine to author a spec. Common asks → how to model them:

| You want… | Model it as | Section |
|---|---|---|
| An auto-numbered identity (WO-00001) that **is** the title | `autoNumberFormat` on `primaryAttribute` | entities |
| An auto-number that is **not** the title | a column `type: "AutoNumber"` + `autoNumberFormat` | entities |
| A plain many-to-many | `ManyToMany` relationship; sub-grid on either side | relationships |
| **N:N with attributes** (role/date per link) | a **junction entity** + two `OneToMany`; `$parents` for sample rows | relationships / sampleData |
| Client-side validation / defaulting | a `webResources[]` script + form `events[]` | webResources / forms |
| "My …", "… this week", "not Completed/Cancelled" views | view `filters[]` (`eq-userid`, `this-week`, `not-in`) | views |
| Records pre-set to a custom status reason | `statusReasons[]` on the entity + `statusReason` on sample rows | entities / sampleData |
| A child grid on a parent form | `subgrids[]` (1:N or N:N — auto-resolved) | forms |
| A simplified create dialog / read-only related card | `forms[].formType` `QuickCreate` / `QuickView` | forms |
| A related record's card shown on a form | `forms[].quickViews[]` (lookup + a `QuickView` form by name) | forms |
| A command-bar button that runs JS | `commands[]` (`library` + `function`; optional `hidden`/`disabled`) | commands |
| A command **drop-down menu** of buttons | `commands[].type: "FlyoutAnchor"` + `children[]` | commands |
| A dashboard of chart/list tiles | `dashboards[]` (`tiles[]` reference declared `views`/`charts`) | dashboards |
| A dashboard in the app nav | a `dashboard` sitemap subarea in `appShell` (auto-pins it) | appShell |
| A table in the app but not its navigation | `app.tables` (logical names; additive membership) | app |
| Only selected Main forms offered by this app | `app.mainForms` (table → Main form names) | app / forms |

The builder is **idempotent** and runs everything in one pass (no post-build scripts): tables,
columns, relationships, web resources, views, charts, forms (+ sub-grids + JS handlers), commands, dashboards, the app,
sample data (incl. multi-parent junction links + status reasons), and publish.

## Top-level shape

```jsonc
{
  "solution": { "uniqueName": "ContosoSupportDesk", "displayName": "Contoso Support Desk", "publisherPrefix": "new" },
  "app":      { "name": "Support Desk", "description": "Track tickets", "icon": "new_appicon" /* , "aiDescription": "…" — optional routing description */ },
  "entities":      [ /* tables — see below */ ],
  "relationships": [ /* 1:N links — see below */ ],
  "globalChoices": [ /* optional shared option sets */ ],
  "webResources":  [ /* optional JS/HTML/CSS for form logic */ ],
  "views":         [ /* saved queries */ ],
  "charts":        [ /* Choice-column charts */ ],
  "forms":         [ /* main forms — may wire JS event handlers */ ],
  "appShell":      { "areas": [ /* sitemap */ ] },
  "sampleData":    { /* optional, keyed by entity schemaName */ },
  "ai":            { /* optional — AI feature flags + row-summary config */ },
  "personas":      [ /* optional — one security role per persona (see below) */ ],
  "roleGrants":    [ /* optional — ADD privileges to a role you did NOT author (see below) */ ],
  "languageCode":  1031 /* optional — LCID for Dataverse labels; defaults to the org's base language */
}
```

- **`app.icon`** *(optional)* — the app tile icon. Must be a **declared image web resource**
  (png/jpg/gif/svg/ico in `webResources[]`) so the app is **self-contained** on export/import.
  **Omit it** and the build generates a simple default SVG icon **inside the solution** — either
  way the app never depends on an arbitrary external/managed icon (which would fail to import into
  a new environment). The app's **sitemap** is also added to the solution automatically.
- **`app.newLook`** *(optional, default off)* — opt into the **modern ("new look") shell** for this app.
  Writes the per-app `NewLookAlwaysOn` setting, which Dataverse describes as enabling the new look and
  **hiding the user switch** — so the result is deterministic rather than a per-user preference. It is
  a *setting*, not an appmodule column: `navigationtype` is Single/Multi **session** and unrelated, and
  the other new-look definitions (`NewLookOptOut`, `NewLookModernExperienceOct2023`) both default to
  true and are user-facing toggles, so writing them would not give the author a dependable result.
  Scoped to the app **and** the solution, so it travels on export/import.
  **Best-effort:** this is a platform feature that rolls out by tenant. If the setting cannot be
  written the build still succeeds — the app is fully functional on the classic shell — but it warns
  and reports `created.newLook: false`, so a failure is never mistaken for success.
- **`app.headerNavigationRefresh`** *(optional)* — control the **Wave 2 header and
  navigation refresh** (public preview) for this app.
  **The platform default is ON, not off.** Verified against the real vendored bundle (offline, by
  capturing the writes a push issues): the SDK defaults the app artifact's
  `headerAndNavigationRefresh` to `true` and pushing a **new** app writes the setting to its ON value
  unprompted. So set this to `false` if you want the classic header and navigation — omitting it
  leaves whatever the platform chose, which for a new app is on.
  Both values are honoured: `true` writes ON, `false` actively writes OFF. Treating `false` as "do
  nothing" would silently leave the feature on for an author who asked for it off.
  This is a **different setting from `app.newLook`** and the two are independent: `newLook` writes
  `NewLookAlwaysOn` (the new-look shell), while this writes `HeaderAndNavigationRefresh` (the header
  and navigation redesign). Enabling one does **not** enable the other.
  Written through the SDK's dedicated API rather than a raw setting write, because the encoding is a
  trap: it is a Number **tri-state where ON is `'2'`, not `'1'`**, and writing `'1'` is *accepted by
  the API and then silently fails to enable the feature*. Delegating means the plugin cannot get it
  wrong.
  **Best-effort**, like `newLook`: a tenant without the setting definition still gets a fully working
  app, with a warning and `created.headerNavigationRefresh: "unknown"` — never a silent success, and
  never a claim about a value that was not written. On success
  `created.headerNavigationRefreshOutcome` records `created` / `updated` / `unchanged`.
- **`app.uniqueName`** *(optional, download-emitted)* — the app module's **real, immutable** Dataverse
  uniquename (e.g. `crba3_supportdesk`). A **downloaded** spec carries it so a rebuild resolves the
  **existing** app by identity — even after you **rename** the display `app.name` — instead of creating a
  **duplicate** app. You normally never hand-author this: an authored create-fresh spec omits it, and the
  build derives the uniquename deterministically from `solution.publisherPrefix` + `app.name`.
  Download recovers the immutable name from the fetched SDK artifact, including an unpublished
  GUID-addressed app, and refuses when it cannot resolve identity; it never derives one from display name.
- **`app.tables`** *(optional)* — additional app table membership, independent of navigation:
  `["task", "email"]`. It is an array of non-empty logical names with no case-insensitive duplicates.
  A table need not be declared in `entities[]`, but must exist by the app-shell phase; an unresolved
  name stops the build before any app write. A navigation table is already included, so listing it
  here is harmless but lint warns. Membership is **additive**: removing a name from the spec never
  removes an existing app component.
  Download emits hidden type-1 members here, sorted. A custom hidden table also goes to `entities[]`;
  a known non-custom hidden type-1 member does not, **even when a view/chart/form references it**, so
  rebuilding does not copy another solution's custom columns or relationships. Tables discovered
  **only** through view/chart/form components retain their existing schema-capture behavior.
  Membership-only stock tables do not need a primary-name column.
  A hidden type-1 table with unknown custom/stock status is also reference-only, with a loss note;
  schema is adopted only on an explicit `IsCustomEntity === true`, even with companion assets.
- **`app.mainForms`** *(optional)* — a per-navigation-table **Main-form allow-list**, by name:
  ```json
  {
    "minimumPluginVersion": "2.13.0",
    "app": {
      "name": "Work Items",
      "tables": ["task", "email"],
      "mainForms": { "contoso_workitem": ["Work Item"] }
    }
  }
  ```
  Each key must name an `Entity` table in this app's sitemap, ignoring case; a hidden `app.tables`
  reference alone is not eligible. Each value is a non-empty array of distinct names, compared
  ignoring case and accents. A name resolves within **(table, Main)** to a declared form or an
  existing **active** Main form; missing, inactive or ambiguous names stop the build before an app
  write. A same-named QuickView/QuickCreate is a different identity and does not shadow a valid Main.
  A known `forms[].formId` does not bypass active-name ambiguity; a newly created/reused id counts
  as a candidate even before the catalog reports it.
  `{}` restricts nothing. Empty lists are refused: an app with no Main member offers every form.
  **Create is exact; existing-app updates only stop widening.** Listed forms are added, other Main
  forms are not added, and **none are removed**. Existing extras produce a warning and fail
  `--verify`: remove them in Maker (**app designer → table → Forms**) or include them in the list.
  Every later app push re-supplies the directive; it is not stored as a server-side allow-list.
  Quick Create, Quick View and card forms, dashboards, views and charts are unaffected.
  This does **not** choose a default, an order or security roles. Lint warns when the list excludes
  the explicit default or first `entities[].mainFormOrder` form. A user's remembered Main form is
  **per table**, not per app. **Measured:** membership changes after first publish did not reach
  the runtime form list within 89 minutes, even after validation and republishing; do not promise
  immediate runtime changes for an existing app.
  Download emits a list only for a non-empty strict subset of the table's active Main catalog whose
  member names are unique among its Main forms. Inactive or unclassifiable pins are named in
  not-round-tripped notes; an encodable active restriction is still preserved. Empty/full active
  membership is omitted, with a note for the empty case. Form layouts themselves are not reconstructed.
  **Download is a server-current edit snapshot**, including saved unpublished app/sitemap changes.
  Navigation, table classification and Main membership use that same current layer; `--verify`
  instead checks the published layer that users consume.
  All modeled navigation targets (entity, generative page, URL, dashboard and custom page) and
  their occurrence counts must match. If those multisets disagree, or the SDK sitemap is missing,
  download refuses the mixed snapshot: publish the app, then download again.
- **Capability floor:** set **`minimumPluginVersion: "2.13.0"` or newer** whenever using `app.tables`
  or `app.mainForms`; lint warns without it. Download adds that floor when it emits either field and
  retains a higher authored floor. The 2.12 consumer's existing version gate refuses such a spec
  instead of silently ignoring membership instructions it cannot build.
- **`app.aiDescription`** *(optional)* — the app's **routing description**: what an agent or router
  reads to decide whether *this* app is the right place for a request. It is **separate from
  `app.description`**, the text on the app tile, and maps to the platform's
  [`appmodule.aiappdescription`](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/appmodule#BKMK_aiappdescription)
  column. Write who the app is for, the tasks it covers, what it deliberately excludes and — when
  sibling apps expose the same tables — how to tell them apart (see *Descriptions* below).
  **Absent means "leave it alone":** the platform can write this text itself, so the build writes the
  field only when the spec sets it (at create, or on an existing app when the value differs) and never
  blanks it. A download carries it back when the app has one, and `--verify` checks the deployed value
  whenever the spec sets one. Changing it on an app that has an **unpublished** change to its name,
  description or routing description (saved in Maker but not published) halts the build: Dataverse
  refuses the write until that change is published, so publish the app (or discard the change) first.
  **Rules:** a non-empty string of at most 1,048,576 characters, the column's maximum.
- **`languageCode`** *(optional)* — the [LCID](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-lcid/)
  stamped on the Dataverse labels the build creates: data-model labels (table, column, choice, status
  reason, relationship and alternate-key display names) **and** form, dashboard and sitemap labels.
  The serializers used to hardcode 1033 with no caller override; they now take the
  authoring language, so a non-English build no longer produces translated columns next to English
  form labels.
  **Normally omit it**: the build reads the organization's base language
  (`organization.languagecode`) and uses that, which is always a language the org has provisioned.
  Set it only to deliberately author labels in a *different* provisioned language than the org
  default; `--language-code <lcid>` overrides it for a single run.
  If the organization has **not** provisioned the LCID you pin, the build stops at the start of the
  data-model phase and lists the ones it does have — Dataverse would otherwise accept the table and
  Choice labels (silently storing them under the org's base language) and then reject the first
  `DateTime` or `Memo` column, leaving a half-built data model. The check is best-effort: if
  `RetrieveProvisionedLanguages` cannot be read, the build proceeds unchanged.
  Must be a positive integer LCID up to 65535 — `1031`, not `"de-DE"` and not `true`. An invalid
  value is rejected by validation, and a caller that bypasses validation gets a warning naming the
  discarded value rather than a silent fall-through.
  **It is build-wide.** One LCID is resolved and applied to every table, column, choice, status
  value, relationship and alternate key in the spec. There is **no per-table language**: an
  `entities[].languageCode` is rejected, because the build cannot honour it — the SDK takes the
  language as a construction-time option. To label something in **several** languages, write the
  field itself as an LCID map (see *Localized labels* below); an `entities[].localizedLabels` block
  is rejected too, because the map belongs beside the name it labels rather than in a parallel
  addressing scheme.
  **Emitted by `download-model-app.js` only if you pinned it yourself.** It is deliberately never
  read from Dataverse: an LCID copied out of the source org would be re-applied verbatim when the
  spec is rebuilt somewhere else, which is exactly how a spec starts failing in an org that lacks
  that language. Leaving it absent lets every target org resolve its own base language. But a value
  **you** wrote is carried across a download from the previous `app-spec.json` at that path, so a
  pin is not silently lost — losing it would leave newly created columns in the org default while
  the existing ones keep the pinned language, with no error anywhere.

## Localized labels — one name, several languages

`languageCode` above sets the **one** language every plain label is written in. To label something in
**several** languages, write the field as a map keyed by LCID instead of a string:

```jsonc
"displayName": "Project Baseline"                                       // one language
"displayName": { "1033": "Project Baseline", "3082": "Línea base" }     // two
```

This works on every author-facing name the SDK can localize. **Measured**, per surface, against an
organization with 1033 and 3082 provisioned — the table is the honest scope of the claim:

| Where | Field | Status |
|---|---|---|
| `entities[]` | `displayName`, `pluralName` | **verified** — stored in both languages |
| `entities[].primaryAttribute` | `displayName` | **verified** |
| `entities[].columns[]` | `displayName` | **verified** |
| `entities[].columns[]` | inline Choice `options[]` | **verified** |
| `relationships[].lookup` | `displayName` | **verified** |
| `entities[].alternateKeys[]` | `displayName` | accepted; not consistently reproducible |
| `globalChoices[]` | `displayName`, `options[]` | **REJECTED at the spec gate** — see below |

**Global choices are the exception, and it is not this plugin's doing.** Measured: a global option set
created with a two-language label stores only the base language — **including through a raw
`POST /GlobalOptionSetDefinitions` that bypasses the SDK entirely** (0/4). Because Dataverse reports
nothing when it drops the language, a localized `globalChoices[]` label is **rejected by validation**
rather than sent: accepting it would produce a green build with the author's second language silently
gone, which is the exact failure this feature exists to end. Use an **inline** Choice on the column
(`columns[].options[]`, verified) when you need localized option labels, or set the global set's
labels in Maker. Plain-string global-choice labels are unaffected.

**Why a map on the field, not a `localizedLabels` block.** The label belongs beside the name it
labels. A table-level block cannot address a Choice **option** or a lookup's display name without
inventing a parallel addressing scheme, and it splits one value across two places that then drift.
An `entities[].localizedLabels` key is therefore **not** a supported shape.

**Rules**
- Keys are **canonical positive integer LCIDs** up to 65535 — `3082`, not `"03082"` and not
  `"es-ES"`. A language tag is rejected rather than guessed: `es-ES` is 3082 *or* 1034 depending on
  sort order, and guessing wrong would not fail — it would label everything in the wrong language.
- Every value must be a non-empty string; an empty map is rejected (the SDK rejects one too).
- `pluralName` becomes **required** beside a localized `displayName`. The English fallback appends
  `"s"`, which is not a plural rule in most languages — so the spec asks rather than inventing
  *"Línea base del proyectos"*.
- Omitting the spec's own `languageCode` from a map is a **warning**, not an error. Dataverse serves
  the base-language label to every user whose UI language has none, so leaving it out usually means
  those users read a schema name — but a deliberately single-non-English label is legal.
- Labels for all languages are written in **one** create call. That matters: a later single-language
  `PUT` can overwrite the base label even with merge semantics.
- **Every LCID you name must be provisioned in the organization, and the build halts if one is not.**
  This is the guard the feature depends on, not a nicety. Live-measured against a 1033-only org:
  `createTable` carrying `{ "1033": …, "3082": … }` returns **success** and stores **only** the 1033
  label — Dataverse does not warn, error, or report the drop anywhere. Without the halt you would get
  a green build with the second language silently gone, which is the exact failure this feature
  exists to end. The check is best-effort in the same way the existing `languageCode` check is: an
  unreadable `RetrieveProvisionedLanguages` leaves the build unchanged, and a spec with only plain
  string labels never pays the round trip.

**Referencing a localized label.** Anywhere the spec names an artifact by its label — `sampleData`
choosing a Choice option, or `personas[].jobs[].surfaces[]` naming a screen — **any** of its
languages resolves to the same artifact. One option, one value, several names.

**Round-trip.** `download-model-app` reconstructs localized labels from Dataverse: a table, plural,
column or option labelled in several languages comes back as a map, and one labelled in a single
language comes back as a plain string (so no existing spec changes shape). The download emits
`pluralName` alongside a localized `displayName`, so its own output re-validates.

## `description` — write one on everything that takes one

`description` is optional on every artifact below and **recommended on all of them**. It is written
to Dataverse **at create time**, so it costs nothing extra and needs no backfill pass.

| Accepts `description` | Notes |
|---|---|
| `entities[]` · `entities[].columns[]` | The highest-value ones — table and column names are cryptic (`new_col3`) without them |
| `views[]` · `charts[]` · `forms[]` · `dashboards[]` | What the artifact is *for*, not what it contains |
| `businessRules[]` | Why the rule exists — the logic itself is already visible |
| `solution` · `globalChoices[]` · `webResources[]` · `app.description` | |

**Accepted by the spec but NOT written to Dataverse** (you get a build **warning**, never silent
loss) — the vendored SDK's create surface has nowhere to put them:
- **`commands[]`** — `createArtifact('command', …)` drops the field.
- **`Customer` columns** — `createCustomerColumn`'s payload is only `{ Lookup, OneToManyRelationships }`.

**Not accepted at all, deliberately:** **`personas[]`**. The SDK stamps its own ownership marker into
a security role's `description` and then requires an *exact* match on it before it will touch that
role, so a custom description would make the SDK disown the role it created and refuse to update it.

**Why it matters beyond tidiness.** A description is the only durable, machine-readable statement of
*intent* an app carries. Names say what a thing is called; descriptions say what it is for. When an
agent later inspects an app it did not build — to extend it, debug it, or answer a question about it
— descriptions are the grounding it has. Write them for that reader.

Good: `"Severity 1-5; drives the escalation rule and the SLA clock."`
Weak: `"The priority column."` (restates the name and adds nothing)

**Rules:** must be a non-empty string, max 2000 characters (the Dataverse ceiling — the platform
truncates silently past it, so it is rejected at author time instead). Omit the field entirely rather
than setting `""`; every write site omits an absent description, so **a rebuild never blanks one a
maker typed in the UI**.

**Download/read-back:** `download-model-app` preserves descriptions on artifacts it can already
reconstruct as rebuildable spec (`solution`, `entities[]`, `entities[].columns[]`, `dashboards[]`).
Views, charts, forms, business rules and global choices are not fully reconstructed yet, so their
deployed descriptions are exposed under `descriptionInventory` for inspection only rather than as
partial rebuildable artifacts. Null or absent Dataverse descriptions are omitted, never written as
`""`.

**Rebuild behaviour:** a description is written at CREATE, and is additionally **reconciled on an
artifact that already exists** for **views and charts** — so authoring one on a table whose
Dataverse-generated *"Active &lt;Plural&gt;"* view the build reconciles onto still lands. Those two
write only when the spec **explicitly sets** a description **and** it differs from the deployed
value, so an ordinary rebuild issues no extra write and an omitted description never blanks text a
maker typed in the UI.

Everything else is **create-only** — the description reaches Dataverse when the artifact is first
created and is not revisited: tables, columns, the solution, global choices, `webResources[]`,
`app.description`, forms, dashboards and business rules. Adding a description to one of those *after*
it exists is accepted by validation, builds green, and does not change the deployed artifact.

**The routing signal goes in `app.aiDescription`, not `app.description`.** An orchestrator deciding
whether *this* app is the right place to send a request needs more than the app tile can hold, so the
routing text has its own field (`appmodule.aiappdescription`), leaving `app.description` short. Write
who the app is for, the tasks it covers, what it deliberately **excludes**, and — when two apps expose
the same tables — how to tell them apart. Sibling apps over the same data are precisely where a
purpose-only description fails.

Good: `"Project-manager and portfolio work: planning projects, assigning and reprioritizing work,
and managing sprints, budgets, risks and releases. Prefer the My Work app when the request is about
the signed-in contributor's own assigned items."`
Weak: `"An app for managing projects."` (no persona, no scope boundary, nothing to disambiguate)

It follows its own rules, not the ones above: up to **1,048,576** characters, and **one string for
every language** — the column is not localizable, so it takes no LCID map. Unlike `app.description`
it is **reconciled on an existing app**: a rebuild writes it whenever it differs from the deployed
value. A download copies the deployed value into the spec — including one the platform generated —
and from then on the spec owns it: if the platform later rewrites it, `--verify` reports the
difference and the next full build restores the spec's value (a `--changed-only` apply compares the
spec with its last snapshot, not with the deployed row, so it does not notice).

## entities[]
```jsonc
{
  "schemaName": "new_ticket",            // publisher-prefixed; logical name is its lowercase
  "displayName": "Ticket",
  "pluralName": "Tickets",               // optional (defaults to "<displayName>s")
  "hasNotes": true,                       // optional — enables the Notes/timeline on the table + form
  "quickCreate": true,                    // optional — enable "Allow quick create" (IsQuickCreateEnabled)
                                          //   on the table, so the inline "+ New" (from a lookup or a
                                          //   sub-grid's + New) opens a Quick Create form instead of the
                                          //   full form. Auto-derived as true when you author a
                                          //   forms[] entry with formType "QuickCreate" for this entity
                                          //   (authoring the form but leaving the flag off is a footgun —
                                          //   the form exists but is never surfaced), so set it
                                          //   explicitly only when you want the flag WITHOUT a custom
                                          //   Quick Create form (the platform's default one is used).
  "vectorIcon": "new_ticketicon",         // RECOMMENDED — the table's OWN icon (what the modern app
                                          //   designer + app nav render for the table). Assign one
                                          //   per CUSTOM table by default so the nav shows a glyph,
                                          //   not the generic table cube. Must be a declared SVG web
                                          //   resource (webResources[] type "svg").
                                          //   NOTE: this is a web-resource name, NOT a Fluent token —
                                          //   an unresolvable value leaves the designer's property
                                          //   pane stuck on a glimmer, so it is hard-validated.
                                          //   (Author a clean, original single-path Fluent-style SVG;
                                          //   see references/authoring-flow.md → Table icons.)
  "iconDescription": "a briefcase",       // RECOMMENDED alongside vectorIcon — what the glyph DEPICTS,
                                          //   in plain language ("an outlined clipboard with a
                                          //   checkmark", "a laptop with a clock overlay"). Documentary
                                          //   only: never written to Dataverse. It is what the user
                                          //   approves in model-app-plan.md BEFORE the SVG is drawn, so
                                          //   a Fluent TOKEN name (Briefcase, ClipboardTask) is REJECTED
                                          //   — the SVG is authored fresh, and a token the user has not
                                          //   seen tells them nothing. Also valid on a sitemap area,
                                          //   group, or non-entity subarea (an entity subarea renders
                                          //   the TABLE's icon, so describe it on the table).
  "icon": "new_ticketicon_png",           // optional — raster fallback (png/jpg/gif/ico web resource,
                                          //   → IconMediumName). Prefer vectorIcon for the modern look.
  "existing": true,                       // optional — this table PRE-EXISTS (system table like
                                          //   account/contact, or a custom table owned elsewhere).
                                          //   The build reuses it; teardown NEVER deletes it. System
                                          //   tables are auto-detected and skipped by teardown even
                                          //   without this flag — set it for a REUSED CUSTOM table
                                          //   you want protected from teardown. ALSO skips
                                          //   default-view enrichment (which replaces a view's
                                          //   column set) — override with enrichDefaultViews: true.
  "description": "A customer support ticket, from intake through resolution.",
                                          // RECOMMENDED — see "description" below. Written to
                                          //   Dataverse at create time; the grounding an agent reads
                                          //   when it later inspects an app it did not build.
  "primaryAttribute": { "schemaName": "new_subject", "displayName": "Subject" },
  // primary can be auto-numbered (the number IS the record identity — recommended for orders/cases):
  // "primaryAttribute": { "schemaName": "new_ordernumber", "displayName": "Order Number", "autoNumberFormat": "WO-{SEQNUM:5}" },
  "columns": [
    { "schemaName": "new_priority", "displayName": "Priority", "type": "Choice", "options": ["Low","High"],
      "description": "How urgently the ticket needs attention." },   // RECOMMENDED — see below
    { "schemaName": "new_duedate",  "displayName": "Due Date", "type": "DateTime" },
    { "schemaName": "new_score",    "displayName": "Score", "type": "Integer",
      "visualization": "RadialDial" },        // optional — CUSTOM GRID RENDERING (preview), below
    { "schemaName": "new_externalref", "displayName": "External Reference", "type": "Text",
      "isValidForUpdate": false }             // optional — WRITE-ONCE after creation, below
  ]
}
```
- **Unknown table keys are REJECTED, not ignored.** A table accepts exactly the keys above
  plus `statusReasons` / `alternateKeys` / `mainFormOrder`. Anything else — a misspelled `pluralname`, or a
  `languageCode` / `localizedLabels` asking for a per-table language or a parallel label block —
  fails validation naming the alternative, rather than validating clean and being dropped from the
  build.
- **Column `type`:** `Text · Memo · Choice · MultiChoice · Boolean · Money · DateTime ·
  Integer · BigInt · Decimal · Double · File · Image · AutoNumber · Customer`.
  **Lookups are NOT columns** — declare a `OneToMany` relationship instead.
- **Per-type options** (all optional): `required: true` / `"recommended"`; Text → `maxLength`,
  `format` (`Text`/`Email`/`Url`/`Phone`); numeric → `minValue`/`maxValue`/`precision`;
  Integer → also `integerFormat` (`None`/`Duration`/`TimeZone`/`Language`/`Locale` — e.g. render a
  raw minute count as a Duration picker instead of a plain number); DateTime → `dateFormat`
  (`DateOnly`/`DateAndTime`); Boolean → `trueLabel`/`falseLabel`/`defaultValue` (explicit `true` or
  `false` — see note below); File/Image → `maxSizeKb`, Image → `isPrimaryImage`; AutoNumber →
  `autoNumberFormat` (e.g. `"C-{SEQNUM:5}"`); Calculated/Rollup → `source: "Calculated"|"Rollup"` +
  `formula`.
- **Write permissions** (optional, every column type **except Customer**): `isValidForCreate` /
  `isValidForUpdate` / `isValidForRead` — see `isValidForCreate / isValidForUpdate /
  isValidForRead` below.
- **`defaultValue` and `integerFormat` are boolean-typed / enum-typed spec-gate checks, not
  free-form.** `defaultValue` must be a literal `true`/`false` and only applies to a `Boolean`
  column; `integerFormat` must be one of the five literals above and only applies to an `Integer`
  column (not `BigInt`/`Decimal`/`Double`/`Money`, even though they share the same numeric
  `minValue`/`maxValue`/`precision` options) — either mismatch is rejected by name at validation
  time rather than surfacing as a mid-build SDK error.
- **`required` converges on rebuild only when authored explicitly.** For a new column, `true` creates
  Dataverse `ApplicationRequired` and `"recommended"` creates `Recommended`. For a column that
  already exists (including the primary/name column), a rebuild first reads its current
  `RequiredLevel` and only writes when the explicit spec value differs. If `required` is omitted,
  the build leaves the existing column alone instead of treating omission as `None`, so it never
  silently demotes a field a maker already made Business Required.
- **`defaultValue`, `integerFormat`, and `isValidFor*` converge differently: by re-assertion, not
  by diff.** Unlike `required` above, a rebuild does not read the column's current state first —
  it simply re-sends whichever of these fields the spec sets explicitly, on every build, for both a
  brand-new column and one that already exists. This is safe because re-sending an already-correct
  value is a no-op on the wire; it does mean (unlike `required`) there is no "leave it alone if
  omitted" behavior to rely on for a value set by hand in the portal — omit the field entirely to
  leave portal-set state untouched, exactly as for `visualization` below.
- **Choice / MultiChoice** need `options[]` (string labels) **or** a `globalChoice` reference
  (see `globalChoices` below). **Customer** is a polymorphic account/contact lookup.
- **AutoNumber** can also be the **primary** column — put `autoNumberFormat` on `primaryAttribute`
  (above) instead of adding a separate column, so the generated number is the record identity.

### `visualization` — custom grid rendering (optional, PREVIEW)

Renders the column's value as a small graphic instead of plain text, in **every grid and view that
shows the column** — it is per-*column* metadata, not per-view, so you set it once here rather than
on each `views[]` entry.

| Value | Renders as | Best for |
|---|---|---|
| `RadialDial` | circular gauge filled to a percentage | a number over a known range (0–100) |
| `LineChart` | sparkline across several points | a **text** column of comma-separated numbers |
| `HeatMap` | horizontal bar coloured by value | a single number, or a choice value |
| `StarRating` | row of stars filled to the value | a whole number (0–5 by default) |
| `None` | plain text | explicitly **clearing** a renderer |

- **Type-only.** The renderers use built-in defaults (dial 0–100, stars 0–5); there are no tuning
  parameters. Column-type compatibility is **not** validated — the pairings above are guidance, and
  the platform does not enforce a clean "numeric only" rule (`LineChart` is documented for a text
  column). A nonsensical pairing deploys and simply renders nothing useful.
- **Omitting is not the same as `None`.** An omitted column is left exactly as deployed; use
  `"None"` to actively clear a renderer set by an earlier build or by a maker in the portal.
- **Rebuild-safe.** The value is re-asserted on every build, including for columns that already
  exist, and converges to a single configuration row.
- **PREVIEW — not provisioned everywhere.** Where the platform has not enabled it, the build
  **skips** the visualization step (the column and everything else still deploy) and `verify`
  reports no divergence. Live-measured: the backing `controlconfigurations` table was present on
  only 1 of 18 test environments. If a renderer does not appear, check the environment first — the
  same spec succeeds unchanged on a provisioned org.

### `isValidForCreate` / `isValidForUpdate` / `isValidForRead` — per-verb write/read permissions (optional)

Governs which API verbs Dataverse allows against the column, independent of the table-level
security a `personas[]` role grants. The common case is **write-once**: a column that should be
populated at creation (an external system id, an intake source) and never touched again —
`"isValidForUpdate": false` blocks every later write, whether from a form, a flow, or the API,
without needing a business rule or a plug-in to enforce it.

```jsonc
{ "schemaName": "new_externalref", "displayName": "External Reference", "type": "Text",
  "isValidForUpdate": false }
```

- **All three are independently optional booleans** — set only the ones you mean to constrain.
  Omitting all three leaves the column at the Dataverse default (valid for create, update, AND
  read).
- **`false` is the entire point of the feature, and is honoured exactly like `true`.** The spec
  validation and the build both use an explicit-value check (`!== undefined`), never a truthy
  check, specifically so `isValidForUpdate: false` is never silently dropped the way a naive
  `if (value)` guard would drop it.
- **Every buildable column type accepts these EXCEPT Customer.** A `Customer` column is created
  through a separate Dataverse API path (a polymorphic account/contact lookup) that carries no
  such option. Setting any of the three on a Customer column does not fail the build — it
  **warns** and the flag is silently not written, the same treatment `description` gets on a
  Customer column elsewhere in this doc.
- **Rebuild-safe, by re-assertion (see the reconcile note above).** Whichever of the three fields
  the spec sets explicitly is re-sent on every build for an existing column, not just a newly
  created one — so tightening `isValidForUpdate` to `false` in the spec and rebuilding converges an
  already-shipped table, not only a fresh one.

### entity sub-sections (optional)
```jsonc
"statusReasons": [ { "label": "In Review", "state": "Active" } ],   // custom status values
"alternateKeys": [ { "schemaName": "new_emailkey", "displayName": "Email Key", "columns": ["new_email"] } ],
"mainFormOrder": ["Work Item", "Work Item — Summary"]   // the Main Form Set order — see forms[] → "Which form a table opens with"
```

## Conditional features — read `app-spec-schema-advanced.md` when you use one

These fields are **optional and situational**: most apps use none of them, so their full field
reference lives in [`app-spec-schema-advanced.md`](./app-spec-schema-advanced.md) rather than
here. This document stays the contract for everything an app always has.

**Read the advanced reference when — and only when — your design uses one of these.** The table
is deliberately here, in the document you always read, so the menu is never hidden: choosing a
capability is the step that must not be missed, and the `/app-builder` skill body carries the same
list with "reach for it when…" guidance.

| Field | What it is |
|---|---|
| `globalChoices[]` | shared option sets |
| `webResources[]` | client-side logic |
| `commands[]` | modern command-bar buttons |
| `businessRules[]` | declarative form logic, no code |
| `businessProcessFlows[]` | guided, staged process on a table |
| `dashboards[]` | chart/list/iframe/web-resource tiles |
| `roleGrants[]` | extend a role you did NOT author |
| `businessProcessFlows[].securityRoles` | who may run a flow |

## relationships[]
```jsonc
{ "type": "OneToMany", "referenced": "new_customer", "referencing": "new_ticket",
  "lookup": { "schemaName": "new_CustomerId", "displayName": "Customer" } }
```
- `referenced` = the "one" (parent); `referencing` = the "many" (child, gets the lookup column).
- The relationship's schema name defaults to `<referenced>_<referencing>` and **must differ**
  from `lookup.schemaName` (Dataverse rejects a collision — `lintAppSpec` flags this, so
`scripts/lint-app-spec.js` catches it before you deploy; note the build itself does **not**
run the lint, so an unlinted spec hits the failure at build time instead).
- **Relationships to a standard/system table** (e.g. `systemuser`, `account` — a common
  "bridge to a real user / owner" pattern) are handled automatically: because a system table has
  no publisher prefix, the naive default name wouldn't start with your prefix and Dataverse would
  reject it. The builder **auto-prepends the publisher prefix** (e.g. `systemuser` + child
  `contoso_teammember` → `contoso_systemuser_teammember`), so you don't need to set `schemaName`.
  If you *do* supply an explicit `schemaName`, it **must** start with `<publisherPrefix>_` — the
  lint errors otherwise (an unprefixed relationship name is a build-time 400).
- Two relationships may not share a schema name. Dataverse allows one relationship per name, so
  the second would not be created. A 1:N and an N:N between the same pair, two 1:N relationships
  on one pair (different lookups), and a self-referential 1:N plus an N:N on that table all derive
  the same default name — give one of them an explicit `schemaName`.

**Many-to-many:**
```jsonc
{ "type": "ManyToMany", "entity1": "new_project", "entity2": "new_tag" }  // intersect auto-named
```
- A **plain N:N** (no extra fields on the link) — use `ManyToMany`. A form sub-grid can sit on
  *either* side (the builder resolves the N:N relationship name automatically).
- **N:N that needs attributes on the link** (e.g. a role/date per assignment) — model a
  **junction entity** with two `OneToMany` relationships into it, and put the payload columns on
  the junction. Sample rows then bind **both** parents via `$parents` (see sampleData). This is the
  recommended pattern for "Technician ↔ Work Order with a Role".

**What a download reconstructs.** `download-model-app.js` rebuilds `relationships[]` from live
metadata, keeping the lookup's deployed casing (`new_CustomerId`, not `new_customerid`) and its
label. It emits an explicit `schemaName` whenever the deployed name is not the one this
solution's prefix would generate, including a name that uses another publisher's prefix. Omitting
that name would make a rebuild into the **same** environment create under a different name and
fail on the lookup that already exists. A foreign-prefix name is a lint warning: a new environment
cannot create it under this publisher, so rename it explicitly there. Three cases it **cannot** express are reported by name and reason
rather than silently dropped:
- a **polymorphic** lookup — one column targeting several tables (Dataverse surfaces it as several
  relationships sharing one lookup attribute), where `relationships[]` declares exactly one
  `referenced` table per lookup;
- a parent that is a **custom table the app does not include**, which a rebuild target would not
  have (a bridge to a *standard* table like `systemuser`/`account` is kept — every org has one);
- an **N:N whose partner table is outside the app**.

Every relationship a download reconstructs carries **`"existing": true`** — the same ownership flag its
tables carry, for the same reason: a download cannot prove this app created it. The build still creates
a missing one; **teardown retains it**, because deleting a relationship removes its lookup column (and
that column's data) from a table teardown also retains. An author-built relationship has no flag and is
torn down with the app as before. If you set the flag on a relationship yourself, set it on its
`referenced` table too: teardown cannot delete a table that a retained relationship still points at.

A polymorphic lookup's **shadow attributes** (`<lookup>name`, `<lookup>yominame`) are excluded from
`columns[]` along with it, so a rebuild does not gain invented Text columns where the lookup used to
be. Every lookup has shadows; a polymorphic one's are physically stored rather than logical, which is
why they need naming here at all.

## views[]
```jsonc
{ "entity": "new_ticket", "name": "Active Tickets", "columns": ["new_subject","new_priority"],
  "sort": [{ "attr": "new_subject", "dir": "asc" }], "activeOnly": true,
  "description": "Unresolved tickets, most urgent first — the queue agents work from.",
  // optional rich filters (beyond the default active-records condition):
  "filters": [
    { "attr": "ownerid", "op": "eq-userid" },                       // "my" records — no value
    { "attr": "new_priority", "op": "not-in", "values": ["Low"] },  // multi-value (Choice labels resolve to ints)
    { "attr": "new_duedate", "op": "this-week" }                    // relative-date — no value
  ] }
```
- **`columns[]` is an array of column NAMES (strings)**, and so are `sort[].attr` and
  `filters[].attr`. Not `[{ "name": "..." }]` — that is the shape `forms[]` uses for its fields, and
  it used to be accepted here and stringified into the view's FetchXML as `[object object]`. The
  build then failed at the platform, mid-run, and left behind a view row that could not be read or
  deleted, so every later build failed the same way. It is now rejected up
  front, naming the view and the offending entry.
- `activeOnly` (default `true`) adds `statecode eq 0`. `filters[]` add conditions: `op` is any
  FetchXML operator — `eq`/`ne`/`lt`/`le`/`gt`/`ge`/`like`, no-value ops (`eq-userid`, `null`,
  `not-null`, `this-week`/`this-month`/`today`/…), and multi-value `in`/`not-in` (use `values[]`).
  Choice **labels** in `value`/`values` resolve to option ints. This is what "My Open Orders"
  (`ownerid eq-userid` + `new_status not-in [Completed, Cancelled]`) and "Completed This Week"
  (`new_status eq Completed` + `modifiedon this-week`) need — no post-build FetchXML patching.
- **Default-view enrichment (automatic):** the auto-generated **"Active &lt;Entity&gt;"** and
  **"Inactive &lt;Entity&gt;"** system views ship with only the primary column. The build enriches
  them with the primary column plus up to 6 meaningful declared columns (in declared order, skipping
  wide/opaque types like MultilineText). This runs by default for every table the build **owns** that
  has extra columns; opt a table out with **`"enrichDefaultViews": false`** on its `entities[]` entry.
  A table marked **`"existing": true`** is skipped by default — enrichment *replaces* a view's column
  set, and `existing` means the build cannot prove it owns the table, so rewriting another app's
  default views is not a safe default. Set **`"enrichDefaultViews": true`** to override that when you
  know the reused table is yours. Author-declared `views[]` are separate and always win.
- **A view is found by its name on its table, so a name the table already has is that view.** A view
  named like the platform's own "Active &lt;Plural&gt;", or like any view already on the table, is not
  created a second time: the build adds the spec's columns to the existing view (removing none) and
  writes its `description`, but does not reapply its `filters` or `sort` — it warns instead. Give the
  view its own name to get a separate one.

## charts[]
```jsonc
{ "entity": "new_ticket", "name": "Tickets by Priority", "chartType": "Pie",
  "groupBy": "new_priority", "measure": "count",
  "description": "Where the open workload is concentrated." }
```
- `chartType`: `Column · Bar · Pie · Line`. **`groupBy` MUST be a Choice column** on `entity`.

## forms[]
```jsonc
// auto layout (default): primary + all scalar columns + 1:N parent lookups; opt-in child grids
{ "entity": "new_customer", "type": "main", "name": "Customer", "layout": "auto",
  "description": "The main customer record — profile, contacts and open tickets.",
  "notes": true,                                   // optional — add a Notes section
  "autoSubgrids": true,                            // optional — a sub-grid for every child relationship
  "deactivateOtherMainForms": true,                // optional — see below (own custom tables only)
  "subgrids": [ { "childEntity": "new_ticket", "view": "Active Tickets", "label": "Tickets" } ] }

// explicit layout: author tabs -> sections -> columns(1-4) -> fields
{ "entity": "new_project", "type": "main", "name": "Project",
  "tabs": [ { "label": "General", "sections": [
    { "label": "Details", "columns": 2, "fields": ["new_name","new_budget","new_status"] } ] } ] }

// explicit layout, richer: multi-column tabs, per-cell spans, visibility
{ "entity": "new_project", "type": "main", "name": "Project",
  "tabs": [
    { "name": "tab_delivery", "label": "Delivery", "expanded": true, "columns": [
      { "width": "65%", "sections": [
        { "name": "sec_scope", "label": "Scope", "columns": 2, "fields": [
          { "name": "new_summary", "colspan": 2 },     // span the whole 2-column section
          "new_startdate", "new_targetdate" ] } ] },
      { "width": "35%", "sections": [
        { "name": "sec_status", "label": "Status", "columns": 1, "fields": ["new_status","new_owner"] } ] } ] },
    { "name": "tab_audit", "label": "Audit", "expanded": false,
      "sections": [ { "name": "sec_audit", "label": "Audit", "columns": 2, "fields": ["createdon","modifiedon"] } ] } ] }

// per-field control options: read-only, hidden, and targeted positioning
{ "entity": "new_workitem", "name": "Work Item", "layout": "auto",
  "fieldOptions": {
    "new_workitemnumber": { "readOnly": true },          // visible but locked (e.g. an AutoNumber)
    "new_storypoints":    { "hidden": true },            // on the form for scripts, not shown
    "new_daysremaining":  { "after": "new_duedate" }     // move it directly after Due Date
  } }

// offer this form only to particular personas (a form with no assignment is offered to EVERY role)
{ "entity": "new_ticket", "name": "Dispatcher Ticket", "layout": "auto",
  "securityRoles": { "personas": ["Dispatcher"], "fallbackForm": false, "order": 1 } }

// the same options inline, when an explicit layout already lists the fields
{ "entity": "new_workitem", "name": "Work Item", "layout": "explicit", "prune": false,
  "tabs": [ { "label": "General", "sections": [ { "columns": 1, "fields": [
    "new_name",
    { "name": "new_workitemnumber", "readOnly": true },
    { "name": "new_storypoints", "hidden": true } ] } ] } ] }

// form JS: wire onload/onsave/onchange handlers to a web-resource library
{ "entity": "new_ticket", "type": "main", "name": "Ticket", "layout": "auto",
  "events": [
    { "event": "onload",   "library": "new_ticket.js", "function": "Ticket.onLoad" },
    { "event": "onchange", "attribute": "new_priority", "library": "new_ticket.js", "function": "Ticket.onPriority" }
  ] }

// quick-create form: a simplified create form (same entity). formType defaults to "Main".
{ "entity": "new_ticket", "name": "Ticket Quick Create", "formType": "QuickCreate", "layout": "auto" }

// quick-view placement: embed a related record's QuickView form on a host form via a lookup column
{ "entity": "new_ticket", "name": "Ticket", "formType": "Main", "layout": "auto",
  "quickViews": [ { "lookup": "new_customerid", "targetEntity": "new_customer",
                    "form": "Customer Card", "label": "Customer" } ] }
{ "entity": "new_customer", "name": "Customer Card", "formType": "QuickView", "layout": "auto" }
```
- **`formType`** is `Main` (default), `QuickCreate`, or `QuickView`. A `QuickCreate` form is a
  simplified create form on the same entity (no sub-grids, no Notes; events allowed). A `QuickView`
  form is read-only (no sub-grids, no events). Sub-grids/Notes are Main-form only.
- **`quickViews[]`** (on a host form) embed a `QuickView` form via a lookup: `lookup` is the lookup
  column on the host, `targetEntity` the related entity, `form` the **name** of a `QuickView` form
  declared in `forms[]` (lint-enforced). Optional `label`, `section`, `displayAsCard`. The control
  renders from plain formxml, so it persists on a plain push.
- A sub-grid needs a matching `OneToMany` **or** `ManyToMany` between the form's entity and
  `childEntity` (lint-enforced); the builder resolves the relationship name either way. Each sub-grid
  renders in its **own 1-column, full-width section**; its title defaults to the child entity's
  `pluralName` (then `displayName`), with `subgrids[].label` overriding.
- **`deactivateOtherMainForms`** (optional, default `false`, Main forms only): after promoting this
  form as the entity default, deactivate every OTHER active main form on the entity — i.e. hide the
  blank stock "Information" form so only this form ships active. **Destructive**, so it is OFF by
  default and only ever applies to a table THIS build owns (a custom, publisher-prefixed, non-`existing`
  table); it never touches a reused/system table. Teardown reactivates the stock form before deleting
  ours, so a torn-down table is left clean.
- **`isDefault`** *(optional, boolean, Main forms only)* — which Main form the table **opens with**:
  the build marks it `systemform.isdefault` **and** puts it first in the table's Main Form Set order —
  the flag alone does not decide what opens (see *Which form a table opens with* below). Exactly one
  Main form per table may set it. Set explicitly, it applies on **any** table, `existing: true`
  included; without it, a table this spec creates opens with its first Main form in spec order. It is
  applied once, after every form exists, rather than each form racing to promote itself. A promotion
  the environment refuses is reported as a warning and fails `--verify`, which proves the deployed
  `systemform.isdefault` independently — so a build can no longer record a default it did not
  actually set. Moving the default to another form **clears** it on the table's other spec-declared
  Main forms (measured: setting the flag on one form does not clear it on another, so both stayed
  default), and `--verify` fails while any of them still holds it. Forms the spec does not declare,
  and their activation state, are never touched.
- **Form resolution is by `(entity, name, formType)`** — a Dataverse form name is unique only per
  `(entity, type)`, so a table's auto-created **Main**, **Quick View**, and **Card** forms can all be
  named "Information" without colliding. A `formType:"Main"` edit reconciles **only** the Main form;
  same-named Quick View / Card siblings never block it.
- **`formId`** *(optional, GUID)* — pin an **exact existing** form to reconcile. Needed only for the rare
  residual collision where a table has **two forms of the same `(entity, type, name)`** that type-scoped
  resolution can't disambiguate — the build then errors and tells you to set `formId`. The id is verified
  to belong to the form's table before anything is reconciled. Omit it for normal forms.
- **`events[]`** wire client-side JS: `event` is `onload`/`onsave`/`onchange` (`onchange` needs an
  `attribute`), `library` references a declared `webResources[]` name (lint-enforced), `function` is
  the JS function. Optional `enabled` (default true), `passExecutionContext` (default true),
  `parameters` (a comma-separated argument list). All three are **honoured** — an authored
  `"enabled": false` really does deploy a disabled handler. `enabled` and `passExecutionContext` must
  be booleans and `parameters` a string; a string `"false"` is rejected rather than coerced, because it
  is truthy in JS and would silently enable a handler you meant to disable.
  The build fetches the pushed form, injects the handlers, then publishes it.

### Which form a table opens with — `isDefault` and `entities[].mainFormOrder`

A table's Main forms are served in its **Main Form Set order**, and a user opens the **first one
they may open** — unless they switched forms earlier: the platform remembers the last Main form each
user opened for a table and opens that one for them while they may still open it. The order is
stored on each form (its formxml `<DisplayConditions Order="n">`), and `systemform.isdefault` does
not change it: measured, moving the flag reordered nothing, and a table's three new Main forms — all
at the same order, as every new form is — were served with the `isdefault` form *last*.

- **`forms[].isDefault: true`** — this form opens first: it becomes the table's default **and** comes
  first in the order. Applied on any table.
- **`entities[].mainFormOrder`** — the order itself, first to last, as names of the table's Main forms
  in `forms[]`:
  ```jsonc
  { "schemaName": "contoso_workitem", "existing": true,
    "mainFormOrder": ["Work Item", "Work Item — Summary", "My Work — Work Item"] }
  ```
  The first form is the one the table opens with (an `isDefault` form must be first). A partial list
  puts the listed forms first; the table's other spec forms follow in their current order. Each name
  is spelled as in `forms[]`, and must not match another Main form of the table ignoring case and
  accents — Dataverse, and so the build, compares form names that way, and could not tell them apart.
- **Neither set:** on a table this spec creates, the first Main form in spec order comes first and
  the others follow in spec order. On any other table the order is left as it is, and a Main form the
  build *creates* there is put after the table's other Main forms — adding an alternate form does not
  change what the table opens with. If none of those forms has an order yet, the new form comes first
  and the build warns; it also warns when the new form comes before a form that has no order (a form
  without one is served after every form that has one). The new form's place is part of creating it,
  so an interrupted build cannot leave it first.
- **Only forms in `forms[]` are written.** A Main form the spec does not declare keeps its order; if
  it would still come first, the build warns and `--verify` fails, naming it. Move it down in Maker
  (**Form settings → Form order**), or declare it and list it in `mainFormOrder`.
- **`securityRoles.order`** writes the same attribute. A table where a Main form sets it is ordered by
  hand: the build leaves its order alone, and the spec cannot also give it `mainFormOrder`.
- **Also deciding what a user sees:** their security roles — a form restricted by `securityRoles` is
  served only to those roles, and everyone else opens the next form they may open — and their
  remembered form, which is per user **and table**, not configuration (they change it by switching
  forms). Without `app.mainForms`, an app offers **every** active Main form of its navigation tables,
  including undeclared forms such as stock "Information". Use `app.mainForms` to restrict additions
  for this app; creating an app is exact, but existing members are never removed automatically.
- **`--verify`** checks the stored order (`form-order`) and the order the platform serves the user
  running verify (`form-order-served`, read with the public `RetrieveFilteredForms` function). When
  that user may not open the first form, the check is reported as not applicable, not as a pass.

### Explicit layout — tabs, form-columns, sections

| Level | Key | Meaning |
|---|---|---|
| tab | `name` | Stable identity. Emitted as `tab_<i>` when omitted — see *editing an existing form* below. |
| tab | `label` | Tab title. |
| tab | `expanded` | `false` collapses the tab on open (default `true`). |
| tab | `visible` | `false` hides the tab (default `true`). |
| tab | `sections[]` | Shorthand for **one full-width form-column**. |
| tab | `columns[]` | The multi-column form: each entry is `{ "width": "60%", "sections": [...] }`. |
| form-column | `width` | Percentage string (`"60%"`). Omitted widths split evenly (3 columns → 34/33/33). |
| section | `name` | Stable identity, `section_<tab>_<i>` when omitted. |
| section | `label`, `showLabel`, `visible` | Section heading, whether it renders, whether the section shows. |
| section | `columns` | `1`–`4` grid columns. |
| section | `fields[]` | Column logical names, or `{ "name": …, … }` entries. |
| field entry | `colspan`, `rowspan` | Whole numbers ≥ 1. A cell wider than its section is clamped to it — the clamp reaches the deployed cell, not just the row packing. A field **moved** into another section without a declared `colspan` keeps its deployed width if it fits there, and is narrowed to that section's width (and reported) if not — declare `colspan` to choose. `rowspan` is valid only on the **last** field of a section (see below). |

A tab declares **either** `sections` **or** `columns`, never both. `columns` on a **tab** is the list
of form-columns; `columns` on a **section** is its 1–4 grid width — a number on a tab is rejected
rather than silently discarded. Any other key is **rejected** — including `showLabel`/`labelPosition`
on a tab and `labelPosition`/`locked` on a section, which FormXml has no place for, so accepting them
would promise a layout Dataverse never renders. The SDK refuses these too, but this plugin rejects
them at **author time** — before any workspace or network call — and names the real mechanism rather
than reporting a JSON pointer into the compiled form.

**`minimumPluginVersion`** (top level, optional) declares the oldest plugin that can build this spec —
`"minimumPluginVersion": "2.9.0"`. A plugin older than that refuses the spec instead of mis-compiling
it, naming both versions. The value must be a plain dotted version (`2`, `2.9`, `2.9.0`) with an
optional `-pre` or `+build` suffix, which compares on the release core. Anything else — `2..9`, a
trailing typo, stray whitespace — is rejected as malformed rather than quietly reinterpreted as a
different floor.

⚠ It protects **forward only**. Measured against the shipped 2.8.0 validator, an unknown top-level
key, `schemaVersion: 3` and even `schemaVersion: 99` are all accepted — it validates none of them —
so no marker can make an already-released consumer reject a spec. What stops an older plugin
damaging a richer form today is the destructive preflight: reducing a multi-column form to an empty
field set surfaces as a plan to remove every non-primary field, which needs authorization.
**Names are identity, and a field is placed once per form.** Two tabs — or two sections — on one
form may not share a `name`, and a column may not be placed twice, whether in two different sections
or twice in the same one (matching is case-insensitive, and applies to both the string and the
`{ "name": … }` entry shape). All three are rejected at author time.

The reason is that create and rebuild would otherwise disagree. The compiler emits **one cell per
entry**, so a fresh build deploys a duplicated field twice, while every reconcile path resolves a
field to its **first** placement — the second cell would appear on the initial create and then vanish
on the next build of the same spec. Duplicate container names fail the same way: `name` is what the
build matches a deployed tab or section by, so two declarations sharing one would target the same
live container. A second form on the same table may of course place the same column — identity is
per form.

**`rowspan` must be the last field in its section.** A cell that spans down reserves its column in
the rows beneath it, and the cells of the following row fill the section left to right — so a field
declared after a spanning one would land in the reserved slot. Every stock Dataverse form that uses
`rowspan` puts it on the last cell of its section, so that is the shape this plugin emits.

This is a **compiler limitation, not a platform one.** Positioning a field beside a vertical span
requires emitting an empty *spacer* cell to occupy the reserved slot, which the SDK serializes
correctly; the compiler does not emit one yet. The restriction can be lifted once it does.

A **deployed** `rowspan` — one a maker added by hand, which the authored restriction above cannot
prevent — can make the rows of a section positionally meaningful in the same way: once any cell
**follows** a row-spanning cell, re-flowing the section by reading order could move that cell into
the reserved slot. In such a section the build therefore never flattens and re-flows the whole
section. Every fit below counts a row's own cells **plus** the columns a row-spanning cell above
still reserves in it — the same occupancy rule `--verify` applies, so placement does not introduce
row overflow. Narrowing the grid is applied
only when every row already fits the new width that way; otherwise the section **keeps its current
grid** and the refusal is reported. A span change that would overflow the rows its cell occupies is
skipped (and reported), rather than applied without the re-flow. Before optional positioning, a new
field is packed into the last row if it fits there, otherwise into the first new row with room.
Likewise a `rowspan` is never **raised** on a deployed cell that other cells follow, even when its
row still fits: the build keeps a field where
the form already has it, so the field you list last is not necessarily last on the form. A section
whose row spans are all **trailing** — stock Main forms put `rowspan` on the last cell — re-flows
normally, because nothing comes after the span to land in its reservation. Every refusal is also
recorded in the build result (`skipped.layout`). `--verify` reports declared grid/span/state
mismatches for an explicit layout, but does not check field order or `after` adjacency.

**Editing an existing form.** An explicit layout reconciles containers and field-to-section
placement, not the order of existing fields. It is not flattened into the form's first section:
missing tabs, form-columns and sections are **created** where the layout places them, a tab's
`label`/`expanded`/`visible`, a form-column's `width` and a section's
`columns`/`label`/`showLabel`/`visible` are **updated in place**, a named section that sits in another
tab or form-column is **moved** to where the layout places it, the tabs — and the sections of each
form-column — are **put in the layout's order**, and a field sitting in the wrong section is **moved**
(never duplicated — the cell keeps its id and any control state a maker edited). Containers are
matched by `name`, then `label`, then position, so a form built by an earlier `auto` layout — or by
hand in Maker — reuses its containers instead of gaining a duplicate tab. Nothing is renamed,
because form scripts and business rules can reference a section by name. Tab/section moves are
reported; only the layout's own
containers are ordered — a tab or section it does not mention (a maker's own, the notes timeline)
keeps its place among them.

Three rules keep that matching from claiming the wrong container. An index an earlier tab or section
already matched is **not reused**, because an unlabeled container compiles to a default label
(`General` for a tab, `Details` for a section) and several of them would otherwise all match the
first one. A tab or section whose name another one in the layout declares is matched only **by that
name**, so it can be moved to its own place instead of being taken over by a neighbour with the same
label or position. And sections the **engine** owns — a sub-grid host, the notes/timeline section — are
matched only by `name`: a label or a position is not evidence about what a container *is*, and
matching one positionally would relabel a sub-grid and place fields in the row holding its grid.
Their name is the engine's own, so a section **you** declare never takes one even by name: a section
of yours called `section_notes` gets a section of its own rather than the timeline host of that name.
A host is known by that name *and* by what it holds: only controls without a field, or the control the
host exists for — the timeline in `section_notes`, a sub-grid in `section_grid_…` — even after a maker
added a field beside it. A section of yours that a maker filled with a web resource or sub-grid keeps
its own name, and is still found by it. (One you name `section_notes` or `section_grid_…` is
indistinguishable from a host when it has no fields, or when a maker puts that host's control into it:
the build then gives your fields a section of their own beside it. Give it another name. And a host
that a maker both renamed and gave a field carries neither mark, so it is matched like any other
section — keep the engine's section names when you customise its sections in Maker.)

⚠ **Moving a section.** A section with an explicit `name` is found wherever it is on the deployed
form and moved to the tab and form-column the layout places it in — the same section, so its fields,
id and anything set on it in Maker travel with it, and the build reports the move. It lands after
every section the layout places before it in that column (or first, when there is none). A section
whose `name` is **generated** is a different identity once it moves — generated names encode
position (`section_<tab>_<column>_<index>`) — so it is created in the new place, its fields are moved
into it, and the original, left empty by this run, is removed (unless `"prune": false`). Give a
section an explicit `name` when you intend to move it. A section the layout stops mentioning is
removed only when this run empties it — its fields pruned, or moved into another section — and
`prune` is on; anything else it still holds keeps it, and a section it leaves alone is yours to
remove in Maker.

⚠ **Field order.** On a new form, an explicit section's `fields` list sets its initial reading order.
On an existing form, a field already in its requested section **stays where it is**: changing the
list does not reorder existing fields. A field in another section is still moved to its declared
section, without reordering the fields already there.

Only a field **created by this build** takes its listed position: after its listed predecessor, or
before its listed successor when it starts the list. A leading run of new fields is placed before
the next existing listed field, then chained in list order. Placement uses the occupancy-safe
mechanism below. If reservations make insertion unsafe, the new field keeps its safely appended
position and a warning is recorded; later builds treat it as existing rather than retrying list
reordering. This does **not** promise the whole list's order when existing neighbours are out of order.

Missing fields and relative positions are planned together on a copy, then persisted in **one
artifact edit**. A failed write cannot leave an appended-but-unpositioned new field, an overflowing
intermediate row, or duplicated trailing cells. A retry uses either the prior layout or the complete
planned layout, preserving existing cell/control identities.

`--verify` checks tab/section order, row occupancy and **cell/control ID uniqueness across each
whole form**, including headers, footers and unbound controls. Auto forms also require readable
FormXML for the identity check. Repeated bindings of one field with distinct IDs are allowed.
It does **not** check field order or `after` adjacency.
To reposition an existing field, use `fieldOptions[x].after` outside the explicit field list, below.

⚠ Declaring explicit `tabs` also switches **pruning** on: a field the deployed form carries and the
layout does not list is removed (never the primary field). Set `"prune": false` to restyle or
reorder a subset without re-declaring every other field. A row that a removed or moved field leaves
holding nothing goes with it, so no blank line is left behind. The exceptions are a row that a
row-spanning cell above still reserves, which stays because the span occupies it, and a row that was
already empty, which is left as it is.

### Per-field control options — `readOnly`, `hidden`, `after`

A form field can carry these per-control options. Declare them **form-level** in `fieldOptions`
(keyed by column logical name) — the only route under an `auto` layout, which has no field list —
or **inline** on an explicit layout's `fields[]` entry as `{ "name": …, "readOnly": …, "hidden": … }`.
Where both apply to one field the inline entry wins; a plain string entry keeps working unchanged.

- **`readOnly: true`** locks the control (`disabled="true"`), leaving it visible. Use it for a value
  the platform generates but does **not** make immutable — an AutoNumber column is writable through
  the API, so "read-only" for it is a form-level statement, not a metadata one.
- **`hidden: true`** places the field as a hidden control (`visible="false"`) — present for form
  scripts and business rules, not shown to the user.
- **`after: "<logical>"`** moves the field so it immediately follows the named anchor in
  **section-flat, row-major cell order**, including across a row boundary. This is the
  **non-destructive** way to reposition one control: it works on an already-deployed form and does
  not require re-declaring the rest of the form. Valid, already adjacent fields are not moved again.
  An overfull row stored by an earlier build can be repacked once without changing that flat order.
  An anchor that is not on the form is ignored.
  New listed fields are positioned first; anchors then run in **dependency order**, so an anchor is
  positioned before its dependents regardless of `fieldOptions` property order. Every remaining
  adjacency is checked once afterward, and an unsatisfied request is reported rather than silently
  accepted. Unlisted anchored controls may therefore sit between listed fields; the `after` chain
  takes precedence over a new field's initial adjacency to its listed predecessor.
  Placement counts colspans and columns reserved by rowspans above. A full anchor row may have its
  trailing cells split into new rows immediately below it: `[count|name] [code]` becomes
  `[count|code] [name]` in a two-column section. If the inserted field cannot fit beside the anchor,
  it takes the next new row instead. Cells keep their identities and control state. A moved cell
  wider than its destination section is narrowed to that grid and the narrowing is reported.
  If a split would disturb a row-spanning reservation, or the resulting rows would overflow,
  **the move is skipped**, with a warning naming the field, anchor and reason in `skipped.layout`;
  these constraint-based skips do not fail the build. SDK/storage errors still halt the build, but
  the placement edit is atomic and can be retried safely. `--verify` checks occupancy and unique
  identities, not adjacency.
  Valid only in form-level `fieldOptions`, and only for a field an explicit layout does **not** list.
  Inline `after`, or a form-level anchor on a listed field, is rejected to avoid combining two
  placement instructions; that restriction does not imply existing-field list reordering.
  Use `"prune": false` to keep an unlisted field on an explicit form.
  Two anchor shapes are **rejected**, because neither has a satisfiable answer: only **one** field may
  sit immediately after a given anchor (to place several in sequence, *chain* them — anchor the second
  after the first), and anchors may not form a **cycle**.
- **`colspan: <n>`** widens the control to `n` of its section's columns (a whole number ≥ 1, clamped
  to the section's width) — the same key an inline entry takes. An `auto` layout generates a
  one-column section (two columns once it holds more than six fields), so there a wider span only
  takes effect up to that width — or on a deployed form whose section is wider (a stock Main form
  the build reconciles). **`rowspan`** above 1 is accepted **inline only**, on the last field of a
  section: a form-level option cannot see where its field lands, so it is rejected there.

**Only the enabled state is ever written.** The build emits `readOnly`/`hidden` when you ask for
them and writes *nothing* when you do not, so a rebuild never clears a lock or a hide someone applied
in the form designer. The corollary is that `readOnly: false` / `hidden: false` cannot turn a flag
back off — they are rejected at author time rather than accepted and ignored. To un-set one, clear it
in the designer, or drop the field and let the next build re-add it.

**Under an `auto` layout the flags apply to the fields the layout places** — the primary column, the
table's declared columns and its parent lookups. A `readOnly`/`hidden` on any other field (a stock
column of an existing table, say) is never written, and lint warns about it; list that field in an
explicit layout instead (`prune: false` keeps the rest of the form). `--verify` proves every flag the
build writes, and fails a flagged field the deployed form no longer carries.

- **`prune`** *(optional, default `true`, explicit layouts only)* — an explicit `tabs` layout is
  normally the complete desired state, so a rebuild removes any deployed field it does not list. Set
  `prune: false` to keep those fields, which lets you restyle or reorder a **subset** of a form
  without re-declaring every other field just to preserve it. It has no effect on an `auto` layout
  (already additive) and is warned about there.

### `securityRoles` — who the form is offered to

A form with **no** `securityRoles` block is offered to **every** security role. Declaring one is
therefore a **restriction**, not a grant, and that direction is what makes each mistake here
access-relevant: an empty list or a mistyped persona would hide the form from everyone, not simply
fail to add anyone. Every malformed shape is a hard error for that reason.

```jsonc
{ "securityRoles": { "personas": ["Dispatcher", "Supervisor"] } }   // only these roles see it
{ "securityRoles": { "everyone": true } }                            // explicitly every role
{ "securityRoles": { "personas": ["Dispatcher"], "fallbackForm": true, "order": 2 } }
```

- **`personas[]`** — names from this spec's `personas[]`, **not** role GUIDs. The build resolves each
  to the role it created. A name that is not declared is rejected at the spec gate, and would halt the
  build if it somehow reached it.
- **`everyone`** — mutually exclusive with `personas`. That is the *platform's* model, not a rule of
  this spec: `<Everyone />` **replaces** the role list rather than adding to it. `everyone: false` is
  rejected, because it looks like "restrict to nobody" and means nothing.
- **Removing a restriction needs `everyone: true`, not deleting the block.** A build only visits
  forms that *declare* `securityRoles`, so deleting the block leaves the deployed
  `<DisplayConditions>` exactly as it was — the form stays hidden from everyone outside the old list.
  This direction fails closed (access never silently widens), but it does mean "undo" is an explicit
  `{ "everyone": true }`.
- **`fallbackForm`** *(optional)* — show this form to users whose roles have no form of their own.
- **`order`** *(optional, non-negative integer)* — this form's place in the table's Main Form Set
  (the same attribute `isDefault` and `entities[].mainFormOrder` set; see *Which form a table opens
  with*). A table where a form sets it is ordered by hand, and cannot also have `mainFormOrder`.
- Both `fallbackForm` and `order` are **preserved** when omitted, so a later build that sets only
  `personas` does not reset them.

**Two things worth knowing.** The roles are stored **inside `formxml`**, as a `<DisplayConditions>`
element — `systemform` has no role relationship at all (it reports
`CanBeInManyToMany: { Value: false, CanBeChanged: false }`), which is why no association-style API
ever worked and why this needs a dedicated call. And the write lands on the **unpublished** layer:
live-measured, the published form still reported `<Everyone />` until the customization was
published, so the restriction takes effect only after a publish. The build publishes the entity when
publishing is enabled.

Assignment happens in the **security** phase, not the forms phase, because the roles do not exist
until then. If you build with `--phases` excluding `forms`, the assignment is skipped with a message
rather than applied to a form this run did not build.

### Column types that cannot go on a form

**Big Integer (`BigInt`) has no Unified Interface form control.** A BigInt placed on a form renders
the text *"Error loading control"* on every record. The `auto` layout therefore **skips BigInt
columns** — the column is still created and still readable/writable through the API, it just is not
placed. An explicit layout still honours a BigInt you list by name (you may be pairing it with a
custom control), but the spec validator emits a warning.

## pages[] (optional — generative pages / genux)  [schemaVersion 2]
```jsonc
[ { "key": "overview", "name": "Overview", "purpose": "KPI overview + recent orders",
    "dataSources": ["new_order", "new_customer"],
    "source": { "kind": "intent" },                // design-time; generate-pages fills the .tsx
    "navigatesTo": [{ "targetKey": "detail", "data": { "orderId": "string" } }],
    "pageInput": { "data": { "orderId": "string" } },
    "directEntry": { "behavior": "selector" } } ]
// after generate-pages: "source": { "kind": "tsx", "codeFile": "overview.tsx" }
```
- **Genpage-first policy** is unchanged. A page's implementation state is an explicit discriminated
  `source`: `{ "kind": "intent" }` (declared but not yet coded) or `{ "kind": "tsx", "codeFile": "…" }`
  (the `.tsx` the build uploads). A **legacy** top-level `"codeFile"` (no `schemaVersion`) is still
  accepted and treated as an implemented tsx page.
- **`pageInput` + `directEntry` — the input contract.** These two rules used to conflict with no way
  for an author to satisfy both, so this spells out the resolution:
  - Every page **must** be a sitemap subarea (see the membership invariant below). The sitemap is the
    download's only membership oracle, so a page reached *only* by `navigatesTo` is invisible to
    download and gets re-created as a **duplicate** on the next build.
  - A detail page therefore lives in the app navigation, which means a user can open it **with no
    input at all** — the `orderId` its `pageInput` declares simply is not there.
  - So a page that declares `pageInput` must also declare **`directEntry`**, which is what that state
    renders: `{ "behavior": "selector" }` (show a picker, then the record) or
    `{ "behavior": "emptyState" }` (explain, and render nothing broken). An optional `note` is passed
    to the generator verbatim. Without this the generated page read `undefined` context on a path a
    user reaches by clicking the nav entry.
  - Every key in `pageInput.data` must be **produced by an incoming `navigatesTo[].data`** edge. An
    input nothing supplies is either a typo or a page that can only ever be entered directly; both
    generate a page reading a key no caller ever sets.

  The alternative — allowing navigation-only pages — was rejected: it would need the sitemap to stop
  being the membership oracle, and the duplicate-page bug it prevents is worse than the extra nav
  entry. `directEntry` also survives download (it is carried in the page manifest), because a spec
  that lost it would fail its own validation on the next build.
- Validation is **profile-scoped**: `design`/`plan` accept intent pages; a `deploy` build (the default)
  requires every page implemented.
- **`key`** (schemaVersion 2, required, unique) is the page's **single stable identity** — used by
  `navigatesTo[].targetKey`, the `PAGEREF_<key>` navigation placeholder, and the `page` sitemap
  subarea. Renaming a page never changes its key. It must match `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`,
  be unique across all pages in the spec, and (for an implemented page) its `codeFile` path must be
  unique and workspace-confined: a relative path to a regular file inside the app folder.
  Rooted, drive-relative and alternate-stream paths, parent escapes, symlinks and junctions are refused.
- **`navigatesTo`**: `[{ "targetKey": "<page key>", "data": { … } }]` — declared page-to-page
  navigation (custom ids travel in `data`, read as `pageInput?.data?.<key>` on the target).
- **Page-name uniqueness** is enforced **only on pages this run creates**. A page carrying a `pageId`
  is a PRE-EXISTING deployed page (edit-snapshot); a page without one is NEW. Two NEW pages (or a NEW
  page colliding with any other) that share a name (case-insensitive) are **rejected**. But a
  case-insensitive duplicate **purely among pre-existing pages** (both carry a `pageId`) is a
  **warning, not an error** — a downloaded app can legitimately contain two pages the run didn't
  create (authored by different people/tools), and an unrelated edit (e.g. a form change) must still
  build. The pages phase matches by `pageId`/`key`, never by name, so distinct-id same-name pages
  build correctly; rename one in Maker to disambiguate the navigation.
- **A straight double quote (`"`) in a page `name`** draws a lint warning: pac stores each one as `\"`
  on the page's own record, and the backslashes stay there. The navigation shows the page subarea's
  `title`, which the build writes as given. A download writes the name without pac's backslashes, so a
  rebuild does not add more. Use typographic quotes (“ ”) or an apostrophe — pac stores those, and
  every other character, exactly.
- **`pageInput`**: `{ "data": { … } }` — the input this page expects when navigated to.
- **Durable page manifest.** The build writes a `<app-unique-name>_pagemanifest` web resource
  carrying `{ schemaVersion, pages: [{ key, name, pageId, purpose, dataSources, navigatesTo, pageInput }], design }`.
  This manifest is the source of truth for a download round-trip: download fetches it, enumerates
  deployed pages fail-closed, and uses `reconcilePageIds` to reconstruct keys and reverse-normalize
  navigation placeholders back to `"PAGEREF_<key>"` in each page's source. Legacy apps with no
  manifest get fresh keys assigned on first download.
- **Three-authority page identity.** Generative-page management consults three authorities, each
  for a distinct question — all matching is **by id**, never by display name:
  1. **IDENTITY** — the `<appUnique>_pagemanifest` (`key → pageId` map). For an *edit-snapshot* spec
     (downloaded from a live app), the spec's own `pages[].pageId` is the highest authority and
     outranks the manifest.
  2. **EXISTENCE** — env-wide `pac model genpage list` (no `--app-id`). This set alone decides
     whether an id is still live. An unplaced id needs a local creation receipt for this app/key/id
     and a decoded stored name exactly equal to the spec page name; otherwise `unproven-manifest-id` halts,
     never requests a replacement CREATE. The build takes this app's PUBLISHED navigation as proof: a page
     that is only in its saved but unpublished navigation halts with advice to publish the app first, so
     other apps' navigation is checked before the page is updated. If it is this app's page, add it to the
     app's navigation in the maker, publish the app and re-run; otherwise remove the stale id from the manifest/spec (or delete the
     page) and re-run. A read failure HALTs (`pages-existence-failed`).
     An uncertain CLI CREATE stops and reports each new candidate's id, stored name and `createdon`.
     No candidate is automatically adopted, even with a matching name/date. If the candidate is yours,
     re-run the upload explicitly with `--page-id`; otherwise leave it and re-run the create.
  3. **MEMBERSHIP** — the app's sitemap `GenPageId` set (read via `fetchSitemap` —
     fail-closed, discriminated). This set alone decides placement, download enumeration, and verify
     coverage. A read failure HALTs (`pages-sitemap-read-failed`).
- **Teardown page scope.** The manifest supplies candidates, not permission to delete. A candidate
  is deleted only when it is in this app's sitemap (published, or saved but unpublished — a page another app's
  saved navigation still references is refused by the platform and kept) or a local app/key/id creation receipt proves it,
  with its stored name corroborating the receipt. Other candidates are kept with a manual-removal hint.
  The build writes `page-ownership.created.<hash>.json` in its workspace after an acknowledged create,
  before manifest persistence/placement. Version-2 records include an opaque SHA-256 fingerprint of
  the normalized target HTTPS origin (lower-case host, no path or trailing slash), not its URL.
  Lookup and consumption require that same fingerprint; another target's records stay untouched.
  There is only this environment-bound format. An unknown version, malformed or unreadable file
  halts with its path: inspect it; delete it only if no page it names still exists.
  These records contain no environment routing; copied
  baselines, downloaded ids, remote manifests and diagnostic journals cannot substitute for them.
  Without a workspace, off-sitemap ids are kept or halted. Dry-run lists
  every candidate without writes; absent rows are labeled "not found" with their manifest name only.
  Before app removal, the verified set is saved as local `page-ownership.teardown.<hash>.json` records.
  An unreadable proof or failed record write leaves the app intact. A retry uses those records even
  when `pages[]` is empty and the app has already gone. Proven pages still undeleted keep their records,
  manifest and solution and prevent a successful result. Only completed deletion or confirmed absence
  consumes the records. Form-only references are not scanned; platform sitemap dependencies remain an
  additional safeguard, not proof that no form embeds the page.
- **Workspace clearing preserves ownership.** `--clear-workspace` refuses while any unconsumed local
  ownership record remains, including other apps/environments. The refusal names each record file.
  Teardown consumes a record when it deletes or confirms the page's absence; a record whose page
  you have confirmed gone may be deleted by hand. Resume in the original app/environment before
  clearing; do not relabel receipts.
  A record arriving while the workspace is isolated keeps that isolated directory and reports its path.
- **Every page must be in the sitemap.** Validation rejects a page that is not referenced by a
  `page` subarea in `appShell`. Navigation-only (headless) pages — reachable only by a `PAGEREF_`
  call but absent from the sitemap — are not supported; they are not owned by the app. A "detail"
  page is a normal sitemap page that receives caller-supplied context via `pageInput`.
- **`pageId` (optional — edit-snapshot only).** A spec produced by `download-model-app.js` carries
  each page's deployed `GenPageId` as `pages[].pageId` (env-specific GUID). A fresh, hand-authored
  spec **omits** `pageId` — it is portable across environments. On rebuild the spec `pageId` is the
  highest identity authority (outranks the manifest), confirmed against EXISTENCE — so a downloaded
  app (including Maker-added pages) rebuilds against the correct existing page without duplication.
- **What a page round-trip carries — and what it does not.** A download brings back each page's
  code, prompt, `dataSources`, the id of the **model** that generated it (`pages[].model`) and its
  identity; the build re-sends the model with every upload, because pac stores whatever an upload says
  and an upload without one stored it empty. A page's **connector and Custom API bindings** have no App
  Spec field, so they are not in the spec. The build uploads without them, and pac leaves a page's
  existing bindings in place when they are omitted: a rebuild in the **same environment** keeps the
  bindings working, but that is preservation, not reconstruction — the same spec rebuilt in **another
  environment** deploys the page without them (bind them there with `/genpage`).
- **`model` (optional).** The model id a page was generated with, e.g. `"gpt-4.1"` — letters, digits and
  `. _ : / @ + -`, at most 100 characters. A download writes it (an id outside that shape is left out, with
  a warning); an authored spec may omit it, and then a rebuild of an existing page stores it empty.
- **Safety HALTs (pages phase).** The build halts on identity/safety violations rather than
  proceeding with potentially wrong state:
  - `pages-identity-conflict` — spec `pageId` and manifest disagree on a key, or a duplicate id is
    detected across two keys, or an off-sitemap id lacks a corroborated local creation receipt. Manual resolution required.
  - `pages-manifest-corrupt` — the manifest web resource cannot be parsed (two keys mapping to the
    same id). Fix or delete the manifest and rebuild.
  - `pages-shared-across-apps` — a page appears in another app's sitemap. Detach it in Maker first.
    `--allow-destructive` does NOT bypass this halt.
  - `pages-removed` — a page is live in the env but no longer in the spec. Re-add it to the spec, or
    pass `--allow-destructive` to detach it from the nav (`SubArea` removed; page record left deployed).
- **Offline evaluation.** The app-builder eval harness (`evals/model-apps/app-builder/`) grades
  page-stage structural facts from the spec offline (navigation graph resolution, intent-vs-tsx
  completeness). See [`evals/model-apps/app-builder/EVAL_GUIDE.md`](../../../evals/model-apps/app-builder/EVAL_GUIDE.md).

## appShell
```jsonc
{ "areas": [ { "label": "Main", "icon": "new_areaicon.svg", "groups": [ { "label": "Records", "subAreas": [
  { "entity": "new_customer", "title": "Customers" },                              // a table (nav icon = its TABLE icon)
  { "dashboard": "Operations", "title": "Overview", "icon": "new_overview.svg" },  // a built dashboard (by name)
  { "url": "https://…",       "title": "Help" },                                   // an external link
  { "url": "$webresource:new_home.html", "title": "Home" },                        // a declared web resource
  { "page": "overview",       "title": "Overview" }                                // a genpage — KEY (schemaVersion 2)
] } ] } ] }
```
- A subarea names exactly **one** target (lint-enforced): `entity` (a table), `dashboard` (the **name**
  of a `dashboards[]` entry — auto-pinned as an app component so the app includes it), `url`, or
  `page` (the **`key`** of a `pages[]` generative page at schemaVersion 2; the **name** for legacy specs
  — surfaced as a `GenPage` sitemap subarea).
- **Areas and groups take `label`; subareas take `title`.** Each level accepts only the keys the build
  reads — area: `label`, `icon`, `vectorIcon`, `iconDescription`, `groups`; group: `label`,
  `iconDescription`, `subAreas`; subarea: `title`, one target, `icon`, `vectorIcon`, `iconDescription` —
  and anything else is a validation error, so a `title` on an area says "did you mean `label`?" rather
  than deploying an untitled area.
- **Rebuilding an existing app keeps what the spec cannot describe.** Each nav entry the spec keeps is
  written onto the live entry it corresponds to (a subarea by its target; an area or group by its
  label), so the live entry's id, its other attributes (`Client`, `Sku`, `AvailableOffline`, …) and its
  titles in other languages survive; only the label, title, target and icons the spec sets are applied.
  A `dashboard` entry is written the way the designer writes one, with
  `Url="/workplace/home_dashboards.aspx"` — without it the app shows a placeholder icon for the entry,
  and `--verify` fails it.
- **A nav change made in the designer after a download is kept, not reverted.** Download and every
  successful apply record the spec as a baseline in `.maker-workspace/last-applied.json`, for that
  environment and app. When the spec still has the baseline's title or icon for an entry and the
  environment has something else, the build keeps the environment's value and says so, and `--verify`
  accepts it — change the spec to change it. With no baseline for the environment, the spec wins and the
  build reports each change it makes to an existing entry.
- **`url` is either a real http(s) link or a web-resource reference** — `$webresource:<name>` (the form
  the Site Map Designer writes for a "custom page backed by an HTML web resource") or the equivalent
  `/WebResources/<name>` path. A web-resource reference **passes through as-is**, like a platform icon
  ref: it is a live/OOB value a downloaded app carries, and the resource is frequently managed or owned
  by another publisher, so requiring it to be declared would break the download→build round-trip.
  Download captures its content into `webResources[]` when it can safely do so (own prefix, unmanaged).
  Any other scheme is rejected: a `javascript:` or `file:` nav entry in a shipped app is a
  script-injection / local-file-exfil vector.
- Any area or subarea may set **`icon`**. This is either a declared image `webResources[]` NAME
  (png/jpg/gif/svg/ico — validated against `webResources[]`) OR a **platform icon reference** — a path
  (`/WebResources/…`, `/_imgs/…`) or a `$webresource:<name>` — which a **downloaded** app carries verbatim
  (including OOB system icons like `/WebResources/msdyn_.../SitemapIcon/CDSEntity`). A platform reference is
  passed through as-is (case-preserved) and is **not** required to be a declared web resource, so a
  download→build round-trip is never blocked by an OOB icon the download itself wrote. Icons are **chrome,
  not a target** — they don't count toward the "exactly one target" rule.
- **Entity-subarea nav icons round-trip.** An `entity` subarea's `vectorIcon` (and `icon`) are preserved
  across a build **when they are a platform reference** — a modern custom nav glyph
  (`/WebResources/<pub>/icons/x.svg` or `$webresource:<name>.svg`) is emitted onto the sitemap `<SubArea>`
  and round-trips through download. Only a **bare Fluent token** (e.g. `Shop`) is dropped from an entity
  subarea (a raw token there breaks the modern app-designer property pane) — and that drop is **surfaced as
  a warning**, not silent. Alternatively, set the table's own icon via `entities[].vectorIcon` (an SVG web
  resource → `IconVectorName`), which the modern designer also renders for the table. For a non-entity
  subarea (`url`/`page`/`dashboard`), `vectorIcon` is any platform reference (an **SVG path** or a
  **`$webresource:<name>.svg`**) — a bare Fluent token is lint-warned.
- **Custom nav icons are made portable on download.** A path/`$webresource:` reference assumes the web
  resource already exists in the target env, so a naive download→rebuild into a **different** env renders
  a broken icon. To fix this, **download re-declares** the referenced web resource into `webResources[]`
  (with its base64 content, flagged **`external`** — see above) so the build recreates it cross-env — but
  **only** when the WR is (a) **owned by this app** (its name starts with the app's own publisher
  customization prefix), (b) **custom** (unmanaged), and (c) an **image** type. A **foreign-prefix**,
  **managed**, or **OOB** reference (e.g. `/WebResources/msdyn_.../CDSEntity`) is **left as a bare
  reference** — recreating a foreign publisher prefix on a fresh env would hard-fail the build, and OOB
  icons already exist everywhere. If an own-prefix custom icon **can't be captured** (already absent on the
  source env, or the read fails), download **emits a warning**: the sitemap reference still round-trips, but
  the icon will be missing in a fresh env until you declare the web resource yourself. The build also emits a
  non-blocking **portability warning** when an own-prefix path-referenced icon is not declared in
  `webResources[]`.

## design (optional — page design contract)
```jsonc
{ "accentColor": "#0f6cbd", "density": "comfortable", "cornerRadius": "medium",
  "darkMode": "system", "layout": "cards" }
```
- Shared styling tokens threaded to every page so generated pages look consistent with each other
  and the model-driven shell (both Fluent UI V9). Unknown keys are rejected.
- During **generate-pages** the design contract is passed to each headless `page-builder` agent
  so all generated `.tsx` files apply the same Fluent UI V9 token set (accent color, density,
  corner radius, dark-mode policy). Run `node scripts/preview-app.js @<dir>/app-spec.json` to
  preview the design contract alongside the rest of the app before approving the build.

## sampleData (optional)
Keyed by entity `schemaName`. Choice values are **labels** (resolved to ints) — for **both** inline
`options[]` columns **and** `globalChoice`-backed columns (write `"Platinum"`, not `100000000`; the
engine resolves it, and `lintAppSpec` flags any label that isn't a declared option). Raw option ints still
work. Relate records to parents with `$parent` (one) or `$parents` (several — for a junction row), and
set a custom status with `statusReason`. All are topologically inserted and bound via the lookup nav-property.
```jsonc
{
  "new_customer": [ { "new_name": "Northwind", "new_tier": "Pro" } ],
  "new_ticket":   [ { "new_subject": "Down", "new_priority": "High", "statusReason": "Passed QA",
                      "$parent": { "entity": "new_customer", "match": { "new_name": "Northwind" } } } ],
  // a junction row binds BOTH parents — no post-build association script needed:
  "new_assignment": [ { "new_name": "WO-1 / Jane", "new_role": "Lead",
                        "$parents": [ { "entity": "new_workorder", "match": { "new_name": "Replace compressor" } },
                                      { "entity": "new_technician", "match": { "new_name": "Jane Doe" } } ] } ]
}
```
- **`$parents`** is the array form of `$parent` — each entry binds one lookup, so a junction/intersect
  row links to every parent it points at (the engine sets each `<lookup>@odata.bind`).
- **Self-referencing parents work.** A row may point at another row of the **same** entity — an org
  hierarchy, a "reports to" chain — as long as the references form no cycle:
  ```jsonc
  "new_org": [ { "new_name": "Head Office" },
               { "new_name": "North Region", "$parent": { "entity": "new_org", "match": { "new_name": "Head Office" } } } ]
  ```
  Order in the array does not matter; the engine seeds such rows in dependency waves, creating each
  row only after the row it points at. A **cycle** (including a row that is its own parent) is
  rejected by `validateAppSpec` — so by the build on load, and by
  `scripts/lint-app-spec.js`, which runs it — because no creation order can satisfy it.
- **`lookup`** (optional) names *which* relationship a parent bind goes through, by the lookup's
  `schemaName`:
  ```jsonc
  "$parent": { "entity": "new_org", "lookup": "new_GroupAncestorId", "match": { "new_name": "Head Office" } }
  ```
  It is only needed when **two or more** `OneToMany` relationships connect the same pair — common for
  a hierarchy table with both a "parent org" and a "group ancestor" self-lookup. Without it the bind
  would be ambiguous, so `validateAppSpec` **rejects** it rather than silently picking the first
  declared relationship and asserting something false about the data.
- **`statusReason`** must match a declared `statusReasons[]` label on the entity; the engine resolves
  it to the right `statecode` + `statuscode` (so "Completed orders with Passed/Pending QA" just work).
  The status option value is captured during the **data-model** phase — if you set `statusReason` on
  a sample row, **don't `--skip data-model`** in the same run (the build halts loudly rather than
  silently inserting a default status). Re-running *with* `data-model` is safe: status reasons are
  created with a pinned, deterministic value, so a re-run skips the existing one instead of
  duplicating it.
- **MultiChoice** sample values are a comma-separated string of option **labels** (`"A,C"`) or ints
  (`"100000000,100000002"`) — each known label token is resolved.

## ai (optional — AI feature flags and row-summary configuration)

Controls AI-powered features that the platform activates at the app/table level. The block is
entirely optional; omitting it writes no AI setting, so the app's existing AI settings are left as
they are — a feature follows the environment's value only where the app has no value of its own
(removing an app-scope value is not something the build does). Any `ai` block writes every feature
below as an app-scope value, which overrides the environment's.

> **Admin-gated.** AI features turn on only where the environment administrator has enabled them
> in Power Platform Admin Center (Environments → Settings → Product → Features). The `ai-features`
> build phase preflights each setting (`RetrieveSetting` via the SDK) and **skips / warns** for
> anything off — it never fails the build and cannot flip admin or tenant switches.
>
> **Standalone preflight:**
> ```bash
> node "${PLUGIN_ROOT}/scripts/ai-preflight.js" --env <envUrl> [--app <uniqueName>]
> ```
> Prints each feature's on/off status and the exact admin action needed for anything off. Never fails.

```jsonc
"ai": {
  // appFeatures: opt specific AI features in or out for this app (all optional).
  //
  // `false` DOES NOT MEAN "leave alone". It writes an explicit app-scope override that BEATS the
  // org value, so setting it on a feature the org has enabled turns that feature OFF for this app.
  // To defer a feature to the platform instead, give it that setting's platform-default value — still
  // an app-scope value, so the app gets the platform's default rather than the environment's setting.
  //
  // Every one of these settings is a tri-state, and the numbers differ by setting (taken from the
  // platform's own settings UI):
  //   formFill, formFillSuggestions, formFillSmartPaste, formFillFiles, nlSearch, m365
  //                                   -> 0 = Default (defer to the platform), 1 = Off, 2 = On
  //   nlChart                         -> 0 = Off, 1 = Auto (its platform default), 2 = On
  // The build writes `true` as 2 for every feature and `false` as that setting's Off — 1, or 0 for
  // nlChart. (Before AB#6714731 it wrote 1 for `true` outside the form-fill family, which is Off for
  // nlSearch and m365 and only Auto for nlChart.)
  // An explicit integer (0-1000000) is written verbatim, e.g. to choose the platform default; the
  // bound mirrors the SDK's own, so an out-of-range value is rejected here rather than aborting the
  // build half-applied.
  //
  // These write PER-APP settings, which are distinct from the org-level admin gates the build
  // preflights. The gate is NOT a precondition: every write is attempted and then verified, and a
  // gate is read only to EXPLAIN a write that did not persist (AB#6688904 — for four of these
  // features the "gate" IS this same per-app row, so reading it first made a brand-new app look
  // forbidden and nothing was written at all). A feature whose write does not persist is surfaced
  // with a warning naming the admin action; it is never silently reported as applied.
  // DISABLING is treated identically — a `false` is written whatever the gate says, which is why an
  // incorrect `false` is the more damaging mistake of the two.
  "appFeatures": {
    "formFill":  true,   // Copilot-assisted form fill (data entry) — writes 2 (On)
    "nlSearch":  true,   // natural-language grid/view search (data exploration) — writes 2 (On)
    "nlChart":   1,      // natural-language chart / AI data visualization — 1 = Auto, the platform decides
    "m365":      false   // M365 Copilot integration — writes 1 (Off); by default it is left at 0 (Default)
  },
  // summaries: configure the row-summary (Copilot summary card) feature per table.
  "summaries": {
    "default": "auto",   // "auto" (default) | "off" — the app-level default for all tables
    "tables": {
      // per-table overrides; keys are entity schemaNames (case-insensitive, must be declared
      // in entities[]).
      "new_ticket": {
        "enabled":     true,
        "instruction": "Summarise the ticket status, priority and latest comment in two sentences.",
        "columns":     ["new_status", "new_priority", "new_description"]
        // columns[] constrains which fields the summary reads; each entry must be a declared
        // column schemaName on that entity (validation-enforced).
      },
      "new_customer": { "enabled": false }   // opt this table out
    }
  }
}
```

**`summaries.default: "auto"` candidate policy.** When `default` is `"auto"`, the skill
auto-selects tables that are good row-summary candidates and skips those that aren't:
- **Skipped automatically:** lookup-only tables (no descriptive columns), config/reference
  tables, and junction/intersect entities.
- **Always skipped:** the Dynamics 365 app-owned tables `incident` (Case), `lead`, and
  `opportunity` — they provide their own summaries and the feature is not available for them.
  Explicitly setting `enabled: true` for one of these in `summaries.tables` produces a lint
  warning.

**Prompt authoring guidelines** (for `instruction`):
- Write for **meaningful insights**, not field/value repetition.
- **No record GUIDs** in the output.
- Pull in **recent activity** where relevant.
- Use **audience-appropriate tone** (e.g. internal ops vs. customer-facing).
- State an **explicit output shape**: a short paragraph is the recommended default.

**Validation rules** (`validateAppSpec` / `lintAppSpec`):

> **The two gates are not the same, and only one of them runs on every build.**
> `validateAppSpec` is the hard schema gate: `build-model-app.js` runs it on load, so
> `--apply` refuses on its errors. `lintAppSpec` is the authoring guardrail, and the build
> does **not** run it — its findings only reach you through `scripts/lint-app-spec.js`
> (which runs migrate → `validateAppSpec` → `lintAppSpec`) or the skill's plan gate. So a
> rule described below as enforced by the *lint* is one an unlinted spec will carry into a
> build and fail at the platform. Where it matters, the rule names its gate.

- `ai.appFeatures` keys must be one of `formFill · formFillSuggestions · formFillSmartPaste · formFillFiles · nlSearch · nlChart · m365`; values must be a boolean or an integer between `0` and `1000000` (hard error) — the same range the SDK enforces, so an out-of-range value is rejected here rather than aborting the build half-applied. The boolean spelling is **not** a flat `1`/`0`: `true` writes `2` (*On*) for every feature, and `false` writes that setting's *Off* — `1` for most, but **`0` for `nlChart`**, whose `1` means *Auto*. `0` means *Default* (defer to the platform) everywhere except `nlChart`. Use an explicit integer for any other state, such as the platform default.
- **`false` is not "leave alone".** It writes an app-scope override that beats the org value, and unlike enabling it is **not** gated — so `false` on a feature the org has enabled will turn that feature off for this app. To defer a feature to the platform, give it the setting's platform-default value instead (`0`, or `1` for `nlChart`).
- Omitting `ai.appFeatures` does **not** mean "no AI features": a spec carrying any `ai` block gets the defaults `formFill · nlSearch · nlChart` on (`2`) and `m365` left at its platform default (`0`), and `--verify` reconciles that whole resolved set.
- A rejected row-summary publish does not authorize name-based cleanup. Same-name AI models are
  kept and reported because the failed SDK call returns no created-model id to the build.
- `ai.summaries.default` must be `"auto"` or `"off"` (hard error).
- `ai.summaries.tables` keys must match a declared entity `schemaName` (case-insensitive, hard error).
- `columns[]` entries must be declared column `schemaName` values on that entity (hard error in both validate and lint).
- **Lint warnings:**
  - `incident`, `lead`, and `opportunity` are Dynamics 365 app tables (Case / Lead / Opportunity) that provide their own row summaries — configuring one as a summary table warns, because the row-summary feature is not available for them.
  - A table with no descriptive columns (only lookups / system fields) warns that a row summary may not be useful.

## personas[] (optional — security roles)

Authors one **security role per persona**, sized to the entity access that persona's
**jobs-to-be-done** need. Without at least one role the generated app runs only for system
administrators; `personas[]` produces a working access model so the app opens for real users.

`personas[]` is captured **first** during authoring (Level (a0), before the data model): the jobs
are what the app exists to do, so they drive which tables and surfaces exist. `privileges[]` is
filled in later (Level (c)), once the entities they reference are agreed.

The model is **deterministic**: you DECLARE the access each job requires — the builder never infers
privileges from a job's text. It **unions** every job's declared access into the persona's one role
(max scope wins per entity+access) and applies it with replace semantics (a rebuild that drops a
privilege removes it — the role converges to the spec).

```jsonc
"personas": [
  {
    "persona": "Field Technician",         // the role name (unique across personas[])
    // jobs[]: the units of work this persona does. Each job DECLARES the entity access it needs.
    // `surfaces[]` is optional and documentary — the views/forms/pages that let them do the job.
    "jobs": [
      { "name": "Complete work orders",
        "surfaces": ["My Work Orders", "Work Order"],
        "privileges": [
          { "entity": "msdyn_workorder", "access": ["read", "write"], "scope": "businessUnit" },
          { "entity": "msdyn_workorderproduct", "access": ["read", "create", "write"], "scope": "user" }
        ] },
      { "name": "Look up customers",
        "privileges": [ { "entity": "account", "access": ["read"], "scope": "organization" } ] }
    ],
    // additionalPrivileges (optional): baseline access not tied to one job (shared reference tables,
    // extra app components). Unioned in like a job's privileges.
    "additionalPrivileges": [ { "entity": "product", "access": ["read"], "scope": "organization" } ],
    // appAccess (optional, default true): when true, the build injects a read privilege on the app's
    // appmodule AND associates the app to this role, so the app opens for the persona. Set false to
    // author a data-only role that does NOT get the app (e.g. a back-office role).
    "appAccess": true,
    // assignTo (optional, grant-only): assign the finished role to existing teams/users by GUID. The
    // build only ADDS members (never revokes). Omit to author the role and let an admin assign it.
    "assignTo": { "teams": [], "users": [] }
  }
]
```

**Field reference**
- `persona` (**required**) — the security role's display name; also its idempotency key. Must be unique across `personas[]`.
- `jobs[]` (**required**, ≥1) — `{ name, description?, surfaces?, privileges[] }`. `privileges[]` is required and non-empty per job.
- `jobs[].surfaces[]` (optional) — the view/form/page names (or page `key`s) that let this persona **do** the job. Never applied to Dataverse. It renders the jobs→surfaces traceability table in `model-app-plan.md`; a job with no `surfaces[]` is flagged by `spec-lint.js` as a design gap, and a surface that **matches nothing this spec builds** is flagged too (`lib/surface-resolver.js` resolves each entry against `views[]` / `forms[]` / `pages[]` (key **or** name) / `dashboards[]` / `entities[]` / sitemap subarea titles, case-insensitively). Both are **warnings**, never errors — a surface may legitimately name an out-of-the-box artifact this spec does not author. `verify-model-app` additionally rolls a *deployed* failure up to the job that depended on it (`job-surface`), so "view X is missing" also reads as "persona P can no longer do job J".
- `privileges[].entity` (**required**) — a table **logical name** (e.g. `account`, `msdyn_workorder`). May be a table this spec doesn't author (standard/system tables are common); existence is resolved against live metadata by the build, not at lint time.
- `privileges[].access` (**required**) — one or more of `read · create · write · delete · append · appendTo · assign · share`.
- `privileges[].scope` (optional, default `user`) — `user` (Basic) · `businessUnit` (Local) · `parentChild` (Deep) · `organization` (Global), least→most permissive.
- `additionalPrivileges[]` (optional) — baseline `EntityPrivilege[]` unioned into the role.
- `appAccess` (optional boolean, default `true`) — inject app-module read + associate the app to the role.
- `businessUnitId` (optional GUID) — business unit to create the role in (defaults to the org root BU).
- `assignTo` (optional) — `{ teams?: GUID[], users?: GUID[] }`, grant-only.
- `excludes[]` (optional) — what this persona deliberately **does not** do in this app, e.g.
  `"Approving budgets — handled in the Finance app"`. Never applied to Dataverse; like
  `jobs[].surfaces[]` it is documentary, and it renders as a **Deliberately out of scope** list beside
  the jobs→surfaces traceability table in `model-app-plan.md`. An app's scope is defined as much by
  what it leaves out as by what it includes, and the exclusions are what let a reviewer tell two apps
  built over the same tables apart — an omission nobody was shown cannot be approved. Entries must be
  non-empty strings; a bare string instead of an array is rejected rather than read as a one-item list.

**Idempotency & safety.** A role is identified by its **(trimmed name, business unit)** — the same
identity the platform uses. A rebuild **reuses** only a role the builder itself authored (marked as
SDK-authored); a same-name role someone else created — or a managed role — is a **conflict** the build
refuses (fail-closed), never adopting or mutating a role it does not own. Privileges **converge**
(replace semantics): a rebuild that drops a privilege removes it. App availability also converges —
flipping `appAccess` to `false` on a rebuild **removes** the app↔role association (the app stops
appearing for that persona), not just the injected privilege. `teardown --apply` deletes only the
builder-authored persona roles, scoped to the persona's business unit so a same-named role in another
business unit is never touched. Because roles are keyed by (name, BU), two apps that declare a persona
of the **same name in the same business unit** share one role by design (the second build reuses the
first's) — give personas distinct names, or a distinct `businessUnitId`, if you need separate roles. In
`--changed-only` mode a persona change forces a **full build** (there is no partial security apply yet).

**Verification.** `verify-model-app` proves the role **row** exists carrying the SDK ownership marker
(`role`) *and* — when the reader supplies role/entity privilege access — that the role actually
**grants** every declared privilege at **at least** the declared depth (`role-privileges`). The depth
comparison is a **subset** check by design: extra privileges are never a finding, because `appAccess`
injects `appmodule` read, unioned jobs escalate a shared entity+access to the max declared scope, and
distinct entities can share one Dataverse privilege (a role holds one depth per privilege). It fails
**closed** — an unreadable role, or a table whose privilege metadata cannot be read, is reported
rather than skipped.

**Validation rules** (`validateAppSpec`): `persona` required + unique; each job needs a `name` and a
non-empty `privileges[]`; `access` values and `scope` must be valid tokens; `appAccess` must be a
boolean; `businessUnitId` and `assignTo` ids must be GUIDs. Two apply-time checks need live metadata and
are **not** enforced at lint time (they surface as a clear build halt): whether an entity supports a
requested access, and the rule that different entities sharing one Dataverse privilege must request the
same scope.

**Not yet supported** (tracked follow-up): column-level (field) security and access teams / hierarchy
security. The security surface today is role-per-persona plus `roleGrants[]` (below).
