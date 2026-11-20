# Navigation layouts and screen skeletons

How to write route layouts and typed screen skeletons by hand. `/edit-app` follows these rules when a change adds screens or changes navigation in an existing app.
`/create-mobile-app` no longer does this by hand: its Step 5 runs `scripts/scaffold-preview-screens.js`, which applies the same layout rules from the approved screen graph and writes placeholders instead of skeletons.

The orchestrator writes layouts, shared code, and typed skeletons before any builder runs, so parallel builders never race on shared files.

## 1 — Navigation layout

Read `## Screens → Navigation Pattern` from `native-app-plan.md`.

- **Stack** — skip. `app/(app)/_layout.tsx` already renders `<Stack>`. Nothing to do.
- **Tabs** or **Tabs + Stack** — write outer `<Tabs>` in `app/(app)/_layout.tsx` AND a per-folder inner `<Stack>` in each `app/(app)/<folder>/_layout.tsx`.
- **Drawer** — write outer `<Drawer>` in `app/(app)/_layout.tsx` AND a per-folder inner `<Stack>` in each `app/(app)/<folder>/_layout.tsx`.

> **⚠️ The phantom-tab fix lives here.** expo-router auto-registers every top-level `.tsx` file under `app/(app)/` as a tab/drawer entry. This step prevents phantom entries by walking the **File** column in the Screen Map (not the Screen names): each unique top-level entry under `app/(app)/` — file OR folder — becomes ONE tab/drawer entry. Folders contain detail/modal screens *inside* their own stack, so they never leak as siblings.

### 1.1 — Compute the layout structure from the Screen Map

Read the Screen Map's **File** column. For every row whose File starts with `app/(app)/`, classify each path into one of three groups:

| Path shape | Classification | Example |
|---|---|---|
| `app/(app)/<name>.tsx` (no subfolder) | **Top-level flat file** — one outer entry, no inner layout | `app/(app)/home.tsx` |
| `app/(app)/<folder>/index.tsx` | **Folder root** — one outer entry, needs inner `_layout.tsx` | `app/(app)/inspections/index.tsx` |
| `app/(app)/<folder>/<child>.tsx` (any other file inside a folder) | **Folder child** — pushed into the folder's stack, NOT an outer entry | `app/(app)/inspections/[id].tsx` |

Build two lists from the classification:

1. **Outer entries** = unique `<name>` from the top-level flat files + unique `<folder>` from the folder roots. These get one `<Tabs.Screen>` or `<Drawer.Screen>` each in the outer layout.
2. **Inner stacks** = one entry per unique `<folder>`. For each folder, list its children (root + non-root files), with each child's `Presentation` value from the Screen Map.

**Sanity check before writing anything:** if any folder has children but no `index.tsx` row in the Screen Map, STOP and report: `BLOCKED: folder app/(app)/<folder>/ has children (<list>) but no index.tsx row in the Screen Map. The screen-planner must emit an index.tsx row for every folder.` This catches a planner mistake that would render the folder unreachable from the outer tab.

Normalize every Screen Map file to its Expo route (strip `.tsx`, collapse trailing `/index`, preserve dynamic segments). If two files normalize to the same route, STOP before writing layouts. In particular, reject `<parent>/[id].tsx` together with `<parent>/[id]/<child>.tsx`; move the detail contract to `<parent>/[id]/index.tsx`.

```text
BLOCKED: duplicate Expo route <route> from <file-a> and <file-b>. Use [id]/index.tsx when a dynamic detail route owns child screens.
```

### 1.2 — Write per-folder inner `_layout.tsx` files (if any folders exist)

For each entry in the Inner stacks list, create the folder if missing and write `app/(app)/<folder>/_layout.tsx` with this template:

```tsx
import { Stack } from 'expo-router';

export default function <FolderName>Layout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      {/* one <Stack.Screen> per non-index child, with presentation from Screen Map */}
      <Stack.Screen name="<child-without-tsx>" options={{ presentation: '<Presentation>' }} />
    </Stack>
  );
}
```

Rules:
- `headerShown: false` at the Stack level — each screen sets its own header inline via `<Stack.Screen options={{...}}>` at the top of its component (the Expo Router idiom).
- `<Stack.Screen name="index" />` is required — without it, the folder root won't render.
- `presentation: 'modal'` and `presentation: 'formSheet'` come from the Screen Map's Presentation column. Skip the `options` prop entirely for `default` presentation.
- `name` for `[id].tsx` is literally `[id]` (with brackets). When `[id]` owns child routes, create `<folder>/[id]/_layout.tsx` with `<Stack.Screen name="index" />` and child entries; do not register both `[id].tsx` and a `[id]/` folder.
- Folder name in the function name is PascalCase (e.g. `InspectionsLayout`).

**Why this must run before any screen-builder:** screen-builders write their files in parallel, multiple builders may target the same folder, and any of them creating `_layout.tsx` would race. The orchestrator owns these files.

### 1.3 — Write outer `app/(app)/_layout.tsx`

Now rewrite only the `return` statement in `app/(app)/_layout.tsx`. Keep every line above the `return` untouched (auth guard, all imports).

**How to build the `<Tabs>` block (Tabs / Tabs + Stack pattern):**

For each entry in the Outer entries list, emit one `<Tabs.Screen>`. The `name` is the file/folder name without `.tsx`:

For each tab, infer a Ionicons icon name from the screen name:

| Screen name contains | Icon |
|---|---|
| home, dashboard, overview | `home-outline` |
| inspect, audit, checklist, task | `clipboard-outline` |
| profile, account, me, user | `person-outline` |
| settings, config, preferences | `settings-outline` |
| report, analytics, chart, stats | `bar-chart-outline` |
| map, location, sites, field | `map-outline` |
| message, chat, inbox, notify | `chatbubble-outline` |
| anything else | `apps-outline` |

**The Edit to apply:**

Add `import { Platform } from 'react-native';`, `import { Tabs } from 'expo-router';`, `import { Ionicons } from '@expo/vector-icons';`, and `import { useThemeTokens } from '@microsoft/power-apps-native-host';` to the import block if not already present. Inside `AppLayout`, after the auth state is read, add `const theme = useThemeTokens();`. Then replace:

```tsx
return (
  <Stack
    screenOptions={{
      headerShown: false,
    }}
  />
);
```

with:

```tsx
return (
  <Tabs
    screenOptions={{
      headerShown: false,
      tabBarActiveTintColor: theme.accentBase,
      tabBarInactiveTintColor: theme.text2,
      // Web preview only: react-native-web clips the 10px tab label to a 10px line box, cutting
      // off descenders, and a browser has no bottom inset to give the taller label room. Native
      // keeps react-navigation's inset-aware defaults.
      ...(Platform.OS === 'web' ? { tabBarLabelStyle: { lineHeight: 13 }, tabBarStyle: { height: 56 } } : null),
    }}
  >
    <Tabs.Screen
      name="<screen-file-name>"
      options={{
        title: '<Screen Title>',
        tabBarIcon: ({ color }) => <Ionicons name="<icon>" size={22} color={color} />,
      }}
    />
    {/* one Tabs.Screen per top-level tab */}
  </Tabs>
);
```

Run `npx --no-install tsc --noEmit` after the edit. If it fails, check that the `Tabs.Screen name` values exactly match the file names under `app/(app)/` (without `.tsx`).

**How to build the `<Drawer>` block (Drawer pattern only):**

Same Outer-entries computation as Tabs — one entry per top-level flat file or folder root from 1.1. Detail, modal, and nested routes are inside their folder's inner stack, not drawer items.

Use the same icon mapping table as Tabs (above).

**The Edit to apply:**

Add `import { Drawer } from 'expo-router/drawer';`, `import { Ionicons } from '@expo/vector-icons';`, and `import { useThemeTokens } from '@microsoft/power-apps-native-host';` to the import block if not already present. Inside `AppLayout`, after the auth state is read, add `const theme = useThemeTokens();`. Then replace the existing `<Stack>` return with:

```tsx
return (
  <Drawer
    screenOptions={{
      headerShown: true,
      drawerType: 'front',
      drawerActiveTintColor: theme.accentBase,
      drawerInactiveTintColor: theme.text2,
      drawerStyle: { width: 280 },
    }}
  >
    <Drawer.Screen
      name="<screen-file-name>"
      options={{
        title: '<Screen Title>',
        drawerIcon: ({ color }) => <Ionicons name="<icon>" size={22} color={color} />,
      }}
    />
    {/* one Drawer.Screen per top-level destination */}
  </Drawer>
);
```

**Key differences from Tabs:**
- Import is `from 'expo-router/drawer'` (not `from 'expo-router'`)
- `headerShown: true` — drawer needs the hamburger icon in the header; hiding it makes the drawer unreachable
- `drawerType: 'front'` — standard mobile pattern (drawer slides over content)
- Icon prop is `drawerIcon` (not `tabBarIcon`)

Run `npx --no-install tsc --noEmit` after the edit. If it fails, check that the `Drawer.Screen name` values exactly match the file names under `app/(app)/` (without `.tsx`).

## 2 — App-specific shared code and screen skeletons

**Print before starting:**
> "→ Generating shared components and typed screen skeletons from the plan…"

This step writes **shared UI that several screens use** plus a **typed skeleton** for each screen. Builders then fill in the JSX rather than starting from zero, which cuts builder output by about half and removes import-path guessing.
Data access is already done: every entity hook and device action lives in `src/hooks/data/`, and skeletons import them from `@/hooks/data` only.

---

### 2.1 — Analyze plan for cross-screen patterns

Read all per-screen specs in `## Screens → ### Per-Screen Specs` and generate only what two or more screens share:

| Pattern in specs | Generate | Where |
|---|---|---|
| Same entity shown as a list item on 2+ screens | `<Entity>Card.tsx` or `<Entity>Row.tsx`, taking the domain type from `@/hooks/data` as a prop | `src/components/` |
| Same literal-union field (a status or category) styled on 2+ screens | `constants.ts` with a label + tone map keyed by the union's values | `src/utils/` |
| Same entity-specific formatting on 2+ screens (e.g. "inspection title" = `${title} · ${siteName}`) | A formatter | `src/utils/` |

Shared components receive data as props; they never call data hooks themselves, so one screen's loading state stays that screen's concern.
If no cross-screen patterns exist, skip this sub-step.

---

### 2.2 — Generate screen skeletons

For each screen in the Screen Map that a screen-builder will build, write a **typed skeleton** at its `target_file` path containing:

1. All imports (components, data hooks, utils, types) pre-resolved
2. The exported component function with typed route params
3. The hook calls from the spec's `**Data**` field
4. An empty return with a `// TODO: screen-builder fills JSX here` marker

**Cursor List screen (`Pagination: cursor`):**
```tsx
import React from 'react';
import { FlatList, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { YStack, XStack, Text, Input, Spinner } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LoadingState, ErrorState, EmptyState, ScreenHeader } from '@/components';
import { formatDate } from '@/utils';
import { use<Entity>List, type <Entity> } from '@/hooks/data';
// App-specific imports (if generated at 2.1):
import { <Entity>Row } from '@/components/<Entity>Row';
import { <ENTITY>_STATUS } from '@/utils/constants';

export default function <ScreenName>() {
  const router = useRouter();
  const { items, loading, refreshing, loadingMore, hasNextPage, error, query, setQuery, onRefresh, refetch, loadMore } =
    use<Entity>List();

  // TODO: screen-builder fills JSX here. FlatList MUST wire:
  // - data={items}
  // - refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
  // - onEndReached={hasNextPage ? loadMore : undefined}
  // - ListFooterComponent={loadingMore ? <Spinner /> : null}
  return null;
}
```

**Bounded List screen (`Pagination: none`):**
```tsx
import React from 'react';
import { FlatList, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { YStack, XStack, Text, Input } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LoadingState, ErrorState, EmptyState, ScreenHeader } from '@/components';
import { useSearchFilter } from '@/hooks';
import { use<Entity>List, type <Entity> } from '@/hooks/data';

export default function <ScreenName>() {
  const router = useRouter();
  const { items, loading, refreshing, error, onRefresh, refetch } = use<Entity>List();
  const { query, setQuery, filtered } = useSearchFilter(items, [<searchKeys>]);

  // TODO: screen-builder fills JSX here
  return null;
}
```

A `bounded` entity's list hook wraps `useListData`, which loads one page; `useSearchFilter` filters only loaded rows. Use the cursor skeleton whenever the spec says `Pagination: cursor`.

**Detail screen:**
```tsx
import React from 'react';
import { ScrollView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { YStack, XStack, Text, Button } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LoadingState, ErrorState, BottomActionBar, InfoRow } from '@/components';
import { formatDate } from '@/utils';
import { use<Entity>, use<Entity>Mutations } from '@/hooks/data';

export default function <ScreenName>() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { item, loading, error, refetch } = use<Entity>(id);
  const { update, saving } = use<Entity>Mutations();

  // TODO: screen-builder fills JSX here. Every mutation returns { ok, value | message }:
  // branch on result.ok and render result.message inline.
  return null;
}
```

**Form screen:**
```tsx
import React, { useState } from 'react';
import { ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { YStack, Text, Button, Input } from 'tamagui';
import { ModalHeader, FormField, RowPick } from '@/components';
import { use<Entity>Mutations, type <Entity>Draft } from '@/hooks/data';

export default function <ScreenName>() {
  const router = useRouter();
  const { create, saving } = use<Entity>Mutations();
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Form state fields from spec:
  <field_declarations>

  const submit = async (draft: <Entity>Draft) => {
    // TODO: screen-builder fills validation, then:
    // const result = await create(draft);
    // if (!result.ok) { setSubmitError(result.message); return; }
    // router.back();
  };

  // TODO: screen-builder fills JSX here
  return null;
}
```

**Profile screen** (`/(app)/profile`, always generated; app-specific content comes from the Profile spec):
```tsx
import React from 'react';
import { Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { YStack, XStack, Text, Button } from 'tamagui';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@microsoft/power-apps-native-host';

export default function <ScreenName>() {
  const router = useRouter();
  // AuthState shape (@microsoft/power-apps-native-host): { isLoading, isAuthReady, isSignedIn, error, acquireToken, signIn, signOut }
  // There is NO `user` / `account` field. Display name comes from the ID-token claim, not from useAuth().
  const { isSignedIn, signOut } = useAuth();

  const handleSignOut = React.useCallback(() => {
    Alert.alert('Sign out?', 'You can sign in again with your work or school account.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: () => {
          void Promise.resolve()
            .then(() => signOut())
            .finally(() => router.replace('/login'));
        },
      },
    ]);
  }, [router, signOut]);

  // TODO: screen-builder fills JSX here. Any visible Sign out button calls handleSignOut.
  return null;
}
```

On web the host reports every user as signed in and `signOut` does nothing, so the preview shows Profile as a signed-in user; the real sign-out flow runs on the device.

**Rules for skeleton generation:**
- Replace `<Entity>`, `<ScreenName>`, `<searchKeys>`, and `<field_declarations>` with the Data Contract and per-screen spec names; hook and type names must match `src/hooks/data/` exactly.
- Import data, domain types, and device actions only from `@/hooks/data`. `check-data-layer.js` fails a screen that imports `@/generated/...`, `@/native/...`, or fixtures.
- Profile skeletons may also call data hooks when the Profile spec's `Profile content` or `Data` fields need persisted app-specific user context. Keep the sign-out helper regardless.
- The skeleton is a **valid TypeScript file** (compiles with `return null`) — builders replace the `return null` with real JSX.
- Skip skeletons for screens that already exist in the template and that the Screen Map does not assign (e.g. an unassigned `home.tsx`).
- The Profile skeleton must keep the `handleSignOut` helper and wire the planned `Sign out` button to it. Profile is the only sign-out owner: keep sign-out imports and helpers out of every other skeleton, and give Profile real content beyond the sign-out button.
- **`AuthState` has exactly** `isLoading`, `isAuthReady`, `isSignedIn`, `error`, `acquireToken`, `signIn`, and `signOut`. If the screen needs the signed-in user's name or email, add a `// TODO: decode ID token claim` comment.

The skeleton file is the single source of truth for per-screen imports and hook calls; the plan does not repeat them.
