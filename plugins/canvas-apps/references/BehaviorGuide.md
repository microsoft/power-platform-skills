# Canvas App Behavior Acceptance Guide

Use this guide to turn advanced prompt requirements into implementation contracts that can
be verified from the generated YAML. A control, collection, or screen existing is not proof
that the behavior works.

## General acceptance contract

For every requested behavior, the plan must identify:

1. The initial state and visible entry point.
2. The exact control event and state or data operation.
3. The success path and its visible evidence.
4. Any required blocked or boundary path and its visible evidence.
5. The source of truth that subsequent screens, filters, and metrics read.

Keep a single source of truth for each concept. Do not update one collection while a visible
gallery, metric, or selector reads another.

The visible evidence must be reachable in the immediate post-action state. Keep it in the
current viewport, navigate to its bound list/detail, or show an immediately visible control
that opens it. A changed row placed only below a long form is not observable evidence.

## Navigation and action reachability

- Put every primary destination in a repeated navigation region that is visible in the
  initial viewport, or behind an immediately visible menu control.
- Keep record-level management actions on the management row/detail surface or behind a
  visible overflow control. Do not rely on clicking non-interactive text or cards.
- A required action below the fold needs an obvious, working scroll affordance and must not
  be trapped inside nested fixed-height containers.
- Repeat the same destination set and ordering across screens so an evaluator or user does
  not need to rediscover navigation after each action.

## Role-scoped record management and review

A request for a named role to manage all records of the app's primary entity is an
operational lifecycle requirement, not a request for a read-only list. It does not imply
CRUD for supporting entities.

- Provide a reachable management list and a visible way to select a record.
- Provide a correction/update path that loads the selected record, saves changes to the
  shared source, and displays the updated values in the management list.
- Provide remove/cancel with a visible confirmation or cancel path. After confirmation,
  the record must disappear or visibly enter the requested canceled state.
- When review distinguishes final approved records, provide both approve and reject/decline
  decisions unless the request explicitly defines a one-way workflow.
- Keep decision controls together and render the resulting status from the same field they
  mutate. An Approve-only queue is not a complete review workflow when rejected records are
  a meaningful outcome.

## Program periods and recurrence

- Represent quarterly, monthly, annual, cycle, season, or period requirements with a shared
  field or deterministic derivation, not only a heading.
- Give new records the active period and show it in the relevant form, list, detail, or
  review surface.
- When users need to distinguish periods, provide a visible selector or filter and bind it
  directly to the rendered source.
- Use one period meaning everywhere. Do not label a date as a quarter in one screen while
  filtering a different field elsewhere.

## Export and report output

- Give every explicit export, download, print, or report request a visible action.
- Define the eligible-record predicate and output columns exactly. For example, an approved
  list export must exclude pending and rejected records using the same status field shown
  in review.
- Use an output mechanism supported by discovered controls, connectors, and data sources,
  and provide visible evidence that output was prepared or delivered.
- If exact file export is unavailable, label and implement an explicit approximation such
  as a copyable report view. Do not present a notification that claims a file was exported
  when no output exists.

## Operational setup for requested behavior

A prompt can request moving, comparing, ranking, scheduling, or measuring records without
explicitly saying "add a create form." When the generated app uses local/mock data and the
requested behavior needs mutable records to be exercised, provide the minimum visible setup
actions needed to create those records.

- Add only the supporting create actions needed to exercise requested behavior; this is not
  permission to generate universal CRUD.
- For relationship-based features, provide inputs for the entity name, group/team, and
  parent/manager relationship needed to create at least two levels.
- New records must enter the same shared source used by the visualization, metrics,
  selectors, mutations, and snapshots.
- Keep meaningful seed data so the app is useful on first load, but do not make seeded rows
  the only records the user can operate on.
- After creation, show the new record in the core visualization without navigation, reload,
  or app restart.

## Search and filtering

- Bind the visible input or selector directly into the target list's `Items` formula.
- Include every requested searchable field and combine simultaneous filters explicitly.
- Provide a reachable clear/reset action when more than one filter can be active.
- Show the active filter state and a zero-result state; a blank gallery is ambiguous.

## Reordering, moving, and drag interactions

- Define the source item, destination position or group, ordering field, and visible list
  that proves the result.
- Update every affected row when order values must remain unique and contiguous.
- Bind the rendered list to the ordering field with an explicit sort.
- Preserve the changed order when navigating away and back by storing it in the shared
  mutable source, not screen-local initialization.
- Use real drag and drop only when a discovered control exposes that event contract. If it
  does not, plan explicit Move up, Move down, Move to, or Apply reassignment controls and
  mark the interaction as an approximation. Never label click controls as drag handles.

## Limits and validation constraints

- Derive the limit from the same source and predicate used by the visible list or count.
- Enforce the rule twice: disable or explain the unavailable action before submission, and
  guard the mutation event so stale UI state cannot bypass it.
- Define both boundary paths: the last allowed operation succeeds, and the next operation
  is rejected without changing data.
- Display the current count, limit, and rejection reason close to the action.

## Metrics and dashboards

- Derive metrics from the current shared source or a named formula, not a copied value
  initialized during navigation.
- State the exact field semantics, filters, grouping, and denominator.
- Every mutation that should affect a metric must change the source the metric reads.
- For relationship data, calculate layer depth, direct-report counts, and group totals from
  the same current parent/group fields rendered by the hierarchy.
- Show both aggregate values and the requested breakdown. A heading or empty metric card is
  not a metric.
- Provide meaningful zero and empty states; never divide by zero or display a stale seeded
  total after records change.

## Versions and comparison

- A save-version action creates an immutable snapshot with a unique identifier, timestamp,
  and the fields needed for comparison.
- Store version metadata separately from snapshot rows. Copy every compared entity into
  snapshot rows keyed by `VersionId`; do not store a reference to the live collection or
  derive both comparison panels from current state.
- Saving a later version must not mutate the earlier snapshot.
- Version selectors bind to the snapshot source and prevent comparing one version to itself.
- The comparison view identifies both selected versions and renders two populated, labeled
  panels at the same time. When the requirement says side by side, do not replace this with
  a single panel, tabs, or vertically stacked states; choose a wide dashboard composition or
  an intentional horizontal comparison region.
- Derive field-level differences by matching stable entity IDs across the two selected
  snapshot sets. Highlight added, removed, moved, and changed records from that derivation.
- Do not show "no changes" unless the selected snapshots are distinct and the derived
  difference set is actually empty.
- Persistence claims must match the actual source. An in-memory collection persists only
  during the current app session; do not describe it as durable storage.

## Core visualizations

- A named org chart, timeline, comparison, dashboard, board, chart, or map must render bound
  content. A filled rectangle, empty container, disabled input, or heading over blank space
  is a placeholder, not a visualization.
- Provide meaningful first-render data or a visible, truthful empty state with a reachable
  setup action.
- Relationship visualizations must expose the relationship, not only a flat list. Show
  parent/group labels, layer or depth, and a visible reporting/connection treatment.
- Keep required controls outside decorative overlays and ensure empty-state surfaces do not
  cover populated content.

## Category management

- Category creation updates the same shared category source used by forms, filters, and
  management lists.
- Prevent or visibly handle blank and duplicate category names.
- A newly added category must become visible in every requested selector without requiring
  app restart or reseeding.
- Deletion or rename behavior must define what happens to records that reference the
  affected category.

## Leaderboards and ranked lists

- Define the score formula, eligible population, sort direction, tie behavior, and displayed
  rank.
- Sort from the current source rather than storing a separate stale leaderboard.
- Use a deterministic secondary sort for ties.
- Recalculate visibly after any action that changes the ranking inputs.

## Completion rule

If any required success path, boundary path, source-of-truth binding, or visible evidence
cannot be implemented with discovered controls and data sources, mark the action blocked or
an explicit approximation. Do not ship placeholder UI or claim completion.
