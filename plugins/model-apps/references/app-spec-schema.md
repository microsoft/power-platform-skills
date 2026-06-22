# App Spec schema (model-app-maker)

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
| A command-bar button that runs JS | `commands[]` (`library` + `function`; optional `hidden`/`disabled`) | commands |

The builder is **idempotent** and runs everything in one pass (no post-build scripts): tables,
columns, relationships, web resources, views, charts, forms (+ sub-grids + JS handlers), commands, the app,
sample data (incl. multi-parent junction links + status reasons), and publish.

## Top-level shape

```jsonc
{
  "solution": { "uniqueName": "ContosoSupportDesk", "displayName": "Contoso Support Desk", "publisherPrefix": "new" },
  "app":      { "name": "Support Desk", "description": "Track tickets" },
  "entities":      [ /* tables — see below */ ],
  "relationships": [ /* 1:N links — see below */ ],
  "globalChoices": [ /* optional shared option sets */ ],
  "webResources":  [ /* optional JS/HTML/CSS for form logic */ ],
  "views":         [ /* saved queries */ ],
  "charts":        [ /* Choice-column charts */ ],
  "forms":         [ /* main forms — may wire JS event handlers */ ],
  "appShell":      { "areas": [ /* sitemap */ ] },
  "sampleData":    { /* optional, keyed by entity schemaName */ }
}
```

## entities[]
```jsonc
{
  "schemaName": "new_ticket",            // publisher-prefixed; logical name is its lowercase
  "displayName": "Ticket",
  "pluralName": "Tickets",               // optional (defaults to "<displayName>s")
  "hasNotes": true,                       // optional — enables the Notes/timeline on the table + form
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

## charts[]
```jsonc
{ "entity": "new_ticket", "name": "Tickets by Priority", "chartType": "Pie",
  "groupBy": "new_priority", "measure": "count" }
```
- `chartType`: `Column · Bar · Pie · Line`. **`groupBy` MUST be a Choice column** on `entity`.

## forms[]
```jsonc
// auto layout (default): primary + all scalar columns, sub-grids for child relationships
{ "entity": "new_customer", "type": "main", "name": "Customer", "layout": "auto",
  "notes": true,                                   // optional — add a Notes section
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
```
- **`formType`** is `Main` (default), `QuickCreate`, or `QuickView`. A `QuickCreate` form is a
  simplified create form on the same entity (no sub-grids, no Notes; events allowed). A `QuickView`
  form is read-only (no sub-grids, no events) and is **created**, but placing it on a parent form via
  a lookup is not auto-wired yet (lint warns). Sub-grids/Notes are Main-form only.
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
```
- A button's on-click calls `function` in the declared `library` web resource (both lint-enforced) —
  this is what makes it **functional** (not a structural-only button). `parameters` (optional) passes a
  raw arg string.
- **`location`** is `MainTab` (default — the entity form/grid command bar), `HomeTab`, or `ContextualTab`.
- **`hidden`** / **`disabled`** set *static* visibility/enablement. **Conditional (rule-based)
  visibility is not supported** — it's Power Fx-only on modern commands and needs a component library
  that can't be authored headlessly.
- Buttons are emitted as loose controls (no custom grouping — a titled group needs a parent command-bar
  row the SDK doesn't synthesize from scratch). The command lands in the Default solution but is
  entity-scoped, so it shows on the entity's command bar in the app.

## appShell
```jsonc
{ "areas": [ { "label": "Main", "groups": [ { "label": "Records",
  "subAreas": [ { "entity": "new_customer", "title": "Customers" } ] } ] } ] }
```

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
