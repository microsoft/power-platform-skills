# Navigation and Screen Preparation

Follow the retained
[`Live Build Plan protocol`](./build-plan.md). Mark `navigation` active before
Step 10b and complete only after layouts, shared code, skeletons, routes, and
the navigation TypeScript gate are valid.

### Step 10b — Wire navigation layout

Read `<working_dir>/.tmp/navigation-manifest.json` as the only navigation
execution input. It must be the current Phase 3 projection of Product Scope;
if it is missing or stale, return to Phase 3 and rerun
`compile-navigation-manifest.js`. Do not reconstruct navigation from human plan
prose, route files, folder names, or screen-name heuristics.

Product Scope remains the planning authority. The manifest is its canonical,
deterministic execution projection and must not be hand-edited to make a layout
pass.

Before writing any navigation or skeleton file, verify the all-mode usage
binding from Phase 3:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-data-model-usage.js" \
  --project-root "<working_dir>" --check
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-fixture-scenarios.js" \
  --project-root "<working_dir>" --check
```

A failure returns to the owning Phase 3 contract and Gate 2. Do not repair
usage by inferring a consumer from a route, screen, service, or table name, and
do not restamp or recreate scenario values in this phase.

#### Step 10b.1 — Resolve registrations from the manifest

Use the manifest fields without adding or inferring destinations:

| Manifest field | Layout rule |
|---|---|
| `pattern` | Select exactly one outer `Tabs`, `Drawer`, or `Stack` navigator for `tabs-plus-stacks`, `drawer`, or `stack-only`. |
| `visibleTabs` | For `tabs-plus-stacks`, emit exactly these visible outer entries in array order. |
| `durableDestinations` | For `drawer`, emit exactly these visible drawer entries in array order. For tabs or stack, use them only as declared durable roots. |
| `screens` | Treat this object as the complete set of planned Expo routes and shell behavior. Do not discover additional entries from the filesystem. |
| `iconName` | Use the destination's value directly for `tabBarIcon` or `drawerIcon`. Never derive an icon from an ID, label, route, or screen name. |
| `parentTabId` | Place the screen in that visible tab's nested stack. A non-null value must resolve to one `visibleTabs[].destinationId`. |
| `tabVisible` | Keep or hide the parent tab bar on that route exactly as declared. It does not decide whether the route is an outer tab. |
| `headerMode` | Use root-header behavior for `root` and child-header behavior for `back`. |
| `backBehavior` | Emit no back affordance for `none`, normal stack pop for `stack-pop`, and the declared stack-only return action for `return-home`. |
| `targetPath` | Derive the Expo route file, outer entry name, and nested `Stack.Screen` name from this canonical route only. |

For each destination or screen, strip the leading slash from `targetPath` and
split it into route segments. The first segment is the outer entry name. The
remaining segments form the nested stack registration; use `index` for the
root screen of a folder. Preserve dynamic segments such as `[id]` literally.
If a required `targetPath` is null, two screen IDs claim the same path, or a
`parentTabId` points to a different top-level segment than its parent
destination, stop with `BLOCKED` and repair Product Scope through Phase 3.

#### Step 10b.2 — Write per-folder inner `_layout.tsx` files (if any folders exist)

Create folders and nested `_layout.tsx` files only from relationships expressed
by `screens[*].targetPath` and `parentTabId`. Never scan `app/(app)` to decide
which stacks exist.

- Register every folder root as `index` and every descendant by its literal
  path relative to that folder, without `.tsx`.
- Under tabs, a screen with `parentTabId` belongs to that tab's inner `Stack`.
  Apply `tabVisible` on the active route instead of promoting or removing the
  screen from `visibleTabs`.
- Under a drawer, each durable destination's folder stack owns its root menu
  affordance; screens with `headerMode: back` and `backBehavior: stack-pop`
  receive the normal Stack back affordance.
- Under stack-only navigation, preserve manifest screen order and register
  nested stacks from `targetPath`; a root with `backBehavior: return-home`
  implements the manifest's declared return-home mechanism.
- `headerMode: root` with `backBehavior: none` must not render a back control.
  Do not override `headerMode: back` with a second custom root header.

The foreground orchestrator owns every `_layout.tsx` file. Write them before
Step 11 so parallel screen builders never race on shared navigation files.

#### Step 10b.3 — Write outer `app/(app)/_layout.tsx`

Preserve the existing auth guard and unrelated code in the outer layout. Add
only the navigator, icon, and theme imports required by `pattern`.

- For `tabs-plus-stacks`, render `Tabs.Screen` entries from `visibleTabs` only,
  in manifest order. Use each destination's `label`, `targetPath`, and
  `iconName` directly.
- For `drawer`, render `Drawer.Screen` entries from `durableDestinations` only,
  in manifest order. Use each destination's `label`, `targetPath`, and
  `iconName` directly. Folder-backed roots delegate their menu/back headers to
  the inner Stack.
- For `stack-only`, render an outer `Stack` and registrations derived from
  `screens[*].targetPath`, `headerMode`, and `backBehavior`. Do not add tab or
  drawer imports.

Expo Router auto-registers top-level routes. Any manifest screen whose
`targetPath` creates a top-level entry that is not a visible entry for the
selected pattern must be nested under its declared parent or explicitly
registered with `href: null`. It must never surface as a phantom tab or drawer
destination.

The layout validator also checks that every manifest `targetPath` has a route
file, so run it after Step 10.8b has materialized the typed skeletons. Step
10.8d runs this exact command after `check-routes.js`:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-navigation-layout.js" \
  --project-root "<working_dir>"
```

A nonzero exit is `BLOCKED`: do not launch Step 11. Repair only the manifest-
backed layouts or route skeletons reported by the validator, rerun it, and
never fall back to prose, filesystem, or icon inference.

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

For every shared component, hook, and skeleton, consume only the screen's
binding from `.tmp/scenario-facts.json` plus its referenced record IDs,
relationships, media keys, and invariants. Use those values only through the
later bounded work-order projection. Do not hardcode an independent sample
name, status, date, metric, image URL, or fallback into a skeleton.

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
5. Typed placeholders for the screen's canonical scenario binding and media
  keys when the compiled implementation contract requires them

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
node "${CLAUDE_SKILL_DIR}/../../scripts/check-routes.js"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-navigation-layout.js" \
  --project-root "<working_dir>"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-data-model-usage.js" \
  --project-root "<working_dir>" --check
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
  --artifact "data-model-usage=.tmp/data-model-usage.json" \
  --artifact-tree "routes=app" \
  --artifact-tree "source=src"
```
