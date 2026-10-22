# CREATE Navigation and State

The coordinator owns shared bindings and initialization. Builders implement their assigned transitions, report missing shared decisions, and do not invent shared globals or reseed data.

## Context-preserving round trips

Before dispatch, translate the screen map's round trips into bindings with explicit ownership: typed stable record identity, originating destination, filters/day, return context, and preserved/reset values. Use the smallest design that satisfies the graph; a universal navigation stack is not required.

Trace nested visits, not just each forward Navigate. For list -> details -> related profile -> details -> list, opening the profile must not destroy the details screen's original return destination. If the profile opens a different related record, returning must restore the intended identity as well as the screen. A single mutable return variable cannot represent multiple outstanding origins.

Direct header navigation and contextual Back are different actions. Define their state effects explicitly; a header entry that never records origin must not rely on a stale contextual return value. Clear or preserve selection according to the declared journey, not on every OnVisible by habit.

Use typed state names/defaults from bindings. `Set` writes app-wide state and `UpdateContext` writes screen-local state; neither scope is a history stack or an automatic restoration mechanism. Do not assume Back restores arbitrary global selection mutations.

For mutation-to-destination navigation, set the destination day/filter from the affected record when the journey promises to show it; do not leave the destination on its initial default day. Distinguish this continuation from an ordinary header visit that preserves the user's chosen filter. Built-in `Back()` may preserve destination history, but record/filter context still needs explicit ownership.

Reuse `[working directory]/Screen1.pa.yaml` with key `Screen1` for the landing screen and set `App.StartScreen` to `=Screen1`. Never Navigate from App.OnStart or the landing screen's OnVisible. Additional screens need distinct paths/keys/prefixes. Shared initialization runs once per intended app lifecycle; returning to a screen must not clear or reseed user data.

## Reachable state producers

For each loading, empty, unavailable, confirmation, success or failure surface, identify the actual state producers and consumers:

- Initial value and the event/operation that enters the state.
- Successful outcome and the bound source/identity displayed.
- Error/cancel/invalid transition, including what remains unchanged.
- Recovery/retry/reset event and its effect on pending selections/messages.

Do not unconditionally mark data available after a restore that can fail. Do not leave a loading flag permanently true or show a success receipt after an error. A missing record is different from a blank optional field and should not silently resolve to the first record.

## Canonical derivation and record scope

`QACHK-SHARED-SOURCE-DERIVATION`: search, filters, ordering, alerts, metrics, badges, visualizations and reports derive from the same canonical source and field semantics that mutations update. Do not use copied counters, seed tables or parallel screen-local collections as current truth. An intentional projection/cache needs an explicit refresh/update on every successful relevant mutation before its evidence appears. An immutable version snapshot is separate only with approved snapshot identity/comparison semantics.

Sort dates/times using typed values or validated canonical keys, not localized display strings. Counts and empty states use the full eligible/filtered source, not lazy gallery materialization. Use shared derived expressions where they prevent observer predicates from drifting.

Nested Filter/LookUp/derived-table expressions need explicit aliases when scope is ambiguous. An alias inside Filter does not extend into a separate AddColumns expression; alias the table consumed by AddColumns. New column names use identifier syntax, not obsolete quoted strings:

```powerfx
AddColumns(
    Filter(colLinks, OwnerId = varOwnerId) As link,
    Related,
    LookUp(colRecords As record, record.ID = link.RecordId)
)
```

Use actual app names/types and follow the derived record into its labels/events. Do not assume inner ThisRecord refers to the outer entity.

Use `${PLUGIN_ROOT}/references/CreateConformance.md` for cross-screen inspection and evidence. Every navigation destination must exist at completion; intermediate pending destinations follow its compile policy.
