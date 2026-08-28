# Detail, Comparison, and Overview Screens

## Composition

- The first viewport answers identity, current state, and the next useful
  action. Choose the hero from the build pack: media, status summary, metric,
  identity block, or comparison—not a generic title card.
- Group related facts into a small number of semantic sections. Use spacing and
  surface contrast before adding borders/cards.
- Put trust/provenance next to the decision it supports.
- Destructive actions are separated, confirmed, and never visually compete
  with the primary workflow action.
- A failure/error record uses a compact status band or tinted summary, not a
  giant red app-error header unless emergency visibility is explicitly
  approved.

## Data and states

- Normalize the route ID before loading.
- Check the generated service result before reading `data`.
- Loading skeletons preserve hero and section geometry.
- Missing/invalid identity is an explicit error state with safe navigation.
- Refresh never clears already visible trusted data unless the response
  succeeds.

## Comparison/overview

- Comparison makes differences visually scannable and names the basis of the
  comparison.
- Overview metrics are schema-backed or explicitly sample-only. Never derive
  authoritative totals from a capped first page.
- Primary and secondary actions follow the Navigation Contracts exactly.

## Native feel

Use readable long-form spacing, safe top/bottom chrome, real back behavior, and
accessible action labels. The hierarchy should feel authored for this record,
not like a database field dump.
