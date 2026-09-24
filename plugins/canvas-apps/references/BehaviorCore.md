# Canvas App Behavior Acceptance Guide

Use this guide to turn advanced prompt requirements into implementation contracts that can be verified from the generated YAML. A control, collection, or screen existing is not proof that the behavior works.

## Functional capability inventory

Canvas apps are extensible through controls, Power Fx, data sources, connectors, components, and device capabilities, so no static list can enumerate every possible app. Classify every requested requirement into the applicable capability families below and create an Action Contract for every behavior in scope:

1. **App shell and navigation** — start screen, menus, tabs, deep links, back behavior, responsive composition, accessibility, loading, empty, error, and permission states.
2. **Data lifecycle** — create, read, select, view details, edit, save, cancel, delete, restore, validate, deduplicate, and preserve stable identity.
3. **Data exploration** — search, filter, sort, group, paginate, select, clear, drill down, and show active criteria and zero-result states.
4. **Workflow and review** — status transitions, approve, reject, assign, escalate, submit, reopen, confirm, enforce eligibility, and expose role-specific actions.
5. **Relationships and hierarchy** — parent/child, team membership, ownership, dependencies, trees, org charts, and reassignment.
6. **Time and scheduling** — dates, calendars, periods, recurrence, deadlines, timers, reminders, and time-zone-aware display.
7. **Analytics and visualization** — counts, aggregates, KPIs, charts, dashboards, boards, maps, rankings, comparisons, and snapshots.
8. **Files, media, and device input** — attachments, images, camera, barcode, audio, signatures, location, sensors, and import/export.
9. **Integration and automation** — data-source CRUD, connectors, APIs, flows, notifications, report preparation, refresh, and error handling.
10. **Security, persistence, and resilience** — role visibility, data-source permissions, session versus durable storage, offline behavior, concurrency, retry, and truthful failure states.

Implement only capabilities supported by discovered controls, data sources, APIs, and the approved scope. If exact behavior is unavailable, use an explicitly approved approximation or mark it blocked. Never substitute static UI for a behavior from this inventory.

## Functional-first priority

Allocate implementation effort in this order:

1. Shared data model, stable IDs, source-of-truth fields, and valid seed data.
2. Every requested action's complete state transition and boundary behavior.
3. Observable postconditions and cross-screen source consistency.
4. Reachability, responsive layout, accessibility, and truthful empty/error states.
5. Visual polish, decorative media, and optional secondary content.

When control or screen budgets are tight, remove decoration and consolidate presentation before reducing behavior. An attractive control that does not perform its named action is a defect, not partial credit.

## General acceptance contract

For every requested behavior, the plan must identify:

1. The initial state and visible entry point.
2. The exact source of truth and stable record identity.
3. The exact control event and state or data operation.
4. The postcondition in that source and the observer formula that reads it.
5. The success path and its visible evidence.
6. Any required blocked or boundary path and its visible evidence.

Keep a single source of truth for each concept. Do not update one collection while a visible gallery, metric, or selector reads another.

Every user-requested or plan-declared mutation needs an in-viewport result surface bound to the exact affected record or a snapshot captured by the handler. Internal setup and initialization mutations do not require user-facing receipts. Show the record identity, action, and fields needed to verify the requested outcome. A list, detail screen, or metric must also read the changed source, but list position is secondary evidence: a success notification, navigation alone, or a changed row somewhere in a long list does not satisfy the contract. Do not depend on programmatically scrolling a Gallery to an arbitrary record; Canvas galleries do not provide a reliable general reveal contract.

## Closed-loop state transitions

Every action must form one traceable loop:

`reachable entry point -> enabled event -> source operation -> postcondition -> observer -> visible evidence`

- Name the precondition and eligibility predicate. The control's `Visible` and `DisplayMode` formulas must permit that state.
- Mutate the same source and field that the observer reads. A status button that patches `ReviewState` while the badge renders `Status` is broken even when both formulas compile.
- Identify records by an immutable stable ID. Capture `ThisItem.ID` or the selected ID before mutation and look up the target from the source; do not infer identity from a display name. The `LookUp`/`Filter` that locates the target must compare the key field against the raw selected/context value with no concatenation, prefix, suffix, casing, or reshaping (`= Selected.ID & " ID"`, `"ITEM-" & Selected.ID`, `Left(...)`, `Trim(...)`) unless the documented schema stores the key that way. A reshaped key is a **phantom LookUp key**: it matches nothing, so `LookUp` returns `Blank()` and the `Patch` silently mutates no row even though the formula compiles.
- When an action depends on a prior record selection, use one nullable selected-record ID
  as the selection source of truth. Initialize or reset it to `Blank()`, assign it from the
  row's selection event, and use that same ID for the selected-record display, eligibility
  gate, mutation `LookUp`, receipt, and compound sequence evidence. This is the default
  pattern for proving an incomplete state. A direct row action may instead use that row's
  stable `ThisItem` identity without introducing separate selection state.
  `Control.Selected` / `.Selected.*` on a Gallery, Dropdown, List box, or Combo box is not
  an empty-selection contract: a control with nonempty `Items` can expose an
  automatic/default selection before the user chooses one. Use it as incomplete-state
  evidence only when the control's empty-selection semantics are explicitly configured and
  evidenced.
- Feed mutations from live input, not dead state. Any variable that is meant to carry a user-entered or user-selected value (`varAmount`, `varOldQuantity`, a staging variable) must be written from its input control at the moment of input — an `OnChange` that runs `Set(varStaging, Control.Value)`/`Set(varStaging, Control.Selected)`, or an inline `Control.Value`/`Control.Selected` read inside the handler. A staging variable initialized only in `App.OnStart` or `Screen.OnVisible` and never re-written from an input is **dead**: it stays at its seed (`0`, `Blank()`), so the mutation silently computes against the seed while still compiling and still passing sign/direction checks. Prefer reading the input directly at mutation time (`Value(txtAmount.Text)`, `cmbItem.Selected.ID`).
  An amount staged by `OnChange` is live, but not automatically valid: the input's
  `Default`, `Min`, and current `Value` must still make invalid states representable, and
  the submission gate must reject the staged/current blank or non-positive value.
- Use the mutation result or a fresh lookup by ID for the receipt. Do not read a potentially stale gallery `ThisItem` after `Patch` and assume it contains the new value.
- Make success contingent on the operation. Reset inputs, exit edit mode, navigate, and reveal success evidence only on the success path.
- Bind every downstream list, filter, metric, export, and decision surface to the same updated source or refresh the external source before observing it.
- Define a deterministic Given/When/Then scenario for the success path and each required negative or boundary path. If the generated formulas cannot satisfy that scenario by inspection, the action is incomplete.


## Navigation and action reachability

- Put every primary destination in a repeated navigation region that is visible in the initial viewport, or behind an immediately visible menu control.
- Keep record-level management actions on the management row/detail surface or behind a visible overflow control. Do not rely on clicking non-interactive text or cards.
- Render each primary record's canonical human-readable identity, such as the full colleague, customer, or item name, as visible text on its row or immediately reachable detail. Avatar initials, icons, IDs, accessible labels, and agent-inferred names may supplement this text but cannot replace it.
- On phone layouts, keep the record identity, status, and required lifecycle actions in the visible row or its immediately reachable detail. Stack the row or use a visible overflow control; never leave Edit, approve, reject, or remove in desktop columns clipped beyond the canvas width.
- A required action below the fold needs an obvious, working scroll affordance and must not be trapped inside nested fixed-height containers.
- Repeat the same destination set and ordering across screens so an evaluator or user does not need to rediscover navigation after each action.

## Record presentation contract

- For every repeated card, row, or immediately reachable detail, enumerate the fields the
  requirements expect users to see. Render each field through a visible control bound to
  the current record and keep that control inside the record surface.
- The canonical identity is mandatory, but it is not sufficient when the request also
  names people, time ranges, descriptions, statuses, or other details. A time-only card,
  icon, tooltip, accessible label, hidden control, or clipped text does not prove those
  fields are present.
- A combined text control may render several fields only when its formula references every
  required source field and the complete value fits or wraps in the normal layout.
- After create or edit, update or refresh the source used by the record surface so the
  required field bindings immediately show the new values without a manual refresh.


## Completion rule

If any required success path, boundary path, source-of-truth binding, or visible evidence cannot be implemented with discovered controls and data sources, mark the action blocked or an explicit approximation. Do not ship placeholder UI or claim completion.
