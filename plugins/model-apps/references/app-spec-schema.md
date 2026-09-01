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
  "ai":            { /* optional — AI feature flags + row-summary config */ },
  "personas":      [ /* optional — one security role per persona (see below) */ ],
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
- **`languageCode`** *(optional)* — the [LCID](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-lcid/)
  stamped on the Dataverse labels the build creates: data-model labels (table, column, choice, status
  reason, relationship and alternate-key display names) **and** form, dashboard and sitemap labels.
  The serializers used to hardcode 1033 with no caller override
  ([#455](https://github.com/microsoft/power-platform-skills/issues/455)); they now take the
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
  **Emitted by `download-model-app.js` only if you pinned it yourself.** It is deliberately never
  read from Dataverse: an LCID copied out of the source org would be re-applied verbatim when the
  spec is rebuilt somewhere else, which is exactly how a spec starts failing in an org that lacks
  that language. Leaving it absent lets every target org resolve its own base language. But a value
  **you** wrote is carried across a download from the previous `app-spec.json` at that path, so a
  pin is not silently lost — losing it would leave newly created columns in the org default while
  the existing ones keep the pinned language, with no error anywhere.

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
- **Content edits are NOT applied on rebuild.** Like commands, the phase is discover-then-skip: a web
  resource that already exists is reused as-is, so changing `content` and rebuilding deploys nothing
  and the old script keeps running. Delete the web resource (or tear down) and rebuild to change it —
  note it cannot be deleted while a command or form handler still references it.
- **Never hardcode Choice (option-set) values in the script.** Values like `100000003` are assigned
  per publisher, so a literal that is correct in one environment silently selects nothing in another —
  and a `setValue` with an unknown value fails quietly. Resolve by label instead:
  ```js
  function setChoiceByLabel(formCtx, attr, label) {
    var a = formCtx.getAttribute(attr);
    var hit = (a.getOptions() || []).filter(function (o) { return o.text === label; })[0];
    if (hit) { a.setValue(hit.value); }
    return !!hit;
  }
  ```
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
  "description": "Unresolved tickets, most urgent first — the queue agents work from.",
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
  wide/opaque types like MultilineText). This runs by default for every table the build **owns** that
  has extra columns; opt a table out with **`"enrichDefaultViews": false`** on its `entities[]` entry.
  A table marked **`"existing": true`** is skipped by default — enrichment *replaces* a view's column
  set, and `existing` means the build cannot prove it owns the table, so rewriting another app's
  default views is not a safe default. Set **`"enrichDefaultViews": true`** to override that when you
  know the reused table is yours. Author-declared `views[]` are separate and always win.

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

### Per-field control options — `readOnly`, `hidden`, `after`

A form field can carry three per-control options. Declare them **form-level** in `fieldOptions`
(keyed by column logical name) — the only route under an `auto` layout, which has no field list —
or **inline** on an explicit layout's `fields[]` entry as `{ "name": …, "readOnly": …, "hidden": … }`.
Where both apply to one field the inline entry wins; a plain string entry keeps working unchanged.

- **`readOnly: true`** locks the control (`disabled="true"`), leaving it visible. Use it for a value
  the platform generates but does **not** make immutable — an AutoNumber column is writable through
  the API, so "read-only" for it is a form-level statement, not a metadata one.
- **`hidden: true`** places the field as a hidden control (`visible="false"`) — present for form
  scripts and business rules, not shown to the user.
- **`after: "<logical>"`** moves the field so it immediately follows the named anchor. This is the
  **non-destructive** way to reposition one control: it works on an already-deployed form and does
  not require re-declaring the rest of the form. An anchor that is not on the form is ignored.
  Only valid in `fieldOptions` — inside an explicit `tabs` layout the listed order already positions
  the field, so `after` there is rejected rather than silently overriding the list.
  Two anchor shapes are **rejected**, because neither has a satisfiable answer: only **one** field may
  sit immediately after a given anchor (to place several in sequence, *chain* them — anchor the second
  after the first), and anchors may not form a **cycle**.

**Only the enabled state is ever written.** The build emits `readOnly`/`hidden` when you ask for
them and writes *nothing* when you do not, so a rebuild never clears a lock or a hide someone applied
in the form designer. The corollary is that `readOnly: false` / `hidden: false` cannot turn a flag
back off — they are rejected at author time rather than accepted and ignored. To un-set one, clear it
in the designer, or drop the field and let the next build re-add it.

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
- **`order`** *(optional, non-negative integer)* — display order among the entity's forms.
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
  this is what makes it **functional** (not a structural-only button).
- **Your function is handed the record automatically.** The build passes the standard command
  parameters for the button's location, so the usual handler shape works as written:
  ```js
  function escalate(primaryControl) {
    primaryControl.getAttribute('new_priority').setValue(100000003);
    primaryControl.data.save();
  }
  ```
  Defaults by location — `MainTab` → `PrimaryControl`; `ContextualTab` → `SelectedControl`;
  `HomeTab` → `SelectedControl` + `SelectedControlSelectedItemIds`. Override with `parameters`
  (a raw JSON string, e.g. `'[{"type":5,"value":null}]'`); pass `""` for a function that genuinely
  takes no arguments. **Without a parameter the function is invoked with no arguments**, so
  `primaryControl` is `undefined` and the button appears to do nothing — the error is visible only
  in the browser console, and the build, the deployed rows and `--verify` all still look correct.
- **Button edits are not applied on rebuild.** The command phase is discover-then-skip: it creates a
  bar only when none exists. To change a deployed button, delete the entity's commands (or tear down)
  and rebuild.
- **`location`** is `MainTab` (default — the entity form/grid command bar), `HomeTab`, or `ContextualTab`.
- **`hidden`** / **`disabled`** set *static* visibility/enablement. **Conditional (rule-based)
  visibility is not supported** — it's Power Fx-only on modern commands and needs a component library
  that can't be authored headlessly.
- **`type`** is `Button` (default), `FlyoutAnchor`, or `SplitButton`. A flyout/split container holds
  `children[]` (each a button with its own `library`+`function`) instead of an on-click of its own —
  the menu items live under it. Top-level buttons emit as **loose controls**; a *titled* group is not
  supported (it needs a parent command-bar row the SDK doesn't synthesize from scratch). The command
  lands in the Default solution but is entity-scoped, so it shows on the entity's command bar.

## businessRules[] (optional — declarative form logic, no code)

```jsonc
{ "entity": "new_ticket", "name": "Hide notes on closed tickets",
  "description": "Closed tickets are read-only history, so the working fields are hidden.",
  "scope": "Entity",          // only Entity today
  "status": "Active",         // Active (default) | Draft — a Draft rule is deployed but inert
  "conditions": [             // ALL must hold (ANDed); more than one is allowed
    { "field": "new_status", "operator": "Equals", "value": "100000001", "dataType": "Picklist" }
  ],  "actions": [
    { "type": "SetVisibility",       "field": "new_notes",  "visible": false },
    { "type": "LockUnlock",          "field": "new_owner",  "lock": true },
    { "type": "SetBusinessRequired", "field": "new_reason", "required": true },
    { "type": "SetFieldValue",       "field": "new_owner",  "value": "unassigned" }
  ] }
```

- **Environment gate — read this first.** The SDK writes a rule through the bound
  `CreateProcessWithWfomJson` member, the same one the modern business-rule designer uses, and has
  **no fallback**. An environment that does not declare that member cannot host business rules at
  all, and that is the common case rather than an edge case. The build then
  **skips** `businessRules[]`, warns once naming the member, and builds everything else normally —
  so you get a working app without the rules, not a half-built one. `--verify` will report those
  rules as not deployed, which is the truth.
- **Operators**, all of which the SDK's own table defines:
  `Equals` · `DoesNotEqual` · `IsGreaterThan` · `IsGreaterThanEqualTo` · `IsLessThan` ·
  `IsLessThanEqualTo` · `Contains` · `DoesNotContain` · `BeginsWith` · `DoesNotBeginWith` ·
  `EndsWith` · `DoesNotEndWith` · `On` · `NotOn` (all carry a `value`), plus the presence operators
  `ContainsData` · `DoesNotContainData`, which must **not** carry one.
  Mind the spelling: it is `IsGreaterThan`, **not** `GreaterThan`. The SDK resolves an operator it
  does not recognise to **Equals** rather than rejecting it, so a misspelling would deploy, activate,
  and quietly test equality. The spec rejects anything outside the table for exactly that reason, and
  suggests the correct spelling when it can.
- **Actions**: `SetVisibility` (`visible`) · `LockUnlock` (`lock`) · `SetBusinessRequired`
  (`required`) · `SetFieldValue` (`value`). The three boolean payloads must be **real booleans** — a
  string `"false"` is truthy and would invert the intent, so it is rejected.
  The SDK also models `SetDefaultValue`, `ShowErrorMessage` and `Recommendation`. They are not
  exposed yet: each needs mapping that cannot be exercised end to end on an environment without the
  bound member, and shipping unverified mapping is how a rule deploys and does the wrong thing.
- **`conditions[]` are ANDed**, and there may be **more than one** — they are folded with the
  platform's `LogicalAnd`. (An earlier single-condition limit came from a client-side XAML compiler
  that has since been deleted upstream; it was never a platform limit.) `OR` is not exposed.
- **`dataType`** (optional) — accepted values are `String` · `Memo` · `Picklist` · `State` ·
  `Status` · `Boolean` · `Integer` · `Double` · `Decimal` · `Money`.
  **It currently has no effect.** Measured across every accepted value, on both the condition and the
  action path, the SDK types every literal as `String` and never consults this field. It is still
  validated as a closed set so a typo is caught and so the surface stays forward-compatible, but do
  not expect it to change the deployed rule. For a Choice column, give the option's **integer
  value**, not its label — that part matters regardless.
- Every `field` must be a column on the rule's own `entity` (its own columns, its primary name, or a
  lookup a relationship creates). A rule naming a column that does not exist is accepted by the
  platform and then simply **never fires**, so this is validated up front.
- **Rebuild behaviour is additive** — a rule is matched by `(entity, name)` and reused if present;
  edits are **not** re-applied. Recreate the rule to change it.

## businessProcessFlows[] (optional — guided, staged process on a table)

A BPF is the stage bar across the top of a record: an ordered set of stages, each with steps the user
works through. See
[Create a business process flow](https://learn.microsoft.com/en-us/power-automate/create-business-process-flow).

```jsonc
{ "entity": "new_ticket", "name": "Ticket Handling",
  "description": "How support tickets move to resolution",  // optional
  "status": "Active",        // Active (default) | Draft — a Draft flow is deployed but does NOT
                             // appear on the form
  "order": 1,                // optional; the workflow's processorder when several flows apply
  "stages": [
    { "name": "Triage", "steps": [
        { "name": "Subject",  "field": "new_subject", "required": true },
        { "name": "Priority", "field": "new_priority" } ] },
    { "name": "Resolve", "steps": [
        { "name": "Resolution notes", "field": "new_notes" },
        { "name": "Confirmed with customer", "field": "new_confirmed" } ] }
  ] }
```

- **Stages are ordered** (array order) and each needs a unique `name` **and at least one step**; steps
  within a stage need unique names too. `stages[]` is required — a flow with no stage is not a
  process. A stage with no steps is rejected because the SDK substitutes a placeholder step literally
  named *"New Step"*, which would then appear on the stage bar without ever having been authored.
- **A flow's `name` must be unique across the whole spec, not just per table.** The unique name
  Dataverse stores is derived as `new_<name lower-cased, non-alphanumerics stripped>` — it **ignores
  the table** — and activation creates a backing table with that name, so `"Ticket Handling"` on two
  different tables (or `"Ticket Handling"` and `"ticket-handling"` on one) cannot both deploy.
  Validation rejects the collision and names the derived value; rename one, e.g.
  `"Ticket Handling (Cases)"`.
- **Every step must bind a `field`**, and it must be a column on the flow's own `entity` (its own
  columns, its primary name, or a lookup a relationship creates). The platform rejects a step with no
  column outright — `datafieldname of ControlStep cannot be null or empty` — so there is no such
  thing as a field-less "checklist" step; for a manual check-off, bind a Boolean column such as a
  `Confirmed` flag. Like a business rule, the platform *accepts* a step bound to a column that does
  not exist and simply renders it bound to nothing, so the column is validated up front too.
- **At most 30 stages per flow and 30 steps per stage** — ceilings the SDK enforces, checked here so
  an over-large flow is a spec error rather than a failure in a late build phase.
- **`status`** matters more than it does for a rule: an inactive BPF is not merely inert, it is
  **invisible** — the stage bar does not render at all. `Active` is the default for that reason.
- **v1 is single-entity and linear.** Every stage must be on the flow's own `entity`. The SDK also
  models cross-entity stages, branching, stage actions and security-role grants; keys carrying them
  are **rejected** at flow, stage **and** step level (the allowed keys are `name`/`entity`/
  `description`/`status`/`order`/`stages`; per stage `name`/`entity`/`steps`; per step
  `name`/`field`/`required`). The rejection is an allow-list rather than a list of known-bad names
  because the SDK's own normalizers silently discard any key they do not copy — so an unguarded
  `branch` on a stage, or `fieldLogicalName` instead of `field` on a step, would validate clean and
  deploy as though it had never been written. Configure those in Maker after the flow deploys.
- **Activation creates a backing table** (an org-owned table named after the flow's unique name)
  that the platform manages. Teardown deactivates and deletes the flow, which removes it.
- **Rebuild behaviour is additive**, exactly like business rules — a flow is matched by
  `(entity, name)` and reused if present; only its Active/Draft **state** is converged. Stage and
  step edits are **not** re-applied: recreate the flow to change its structure.
- Verified by `--verify` on three axes: it exists, there is exactly **one** of it (duplicates would
  offer users the same process twice), and its deployed state matches `status`.

## dashboards[] (optional — chart/list/iframe/web-resource tiles)
```jsonc
{ "name": "Operations", "description": "Daily queue health for the support lead.", "tiles": [
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
  { "url": "$webresource:new_home.html", "title": "Home" },                        // a declared web resource
  { "page": "overview",       "title": "Overview" }                                // a genpage — KEY (schemaVersion 2)
] } ] } ] }
```
- A subarea names exactly **one** target (lint-enforced): `entity` (a table), `dashboard` (the **name**
  of a `dashboards[]` entry — auto-pinned as an app component so the app includes it), `url`, or
  `page` (the **`key`** of a `pages[]` generative page at schemaVersion 2; the **name** for legacy specs
  — surfaced as a `GenPage` sitemap subarea).
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
  // appFeatures: opt specific AI features in or out for this app (all optional).
  // Values are `true`/`false` (the ergonomic spellings of the underlying numeric settings' 1/0) or an
  // explicit integer between 0 and 1000000 for a platform-defined value — notably `2` = "on for
  // everyone". The bound mirrors the SDK's own, so an out-of-range value is rejected here rather
  // than aborting the build half-applied.
  // These write PER-APP settings, which are distinct from the org-level admin gates the build
  // preflights; a feature whose org gate is off is skipped with a warning and never silently applied.
  "appFeatures": {
    "formFill":  true,   // Copilot-assisted form fill (data entry)
    "nlSearch":  true,   // natural-language grid/view search (data exploration)
    "nlChart":   2,      // natural-language chart / AI data visualization — on for everyone
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
- `ai.appFeatures` keys must be one of `formFill · nlSearch · nlChart · m365`; values must be a boolean or an integer between `0` and `1000000` (hard error) — the same range the SDK enforces, so an out-of-range value is rejected here rather than aborting the build half-applied. `true`/`false` mean the underlying numeric setting's `1`/`0`; use an explicit integer (e.g. `2`) for a platform value like "on for everyone".
- Omitting `ai.appFeatures` does **not** mean "no AI features": a spec carrying any `ai` block gets the defaults `formFill · nlSearch · nlChart` on and `m365` off, and `--verify` reconciles that whole resolved set.
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
security. The security surface today is role-per-persona only.
