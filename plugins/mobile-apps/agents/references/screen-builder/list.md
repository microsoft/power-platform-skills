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

## Repeated-item geometry belongs to the content

Choose rows, cards, sections, or an approved grid from the next decision and available
width; none is a mandatory default. Align the repeated information roles, not invented
field names. Keep media/leading-icon slots, title/metadata start edges, and trailing
affordances consistent **where those slots exist**. Do not add blank media or fabricated
status to make records look alike.

- Rows: constrain the text column with `flex={1}` and `minW={0}`, leave icon/chevron
  columns non-shrinking, and allow essential titles, warnings, and decision text to
  wrap. Shared `ActionRow` and `RowPick` already provide this text column. `RowPick`
  reserves its selection marker so selecting an item does not shift text width.
- Paired comparison tiles: only when that comparison is approved, stretch the outer
  cells **and the inner card surfaces**. Stretching a pressable wrapper alone leaves
  short content's background shorter. Let a growing body push the footer down instead
  of pinning a fixed card height or padding individual records to match.
  If the accepted preview establishes that alignment, uneven native surfaces are a
  regression—not an acceptable substitute for the approved repeated-item treatment.
- Ordinary feed/reading rows can have different heights. Never make every row equal
  height, truncate important text, or force a grid just to align bottoms. A long
  label/localization or larger system text may require one column or stacked metadata.
- Effective actions are at least 44pt on iOS and 48dp on Android; use 48 minimum targets
  for shared examples. Minimums may grow with content. Independent actions remain
  siblings, not buttons inside a pressable card.

This **optional approved pair** demonstrates the inner-stretch requirement. The
240dp minimum column is specific to this example's content, not an app-wide breakpoint
or a grid mandate. The available-width/font-scale check is conservative; verify the
actual longest text in the rendered app. Width changes and larger text fall back to
one column without losing either action.

```tsx
// Native layout example: inspection-pair
import React from 'react';
import { Pressable, useWindowDimensions } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

type InspectionOption = { id: string; title: string; description: string };

export function InspectionPair({
  items, onChoose, allowColumns = false,
}: {
  items: readonly [InspectionOption, InspectionOption];
  onChoose: (id: string) => void;
  allowColumns?: boolean;
}) {
  const { width, fontScale } = useWindowDimensions();
  const sideBySide = allowColumns && (width - 32 - 12) / 2 >= 240 * Math.max(1, fontScale);
  return (
    <XStack flexDirection={sideBySide ? 'row' : 'column'} items="stretch" gap={12} px={16}>
      {items.map((item) => (
        <Pressable
          key={item.id}
          accessibilityRole="button"
          accessibilityLabel={`Open ${item.title}`}
          onPress={() => onChoose(item.id)}
          style={({ pressed }) => ({
            flex: sideBySide ? 1 : undefined, minWidth: 0, minHeight: 48,
            alignSelf: 'stretch', opacity: pressed ? 0.8 : 1,
          })}
        >
          <YStack grow={sideBySide ? 1 : undefined} minW={0} p="$4" gap="$3" bg="$color2" rounded="$4">
            <YStack grow={1} minW={0} gap="$2">
              <Text fontSize="$5" fontWeight="700">{item.title}</Text>
              <Text fontSize="$4" color="$color10">{item.description}</Text>
            </YStack>
            <Text fontSize="$4" fontWeight="600">Open checklist</Text>
          </YStack>
        </Pressable>
      ))}
    </XStack>
  );
}
```

For a reading queue, use a variable-height `ActionRow` instead; its entire row is
one labeled target and the subtitle can wrap. A status, author, or cover is optional
only when required by the approved queue decision—not inferred from this example.

```tsx
// Native layout example: reading-row
import React from 'react';
import { ActionRow } from '@/components';

export function ReadingRow({
  title, summary, onOpen,
}: {
  title: string;
  summary?: string;
  onOpen: () => void;
}) {
  return <ActionRow iconName="book-outline" label={title} subtitle={summary} onPress={onOpen} />;
}
```
