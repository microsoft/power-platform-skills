# CREATE Plan Index Artifact

Project a validated CREATE PlanModel into the compatible `[working directory]/canvas-app-plan.md` index. Keep these headings and dispatch columns exact.

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

## State-Driven Surface Visibility

| Surface key | Owner screen | Surface control | State predicate | Visible and hidden states |
| ----------- | ------------ | --------------- | --------------- | ------------------------- |
| [stable surface identifier] | [Screen] | [Container/card/panel control] | [Exact `=state predicate`] | [State where the surface appears; state where it is hidden] |

[Include a row only when the plan requires a whole UI surface to appear or disappear
according to app state. The named control is the surface whose `Visible` property owns the
disclosure, not a child control. Omit always-visible surfaces, navigation-based disclosure,
child-only visibility, and visibility not required by the plan. An exact
`Surface.Visible=state predicate` declaration in an Action Contract's
`Observer and evidence` cell is the established compact form of the same contract; do not
duplicate it in this table.]

## Action Contracts

| Requested action            | Preconditions                             | Entry point                            | Owner screen | Control and event                     | Source and stable ID                          | Transition and postcondition                 | Mutation write set                   | Receipt proof set                                          | Observer and evidence                                              |
| --------------------------- | ----------------------------------------- | -------------------------------------- | ------------ | ------------------------------------- | --------------------------------------------- | -------------------------------------------- | ------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| [Concrete requested action] | [Eligible state and enabled/visible rule] | [Visible control the user starts from] | [Screen]     | [PrefixedControl.OnSelect / OnChange] | [Named source and immutable identity, or N/A] | [Exact operation and resulting source state] | [Every changed field/status, or N/A] | [Identity plus every value rendered after success, or N/A] | [Formula/control reading the post-state plus in-viewport evidence] |

[Include only actions stated by the request or approved plan and apply the relevant
acceptance paths from `${PLUGIN_ROOT}/references/BehaviorCore.md` and the applicable capability
reference. Do not infer universal CRUD for
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

## Mutation Lifecycle Evidence

| Action | Receipt binding | Canonical source and observer | Requested destination and observer | Stable ID continuity | Synchronization when sources differ | Destination focus |
| ------ | --------------- | ----------------------------- | ---------------------------------- | -------------------- | ----------------------------------- | ----------------- |
| [Mutation Action Contract] | [Returned record/ID or deletion snapshot plus receipt control] | [Authoritative source and exact post-state observer] | [Requested list/detail/review/relationship/status surface and exact observer] | [Same immutable ID across operation, receipt, canonical observer, and destination] | [Exact success-path refresh/requery/cache update, or N/A — same live source] | [Exact select/filter/highlight/open-by-ID behavior, or N/A — single-record destination] |

[Include one row per mutation. This lifecycle ledger supplements, rather than replaces, the
Action Contract. The requested destination is the surface where the requirement expects
the result to be usable or inspectable. When it reads a different cache, projection,
related collection, or external query from the canonical source, name the synchronization
event that runs only after success. A multi-record destination must focus the same stable
ID; display text and list position are not identity.]

## Mutation Field Ledger

| Action | Field | Classification | Canonical pre-state or input | Write or preservation mechanism | Receipt/proof binding | Post-state observer |
| ------ | ----- | -------------- | ---------------------------- | ------------------------------- | --------------------- | ------------------- |
| [Mutation Action Contract] | [Field/status] | Changed / Preserved | [Live input/transition expression, or canonical pre-state lookup] | [Exact write target/expression, omitted partial-update field, or canonical carry-forward] | [Labeled receipt binding for Changed; preservation evidence for Preserved] | [Exact canonical/destination formula reading the same ID and field] |

[Include every field/status written by the handler and every user-visible or
lifecycle-significant field that must survive it. This field ledger expands the existing
write-set/proof-set contract: each Changed row appears in both sets and has one readable
proof binding. Each Preserved row names how the canonical value survives and where the
post-state proves it; never source preservation from a default, display text, stale
selection, or parallel collection.]

## Continuation Contracts

[Include this conditional continuation section only when a create intentionally feeds a later edit, delete,
relationship, approval, or state-transition action. Otherwise omit it.]

| Create action | Returned stable-ID binding | Downstream action and event | Downstream target binding | Successful-completion clear | Cancellation clear |
| ------------- | -------------------------- | --------------------------- | ------------------------- | ---------------------------- | ------------------ |
| [Create Action Contract] | [Exact captured returned ID] | [Later mutation and reachable control event] | [Exact lookup/target using that ID] | [Exact successful downstream event clearing ID and mode] | [Exact cancel event clearing ID and mode without mutation] |

[The continuation action, later mutation receipt, observers, and requested destination
must use the captured returned ID. Never recover the created record from display text,
list position, or implicit selection. A downstream failure may retain the ID for retry,
but completion and cancellation are the only clearing paths.]

## Functional Test Matrix

| Scenario                 | Given                                   | When                                | Then                         | Evidence surface                              | Boundary or negative case                                     |
| ------------------------ | --------------------------------------- | ----------------------------------- | ---------------------------- | --------------------------------------------- | ------------------------------------------------------------- |
| [Action-path identifier] | [Deterministic seed and eligible state] | [Exact visible control interaction] | [Exact source postcondition] | [Observer formula/control and receipt fields] | [Blocked, empty, invalid, clear, or failure behavior, or N/A] |

[Include at least one success scenario for every Action Contract and one row for every
required boundary or negative path. Use concrete seeded IDs and values when the app uses
local/mock data. Every Then clause must be provable from the named source through the
Evidence surface; do not use appearance, navigation, or notification as proof. Opposing
transitions require separate scenarios with the same concrete old value and amount so
their expected results prove both arithmetic directions. When Continuation Contracts are
present, include returned-ID-bound downstream completion and cancellation scenarios; both
must prove continuation state clears, while cancellation leaves the source unchanged.]

## Directional Mutation Evidence

[Include this section when the Action Contracts contain both directions of Receive/Issue,
Increase/Decrease, Credit/Debit, Allocate/Release, Check-in/Check-out, or Enable/Disable.
Use one row per pair. Declare exact compile-ready planned
`Control.Property: =formula` bindings; final acceptance compares the implemented YAML to
this contract. The selected-record state must be the exact stable-ID target used by both
mutations. Receipt bindings must be separated with `<br>` and include
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
unless its empty-selection semantics are configured and evidenced. Declare compatible
NumberInput `Default`, `Min`, current `Value` gate, visible validation, and reset behavior;
final validation cross-checks those planned bindings against implemented YAML. Blank and
non-positive values must be representable. `Default: =0` is valid with `Min <= 0`, a
rejecting gate, and Reset that restores zero. An `OnChange`-staged amount is subject to the
same input validity checks. Accept either `value <= 0` or `Not(value > 0)` for the
non-positive gate. For a classic operation Dropdown with nonempty `Items`, require
`AllowEmptySelection: =true`; for a Combo box require `DefaultSelectedItems: =[]`. Do not
prescribe an unsupported empty-selection property for a List box, and prefer explicit
operation state when control semantics are uncertain. Every direction must have its own
literal guard; default/else arms do not prove a direction. If success resets current
operation state, the receipt operation binding must use a captured completed-operation
value.
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
| [Receive/Issue] | [e.g. `varSelectedId`; planned YAML must blank-reset, row-assign, and consistently consume it] | [e.g. `Adjust.OnVisible: =Set(varOperation, Blank())` or exact successful-Apply reset] | [e.g. `btnApply.DisplayMode: =If(IsBlank(varSelectedId) \|\| IsBlank(varOperation) \|\| IsBlank(numAmount.Value) \|\| numAmount.Value <= 0, DisplayMode.Disabled, DisplayMode.Edit)`] | [exact `Control.Property: =formula`] | [exact `Control.Property: =formula`] | [exact `Control.Property: =formula`] | [e.g. `operation=lblReceiptOperation.Text: =varLastOperation<br>old=lblReceiptOld.Text: =varOldQuantity<br>amount=lblReceiptAmount.Text: =varAmount<br>expected=lblReceiptExpected.Text: =varExpectedQuantity<br>actual=lblReceiptActual.Text: =varLastMutation.Quantity`] |

## Compound Sequence Evidence

[Include this section when both directions of an opposing pair act on the **same record
type**. One row per pair. It proves the second operation reads the value the first mutation
already persisted, not the original — the runtime failure a single-operation scenario cannot
catch. The `Second-op old-value binding` must declare the exact compile-ready planned
`Control.Property: =formula` that sources the old value for the second operation from the
canonical source (e.g. a `LookUp` over the patched collection), not a stale selection
snapshot. Final acceptance compares the implemented YAML to this contract. The validator
does not machine-check this table; it is a required reviewer/authoring proof.]

| Pair | Same-record ID expression | Sequence (start -> op1 amount -> mid -> op2 amount -> end) | Second-op old-value binding (reads mutated canonical source) |
| ---- | ------------------------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| [Receive/Issue] | [e.g. `varSelectedInventoryId`] | [e.g. `Qty 10 -> Receive 3 -> 13 -> Issue 2 -> 11`] | [exact `Control.Property: =formula` reading canonical source, e.g. `btnIssue.OnSelect: =Set(varOldQuantity, LookUp(colInventory, ID = varSelectedInventoryId).Quantity); ...`] |

## Data Entry Label Contracts

| Required input | Persistent visible label | Shared field region |
| -------------- | ------------------------ | ------------------- |
| [classic/modern TextInput, NumberInput, Radio, DropDown, or ComboBox] | [exact sibling label binding; native visible Label only for ModernNumberInput] | [immediate parent field row/group containing both] |

[Include every data-entry control consumed by an accepted action. AccessibleLabel and
HintText do not replace a persistent visible field name. Modern variants and optional
versions are in scope.]

## Layout Budget Contracts

| Screen / container | Applied policies | Instance-specific measurements | Protected controls |
| ------------------ | ---------------- | ------------------------------ | ------------------ |
| [screen / container] | [ResponsiveRoot, NestedVisibleChildren, TouchTarget44, HorizontalReflow, FieldGroups, GalleryRows, ScrollableRoot, LongestLabelFit, ContrastPairs] | [available width, longest label, gallery Height/TemplateSize, named color pair, or N/A] | [amount, Save/Apply, receipt operation/old/amount/expected/actual] |

[Name the policies from `${PLUGIN_ROOT}/references/LayoutPolicies.md`. Record only measurements unique
to this screen. Include every nested AutoLayout container that participates in a
coordinated breakpoint. Logical canvas/root width may remain at design width in a
scale-to-fit host, so the wide/default field and action composition must fit a static
bound, wrap, deliberately scroll, or stack without relying on narrow-branch activation.]

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
