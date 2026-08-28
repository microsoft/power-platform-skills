# List, Queue, Feed, and Discovery Screens

Use the compiled build-pack composition and row-style key; do not default to
generic cards.

## Composition

- Put queue/list context, search/filter affordance when needed, and the most
  important status/count in the first viewport.
- Prefer flat rows with separators for dense operational lists. Use compact
  cards only when each item needs grouped evidence or media.
- One primary create/start action is bottom-reachable. A FAB is acceptable only
  when the entity/action is obvious and it exposes an accessible label.
- Four or more filters use a compact horizontal chip row or a dedicated filter
  sheet; never equal-width multi-row card-like filters.
- A whole-row tap has one press owner. Child actions are siblings, not nested
  touch targets.

## Data and states

- Bounded lists use `useListData`; cursor lists follow the cursor contract in
  `code-idioms.md`.
- Search only real string fields. Cursor search is server-side.
- Loading uses row-shaped skeletons.
- Empty state stays in `ListEmptyComponent`, names the real condition, and
  offers the next action.
- Filter-empty copy names the active filter and how to clear/change it.
- Error state keeps refresh/retry available and never displays raw errors.
- Pull-to-refresh calls the same loader as the normal query.

## Row evidence

- Lead with the field that helps users choose the next record.
- Secondary text is limited to decision-relevant context.
- Use either a status pill or a status stripe, not both.
- IDs, dates, coordinates, and currency may use the approved mono treatment.
- Titles truncate to one line; supporting text normally uses two.

## Native feel

Use press feedback with a small scale change, stable keys, readable metadata,
44pt targets, and bottom-safe overlays. Lists should scan quickly without
looking like repeated bordered boxes.
