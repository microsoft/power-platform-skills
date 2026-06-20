# App Spec schema (model-app-maker)

The **App Spec** is the reviewable JSON contract between the interactive authoring flow and the
deterministic builder (`scripts/build-model-app.js`). Author it to this shape, lint it
(`scripts/lib/spec-lint.js`), then build it — **never hand-write a builder.**

> **Canonical example:** [`samples/app-spec.support-desk.json`](../samples/app-spec.support-desk.json)
> — 3 tables, 2 relationships, 3 views, 2 charts, 3 forms (with sub-grids), relational sample
> data. Read it first; it shows every section in use. `app-spec.project-tracker.json` shows an
> **explicit form layout** (`tabs`).

## Top-level shape

```jsonc
{
  "solution": { "uniqueName": "ContosoSupportDesk", "displayName": "Contoso Support Desk", "publisherPrefix": "new" },
  "app":      { "name": "Support Desk", "description": "Track tickets" },
  "entities":      [ /* tables — see below */ ],
  "relationships": [ /* 1:N links — see below */ ],
  "views":         [ /* saved queries */ ],
  "charts":        [ /* Choice-column charts */ ],
  "forms":         [ /* main forms */ ],
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
  "columns": [
    { "schemaName": "new_priority", "displayName": "Priority", "type": "Choice", "options": ["Low","High"] },
    { "schemaName": "new_duedate",  "displayName": "Due Date", "type": "DateTime" }
  ]
}
```
- **Column `type`:** `Text · Memo · Choice · Boolean · Money · DateTime · Integer · Decimal`.
  `Choice` **requires** `options[]` (string labels). **Lookups are NOT columns** — declare a
  `OneToMany` relationship instead.
- `required: true` marks a column application-required.

## relationships[]
```jsonc
{ "type": "OneToMany", "referenced": "new_customer", "referencing": "new_ticket",
  "lookup": { "schemaName": "new_CustomerId", "displayName": "Customer" } }
```
- `referenced` = the "one" (parent); `referencing` = the "many" (child, gets the lookup column).
- The relationship's schema name defaults to `<referenced>_<referencing>` and **must differ**
  from `lookup.schemaName` (Dataverse rejects a collision — the lint enforces this).

## views[]
```jsonc
{ "entity": "new_ticket", "name": "Active Tickets", "columns": ["new_subject","new_priority"],
  "sort": [{ "attr": "new_subject", "dir": "asc" }], "activeOnly": true }
```

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
```
- A sub-grid needs a matching `OneToMany` from the form's entity to `childEntity` (lint-enforced).

## appShell
```jsonc
{ "areas": [ { "label": "Main", "groups": [ { "label": "Records",
  "subAreas": [ { "entity": "new_customer", "title": "Customers" } ] } ] } ] }
```

## sampleData (optional)
Keyed by entity `schemaName`. Choice values are **labels** (resolved to ints). Relate a child to
its parent with `$parent` (topologically inserted, bound via the lookup):
```jsonc
{
  "new_customer": [ { "new_name": "Northwind", "new_tier": "Pro" } ],
  "new_ticket":   [ { "new_subject": "Down", "new_priority": "High",
                      "$parent": { "entity": "new_customer", "match": { "new_name": "Northwind" } } } ]
}
```
