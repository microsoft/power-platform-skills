# Canvas App Mutation Behavior Guide

Read this reference when the plan creates, edits, deletes, approves, rejects, categorizes, or otherwise mutates records. Read `${PLUGIN_ROOT}/references/BehaviorCore.md` first.

## Feedback policy

Choose a feedback mode for each user-facing mutation in scope and carry it in its Action Contract and evidence:

- **`Feedback: Preserve`** applies to an existing action when changing its feedback is outside the approved delta. Keep its working success/error handling and source-bound observers, including existing receipt UI if present. Prove every write and preserved field from actual final YAML and trace the existing feedback plus canonical/destination observers for the affected stable ID. A notification alone is not mutation proof. Do not add a result card, per-field display, capture state, reveal behavior, or destination focus just to satisfy a receipt pattern.
- **`Feedback: Receipt`** applies to a new mutation or an approved feedback change. It also applies when feedback must change to make the requested result observable; record that necessity in the allowed changes, and reconcile material UX or scope expansion before implementation. Provide substantive immediate result feedback under the conditional Mutation receipt contract below, not merely static success text, navigation, or a transient notification.
- Internal setup and initialization mutations need no user-facing feedback. They still must leave canonical state and consumers consistent.

A handler repair, new observer, or new screen in an existing app does not by itself authorize redesigning an existing action's feedback. Preserve source identity, correct success/error ordering, and observer consistency in both modes. If existing feedback is misleading or stale because of the requested change, repair that directly coupled defect rather than claiming preservation or silently adding a new interface.

## Directional mutation contracts

Opposing transitions are independent behaviors, even when one form implements both.
Receive/Issue, Increase/Decrease, Credit/Debit, Allocate/Release, Check-in/Check-out, and
Enable/Disable each require separate Action Contract rows and separate concrete
Given/When/Then scenarios.

- A shared form is valid only when the operation selector and amount or value input are
  visible, pointer-selectable, and consumed by the mutation formula. Evidence identifies both values under the action's feedback mode.
- Disable submission whenever the operation or required amount/value is hidden, clipped,
  blank, invalid, unset, or unreachable. Never fall through to a default direction or use
  stale operation state from an earlier interaction.
- Make blank and non-positive amount states representable so the invalid paths can actually
  be exercised. For `ModernNumberInput`, define compatible `Default`, `Min`, and
  `ValidationState` formulas: do not set `Min: =1` when acceptance must enter or reset to
  `0`. Gate on the current `Value`; both `Control.Value <= 0` and
  `Not(Control.Value > 0)` are valid non-positive checks. Show visible validation, and use
  `Reset(Control)` only when its `Default` restores the chosen
  invalid state. `Default: =Blank()` and `Default: =0` are both valid when `Min` permits
  that value and the gate rejects it.
- Reset shared operation state to `Blank()` on entry to the action screen and/or after a
  successful Apply. `App.OnStart` runs for the app session, not for each visit or
  adjustment, so an OnStart-only blank assignment permits a stale direction to carry into
  the next action. Blank-operation acceptance names the actual operation variable and its
  reset event; an amount input's `Default: =Blank()` is not operation-state evidence. If
  Apply clears the current operation, any feedback that displays the completed operation must read completed-operation state rather than the newly blank current state.
- A classic Dropdown with nonempty `Items` needs `AllowEmptySelection: =true` when its
  blank default/reset is used to prove that no operation is selected. For a Combo box,
  use `DefaultSelectedItems: =[]` and verify its empty selection; do not assign
  `AllowEmptySelection` to it. Do not prescribe unsupported empty-selection properties for
  a List box. Prefer an explicit operation variable whenever control semantics are absent
  or uncertain.
- Independent direct actions need no shared operation variable or reset: the identity of
  each action control commits its direction. Each handler still needs its own selected-ID
  and valid-amount gates and its own complete mutation/feedback path.
- For arithmetic pairs, read the canonical old value before writing and encode the direction
  explicitly: increase is `newValue = oldValue + amount`; decrease is
  `newValue = oldValue - amount`. State pairs must likewise assign explicit opposing
  target states rather than toggle implicit state. Read both operands from live state at
  mutation time — the old value from the canonical source and the amount from the input
  control (`Value(txtAmount.Text)` or an `OnChange`-populated staging variable), never from a
  staging variable left at its `App.OnStart` seed.
- Prove each guarded direction with its own literal comparison, such as
  `varOperation = "Receive"` and `varOperation = "Issue"`. A default or `else` arm is not
  directional proof because an unknown or blank value can fall through to it.
- Trace the chosen operation, old value/state, amount when applicable, expected new value/state, and actual canonical post-state. The destination observer must agree with the post-state. Render these values in a receipt only for `Feedback: Receipt`; preserved feedback uses static operand/write evidence and its existing source-bound observers.

## Canonical mutation and evidence contracts

Apply these contracts to every create, edit, delete, relationship change, approval, and
state transition. The lifecycle, field-ledger, and continuation contracts below generalize
the directional rules above to all mutations. The plan and acceptance artifact use additive
ledgers so existing Action Contract columns remain compatible.

### Mutation lifecycle evidence

- Identify the mutation's stable ID from the operation result, selected identity, or existing pre-delete identity. Keep it traceable across the write, feedback, and canonical post-state; a delete proves absence for that same ID. `Feedback: Receipt` additionally captures result/snapshot state as specified below.
- Name the **canonical source** that owns the post-state and the **requested destination**
  where the user expects to use or inspect it after the mutation, such as a list, detail,
  relationship view, review queue, or status board. The canonical and destination observers must trace the same stable ID; any record-bound feedback must agree. Existing generic success text may remain in Preserve mode when the handler and actual source-bound observers supply the identity/post-state proof.
- When canonical source and destination read the same live source, state that no
  synchronization step is needed. When they differ because the destination uses a cache,
  projection, related collection, or external query, name the successful-path
  refresh/requery/update that synchronizes it before evidence is shown.
- Record any existing or approved focus mechanism by stable ID. `Feedback: Preserve` retains it without requiring new selection, highlighting, filtering, or navigation; receipt-mode destination focus is specified below.
- Keep success-only synchronization, focus, navigation, and evidence after the mutation
  succeeds. A failed or cancelled operation must not expose success feedback or move the
  user to a destination that implies success.

### Changed/preserved field ledger

- For each mutation, maintain a field ledger that classifies relevant fields as
  **Changed** or **Preserved**. Include every field/status written by the handler and every
  user-visible or lifecycle-significant field that the operation must retain. For delete,
  record existence as Changed and bind its proof to the deleted stable ID plus canonical
  absence observer.
- A Changed row names the input or transition expression, canonical write target, and proof binding. Every changed field must appear in both the Action Contract write set and proof set. For `Feedback: Preserve`, each field has static write/post-state proof tied to the actual source-bound observer path; it need not gain a new visible per-field control. For `Feedback: Receipt`, each field has a readable receipt binding under the contract below.
- A Preserved row names its canonical pre-state source and preservation mechanism: omit it
  from a partial update, or carry forward that exact canonical value. Do not repopulate a
  preserved field from a control default, stale selection, display text, or parallel
  collection. Name the canonical post-state observation and existing observer path that demonstrate preservation; do not add per-field UI for static preservation evidence.
- The ledger is a contract, not a second mutation schema. It expands the existing
  write-set/proof-set parity rule without changing the meaning of either set.

### Conditional stable-ID continuation

- Include continuation state only when a successful create is intentionally used by a
  later edit, delete, relationship, approval, or state-transition action. Do not add a
  continuation contract for create-only flows or ordinary navigation.
- Capture the created record's returned stable ID and bind the named continuation action
  directly to that ID. The later mutation, its feedback, canonical observer, and requested
  destination must retain the same identity; never recover it from a display name, current
  list position, or implicit default selection.
- Clear continuation identity and mode after the downstream action completes successfully
  or the user cancels it. A failed downstream mutation may retain the ID for retry, but
  must not claim completion or clear the context as if it succeeded.

These contracts can be traced statically through final YAML, but static traceability does
not prove that controls rendered, events fired, external writes succeeded, synchronization
completed, or focus moved at runtime. Keep acceptance labeled
`Runtime evaluation: NOT RUN` until those paths are actually executed in the running app.

## Mutation receipt contract

Apply this section only to `Feedback: Receipt` actions. It defines their immediate result UI; `Feedback: Preserve` is evaluated using the Feedback policy and canonical evidence contracts above.

- Reserve a compact result card, banner, or detail region in the action screen's initial viewport. Hide it until a mutation succeeds.
- In the mutation handler or form success event, capture the returned record (`Patch` result, `Form.LastSubmit`, or connector response), a fresh canonical lookup by returned stable ID, or a pre-delete snapshot before resetting inputs or navigating. Bind the result surface's action and identity to that captured state.
- Define a **write set** for each mutation: every field and status value the handler creates or changes. Define a **proof set** in the Action Contract: the identity plus the write-set values that must be visible after success. For create and edit, the proof set must include every user-entered or user-selected field written by the handler; do not reduce it to fields already convenient to display in a list. For approve, reject, or another transition, include the identity and resulting status. For delete, include the removed identity and action from the captured snapshot.
- Render every proof-set field as labeled, readable content bound to the captured state. A field is not proven by the input before submission, by an agent's remembered value, by hidden state, or by an unlabeled/truncated list cell.
- Each receipt field must expose one unambiguous dynamic value expression, directly or decorated with literal label text. Multiple candidate dynamic values fail as an ambiguous receipt expression; do not guess the intended value.
- A directional receipt shows the chosen operation, old value/state, amount when applicable, expected new value/state, and actual persisted new value/state.
- Keep a directional receipt's operation, old value, amount, expected value, and actual
  value together in one sufficiently sized visible region. Budget the container's height
  from all five labeled rows, gaps, and padding; a visible heading above clipped receipt
  fields is not evidence.
- Keep the result visible until the user dismisses it or begins another mutation. A transient `Notify()` may supplement this surface but cannot replace it.
- Also refresh or update the shared source so lists, filters, metrics, and later screens reflect the mutation. The receipt proves the immediate outcome; it does not replace source-of-truth consistency.
- When the requested destination contains multiple records, select, filter, highlight, or open the returned stable ID on the success path. Focus supplements the receipt and never matches by display text or list position.
- Treat write-set/proof-set parity as a generation invariant. If the handler writes a user-supplied field that the receipt does not render, the mutation is incomplete even when persistence and navigation work.

## Create and edit form lifecycle

- Give every required finite-choice field a directly selectable control. For a short static set, prefer visible radio or button choices, then a dropdown that commits a value by click or tap. Do not use a searchable combobox unless the choice set is large enough to require search or the requirement allows free-form entry.
- Populate finite-choice sources with concrete, visible values, including examples named by the request. Configure the display field correctly and give a required short-choice field a valid initial value when the business rule permits one. Use a blank required placeholder only when an explicit choice is meaningful, and keep every option selectable without typing text or relying on keyboard-only commitment.
- Do not make an optional field block submission. For required fields, keep the submit action reachable and visibly explain what remains invalid.
- Create records with a stable unique ID and write every displayed field to the shared source. Retain that identity across reset and feedback, apply the action's feedback mode, and update the bound list.
- Put a visible Edit action on each manageable row or its immediately reachable detail. Selecting Edit must store the record identity, enter an obvious edit mode, and prepopulate every editable input from that record.
- Save edits by stable ID, preserve fields the user did not change, exit edit mode, and apply the action's feedback mode. The bound list or detail must reflect the updated values. Cancel must leave the source unchanged and clear edit state.
- When create and edit share a form, make mode, selected record, defaults, submit label, save formula, cancel behavior, and reset behavior explicit. Never infer edit mode from a mutable display value such as a name.


## Role-scoped record management and review

A request for a named role to manage all records of the app's primary entity is an operational lifecycle requirement, not a request for a read-only list. It does not imply CRUD for supporting entities.

- Provide a reachable management list and a visible way to select a record.
- Provide a visible Edit action that loads the selected record by stable ID, prepopulates editable fields, saves changes to the shared source, and displays the updated values in the management list.
- Provide remove/cancel with a visible confirmation or cancel path. After confirmation, the record must disappear or visibly enter the requested canceled state.
- When review distinguishes final approved records, provide both approve and reject/decline decisions unless the request explicitly defines a one-way workflow.
- Keep decision controls together on each eligible pending record, or expose one immediately visible Review entry that opens a detail surface containing both decisions. Render the resulting status from the same field they mutate. An Approve-only queue is not a complete review workflow when rejected records are a meaningful outcome, and screen density is not permission to drop one decision.


## Category management

- Category creation updates the same shared category source used by forms, filters, and management lists.
- Prevent or visibly handle blank and duplicate category names.
- A newly added category must become visible in every requested selector without requiring app restart or reseeding.
- Deletion or rename behavior must define what happens to records that reference the affected category.
