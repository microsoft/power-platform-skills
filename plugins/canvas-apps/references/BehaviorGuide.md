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

Every mutation needs an in-viewport result surface bound to the exact affected record or a snapshot captured by the handler. Show the record identity, action, and fields needed to verify the requested outcome. A list, detail screen, or metric must also read the changed source, but list position is secondary evidence: a success notification, navigation alone, or a changed row somewhere in a long list does not satisfy the contract. Do not depend on programmatically scrolling a Gallery to an arbitrary record; Canvas galleries do not provide a reliable general reveal contract.

## Closed-loop state transitions

Every action must form one traceable loop:

`reachable entry point -> enabled event -> source operation -> postcondition -> observer -> visible evidence`

- Name the precondition and eligibility predicate. The control's `Visible` and `DisplayMode` formulas must permit that state.
- Mutate the same source and field that the observer reads. A status button that patches `ReviewState` while the badge renders `Status` is broken even when both formulas compile.
- Identify records by an immutable stable ID. Capture `ThisItem.ID` or the selected ID before mutation and look up the target from the source; do not infer identity from a display name.
- Use the mutation result or a fresh lookup by ID for the receipt. Do not read a potentially stale gallery `ThisItem` after `Patch` and assume it contains the new value.
- Make success contingent on the operation. Reset inputs, exit edit mode, navigate, and reveal success evidence only on the success path.
- Bind every downstream list, filter, metric, export, and decision surface to the same updated source or refresh the external source before observing it.
- Define a deterministic Given/When/Then scenario for the success path and each required negative or boundary path. If the generated formulas cannot satisfy that scenario by inspection, the action is incomplete.

## Mutation receipt contract

- Reserve a compact result card, banner, or detail region in the action screen's initial viewport. Hide it until a mutation succeeds.
- In the mutation handler or form success event, capture the returned record, stable ID, or a deletion snapshot before resetting inputs or navigating. Bind the result surface to that captured state.
- Define a **write set** for each mutation: every field and status value the handler creates or changes. Define a **proof set** in the Action Contract: the identity plus the write-set values that must be visible after success. For create and edit, the proof set must include every user-entered or user-selected field written by the handler; do not reduce it to fields already convenient to display in a list. For approve, reject, or another transition, include the identity and resulting status. For delete, include the removed identity and action from the captured snapshot.
- Render every proof-set field as labeled, readable content bound to the captured state. A field is not proven by the input before submission, by an agent's remembered value, by hidden state, or by an unlabeled/truncated list cell.
- Keep the result visible until the user dismisses it or begins another mutation. A transient `Notify()` may supplement this surface but cannot replace it.
- Also refresh or update the shared source so lists, filters, metrics, and later screens reflect the mutation. The receipt proves the immediate outcome; it does not replace source-of-truth consistency.
- Treat write-set/proof-set parity as a generation invariant. If the handler writes a user-supplied field that the receipt does not render, the mutation is incomplete even when persistence and navigation work.

## Create and edit form lifecycle

- Give every required finite-choice field a directly selectable control. For a short static set, prefer visible radio or button choices, then a dropdown that commits a value by click or tap. Do not use a searchable combobox unless the choice set is large enough to require search or the requirement allows free-form entry.
- Populate finite-choice sources with concrete, visible values, including examples named by the request. Configure the display field correctly and give a required short-choice field a valid initial value when the business rule permits one. Use a blank required placeholder only when an explicit choice is meaningful, and keep every option selectable without typing text or relying on keyboard-only commitment.
- Do not make an optional field block submission. For required fields, keep the submit action reachable and visibly explain what remains invalid.
- Create records with a stable unique ID and write every displayed field to the shared source. Capture the created record or its ID before resetting the form and show the required mutation receipt with labeled bindings for every submitted visible field. The bound list must also update; sorting, selecting, highlighting, or filtering the new ID can reinforce the receipt but cannot replace it.
- Put a visible Edit action on each manageable row or its immediately reachable detail. Selecting Edit must store the record identity, enter an obvious edit mode, and prepopulate every editable input from that record.
- Save edits by stable ID, preserve fields the user did not change, exit edit mode, and show the required mutation receipt with the updated values. The bound list or detail must also reflect them. Cancel must leave the source unchanged and clear edit state.
- When create and edit share a form, make mode, selected record, defaults, submit label, save formula, cancel behavior, and reset behavior explicit. Never infer edit mode from a mutable display value such as a name.

## Navigation and action reachability

- Put every primary destination in a repeated navigation region that is visible in the initial viewport, or behind an immediately visible menu control.
- Keep record-level management actions on the management row/detail surface or behind a visible overflow control. Do not rely on clicking non-interactive text or cards.
- Render each primary record's canonical human-readable identity, such as the full colleague, customer, or item name, as visible text on its row or immediately reachable detail. Avatar initials, icons, IDs, accessible labels, and agent-inferred names may supplement this text but cannot replace it.
- On phone layouts, keep the record identity, status, and required lifecycle actions in the visible row or its immediately reachable detail. Stack the row or use a visible overflow control; never leave Edit, approve, reject, or remove in desktop columns clipped beyond the canvas width.
- A required action below the fold needs an obvious, working scroll affordance and must not be trapped inside nested fixed-height containers.
- Repeat the same destination set and ordering across screens so an evaluator or user does not need to rediscover navigation after each action.

## Role-scoped record management and review

A request for a named role to manage all records of the app's primary entity is an operational lifecycle requirement, not a request for a read-only list. It does not imply CRUD for supporting entities.

- Provide a reachable management list and a visible way to select a record.
- Provide a visible Edit action that loads the selected record by stable ID, prepopulates editable fields, saves changes to the shared source, and displays the updated values in the management list.
- Provide remove/cancel with a visible confirmation or cancel path. After confirmation, the record must disappear or visibly enter the requested canceled state.
- When review distinguishes final approved records, provide both approve and reject/decline decisions unless the request explicitly defines a one-way workflow.
- Keep decision controls together on each eligible pending record, or expose one immediately visible Review entry that opens a detail surface containing both decisions. Render the resulting status from the same field they mutate. An Approve-only queue is not a complete review workflow when rejected records are a meaningful outcome, and screen density is not permission to drop one decision.

## Program periods and recurrence

- Represent quarterly, monthly, annual, cycle, season, or period requirements with a shared field or deterministic derivation, not only a heading.
- Give new records the active period and show it in the relevant form, list, detail, or review surface.
- When users need to distinguish periods, provide a visible selector or filter and bind it directly to the rendered source.
- Use one period meaning everywhere. Do not label a date as a quarter in one screen while filtering a different field elsewhere.

## Export and report output

- Give every explicit export, download, print, or report request a visible action.
- Define the eligible-record predicate and output columns exactly. For example, an approved list export must exclude pending and rejected records using the same status field shown in review.
- Use an output mechanism supported by discovered controls, connectors, and data sources, and provide visible evidence that output was prepared or delivered.
- If exact file export is unavailable, label and implement an explicit approximation such as a copyable report view. Do not present a notification that claims a file was exported when no output exists.

## Operational setup for requested behavior

A prompt can request moving, comparing, ranking, scheduling, or measuring records without explicitly saying "add a create form." When the generated app uses local/mock data and the requested behavior needs mutable records to be exercised, provide the minimum visible setup actions needed to create those records.

- Add only the supporting create actions needed to exercise requested behavior; this is not permission to generate universal CRUD.
- For relationship-based features, provide inputs for the entity name, group/team, and parent/manager relationship needed to create at least two levels.
- New records must enter the same shared source used by the visualization, metrics, selectors, mutations, and snapshots.
- Keep meaningful seed data so the app is useful on first load, but do not make seeded rows the only records the user can operate on.
- After creation, show the new record in the core visualization without navigation, reload, or app restart.

## Search and filtering

- Bind the visible input or selector directly into the target list's `Items` formula.
- Include every requested searchable field and combine simultaneous filters explicitly.
- Provide a reachable clear/reset action when more than one filter can be active.
- Show the active filter state and a zero-result state; a blank gallery is ambiguous.
- For six or fewer static filter choices, prefer visible choice buttons or radio controls. Use a dropdown only when the current control definition exposes a pointer-committed selection contract, and keep its `Items` shape, display formula, selected-value formula, and target predicate type-compatible.
- Verify filtering with at least two matching records and one non-matching record. Selecting one criterion must leave all matching records visible and hide the non-matching record; clearing it must restore the full eligible set.

## Reordering, moving, and drag interactions

- Define the source item, destination position or group, ordering field, and visible list that proves the result.
- Update every affected row when order values must remain unique and contiguous.
- Bind the rendered list to the ordering field with an explicit sort.
- Preserve the changed order when navigating away and back by storing it in the shared mutable source, not screen-local initialization.
- Use real drag and drop only when a discovered control exposes that event contract. If it does not, plan explicit Move up, Move down, Move to, or Apply reassignment controls and mark the interaction as an approximation. Never label click controls as drag handles.

## Limits and validation constraints

- Derive the limit from the same source and predicate used by the visible list or count.
- Enforce the rule twice: disable or explain the unavailable action before submission, and guard the mutation event so stale UI state cannot bypass it.
- Define both boundary paths: the last allowed operation succeeds, and the next operation is rejected without changing data.
- Display the current count, limit, and rejection reason close to the action.

## Metrics and dashboards

- Derive metrics from the current shared source or a named formula, not a copied value initialized during navigation.
- State the exact field semantics, filters, grouping, and denominator.
- Every mutation that should affect a metric must change the source the metric reads.
- For relationship data, calculate layer depth, direct-report counts, and group totals from the same current parent/group fields rendered by the hierarchy.
- Show both aggregate values and the requested breakdown. A heading or empty metric card is not a metric.
- Provide meaningful zero and empty states; never divide by zero or display a stale seeded total after records change.

## Versions and comparison

- A save-version action creates an immutable snapshot with a unique identifier, timestamp, and the fields needed for comparison.
- Store version metadata separately from snapshot rows. Copy every compared entity into snapshot rows keyed by `VersionId`; do not store a reference to the live collection or derive both comparison panels from current state.
- Saving a later version must not mutate the earlier snapshot.
- Version selectors bind to the snapshot source and prevent comparing one version to itself.
- The comparison view identifies both selected versions and renders two populated, labeled panels at the same time. When the requirement says side by side, do not replace this with a single panel, tabs, or vertically stacked states; choose a wide dashboard composition or an intentional horizontal comparison region.
- Derive field-level differences by matching stable entity IDs across the two selected snapshot sets. Highlight added, removed, moved, and changed records from that derivation.
- Do not show "no changes" unless the selected snapshots are distinct and the derived difference set is actually empty.
- Persistence claims must match the actual source. An in-memory collection persists only during the current app session; do not describe it as durable storage.

## Core visualizations

- A named org chart, timeline, comparison, dashboard, board, chart, or map must render bound content. A filled rectangle, empty container, disabled input, or heading over blank space is a placeholder, not a visualization.
- Provide meaningful first-render data or a visible, truthful empty state with a reachable setup action.
- Relationship visualizations must expose the relationship, not only a flat list. Show parent/group labels, layer or depth, and a visible reporting/connection treatment.
- Keep required controls outside decorative overlays and ensure empty-state surfaces do not cover populated content.

## Category management

- Category creation updates the same shared category source used by forms, filters, and management lists.
- Prevent or visibly handle blank and duplicate category names.
- A newly added category must become visible in every requested selector without requiring app restart or reseeding.
- Deletion or rename behavior must define what happens to records that reference the affected category.

## Leaderboards and ranked lists

- Define the score formula, eligible population, sort direction, tie behavior, and displayed rank.
- Sort from the current source rather than storing a separate stale leaderboard.
- Use a deterministic secondary sort for ties.
- Recalculate visibly after any action that changes the ranking inputs.

## Completion rule

If any required success path, boundary path, source-of-truth binding, or visible evidence cannot be implemented with discovered controls and data sources, mark the action blocked or an explicit approximation. Do not ship placeholder UI or claim completion.
