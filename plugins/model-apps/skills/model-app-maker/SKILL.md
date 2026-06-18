---
name: model-app-maker
version: 0.1.0
description: Builds a model-driven Power Apps APP from a natural-language intent — proposes a structured App Spec, confirms it with you, then provisions tables, columns, adaptive forms (with related-record sub-grids), views, charts, and the app module + sitemap into a solution. Use when the user says "build an app for X", "create a model-driven app", or "make me an app to manage Y". For generative PAGES use /genpage; for editing one existing form use the model-maker relay.
author: Microsoft Corporation
argument-hint: "<app description>"
user-invocable: true
model: sonnet
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
---

# model-app-maker — intent → model-driven app

Turn a natural-language request into a runnable model-driven app. This skill is a
thin loop around the deterministic builder (`scripts/build-model-app.js`); it does
NOT hand-write metadata or XML — tables/columns/relationships go through the
plugin's `dv-*` scripts, and forms/views/sitemap XML is produced headlessly by the
vendored `cds-maker-kernel` bundle.

## Workflow

1. **Confirm the target environment** (org URL) — the mandatory multi-env safety
   check. Never provision without it.
2. **Confirm auth:** `node scripts/check-auth.js <envUrl>` → expect `ok:true` and
   `identitiesMatch:true`.
3. **Propose an App Spec.** From the user's prompt, draft a structured App Spec
   (see `samples/app-spec.project-tracker.json` for the exact shape): `solution`,
   `app`, `entities` (with `columns` + `type`), `relationships`, `forms`, `views`,
   `appShell`. Column `type` is one of Text / Memo / Choice / Boolean / Money /
   DateTime / Integer / Decimal / Lookup (Choice needs `options[]`). Keep the MVP
   to ONE entity unless the user asks for more. Write it to a scratch JSON file.
   **Adaptive form layout.** Prefer to OMIT `tabs` (or set `"layout": "auto"`) so the
   kernel's `planFormLayout` groups/labels the fields for you (Summary / Details /
   Classification, Memo full-width at the bottom, two-column when there are enough
   fields). Only give explicit `tabs` (with `sections.fields`) when the maker wants a
   specific structure — set `"layout": "explicit"` or just provide `tabs`. Optionally
   pass `"purpose"` (e.g. `"tracking"`, `"catalog"`) to bias the grouping.
   **Charts (auto-suggest).** For each **Choice** column on the app's primary entity,
   propose one chart in `charts[]` named `<Entity> by <Choice>` (alternate Pie / Column),
   e.g. `{ "entity": "new_ticket", "name": "Tickets by Priority", "groupBy":
   "new_priority", "measure": "count", "chartType": "Pie" }`. The maker confirms,
   edits, or removes them before build — nothing is created without confirmation.
   **Related sub-grids.** To show child records on a parent form, declare
   `form.subgrids: [{ "childEntity": "new_comment", "view": "Active Comments",
   "label": "Comments" }]`. There must be a OneToMany relationship whose `referenced`
   is the form's entity and `referencing` is `childEntity`; the builder derives the
   relationship and resolves the child view id (defaults to the child's first view if
   `view` is omitted) and places the sub-grid on a Related tab.
   **Sample/test data (only if the user asks for it):** add a `sampleData` block
   keyed by entity schemaName, e.g. `"sampleData": { "new_ticket": [ { "new_name":
   "...", "new_priority": "High" } ] }`. Write Choice values as their **labels**
   ("High") — the builder resolves them to the option ints. For **relational** data,
   give a child record a `"$parent": { "entity": "new_customer", "match": { "new_name":
   "Northwind Traders" } }` — the builder inserts parents first and binds the lookup.
   See `samples/app-spec.support-tickets.json` (flat) and
   `samples/app-spec.support-desk.json` (relational Customer → Tickets → Comments with
   sub-grids + charts) for full examples. Sample data is inserted only with
   `--sample-data`.
4. **Review gate.** Show the App Spec and the build **plan**:
   `node scripts/build-model-app.js --env <url> --spec @spec.json` (no `--apply` =
   dry-run; it prints the ordered plan and writes nothing). Let the user edit the
   spec. **Nothing is written to Dataverse until they confirm.**
5. **Build.** `node scripts/build-model-app.js --env <url> --spec @spec.json --apply`
   (add `--publish` to publish customizations, `--sample-data` to insert the
   spec's `sampleData`, `--preview` to open the app/form in the relay). The builder
   is deterministic and scopes everything to a dedicated unmanaged solution. It
   prints numbered `[n/total] <step>` progress lines as it runs — run it so the
   user sees that output live (publishing can take 1-2 min and is the slow step).
6. **Verify.** Open the app; iterate on the spec and re-run.

## What the builder does (in order)

solution → tables + columns (`dv-*` scripts) → relationships → **publish entities**
→ **sample data** (opt-in `--sample-data`, relational/topological + `$parent` binds)
→ **views** (kernel `buildView` → `savedquery`) → **charts** (kernel `buildChart` →
`savedqueryvisualization`) → **forms** (kernel `buildForm` with adaptive layout +
sub-grids → PATCH the system form) → app module + sitemap (kernel `buildSitemap` →
`appmodule` / `sitemap` / `AddAppComponents`, components include charts: type 59) →
publish (opt-in `--publish`). Views and charts build **before** forms so a parent
form's sub-grid can reference the child view id. Each phase emits a `[n/total]`
progress line.

## Notes & limits

- **Dedicated unmanaged solution per app** (review / teardown). **Publish and
  preview are opt-in** (`--publish` / `--preview`); the builder never publishes by
  accident.
- **Creates, does not update.** Updating an existing app (diffing a spec against a
  deployed app) is a later increment; a name/schema collision stops with a clear
  message.
- The kernel produces designer-fidelity FormXML by reusing the form designer's own
  serializer headlessly — no browser needed for the build. The relay is only the
  optional `--preview`.
- Not in scope (later phases): quick-create / quick-view forms, lookup/associated
  views, multi-area sitemaps, security roles, business rules. (Adaptive main forms,
  related-record sub-grids, and Choice-column charts are supported.)
