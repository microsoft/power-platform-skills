# Screen Templates

Detailed archetype specifications. The SKILL.md has the summary; this is the full version.

## Catalogue keys (referenced from per-screen specs)

`agents/screen-planner.md` Step 4 emits row style, hero type, and operational pattern by **key only** (e.g. `Row style: status-stripe-card`). The descriptions live here so they're authored once and read by the screen-builder when it materializes the spec into TSX. Builders MUST resolve unknown keys by looking them up in this section before falling back to a generic layout.

### Row style keys (List screens)

Pick the row style that surfaces what matters for the entity. Never pick `status-stripe-card` by default just because it's most common.

| Key | Use when | Visual |
|---|---|---|
| `status-stripe-card` | Entity has a status field that's the most important signal | Left colored border (4px, status color) + title + 1-2 metadata lines |
| `avatar-row` | Entity is a person, company, or assigned-to record | Circular avatar/initials (40pt) + name + subtitle + chevron |
| `stat-card` | Entity has a key numeric metric (count, amount, percentage, duration) | Large number prominent, entity name secondary, supporting metadata tertiary |
| `media-tile` | Entity has a photo or image field | Square/rect image left or top, title + metadata text right/below |
| `sentence-row` | Entity reads naturally as a sentence (activity, event, log entry) | No card border, full-width separator only, icon left, text right |
| `timeline-row` | Entity is time-ordered with a date/time as primary signal | Date displayed prominently (left column or above title), no card bg |
| `checklist-row` | Entity is a task or completable item | Checkbox left, title + metadata, strike-through on completed |

### Hero type keys (Detail screens)

Pick the hero treatment that matches the entity. Never default to "H2 title + InfoRows".

| Key | Use when | Visual |
|---|---|---|
| `status-header-band` | Status/approval is the primary signal | Full-width colored bar at top with large status text (white on color), entity name below |
| `stat-grid` | Entity has 3–6 key numeric metrics | 2×N grid of stat tiles with large numbers and small labels, below a compact title |
| `image-hero` | Entity has a photo field | Full-width image (200–280pt tall), title overlaid at bottom with gradient scrim |
| `identity-block` | Entity is a person/organization | Large avatar (72pt), name as H1, role/company as subtitle, action row below |
| `summary-card` | Entity has a rich description or long text | Prominent `Paragraph` block with pull-quote styling, details below |
| `timeline-header` | Entity is an event or has a date range | Large date display at top, timeline indicator, status below |
| `minimal-header` | Entity is data-dense with many fields | Standard title only — data speaks for itself through well-structured InfoRows |

### Operational pattern keys (Home + workflow screens)

Use these pattern names when the user's app has dashboard or workflow behavior. These are still implemented as the normal archetypes (List/Detail/Form/Tab-root), but naming the pattern prevents builders from reducing them to generic CRUD. `home-dashboard` is cross-domain; the rest are common in inspection, dispatch, safety, warehouse, maintenance, aviation, and field-service workflows.

| Key | Use when | Required layout pieces |
|---|---|---|
| `home-dashboard` | The first screen after sign-in needs to summarize current state, progress, recent/upcoming activity, and next action | Context header, current/next item card, progress/status/priority strip, 2–4 summary tiles, 3–5 recent/upcoming/recommended rows, one bottom primary CTA |
| `assignment-dashboard` | A worker starts from one active assignment, route, job, visit, or flight | Current assignment hero, progress/step bar, 2–4 KPI tiles, recent activity rows, one bottom primary CTA |
| `walkaround-stepper` | A task has ordered zones/steps that can be revisited | Sticky step header with Step N / total, previous/next controls, evidence section, per-step defect chips, completion gate copy |
| `wizard-progress-stepper` | A workflow is split into multiple form-like steps: onboarding, appointment creation, quote/order creation, request forms | Current step and total steps, optional step labels, Back/Next/Save or Finish, current-step validation gate, draft preservation across steps, dirty-cancel confirmation, final save action |
| `floating-action-menu` | One screen needs 2-5 related quick actions from a compact trigger: create visit/event/order, add item, import/export | Visible trigger button, Sheet/Popover/Menu, `ActionRow` items with icon + label, dismiss on outside/back/select, safe-area aware position above tabs/home indicator, route/action per item |
| `scan-geofence-gate` | Start requires identity, QR/barcode, NFC, camera, or location verification | Scan/camera target or manual fallback, location confidence state, retry/override path, audit note for override |
| `severity-filtered-queue` | Users triage defects, tickets, exceptions, alerts, or incidents | Segmented severity chips, status chips, dense rows with ID + short description + related asset, clear active-filter count |
| `dispatch-signoff-queue` | Final hand-off/sign-off locks records or sends work to another team | Submitted/ready queue, explicit lock/sign-off state, biometric/PIN gate if required, immutable audit message after completion |
| `audit-timeline` | Users review who changed what and when | Toggle between domain grouping and chronological log, timestamp + actor + action rows, hash/verification status when relevant |

### Calendar pattern keys (Calendar / schedule / appointment screens)

Calendar management screens should use `react-native-calendars` when the package is present. These keys let the planner specify the expected calendar surface without inlining implementation details into every screen spec.

| Key | Use when | Required layout pieces |
|---|---|---|
| `expandable-calendar-agenda` | Personal/team/POS calendar management views where users move between month context and daily agenda | `CalendarProvider`, `ExpandableCalendar`, `AgendaList`, selected-date state, marked dates/count dots, pull-to-refresh agenda rows, empty day state |
| `month-agenda` | Appointment list screens that need month selection plus rows below | `Calendar` or compact `CalendarList`, marked dates, selected day header, agenda `FlatList`, create/view appointment CTA |
| `calendar-list-range` | Users browse date ranges across multiple months | `CalendarList`, range or multi-dot marking, sticky selected-range summary, rows filtered by visible date/range |
| `timeline-day-list` | The template does not include `react-native-calendars`, or the app intentionally wants a lightweight schedule timeline | Horizontal date chip strip, date-grouped `FlatList`, today shortcut, empty day state |

For TWEED-style field-sales calendars, use `expandable-calendar-agenda` for Personal, Team, and POS calendar views, and `month-agenda` for appointment lists.

### Control pattern keys (field and row controls)

Use these keys when a screen needs a specialized control that is more specific than a normal Button/Input/Select but still generic across industries. Per-screen specs reference the key and provide only the app-specific values such as label, min, max, step, and commit behavior.

| Key | Use when | Required layout pieces |
|---|---|---|
| `checkbox-field` | A boolean or multi-select value should be toggled explicitly: consent, completed, include/exclude, required flags, feature flags, checklist items | Tamagui `Checkbox` with label to the right, row tap toggles the value, checked/unchecked/disabled states, helper/error copy, boolean vs multi-select mapping, accessibility role/state |
| `numeric-stepper` | A bounded numeric field should be adjusted with plus/minus instead of free typing: quantity, servings, seats, guests, rooms, inventory count, score, priority, duration, samples, attendees | Decrement button, current value, increment button, min/max/step, disabled state at bounds, optional direct numeric input for large ranges, accessible labels for both buttons, commit behavior |
| `line-item-stepper-row` | A list row combines item identity with inline quantity/count adjustment: products in an order, inventory pick list, sample request, menu item, booking add-on, equipment count | Item code/image/title/subtitle, price or secondary metric when applicable, `numeric-stepper`, selected-state cue when value > 0, optional line total, bottom summary recalculated from local state |
| `searchable-lookup-sheet` | A Dataverse lookup or ComboBox has too many records for an inline select: account, contact, product, owner, location, category, parent record | Trigger row, Sheet/modal with search input, `FlatList`, `RowPick` rows, selected ID state, display/subtitle fields, cursor pagination for unbounded tables, loading/empty/error states, lookup `@odata.bind` output |
| `segmented-control` | 2-5 bounded mutually-exclusive options should be switched quickly: mode, status filter, calendar scope, order type, priority, view type | Horizontal buttons/chips, selected state, generated option const mapping for Dataverse choices, optional counts, accessible selected state, no wrapping into card grid |
| `recurrence-rule-editor` | A user configures a repeating schedule: appointments, recurring visits, maintenance, tasks, classes, sessions | Recurrence pattern, start date, optional end date, start/end time when applicable, weekday selection for weekly recurrence, data-model mapping for explicit days or numeric weekday mask, summary text, invalid-combination validation |

Prefer `line-item-stepper-row` for TWEED-style product/order rows. Prefer plain `numeric-stepper` for standalone form fields such as attendees, room count, serving count, or score.

When a per-screen spec emits `Operational pattern: <key>`, the screen-builder MUST include the listed layout pieces. The archetype (List/Detail/etc.) is the implementation shell; the operational pattern is the UX contract.

---

## Naming a screen in plan.md

```
- ScreenName — archetype — purpose — data — navigates to
```

Example:
```
- RecipesList — list — browse all recipes — Recipe[] — "+" → RecipeForm; tap → RecipeDetail
- RecipeDetail — detail — view a recipe — Recipe — edit → RecipeForm
- RecipeForm — form — create/edit recipe — Recipe — save → back
- Profile — tab-root — user's content + settings — User + Recipe[]
```

## Archetype: List

**Purpose:** browse many of one entity.

**Layout:**
```
┌─────────────────────────┐
│ Header   [+]            │
│ [🔍 Search]             │
│ ┌─ item ──────────────┐ │
│ └─────────────────────┘ │
│ ┌─ item ──────────────┐ │
│ └─────────────────────┘ │
│ ...                     │
└─────────────────────────┘
```

**Required states:**
- Loading (skeleton rows, never spinner for lists)
- Empty (illustration + value prop + CTA)
- Error (message + retry)
- Populated (the happy path)

**Tamagui components:**
- Wrapper: `YStack f={1} bg="$background"`
- Header: `XStack ai="center" jc="space-between" p="$4"`
- Search: `Input size="$4"` with leading icon
- List: `FlatList` (React Native built-in)
- Rows: `ListItem` or custom `XStack` with `pressStyle`

## Archetype: Detail

**Purpose:** view one entity with actions.

**Layout:**
```
┌─────────────────────────┐
│ [<] Title       [⋯]    │
│ ┌─ hero image ────────┐ │
│ └─────────────────────┘ │
│ Title                   │
│ Subtitle                │
│ ─────────────────────── │
│ Section 1               │
│ Section 2               │
│ [Edit] [Delete]         │
└─────────────────────────┘
```

**Required:**
- Back button (native Expo Router header handles this)
- Destructive actions via `AlertDialog` confirmation
- Loading + error states for the fetch

## Archetype: Form

**Purpose:** create or edit one entity.

**Required:**
- `react-hook-form` with `zodResolver(schema)`
- `KeyboardAvoidingView` around the form body, not the whole screen (behavior="padding" on iOS)
- Header/chrome outside the keyboard-adjusted body so the keyboard does not shove the whole screen upward
- Labels **above** inputs, not as placeholders
- Validation on blur
- Error text: red, below field, icon + text
- Submit disabled until `formState.isValid`
- Submit shows spinner, disables form during save
- If form is dirty on cancel/back, show confirm dialog

**Tamagui pattern:**
```tsx
<Form onSubmit={handleSubmit(onSubmit)}>
  <YStack gap="$4">
    <Label htmlFor="title">Title</Label>
    <Controller control={control} name="title" render={({ field, fieldState }) => (
      <YStack gap="$1">
        <Input {...field} size="$4" />
        {fieldState.error && <Text col="$red10">{fieldState.error.message}</Text>}
      </YStack>
    )} />
    <Form.Trigger asChild>
      <Button bg="$blue10" color="$color1" disabled={!formState.isValid || formState.isSubmitting}>
        {formState.isSubmitting ? 'Saving…' : 'Save'}
      </Button>
    </Form.Trigger>
  </YStack>
</Form>
```

## Archetype: Auth

**Purpose:** sign-in, sign-up, reset.

**Structure:**
- Minimal branding (logo + one-line tagline)
- Primary CTA — "Sign in" button
- Secondary link — "Create account"
- Social buttons ABOVE email form if enabled
- Errors inline — never `Alert.alert()`
- Loading state on submit

**Don't:**
- Auto-submit on keystroke
- Require weird password rules without showing them
- Use native `Alert` for errors

## Archetype: Tab-root

**Purpose:** top-level navigation destination.

Usually wraps a List archetype or a Home/Feed. The tab itself is configured in `app/(tabs)/_layout.tsx`.

### Home Dashboard Pattern

Home is the first screen after sign-in and should usually be a dashboard, not a welcome page. Use this when the app has meaningful current state: work, progress, tasks, inspections, approvals, schedules, dispatch, learning progress, requests, alerts, goals, balances, projects, bookings, recommendations, or saved activity.

**Purpose:** answer "what matters now, what changed recently, and what should I do next?" in one glance.

**Layout:**
```
┌─────────────────────────┐
│ Context / current role  │
│ ┌─ current / next item ┐│
│ │ title + status + CTA ││
│ └──────────────────────┘│
│ Progress / status strip │
│ ┌ KPI ┐ ┌ KPI ┐ ┌ KPI ┐│
│ Upcoming / Recent rows  │
│ [Bottom primary CTA]    │
└─────────────────────────┘
```

**Required:**
- Context header: user, shift, team, date, route, assignment, or other domain cue
- Current/next item card: one thing to start, resume, review, or approve
- Progress/status strip when the domain has steps or workflow state
- 2–4 KPI tiles only; avoid stat confetti
- 3–5 recent/upcoming rows with tap-through to the relevant list/detail
- One primary CTA near the bottom or in native bottom chrome

**Domain variants:**
- Field/inspection: current assignment, step progress, defect count, recent inspections
- Learning: next lesson, course progress, streak, recommended practice
- Finance: balance/health summary, upcoming due item, recent activity, review CTA
- Healthcare/wellness: next appointment/task, care-plan progress, reminders, check-in CTA
- CRM/sales: pipeline summary, overdue follow-ups, recent accounts, log interaction CTA
- Consumer/service: upcoming booking/order, saved item, recommendations, support CTA

**Don't:**
- Do not show a generic "Welcome" hero with no operational content
- Do not make Home a duplicate of the first list tab
- Do not show more than 4 stats above the fold
- Do not hide the primary next action in the top-right header

## Archetype: Modal / Sheet

**When to use which:**
- **Sheet** — filter, quick-add, date picker, action menu. Most things.
- **Dialog** — confirmations, small alerts. Not for content.
- **Full-screen modal** — multi-step flow (checkout, onboarding wizard).

**Always use `Sheet` first.** Only upgrade to full-screen modal if the flow has >3 steps or needs its own navigation stack.

## Archetype: Empty / Onboarding

**Purpose:** first-run or empty-account state.

**Elements:**
- Illustration (not a generic icon)
- Headline (what the screen *will* show)
- 1-sentence value prop
- Primary CTA to the first meaningful action

**Never:** show "No items" with nothing else. Every empty state should point to the next action.

## Loading state choices

- **Initial fetch:** skeleton UI matching real layout
- **Refresh:** pull-to-refresh spinner via FlatList `refreshing` + `onRefresh` props
- **Submit:** button spinner + disabled form
- **Background refetch:** subtle indicator, don't block UI

Never a full-screen spinner for initial load — always skeleton. Spinners feel like the app is broken.

## Error state guidelines

- Human-readable message, not stack traces
- Always offer retry
- For network errors, explicitly say "Check your connection"
- For 404s, offer a way back ("Go to list")
- Log the actual error to your telemetry; show a friendly version

## Accessibility requirements (every screen)

See `./accessibility-checklist.md`.

- Every icon-only button has `accessibilityLabel`
- Every pressable has `accessibilityRole`
- Touch targets ≥ 44×44
- Text contrast ≥ 4.5:1
- Focus order matches visual order
- Dynamic type not disabled

---

## Illustration & asset guidance

### Empty states

Every empty state should have a visual element beyond just text. In priority order:

1. **Ionicon** (available via `@expo/vector-icons`, already in the upstream template) — always available, zero config. Use `size={48}` with a muted hex like `#9BA1A6` for a non-competing visual.
2. **Custom SVG** — if the brand provides illustrations, import via `react-native-svg`. Place in `assets/illustrations/`.
3. **Placeholder image** — `<Image source={require('../assets/empty-state.png')} />`. Must provide light + dark variants.

**Never** use: generic stock photos, AI-generated images in the app itself, or emojis as primary illustration.

### Icon choices by screen type

| Screen purpose | Recommended icon (Ionicons) | Import |
|---|---|---|
| Empty list | `mail-open-outline` | `@expo/vector-icons` |
| No search results | `search-outline` | `@expo/vector-icons` |
| No documents | `document-outline` | `@expo/vector-icons` |
| No people/team | `people-outline` | `@expo/vector-icons` |
| Error state | `alert-circle` | `@expo/vector-icons` |
| Success/complete | `checkmark-circle` | `@expo/vector-icons` |
| Offline | `cloud-offline-outline` | `@expo/vector-icons` |
| No permissions | `shield-outline` | `@expo/vector-icons` |
| Onboarding welcome | `sparkles` | `@expo/vector-icons` |

### Image handling

- Always use `expo-image` (not React Native `Image`) for remote images — it handles caching, progressive loading, and placeholder blur.
- Provide `contentFit="cover"` for hero images, `contentFit="contain"` for logos.
- Add a `$color4` background behind images so there's no flash of white during load.
- For user avatars, always include a fallback with initials (see Avatar recipe in `tamagui-component-recipes.md`).

### Dark mode assets

If using custom illustrations:
- SVGs: use `currentColor` or Tamagui tokens so they adapt automatically
- PNGs: provide `*-dark.png` variants and switch based on `useColorScheme()`
- Prefer SVGs — they scale and theme automatically

---

## Typography by Archetype

When the plan's `## Design` specifies a font pairing (e.g., `Typography: paired: heading=Lora, body=Inter`), apply the heading/body split per archetype as shown below. If `Typography: single-family`, use weight differentiation only — the `$heading`/`$body` distinction still applies via font weight.

| Archetype | Title treatment | Body treatment | Special rules |
|---|---|---|---|
| **List** | `fontFamily="$heading"` on screen title only; rows use `$body` | Row titles `fontWeight="600"`, descriptions `$color10` | Monospace (`$mono`) for IDs/timestamps in row metadata |
| **Detail** | `fontFamily="$heading"` on entity title + section headers | Body prose at `lineHeight` 1.6x, `maxWidth={520}` | Negative tracking on hero title (`letterSpacing` -0.5 to -1.0 at `$7`+) |
| **Form** | `fontFamily="$body"` throughout | Labels `fontSize="$3"`, inputs `fontSize="$4"` | No serif in forms — forms are UI chrome, serif slows scanning |
| **Auth** | `fontFamily="$heading"` on app name/tagline only | Everything else `$body` | Centered title is acceptable here (exception to left-align rule) |
| **Tab-root** | Inherits from child archetype (usually List) | N/A | Tab bar labels always `$body`, `fontSize="$1"` |
| **Modal/Sheet** | `fontFamily="$body"` throughout | Compact sizing, tighter line-height | Sheet titles `fontWeight="700"` for emphasis |
| **Empty/Onboarding** | `fontFamily="$heading"` on headline | Description at generous `lineHeight` 1.6x, `maxWidth={420}` | Centered layout is acceptable here |

---

## Copy Tone by Archetype

When the plan's `## Design` specifies a copy tone (e.g., `Copy tone: Warm`), use the examples below as a starting point. Adapt the entity name to match the app's domain. Full tone reference → [typography-and-tone.md](typography-and-tone.md).

### List screen copy

| Element | Professional | Warm | Utilitarian | Editorial |
|---|---|---|---|---|
| Empty headline | No inspections yet | Ready for your first inspection? | No items | Nothing here yet |
| Empty body | Create an inspection to get started. | Tap below to begin. | — | What will you add first? |
| Empty CTA | New inspection | Create your first | Add | Begin |
| Error headline | Could not load inspections | Something went wrong | Load failed | Could not load |
| Error CTA | Try again | Try again | Retry | Try again |

### Detail screen copy

| Element | Professional | Warm | Utilitarian | Editorial |
|---|---|---|---|---|
| Delete confirm title | Delete this inspection? | Delete this inspection? | Delete? | Delete this entry? |
| Delete confirm body | This cannot be undone. | This will be permanently removed. | Cannot undo. | This cannot be undone. |
| Delete confirm CTA | Delete | Delete | Delete | Delete |
| Delete cancel | Cancel | Keep it | Cancel | Cancel |

### Form screen copy

| Element | Professional | Warm | Utilitarian | Editorial |
|---|---|---|---|---|
| Submit button | Save inspection | Save inspection | Save | Save |
| Cancel (dirty) title | Discard changes? | Discard your changes? | Discard? | Discard changes? |
| Cancel (dirty) body | Your unsaved changes will be lost. | You have unsaved work that will be lost. | Unsaved changes will be lost. | Changes you have made will be lost. |
| Success | Inspection saved | Inspection saved | Saved | Saved |
| Validation error | This field is required | Please fill in this field | Required | Required |

### Empty / Onboarding screen copy

| Element | Professional | Warm | Utilitarian | Editorial |
|---|---|---|---|---|
| Headline | Welcome to [App] | Welcome to [App] | [App] | [App] |
| Body | Get started by creating your first item. | Let's set up your workspace. | — | A place for your work. |
| Primary CTA | Get started | Let's go | Start | Begin |

---

## Micro-interactions

Apply these to every screen. They are the difference between an app that feels cheap and one that feels polished.

> **Note:** `expo-haptics` is BANNED — it crashes at runtime in the current rewrap binary. Use visual-only feedback (`pressStyle={{ scale: 0.98 }}` for press, green pill / banner / snackbar for success, inline error text for error, Switch's visible state change for toggle). See `agents/screen-builder.md` HARD RULE for details.

---

### Skeleton shimmer (initial data load)

Every data-driven screen must show a skeleton while loading — never a spinner, never blank. Use the `ShimmerBox` component from [universal-patterns.md](universal-patterns.md) Section 3.

**List screen skeleton:**
```tsx
function ListSkeleton() {
  return (
    <YStack gap="$3" p="$4">
      {[...Array(6)].map((_, i) => (
        <XStack key={i} ai="center" gap="$3">
          <ShimmerBox width={40} height={40} borderRadius={20} />
          <YStack gap="$2" f={1}>
            <ShimmerBox width="70%" height={14} />
            <ShimmerBox width="40%" height={12} />
          </YStack>
        </XStack>
      ))}
    </YStack>
  )
}
```

**Detail screen skeleton:**
```tsx
function DetailSkeleton() {
  return (
    <YStack gap="$4" p="$4">
      <ShimmerBox width="100%" height={200} borderRadius={12} />
      <ShimmerBox width="60%" height={24} />
      <ShimmerBox width="40%" height={16} />
      <YStack gap="$2" mt="$2">
        {[...Array(4)].map((_, i) => (
          <ShimmerBox key={i} width={`${90 - i * 10}%`} height={14} />
        ))}
      </YStack>
    </YStack>
  )
}
```

**Rule:** skeleton layout must match the real content layout — same row heights, same spacing, same avatar size. Mismatched skeletons cause a jarring layout shift on load.

---

### Press / active states

Every tappable element needs a visible press state. Use Tamagui's `pressStyle` — never rely on the OS default highlight alone.

| Element | pressStyle |
|---|---|
| Card / list row | `pressStyle={{ scale: 0.98, opacity: 0.85 }}` |
| Primary button | `pressStyle={{ scale: 0.96, opacity: 0.9 }}` (Tamagui Button has this built in) |
| Icon button (chromeless) | `pressStyle={{ opacity: 0.5 }}` |
| Tab bar item | Handled by Expo Router — do not override |
| Large FAB | `pressStyle={{ scale: 0.94 }}` |

```tsx
// Card with press feedback
<Pressable onPress={onPress}>
  {({ pressed }) => (
    <Animated.View style={{ transform: [{ scale: pressed ? 0.98 : 1 }], opacity: pressed ? 0.85 : 1 }}>
      <YStack bg="$color2" br="$4" p="$4" gap="$2" borderWidth={1} borderColor="$borderColor">
        {/* card content */}
      </YStack>
    </Animated.View>
  )}
</Pressable>
```

---

### State transition animations

When data loads or a UI state changes, never snap between states — always animate.

| Transition | Animation |
|---|---|
| Skeleton → data | `FadeIn.duration(200)` on the data container |
| Empty → first item added | `FadeInDown.duration(300)` on the new item |
| Error → retry loading | Fade out error, fade in skeleton, then data |
| Tab content switch | Handled by Expo Router — don't animate content area |
| Sheet open | `withSpring` (built into Tamagui Sheet) |
| Alert dialog appear | `FadeIn` on overlay + `ZoomIn.duration(200)` on content |
| Toast / snackbar | `SlideInDown` from bottom, `SlideOutDown` after 3s |

```tsx
// Skeleton → data swap
{isLoading ? (
  <ListSkeleton />
) : (
  <Animated.View entering={FadeIn.duration(200)}>
    <FlatList data={items} ... />
  </Animated.View>
)}
```

---

### Swipe-to-act

For any list that supports quick actions (delete, archive, complete), use swipe-to-act from [universal-patterns.md](universal-patterns.md) Section 28. Rules for when to add it:

- Add swipe-to-delete only if the delete action appears in the detail screen too
- Always pair with an undo toast (3-second window)
- Left swipe = destructive (red), right swipe = non-destructive (green/blue)
- Do NOT add swipe-to-act on read-only lists

### Search screen copy

| Element | Professional | Warm | Utilitarian | Editorial |
|---|---|---|---|---|
| Placeholder | Search inspections | Search your inspections | Search | Search entries |
| No results headline | No results for "[query]" | We couldn't find anything for "[query]" | No matches | Nothing found |
| No results body | Try a different search term. | Try different keywords. | — | Try different words. |
