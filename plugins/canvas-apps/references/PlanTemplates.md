# Canvas App Plan Templates

The planner writes three artifact types:

1. `[working directory]/canvas-app-plan.md` — compact orchestration index
2. `[working directory]/canvas-app-shared.md` — cross-screen conventions
3. `[working directory]/[target-base].screen-plan.md` — one implementation brief per screen

## Contents

- Plan Index — CREATE
- Plan Index — EDIT
- Shared Plan
- Screen Brief — CREATE
- Screen Brief — MODIFY

## Plan Index — CREATE

```markdown
# Canvas App Plan

## Mode

CREATE

## Requirements

[Original requirements]

## Requirement Coverage

| Requirement                                     | Planned affordance                   | Fidelity                        |
| ----------------------------------------------- | ------------------------------------ | ------------------------------- |
| [Concrete noun or interaction from the request] | [Visible control and exact behavior] | Exact / Approximation: [reason] |

## Required Record Fields

| Field key                        | Screen   | Record surface | Required field | Source field | Presentation requirement                  |
| -------------------------------- | -------- | -------------- | -------------- | ------------ | ----------------------------------------- |
| [screen/surface/field identifier] | [Screen] | [Card/row/detail] | [Visible meaning] | [Record field] | [Full text, combined format, label, etc.] |

[Include one row for every field the requirements say must appear on a repeated record
card, row, or immediately reachable detail. Include the canonical identity and every
requested title, person, time range, description, status, or other display value. Use one
stable unique field key per row. A surface that renders only one secondary value, such as
time, does not satisfy omitted requested fields. Omit this section only when the app has no
record list, card, row, or detail surface.]

## Action Contracts

| Requested action            | Preconditions                             | Entry point                            | Owner screen | Control and event                     | Source and stable ID                          | Transition and postcondition                 | Mutation write set                   | Receipt proof set                                          | Observer and evidence                                              |
| --------------------------- | ----------------------------------------- | -------------------------------------- | ------------ | ------------------------------------- | --------------------------------------------- | -------------------------------------------- | ------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| [Concrete requested action] | [Eligible state and enabled/visible rule] | [Visible control the user starts from] | [Screen]     | [PrefixedControl.OnSelect / OnChange] | [Named source and immutable identity, or N/A] | [Exact operation and resulting source state] | [Every changed field/status, or N/A] | [Identity plus every value rendered after success, or N/A] | [Formula/control reading the post-state plus in-viewport evidence] |

[Include only actions stated by the request or approved plan and apply the relevant
acceptance paths from `${PLUGIN_ROOT}/references/BehaviorGuide.md`. Do not infer universal CRUD for
supporting entities. Role-scoped management of all primary records requires separate
list/select, edit/save, and remove/cancel rows. Keep other requested actions separate,
including paired approve and reject decisions. Add supporting setup only when required to
exercise requested behavior over local/mock data. For create/edit, include inputs, finite
choices, defaults, stable identity, prepopulation, cancel behavior, and a deterministic
post-save mutation receipt bound to the changed ID. For every mutation, enumerate the write
set and proof set. A create/edit proof set must contain every user-entered or user-selected
field in the write set. Name the receipt control, visibility state, and labeled binding for
each proof-set field. Opposing transitions have separate rows even when they share a form.
For an arithmetic pair, each row names old value, amount, explicit `+` or `-` arithmetic,
and a proof set containing operation, old value, amount, expected new value, and actual
persisted new value. Do not use navigation, a notification, or a row somewhere in a longer
list as the Observable result. For a shared-operation flow — directional selector events
commit operation state and a distinct guarded event consumes that state to mutate — each
directional row must name its selection-only event, the same operation state, and the same
distinct mutation event, regardless of control names or labels. Selectors never mutate,
but may also set receipt/display state; the actual operation state is the one consumed by
the mutation owner. An event-bearing selector must assign it, the invalid gate must
blank-check it, and the gated control must own or route to the mutation. A dead gated
control beside direct-mutation buttons is invalid. Each arithmetic branch is associated
with its matching operation. Button, dropdown, and radio selectors are all valid when
they commit explicit direction state. Separate direct actions remain valid when each
action is independently gated and no dead shared gate is claimed; their control identity
commits direction, so they require no shared operation variable/reset. Every direct action
still gates selected ID and amount.]

## Functional Test Matrix

| Scenario                 | Given                                   | When                                | Then                         | Evidence surface                              | Boundary or negative case                                     |
| ------------------------ | --------------------------------------- | ----------------------------------- | ---------------------------- | --------------------------------------------- | ------------------------------------------------------------- |
| [Action-path identifier] | [Deterministic seed and eligible state] | [Exact visible control interaction] | [Exact source postcondition] | [Observer formula/control and receipt fields] | [Blocked, empty, invalid, clear, or failure behavior, or N/A] |

[Include at least one success scenario for every Action Contract and one row for every
required boundary or negative path. Use concrete seeded IDs and values when the app uses
local/mock data. Every Then clause must be provable from the named source through the
Evidence surface; do not use appearance, navigation, or notification as proof. Opposing
transitions require separate scenarios with the same concrete old value and amount so
their expected results prove both arithmetic directions.]

## Directional Mutation Evidence

[Include this section when the Action Contracts contain both directions of Receive/Issue,
Increase/Decrease, Credit/Debit, Allocate/Release, Check-in/Check-out, or Enable/Disable.
Use one row per pair. Copy the exact final-YAML `Control.Property: =formula` bindings into
the acceptance artifact. The selected-record state must be the exact stable-ID target used
by both mutations. Receipt bindings must be separated with `<br>` and include
`operation`, `old`, `amount`, `expected`, and `actual`. For a shared-operation flow, both
mutation columns name the same distinct event binding and identify the operation value and
branch that reaches the corresponding arithmetic; isolated `+` and `-` excerpts are not
evidence. The invalid-submit gate must blank-check the exact operation state written by
every selector and consumed by that event. The operation-state reset binding must name
that state's `Blank()` assignment on screen entry and/or after successful Apply; never put
an amount input's `Default` in that column. Use one nullable selected-ID expression
initialized or reset to `Blank()`, assigned by row selection, and consumed by display,
gate, mutation, receipt, and compound evidence. `Control.Selected` / `.Selected.*` is not
an explicit no-selection contract for a nonempty Gallery, Dropdown, List box, or Combo box
unless its empty-selection semantics are configured and evidenced. Cross-check final YAML for compatible
NumberInput `Default`, `Min`, current `Value` gate, visible validation, and reset behavior;
blank and non-positive values must be representable. `Default: =0` is valid with
`Min <= 0`, a rejecting gate, and Reset that restores zero. An `OnChange`-staged amount is
subject to the same input validity checks. Accept either `value <= 0` or
`Not(value > 0)` for the non-positive gate. For a classic operation Dropdown with
nonempty `Items`, require `AllowEmptySelection: =true`; for a Combo box require
`DefaultSelectedItems: =[]`. Do not prescribe an unsupported empty-selection property for
a List box, and prefer explicit operation state when control semantics are uncertain.
Every direction must have its own literal guard; default/else arms do not prove a
direction. If success resets current operation state, the receipt operation binding must
use a captured completed-operation value.
Preserve quoted or block-scalar formulas and
normalize embedded newlines to `<br>` in the table. A receipt may render readable label
text, but static evidence must expose one unambiguous underlying value expression for each
of `operation`, `old`, `amount`, `expected`, and `actual`. Use either a direct value
formula or literal label decoration around exactly one dynamic value expression. If a
binding contains multiple plausible dynamic values and the underlying value cannot be
uniquely extracted, record a dedicated ambiguous-receipt-expression error rather than
guessing. A `var*` or `loc*` operand is live only when a reachable event assigns it from
the input with `Set(...)` or `UpdateContext({...})` before the mutation, or the mutation
reads the input inline. `App.OnStart`/`Screen.OnVisible`-only and after-mutation assignments
do not establish liveness.]

| Pair | Selected-record expression | Operation-state reset binding | Invalid-submit gate | Receive/increase mutation | Issue/decrease mutation | Canonical-source observer | Receipt bindings |
| ---- | -------------------------- | ----------------------------- | ------------------- | ------------------------- | ----------------------- | ------------------------- | ---------------- |
| [Receive/Issue] | [e.g. `varSelectedId`; final YAML must blank-reset, row-assign, and consistently consume it] | [e.g. `Adjust.OnVisible: =Set(varOperation, Blank())` or exact successful-Apply reset] | [e.g. `btnApply.DisplayMode: =If(IsBlank(varSelectedId) \|\| IsBlank(varOperation) \|\| IsBlank(numAmount.Value) \|\| numAmount.Value <= 0, DisplayMode.Disabled, DisplayMode.Edit)`] | [exact `Control.Property: =formula`] | [exact `Control.Property: =formula`] | [exact `Control.Property: =formula`] | [e.g. `operation=lblReceiptOperation.Text: =varLastOperation<br>old=lblReceiptOld.Text: =varOldQuantity<br>amount=lblReceiptAmount.Text: =varAmount<br>expected=lblReceiptExpected.Text: =varExpectedQuantity<br>actual=lblReceiptActual.Text: =varLastMutation.Quantity`] |

## Compound Sequence Evidence

[Include this section when both directions of an opposing pair act on the **same record
type**. One row per pair. It proves the second operation reads the value the first mutation
already persisted, not the original — the runtime failure a single-operation scenario cannot
catch. The `Second-op old-value binding` must copy the exact final-YAML `Control.Property:
=formula` that sources the old value for the second operation from the canonical source (e.g.
a `LookUp` over the patched collection), not a stale selection snapshot. The validator does
not machine-check this table; it is a required reviewer/authoring proof.]

| Pair | Same-record ID expression | Sequence (start -> op1 amount -> mid -> op2 amount -> end) | Second-op old-value binding (reads mutated canonical source) | Result |
| ---- | ------------------------- | --------------------------------------------------------- | ------------------------------------------------------------ | ------ |
| [Receive/Issue] | [e.g. `varSelectedInventoryId`] | [e.g. `Qty 10 -> Receive 3 -> 13 -> Issue 2 -> 11`] | [exact `Control.Property: =formula` reading canonical source, e.g. `btnIssue.OnSelect: =Set(varOldQuantity, LookUp(colInventory, ID = varSelectedInventoryId).Quantity); ...`] | PASS |

## Layout Budget Contracts

| Screen / container | Branch / screen-width source | Horizontal total-width arithmetic | Vertical height arithmetic | Protected controls |
| ------------------ | ---------------------------- | ----------------------------------- | -------------------------- | ------------------ |
| [screen / container] | [prefer local/root width; if `App.Width` is used, include the narrowest supported local/root rendered width; list every reachable cross-branch pair if scopes differ] | [total available local/root width versus padding + child fixed/min widths + gaps, or N/A] | [Height versus child fixed/min heights + gaps + padding, or N/A] | [amount, Save/Apply, receipt operation/old/amount/expected/actual] |

[Include every nested AutoLayout container participating in a coordinated breakpoint,
every horizontal AutoLayout branch, and every fixed-height vertical AutoLayout branch.
Repeat the same container in separate rows for each axis/branch when necessary.
Over-budget rows must wrap, scroll with a visible affordance, stack, or switch at a higher
threshold.]

## Working Directory

[absolute working directory]

## Discovery Summary

- Controls: [relevant controls]
- Data sources: [used sources or none]
- Connectors: [used connectors or none]

## Dispatch

| Action | Screen       | Target File            | YAML Key | Name Prefix | Screen Brief                  |
| ------ | ------------ | ---------------------- | -------- | ----------- | ----------------------------- |
| Create | [Landing]    | `[working directory]/Screen1.pa.yaml` | Screen1  | [Prefix]    | `[working directory]/Screen1.screen-plan.md` |
| Create | [Additional] | `[working directory]/[Name].pa.yaml`  | [Name]   | [Prefix]    | `[working directory]/[Name].screen-plan.md`  |

## Editor State Changes

[Exact final ScreensOrder and ComponentDefinitionsOrder lists, or "None"]
```

## Plan Index — EDIT

```markdown
# Canvas App Plan

## Mode

EDIT

## Requirements

[Original edit requirements]

## Requirement Coverage

| Requirement                                     | Planned affordance                   | Fidelity                        |
| ----------------------------------------------- | ------------------------------------ | ------------------------------- |
| [Concrete noun or interaction from the request] | [Visible control and exact behavior] | Exact / Approximation: [reason] |

## Required Record Fields

| Field key                        | Screen   | Record surface | Required field | Source field | Presentation requirement                  |
| -------------------------------- | -------- | -------------- | -------------- | ------------ | ----------------------------------------- |
| [screen/surface/field identifier] | [Screen] | [Card/row/detail] | [Visible meaning] | [Record field] | [Full text, combined format, label, etc.] |

[Include every requested record field affected by the edit and every existing field whose
surface, source, formula, visibility, or layout is touched. Preserve unaffected required
fields on a modified surface. Omit this section only when the edit cannot affect a record
list, card, row, or detail surface.]

## Action Contracts

| Requested action            | Preconditions                             | Entry point                            | Owner screen | Control and event                     | Source and stable ID                          | Transition and postcondition                 | Mutation write set                   | Receipt proof set                                          | Observer and evidence                                              |
| --------------------------- | ----------------------------------------- | -------------------------------------- | ------------ | ------------------------------------- | --------------------------------------------- | -------------------------------------------- | ------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| [Concrete requested action] | [Eligible state and enabled/visible rule] | [Visible control the user starts from] | [Screen]     | [PrefixedControl.OnSelect / OnChange] | [Named source and immutable identity, or N/A] | [Exact operation and resulting source state] | [Every changed field/status, or N/A] | [Identity plus every value rendered after success, or N/A] | [Formula/control reading the post-state plus in-viewport evidence] |

[Include only actions stated by the request or approved plan. Preserve unaffected existing
actions, and do not expand the edit into universal CRUD. Preserve the semantic contracts
for role-scoped primary-record management, paired review decisions, requested periods or
cycles, and requested export/report output. Preserve or add separate Action Contract rows
for opposing transitions. A shared form does not merge Receive/Issue, Increase/Decrease,
Credit/Debit, Allocate/Release, Check-in/Check-out, or Enable/Disable into one contract.]

## Functional Test Matrix

| Scenario                     | Given                     | When                        | Then                                       | Evidence surface                      | Boundary or negative case                    |
| ---------------------------- | ------------------------- | --------------------------- | ------------------------------------------ | ------------------------------------- | -------------------------------------------- |
| [Changed or regression path] | [Current or seeded state] | [Exact visible interaction] | [Exact preserved or changed postcondition] | [Observer/control reading the source] | [Required failure/boundary behavior, or N/A] |

[Cover every changed Action Contract and every existing action whose source, fields,
controls, or observer are touched by this edit. This is the regression contract. When an
opposing pair is affected, include one concrete scenario per direction and verify explicit
before/amount/after semantics.]

## Layout Budget Contracts

| Screen / container | Branch / screen-width source | Horizontal total-width arithmetic | Vertical height arithmetic | Protected controls |
| ------------------ | ---------------------------- | ----------------------------------- | -------------------------- | ------------------ |
| [changed container] | [local/root source and narrowest supported rendered width, or all cross-branch pairs] | [total available local width versus padding + children + gaps, or N/A] | [available Height versus children + gaps + padding, or N/A] | [amount, Save/Apply, complete receipt, or N/A] |

## Working Directory

[absolute working directory]

## Discovery Summary

- Existing screens: [names]
- Layout: [ManualLayout / AutoLayout / mixed]
- Data sources: [used sources or none]

## Dispatch

| Action | Screen     | Target File           | YAML Key       | Name Prefix | Screen Brief                 |
| ------ | ---------- | --------------------- | -------------- | ----------- | ---------------------------- |
| Modify | [Existing] | `[working directory]/[File].pa.yaml` | [existing key] | [Prefix]    | `[working directory]/[File].screen-plan.md` |
| Create | [New]      | `[working directory]/[File].pa.yaml` | [new key]      | [Prefix]    | `[working directory]/[File].screen-plan.md` |

## App Changes

### Before builders

[Shared definitions screens bind to — collections, named formulas, app variables, OnStart
seed data — or "None"]

### After builders

[Changes referencing screens that do not exist yet, such as StartScreen — or "None"]

## Editor State Changes

[Exact final ScreensOrder and ComponentDefinitionsOrder lists, or "None"]
```

## Shared Plan

```markdown
# Canvas App Shared Plan

## Aesthetic Direction

- Palette: [description]
- Primary background: RGBA([...])
- Accent: RGBA([...])
- Text primary: RGBA([...])
- Text secondary: RGBA([...])
- Typography: [scale and weights]

## Visual Contract

- Type roles: [exact title, section-heading, body, caption sizes and weights]
- Spacing scale: [approved gap and padding values]
- Surfaces: [page, panel, card, border, and shadow treatment]
- Actions: [exact primary, secondary, destructive, and disabled treatment]
- Density: [desktop, tablet, and phone composition rules]

## Layout Strategy

[Shared layout rules and target-device rationale. Record the breakpoint formulas, the
narrowest supported local/root rendered width, and the rule that responsive properties
derive from current width rather than `OnVisible` variables. Do not equate `App.Width`
with an embedded or letterboxed viewport.]


## Named State

[Variables, named formulas, collections, and ownership]

## Control Naming

[Standard control-type abbreviations followed by the per-screen namespace, such as
`conDiscNavBar` and `btnDetailBack`, plus the rule that repeated UI blocks are
instantiated under each screen's own namespace]

## Cross-Screen Contracts

[Navigation targets and shared state expectations. For repeated navigation blocks, list
the exact items in order and prohibit extra screen-specific children. Use ModernButtons
for cross-screen navigation; reserve ModernTabList for panels within one screen.]

## YAML Conventions

- Formula prefix
- Multi-line formula syntax
- String and record-literal quoting
- Enum escaping
- App-specific conventions
```

## Screen Brief — CREATE

```markdown
# Screen Plan: [Logical Screen]

## Assignment

- Action: Create
- Target file: `[working directory]/[File].pa.yaml`
- YAML key: [key]
- Control name prefix: [Prefix]

## Specification

- Purpose: [description]
- Layout: [root and child structure. For each fixed-height section and horizontal row
  with four or more substantive children, include a desktop/narrow/phone budget with
  child grouping, minimum widths/heights, gaps, padding and resulting section size.
  Prove all visible children remain inside their parent and do not overlap at each target
  width. The sole responsive root must use exact `Width: =Parent.Width`,
  `Height: =Parent.Height`, `LayoutMinWidth: =0`, and `LayoutMinHeight: =0`; breakpoint
  sizing belongs only on descendants. For record rows, name the canonical human-readable
  identity field and text binding that renders its full value, then define how that text,
  status, and required lifecycle actions remain visible or immediately reachable on phone.
  Avatar initials do not satisfy identity. When review requires both Approve and
  Reject/Decline, keep both decisions on the same eligible row or same immediately reachable
  detail; do not drop one to fit the layout.]
- Breakpoint source: [one screen-level width expression used by coordinated parent Height,
  nested child LayoutDirection, and related formulas; if sources differ, enumerate every
  reachable cross-branch combination]
- Numeric layout budgets: [for each horizontal branch: total available width versus
  padding + child fixed/`LayoutMinWidth` sum + gaps; for each fixed-height vertical branch:
  child fixed/minimum heights plus gaps and padding versus Height. Include amount inputs,
  Save/primary actions, and the complete labeled receipt.]
- Text fit: [single-line or wrapping behavior and longest-value width/height budget for
  each text-bearing control]
- Visual hierarchy: [title, section, body, caption, primary action, and focal content
  roles copied from the shared Visual Contract]
- Core visualization: [bound source, meaningful first-render records, relationship or
  comparison encoding, populated controls, and truthful empty state; omit only when this
  screen owns no core visualization]
- Grid contract: [for each GridLayout, exact columns, rows, column minimum, row minimum,
  height and child-position formulas; omit when there is no GridLayout]
- Controls: [prefixed control names and purpose]
- Column headers: [for any grid or repeated row of inputs, the exact visible header
  strings — "Mon", "Tue", … . A row of identical unlabelled inputs is unusable, and
  `AccessibleLabel` is not a substitute for a visible header. Omit if the screen has no
  repeated input row.]
- Data binding: [sources, fields and variables; identify small screen-local read-only
  tables that stay inline in `Items`, versus shared or mutable collections owned by App.
  For entities with multiple date/status fields, define which field drives each visible
  view and ensure displayed labels, seed data and filters use that same meaning.]
- Navigation: [targets and triggers]
- State: [OnVisible initialization]

## Required Record Fields

| Field key                         | Record surface | Required field | Source field | Bound control | Exact formula | Placement and visibility |
| --------------------------------- | -------------- | -------------- | ------------ | ------------- | ------------- | ------------------------ |
| [key copied from the plan index]  | [Card/row/detail] | [Visible meaning] | [Record field] | [Prefixed control] | [Exact binding] | [Hierarchy, sizing, normal-state visibility] |

[Copy every Required Record Fields row owned by this screen. Each row names a concrete
visible control inside the record surface, its exact formula, and enough layout detail to
prove that the value is visible in the normal state. A combined control may satisfy
multiple rows only when its formula references every named source field. Do not replace
requested text with an icon, tooltip, accessible label, record ID, or time-only summary.]

## Required Actions

| Action                              | Preconditions    | Entry point and event                                   | Source and stable ID                          | Transition and postcondition                  | Mutation write set                   | Receipt proof set                                 | Observer and evidence                                    |
| ----------------------------------- | ---------------- | ------------------------------------------------------- | --------------------------------------------- | --------------------------------------------- | ------------------------------------ | ------------------------------------------------- | -------------------------------------------------------- |
| [Action copied from the plan index] | [Eligible state] | [Visible entry and PrefixedControl.OnSelect / OnChange] | [Named source and immutable identity, or N/A] | [Exact formula operation and resulting state] | [Every changed field/status, or N/A] | [Identity plus every labeled bound value, or N/A] | [Formula/control reading the source plus visible result] |

[Copy every Action Contract owned by this screen. Include the exact input, binding, event,
source operation, and immediate visible evidence needed to implement each row. For
create/edit, include finite-choice values and defaults, stable identity, prepopulation,
save-by-ID, reset, cancel behavior, and the in-viewport mutation receipt's control,
visibility state, and labeled binding for every proof-set field. Preserve write-set/proof-set
parity from the Action Contract. Expand every success, boundary, rejection, persistence,
and recalculation path assigned by the plan. Keep paired review decisions as separate rows
but require both controls on the same eligible record surface.]

## Functional Test Scenarios

| Scenario                              | Given            | When                      | Then                   | Evidence surface                           | Boundary or negative case            |
| ------------------------------------- | ---------------- | ------------------------- | ---------------------- | ------------------------------------------ | ------------------------------------ |
| [Scenario copied from the plan index] | [Concrete state] | [Exact local interaction] | [Source postcondition] | [Local or downstream observer and receipt] | [Required boundary behavior, or N/A] |

[Copy every Functional Test Matrix row exercised by this screen. The builder must be able
to trace each row through concrete formulas without reading another brief.]


## Relevant Data Source Schemas

[Only the fields this screen reads or writes; omit if none]

## Relevant API Details

[Only the operations and parameters this screen calls; omit if none]

## Required Variants

[Control type -> exact variant to use, for every control type whose definition includes a
Variants section; omit if none]

## Control Definitions

[For each control type used on this screen: the complete list of valid input property
names, plus the full enum name for each enum property this screen sets. Not the whole
describe_control response.

Give each enum property the **compile-ready literal**, not a list of members. Write
`Precision: =DecimalPrecision.'1'`, never `Enum name: DecimalPrecision; values: 0, 1, 2`.
A member list is transcribed literally by the builder and a member starting with a digit
then fails to compile.]
```

## Screen Brief — MODIFY

```markdown
# Screen Plan: [Logical Screen]

## Assignment

- Action: Modify
- Target file: `[working directory]/[File].pa.yaml`
- YAML key: [existing key]
- Control name prefix: [Prefix]

## Current State

[Concise summary of relevant existing controls and layout]

## Changes

1. [Exact required change]

## Layout and Visual Impact

- Responsive bounds: [desktop, tablet, and phone width/height budgets for changed regions]
- Breakpoint source: [one screen-level width expression for coordinated nested branches,
  or every reachable cross-branch combination]
- Numeric layout budgets: [total horizontal width versus padding + children + gaps; vertical
  Height versus children + gaps + padding; include amount, Save/primary action, and all
  receipt fields]
- Text fit: [longest-value budget for changed text-bearing controls]
- Visual contract: [shared type, spacing, surface, and action roles that changed controls
  must preserve]
- Record presentation: [canonical identity field and full visible text binding; placement
  of paired review decisions on each eligible record, or N/A]

## Required Record Fields

| Field key                         | Record surface | Required field | Source field | Bound control | Exact formula | Placement and visibility |
| --------------------------------- | -------------- | -------------- | ------------ | ------------- | ------------- | ------------------------ |
| [key copied from the plan index]  | [Card/row/detail] | [Visible meaning] | [Record field] | [Control] | [Exact binding] | [Hierarchy, sizing, normal-state visibility] |

[Copy every affected Required Record Fields row and every preserved row on a record
surface whose source, formula, visibility, hierarchy, or layout changes. Do not allow a
modified card or row to retain only one secondary value while required identity or detail
fields disappear.]

## Controls to Add

[Name, type, placement, properties; or "None"]

## Controls to Remove

[Names; or "None"]

## Properties to Update

[Control -> property -> exact value; or "None"]

## Required Actions

| Action                              | Preconditions    | Entry point and event                           | Source and stable ID                          | Transition and postcondition                  | Mutation write set                   | Receipt proof set                                 | Observer and evidence                                    |
| ----------------------------------- | ---------------- | ----------------------------------------------- | --------------------------------------------- | --------------------------------------------- | ------------------------------------ | ------------------------------------------------- | -------------------------------------------------------- |
| [Action copied from the plan index] | [Eligible state] | [Visible entry and Control.OnSelect / OnChange] | [Named source and immutable identity, or N/A] | [Exact formula operation and resulting state] | [Every changed field/status, or N/A] | [Identity plus every labeled bound value, or N/A] | [Formula/control reading the source plus visible result] |

[Copy every affected Action Contract and preserve unaffected behavior. Include the target
source and deterministic visible result bound to the changed stable ID for mutations. Copy
the exact mutation write set and receipt proof set from the Action Contract. For create/edit
changes, define finite-choice values and defaults, stable identity, visible Edit entry,
prepopulation, save-by-ID, reset, cancel behavior, and the exact reveal receipt. Name its
control, visibility state, and one labeled binding per proof-set field. Keep changed
success, boundary, rejection, persistence, and recalculation paths separate.]

## Functional Test Scenarios

| Scenario                                                    | Given            | When                      | Then                   | Evidence surface                      | Boundary or negative case            |
| ----------------------------------------------------------- | ---------------- | ------------------------- | ---------------------- | ------------------------------------- | ------------------------------------ |
| [Changed or regression scenario copied from the plan index] | [Concrete state] | [Exact local interaction] | [Source postcondition] | [Observer/control reading the source] | [Required boundary behavior, or N/A] |

[Copy every affected scenario, including preservation checks for behavior sharing a
changed source, field, control, or observer.]


## Relevant Data Source Schemas

[Only the fields this edit reads or writes; omit if none]

## Relevant API Details

[Only the operations this edit calls; omit if none]

## Required Variants

[Control type -> exact variant, for any control this edit adds whose definition includes a
Variants section; omit if none]

## Changed or Added Control Definitions

[For each control type receiving a new property, enum, or variant — including types
already present in the app: valid input property names, plus the full enum name and
compile-ready literal for each enum property this edit sets. Write
`Precision: =DecimalPrecision.'1'`, not a bare member list; omit if none]
```
