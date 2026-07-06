# Mobile UI Patterns

Build screens that feel native and polished. This internal reference enforces screen archetypes, required states, and accessibility for Tamagui + Expo apps.

## When to use

- Building any new screen from the plan.md screen inventory
- Reviewing an existing screen for missing states (empty, loading, error)
- Adding accessibility labels, roles, and hit targets
- Choosing between `Sheet`, `Dialog`, and full-screen modal

Not this reference: Tamagui config/theme setup (use `skills/design-system/references/tamagui-integration.md`), overall project planning (use app planner/orchestrator).

## Screen archetypes

Every screen in the plan.md maps to one of these. Pick the right one first, then fill in the archetype's required elements.

### List archetype

Shows many of one entity.

Required:
- Header with contextual title plus count/status/meta when useful; create actions are labeled and bottom-reachable unless this is a single obvious list FAB with an accessibility label
- Search/filter bar if list can exceed ~15 items
- `FlatList` (React Native built-in) for dynamic data; never `.map()` in `ScrollView`
- Empty state (illustration + message + CTA)
- Loading state (skeleton rows, not spinner)
- Error state (message + retry)
- Pull-to-refresh
- Tap item to detail screen

Reference implementation: `shared/samples/screen-list.tsx`.

### Detail archetype

Shows one item with actions.

Required:
- Back button (leftmost in header)
- Hero section (image/title)
- Body sections spaced with `$6` separators or `<Separator />`
- Action buttons (edit, delete, share); destructive actions need confirm via `<AlertDialog>`
- Loading + error states for the single fetch

### Form archetype (create / edit)

Input-heavy.

Required:
- `react-hook-form` + `zod` schema
- Labels above inputs (never placeholder-as-label)
- Inline validation on blur, not every keystroke
- Error text below field, red, with icon
- Submit button disabled until valid
- Loading state on submit (button spinner, inputs disabled)
- `KeyboardAvoidingView` wrapping
- Dismiss-on-tap-outside
- Confirm-on-cancel if form is dirty

Reference: `shared/samples/screen-form.tsx`.

### Auth archetype

Sign-in, sign-up, reset password.

Required:
- Minimal branding (logo + tagline)
- One primary CTA, one secondary link
- Social buttons above email form if enabled
- Errors inline, never in native `Alert`
- Loading state on submit

### Tab-root archetype

Top-level tab destination. Usually wraps a list or home screen.

### Home dashboard pattern

First screen after sign-in. Use this instead of a generic welcome page when the app has meaningful current state: work, progress, requests, approvals, schedules, inspections, dispatch, alerts, goals, balances, projects, bookings, recommendations, or saved activity.

Required shape:
- Context header: role, date, account, team, route, goal, project, course, booking, or user cue
- Current/next item card with status or priority and one clear action
- Progress/status/priority strip when the domain has steps, goals, workflow, risk, or freshness
- 2-4 summary tiles that matter today
- 3-5 recent/upcoming/recommended rows with tap-through
- One bottom primary CTA for the most common next action

Avoid duplicating the first List tab. Home summarizes and routes; the List tab browses everything.

### Modal / Sheet archetype

Short, focused interactions (filter, quick-add, confirm).

Rule: if it could be a `Sheet`, it should be a `Sheet`. Full-screen modals only for multi-step flows.

```tsx
import { Sheet } from 'tamagui'

<Sheet modal open={open} onOpenChange={setOpen} snapPointsMode="fit">
  <Sheet.Overlay />
  <Sheet.Handle />
  <Sheet.Frame p="$4">
    {/* content */}
  </Sheet.Frame>
</Sheet>
```

Requires `PortalProvider`; if missing, see `skills/design-system/references/tamagui-integration.md`.

### Empty / onboarding archetype

First-run or empty-account state. Elements: illustration, 1-sentence value prop, primary CTA.

## Universal checklist (every screen)

- [ ] Wrapped in `SafeAreaView` from `react-native-safe-area-context`
- [ ] Uses Tamagui `YStack`/`XStack` for layout, not raw `View`
- [ ] All spacing via tokens (`$1`-`$10`), not literals
- [ ] All colors via theme (`$background`, `$color`), not hex
- [ ] Has loading, empty, and error state components
- [ ] Works in light AND dark mode (test by toggling)
- [ ] `accessibilityLabel` on every icon-only Pressable
- [ ] `accessibilityRole` on interactive elements
- [ ] Min touch target 44x44 (use `hitSlop` if visual is smaller)
- [ ] No nested touch targets: do not put a `Button`, `Pressable`, `Touchable*`, `Link`, or tappable custom stack inside another `onPress` parent. Decorative children/overlays inside a tappable parent use `pointerEvents="none"`.
- [ ] No visible no-op buttons: if a handler would early-return because required state is missing, disable the button and show a short reason, or do not render it until the state exists.
- [ ] Keyboard doesn't obscure focused input
- [ ] Dynamic type supported (don't disable `allowFontScaling`)

## State patterns (must-have)

Every data-driven screen needs these three components with no exceptions:

```tsx
// EmptyState
<YStack f={1} ai="center" jc="center" p="$6" gap="$3">
  <Image source={emptyIllustration} />
  <H4>No recipes yet</H4>
  <Paragraph ta="center" col="$color10">
    Add your first recipe to get started.
  </Paragraph>
  <Button bg="$blue10" color="$color1" onPress={onAdd}>Add a recipe</Button>
</YStack>

// LoadingState - use skeletons, not spinners
<YStack gap="$3" p="$4">
  {Array.from({ length: 6 }).map((_, i) => (
    <XStack key={i} h={60} bg="$color4" br="$3" />
  ))}
</YStack>

// ErrorState
<YStack f={1} ai="center" jc="center" p="$6" gap="$3">
  <Ionicons name="alert-circle" size={48} color="#E5484D" />
  <H4>Something went wrong</H4>
  <Paragraph ta="center" col="$color10">{error.message}</Paragraph>
  <Button onPress={onRetry}>Try again</Button>
</YStack>
```

## Data fetching pairing

- TanStack Query (`useQuery`) for server state; use `isLoading`, `isError`, `data`
- Map to the three states above

```tsx
const { data, isLoading, isError, error, refetch } = useQuery(...)

if (isLoading) return <LoadingState />
if (isError) return <ErrorState error={error} onRetry={refetch} />
if (!data?.length) return <EmptyState onAdd={handleAdd} />
return <RecipeList recipes={data} />
```

## Navigation patterns (Expo Router)

```text
app/
  (tabs)/                  # tab group (no URL segment)
    _layout.tsx            # Tab bar config
    index.tsx              # first tab
    profile.tsx
  (auth)/                  # auth group, shown when unauthenticated
    _layout.tsx
    login.tsx
    signup.tsx
  recipe/
    [id].tsx               # dynamic detail
    new.tsx                # create form
    [id]/edit.tsx          # edit form
  _layout.tsx              # root layout with providers
  +not-found.tsx
```

Rules:
- Back button only hidden with good reason
- Never nest tabs within tabs
- Modals via `presentation: 'modal'` in `Stack.Screen` options
- Sheets for anything ephemeral (filter, quick-add), not route-based modals

### Navigation and submit idempotency guardrails

- Route intent matrix:
  - Singleton destinations (`/(app)/workout/form`, `/(app)/recovery/form`, `/login`, and planner-marked singleton routes) use `router.navigate(...)`
  - Detail drill-down routes use `router.push(...)`
  - Auth/guard redirects use `router.replace(...)`
- Every primary navigation action is duplicate-tap safe with an `isNavigating` lock (`if (isNavigating) return;` then set true before route call and clear in `finally`).
- Every async submit/save action is idempotent with `isSubmitting` or React Query `isPending` lock.
- Busy submit CTA behavior is mandatory: disabled while pending + label swap (`Save` -> `Saving...`).
- Error path is mandatory: failed submits stay on-screen with user input preserved; never auto-pop/replace on error.
- Success exit rule: normal edit/create uses `router.back()`; only explicit redirect flows in the screen spec may use `replace`.

## Lists: critical rules

1. Never `.map()` a dynamic array inside `ScrollView`. Use `FlatList`.
2. Always set `keyExtractor`.
3. Memoize list items if they have any non-trivial render.
4. Use `getItemLayout` when row height is fixed.
5. Pull-to-refresh via `refreshing` + `onRefresh` props on FlatList.
6. Pagination rule: if the list queries a Dataverse table with no natural record ceiling, always paginate with a cursor/next-page path. In the Power Apps data SDK this is `maxPageSize` + returned `skipToken`; `top: 50` by itself is only a capped first page. Use deterministic `orderBy` with a unique key, include `select`, and push search into the service `filter`.
7. Search rule: never filter a large list client-side. Push `$filter` to Dataverse.

## References

- `shared/references/screen-templates.md`
- `shared/references/accessibility-checklist.md`
- `shared/references/data-performance.md`
- `shared/samples/screen-list.tsx`
- `shared/samples/screen-detail.tsx`
- `shared/samples/screen-form.tsx`
