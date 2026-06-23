# Mobile gesture recipes

Single source of truth for the gesture patterns the planner can request and the screen-builder must implement. If the spec in `native-app-plan.md` mentions any of these, follow the recipe verbatim — do not reinvent.

All recipes use `react-native-gesture-handler` (already in template, version 2.30.1).

> **Native target:** these recipes are for iOS and Android. Do not add alternate pointer-only patterns; provide accessible visible actions only as secondary fallbacks for users who cannot perform the gesture.

---

## Prerequisite — `<GestureHandlerRootView>` at app root

`react-native-gesture-handler` requires a `<GestureHandlerRootView>` wrapping the entire app. Without it, `Swipeable` and other gesture components silently do nothing on Android.

Verify in `app/_layout.tsx`:

```tsx
import { GestureHandlerRootView } from 'react-native-gesture-handler';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack>{/* ... */}</Stack>
    </GestureHandlerRootView>
  );
}
```

If missing, add it as a one-line template fix before writing any gesture code. The template is expected to ship this; verify on first builder pass.

---

## Recipe A — Swipe-to-delete on list rows

**When to use:** spec mentions "swipe to delete", "swipe action", or any list row destructive action. This is the iOS Mail / Photos / Messages convention. Native users expect it.

**When NOT to use:** spec explicitly asks for visible multi-select controls, or list rows are < 56pt tall (swipe area too narrow).

```tsx
import { Swipeable, GestureHandlerRootView } from 'react-native-gesture-handler';
import { Pressable, Text, YStack } from 'tamagui';

function InspectionRow({ row, onDelete }: Props) {
  const renderRightActions = () => (
    <Pressable
      onPress={onDelete}
      bg="$red9"
      jc="center"
      ai="center"
      px="$4"
      minWidth={88}
      accessibilityLabel={`Delete ${row.title}`}
      accessibilityRole="button"
    >
      <Text color="white" fontWeight="600">Delete</Text>
    </Pressable>
  );

  return (
    <Swipeable
      renderRightActions={renderRightActions}
      overshootRight={false}
      rightThreshold={80}
    >
      <RowContent row={row} />
    </Swipeable>
  );
}
```

**Mandatory rules:**

1. `rightThreshold: 80` minimum — prevents accidental delete from list scroll. Smaller values cause false positives on fast scroll.
2. `overshootRight: false` — destructive actions never auto-trigger. The user must tap the revealed `Delete` button as a second confirmation. Swipe-release alone NEVER deletes.
3. Provide an overflow `…` menu in the row as a secondary accessibility path, with a `Delete` item.
4. The `Delete` button MUST have `accessibilityLabel` (VoiceOver/TalkBack users may not swipe — the label is their access path).

---

## Recipe B — Long-press for multi-select / context menu

**When to use:** spec mentions "long press to select", "bulk operations", "contextual menu", or "drag to reorder" (where long-press picks up the row).

**When NOT to use:** as the primary action on a screen (long-press is undiscoverable — primary actions need a visible trigger).

```tsx
import { Pressable } from 'tamagui';

<Pressable
  onPress={onTap}
  onLongPress={onLongPress}
  delayLongPress={400}
>
  {/* ... */}
</Pressable>
```

**Mandatory rules:**

1. `delayLongPress: 400` — matches iOS Mail / Photos / Messages. The React Native default of 500 ms feels sluggish; native iOS apps trigger at ~400 ms.
2. Pair the long-press trigger with a visible state change (selection-mode toolbar, highlighted row, action sheet). Without a visible cue, users can't tell the long-press registered.
3. Reserve for: multi-select entry, contextual action sheets, reorder grip activation. Never for primary actions like Save / Submit / Continue.
4. If the action is critical, expose the same action via a visible overflow menu in the row so users do not have to discover long-press.

---

## Out of scope for v0

- **Pinch-to-zoom for image preview** — needs `react-native-reanimated` + `PinchGestureHandler`. Recipe is medium-complexity (worklets + matrix transforms). Defer until image-heavy app types ship.
- **Drag-to-reorder lists** — needs `react-native-draggable-flatlist` (NOT in template deps — would require upstream addition).
- **Pan-to-dismiss sheets** — Tamagui `Sheet` handles this internally; nothing for builder to do.
- **Edge-swipe back navigation customisation** — covered by screen-builder back-button rule (§31 / §32), not a gesture recipe.

---

## Cross-references

- Pull-to-refresh enforcement: `agents/screen-builder.md` rule 23
- Hardware back button (Android) + swipe-back (iOS): `agents/screen-builder.md` rules 31 + 32
- Animation vocabulary the planner uses: `agents/screen-planner.md` Step 4
