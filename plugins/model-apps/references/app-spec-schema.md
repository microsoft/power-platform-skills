# App Spec schema (app-builder)

The **App Spec** is the reviewable JSON contract between the interactive authoring flow and the
deterministic builder (`scripts/build-model-app.js`). Author it to this shape, lint it
(`scripts/lib/spec-lint.js`), then build it — **never hand-write a builder.**

> **Canonical example:** [`samples/app-spec.support-desk.json`](../samples/app-spec.support-desk.json)
> — 3 tables, 2 relationships, 3 views, 2 charts, 3 forms (with sub-grids), relational sample
> data. Read it first; it shows every section in use. `app-spec.project-tracker.json` shows an
> **explicit form layout** (`tabs`).

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

## entities[]
```jsonc
{
  "schemaName": "new_ticket",            // publisher-prefixed; logical name is its lowercase
  "displayName": "Ticket",
  "pluralName": "Tickets",               // optional (defaults to "<displayName>s")
  "hasNotes": true,                       // optional — enables the Notes/timeline on the table + form
  "vectorIcon": "new_ticketicon",         // optional — the table's OWN icon (what the modern app
                                          //   designer + app nav render for the table). Must be a
                                          //   declared SVG web resource (webResources[] type "svg").
                                          //   NOTE: this is a web-resource name, NOT a Fluent token —
                                          //   an unresolvable value leaves the designer's property
                                          //   pane stuck on a glimmer, so it is hard-validated.
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
  `childEntity` (lint-enforced); the builder resolves the relationship name either way.
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

## pages[] (optional — generative pages / genux)
```jsonc
[ { "name": "Overview", "dataSources": ["new_order", "new_customer"],
    "prompt": "A KPI overview with recent orders", "codeFile": "overview.tsx" } ]
```
- **Genpage-first policy:** model-driven forms/views are the default for record surfaces; use a
  generative `page` for overviews/dashboards/analytics/landing surfaces. Each page needs a `name` and
  a **`codeFile`** (the `.tsx` the build uploads via `pac model genpage upload`, no `--add-to-sitemap`
  — the SDK owns the sitemap). `dataSources` (tables the page reads) are passed to pac and lint-warned
  if they aren't declared entities (standard tables are fine). `prompt` is retained on the page.
- Surface a page in the nav with a **`page`** sitemap subarea (below) — it becomes a `GenPage` subarea
  keyed by the deployed page's id. Traditional `dashboards[]` remain available for explicit classic
  dashboards.

## appShell
```jsonc
{ "areas": [ { "label": "Main", "icon": "new_areaicon.svg", "groups": [ { "label": "Records", "subAreas": [
  { "entity": "new_customer", "title": "Customers", "icon": "new_customer.svg" },  // a table (+ nav icon)
  { "dashboard": "Operations", "title": "Overview", "vectorIcon": "Home" },        // a built dashboard (by name)
  { "url": "https://…",       "title": "Help" }                                    // an external link
] } ] } ] }
```
- A subarea names exactly **one** target (lint-enforced): `entity` (a table), `dashboard` (the **name**
  of a `dashboards[]` entry — auto-pinned as an app component so the app includes it), `url`, or
  `page` (the **name** of a `pages[]` generative page — surfaced as a `GenPage` sitemap subarea).
- Any area or subarea may set **`icon`** (a declared image `webResources[]` entry — png/jpg/gif/svg/ico)
  and/or **`vectorIcon`** (a Fluent icon token, e.g. `"Home"`). Icons are **chrome, not a target** — they
  don't count toward the "exactly one target" rule. `icon` must reference a declared **image** web resource
  (validated); `vectorIcon` is a free-form token (lint warns if it looks like a filename).

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
