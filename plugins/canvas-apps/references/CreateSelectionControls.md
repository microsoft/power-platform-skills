# CREATE Selection and Filtering

Use the direct description of the selected control, not a property name remembered from a similar one. Preserve the approved interaction and required fields.

## Selection contract

Keep the `Items` record shape, per-item display expression, default shape, selected output and consuming predicate type-compatible. A control with populated Items is incomplete if options render blank or click/tap does not commit the selection.

`QACHK-ITEM-DISPLAY-TEXT`: per-row display and key properties use the documented record scope. Where `ThisItem.Value` is the actual field, `ItemDisplayText: =ThisItem.Value` reads it; `ItemDisplayText: ="Value"` repeats a constant. Apply the same rule to ItemKey. Omit an explicit display mapping only when the described single-column-table behavior supplies it correctly.

Settable inputs are not automatically readable outputs. If `Items` is not exposed as an output, `Default: =LookUp(Self.Items, ...)` is invalid. Derive the correctly typed default directly from the canonical Items source expression instead. A Record default is not interchangeable with its display text.

For short finite choices, use visible radio/buttons or a dropdown that commits by click/tap. Do not substitute searchable/free-form entry or keyboard-only commitment unless requested. Apply the core's persistent field-label rule.

## Blank, change and reset

An automatic first selection is not evidence that the user selected a record. Where explicit selection is required, use the documented empty-selection semantics or owned nullable selection state, and gate the action accordingly. Do not assign another control's empty-selection property by analogy.

Initialize to a valid choice only when the requirement allows it. Otherwise keep the incomplete state reachable and visibly explain validation. Trace `Reset(control)` to its actual Default; reset does not mean blank unless the default and control semantics make it so. Reset dependent state when its parent choice changes.

Read live input in the handler or ensure its OnChange actually updates the intended staging value. Check when the described output changes; a delayed/focus-out output must not silently leave submission using an old value. Do not invent an event to compensate.

## Filtering and ordering

- For source-backed categories and slots, derive finite filter choices from the canonical source or its approved vocabulary, not a separately invented list. Keep display labels separate from typed filter keys. `"09:00"` does not equal `"9:00 AM"`; normalize both sides explicitly or select the stored canonical value. Verify every mock-data option has the intended matching records, and no real topic/day is accidentally omitted.
- Bind every requested search field and simultaneous criterion into the actual target source. Use explicit record aliases for joins/nested scopes; an inner ThisRecord is not the outer session or entity.
- Show the active criteria, provide a reachable clear/reset action, and distinguish no matches from unavailable data.
- Trace concrete matching and nonmatching records and the clear path. Counts/empty states must describe the filtered source, not only the subset a lazy gallery has currently loaded.
- Use typed dates/times for predicates and sorting. A text time criterion needs clear accepted formats/semantics; substring search is not range selection. Do not claim a stronger interaction than the approved implementation.
- Use `${PLUGIN_ROOT}/references/CreateNavigationState.md`'s canonical derivation rules for shared filters/counts, joins and record scope. Do not introduce global initialization for screen-owned state.

When advanced filters collapse, retain a visible active-criteria summary and a reachable clear action. Each expanded field keeps its own label in the same local layout region; a single combined caption does not label multiple wrapped rows. Recompute the expanded height from the actual number of rows, labels and gaps at each local width.

Use `${PLUGIN_ROOT}/references/CreateConformance.md` for concrete filter/reset inspection and reporting.
