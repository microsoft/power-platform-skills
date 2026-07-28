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

The builder is **idempotent** and runs everything in one pass (no post-build scripts): tables,
columns, relationships, web resources, views, charts, forms (+ sub-grids + JS handlers), commands, dashboards, the app,
sample data (incl. multi-parent junction links + status reasons), and publish.

## Top-level shape

```jsonc
{
  "solution": { "uniqueName": "ContosoSupportDesk", "displayName": "Contoso Support Desk", "publisherPrefix": "new" },
  "app":      { "name": "Support Desk", "description": "Track tickets", "icon": "new_appicon" },
  "entities":      [ /* tables — see below */ ],
  "relationships": [ /* 1:N links — see below */ ],
  "globalChoices": [ /* optional shared option sets */ ],
  "webResources":  [ /* optional JS/HTML/CSS for form logic */ ],
  "views":         [ /* saved queries */ ],
  "charts":        [ /* Choice-column charts */ ],
  "forms":         [ /* main forms — may wire JS event handlers */ ],
  "appShell":      { "areas": [ /* sitemap */ ] },
  "sampleData":    { /* optional, keyed by entity schemaName */ },
  "ai":            { /* optional — AI feature flags + row-summary config */ }
}
```

- **`app.icon`** *(optional)* — the app tile icon. Must be a **declared image web resource**
  (png/jpg/gif/svg/ico in `webResources[]`) so the app is **self-contained** on export/import.
  **Omit it** and the build generates a simple default SVG icon **inside the solution** — either
  way the app never depends on an arbitrary external/managed icon (which would fail to import into
  a new environment). The app's **sitemap** is also added to the solution automatically.
- **`app.uniqueName`** *(optional, download-emitted)* — the app module's **real, immutable** Dataverse
  uniquename (e.g. `crba3_supportdesk`). A **downloaded** spec carries it so a rebuild resolves the
  **existing** app by identity — even after you **rename** the display `app.name` — instead of creating a
  **duplicate** app. You normally never hand-author this: an authored create-fresh spec omits it, and the
  build derives the uniquename deterministically from `solution.publisherPrefix` + `app.name`.

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
  "icon": "new_ticketicon_png",           // optional — raster fallback (png/jpg/gif/ico web resource,
                                          //   → IconMediumName). Prefer vectorIcon for the modern look.
  "existing": true,                       // optional — this table PRE-EXISTS (system table like
                                          //   account/contact, or a custom table owned elsewhere).
                                          //   The build reuses it; teardown NEVER deletes it. System
                                          //   tables are auto-detected and skipped by teardown even
                                          //   without this flag — set it for a REUSED CUSTOM table
                                          //   you want protected from teardown.
  "primaryAttribute": { "schemaName": "new_subject", "displayName": "Subject" },
  // primary can be auto-numbered (the number IS the record identity — recommended for orders/cases):
  // "primaryAttribute": { "schemaName": "new_ordernumber", "displayName": "Order Number", "autoNumberFormat": "WO-{SEQNUM:5}" },
  "columns": [
    { "schemaName": "new_priority", "displayName": "Priority", "type": "Choice", "options": ["Low","High"] },
    { "schemaName": "new_duedate",  "displayName": "Due Date", "type": "DateTime" }
  ]
}
```
- **Column `type`:** `Text · Memo · Choice · MultiChoice · Boolean · Money · DateTime ·
  Integer · BigInt · Decimal · Double · File · Image · AutoNumber · Customer`.
  **Lookups are NOT columns** — declare a `OneToMany` relationship instead.
- **Per-type options** (all optional): `required: true` / `"recommended"`; Text → `maxLength`,
  `format` (`Text`/`Email`/`Url`/`Phone`); numeric → `minValue`/`maxValue`/`precision`;
  DateTime → `dateFormat` (`DateOnly`/`DateAndTime`); Boolean → `trueLabel`/`falseLabel`;
  File/Image → `maxSizeKb`, Image → `isPrimaryImage`; AutoNumber → `autoNumberFormat`
  (e.g. `"C-{SEQNUM:5}"`); Calculated/Rollup → `source: "Calculated"|"Rollup"` + `formula`.
- **Choice / MultiChoice** need `options[]` (string labels) **or** a `globalChoice` reference
  (see `globalChoices` below). **Customer** is a polymorphic account/contact lookup.
- **AutoNumber** can also be the **primary** column — put `autoNumberFormat` on `primaryAttribute`
  (above) instead of adding a separate column, so the generated number is the record identity.

### entity sub-sections (optional)
```jsonc
"statusReasons": [ { "label": "In Review", "state": "Active" } ],   // custom status values
"alternateKeys": [ { "schemaName": "new_emailkey", "displayName": "Email Key", "columns": ["new_email"] } ]
```

## globalChoices[] (optional — shared option sets)
```jsonc
[ { "name": "new_priority", "displayName": "Priority", "options": ["Low","Medium","High"] } ]
```
Reference from a column via `"globalChoice": "new_priority"` (built before the columns that bind it).

## relationships[]
```jsonc
{ "type": "OneToMany", "referenced": "new_customer", "referencing": "new_ticket",
  "lookup": { "schemaName": "new_CustomerId", "displayName": "Customer" } }
```
- `referenced` = the "one" (parent); `referencing` = the "many" (child, gets the lookup column).
- The relationship's schema name defaults to `<referenced>_<referencing>` and **must differ**
  from `lookup.schemaName` (Dataverse rejects a collision — the lint enforces this).
- **Relationships to a standard/system table** (e.g. `systemuser`, `account` — a common
  "bridge to a real user / owner" pattern) are handled automatically: because a system table has
  no publisher prefix, the naive default name wouldn't start with your prefix and Dataverse would
  reject it. The builder **auto-prepends the publisher prefix** (e.g. `systemuser` + child
  `contoso_teammember` → `contoso_systemuser_teammember`), so you don't need to set `schemaName`.
  If you *do* supply an explicit `schemaName`, it **must** start with `<publisherPrefix>_` — the
  lint errors otherwise (an unprefixed relationship name is a build-time 400).

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

## webResources[] (optional — client-side logic)
```jsonc
[ { "name": "new_ticket.js", "displayName": "Ticket Scripts", "type": "js",
    "content": "var Ticket={onLoad:function(ctx){},onPriority:function(ctx){}};" } ]
```
- `type`: `js · html · css · xml · png · jpg · gif · svg · ico · xsl · resx` (script web resources
  should be named with a `.js` extension).
- Source comes from **one** of: `content` (inline text), `contentPath` (a file read relative to the
  app folder at build time), or `contentBase64` (for binary types).
- Built **before** forms and added to the solution; reference one from a form `events[]` handler.
- **`external`** *(optional, download-emitted)* — set `true` on an entry that **download** re-declared
  because a sitemap nav icon referenced a custom image web resource **by path** (see appShell icons
  below). The build **creates it if missing, reuses it if present** (idempotent, no overwrite), so the
  icon resolves after a rebuild into a **fresh** environment. Teardown **never deletes** an `external`
  web resource: a publisher-owned WR can be shared across that publisher's other apps/solutions, and an
  orphaned icon is recoverable while a deleted shared resource is not — so this fails safe (mirrors
  `existing: true` on downloaded tables). You normally never hand-author this flag.

## views[]
```jsonc
{ "entity": "new_ticket", "name": "Active Tickets", "columns": ["new_subject","new_priority"],
  "sort": [{ "attr": "new_subject", "dir": "asc" }], "activeOnly": true,
  // optional rich filters (beyond the default active-records condition):
  "filters": [
    { "attr": "ownerid", "op": "eq-userid" },                       // "my" records — no value
    { "attr": "new_priority", "op": "not-in", "values": ["Low"] },  // multi-value (Choice labels resolve to ints)
    { "attr": "new_duedate", "op": "this-week" }                    // relative-date — no value
  ] }
```
- `activeOnly` (default `true`) adds `statecode eq 0`. `filters[]` add conditions: `op` is any
  FetchXML operator — `eq`/`ne`/`lt`/`le`/`gt`/`ge`/`like`, no-value ops (`eq-userid`, `null`,
  `not-null`, `this-week`/`this-month`/`today`/…), and multi-value `in`/`not-in` (use `values[]`).
  Choice **labels** in `value`/`values` resolve to option ints. This is what "My Open Orders"
  (`ownerid eq-userid` + `new_status not-in [Completed, Cancelled]`) and "Completed This Week"
  (`new_status eq Completed` + `modifiedon this-week`) need — no post-build FetchXML patching.
- **Default-view enrichment (automatic):** the auto-generated **"Active &lt;Entity&gt;"** and
  **"Inactive &lt;Entity&gt;"** system views ship with only the primary column. The build enriches
  them with the primary column plus up to 6 meaningful declared columns (in declared order, skipping
  wide/opaque types like MultilineText). This runs by default for every table that has extra columns;
  opt a table out with **`"enrichDefaultViews": false`** on its `entities[]` entry. Author-declared
  `views[]` are separate and always win.

## charts[]
```jsonc
{ "entity": "new_ticket", "name": "Tickets by Priority", "chartType": "Pie",
  "groupBy": "new_priority", "measure": "count" }
```
- `chartType`: `Column · Bar · Pie · Line`. **`groupBy` MUST be a Choice column** on `entity`.

## forms[]
```jsonc
// auto layout (default): primary + all scalar columns + 1:N parent lookups; opt-in child grids
{ "entity": "new_customer", "type": "main", "name": "Customer", "layout": "auto",
  "notes": true,                                   // optional — add a Notes section
  "autoSubgrids": true,                            // optional — a sub-grid for every child relationship
  "deactivateOtherMainForms": true,                // optional — see below (own custom tables only)
  "subgrids": [ { "childEntity": "new_ticket", "view": "Active Tickets", "label": "Tickets" } ] }

// explicit layout: author tabs -> sections -> columns(1-4) -> fields
{ "entity": "new_project", "type": "main", "name": "Project",
  "tabs": [ { "label": "General", "sections": [
    { "label": "Details", "columns": 2, "fields": ["new_name","new_budget","new_status"] } ] } ] }

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
  `parameters`. The build fetches the pushed form, injects the handlers, then publishes it.

## commands[] (optional — modern command-bar buttons)
```jsonc
{ "entity": "new_order", "label": "Escalate", "location": "MainTab",
  "library": "new_order.js", "function": "Order.escalate",   // on-click JS (web resource + fn)
  "disabled": false, "hidden": false }                        // optional static visibility

// flyout (drop-down) menu: a container button whose children are the menu items
{ "entity": "new_order", "label": "More", "type": "FlyoutAnchor", "children": [
  { "label": "Approve", "library": "new_order.js", "function": "Order.approve" },
  { "label": "Reject",  "library": "new_order.js", "function": "Order.reject" } ] }
```
- A button's on-click calls `function` in the declared `library` web resource (both lint-enforced) —
  this is what makes it **functional** (not a structural-only button). `parameters` (optional) passes a
  raw arg string.
- **`location`** is `MainTab` (default — the entity form/grid command bar), `HomeTab`, or `ContextualTab`.
- **`hidden`** / **`disabled`** set *static* visibility/enablement. **Conditional (rule-based)
  visibility is not supported** — it's Power Fx-only on modern commands and needs a component library
  that can't be authored headlessly.
- **`type`** is `Button` (default), `FlyoutAnchor`, or `SplitButton`. A flyout/split container holds
  `children[]` (each a button with its own `library`+`function`) instead of an on-click of its own —
  the menu items live under it. Top-level buttons emit as **loose controls**; a *titled* group is not
  supported (it needs a parent command-bar row the SDK doesn't synthesize from scratch). The command
  lands in the Default solution but is entity-scoped, so it shows on the entity's command bar.

## dashboards[] (optional — chart/list/iframe/web-resource tiles)
```jsonc
{ "name": "Operations", "tiles": [
  { "type": "chart", "chart": "Orders by Status", "view": "Active Orders" },  // chart needs both
  { "type": "list",  "view": "Active Orders", "name": "Recent" },             // list needs a view
  { "type": "iframe", "url": "https://…", "name": "Map" },
  { "type": "webresource", "webResource": "new_widget.html", "name": "Widget" } ] }
```
- A **chart** tile needs both a declared `chart` (the visualization) **and** a declared `view` (its
  data); a **list** tile needs a declared `view`. The target entity is derived from the view. `name`
  defaults to the chart/view name; `colspan`/`rowspan` optional (default 1×4).
- Built after views/charts (it references their ids). The dashboard is **global** (not entity-scoped)
  and added to the solution. To surface it in the app nav, add a `dashboard` sitemap subarea (below) —
  that also auto-pins it as an app component.

## pages[] (optional — generative pages / genux)  [schemaVersion 2]
```jsonc
[ { "key": "overview", "name": "Overview", "purpose": "KPI overview + recent orders",
    "dataSources": ["new_order", "new_customer"],
    "source": { "kind": "intent" },                // design-time; generate-pages fills the .tsx
    "navigatesTo": [{ "targetKey": "detail", "data": { "orderId": "string" } }],
    "pageInput": { "data": { "orderId": "string" } } } ]
// after generate-pages: "source": { "kind": "tsx", "codeFile": "overview.tsx" }
```
- **Genpage-first policy** is unchanged. A page's implementation state is an explicit discriminated
  `source`: `{ "kind": "intent" }` (declared but not yet coded) or `{ "kind": "tsx", "codeFile": "…" }`
  (the `.tsx` the build uploads). A **legacy** top-level `"codeFile"` (no `schemaVersion`) is still
  accepted and treated as an implemented tsx page.
- Validation is **profile-scoped**: `design`/`plan` accept intent pages; a `deploy` build (the default)
  requires every page implemented.
- **`key`** (schemaVersion 2, required, unique) is the page's **single stable identity** — used by
  `navigatesTo[].targetKey`, the `PAGEREF_<key>` navigation placeholder, and the `page` sitemap
  subarea. Renaming a page never changes its key. It must match `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`,
  be unique across all pages in the spec, and (for an implemented page) its `codeFile` path must be
  unique and workspace-confined (no `..` or absolute-path escape).
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
     create-vs-reuse (crash-safe: a page present in the env but not yet in the sitemap is reused,
     never re-created). A read failure HALTs (`pages-existence-failed`).
  3. **MEMBERSHIP** — the app's sitemap `GenPageId` set (read via `fetchSitemap` —
     fail-closed, discriminated). This set alone decides placement, download enumeration, and verify
     coverage. A read failure HALTs (`pages-sitemap-read-failed`).
- **Every page must be in the sitemap.** Validation rejects a page that is not referenced by a
  `page` subarea in `appShell`. Navigation-only (headless) pages — reachable only by a `PAGEREF_`
  call but absent from the sitemap — are not supported; they are not owned by the app. A "detail"
  page is a normal sitemap page that receives caller-supplied context via `pageInput`.
- **`pageId` (optional — edit-snapshot only).** A spec produced by `download-model-app.js` carries
  each page's deployed `GenPageId` as `pages[].pageId` (env-specific GUID). A fresh, hand-authored
  spec **omits** `pageId` — it is portable across environments. On rebuild the spec `pageId` is the
  highest identity authority (outranks the manifest), confirmed against EXISTENCE — so a downloaded
  app (including Maker-added pages) rebuilds against the correct existing page without duplication.
- **Safety HALTs (pages phase).** The build halts on identity/safety violations rather than
  proceeding with potentially wrong state:
  - `pages-identity-conflict` — spec `pageId` and manifest disagree on a key, or a duplicate id is
    detected across two keys. Manual resolution required.
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
  { "page": "overview",       "title": "Overview" }                                // a genpage — KEY (schemaVersion 2)
] } ] } ] }
```
- A subarea names exactly **one** target (lint-enforced): `entity` (a table), `dashboard` (the **name**
  of a `dashboards[]` entry — auto-pinned as an app component so the app includes it), `url`, or
  `page` (the **`key`** of a `pages[]` generative page at schemaVersion 2; the **name** for legacy specs
  — surfaced as a `GenPage` sitemap subarea).
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
engine resolves it, and the lint flags any label that isn't a declared option). Raw option ints still
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
entirely optional; omitting it leaves every AI feature at its platform default.

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
  // appFeatures: opt specific AI features in or out for this app (all optional booleans).
  "appFeatures": {
    "formFill":  true,   // Copilot-assisted form fill (data entry)
    "nlSearch":  true,   // natural-language grid/view search (data exploration)
    "nlChart":   true,   // natural-language chart / AI data visualization
    "m365":      false   // M365 Copilot integration (opt-in; defaults false)
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
- `ai.appFeatures` keys must be one of `formFill · nlSearch · nlChart · m365`; values must be booleans (hard error).
- `ai.summaries.default` must be `"auto"` or `"off"` (hard error).
- `ai.summaries.tables` keys must match a declared entity `schemaName` (case-insensitive, hard error).
- `columns[]` entries must be declared column `schemaName` values on that entity (hard error in both validate and lint).
- **Lint warnings:**
  - `incident`, `lead`, and `opportunity` are Dynamics 365 app tables (Case / Lead / Opportunity) that provide their own row summaries — configuring one as a summary table warns, because the row-summary feature is not available for them.
  - A table with no descriptive columns (only lookups / system fields) warns that a row summary may not be useful.
