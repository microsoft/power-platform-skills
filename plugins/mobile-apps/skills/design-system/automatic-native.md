# Automatic Native Design Rules

Use these rules for an orchestrated prompt-only native app when the maker did
not request explicit brand, visual-reference, gallery, comparison, refresh,
reskin, or theme work.

## Authority

Read the Product Experience Contract, Experience Foundation Contract,
Experience Screen Contract, approved `native-app-plan.md`, and, when present,
the Workflow Journey and Navigation contracts. Do not introduce another
planning artifact or reinterpret the approved product structure.

## UX rules

- Preserve the primary job, permanent Home role, launch and resume routing,
  first-viewport region order, primary action, signature motifs, states,
  capability placement, media policy, and forbidden defaults.
- Keep one obvious focal point and one primary action in states that require an
  immediate decision. Do not repeat headings or fill useful space with
  decoration.
- Use semantic tokens. Selection, warning, error, destructive, brand, and
  primary-action roles remain distinct; do not use error color for ordinary
  selection or spread the accent across every surface.
- Cards must communicate grouping, navigation, selection, or emphasis. Do not
  wrap every section in a card.
- Required product, place, person, document, or evidence media cannot become an
  icon or color block. Offline-critical media cannot be remote-only.
- Optional native capabilities open on demand and remain subordinate to their
  owning task. Include loading, permission-denied, unavailable, failure,
  offline, and manual fallbacks.
- Loading, empty, error, offline, partial-data, and recovery states retain the
  populated hierarchy and action placement.
- Preserve Dynamic Type, screen-reader labels/roles/values, logical focus,
  modal containment, non-color cues, 44-point targets, reduced motion,
  keyboard reachability, sticky-action clearance, and safe areas.
- Navigation styling follows the resolved Navigation Contract. It cannot
  change destination order, nested ownership, tab visibility, deep links,
  back, completion, or cancel behavior.

## Output

Continue through the existing design-system workflow to write
`brand/design-system.md` and `brand/tokens.ts`. Skip brand, cost, and style
pickers unless the maker explicitly requested them. Do not invoke a
deterministic design compiler or require a semantic JSON planner.
