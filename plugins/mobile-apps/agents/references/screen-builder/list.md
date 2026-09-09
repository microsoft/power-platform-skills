# Lists and queues — load only for a list surface

- `pagination: none`: use `useListData` for bounded reads; `useSearchFilter` is only
  for bounded client-side lists of real string fields.
- `pagination: cursor`: use supplied `useCursorListData`, `useInfiniteQuery`, or
  app-specific cursor hook. Pass generated SDK `maxPageSize` and return its `skipToken`
  as the next request's `skipToken`. Include `select` and stable `orderBy` with unique
  key. Push search/filter into the service. `top: 50` is not pagination. Missing cursor
  support for an unbounded source blocks; never downgrade to fetching everything.
- Keep array query keys consistent with sibling mutation invalidation. Use a stable
  row ID in `keyExtractor`, pull-to-refresh for remote lists, guarded load-more, and a
  separate incremental loading/error affordance so existing rows remain usable.
- `ListEmptyComponent` keeps the empty list refreshable. Distinguish initial loading,
  failed query, no records, and active-filter-no-matches. Never substitute fixtures for
  a live empty/error. `source: 'fixture'` is explicit preview/demo mode and must be labeled.
- Parent-dependent lists distinguish missing/unsaved parent from saved-with-no-children.
  Only offer create where the actor has that capability and the required parent exists;
  otherwise offer the approved parent-start/return path. Active filters offer clear/reset.
  Do not assert “children exist elsewhere” unless data/counts establish it.
- Row emphasis and controls follow Domain layout decisions: show the information needed
  for the actor's next decision, not a generic card with every column. Status uses text
  as well as color. Keep independent row actions siblings, never nested touch targets.

## Conditional recipes, not defaults

- Native large-title/search chrome only when approved and supported on this route/
  platform. Compact/custom search remains valid. Never edit the navigator to force it.
- FAB only for the planned single obvious create action with accessible `label`;
  otherwise use the approved labeled header/inline/bottom action.
- Filter chips can be horizontal when space warrants, with readable count labels and
  at least 44pt effective targets. Do not invent costly counts or hide meaningful filters.
- Swipe delete/long-press only when requested, with visible accessible alternatives and
  destructive confirmation. Load the matching platform/gesture reference.
- Insert/remove animation is optional, constrained by approved motion and reduced motion.
  With `motion: none`, no entering/exiting/layout transforms or spring/scale feedback.

For unresolved cursor/query API details read the matching section of
`shared/references/data-performance.md`; `shared/samples/screen-list.tsx` is optional
API guidance, not a mandatory layout.
