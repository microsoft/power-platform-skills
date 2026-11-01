# App Spec — advanced / conditional fields

The situational half of the App Spec contract. [`app-spec-schema.md`](./app-spec-schema.md) is
the document to read first and covers everything an app always has — tables, columns,
relationships, views, forms, the app shell, pages, personas, sample data and AI features.

Everything here is **optional**: a spec that uses none of these fields is complete and valid.
They were split out because that document is read in full at the start of every authoring run,
and ~24% of it described features most apps never use.

> **You still need to know these exist.** The capability list in the `/app-builder` skill body
> and the pointer table in `app-spec-schema.md` both name every field below, with guidance on
> when to reach for it. Read this file once your design calls for one of them — not before, and
> not never.
## globalChoices[] (optional — shared option sets)
```jsonc
[ { "name": "new_priority", "displayName": "Priority", "options": ["Low","Medium","High"] } ]
```
Reference from a column via `"globalChoice": "new_priority"` (built before the columns that bind it).
- **`existing`** *(optional, download-emitted)* — `true` on a set **download** declared: an option set
  is org-wide and may be shared with other apps, and a download cannot prove this app created it. The
  build still creates it if missing (reuses it if present); teardown **retains** it, exactly as it
  retains an `existing: true` table.

## webResources[] (optional — client-side logic)

```jsonc
[ { "name": "new_ticket.js", "displayName": "Ticket Scripts", "type": "js",
    "content": "var Ticket={onLoad:function(ctx){},onPriority:function(ctx){}};" } ]
```
- `type`: `js · html · css · xml · png · jpg · gif · svg · ico · xsl · resx` (script web resources
  should be named with a `.js` extension).
- Source comes from **one** of: `content` (inline text), `contentPath` (a file read relative to the
  app folder at build time), or `contentBase64` (for binary types).
- `contentPath` must name a regular file inside the app folder. Absolute, rooted,
  drive-relative and alternate-stream paths, parent escapes, symlinks and junctions are refused.
  The build and `lint-app-spec.js` check the file before anything is written, alongside page
  `codeFile` sources. Inline `content` or `contentBase64` takes precedence, so a `contentPath`
  beside it is never read and not checked. Teardown reads no source, so a spec with an older
  unconfined path can still be torn down.
- Built **before** forms and added to the solution; reference one from a form `events[]` handler.
- **Content edits are NOT applied on rebuild.** Like commands, the phase is discover-then-skip: a web
  resource that already exists is reused as-is, so changing `content` and rebuilding deploys nothing
  and the old script keeps running. The build says so: it compares the deployed content with the spec's,
  and when they differ its line reads `(exists — reuse; its deployed content differs from the spec's …)`
  and a warning names the web resource; verify fails its `web-resource` check for the same reason (an
  `external` entry is checked only for existence). Delete the web resource (or tear down) and rebuild to change it —
  note it cannot be deleted while a command or form handler still references it.
- **`reconcile: "declared"`** *(optional; needs `minimumPluginVersion: "2.21.0"`)* — the build keeps this
  web resource's content in step with the spec: a rebuild compares the published content with the
  spec's and, when they differ, writes the spec's content to the same row, publishes it and reads it
  back. When the row already exists and its content differs, the build stops at it before writing and
  names the approval `--authorize adopt:webresource:<web resource name>`, with the row's id and the components the
  platform reports as depending on it (a script loaded by a computed or relative path is not listed);
  run the build again with that key to write it. The key is typed: a view's or chart's
  `adopt:<table>/<name>` never approves a web resource, even one whose name is the same text. A spec that
  empties the content of a web resource that has content also needs `--allow-destructive`, which the
  adoption approval does not imply; the halt names it. A row whose content already matches needs no
  approval. A declared web resource that is refused, whose write is not confirmed, or that cannot join
  the app's solution stops the build at once; it is not retried automatically. Its name must be its own:
  validation refuses a declared web resource when another entry's name differs from it only in letter case
  (Dataverse matches web resource names without regard to case, so both would be one row). Not allowed with
  `external: true`. Verify fails a declared web resource whose deployed content differs and says to
  run the build again.
- **An unconfirmed first write is different from an ordinary content edit.** A
  `WEB_RESOURCE_UNVERIFIED` halt names the existing row; it does not mean the resource was lost.
  Keep the same writable build workspace and run the full build again after resolving the cause:
  its recovery record makes the build write the content again by that id, publish it, verify the
  published content, and finish adding it to the solution. Do not delete or rename it to retry.
  A conflicting name/id or an unwritable recovery record needs the explicit resolution in the halt.
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
  all, and that is the common case rather than an edge case. **Production environments are the
  other common case**: they declare the member but have it switched off, so the first rule fails
  with HTTP 400 `0x80040216` ("An unexpected error occurred.") whatever the rule says, and nothing is
  created — a platform limit, not a fault in the rule. In both cases the build
  **skips** `businessRules[]`, warns once (naming the member or the code), and builds everything
  else normally — so you get a working app without the rules, not a half-built one. A 400
  `0x80040216` is read this way only for the first rule of a build, and only when a read right
  after it finds no new definition of that rule (the platform can also save a rule and then fail
  with the same answer). Otherwise — a new definition, a rule created earlier in the build, or any
  other code or status — the build halts as before. `--verify` will report those
  rules as not applicable on this environment, which is the truth.
- **Same-name definitions are not automatically disposable.** Rebuild reuses the oldest matching
  definition and keeps additional pre-existing ids with a warning. After a create, the SDK's returned
  definition is kept. Every other same-name id is reported as not attributable to this run, including
  ids that appeared concurrently; a snapshot delta never authorizes deactivation or deletion.
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
- **A rule is validated against the designer's own completeness rules before it is written.** The
  push cannot tell you a rule is wrong — a condition tree in an unexpected shape is ignored by the
  serializer and written as a rule with no clauses and no actions, which returns 204, activates, and
  never fires. The build runs the same validator the business-rule designer gates its Save button on
  and **halts** with its findings. Nothing this schema allows is rejected by it; if you hit it, the
  rule genuinely would not have worked.
- **Rebuild behaviour is additive** — a rule is matched by `(entity, name)` and reused if present;
  edits are **not** re-applied. Recreate the rule to change it.

## businessProcessFlows[] (optional — guided, staged process on a table)

A BPF is the stage bar across the top of a record: an ordered set of stages, each with steps the user
works through.

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
  the table**, and the `new_` prefix is fixed regardless of your `publisherPrefix` — and activation
  creates a backing table with that name, so `"Ticket Handling"` on two
  different tables (or `"Ticket Handling"` and `"ticket-handling"` on one) cannot both deploy.
  Validation rejects the collision and names the derived value; rename one, e.g.
  `"Ticket Handling (Cases)"`.
- **The derived name is a TABLE name, so it also collides with your tables.** A flow named
  `"Ticket"` derives `new_ticket`; if the spec declares a table `new_ticket`, the flow cannot
  deploy — and because the prefix is always `new_`, this is easy to hit on a spec using the default
  `new` publisher prefix. Validation rejects that too, naming both. A collision the spec cannot see
  (a rename between builds that preserves the derived name, or a flow — or a table — already in the
  environment) is caught at build time by a probe that checks both `workflows` and table metadata,
  and **halts** naming whichever owns the name rather than letting the create fail with a platform
  error about a table you never mentioned. The probe is best-effort — if it cannot run, the build
  proceeds.
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
  models cross-entity stages, branching and stage actions; keys carrying them are **rejected** at
  flow, stage **and** step level (the allowed keys are `name`/`entity`/`description`/`status`/
  `order`/`stages`/`securityRoles` — the last is covered in its own section below; per stage
  `name`/`entity`/`steps`; per step `name`/`field`/`required`). The rejection is an allow-list rather than a list of known-bad names
  because the SDK's own normalizers silently discard any key they do not copy — so an unguarded
  `branch` on a stage, or `fieldLogicalName` instead of `field` on a step, would validate clean and
  deploy as though it had never been written. Configure those in Maker after the flow deploys.
- **Activation creates a backing table** (an org-owned table named after the flow's unique name)
  that the platform manages. Teardown deactivates and deletes the flow, which removes it.
- **Rebuild behaviour is additive for the flow, with the stage edits that cannot move a record applied** — a
  flow is matched by `(entity, name)` and reused if present; its Active/Draft **state** is converged, and its
  stages and steps are compared with the spec's by name. These edits are applied **in place, in one push**,
  and every stage and step keeps its id, so no record leaves the stage it is on: a stage added (anywhere) or
  renamed, and a step added, renamed, rebound to another `field`, made `required` or optional, or moved. These
  are **refused**: no stage or step edit is applied (none of the safe ones either), with a warning that says why
  and what to do, and says "No stage or step edits were applied; the requested Active/Draft state is handled
  independently." The state is not a stage edit: it is still converged, so a flow the spec asks to be Draft is
  deactivated all the same. Refused: a stage or a step the flow has and the spec does not
  list (a build never removes one — a record may sit on that stage, and the platform does not document what
  becomes of it; it also cannot tell a spec that dropped it from a maker who added it in Maker), the same
  stages in another order, a stage replaced by a different number of stages (a rename cannot be told from a
  removal), and names that cannot be told apart. To go ahead with one of those, make the change in Maker
  (move or finish the records on a stage before removing it) or delete and recreate the flow (which deletes
  its backing table and the records in it). The SDK limits an advanced flow **per container**, not as a whole: it
  refuses (before any request) to add, remove or reorder the stages of a flow whose primary composite holds something that is
  not a stage — a branch, say — and to add, remove or move the steps of a stage that also holds something that is not a
  step, such as a stage action. A stage action does not stop a stage being added, and a rename or a rebind keeps what the
  SDK does not model. An edit the SDK refuses is reported as not applied on the same terms.
  The flow's own `description` and `order` are not reapplied, and `--verify` does not compare stages.
- Verified by `--verify` on three axes: it exists, there is exactly **one** of it (duplicates would
  offer users the same process twice), and its deployed state matches `status`.

## dashboards[] (optional — chart/list/iframe/web-resource tiles)
```jsonc
{ "name": "Operations", "description": "Daily queue health for the support lead.", "tiles": [
  { "type": "chart", "chart": "Orders by Status", "view": "Active Orders" },  // chart needs both
  { "type": "list",  "view": "Active Orders", "name": "Recent" },             // list needs a view
  { "type": "iframe", "url": "https://…", "name": "Map", "colspan": 2, "rowspan": 8 },  // optional size
  { "type": "webresource", "webResource": "new_widget.html", "name": "Widget" } ] }
```
- A **chart** tile needs both a declared `chart` (the visualization) **and** a declared `view` (its
  data); a **list** tile needs a declared `view`. The target entity is derived from the view. `name`
  defaults to the chart/view name.
- **Size (`colspan`/`rowspan`, optional): 1 column by 12 rows unless set.** A tile's height is its
  `rowspan`, and the app draws a one-row tile as its title bar alone — no chart, no list — so give a
  tile `rowspan: 1` only when it should be that thin. The grid is two columns wide and fills in tile
  order, left to right: two `colspan: 1` tiles share a row, `colspan: 2` takes the full width (a list
  with several columns), a tile too wide for what is left of a row starts the next one, and a
  `colspan` above 2 is narrowed to 2. The platform's own dashboards give charts and lists 9 to 24
  rows, most often 12, which is why 12 is the default. A rebuild reuses a dashboard that exists and
  never resizes its tiles, so one an earlier version built keeps its one-row tiles until it is
  created again under a new `name` or its tiles are resized in the dashboard designer.
- **View and chart names are unique only per table.** When the tile's view name is declared on more
  than one table, set the tile's `entity` to say which; the chart must be declared on that **same**
  table. Both are rejected at the spec gate otherwise — a same-named chart on another table would
  plot a different table's data over this view.
- **Dashboard names must be unique**, compared the way Dataverse compares them: ignoring case,
  accents, full/half width and trailing spaces (`Overview`, `OVERVIEW `, `Café`/`Cafe`) — but not a
  leading space, and not a vowel sign in scripts where it is a letter. A sitemap subarea names a
  dashboard, and a rebuild finds it by name unless the spec pins its id (below), so two names that
  compare equal would collapse into one. A download **withholds** such a pair and says why, rather
  than emit a spec that cannot be rebuilt: rename one in Maker and download again. Because a name can
  also match **another app's** dashboard, ownership comes from the app's solution, which holds every
  dashboard the build creates (one the build cannot add to it is removed again, or named in the halt
  when that fails too; one a build created and then stopped before adding is added by the next build,
  which finds it by the id it recorded in its workspace before the create). When several in the
  environment match, the build reuses — and verify checks, its sitemap entry included — the one the
  solution holds, and halts if that does not single one out; a single match is used as it is. Teardown
  deletes only the ones the solution holds, never a namesake, and none when the spec has no real
  solution to ask (`Default`) or that solution is already gone.
- Built after views/charts (it references their ids). The dashboard is **global** (not entity-scoped)
  and added to the solution. To surface it in the app nav, add a `dashboard` sitemap subarea (below) —
  that also auto-pins it as an app component.
- **`dashboardId` (optional — what a download writes).** A downloaded spec carries each dashboard's
  deployed id (bare GUID, environment-specific, like `pages[].pageId`); leave it out of an authored
  spec. A rebuild binds to that dashboard **before** trying the name, so one renamed in the designer
  since the download is reused — a build never renames an existing dashboard, so it warns and names
  the new name to put in the spec — instead of a second dashboard being created under the old name
  and the nav entry pointed at it. In an environment without that id (the spec was downloaded
  elsewhere) the name is used as usual. Verify and teardown resolve the pin the same way — when it
  resolves it is the only candidate — and teardown still deletes only a dashboard the app's solution
  holds.
- **ID-passthrough tiles (what a download emits).** A tile may instead carry the *deployed* ids —
  `viewId` (+ `visualizationId` for a chart) and the target `entity` — with no `chart`/`view` name.
  That form binds to artifacts that **already exist**, which is what a downloaded app needs: its
  views and charts are not reconstructed into `views[]`/`charts[]`, so a name could not resolve.
  An id-based chart tile needs `viewId` **and** `entity` (a visualization with no view has nothing
  to plot); an id-based list tile needs `viewId` and `entity`. Author specs by name; let downloads
  use ids.
- **A tile a custom control hosts is not expressible.** A grid or chart that a custom control hosts (the
  Power Apps grid, say) reads like a native tile, but the spec describes only the four tile types
  above. A download leaves such a tile out and names it in a warning — it never emits the plain grid or
  chart its parameters describe, which would replace the control wherever the dashboard is created from
  the spec. A rebuild into the environment the spec was downloaded from keeps the dashboard as it is
  (a build never edits an existing dashboard's tiles), so the control stays; in another environment the
  dashboard is created without that tile, and the tile is added there in Maker. `--verify` leaves such a tile
  alone too: it holds only a native chart tile to a chart and view of its table. A dashboard whose only
  tiles are such tiles is dropped with its navigation entry, which the download refuses without
  `--allow-lossy-download`.

## roleGrants[] (optional — extend a role you did NOT author)

Adds privileges for a table to a security role that **already exists** — typically the roles an
existing solution ships. Use it when you add a table to an app whose access model somebody else owns:
without it the table, its forms and its navigation deploy while every non-admin persona still cannot
open the table, and nothing reports it. (Lint now does: a new table that no persona job and no
`roleGrants[]` entry grants a privilege on is a "no access declared" warning, and a grant that covers it
satisfies the check.) A grant is about **tables**: it does not associate the role with the app, and a
spec with no `personas[]` leaves the roles an existing app has as they are — `write-app-spec-doc.js
--env` lists them.

```jsonc
"roleGrants": [
  {
    // Name the EXISTING role. Either `role` (display name) or `roleId` (GUID) — never both.
    "role": "Contoso PM - Project Manager",
    "businessUnitId": "…",                 // optional; scopes the NAME lookup (defaults to the org root BU)
    "privileges": [
      { "entity": "contoso_projectbaseline",
        "access": ["create", "read", "write", "delete", "append", "appendTo", "assign", "share"],
        "scope": "organization" }
    ]
  },
  { "role": "Contoso PM - Viewer",
    "privileges": [ { "entity": "contoso_projectbaseline", "access": ["read"], "scope": "organization" } ] }
]
```

**How it differs from `personas[]` — and why both exist.** A persona role is **converged**: the build
applies it with `ReplacePrivilegesRole`, so every privilege not in the spec is **removed**. That is
right for a role the spec created and catastrophic for one it did not — pointing a persona at an
existing role to add one table would silently strip everything else that role held. A `roleGrant`
compiles to `AddPrivilegesRole` instead, which is purely **additive**: it re-asserts what you declare
and leaves everything else alone.

| | `personas[]` | `roleGrants[]` |
|---|---|---|
| Owns the role | yes (creates it, SDK-marked) | no — the role already exists |
| Semantics | converges (replace) | adds only |
| Can revoke | yes, by dropping the privilege | **no** — see below |
| Managed role | refused (fail-closed conflict) | allowed |
| Teardown | deletes the role | does nothing |

**A grant is one-way.** Dropping an entry from `roleGrants[]` does **not** revoke the privilege, and
`teardown` never removes one. `AddPrivilegesRole` does not record who added what, so a revoke could not
tell a privilege this spec granted from one the role already held (or one a second spec granted) —
stripping the latter is exactly the outcome this surface exists to avoid. **Revoke in Maker.**

**Field reference**
- `role` **or** `roleId` (**required**, exactly one) — the existing role's display name, or its GUID. Setting both is rejected: they can disagree and only one can be honoured.
- `businessUnitId` (optional GUID) — scopes a lookup by `role` name. Rejected alongside `roleId`, where nothing would consult it.
- `privileges[]` (**required**, ≥1) — identical shape to a persona's: `{ entity, access[], scope? }`. `scope` reaches Dataverse intact as the privilege `Depth`.
- `description` (optional) — a note for readers of the spec; never written to Dataverse.

**Resolution fails closed.** Granting on the wrong role is a silent access-control defect no later
phase would catch, so every ambiguity is a **build halt**, never a skip: a name that matches no role,
a name that matches more than one role in the business unit, a stale pinned `roleId`, or a business
unit that cannot be resolved (a name-only fallback could grant on a same-named role in a *different*
business unit). Unlike the persona path this does **not** require the SDK ownership marker, and a
`ismanaged` role is allowed — extending a solution's shipped roles is the point.

**Validation rules** (`validateAppSpec`): exactly one of `role` / `roleId`; GUID shapes; a non-empty
`privileges[]` with valid `access` / `scope` tokens; **one entry per role** (two entries could request
conflicting depths for a shared Dataverse privilege — the SDK only detects that *within* one call, so
a split would let both writes through and the later would silently win); and a role that is **also a
persona in this spec** is rejected, because the persona pass would converge the grant away on the next
build. The apply-time metadata guards (a table that exposes no such access; two tables sharing one
`prv*` at different depths) surface as a build halt with the SDK's own message.

**Verification.** `verify-model-app` proves the role exists (`role-grant`) and — when the reader
supplies privilege access — that it actually **holds** every granted privilege at at least the declared
depth (`role-grant-privileges`). This matters more here than for a persona: a persona role's existence
implies its content (it was converged), whereas a grant is additive onto a role that existed before and
still exists whether or not the privileges landed. Subset semantics again — the role's other privileges
belong to somebody else and are never a finding.

## businessProcessFlows[].securityRoles — who may run a flow

Same shape and same persona idiom as `forms[].securityRoles`, so there is one thing to learn:

```jsonc
{ "name": "Ticket Handling", "entity": "contoso_ticket", "status": "Active",
  "securityRoles": { "personas": ["Dispatcher"] },
  "stages": [ /* … */ ] }
```

The **mechanic** is different, though, and it explains every rule below. A form's roles live inside
its formxml. A flow's live on a **table**: activating a flow makes the platform create an
organization-owned backing table, and holding privileges on that table is what lets a persona run the
process. Three things measured live before this surface was designed:

- the backing table's logical name is the flow's **deployed `uniquename`**, which the build **reads
  back** rather than deriving. For a flow this build creates the derivation is correct by
  construction, but a flow authored in Maker — or one renamed after creation — keeps a unique name
  unrelated to its display name, and granting on the derivation would target a table that does not
  exist, or an unrelated one that happens to hold that name. The plan can still *name* the derived
  table before the flow exists; the grant uses the value read at build time;
- the table is organization-owned and **every privilege is Global-only** — so there is **no `scope`**
  to author, because the platform accepts no other depth;
- the access granted is fixed at `create`, `read`, `write`, `delete` — a partial set produces a flow a
  user can see but not advance.

**Rejected rather than ignored**
- `everyone`, `fallbackForm`, `order` — formxml concepts with no equivalent here. The error says so
  rather than just listing allowed keys, because an author who wrote them learned them from `forms[]`.
- an **empty** `personas[]` — unlike a form (offered to everyone until restricted), a flow's backing
  table grants to nobody by default, so an empty list is a request that cannot be satisfied.
- `securityRoles` on a **Draft** flow — the backing table is created by *activation*, so there is
  nothing to grant on yet.

Applied in the **security** phase, after `personas[]` roles exist. If the flow was not built in the
same invocation the grant is **skipped with a stated reason**, never applied blind.
`verify-model-app` proves each persona holds the privileges on the backing table (`bpf-roles`) and
fails closed when that table cannot be read — which also catches a flow that never activated.
Teardown plans nothing: measured, the flow (and with it the backing table and its privileges) is
deleted before the roles, and the run completes with 0 failures.

## fieldSecurityProfiles[] (optional — confidential columns: `isSecured` and who may read or change them)

Reach for these when the design names a value only some people may see or change: a salary, a
medical note, a national identifier, a private comment. Needs `minimumPluginVersion: "2.21.0"`.

```jsonc
// on the column (any type except Customer)
{ "schemaName": "new_salary", "displayName": "Salary", "type": "Money", "isSecured": true }
// top level
"fieldSecurityProfiles": [
  { "key": "hr", "name": "HR Confidential", "description": "Read and update salary",
    "permissions": [ { "table": "new_employee", "column": "new_salary", "read": true, "update": true } ],
    "assignTo": { "teams": ["<team id>"], "users": ["<user id>"] } }
]
```

- **`isSecured: true`** turns on column security: from then on, only a user given a profile that
  permits it can read or change the value. Omitted: a new column is not secured, and an existing
  column is left as it is. The build creates a secured column after its table (Dataverse does not
  take one inside the table's create) and before any sample row, so no value is written into an open
  column; it refuses to seed a column the spec declares secured while the environment still holds it
  unsecured.
- **`isSecured: false`** on a column that is secured removes the security **and deletes every
  permission any profile holds on that column**. The build refuses it unless the run consents with
  `--authorize isSecured:<table>.<column>`. Never write `false` merely to mean "not secured" — omit it.
- **A profile** has a `key` (stable and unique in the spec), a `name` (at most 100 characters; the
  build finds the profile by this name), an optional `description`, and `permissions[]`: one per
  column, each `{ "table", "column", "read"?, "create"?, "update"? }`, an omitted permission being
  `false`. Every column a permission names must be secured. Read-unmasked access is not authored, and
  the platform's System Administrator profile is never changed. A profile that already exists with
  other permissions stops the build (`FIELD_SECURITY_PROFILE_DIFFERS`) rather than widening or
  narrowing someone else's access: change it in Power Apps, or give your profile another name.
- **`assignTo`** names the users (`systemuserid`) and teams (`teamid`) to give the profile to. It is
  explicit and additive: the build gives the profile to those it names and takes it from no one. It
  never derives a user from a persona or a security role, and a security role does not open a
  secured column — only a profile does. Omitted means the build gives the profile to no one; the
  plan says *no assignment requested*. Prefer a team to a list of users.
- **When it runs:** profiles and their permissions in the `data-model` phase, after the columns are
  secured; assignments in the `security` phase. A `--stage data` run creates the profiles and lists
  each assignment as **deferred**; the `app` stage gives them.
- **Tell the maker, before the build:**
  - *Administrators are exempt.* A System Administrator reads and changes every secured column
    whatever profiles say, so testing as an administrator proves nothing — test as a user who has
    only the app's role.
  - *Refresh.* A user who already has the app open may need to reload it before a change to their
    access shows.
  - *Least privilege.* Give `read` where people only need to see a value, and `update` only to whoever
    maintains it.
  - *Unsecuring* deletes permissions (above), so it needs its own consent.
- **Rights:** the account running the build needs to customize tables, create field security
  profiles and give them to users and teams (for example, System Administrator).
- **`--verify`** checks that each declared column is stored secured, that each profile holds exactly
  its declared permissions, and that each named user and team holds the profile. These are metadata
  reads made as the build's account; they do not prove what a user without the profile sees.
- **Download** writes `isSecured: true` for a secured column. Profiles and their assignments are not
  downloaded.
- **Teardown** never deletes a profile (users and teams can hold it beyond this app): it keeps each
  declared profile, with its permissions and assignments, and names it as kept, by name only. Remove a
  profile yourself once no one needs it.

## columns[].dateTimeBehavior · option values · table flags (optional — portable schema)

Needs `minimumPluginVersion: "2.21.0"`.

### Fixed option values — `{ "value", "label" }`

```jsonc
"options": [ { "value": 1, "label": "Low" }, { "value": 5, "label": { "1033": "High", "1036": "Haute" } } ]
```

Reach for it when an integration, report, flow or another environment already depends on an option's
**number**. `value` is a whole number from 0 to 2147483647, unique within the set; `label` follows the
usual option-label rules (a global choice's labels stay plain strings). A plain label in the same list
keeps the number of its position (100000000 + index), so mixing the two forms is valid only when every
resulting number is unique. Sample data and view filters may name an option by its number, which is
how to pick between two options that share a label. The build does not renumber or replace the options
of a column that already exists. A download writes `{ "value", "label" }` whenever an option's number
differs from its position's default, and plain labels otherwise.

### Date and Time behaviour — `dateTimeBehavior`

```jsonc
{ "schemaName": "new_renewaldate", "displayName": "Renewal Date", "type": "DateTime", "dateTimeBehavior": "DateOnly" }
```

- `UserLocal` (the default) — stored in UTC and shown in each user's time zone: a timestamp.
- `DateOnly` — a calendar day with no time and no time-zone conversion: a birthday, a due date, a
  renewal date. It implies the DateOnly format, so `dateFormat` may be omitted (`"DateAndTime"` is
  refused).
- `TimeZoneIndependent` — a date and time shown the same to everyone: a site visit at 09:00 site
  time, a hotel check-in.

Omitted: a new column is `UserLocal`, and an existing column is left as it is. Changing the behaviour
of a column that already exists is **one-way** (`DateOnly` and `TimeZoneIndependent` cannot be changed
back) and does **not** convert values already stored, so the build refuses it unless the run consents
with `--authorize dateTimeBehavior:<table>.<column>`; do not change an existing column unless the maker
asks. Declaring `UserLocal` on a column that has no behaviour at all is a repair and needs no consent.
Before it adds a column, lookup or relationship to a table it did not create, the build reads that
table's Date and Time behaviours once, and stops — before sending anything — when a column has none
(`DATETIME_BEHAVIOR_MISSING`) or the read is not conclusive (`DATETIME_BEHAVIOR_UNVERIFIED`); the halt
says how to fix it.

### Table flags — `searchEnabled`, `changeTrackingEnabled`, `duplicateDetectionEnabled`

```jsonc
{ "schemaName": "new_ticket", "displayName": "Ticket", "pluralName": "Tickets",
  "searchEnabled": true, "changeTrackingEnabled": true, "duplicateDetectionEnabled": true, "columns": [] }
```

Set a flag only when the maker asks for what it does; omitted leaves the table as it is.

- `searchEnabled` puts the table in Dataverse search (`false` takes it out, which needs no consent:
  turning it on again restores it once the table is indexed again). `true` also turns on change
  tracking, which can never be turned off, so the spec must say `changeTrackingEnabled: true` too. A
  table that does not allow search is refused.
- `changeTrackingEnabled` can only be `true`.
- `duplicateDetectionEnabled: false` on a table that has it on unpublishes every duplicate detection
  rule of the table, and turning it on again does not republish them, so the build refuses it unless
  the run consents with `--authorize tableFlags:<table>`.

### Consent — `--authorize <key>`

Repeatable, one key per change: `dateTimeBehavior:<table>.<column>`, `isSecured:<table>.<column>`,
`tableFlags:<table>`, and `<kind>:<key>:<field>` for a configuration item (`references/app-spec-schema.md` →
*Configuration items*). A key consents to exactly the change the spec declares for it and to nothing
else; a key for a change the spec does not declare stops the build. `--allow-destructive` does not
imply it. A refused change names the key to use, so read what the change does, then run the build
again with it.

### Download and verify

A download always writes option values (as above) and `isSecured`. `--include-capabilities` also reads
each table's Date and Time behaviours and flags (one read each per table) and writes the ones that
differ from what a build creates by default; a read that fails, or an answer that does not state a
column's behaviour or a flag, is left out and named in a warning, never taken as the default. Without
it, a download makes the reads it always made. A spec that carries any of these fields gets
`minimumPluginVersion: "2.21.0"`. `--verify` checks each declared value against a fresh read, and
reports what it could not read as unverified, never as a pass.

**Not yet supported** (tracked follow-up): access teams / hierarchy security.

## views[].reconcile · charts[].reconcile · entities[].quickFind (optional — declared views and charts, Quick Find)

Requires `minimumPluginVersion: "2.21.0"`. A spec without these fields builds exactly as before: a view
or chart without `reconcile` is created when missing and, on a rebuild, an existing view only gains the
spec's new columns.

```jsonc
{ "entity": "new_ticket", "name": "Open Tickets", "reconcile": "declared",
  "columns": ["new_name", { "name": "name", "relatedEntity": "acct", "width": 150 }],
  "linkEntities": [{ "name": "account", "from": "accountid", "to": "new_accountid", "alias": "acct", "linkType": "outer" }],
  "sort": [{ "attr": "new_name", "dir": "asc" }] }
```

- **`views[].reconcile: "declared"`** — the build makes the view match the spec: the columns in the
  declared order (an object column names its join in `relatedEntity`), the base filter, sort, joins
  (`linkEntities[]`: `name`, `from`, `to`, optional `alias`, `linkType` `inner`/`outer` and `filters`)
  and the description when set. What the spec does not declare (cell options, the Quick Find filter,
  other joins) is kept. `viewId` pins the view to edit in one environment. A new declared view is
  created and published like any other view. The stock `Active <plural>` and `Inactive <plural>` views
  exist on every table, new ones included, so declaring one of them is an adoption (see Approvals).
- **`charts[].reconcile: "declared"`** — the chart type, category, series and description follow the
  spec. `title` is written only to a chart whose stored layout already has a title; a new chart cannot
  store one, so a declared `title` on a new chart is refused (`chart-title-not-stored`).
- **`entities[].quickFind: { "findColumns": [...] }`** — the columns the table's search box matches on
  (its default Quick Find view). Distinct logical names; an empty list needs `--allow-destructive`. It
  does not need `searchEnabled` or change tracking. `--verify` checks that the view stores exactly this
  list, in order (`quick-find <table>`); a stored search template such as `{0}%` is kept and verifies.
  A changed list is written without any `--authorize` key: `overwrite:quickfind:<table>` approves only
  replacing a local copy that differs from the server's (see Local copy below).

**Approvals.** A view or chart that already exists and that this spec has not created in this run is
shown as an adoption: the build leaves it unchanged, builds the rest, and then stops naming the key —
`--authorize adopt:view:<table>/<name>` or `--authorize adopt:chart:<table>/<name>` (the table in lower
case, the name exactly as in the spec). `--authorize overwrite:view:<table>/<name>` (or `chart:`)
approves replacing changes made elsewhere, and `--allow-destructive` approves removing columns. Each key
approves only the artifact of its family, so a view and a chart with the same name are approved
separately. Within a family a key must name one artifact: two declared views on one table need different
names, and so do two declared charts (a chart's name is compared with its outer spaces trimmed). A
`viewId` pin chooses the row a view edits but is not part of its key, so it does not tell two
same-named declared views apart. A build or a plan refuses such a pair before any work; teardown and
verification only warn. The same name on another table, or on a view and a chart, is fine. The older `adopt:<table>/<name>` form still works when it names exactly one declared view or
chart; a key that could name several, or that names no declared view or chart, stops the build. **Local copy.** A declared view, chart or Quick Find view whose local copy differs from the
server's (an edit an earlier run did not send, or one made by hand), or cannot be compared with it, is
refused before anything is written (`workspace-copy-unsent-edits`); the copy is kept. Put any change
to keep into the spec and refresh the local copy, or approve replacing it with the server's:
the `overwrite:` key the refusal prints (`--authorize overwrite:view:<table>/<name>`,
`overwrite:chart:<table>/<name>`, or `overwrite:quickfind:<table>` for a table's Quick Find). **Publishing.** A table is published only when every declared change on it succeeded: when one
fails, the build reports the table as withheld, publishes the other tables, and exits non-zero.

Declared upkeep of web resources is described with `webResources[]` above. Declared process flows,
dashboards, business rules and form layouts are not reconciled in this release: `reconcile` on a form,
dashboard, business rule or flow is a validation error, and the build's existing behaviour for each is
unchanged. A command bar with `commands[].key` is refused (`managed-binding-port-unavailable`) in this version.

## createIdentity (optional — stable create ids for declared views and charts)

Requires `minimumPluginVersion: "2.21.0"`. Write it on a **new** app only; never add it to an existing or
downloaded spec. The only value is `"stable-v1"`; any other value is a validation error
(`create-identity-invalid`), and a spec without the field builds exactly as before.

```jsonc
{ "minimumPluginVersion": "2.21.0", "createIdentity": "stable-v1",
  "views": [{ "entity": "new_ticket", "name": "Open Tickets", "reconcile": "declared", "columns": ["new_name"] }] }
```

- **What gets a stable id.** A declared view or chart (`reconcile: "declared"`) is created with an id
  the spec fixes (from the solution, the table and the name). A build that lost the answer to its
  create, run again from the same or a fresh workspace, finds the row at that id and binds it instead
  of creating a second one. Every other kind (configuration items, custom APIs, environment variables,
  field security, duplicate rules, pages, legacy views and charts) keeps today's ids.
- **Where the binding is kept.** In the build workspace, one file per environment, app and solution
  (`managed-bindings.<hash>.json`). It holds ids, hashes and the state of each change (for a change
  not yet proved, the content it expects the row to hold); never credentials. Keep it with the build
  workspace: it is the record of changes not yet proved and of publishes not yet confirmed. A file the
  build cannot trust stops the build before any write (`managed-binding-store-unreadable`). Keep it as
  it is. Never put back an older copy — a backup or a version-control copy, the build's own included,
  can miss a change or a publish sent after it was made, and a build from it could publish that change
  unproved. Only a copy known to hold the file's latest content may take its place; when that cannot be
  known, keep the file and the workspace as they are and do not build, edit or tear down the app from them.
- **Adoption.** A row found at its id that this workspace never bound — including one equal to the
  spec, and one left by a create whose answer was lost — is bound only with
  `--authorize adopt:view:<table>/<name>` (or `adopt:chart:<table>/<name>`). Without it nothing is
  written and the row stays unbound.
- **A change not yet proved** holds its table's publish. The next build proves it against the content
  it recorded before the send, never against the current declaration: a change proved unsent is sent
  again; a row that holds the recorded content is bound; a row that differs stays held until the
  original declaration is built again or the row is put back. This holds for a removed declaration too:
  the build proves it by its recorded content (with the adoption approval when the create was never
  acknowledged), and removing a declaration never releases the hold — keep `createIdentity` set. A
  publish whose outcome was lost is confirmed by a fresh read, never sent again.
- **Local copy.** A local copy at the id with an edit the server has not seen, or a local create that
  was never acknowledged, stops that view or chart before anything is fetched over, reapplied or sent
  (`create-completion-required`); the copy is kept byte for byte, and running again stops again. There is
  no `overwrite:` approval for this stop: put the change into the spec, then refresh the local copy. The
  build never removes a local draft, not even its own: a create that was refused or lost its answer keeps
  the draft it made and stops with `create-local-draft-kept`, and the next build stops as above. Its
  change is still pending, and it is proved only against the declaration it was prepared from, so settle
  it in this order (a changed declaration first stops with `create-completion-required` and keeps it
  pending):
  1. keep the change you want — from the local draft or from the spec — somewhere apart;
  2. keep the spec's declaration of that view or chart as it was, or put it back;
  3. discard only the local copy: the maker SDK's local discard (`deleteArtifact`) or a refresh of the
     local copy. It removes nothing on the service and leaves the binding store as it is;
  4. build again with the original declaration (with `--authorize adopt:view:<table>/<name>` or
     `adopt:chart:…` if the build asks for it); it finds the row on the server, or sends the same create
     again when nothing of it was sent;
  5. then put your change into the spec and build again.

  The create request is checked just before it is sent: if it is not exactly the create of the draft
  the build made (a name or description edited meanwhile, even by another process), or the push turns
  into any other write of that row (an update, or a batch that touches it), nothing is sent and the
  build stops with `create-local-draft-changed`.
- **Publishing.** A create whose answer was lost holds its table's publish until a later build has
  found and bound the row; another table still publishes. While a change is not yet proved, page edits
  that publish the app (`genpage.js` add-to-app and remove-from-app, `genpage-upload.js --app-id`) are
  refused with `publication-withheld`, and a teardown leaves that table's publish unsent, with a warning.
  A page edit makes that check under the app's build and pages leases, so it is refused with
  `build-locked` while a build of the app runs in the same workspace; run it again once the build ends.
- **`--verify`** reads each bound view or chart by its id. A binding whose create is not yet settled, or
  a file it cannot read, is reported as unverified, never as a pass.