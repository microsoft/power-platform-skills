# Details, review, and decision screens

Load only for an assigned detail/review screen. The actor's next decision determines
hierarchy: identity/context, relevant status/blockers/deadline, and supported next
action before secondary history when the journey calls for it. A read-only detail
does not require a bottom CTA, edit control, hero image, or destructive action.

- Normalize route IDs and return a recoverable invalid-link state before reads.
  Unwrap successful generated query results; request failure is not “record not found”.
- Render friendly retry for load failure and a return path for deleted/missing records.
  Loading retains the same outer geometry and essential navigation as content.
- Related fields use the planned formatted lookup/bounded read/projection contract;
  never run per-row secondary queries to fill a detail section.
- Display dates with shared formatters and choices with generated labels; preserve
  readable large text and avoid truncating essential decisions, amounts, or warnings.
- Approved edit navigation uses the Navigation Contracts route/params, not an invented
  `/[id]/edit` route. Guard repeated taps until the screen regains focus.
- Approved delete requires confirmation, checked service success, pending feedback,
  a synchronous in-flight ref, query invalidation, and exactly one post-delete action.
  Failure keeps the dialog/screen recoverable. Do not auto-close a destructive dialog
  before its request outcome or leave Edit enabled during a delete.
- For review/approval, implement the named business operation and prerequisites;
  changing a badge locally is not completing the decision.

Read `shared/samples/screen-detail.tsx` only for unresolved query/action API idioms.

## Header, body, and optional decision footer

Keep a compact back/title/action row using `ScreenHeader`, or keep the navigator's
existing header. Do not stack a second Back row or duplicate the navigator title.
Use one flexible scrolling body; a persistent decision footer is its normal-flow
sibling, not an absolute overlay with guessed bottom padding. The body shrinks to
leave the footer visible and its final paragraph remains scrollable above the action.
See [platform.md](platform.md#native-chrome-and-insets) for edge ownership.

A persistent footer is a choice, not a default layout requirement. Keep only the
essential summary and primary action pinned; contextual details and repeated
disclaimers belong in the scroll body and, when required, the confirmation. Do not
move information needed for an informed decision somewhere the user cannot reach.
Use `CompactActionBar` for a summary/action row with a 48px-minimum action that wraps at larger text sizes.
Keep error/pending feedback visible and all business guards in the actual handler.

```tsx
// Native layout example: selection-actions
import React from 'react';
import { Text } from 'tamagui';
import { CompactActionBar } from '@/components';

export function SelectionActions({
  count, onReview, pending, error,
}: {
  count: number;
  onReview: () => void;
  pending?: boolean;
  error?: string;
}) {
  return (
    <CompactActionBar
      includeBottomInset={false}
      summary={<Text fontSize="$4" fontWeight="600" color="$color12">{count} selected</Text>}
      actionLabel="Review selection" pendingLabel="Opening review…"
      onAction={onReview} pending={pending} disabled={count === 0} error={error}
    />
  );
}
```

This example delegates bottom insets to the existing non-overlay tabs. It does not
authorize adding tabs. If there is no such owner, use the default inset behavior.
Compare a single short item and a long list at the real viewport: if chrome and
repeated explanations force avoidable scrolling, simplify the footer/content, not
the touch target or text size. Never claim any fixed percentage is right for every app.

Long values/warnings wrap. Shared `InfoRow` wraps values by default and accepts
`layout="stacked"` when two columns cannot fit; do not hide the deciding text behind
`numberOfLines={1}`. A large title, hero, or fixed-height field matrix is not required.

This reading approval example has no native header or tab bar. The outer safe area
owns top/left/right; the shared footer owns bottom when present. In read-only mode,
the outer safe area takes bottom instead. For an in-flow tab bar, omit outer bottom
and use `includeBottomInset={false}` on the footer: the tab navigator already owns it.
The passed handlers remain responsible for the approved leave contract and the real
validated, single-flight business operation; this layout is not a fake approval.

```tsx
// Native layout example: reading-review
import React from 'react';
import { ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Text, YStack } from 'tamagui';
import { BottomActionBar, ScreenHeader } from '@/components';

export function ReadingReview({
  title, sections, onBack, onApprove, approving = false,
}: {
  title: string;
  sections: readonly { id: string; text: string }[];
  onBack: () => void;
  onApprove?: () => void;
  approving?: boolean;
}) {
  return (
    <SafeAreaView
      style={{ flex: 1 }}
      edges={onApprove ? ['top', 'left', 'right'] : ['top', 'left', 'right', 'bottom']}
    >
      <YStack flex={1} bg="$background">
        <ScreenHeader variant="compact" title={title} backAction={{ onPress: onBack }} />
        <ScrollView
          style={{ flex: 1 }}
          contentInsetAdjustmentBehavior="never"
          automaticallyAdjustContentInsets={false}
          automaticallyAdjustsScrollIndicatorInsets={false}
          contentContainerStyle={{ padding: 16 }}
        >
          <YStack gap="$4">
            {sections.map((section) => <Text key={section.id} fontSize="$4">{section.text}</Text>)}
          </YStack>
        </ScrollView>
        {onApprove && (
          <BottomActionBar>
            <Button
              minH={48} height="auto" py="$3"
              role="button" aria-label="Approve document" aria-busy={approving}
              disabled={approving} onPress={onApprove}
            >
              <Button.Text shrink={1}>{approving ? 'Approving…' : 'Approve document'}</Button.Text>
            </Button>
          </BottomActionBar>
        )}
      </YStack>
    </SafeAreaView>
  );
}
```

Verify short and multi-page content, long titles, missing optional sections, large
text, and pending/error states. An approval that fails must retain its content,
navigation, and retry path; a short record must not push the footer into mid-screen.
