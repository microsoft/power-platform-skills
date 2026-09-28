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
- **ID-passthrough tiles (what a download emits).** A tile may instead carry the *deployed* ids —
  `viewId` (+ `visualizationId` for a chart) and the target `entity` — with no `chart`/`view` name.
  That form binds to artifacts that **already exist**, which is what a downloaded app needs: its
  views and charts are not reconstructed into `views[]`/`charts[]`, so a name could not resolve.
  An id-based chart tile needs `viewId` **and** `entity` (a visualization with no view has nothing
  to plot); an id-based list tile needs `viewId` and `entity`. Author specs by name; let downloads
  use ids.

## roleGrants[] (optional — extend a role you did NOT author)

Adds privileges for a table to a security role that **already exists** — typically the roles an
existing solution ships. Use it when you add a table to an app whose access model somebody else owns:
without it the table, its forms and its navigation deploy while every non-admin persona still cannot
open the table, and nothing reports it.

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


**Not yet supported** (tracked follow-up): column-level (field) security and access teams / hierarchy
security.
