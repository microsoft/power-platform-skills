# Navigation and Screen Preparation

### Step 10b — Wire navigation layout

Read `## Screens → Navigation Pattern` from `native-app-plan.md`.

- **Stack** — skip. `app/(app)/_layout.tsx` already renders `<Stack>`. Nothing to do.
- **Tabs** or **Tabs + Stack** — write outer `<Tabs>` in `app/(app)/_layout.tsx` AND a per-folder inner `<Stack>` in each `app/(app)/<folder>/_layout.tsx`.
- **Drawer** — write outer `<Drawer>` in `app/(app)/_layout.tsx` AND a per-folder inner `<Stack>` in each `app/(app)/<folder>/_layout.tsx`.

> **⚠️ The phantom-tab fix lives here.** expo-router auto-registers every top-level `.tsx` file under `app/(app)/` as a tab/drawer entry. Step 10b prevents phantom entries by walking the **File** column in the Screen Map (not the Screen names): each unique top-level entry under `app/(app)/` — file OR folder — becomes ONE tab/drawer entry. Folders contain detail/modal screens *inside* their own stack, so they never leak as siblings.

#### Step 10b.1 — Compute the layout structure from the Screen Map

Read the Screen Map's **File** column. For every row whose File starts with `app/(app)/`, classify each path into one of three groups:

| Path shape | Classification | Example |
|---|---|---|
| `app/(app)/<name>.tsx` (no subfolder) | **Top-level flat file** — one outer entry, no inner layout | `app/(app)/home.tsx` |
| `app/(app)/<folder>/index.tsx` | **Folder root** — one outer entry, needs inner `_layout.tsx` | `app/(app)/inspections/index.tsx` |
| `app/(app)/<folder>/<child>.tsx` (any other file inside a folder) | **Folder child** — pushed into the folder's stack, NOT an outer entry | `app/(app)/inspections/[id].tsx` |

Build two lists from the classification:

1. **Outer entries** = unique `<name>` from the top-level flat files + unique `<folder>` from the folder roots. These get one `<Tabs.Screen>` or `<Drawer.Screen>` each in the outer layout.
2. **Inner stacks** = one entry per unique `<folder>`. For each folder, list its children (root + non-root files), with each child's `Presentation` value from the Screen Map.

**Sanity check before writing anything:** if any folder has children but no `index.tsx` row in the Screen Map, STOP and report: `BLOCKED: folder app/(app)/<folder>/ has children (<list>) but no index.tsx row in the Screen Map. Foreground screen planning must emit an index.tsx row for every folder.` This catches a planning mistake that would render the folder unreachable from the outer tab.

Normalize every Screen Map file to its Expo route (strip `.tsx`, collapse trailing `/index`, preserve dynamic segments). If two files normalize to the same route, STOP before writing layouts. In particular, reject `<parent>/[id].tsx` together with `<parent>/[id]/<child>.tsx`; move the detail contract to `<parent>/[id]/index.tsx`.

```text
BLOCKED: duplicate Expo route <route> from <file-a> and <file-b>. Use [id]/index.tsx when a dynamic detail route owns child screens.
```

#### Step 10b.2 — Write per-folder inner `_layout.tsx` files (if any folders exist)

For each entry in the Inner stacks list, create the folder if missing.

For **Tabs / Tabs + Stack**, write
`app/(app)/<folder>/_layout.tsx` with:

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

For **Drawer**, the outer Drawer header is hidden for folder-backed entries, so
the inner Stack owns the root menu button and child back buttons. Write:

```tsx
import { DrawerToggleButton } from '@react-navigation/drawer';
import { Stack } from 'expo-router';

export default function <FolderName>Layout() {
  return (
    <Stack screenOptions={{ headerShown: true }}>
      <Stack.Screen
        name="index"
        options={{ headerLeft: () => <DrawerToggleButton /> }}
      />
      {/* one <Stack.Screen> per non-index child, with presentation from Screen Map */}
      <Stack.Screen name="<child-without-tsx>" options={{ presentation: '<Presentation>' }} />
    </Stack>
  );
}
```

Rules:
- Tabs layouts use `headerShown: false` at the Stack level; each screen sets its
  own header inline via `<Stack.Screen options={{...}}>` at the top of its
  component.
- Drawer folder layouts use `headerShown: true`, put `DrawerToggleButton` on
  the `index` route only, and let child routes receive the Stack's normal back
  button. Screen-level options may style or hide child headers when the
  approved navigation mood requires it, but must not remove the folder root's
  drawer toggle.
- `<Stack.Screen name="index" />` is required — without it, the folder root won't render.
- `presentation: 'modal'` and `presentation: 'formSheet'` come from the Screen Map's Presentation column. Skip the `options` prop entirely for `default` presentation.
- `name` for `[id].tsx` is literally `[id]` (with brackets). When `[id]` owns child routes, create `<folder>/[id]/_layout.tsx` with `<Stack.Screen name="index" />` and child entries; do not register both `[id].tsx` and a `[id]/` folder.
- Folder name in the function name is PascalCase (e.g. `InspectionsLayout`).

**Why this must run BEFORE Step 11:** screen-builders write their files in parallel, multiple builders may target the same folder, and any of them creating `_layout.tsx` would race. The orchestrator owns these files.

#### Step 10b.3 — Write outer `app/(app)/_layout.tsx`

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

Add `import { Tabs } from 'expo-router';`, `import { Ionicons } from '@expo/vector-icons';`, and `import { useThemeTokens } from '@microsoft/power-apps-native-host';` to the import block if not already present. Inside `AppLayout`, after the auth state is read, add `const theme = useThemeTokens();`. Then replace:

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

Run `npx tsc --noEmit` after the edit. If it fails, check that the `Tabs.Screen name` values exactly match the file names under `app/(app)/` (without `.tsx`).

**How to build the `<Drawer>` block (Drawer pattern only):**

Same Outer-entries computation as Tabs — one entry per top-level flat file or folder root from Step 10b.1. Detail, modal, and nested routes are inside their folder's inner stack, not drawer items.

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
        // Include headerShown: false when this entry is a folder root.
        drawerIcon: ({ color }) => <Ionicons name="<icon>" size={22} color={color} />,
      }}
    />
    {/* one Drawer.Screen per top-level destination */}
  </Drawer>
);
```

**Key differences from Tabs:**
- Import is `from 'expo-router/drawer'` (not `from 'expo-router'`)
- Keep outer `headerShown: true` for flat-file destinations so the Drawer
  supplies the hamburger button.
- Add `headerShown: false` to every folder-backed `<Drawer.Screen>`. Its inner
  Stack supplies `DrawerToggleButton` on the folder root and normal back
  buttons on children. This prevents nested duplicate headers without making
  the Drawer unreachable.
- `drawerType: 'front'` — standard mobile pattern (drawer slides over content)
- Icon prop is `drawerIcon` (not `tabBarIcon`)

Run `npx tsc --noEmit` after the edit. If it fails, check that the `Drawer.Screen name` values exactly match the file names under `app/(app)/` (without `.tsx`).

### Step 10.7 — Snapshot generated services into the plan

**Print before starting:**
> "→ [Step 10.7/13] Probing src/generated/services/ and writing the execution service registry…"

Before spawning N parallel screen-builders, the orchestrator probes
`src/generated/services/` once and writes
`.tmp/generated-services-snapshot.md`. Keep the approved plan immutable after
Gate 4; execution-derived service inventory does not rewrite or restamp it.
Without this registry, every builder may spell service names differently.

```bash
cd <working_dir>
ls -1 src/generated/services/*.ts 2>/dev/null | sed 's|src/generated/services/||;s|\.ts$||'
```

For each service file found, run a quick grep to list its exported methods so builders know what's actually available without re-reading the (large) generated file:

```bash
for svc in $(ls -1 src/generated/services/*.ts 2>/dev/null); do
  name=$(basename "$svc" .ts)
  methods=$(grep -oE 'static async [a-zA-Z_]+' "$svc" | sed 's/static async //' | tr '\n' ',' | sed 's/,$//')
  echo "| \`$name\` | \`src/generated/services/$name.ts\` | $methods |"
done
```

Write/replace `.tmp/generated-services-snapshot.md` on every run:

```markdown
# Generated Services (snapshot at <ISO timestamp>)

| Service | Path | Methods present |
|---|---|---|
| `Cr3e9_projectsService` | `src/generated/services/Cr3e9_projectsService.ts` | `getAll, get, create, update, delete` |
| `Cr3e9_tasksService` | `src/generated/services/Cr3e9_tasksService.ts` | `getAll, get, create, update, delete` |

**For screen-builders:** if a service your spec references is in this table, import it and use the exact name + methods listed. If it is NOT in this table, the data source has not been added yet — write the screen with the expected import path and a `// TODO(connector-not-yet-added): run /add-dataverse to generate <ServiceName>` comment so the user can see what's blocked. Do not invent or rename services.
```

If the directory is empty (no data sources added yet), still write the section with an empty table and a one-line note: "No generated services yet — builders will emit TODO stubs for any service their spec references."

### Step 10.8 — Generate app-specific shared code + screen skeletons

**Print before starting:**
> "→ [Step 10.8/13] Generating app-specific components, hooks, utils, and screen skeletons from the plan…"

This step analyzes the per-screen specs and generates **shared code that multiple screens will use** plus **typed skeleton files** for each screen. Builders then fill in the JSX rather than starting from zero. This cuts builder output by ~50% and eliminates import-path guessing errors.

---

#### 10.8a — Analyze plan for cross-screen patterns

Read all per-screen specs in `## Screens → ### Per-Screen Specs`. Identify:

1. **Entity cards/rows** — if 2+ screens render the same entity (same Service) in a card/row format, generate a shared component.
2. **Choice column maps** — if 2+ screens reference the same choice column (e.g. `status: 1=Pending, 2=Active`), generate a constants file.
3. **Custom hooks** — if 2+ screens call the same service with similar params (e.g. both list + detail call `InspectionsService`), generate a domain hook.
4. **Shared formatters** — if screens need entity-specific formatting (e.g. "inspection title" = `${name} · ${equipment}`), generate a formatter.

**Decision rules:**

| Pattern in specs | Generate | Where |
|---|---|---|
| Same entity shown as list-item on 2+ screens | `<Entity>Card.tsx` or `<Entity>Row.tsx` | `src/components/` |
| Same choice column referenced on 2+ screens | `constants.ts` with `ENTITY_STATUS` map + tone mapping | `src/utils/` |
| Same bounded service + similar `.getAll()` params on 2+ screens | `use<Entity>List.ts` wrapping `useListData` | `src/hooks/` |
| Same cursor-paginated service on 1+ unbounded screens | `use<Entity>CursorList.ts` wrapping `useCursorListData` | `src/hooks/` |
| Entity detail + edit screens for same entity | `use<Entity>.ts` with get + save + delete | `src/hooks/` |

**Write the files directly into the project** (not into samples — these are app-specific):

```bash
# Example — if plan has "Inspections" entity used on list + detail + home screens:
cat > "<working_dir>/src/components/InspectionRow.tsx" << 'EOF'
... generated component ...
EOF
```

If no cross-screen patterns are found (e.g. only 2 screens total with no overlap), skip this sub-step — the shared scaffold is sufficient.

---

#### 10.8b — Generate screen skeletons

For each screen in the plan's Screen Map that will be built by a screen-builder, write a **typed skeleton** file at its `target_file` path. The skeleton contains:

1. All imports (components, hooks, utils, services, types) pre-resolved
2. The exported component function with typed props/params
3. The hook calls (e.g. `useListData`, `useSearchFilter`, `useLocalSearchParams`)
4. An empty return with a `// TODO: screen-builder fills JSX here` marker

**Skeleton template for a Cursor List screen (`Pagination: cursor`):**
```tsx
import React from 'react';
import { FlatList, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { YStack, XStack, Text, Input, Spinner } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LoadingState, ErrorState, EmptyState, ScreenHeader } from '@/components';
import { useCursorListData } from '@/hooks';
import { containsFilter, formatDate, choiceLabel } from '@/utils';
import { <Service> } from '@/generated/services/<Service>';
import type { <Entity> } from '@/generated/models/<Entity>Model';
// App-specific imports (if generated at 10.8a):
import { <Entity>Row } from '@/components/<Entity>Row';
import { <ENTITY>_STATUS } from '@/utils/constants';

export default function <ScreenName>() {
  const router = useRouter();
  const { items, loading, refreshing, loadingMore, hasNextPage, error, query, setQuery, onRefresh, refetch, loadMore } = useCursorListData<<Entity>>({
    queryKey: ['<entityPlural>'],
    fetchPage: ({ pageSize, search, skipToken }) => <Service>.getAll({
      maxPageSize: pageSize,
      orderBy: ['<orderField> desc', '<primaryKey> asc'],
      select: [<renderedColumns>],
      ...(search ? { filter: containsFilter('<searchColumn>', search) } : {}),
      ...(skipToken ? { skipToken } : {}),
    } as any),
  });

  // TODO: screen-builder fills JSX here. FlatList MUST wire:
  // - data={items}
  // - refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
  // - onEndReached={hasNextPage ? loadMore : undefined}
  // - ListFooterComponent={loadingMore ? <Spinner /> : null}
  return null;
}
```

**Skeleton template for a Bounded List screen (`Pagination: none`):**
```tsx
import React from 'react';
import { FlatList } from 'react-native';
import { useRouter } from 'expo-router';
import { YStack, XStack, Text, Input } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LoadingState, ErrorState, EmptyState, ScreenHeader } from '@/components';
import { RefreshControl } from 'react-native';
import { useListData, useSearchFilter } from '@/hooks';
import { formatDate, choiceLabel, normalizeDataverseGuid } from '@/utils';
import { <Service> } from '@/generated/services/<Service>';
import type { <Entity> } from '@/generated/models/<Entity>Model';
// App-specific imports (if generated at 10.8a):
import { <Entity>Row } from '@/components/<Entity>Row';
import { <ENTITY>_STATUS } from '@/utils/constants';

export default function <ScreenName>() {
  const router = useRouter();
  const { items, loading, refreshing, error, onRefresh, refetch } = useListData(
    () => <Service>.getAll({ orderBy: ['<orderField> desc'], top: 50 }),
  );
  const { query, setQuery, filtered } = useSearchFilter(items, [<searchKeys>]);

  // TODO: screen-builder fills JSX here
  return null;
}
```

Do NOT use the bounded skeleton for a screen whose spec says `Pagination: cursor`. `useListData` fetches one bounded page; `useSearchFilter` filters only loaded rows. Cursor screens must use `useCursorListData`, `useInfiniteQuery`, or an app-specific cursor hook generated in 10.8a.

**Skeleton template for a Detail screen:**
```tsx
import React from 'react';
import { ScrollView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { YStack, XStack, Text, Button } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LoadingState, ErrorState, BottomActionBar, InfoRow } from '@/components';
import { formatDate, choiceLabel } from '@/utils';
import { <Service> } from '@/generated/services/<Service>';
import type { <Entity> } from '@/generated/models/<Entity>Model';

export default function <ScreenName>() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const rawId = Array.isArray(params.id) ? params.id[0] : params.id;
  const id = normalizeDataverseGuid(rawId);
  const router = useRouter();
  const [item, setItem] = React.useState<<Entity> | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!id) return;
    const load = async () => {
      const result = await <Service>.get(id);
      if (!result.success) {
        setLoading(false);
        return;
      }
      setItem(result.data ?? null);
      setLoading(false);
    };
    void load();
  }, [id]);

  // TODO: screen-builder fills JSX here
  return null;
}
```

**Skeleton template for a Form screen:**
```tsx
import React, { useState } from 'react';
import { Alert, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { YStack, Text, Button, Input } from 'tamagui';
import { ModalHeader, FormField, RowPick } from '@/components';
import { <Service> } from '@/generated/services/<Service>';

export default function <ScreenName>() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  // Form state fields from spec:
  <field_declarations>

  const submit = async () => {
    // TODO: screen-builder fills validation + service call
  };

  // TODO: screen-builder fills JSX here
  return null;
}
```

**Auth-exit skeleton augmentation** (apply only to the screen whose spec
contains `Sign-out affordance`; a dedicated `/(app)/profile` route is
conditional):
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

**Rules for skeleton generation:**
- Replace `<Service>`, `<Entity>`, `<ScreenName>`, `<searchKeys>`, `<orderField>`, `<field_declarations>` with actual values from the plan's per-screen spec + `.tmp/generated-services-snapshot.md`.
- If a service is NOT in `.tmp/generated-services-snapshot.md`, still write the import but add `// TODO(connector-not-yet-added)` above it.
- A dedicated Profile skeleton may also include generated service/model
  imports when its planned content requires persisted app-specific user
  context.
- The skeleton is a **valid TypeScript file** (compiles with `return null`) — builders replace the `return null` with real JSX.
- Do NOT write skeletons for screens that already exist in the template (e.g. `home.tsx` if it's already present).
- The one planned auth-exit surface keeps `handleSignOut` and wires the planned
  `Sign out` button to it. Do not inline a second auth/logout path.
- Do not generate a Profile route when account/profile work is not in Product
  Scope. A sheet or menu on an existing screen may own this helper.
- **Never destructure `user`, `account`, `profile`, or `claims` from `useAuth()`** — those fields do not exist on `AuthState`. The only fields are `isLoading`, `isAuthReady`, `isSignedIn`, `error`, `acquireToken`, `signIn`, `signOut`. If the screen needs the signed-in user's name/email, add a `// TODO: decode ID token claim` comment — do not invent a field.

---

#### 10.8c — DEPRECATED (skeleton is the import source of truth)

This sub-step previously appended `### Standard Imports` + per-screen `#### Resolved Imports` blocks into the plan. That added ~150 lines on a 14-screen plan and duplicated the imports already pre-resolved into each skeleton file at Step 10.8b.

**The skeleton file IS now the single source of truth** for per-screen imports + hook calls. The screen-builder reads the skeleton at `target_file` and fills the JSX. Do NOT append duplicate import documentation into the plan.

#### 10.8d — Navigation/skeleton TypeScript gate

After Step 10b layouts, Step 10.7 service snapshot, and Step 10.8 shared code/skeletons are all written, run the **Navigation/skeleton gate**:

```bash
npx tsc --noEmit
```

If this fails, do not launch Step 11. Capture the full error list once, batch-fix layout names, route paths, skeleton imports, shared component exports, generated service imports, or hook signatures, then rerun the gate. Screen-builders should start only from a clean shell with typed skeletons that compile with `return null`.

Record the clean screen-build boundary:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/mobile-pipeline-state.js" \
  --project-root "<working_dir>" --record --step "10.8" \
  --artifact "service-registry=.tmp/generated-services-snapshot.md" \
  --artifact "power-config=power.config.json" \
  --artifact "package=package.json" \
  --artifact "auth=auth.config.json" \
  --artifact "tamagui=tamagui.config.ts" \
  --artifact-tree "routes=app" \
  --artifact-tree "source=src"
```
