# Navigation and route safety

Read own/destination rows of `### Navigation Contracts` before using params or
navigation. Declare the full contract union in `useLocalSearchParams`, with required
path params and optional query params, all string values. This preserves caller/
receiver typing; TypeScript annotations themselves do not filter runtime params.

Locked conventions: `editId` for create-or-edit forms, `[id]` for primary entity,
`[<entity>Id]` for nested entities. Never invent `?recordId=` or `?id=`. A missing
destination contract is `NEEDS_CONTEXT`, not a guessed route.

Runtime params can be arrays despite declared types. Normalize the value before all
Dataverse get/update/delete/upload/download calls:

```tsx
const params = useLocalSearchParams<{ id: string }>();
const rawId = Array.isArray(params.id) ? params.id[0] : params.id;
const id = normalizeDataverseGuid(rawId);
```

Use the shared helper, not an inline RFC UUID regex: Dataverse sequential GUIDs need
not have RFC version bits. Reject missing IDs and literal `'null'`/`'undefined'`
before services; `enabled: !!rawId` is not validation.

## Intent and repeat taps

- Singleton destination (including planned singleton forms/login): `router.navigate`.
- Entity-detail drill-down: `router.push`.
- Auth/guard redirect and explicit post-create continuation: `router.replace`.
- Ordinary successful save: `router.back()` if possible, otherwise the declared parent
  with `router.navigate`. Never push another form after Save by default.
- Navigation handlers need a synchronous ref plus disabled feedback when relevant.
  Keep the guard until transition/focus reset, not an immediate `finally` around a
  synchronous router call (that would permit the next tap). Release on navigation
  failure; one-shot successful replace may remain locked.

Read-only back can use navigator behavior. Dirty or in-flight writes must use the
approved leave/cancel contract rather than silently losing work.

## One coherent header

Choose the existing navigator header **or** the shared `ScreenHeader`, not both.
For a custom compact drill-down, keep back, title, and a short trailing action in one
horizontal header row. Do not create a separate Back strip above a title/action row.
`ScreenHeader` accepts optional `variant="compact"` and `backAction`; existing callers
keep the standard title treatment. It owns no safe-area inset.

The title column must shrink and wrap (`flex={1}`, `minW={0}`); back remains a
48×48 target. A compact header has a minimum height, not a fixed height or a one-line
title clamp. Put long secondary actions in the existing `children`/`meta` slots, not
in an ever-widening right slot. Keep context and essential navigation in loading,
empty, error, and success states. A back callback uses the approved parent fallback
and leave guard; the component does not guess routes.

```tsx
// Native layout example: inspection-header
import React from 'react';
import { Button, useTheme } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { ScreenHeader } from '@/components';

export function InspectionHeader({
  title, onBack, onMore,
}: {
  title: string;
  onBack: () => void;
  onMore: () => void;
}) {
  const theme = useTheme();
  return (
    <ScreenHeader
      variant="compact"
      title={title}
      backAction={{ label: 'Back to inspections', onPress: onBack }}
      rightAction={
        <Button
          chromeless minW={48} minH={48} height="auto" p="$2"
          role="button" aria-label="Inspection actions" onPress={onMore}
          icon={<Ionicons name="ellipsis-horizontal" size={24} color={theme.color12.val} accessible={false} />}
        />
      }
    />
  );
}
```

## Preserve approved navigation affordances

Carry the approved route order, icon, visible label, and selected treatment from
intent to native implementation. Do not replace planned icons with emoji, text
initials, generic dots, blank boxes, or labels alone. Use allowlisted icon exports and
verify their names against installed types. Icons supplement labels; selected state
must remain apparent without color alone and exposed to accessibility services.
Reuse navigator tab buttons/semantics rather than hand-rolling a second navigation bar.

The following is **foreground-owned navigator wiring**, only for an approved
reading/review route contract. It is not permission for a screen builder to modify
`_layout.tsx` or invent these routes. The navigator owns the bottom inset and selected
semantics; do not add another tab footer or home-indicator spacer in each screen.

```tsx
// Native layout example: reading-tabs
import React from 'react';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

export function ReadingTabs() {
  return (
    <Tabs screenOptions={{
      headerShown: false,
      tabBarShowLabel: true,
      tabBarAllowFontScaling: true,
      tabBarItemStyle: { minHeight: 48 },
    }}>
      <Tabs.Screen name="library" options={{
        title: 'Library',
        tabBarIcon: ({ color, size, focused }) => (
          <Ionicons name={focused ? 'book' : 'book-outline'} color={color} size={size} accessible={false} />
        ),
      }} />
      <Tabs.Screen name="reviews" options={{
        title: 'Reviews',
        tabBarIcon: ({ color, size, focused }) => (
          <Ionicons name={focused ? 'checkmark-circle' : 'checkmark-circle-outline'} color={color} size={size} accessible={false} />
        ),
      }} />
    </Tabs>
  );
}
```

Check both focused/unfocused destinations, long/localized labels, large text, and
the keyboard-visible state. Do not fix clipping by disabling font scaling, removing
labels/icons, or fixing the whole bar to an arbitrary height; ask the foreground to
apply the approved adaptive navigation treatment if the navigator cannot fit it.

## Profile

Profile is `/(app)/profile`, with planned app-specific content above visible `Sign out`.
Use confirmed `useAuth().signOut()` then `router.replace('/login')`; failures stay
recoverable. Do not clear storage manually, invoke CLI logout, create another auth
service, or add sign-out to unrelated screens. Role-conditioned UI follows the approved
role contract but is not a substitute for backend authorization.

Never declare routes or modify `_layout.tsx`; the foreground owns navigator changes.
