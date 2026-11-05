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
- **Button edits in `commands[]` are not applied on rebuild.** The command phase is discover-then-skip: it creates a
  bar only when none exists. To change a deployed button's label, script or other properties, delete the entity's commands (or tear down)
  and rebuild. To only show, hide, enable or disable an existing button, use `commandStates[]` (below).
- **`location`** is `MainTab` (default — the entity form/grid command bar), `HomeTab`, or `ContextualTab`.
- **`hidden`** / **`disabled`** set *static* visibility/enablement. **Conditional (rule-based)
  visibility is not supported** — it's Power Fx-only on modern commands and needs a component library
  that can't be authored headlessly.
- **`type`** is `Button` (default), `FlyoutAnchor`, or `SplitButton`. A flyout/split container holds
  `children[]` (each a button with its own `library`+`function`) instead of an on-click of its own —
  the menu items live under it. Top-level buttons emit as **loose controls**; a *titled* group is not
  supported (it needs a parent command-bar row the SDK doesn't synthesize from scratch). The command
  lands in the Default solution but is entity-scoped, so it shows on the entity's command bar.

### Listing the existing buttons — `list-command-states.js` (read-only)
```bash
node scripts/list-command-states.js --env <envUrl> --app <uniqueName> [--entity <logical>] [--location MainTab|HomeTab|ContextualTab]
```
Prints every modern command button of the app's tables (or of the one `--entity`), each with its
`rowId`, `bar`, `scope` (`table`, `app`, `other-app`), stored `hidden` / `disabled`, and `candidate`.
It only reads; a write flag is a usage error.
- **Pick a button by `rowId`, never by caption.** Two buttons with the same caption on one bar each
  name the other in `sameCaption`; an unlabelled button has `caption: null`.
- **Excluded buttons are listed, not left out**, each with every reason it is not a candidate:
  `shape-unreadable`, `id-mismatch`, `context-not-table`, `context-mismatch`, `table-not-in-app`,
  `location-unsupported`, `location-mismatch`, `app-scoped` (scoped to an app — this one or another — not to its table: only
  table-scoped buttons are candidates in this version), `not-standard-button`
  (a flyout or split container, or a group), `nested` (a menu item), `not-default-origin` (migrated
  or system), `inactive`, `managed`, `not-customizable`, `flags-unreadable`, `visibility-formula`
  (Power Fx visibility or classic rules: `visibilitytype` other than empty or 0, or a visibility-formula field set; the
  empty `visibilitytype` the platform stores on a button `commands[]` wrote is static), `formula-action` (a Power Fx on-select), `version-unavailable` (the
  platform keeps no row versions for commands, or the row has none).
- A bar the App Spec has no name for (a stored location other than 0, 1, 2) is `bar: "unsupported"`.
- **`candidate` describes the row's shape only.** It does not prove the app renders the button, or
  where.
- A failed or incomplete read prints `{ "ok": false, "code": "command-state-…", "error" }` with
  exit 1 — never a shorter list.

## commandStates[] (optional — show or hide existing buttons)
```jsonc
"minimumPluginVersion": "2.24.0",            // required: an older plugin refuses the spec instead of ignoring it
"app": { "uniqueName": "new_support", ... },  // required: the app the buttons are checked against
"commandStates": [
  { "entity": "new_ticket", "location": "MainTab", "scope": "table",
    "rowId": "11111111-1111-4111-8111-111111111111",   // from list-command-states.js — never invented
    "hidden": true },                                  // and/or "disabled": true|false
  { "entity": "new_ticket", "location": "HomeTab", "scope": "table",
    "rowId": "22222222-2222-4222-8222-222222222222", "hidden": false, "disabled": false }
]
```
Sets the stored **hidden** and **disabled** flags of a modern command button that already exists,
picked by its row id. Nothing else about the button changes, and a row is never created.
- **Fields are closed and exact.** `entity` is a table declared in `entities[]`; `location` is exactly
  `MainTab`, `HomeTab` or `ContextualTab` and must be the row's bar; `scope` is exactly `"table"`;
  `rowId` is the lower- or upper-case id `list-command-states.js` prints (no braces, not all zeros), one
  entry per row; set `hidden`, `disabled` or both. A flag you leave out is not read, sent or checked;
  `false` is an instruction, not "unset". An unknown field (for example `isdisabled`) is refused with
  `command-state-spec-invalid`.
- **Table-scoped buttons only.** `scope: "app"` is refused with `command-state-app-scope-unverified`,
  and so is a row that turns out to be scoped to an app.
- **Only candidates are written:** an active, unmanaged, customizable, top-level plain button with no
  Power Fx visibility or on-select formula, on the declared table and bar, that the platform keeps row
  versions for — the listing's `candidate: true`. A button with an empty (null) `visibilitytype` and
  every visibility-formula field empty — what `commands[]` writes — counts as static; the build never
  writes `visibilitytype`.
- **Only a full build with `--publish` applies them.** A partial range, a changed-only fast apply or an
  apply without `--publish` is refused before anything is read (`command-state-phase-unsupported`,
  `command-state-publish-required`); exactly `--stage data` leaves them alone. A spec that also has
  keyed `commands[]` (`key`) is refused (`command-state-keyed-unsupported`), and so is `commands[]` that
  would create a new bar on a table whose existing button `commandStates` edits
  (`command-state-legacy-create-conflict`): create the button in one build, add its state in a later one.
- **Exact approvals, printed by a dry run.** A dry run reads each row and prints, for every row that
  needs a change, `--authorize overwrite:command-state:<table>/<bar>/<rowId>/<sha256>` — one version of
  one row under one intent in one environment — and for every declared table
  `--authorize publish:command-state-table:<table>/<sha256>`. An apply without every one of them
  writes nothing (`command-state-approval-required`, `command-state-publication-approval-required`);
  a row changed after its dry run needs a new token (`command-state-approval-stale`). There is no
  wildcard and no blanket approval.
- **Publishing a table publishes ALL saved customizations on it** (anyone's, not only these buttons),
  for every app that shows the table — which is why it has its own approval.
- **One conditional write per row.** The build sends only the flags that differ, with `If-Match` on
  the version it read. A row changed in between is refused (`command-state-version-conflict`) and never
  overwritten. A write whose answer was lost is never sent again (`command-state-write-unknown`): read
  the row with `list-command-states.js` before building again.
- **Success needs the table's publication.** The build publishes each declared table with the tables
  it publishes before the app; until that publication is seen to succeed after the row's write, the
  build reports `command-state-publish-unconfirmed`, saying for each table what its rows are known to
  hold ("saved, not published", or "write outcome unknown" / "not written" when that is all it knows) —
  a saved row holds the flags, but the button may still show its old state.
- **The end of the build checks again.** After its app work the build resolves the app afresh and reads
  every declared row once more: a table no longer in the app, or a row that no longer holds its flags,
  fails the build. Nothing is rolled back — the rows it wrote stay written.
- **Delayed publication is not fenced.** A table publish that was sent can still complete after a
  halt, or after you remove the entry. This release keeps no record across runs: the next publishing
  run requests the table again only because `commandStates` still names it.
- **`--verify` checks stored flags** of each declared row — not how the button renders. A changed-only
  apply of a spec with `commandStates` always runs the full build. Removing an entry, or a teardown,
  does not restore a flag, and download does not write `commandStates` back into a spec.

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
- **Managed as one rule.** Everything above is a rule without `reconcile`. To have the build create a
  rule with an id it keeps and prove it on every rebuild, declare it: see `businessRules[].reconcile` below.

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
- **Managed as one flow.** Everything above is a flow without `reconcile`. To have the build create a
  flow whose stages and steps keep the ids it gave them, and prove it on every rebuild, declare it: see
  `businessProcessFlows[].reconcile` below.

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
- **Following the spec on rebuilds.** Everything above is a dashboard without `reconcile`. To have a
  rebuild apply the spec's tiles to an existing dashboard, declare it: see `dashboards[].reconcile` below.

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
case, the name exactly as in the spec). One that already holds exactly what the spec declares is left
unchanged and unbound without a stop (with `createIdentity`, the build warns and names the key; see
Adoption below). `--authorize overwrite:view:<table>/<name>` (or `chart:`)
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

Declared upkeep of web resources is described with `webResources[]` above, of form layouts with
`forms[].reconcile` below, of dashboards with `dashboards[].reconcile` below, and of business rules with
`businessRules[].reconcile` below, and of business process flows with `businessProcessFlows[].reconcile`
below. A command bar with
`commands[].key` is refused (`managed-binding-port-unavailable`) in this version.

**An unconfirmed publish.** A table (or dashboard) publish whose answer was lost may still have run. The
next build confirms it with a fresh read of the published layers, never by sending it again (for a declared
form's table, also when the spec no longer declares the form); that run
publishes nothing more on that table, and the build after it goes on as usual. When no read can confirm
it (the publish carried only layers that were already live), the table stays blocked in every build, and
the build stops and prints the approval that releases it:
`--authorize publication-risk:table:<table>/<dispatch>` (`publication-risk:dashboard:<id>/<dispatch>` for a
dashboard). `<dispatch>` names that one lost publish, so the key accepts only it: a key copied from an
earlier stop does not accept a later lost publish of the same table, and a key with no `<dispatch>` is
refused. Check what is live first. Pass the key exactly as printed: `--allow-destructive` and any other key
never give it. Accepting it is a decision to take the risk, not a proof. The build takes it only as it
starts, before it writes anything, whichever step printed the approval (also when the spec no longer
declares the form or dashboard, or the run does not build forms or dashboards); that build then stops
(`publication-risk-accepted`). A key that matches no lost publish at that point is reported as not used, and
it accepts nothing later in that run. If the build cannot tell whether it recorded the acceptance (the
record was written but its answer was lost), it stops before it writes anything
(`publication-risk-record-unconfirmed`); run it again, without the key, and it reads the record afresh.
After the acceptance the publish is owed again, and the next build publishes it after the usual checks: a
form's table, also when the spec no longer declares the form (with `--publish`, the publish phase can
publish the table again), or a declared dashboard. A dashboard the spec no longer declares is not paid: the
build stops `publication-withheld` ("publish is owed") until you declare the dashboard again with
`reconcile: "declared"`, and that build publishes it.

**A saved change the build did not make.** When a declared form's saved layer holds a change made
elsewhere since the build last proved it, the build does not publish that form's table, because the publish
would put that change live; it stops incomplete. If the change is not published, the stop says so: publish it
in Maker if it should be kept, or undo it there and save, then run the build again. If it is already
published, run the build again: it reads the saved layer afresh and names any change it would overwrite.

**Saved and published layers that read apart.** On some forms the platform reads a caption one way in the
saved layer and another way in the published layer (seen on an adopted form whose sub-grid caption in the
base language did). No read can then confirm a publish of that form's table: the stop says that the saved
layer is still the one the publish shipped, yet the published layer reads differently. Compare what is
published with the spec in Maker; if it matches, pass the `publication-risk` key the build prints. A later
publish of that table can stop the same way, and each needs its own key. For a form the build adopted, the
stop can also name the cells and languages whose caption reads differently in the two layers (for example
"Caption difference at cell <id> (language 1033)"), never the caption text. Start the comparison in Maker
there. This does not show whether the difference is an unpublished edit or how the platform reads the layer,
so the stop and its key stay the same. A form the build created and a dashboard get no such list.

**How a publish is confirmed.** After a declared form's table or a declared dashboard is published, the
build reads the published layer and compares it with what it saved. The platform changes some captions by
itself, and these do not count as a difference:

- Straight after a publish, the published layer can show a cell caption that is still being changed. If
  the first read does not show the publish, the build reads it again, for up to about 45 seconds in all.
  If no read shows it, the publish is not confirmed (`managed-publication-unconfirmed`), as before.
- When a dashboard is created, the platform adds an empty caption to each tab and section that has none.
  An empty caption is not compared. A tab or section caption with text is compared.
- In an organization with more than one language, the saved layer has captions in a second language on
  some labels, and the published layer does not return them. **When the build checks that a publish is
  live, a caption in a language that the published layer does not return, and that is not on every label
  of the form, is not compared.** Thus a change only to such a translation is not seen as unpublished and
  does not stop the build as drift. A caption in a language that both layers return is compared, and so is
  all other content. A form that has a second language on every label, or a published read in more than
  one language (the read of a user whose own language is not the base one), can stay unconfirmed.
- In an organization with more than one language, the build writes each tile that it adds to a dashboard
  with its caption in every language of the organization, with the same text. Thus the platform does not
  add a caption of its own to the new tile. If the build cannot read the languages of the organization, it
  stops before it writes the dashboard (`dashboard-languages-unreadable`). In an organization with one
  language, the dashboard that the build writes does not change.
- The platform does not keep all of these captions. In an organization with 1033 and 3082, an iframe tile
  lost its 3082 caption, and a list tile kept it. The platform did not change the text of a caption that it
  kept. Thus, on a tile that the build adds, a caption that the build sent and that is now missing does not
  stop the build, but the caption in the base language must be there, first, with the text that the build sent.
  A caption that is present must have the text that the build sent.
- The rule about languages applies only to the publish check. It does not apply when the build proves
  that a dashboard it wrote holds what it sent. That proof compares every caption in every language. The
  only exceptions are an empty caption on a tab or a section, on every tab and section of the dashboard,
  and a missing caption in a language other than the base language that the build sent to a tile that it added. A
  caption with text that someone adds to a tab, a section or a tile before the proof, in any language,
  stops the build (`create-completion-required`). If the build must read the languages again for this proof
  (after a lost answer) and cannot, it stops with `dashboard-languages-unreadable` and does not change the
  dashboard. Run the build again.
- If the build creates a dashboard and this proof fails, the build does not bind, publish or add the
  dashboard to the solution. The message gives the ID of the dashboard. If the build knows that it created
  the dashboard, the message tells you to delete the dashboard and run the build again. The build then creates
  the dashboard again. If the build does not know who created the dashboard with that ID, the message tells
  you to examine the dashboard. Do not delete it before you know that it is not the work of another person.

## forms[].reconcile (optional — declared form layouts)

Requires `minimumPluginVersion: "2.21.0"`. A form without `reconcile` builds exactly as before: fields
are only added.

```jsonc
{ "entity": "new_ticket", "name": "Ticket Triage", "formType": "Main", "reconcile": "declared",
  "tabs": [{ "name": "general", "label": "General", "sections": [
    { "name": "details", "label": "Details", "columns": 2,
      "fields": ["new_name", { "name": "new_summary", "colspan": 2 }, { "name": "new_priority", "readOnly": false }] }] }],
  "subgrids": [{ "childEntity": "new_task", "view": "Active Tasks", "label": "Tasks" }],
  "events": [{ "event": "onload", "library": "new_ticket.js", "function": "Ticket.onLoad" }] }
```

- **What follows the spec.** The order, section and spans of each declared field, the declared tabs and
  sections, a section's width when stated, and `readOnly` / `hidden` when stated (an explicit
  `false` clears the flag). A missing sub-grid, quick view, timeline or event handler is added. A new
  form is created whole in one write, with an id that stays the same for the spec.
- **What is kept.** A control the spec does not declare (a maker's field, a sub-grid, a web resource)
  keeps its place, and nothing is deleted: `prune` is refused on a declared form, and such a control is
  never listed as a destructive removal (no `--allow-destructive` is needed). Labels, required
  flags and control settings of existing cells are not changed unless the spec states them.
- **What stops before a write.** A layout the build cannot place without moving a control it does not
  own; an existing sub-grid or quick view that shows something else than the spec asks; a section the
  spec puts in a column the tab lacks; a part changed elsewhere since the last build. The form is left
  as it is and the stop names the cause.
- **Refused fields.** `genPages`, `prune`, `isDefault`, `deactivateOtherMainForms`,
  `securityRoles` and a place in `entities[].mainFormOrder` are refused on a declared form: set them
  in Maker, or leave out `reconcile`. Two declared forms with one key (below) are refused.
- **Approvals.** The key is `<table>/<formType>/<name>` in lower case, for example
  `form:new_ticket/main/ticket triage` (quote it in the shell). A form that already exists and that
  this build did not create is bound only with `--authorize "adopt:form:<key>"`; the first binding
  needs it, later builds do not. `--authorize "overwrite:form:<key>"` approves replacing changes made
  elsewhere. A local copy that differs from the server's stops the build (`workspace-copy-unsent-edits`).
- **Publishing.** A declared form's table is published after all its form work, and only when every
  declared change on it succeeded. A table publish puts live every saved change on that table, not only this
  form's (new columns included, so a build without `--publish` does not leave that table's changes
  unpublished), so the build withholds it while another managed change on the table is not proved. A saved
  form that is definitely unpublished is published without a rewrite. `--publish` does not turn this off; it
  decides only when: without it the forms step publishes the table, as the reconcile of any existing form
  does; with it, the table is published later in the same build, with the build's other publishes.
- **Concurrent edits.** Dataverse does not provide a working conditional-write guard for a form's saved
  layer, so a conditional write cannot reject a stale edit of it. The build re-reads the saved form just
  before it writes and stops when it changed since the build read it. An edit made in Maker in the
  instant between that check and the write cannot be detected: do not edit a declared form while a build
  runs.
- **Verify.** `--verify` reads each bound declared form again by its id and checks it against the spec:
  field order, sections, spans, stated flags, sub-grids, quick views and handlers, and the controls the
  build added. A form whose last publish is not confirmed is listed as unverified, not passed. A
  sub-grid must show the view the build would choose (the view it names, else the first view the spec
  declares on that table, else the table's default view): a different view fails, a view the spec
  declares that is not in the environment fails, and one whose name matches more than one view, or that
  cannot be read, is unverified. A quick view whose form name matches more than one form is unverified.
  Verify expects no default-form flag and no form-order place for a declared form, since the build sets
  neither on it; the default and order checks of the table's plain forms are unchanged.
- **Download.** A plain download leaves declared forms out. To bring them back, pass both
  `--include-managed` and `--managed-manifest <store file>`, the `managed-bindings.<hash>.json` file in the
  build's `.maker-workspace` for that environment and app. Each form the store proves comes back with
  `reconcile: "declared"` and as it was declared (`autoSubgrids` and stated `false` flags included); a form
  that is pending, gone or not valid is left out and named. A declared form with an event handler
  (`events`) comes back with each handler library the spec does not declare, added to `webResources[]` as
  `external: true` and named in `managedForms.libraries` (`[{ name, forms }]`) and in a note. A library is
  downloaded only when it is this app's own: exactly one web resource of that name (on a lookup that read
  every row; one cut short proves nothing), unmanaged, a script,
  with content, and named under the solution publisher's prefix, read and verified by the download. A
  rebuild reuses an `external` library where it exists without writing or comparing its content, creates
  it from the downloaded content where it is missing, and a teardown never deletes it. When a library
  fails any of those checks the form is left out and named in `managedForms.stale` ("handler library
  '<name>' was not downloaded: <why>"), and its declaration is written ready to paste in the build
  folder's `.maker-workspace` (see below), with the library it needs: add both to
  the spec. The download transfers no binding: the
  downloaded folder has no store, so the first build that binds a form there needs
  `--authorize "adopt:form:<key>"`. A rebuild that finds the form already as declared writes nothing and
  may leave it unbound.
- **The fragments file.** A managed download writes each declared form or process flow it proved but left
  out only for what it could not bring (a handler library, a persona) to
  a new file, `<out>/.maker-workspace/managed-fragments-<UTC time>-<random>.json`, and names that file in a
  warning and in the result
  (`managedFragments: { file, keys }`). Each item has the store `key`, the `reason` it was left out, what it
  `needs` (`{ "webResource": "<name>" }` or `{ "persona": "<name>" }`) and a `paste` object
  (`{ "forms": [ ... ] }` or `{ "businessProcessFlows": [ ... ] }`): add the entry to the same array in
  `app-spec.json` with what it needs, from the spec it was built from. An item left out for anything else
  (pending, changed, not valid) is not written there, because nothing proved it. The download only ever
  creates a file under a name nothing holds: it never replaces, moves or removes a file in `.maker-workspace`,
  so files from earlier downloads (and any of the maker's) stay as they are; delete old ones when you no longer
  need them. With nothing left out it writes no file. When `.maker-workspace` is a link, a junction or a file,
  or the file cannot be written, the download stops (`code: "managed-fragments-unwritable"`) before it writes
  anything else: the pages, the spec and the baseline are written only after this file.
- **A removed form that was deleted.** When the spec no longer declares a form and the form was deleted in
  the environment, the next build reads it by its id in both its saved and its published layer. When both
  say it does not exist, the build stops managing it, including a publish of its table it still owed: it
  writes nothing, prints `managed-root-retired` with the form's key, and `--verify` no longer checks it.
  Until that build runs, `--verify` fails the form. A form found in either layer, or a read that fails (no
  access, a timeout), is kept as it is. If the build cannot confirm the retirement (another build settled or
  changed the record while this one read it, or the record could not be written), it warns that the retirement
  could not be confirmed and stops before it writes anything (incomplete, `managed-not-settled`): after it, the
  build sends no form, dashboard, app or publish, not even the publish of a change an earlier attempt of the
  same run saved before a temporary failure (the warning names it, and the next build publishes it; a name
  column length that attempt still owed is named with how to set it in Maker). Running the build again reads
  the record afresh. A form
  whose last publish is unconfirmed is not released this way,
  because that publish may still complete: it stays blocked until a read confirms it or the maker accepts
  `publication-risk:table:<table>/<dispatch>` (see "An unconfirmed publish" above). A form the spec still declares is
  not released either: its missing form stops the build (`form-layout-bound-row-missing`). A form you
  declare under that key after it was released is a new one: the build creates it under a new id, never
  the id of the deleted form, unless you approve adopting a form found by name (`adopt:form:<key>`).
- **A plain form in place of a removed declared form that has not settled.** When the spec turns a declared
  form into a plain one (no `reconcile`; a plain form with no `name` is named `<table> form`, and that name
  counts), or names its id in a plain form's `formId`, while its managed record
  still has unfinished work (a change an earlier build started, such as a create whose answer was lost, or a
  publish that is owed or not confirmed), the build refuses that form before it sends anything for it
  (`managed-form-unsettled`), so it never changes what that work owes or makes a second form. Other forms of the
  table build as usual. Restore the declaration (`reconcile: "declared"` with its key) and let it settle, or run
  the build again once that work has settled.

## dashboards[].reconcile (optional — declared dashboards)

Requires `minimumPluginVersion: "2.21.0"`. A dashboard without `reconcile` builds exactly as before: an
existing one is reused and its tiles are never edited.

```jsonc
{ "name": "Operations", "key": "operations", "reconcile": "declared",
  "description": "Daily queue health for the support lead.",
  "tiles": [
    { "key": "open-orders", "type": "list", "view": "Active Orders", "name": "Open orders", "colspan": 2 },
    { "key": "by-status", "type": "chart", "chart": "Orders by Status", "view": "Active Orders" },
    { "key": "map", "type": "iframe", "url": "https://contoso.example/map", "name": "Map" }] }
```

- **Scope.** A global **Standard** dashboard only. An interactive dashboard, or one scoped to a table, is
  refused (`dashboard-interactive-unsupported`, `dashboard-scope-unsupported`), and left as it is.
- **Keys.** The dashboard's key is its `key` (letters, digits, `_`, `.`, `-`; at most 64), or its name in
  lower case when it has none; a name holding `/` needs a `key`. Two declared dashboards with one key are
  refused. Every tile needs a `key` of the same grammar, unique in its dashboard; the build follows the
  tile by it. `componentId` (a GUID, optional) binds a tile to a control the dashboard already has.
- **What follows the spec.** The description (`""` clears it, and needs `--allow-destructive`), and what
  each declared tile authors: its target (chart and view, view, URL or web resource), `name`, and
  `colspan` / `rowspan` when stated. A new tile is added after the dashboard's last row; a new dashboard
  is created whole, with an id that stays the same for the spec.
- **What is kept.** A tile the spec does not declare keeps its place and settings, and nothing is
  deleted: a tile dropped from the spec stays on the dashboard. A tile's settings the spec does not
  state are kept. The dashboard's name is not changed: the spec's `name` finds it the first time, and
  later builds follow the bound dashboard by its id, so a rename in Maker is kept.
- **What stops before a write.** A tile whose type changed, a tile that is missing from the dashboard, a
  new tile that cannot be added without moving rows the dashboard already has, a part changed elsewhere
  since the last build, and a dashboard of the same name that an earlier build created and did not
  finish: that one is not taken over and not deleted. The dashboard is left as it is and the stop names
  the cause. A new dashboard is also not sent when the local copy the build assembled is not exactly the
  draft it planned (`create-local-draft-changed`).
- **A create whose answer was lost.** Before it sends a new dashboard, the build writes a receipt for it in
  the binding store (its id, and a hash of the draft and of the exact request), and it writes the
  acknowledgement there when the service answers that the dashboard was created, before anything else
  runs. When the build stops after that (a crash, a lost connection, a failed later step), the next build
  recovers it by itself: it does not send the create again, needs no `adopt:` approval, reads the
  dashboard fresh to prove what it holds, binds it as created and publishes it. It does this only when the
  local copy the SDK kept is still exactly the draft the receipt names. It does not refresh or delete that
  copy: it works in a separate throwaway folder, and leaves the copy as it was. These cases still stop and
  need you:
  - The build stopped after the dashboard was sent but before the acknowledgement was written (or that
    write failed). The stop names the cause; this is the earlier behavior. Settle it as described for a
    lost create under `createIdentity` (**Local copy**): keep the declaration as it was, discard only the
    local copy, and build again with `--authorize adopt:dashboard:<key>` if it asks for it.
  - The local copy was changed since the send: the build stops with `workspace-copy-unsent-edits` and keeps
    it. Keep the change you want apart, discard only the local copy, build again, then put your change into
    the spec.
  - A dashboard acknowledged and then deleted by hand is created again under the same id only when a fresh
    read of both the saved and the published dashboard answers that it does not exist.
- **Approvals.** The key is `dashboard:<key>`. A dashboard that already exists and that this build did
  not create is bound only with `--authorize adopt:dashboard:<key>`; the first binding needs it, later
  builds do not. `--authorize overwrite:dashboard:<key>` approves replacing a description changed
  elsewhere, and `overwrite:dashboard:<key>/<tile>` one tile changed elsewhere. A local copy that differs
  from the server's stops the build (`workspace-copy-unsent-edits`), except the exact copy of an
  acknowledged create (see **A create whose answer was lost**), which needs no approval.
- **Publishing.** The dashboards step publishes the dashboard by itself, once, after its write, and only
  when the write is proved, with or without `--publish` (with it, the app's publish later in the build can
  publish it again). A dashboard this build cannot finish is not published, not even by the app's publish: an
  app that would hold it is not written in that run. A recovered create is published by the build that
  recovers it.
- **Concurrent edits.** Dataverse does not version a dashboard's saved layer: a dashboard is a form row,
  and a plain read answers the published row's version, so a conditional write cannot reject a stale
  edit of it. The build re-reads the saved dashboard just before it writes and stops when it changed
  since the build read it. An edit made in Maker in the instant between that check and the write cannot
  be detected: do not edit a declared dashboard while a build runs. Do not edit the local copy of a new
  dashboard while its build runs, or before the next build after a stop: a changed copy is never recovered
  over.
- **Verify.** `--verify` reads each bound declared dashboard again by its id and holds it to what its last
  build proved: the managed tiles (each exactly once, with the target, name and size the build wrote), the
  description, and everything the spec does not declare (other tiles, tabs, sections and a tile's other
  settings). It also fails when the spec now declares the dashboard differently from the declaration the
  last build settled (build again to apply it). A dashboard changed in Maker since that build fails until a
  build settles it. A dashboard whose last publish is not confirmed is listed as unverified, not passed.
- **Download.** A plain download writes each dashboard of the site map as an undeclared entry pinned by its
  id. With both `--include-managed` and `--managed-manifest <store file>`, each declared dashboard the store
  proves (a fresh read still shows what its last build proved) comes back as the declaration it was built
  from, with `reconcile: "declared"`, in place of that entry, plus the ids its last build proved: the
  dashboard's `dashboardId` and each declared tile's `componentId`. A rebuild then finds that dashboard by its
  id even after a rename in Maker or a new dashboard with the same name. One that is pending, gone, changed
  since, or not valid stays the plain entry and is named. The ids are not a binding: the downloaded folder has
  no store, so its first binding needs `--authorize "adopt:dashboard:<key>"` for each (a build without it
  writes nothing to the dashboard and binds nothing).
- **Identity.** A declared dashboard is found by its binding first, then by an earlier build's unfinished
  attempt, then by its `dashboardId`, and only then by its name. A `dashboardId` that is not the bound
  dashboard stops the build. `--verify` uses the same bound dashboard for every dashboard check, the site
  map's included. Before its first binding, `--verify` holds a declared dashboard to its `dashboardId`: if
  that id names no dashboard, the check fails, even when another dashboard has the same name. A new
  dashboard's id stays the same for the spec, and a recovered create keeps it.
- **The binding store.** The receipt and its acknowledgement are new, optional fields in the binding store
  file; a store without them reads as before, and opening a store does not rewrite it. An older plugin
  refuses the dashboard whose binding holds them (`managed-binding-group-invalid`): build with this version
  or later. Do not reset, delete or edit the file to let an older plugin read it, and never put back an
  older copy.
- **A removed declaration.** When the spec no longer declares a dashboard whose last change is not
  settled, the build reads it before it builds any other dashboard:
  - A publish that is not confirmed is confirmed when a fresh read proves it live. It is never published
    again. One it cannot confirm stops the build with `publication-risk:dashboard:<id>/<dispatch>`.
  - A publish that is still owed (saved, never sent) is not paid by a build that does not declare the
    dashboard. That build keeps the dashboard out of every app write and publish, and it ends incomplete.
    Declare the dashboard again with `reconcile: "declared"` to publish it.
  - If the dashboard was deleted in Maker, keep its declaration removed. The build reads the dashboard by
    its id in both the saved and the published layer. When both answer that the row does not exist, the
    build retires its record and reports `managed-dashboard-retired`; nothing is sent, and its unpublished
    change is dropped with it. A row in either layer, or a read that fails (no access, a timeout), keeps the
    block. If the build cannot confirm the retirement (another build settled or changed the record while this
    one read it, or the record could not be written), it warns that the retirement could not be confirmed
    and stops before it writes anything (incomplete, `managed-not-settled`): after it, the build sends no
    dashboard, app or publish, not even the publish of a change an earlier attempt of the same run saved
    before a temporary failure (the warning names it, and the next build publishes it). Running the build
    again reads the record afresh. A dashboard you declare under that key
    later is a new one.
  - A plain `dashboards[]` entry with that dashboard's id or name stops the build before it sends anything,
    so it never makes a second dashboard in its place.

## businessRules[].reconcile (optional — declared business rules)

Requires `minimumPluginVersion: "2.21.0"`. A rule without `reconcile` builds exactly as before (see
`businessRules[]` above).

```jsonc
{ "entity": "new_ticket", "name": "Hide notes when closed", "key": "ticket-closed", "reconcile": "declared",
  "description": "Closed tickets are read-only history.",
  "scope": "Entity",               // Entity (default) | AllForms
  "status": "Active",              // Active (default) | Draft
  "conditionLogic": "AND",         // AND (default) | OR
  "conditions": [
    { "key": "closed", "field": "new_status", "operator": "Equals", "value": "100000001", "dataType": "Picklist" } ],
  "actions": [
    { "key": "hide-notes", "type": "SetVisibility", "field": "new_notes", "visible": false },
    { "key": "reason-default", "type": "SetDefaultValue", "field": "new_reason", "value": "Resolved" },
    { "key": "owner-check", "type": "ShowErrorMessage", "field": "new_owner", "errorMessage": "Set an owner first." },
    { "key": "suggest", "type": "Recommendation", "field": "new_priority", "recommendationTitle": "Lower the priority",
      "messageText": "Closed tickets need no priority.",
      "applyActions": [ { "key": "suggest-low", "field": "new_priority", "value": "1", "dataType": "Picklist" } ] } ] }
```

- **One rule, managed whole.** A rule is one row; its conditions and actions are not, and the platform
  gives them new ids on every read, so the build never matches one by its text. The build follows the rule
  by the id it created it with, and proves the whole rule on every rebuild.
- **Keys.** The rule's key is its `key` (letters, digits, `_`, `.`, `-`; at most 64), or
  `<table>/<name>` when it has none. Every condition, action and recommendation apply-action needs a
  `key` of the same grammar, unique in the rule. Two declared rules with one key are refused, and so is a
  declared rule beside an undeclared one with the same table and name.
- **What a declared rule can say**, beyond `businessRules[]` above: `conditionLogic` `OR`; the actions
  `SetDefaultValue` (`value`), `ShowErrorMessage` (`errorMessage`) and `Recommendation`
  (`recommendationTitle`, `messageText`, optional `acceptanceText`, and a non-empty `applyActions[]` of
  `{ key, field, value, dataType }`; a `label`, when given, must equal the title); and the `AllForms` scope.
  An action or condition takes only its own fields: anything else is refused.
- **Creating.** A new rule is created **Draft** under an id that stays the same for the spec, read back,
  and only then activated (when its `status` is `Active`). The activation carries the version of that
  read, and Dataverse enforces it: if the rule was changed in Maker after the build read it, the build
  does not activate it and stops. A repeated create of the same rule is answered by Dataverse without a
  duplicate, so a create whose answer was lost is proved by reading it, never sent twice.
- **Editing.** A rule that already exists is never edited: a change of its body or its status is
  refused before any write (`workflow-edit-refused`). Change it in Maker, then re-adopt it.
- **Approvals.** The key is `rule:<table>/<name>` (lower-case table). A rule that already exists and
  that this build did not create is bound only with `--authorize adopt:rule:<table>/<name>`, and only when
  the declaration names its whole current body in order; nothing is written. A rule changed outside the
  spec stops the build (`rule-drift`) and needs the same complete re-adoption. There is no `overwrite:`
  approval for a rule.
- **Environment.** An environment that cannot host business rules skips every declared rule with one
  warning and writes nothing for it, as above. The same answer after a declared rule was created in this
  build stops it (`business-rule-unavailable-after-create`); an adopted rule does not count as created. A
  declared rule whose earlier change is still waiting to be proved is never skipped this way: the build
  ends incomplete (`managed-not-settled`) and sends nothing for it.
- **Removing one.** A declared rule taken out of the spec leaves management and is kept. When a change an
  earlier build sent to it is still waiting to be proved, the build ends incomplete (`managed-not-settled`)
  and does not touch that rule: put its entry back and build again. Until then the build neither reads nor
  creates a rule of the same table and name, because the earlier create may not be visible yet.
- **A removed rule whose row is gone.** When a read by the rule's own id answers that the row does not
  exist, the build stops managing it and warns `managed-root-retired` with its `<table>/<name>`: this
  holds for a rule whose last change was proved, and for one whose create was proved but whose activation
  was never sent. The notice says only that the row is gone, never that a change of it was made. A row that
  is there, a read that is refused or cannot be read, and a change that may have been sent and is not proved
  keep it as above. If the build cannot confirm the retirement (another build changed the record while this
  one read the row, or the record could not be written), it ends incomplete (`managed-not-settled`) and, for
  the rest of that build, neither reads nor creates a rule of that table and name; the next build reads the
  record again. Once retired, `--verify` no longer checks it. A rule you declare under that `<table>/<name>`
  later is a new one: the build creates it under a new id, never the id of the retired row.
- **Publishing.** A rule is not published; its activation is the state change above.
- **Verify.** `--verify` reads each bound declared rule again by its id and holds it to what its last
  build proved: its whole body (every condition and action, the spec's and any other) and its status. It
  also fails when the spec now declares the rule differently from what the rule holds, or names it with
  another table or name (a build never renames or moves a managed rule). A rule changed in Maker since that
  build fails until it is re-adopted. Its presence and status are read by its own id too, as is a rule whose
  last change is still waiting to be proved; a rule of the same name never passes for it.
- **Download.** A plain download writes no business rule. With both `--include-managed` and
  `--managed-manifest <store file>`, each declared rule the store proves (a fresh read still shows what its
  last build proved) comes back in `businessRules[]` as the declaration it was built from, with
  `reconcile: "declared"`; one that is pending, gone, changed since, or not valid is left out and named. The
  downloaded folder has no store, so the first build that binds each rule that already exists there needs
  `--authorize "adopt:rule:<table>/<name>"`; a rule that is absent is created with no approval.

## businessProcessFlows[].reconcile (optional — declared business process flows)

Requires `minimumPluginVersion: "2.21.0"`. A flow without `reconcile` builds exactly as before (see
`businessProcessFlows[]` above).

```jsonc
{ "entity": "new_ticket", "name": "Ticket Handling", "reconcile": "declared",
  "description": "How support tickets move to resolution",
  "status": "Active",              // Active (default) | Draft
  "order": 1,
  "stages": [
    { "key": "triage", "name": "Triage", "steps": [
        { "key": "subject",  "name": "Subject",  "field": "new_subject", "required": true },
        { "key": "priority", "name": "Priority", "field": "new_priority" } ] },
    { "key": "resolve", "name": "Resolve", "steps": [
        { "key": "notes", "name": "Resolution notes", "field": "new_notes" } ] } ] }
```

- **One flow, managed whole.** A flow is one row; its stages and steps keep the ids they were written
  with, and a record sits on a stage by that id. The build gives every stage and step its id before it
  sends anything, so a retry derives the same ids, and it proves the whole flow on every rebuild.
- **Keys.** Every stage and every step needs a `key` (letters, digits, `_`, `-`, `.`; at most 64),
  unique among its stage's steps or among the stages. A key is the identity: renaming a stage or step
  under the same key keeps its id, and a step added later lands under its actual stage. The flow's own
  key is `<table>/<name>`; a declared flow beside an undeclared one with the same table and name is
  refused. Everything in `businessProcessFlows[]` above still applies (a single table, linear, at
  least one step per stage, a step bound to a column, the name rules).
- **Settings only.** A declared flow that the build already manages may leave out `stages` to keep
  only its description, order and status in the spec. Creating or adopting a flow needs its stages.
- **Status left out.** On a new flow, `status` defaults to Active. On a flow the build already manages,
  leaving it out keeps the state its last build proved: the build changes nothing, and `--verify` expects
  that state (a flow kept Draft stays Draft and passes). A `status` that is written is always held to.
- **Creating.** A new flow is created **Draft** with every id, read back, and only then activated
  (when its `status` is `Active`). The activation carries the version of that read, and Dataverse
  enforces it: if the flow was changed in Maker after the build read it, the build does not activate it
  and stops. A repeated create of the same flow is answered by Dataverse without a duplicate, so a
  create whose answer was lost is proved by reading it, never sent twice.
- **Editing.** A flow that already exists is never edited: a change of its body or its status is
  refused before any write (`workflow-edit-refused`); change it in Maker, then re-adopt it. Removing or
  reordering a stage or a step is refused in every case (`bpf-structure-refused`), before anything is
  read, so no change in Maker and no approval unlocks it. Branching, stage actions, a stage on another
  table and anything else the build does not write are refused (`bpf-shape-unsupported`).
- **Approvals.** The key is `bpf:<table>/<name>` (lower-case table). A flow that already exists and
  that this build did not create is bound only with `--authorize adopt:bpf:<table>/<name>`, and only when
  the declaration names its whole current body in order (`bpf-whole-body-required`); nothing is written.
  A flow changed outside the spec stops the build (`bpf-drift`) and needs the same complete
  re-adoption. There is no `overwrite:` approval for a flow.
- **The backing table.** `securityRoles` are granted on the table name Dataverse stored for the flow,
  as the build read it, never on a name derived from the display name. A change of a managed flow's
  `securityRoles` alone (or of any setting the flow already holds) sends no workflow write; the build
  records the flow's new declaration. A managed download restores a flow with `securityRoles` only with
  its roles. A persona the downloaded spec lacks is written into `personas[]` from its role only when a
  rebuild provably leaves that role exactly as it is (a persona's role is converged onto exactly what it
  declares, so one is never guessed): see "A persona written by a managed download" under `personas[]`
  in app-spec-schema.md. Otherwise the flow is left out with a warning naming each persona and why, and
  its declaration is written ready to paste in a new `.maker-workspace/managed-fragments-*.json` file (see the
  declared forms' Download note); copy those personas from the spec it was built from.
- **Removing one.** A declared flow taken out of the spec leaves management and is kept. When a change
  an earlier build sent to it is still waiting to be proved, the build ends incomplete
  (`managed-not-settled`) and does not touch that flow: put its entry back and build again. Until then
  an undeclared flow with the same table and name is not read, created or changed either, because the
  row of a create whose answer was lost may not be visible yet.
- **A removed flow whose row is gone.** When a read by the flow's own id answers that the row does not
  exist, the build stops managing it and warns `managed-root-retired` with its `<table>/<name>`, as for a
  rule (above): a flow whose last change was proved, one whose create was proved but whose activation
  was never sent, and one whose change of the security roles alone failed before it was recorded. Anything
  less than that answer keeps it as above, and a retirement the build cannot confirm ends it incomplete as
  for a rule. Once retired, `--verify` no longer checks it. A flow you declare under that `<table>/<name>`
  later is a new one, created under a new id.
- **Publishing.** A flow is not published; its activation is the state change above.
- **Verify.** `--verify` reads each bound declared flow again by its id and holds it to what its last
  build proved: its whole body (every stage and step, with their ids) and its status. It also fails when
  the spec now declares the flow differently from what the flow holds (a stage or step added, renamed or
  changed, or one left out or moved, which a build refuses), or names it with another table or name (a
  build never renames or moves a managed flow). A flow changed in Maker since that build fails until it is
  re-adopted. Its presence and status are read by its own id too, as is a flow whose last change is still
  waiting to be proved, so a flow with the same name never passes for it.
- **Download.** A plain download writes no business process flow. With both `--include-managed` and
  `--managed-manifest <store file>`, each declared flow the store proves (a fresh read still shows what its
  last build proved) comes back in `businessProcessFlows[]` as the declaration it was built from, stage and
  step keys included, with `reconcile: "declared"`; one that is pending, gone, changed since, or not valid
  is left out and named. The downloaded folder has no store, so the first build that binds each flow there
  needs `--authorize "adopt:bpf:<table>/<name>"`.

## createIdentity (optional — stable create ids for declared views and charts)

Requires `minimumPluginVersion: "2.21.0"`. Write it on a **new** app only; never add it to an existing or
downloaded spec. The only value is `"stable-v1"`; any other value is a validation error
(`create-identity-invalid`), and a spec without the field builds exactly as before.

```jsonc
{ "minimumPluginVersion": "2.21.0", "createIdentity": "stable-v1",
  "views": [{ "entity": "new_ticket", "name": "Open Tickets", "reconcile": "declared", "columns": ["new_name"] }] }
```

- **Dashboards.** A declared dashboard already has an id fixed by the spec, without this field; there is
  no dashboard value for `createIdentity`. A fixed id finds a row, but is never an approval to bind it.
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
  written and the row stays unbound. A row that already holds exactly what the spec declares does not
  stop the build: it ends successfully with a warning (`view-not-adopted` or `chart-not-adopted`) that
  names the row's id and the `--authorize adopt:` key that binds it. Until it is bound, a changed
  declaration for it stops for adoption.
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

## configurationIdentity (optional — exact ids for protected configuration)

Set `minimumPluginVersion: "2.23.0"` with it (a lower or missing floor is a lint warning: older plugins
ignore the field, keep no binding store for configuration and find these items by name). The only value
is `"stable-v1"`; any other value is a validation error (`create-identity-invalid`), and a spec without
the field builds exactly as before.

```jsonc
{ "minimumPluginVersion": "2.23.0", "configurationIdentity": "stable-v1",
  "environmentVariables": [ /* … */ ], "connectionReferences": [ /* … */ ],
  "customApis": [ /* … */ ], "duplicateDetectionRules": [ /* … */ ] }
```

- **What it covers.** The declared environment variables, connection references, Custom APIs (with
  their request parameters and response properties) and duplicate detection rules (with their
  conditions). Each is created at an id the spec fixes and recorded in the build's binding store
  (`managed-bindings.<hash>.json`, the same file as `createIdentity`; keep it with the build workspace).
  A later build finds each row by that id, never by name: a bound row deleted outside the plugin stops
  the build with `configuration-row-not-found` and is never replaced by a namesake.
- **The binding store comes from the build.** Under the field, a build that cannot open the binding
  store for configuration stops before any request is sent (`create-identity-unverified`).
- **Opting in does not migrate an existing app.** Setting `configurationIdentity: "stable-v1"` does not
  migrate an existing app. A namesake created earlier at another id stops the first protected create
  with `create-identity-conflict`, even if it is the only match; nothing is created or bound, and no
  approval token selects a namesake. Keep the app without the field, or move it to the reserved ids
  outside the plugin. An app that already has protected bindings cannot go back: see "Removing the
  field" below.
- **An uncertain lookup is not absence.** If the namesake lookup a first create needs cannot be read
  completely (a failed read, a page that cannot be continued), the build stops with
  `create-identity-unverified` and creates or binds nothing for that item. Restore access or reliable
  reads and build again.
- **No deletion.** Under the field, clearing an environment variable's value (a deployment-settings
  `Value` of `null`, which deletes its value row), removing a Custom API child, or an unexpected delete
  in a protected change stops with `configuration-protected-removal-unsupported` before anything is sent, authorized or not
  (a removed duplicate-rule condition is a rule edit: `configuration-edit-unsupported`). Make the
  change outside the plugin, with the maker portal or the Web API. Supported changes keep their
  `--authorize` tokens, and builds without the field are unchanged. Deleting a bound row outside the
  plugin does not release its binding: the next build stops with `configuration-row-not-found`. Never
  delete or reset the binding store to clear a stop.
- **Removing the field.** Removing `configurationIdentity` from an App Spec whose binding store still
  holds a declared protected item (bound, or a create still being settled) stops the build before any
  request with `create-identity-opt-in-required`: those items would otherwise be found by name again,
  where a namesake could stand in for the bound row. Put the field back.
- **Verify reads the bound ids.** Under the field, `verify-model-app` checks each declared protected
  item at the id its binding holds, read-only, never by name: a bound row that is gone fails with
  `configuration-row-not-found` even when a namesake exists, an item with no binding (or no readable
  binding store) fails with `create-identity-unverified`, and an item whose create is still being
  settled is reported unverified. Keep the build workspace with the binding store where verify runs.
- **Checked before anything is sent.** Every declared protected item is read and judged before the
  build's first service change, the solution version included: a first create's reserved id and its
  namesake lookup too, so a create that would stop with `create-identity-conflict` or
  `create-identity-unverified` stops the whole build with nothing sent. An edit the plugin does not
  make stops the whole build there, with nothing sent (`configuration-edit-unsupported`).
- **Duplicate rules: create only.** A protected duplicate rule is created with its conditions, completes
  its initial publication/state, and is then only verified; later edits are outside the plugin. A
  later change of its fields, conditions or state stops with: "This protected duplicate rule can be
  created with its conditions and initial state, then verified. Later field, condition or state edits
  are not supported. No service changes were sent by this build. Make this edit outside the plugin,
  keeping the binding store and exact ids." A rule unpublished outside the plugin is not published
  again: the build stops.
- **Custom APIs.**

  | Change to a bound Custom API | Result |
  |---|---|
  | One request on its own: the root's editable fields, one new child, or one child's labels | made |
  | The root's editable fields together with one or more new children | made, as one change set |
  | Two or more new children, nothing else | made, as one change set |
  | Removing one child | stops: `configuration-protected-removal-unsupported` |
  | Anything else (two label edits, labels with any other change, a removal with any other change, a child's fixed field) | stops: `configuration-edit-unsupported` |

  The refusal reads: "This protected Custom API change is not a supported single request or create-only
  changeset. No service changes were sent by this build. Separate supported non-removing single-request
  edits across builds, or make the change outside the plugin. Removals require maintenance outside the
  plugin." Every write names the row's exact id and its current version (`If-Match`). A change of
  `isPrivate` still needs `--authorize`. An implementation registered outside the plugin (the API's
  plug-in type) is kept: no write sends it, and an edit is complete only while the row still holds the
  implementation it was planned over. One replaced or removed while the edit is written leaves the edit
  unfinished with `create-identity-conflict`, and the next build sends nothing for it.
- **Environment variables and connection references** are edited at their exact ids, each as one
  checked change over the item's whole plan: a definition edit, the first value (created at the id the
  spec fixes, then bound) or a new value for its own value row. A value row under a bound definition
  that the binding does not hold is never overwritten or adopted, whatever `--authorize` tokens are
  given: the build stops with `create-identity-conflict` before anything is sent. A bound value that the
  deployment settings do not name in this run is kept, and nothing is sent for it. A connection
  reference's prompting behaviour is never sent: a new one is expected to hold the platform's default,
  and one changed outside the plugin after it was bound is kept, as a Custom API's implementation is
  (an edit is complete only while the row still holds the value it was planned over).
- **Local copy.** Before it reads a protected item into the workspace, the build checks the workspace
  copy. A protected item whose local copy differs from the server's (an edit an earlier run did not send,
  or one made by hand), or cannot be compared with it, is refused before anything is written
  (`workspace-copy-unsent-edits`), and verify stops too; the copy and its binding are kept. Put any change
  to keep into the spec, then approve replacing the local copy with the server's: the `overwrite:` key the
  refusal prints, `--authorize overwrite:<kind>:<key>` (for example
  `--authorize overwrite:customApi:contoso_calc`; the kind is `customApi`, `environmentVariable`,
  `connectionReference` or `duplicateRule`). With that key the build reads the server's row and puts it in
  place of the local copy (a create the server never took leaves no copy); if it cannot read that row,
  it keeps the copy and stops. The key names the item, not a version of its copy: it replaces the local
  copy as it is when the approved build runs, including any edit made after the stop was printed, as the
  views' and charts' `overwrite:` key does. Check the copy again before you give it, and do not edit the
  copy while that build runs. The key is read only with `configurationIdentity: "stable-v1"`.
  The build never replaces or discards the local copy on its own, also when a protected send fails or its
  answer is lost: the copy is kept with every edit in it, including one made while the build was sending,
  and a later build that finds it stops on it until you give that key. Nothing else discards it. The unfinished send
  itself is still decided from what the build recorded before sending (below); giving the key never sends
  it again. The build command keeps these items' copies in a working folder of its own and removes it
  when the command ends, so a copy kept after a failed send lasts until then: the stop applies within
  that command, and the next command reads the server's rows afresh.
- **Unfinished work is checked first, declared or not.** Before its first service change, every build
  reads the binding store for protected items whose create or edit has not finished. If the App Spec no
  longer declares such an item, the build stops with `managed-settlement-pending` and sends nothing.
  This applies with or without the field and whatever phases run. Declare the item again, with the
  field, to finish it.
  An item that finished before it was removed from the App Spec does not stop the build.
- **`--changed-only` runs the whole build.** While the field is set, or the binding store holds
  configuration state, a `--changed-only` apply runs the full build and prints
  `changed-only: FULL — protected configuration is in play`. Its record of the last apply does not cover
  these rows, so it cannot tell that one was deleted, that an edit is refused or that the store cannot
  be read; the full build checks them before its first service change and stops instead. With or without
  the field, a change to an environment variable, connection reference, Custom API or duplicate-detection
  rule also makes a `--changed-only` apply a full build.
- **An edit that did not finish.** The next build decides a Custom API, environment variable or
  connection reference edit from what the first one recorded before sending. A complete edit is
  recorded and never sent again. An edit that no request can have reached is sent once, at the same ids.
  If its target is already there, nothing is sent, and the edit is recorded only if its rows are
  exactly what the plugin would make: one that needs an approval (a private value) or whose solution
  membership was removed stops, and is never reported unchanged.
  If its rows changed since then, it is dropped while nothing was sent; otherwise the build stops until
  you restore them. Anything else keeps its stop.
  An edit or create the SDK refuses before its first request (for example a Custom API label edit on an
  environment with more than one language, `CUSTOM_API_LABELS_UNSUPPORTED`) stops that build and leaves
  nothing unfinished: the next build is judged on what the App Spec then declares, the earlier
  declaration, another edit or the same one.
- **A create that did not finish.** The next build decides it from what the first one recorded before
  sending, never from today's rows, and sends nothing while it does: a create that is complete is bound;
  a create that is missing a row, its solution membership or the rule's initial state stops with
  `create-completion-required` — complete it under the same ids, then build again. An initial
  publication that failed or whose answer was lost is never sent again by the build: publish the rule
  under the same id yourself. The one exception is a rule whose content was saved, but whose publish
  request the record proves was never sent (the run stopped first). The next build sends that publish
  once, then binds the rule. If the rule's conditions still need your approval, the build asks for it
  first. Rows that no answer proved this build's own are bound only after you check
  them and approve each one exactly: the stop (`create-ownership-required`) lists the tokens, such as
  `adopt:duplicateRule:<key>` and one per child (`adopt:<child kind>:<key>/<child>`, both parts
  percent-encoded, for example `adopt:customApiRequestParameter:contoso_calc/request%3Aa`). Pass each as
  printed with its own `--authorize`; a root's token never covers its children, and the tokens are read
  only with the field and only for declared items. A declaration changed since the create was prepared
  stops with `managed-pending-intent-changed`: put the original declaration back, finish the create,
  then make the change. A row that differs from what was sent stops with `create-identity-conflict`.
- **Retries keep the ids.** When a later step of the same build fails with a transient error and the
  build runs again, the second attempt finds each protected row at the id the first one bound and sends
  nothing for it. A protected create whose answer was lost stops the build (`create-outcome-unknown`)
  and is never retried; the next build decides it as above.