# Screen Kit API

Finite public kit (`@/components`, 24 exports). Domain is props + tokens + image URLs. Never invent a 25th component or an industry widget.

## Public exports

`Gradient` · `StatusPill` · `StatTile` · `Hero` · `ImageHero` · `ProgressMeter` · `EntityRow` · `NumericStepper` · `Callout` · `SectionHeader` · `EntityImage` · `AvatarInitials` · `InfoRow` · `ActionRow` · `LoadingState` · `ErrorState` · `EmptyState` · `ScreenHeader` · `ModalHeader` · `BottomActionBar` · `FloatingActionButton` · `FilterChipRow` · `FormField` · `RowPick`

`Hero variant="endpoint-pair"` is a Hero prop, not a new export.

## Home stack (every Home)

```
ScreenHeader
Hero | ImageHero
optional ProgressMeter
optional Callout
StatTile × 2–4
SectionHeader + EntityRow[] (3–5)
BottomActionBar (one labeled CTA)
```

Bind domain into props. Photos use `ImageHero` / `EntityImage` with a stable URL and the built-in fallback icon.

## UX rails (every app — not a look)

These are layout/behavior rules. They do **not** pick a palette or invent a component.

- **Header + footer** — every screen names where you are and what to do next. Header is `ScreenHeader` (tab-root / list), `ModalHeader` (modal/form), or a native stack header (`headerShown: true` + title) on pushed details. `ScreenHeader` is **sticky chrome**: a sibling above `ScrollView` / `FlatList`, never inside the scroll. Footer is `BottomActionBar` with one labeled CTA. Do not ship a content-only screen. Login/onboarding may use template chrome instead. Never put a Twitter-style `+` FAB over the tab bar.
- **One focus** — one primary object and one primary CTA per screen.
- **One accent** — `$accentBase` is the only strong interactive color. Secondary actions are outlined / chromeless / `$color11`. Never mix two filled brand colors on one screen.
- **Status first** — `StatusPill` / `EntityRow variant="status"` / `Callout` in the first viewport.
- **Sticky action** — `BottomActionBar` for the main CTA; big, labeled, obvious. Tab-root: `edges={['top']}` + `<BottomActionBar safeArea={false}>` (Tabs already own the home-indicator inset). Modal/stack that covers tabs: default `safeArea` (true).
- **Hero stays secondary** — if the screen has `BottomActionBar`, do not pass a filled `action` on `Hero` / `ImageHero`. Mid-screen buttons are outlined or text. The sticky bar is the next step.
- **Do not bury work** — `ImageHero` height ≤ 220 on Home unless the photo *is* the task. Status, price, qty, and the primary CTA stay in the first viewport.
- **No FAB over tabs** — `FloatingActionButton` is banned on tab-root screens that also show `Tabs`. Put create/next in `BottomActionBar` or the header. FAB is only for a stack/list that covers the tab bar.
- **Tabs ≤ 5** — 3–5 top-level destinations. Inactive tab icons use `$color10` / `theme.text2` or stronger, never `$color8`.
- **Field-friendly** — tap targets ≥ 48pt. Prefer `NumericStepper` over a keyboard for counts, qty, sets, kg, received/damaged.
- **Stepper style B only** — circular `( − )  n  ( + )`. Number centered, buttons ≥48pt. Do not mix with a plain `− n +` chrome in the same app. The kit ships style B; do not restyle it per screen.
- **Qty / line row** — wrap each line in a soft card: `YStack` `bg="$surface1"` `rounded="$4"` `borderWidth={1}` `borderColor="$borderColor"` `overflow="hidden"`, gap between cards (not a hairline list). Inside: `EntityRow variant="media"` (thumb + name + price right; meta under the name), then a full-width row with `NumericStepper` left and destructive text right, no wrap. Warning copy sits under that row. Still the 24-kit — the wrap is a `YStack`, not a 25th component.
- **Summary footer** — `BottomActionBar` with amount/label left + pill primary (`rounded="$10"`) right. Optional secondary is a chromeless text link under the pill, not a second filled button.
- **Filters / sort** — `FilterChipRow` is a **horizontal scroller**. Chip count is whatever the domain needs (2 or 20). Do not cap at 5. Sorting is a chip or `RowPick`, not a new widget. Chip label is `$2` / 12pt — never heading size.
- **Button shapes** — one grammar per app. Primary CTA in `BottomActionBar`: pill `rounded="$10"`. Secondary: chromeless text. Chips / stepper: pill or circle. Mid-screen filled actions: `rounded="$4"`. Destructive: text + small icon, never a filled square. Never two pill primaries on one screen. Never a sharp square next to a pill.
- **Photo-led browse** — when the object is merch / food / look, use a 2-col `FlatList` of `EntityImage` + `StatusPill` overlay + name + price. Do not use `EntityRow` for that catalog. Queues / carts / work lists stay `EntityRow`.
- **Carousel / photo strip** — horizontal `ScrollView` of `ImageHero` / `EntityImage`. Not a 25th `Carousel` export.
- **Progressive disclosure** — Home stack first; details, notes, and extra fields live on the next screen or under a section, not all on Home.
- **Explicit feedback** — `LoadingState` / `ErrorState` / `EmptyState` / `Callout` for saving, sync, warning, success. Never a silent no-op.
- **Evidence** — visible Take picture + `EntityImage` thumbnails + notes `FormField` + optional location `Callout`. Gallery is secondary.

Same kit, different apps. Tokens + props change; exports do not.

| App | Bind |
|---|---|
| Pantry | `ImageHero` produce + `ProgressMeter` freshness + `StatTile` ×3 + `EntityRow variant="check\|media"` + `NumericStepper` qty + cook/shop `BottomActionBar` |
| Gym | `ImageHero` workout + `ProgressMeter variant="ring"` streak + `StatTile` ×3 + `EntityRow variant="media"` session + `NumericStepper` sets/kg + Start `BottomActionBar` |
| Aid / ICRC-style (only if they named the brand) | `ScreenHeader` + offline `Callout` + `FilterChipRow` + `EntityRow variant="status"` shipments + `NumericStepper` received/damaged + evidence `EntityImage` + warning `Callout` + Confirm `BottomActionBar`. Brand red lives in tokens, not a new component. |

## Bind, do not invent

| Need | Bind |
|---|---|
| Photo hero + one CTA | `ImageHero` |
| Text / pair hero (origin → destination) | `Hero` or `Hero variant="endpoint-pair"` |
| Ring / bar / zone steps | `ProgressMeter variant="ring\|bar\|segments"` |
| Status, photo, check, time, person, sentence rows | `EntityRow variant="status\|media\|check\|timeline\|avatar\|sentence"` |
| Qty / count | `NumericStepper` |
| Blocked / evidence / warning | `Callout` |
| KPI | `StatTile` |
| Filters / sort (any count) | `FilterChipRow` (horizontal scroll) |
| Photo carousel / strip | horizontal `ScrollView` of `ImageHero` / `EntityImage` |
| Chrome | `ScreenHeader`, `ModalHeader`, `BottomActionBar`, `FloatingActionButton` |
| Form bits | `FormField`, `RowPick` |
| States | `LoadingState`, `ErrorState`, `EmptyState` |

## Generic names → kit (do not create these files)

A “universal mobile UI” list is aliases for the 24 exports. Prefer these patterns. Never add `StatusBadge.tsx`, `Card.tsx`, `Toast.tsx`, `SearchBar.tsx`, or a Field/Logistics skill fork.

| Generic name | Bind |
|---|---|
| ScreenHeader | `ScreenHeader` |
| SectionHeader | `SectionHeader` |
| Card / ListItem / SectionedList | `EntityRow` (group with `SectionHeader` + date/status/category) |
| StickyBottomBar / StickyBottomActions | `BottomActionBar` (full-width primary) |
| StatusBadge | `StatusPill` — **color + text always**, never icon-only |
| Banner / OfflineBanner / SyncBanner / AlertBanner | `Callout` (`info` / `warning` / `danger` / `success`) |
| Toast / Snackbar | `Callout` (inline). Do not add a toast host. |
| EmptyState / LoadingState / Skeleton / Error | `EmptyState` / `LoadingState` / `ErrorState` — required on every data screen |
| Primary / Secondary button | Tamagui `Button` in `BottomActionBar` (primary full-width; secondary outlined) |
| Search + Filter bar | `Input` in `ScreenHeader` children + `FilterChipRow` |
| FilterChips / FilterBar / SegmentedControl | `FilterChipRow` (any count, horizontal scroll) |
| FormField / TextInput | `FormField` |
| Stepper / QuantityStepper | `NumericStepper` when the brief has qty/sets/kg/counts — still this kit, not a logistics-only skill |
| Avatar | `AvatarInitials` |
| ImageThumbnail / PhotoEvidence | `EntityImage` (+ Take picture when the brief needs evidence) |
| NotificationBadge | count on `FilterChipRow` / tab label — not a new export |
| LocationCapture | location `Callout` + native CTA when the brief needs it |

**Visual tokens (every app, not a brand):** one strong primary (from the brief or a named brand; red/blue only if that fits). Surfaces 12–16px if `radius: rounded`, 4–8px if `radius: sharp`. Soft fill or one hairline — not both stacked. Spacing on the 8pt Tamagui scale. Type is title → subtitle → body. Empty / loading / error are never omitted.

**Theme card** (planner writes this from the brief; not a user form):

```
tone: professional | friendly | calm | bold
primary: #hex + name
support: #hex, #hex
radius: rounded | sharp
density: comfortable | compact
feeling: one sentence
```

UX rails above are always on. This card only changes tokens.

**Not a second skill.** Pass/Partial/Fail, steppers, photo evidence, and location are the same exports with different props when the brief needs them. Do not fork “Field / Logistics”.

## Archetypes (shell only)

| Archetype | Shell |
|---|---|
| Tab-root / Home | Home stack above |
| List | `ScreenHeader` + optional `FilterChipRow` + `EntityRow[]` in a `FlatList` |
| Detail | `Hero` or `ImageHero` + `InfoRow` / `SectionHeader` + `BottomActionBar` |
| Form | `ModalHeader` or `ScreenHeader` + `FormField` / `NumericStepper` / `RowPick` + `BottomActionBar` |
| Auth / Modal / Onboarding | Template chrome + `EmptyState` / `Callout` as needed |

## Legacy catalogue keys

If an older plan still emits these keys, map them and move on. Do not reopen the old prose files.

| Old key | Bind |
|---|---|
| `status-stripe-card` | `EntityRow variant="status"` |
| `avatar-row` | `EntityRow variant="avatar"` |
| `stat-card` | `StatTile` |
| `media-tile` | `EntityRow variant="media"` |
| `sentence-row` | `EntityRow variant="sentence"` |
| `timeline-row` | `EntityRow variant="timeline"` |
| `checklist-row` | `EntityRow variant="check"` |
| `status-header-band` | `Hero` + `StatusPill` |
| `stat-grid` | `StatTile` × N |
| `image-hero` | `ImageHero` |
| `identity-block` | `Hero` + `AvatarInitials` |
| `summary-card` | `Hero` |
| `timeline-header` | `Hero` + `EntityRow variant="timeline"` |
| `minimal-header` | `ScreenHeader` |
| `home-dashboard` / `assignment-dashboard` | Home stack |
| `walkaround-stepper` / `wizard-progress-stepper` | `ProgressMeter variant="segments"` + `Callout` + `BottomActionBar` |
| `floating-action-menu` | `FloatingActionButton` + `ActionRow` in a Sheet |
| `scan-geofence-gate` | `Callout` + native capture CTA |
| `severity-filtered-queue` | `FilterChipRow` + `EntityRow variant="status"` |
| `dispatch-signoff-queue` | `EntityRow` + `BottomActionBar` + `Callout` |
| `audit-timeline` | `EntityRow variant="timeline"` |
| `numeric-stepper` / `line-item-stepper-row` | `NumericStepper` (optionally beside `EntityRow variant="media"`) |
| `checkbox-field` | `EntityRow variant="check"` |
| `searchable-lookup-sheet` | `RowPick` in a Sheet |
| `segmented-control` | `FilterChipRow` |
| `expandable-calendar-agenda` / `month-agenda` / `calendar-list-range` | `react-native-calendars` when the plan lists it |
| `timeline-day-list` | `FilterChipRow` (dates) + `EntityRow variant="timeline"` |
