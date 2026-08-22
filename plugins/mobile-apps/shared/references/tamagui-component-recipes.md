# Tamagui Component Recipes

Copy-paste snippets for mobile-app screens.

> **Prefer `src/components/`, `src/hooks/`, `src/utils/`** — the scaffold creates:
> - `src/components/index.tsx` — UI primitives: `StatusPill`, `StatTile`, `Hero`, `SectionHeader`, `AvatarInitials`, `InfoRow`, `ActionRow`, `Gradient`, `LoadingState`, `ErrorState`, `EmptyState`, `BottomActionBar`, `ScreenHeader`, `ModalHeader`, `FormField`, `RowPick`
>   plus `FloatingActionButton`, `FilterChipRow`, and `EntityImage`
> - `src/hooks/` — `useListData`, `useSearchFilter`
> - `src/utils/` — `formatDate`, `formatDateTime`, `formatRelative`, `truncate`, `pluralize`, `choiceLabel`, `STATUS_TONES`, `lookupName`, `formattedValue`, `newId`
> - `src/tokens/` — `gradients`, `shadows`
>
> Import via path aliases: `@/components`, `@/hooks`, `@/utils`, `@/tokens`. Recipes below are the reference implementations.

---

## Primitives (import from `@/components`)

These are defined once in the scaffold and imported by every screen. Never re-roll them inline.

### `<Gradient>`

Thin wrapper over `expo-linear-gradient` that accepts a named gradient key:

```tsx
import { LinearGradient } from 'expo-linear-gradient'
import { gradients, type GradientName } from '@/tokens'

export function Gradient({
  name,
  source,
  style,
  children,
}: {
  name: GradientName
  source: 'content' | 'state' | 'magnitude' | 'legibility'
  style?: object
  children?: React.ReactNode
}) {
  return (
    <LinearGradient
      colors={gradients[name]}
      testID={`gradient:${name}:${source}`}
      style={[{ borderRadius: 12 }, style]}
    >
      {children}
    </LinearGradient>
  )
}

Usage for an image scrim only:
`<Gradient name="imageScrim" source="legibility"><EntityImage testID="hero" ... /></Gradient>`.
State/magnitude gradients additionally bind `data-gradient-bound` to the source
field or wrap a `chart:*` / `progress:*` component.

---

### `<StatusPill>`

Desaturated tinted pill. Use for all status display — never hardcode colors.

```tsx
import { XStack, Text } from 'tamagui'

type StatusVariant = 'overdue' | 'complete' | 'in-progress' | 'pending' | 'draft' | 'cancelled'

const STATUS_STYLES: Record<StatusVariant, { bg: string; text: string; label: string }> = {
  overdue:     { bg: '$statusOverdueBg',    text: '$statusOverdue',    label: 'Overdue' },
  complete:    { bg: '$statusCompleteBg',   text: '$statusComplete',   label: 'Complete' },
  'in-progress': { bg: '$statusInProgressBg', text: '$statusInProgress', label: 'In Progress' },
  pending:     { bg: '$statusPendingBg',    text: '$statusPending',    label: 'Pending' },
  draft:       { bg: '$statusDraftBg',      text: '$statusDraft',      label: 'Draft' },
  cancelled:   { bg: '$statusCancelledBg',  text: '$statusCancelled',  label: 'Cancelled' },
}

export function StatusPill({
  status,
  label,
}: {
  status: StatusVariant
  label?: string
}) {
  const s = STATUS_STYLES[status]
  return (
    <XStack
      bg={s.bg} px="$2" py="$1" rounded="$10" items="center"
      aria-label={`Status: ${label ?? s.label}`}
    >
      <Text fontSize="$1" fontWeight="600" color={s.text}>{label ?? s.label}</Text>
    </XStack>
  )
}
```

Usage: `<StatusPill status="overdue" />` or `<StatusPill status="complete" label="Submitted" />`

---

### `<StatTile>`

Metric card for dashboard summary rows. Pair two side-by-side in an `XStack`.

```tsx
import { YStack, XStack, Text, useTheme } from 'tamagui'
import { Ionicons } from '@expo/vector-icons'
import { shadows } from '@/tokens'

type IoniconName = React.ComponentProps<typeof Ionicons>['name']

export function StatTile({
  label,
  value,
  trend,
  trendUp,
  iconName,
}: {
  label: string
  value: string | number
  trend?: string
  trendUp?: boolean
  iconName?: IoniconName
}) {
  const theme = useTheme()

  return (
    <YStack
      bg="$color2" rounded="$4" p="$4" gap="$1" flex={1}
      {...shadows.sm}
      aria-label={`${label}: ${value}${trend ? ', trend ' + trend : ''}`}
    >
      <XStack items="center" gap="$2">
        {iconName && <Ionicons name={iconName} size={14} color={theme.color10.val} />}
        <Text fontSize="$2" color="$color10" numberOfLines={1}>{label}</Text>
      </XStack>
      <Text fontSize="$8" fontWeight="700" color="$color12">{value}</Text>
      {trend && (
        <Text fontSize="$1" color={trendUp ? '$statusComplete' : '$statusOverdue'} fontWeight="600">
          {trend}
        </Text>
      )}
    </YStack>
  )
}
```

Usage:
```tsx
<XStack gap="$3">
  <StatTile label="Open" value={14} trend="+3 this week" trendUp iconName="clipboard-outline" />
  <StatTile label="Overdue" value={3} trend="-1" trendUp={false} iconName="alert-circle-outline" />
</XStack>
```

---

### `<Sparkline>`

Inline trend for a stat tile. Use approved `d3-scale` to normalize 4–12
ordered numeric observations; the shared component renders View geometry, no
axes, an emphasized endpoint, and a text equivalent.

```tsx
import { scaleLinear } from 'd3-scale'

const scale = scaleLinear()
  .domain([Math.min(...values), Math.max(...values)])
  .range([0, 1])

<Sparkline
  points={values.map((value, index) => ({
    key: String(index), label: labels[index], value, normalized: scale(value),
  }))}
  summary="Completions rose 18% over 7 days"
  seriesColor={chartTokens.seriesPrimary}
/>
```

No axes or auto-animation. If the trend does not change a decision, show the
number without a sparkline.

---

### `<SeriesChart>`

One-series bar/area comparison with at most 12 points, `labelSmall` axes, chart
tokens, a visible caption, accessible root summary, and range-named empty state.

```tsx
import { scaleLinear } from 'd3-scale'

const scale = scaleLinear().domain([0, Math.max(...values)]).range([0, 1])

<SeriesChart
  form="bar"
  points={values.map((value, index) => ({
    key: labels[index], label: labels[index], value, normalized: scale(value),
  }))}
  summary="42 inspections completed in the last 6 months"
  emptyRange="the last 6 months"
  seriesColor={chartTokens.seriesPrimary}
  gridColor={chartTokens.grid}
/>
```

Area form uses only `gradient:chartArea:magnitude`. More than one series is out
of v1 scope; do not hand-roll legends or additional colors.

---

### `<Hero>`

Flat brand header for list and dashboard screens. Generic headers have no
derived gradient source, so they use a solid semantic accent surface.

```tsx
import { YStack, XStack, Text, Button } from 'tamagui'
import { Ionicons } from '@expo/vector-icons'
type IoniconName = React.ComponentProps<typeof Ionicons>['name']

export function Hero({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle?: string
  action?: { label: string; iconName?: IoniconName; onPress: () => void }
}) {
  return (
    <YStack bg="$accentBase" px="$5" pt="$6" pb="$5" gap="$1">
        <XStack items="center" justify="space-between">
          <YStack gap="$1" flex={1}>
            <Text fontSize="$7" fontWeight="700" color="$accentOnAccent" numberOfLines={1}>
              {title}
            </Text>
            {subtitle && (
              <Text fontSize="$3" color="$accentOnAccent" numberOfLines={2}>
                {subtitle}
              </Text>
            )}
          </YStack>
          {action && (
            <Button
              size="$3" chromeless borderColor="$accentOnAccent"
              borderWidth={1} onPress={action.onPress}
              icon={action.iconName ? <Ionicons name={action.iconName} size={16} color="currentColor" /> : undefined}
            >
              <Button.Text color="$accentOnAccent">{action.label}</Button.Text>
            </Button>
          )}
        </XStack>
    </YStack>
  )
}
```

Usage:
```tsx
<Hero
  title="Field Inspections"
  subtitle="14 open · 3 overdue"
  action={{ label: 'New', iconName: 'add', onPress: () => router.push('/inspections/new') }}
/>
```

---

### `<SectionHeader>`

Consistent section headers with optional "View all" action. Replaces every inline `<XStack items="center" justify="space-between">` pattern.

```tsx
import { XStack, Text, Button } from 'tamagui'

export function SectionHeader({
  title,
  action,
}: {
  title: string
  action?: { label: string; onPress: () => void }
}) {
  return (
    <XStack items="center" justify="space-between" mb="$2">
      <Text fontSize="$5" fontWeight="600" color="$color11">{title}</Text>
      {action && (
        <Button size="$2" chromeless onPress={action.onPress}>
          <Text fontSize="$3" color="$blue10">{action.label}</Text>
        </Button>
      )}
    </XStack>
  )
}
```

---

### `<AvatarInitials>`

Initials avatar with optional status dot. No image loading needed.

```tsx
import { YStack, ZStack, Text } from 'tamagui'

export function AvatarInitials({
  name,
  size = 'md',
  statusDot,
}: {
  name: string
  size?: 'sm' | 'md' | 'lg'
  statusDot?: 'online' | 'away' | 'offline'
}) {
  const dim = { sm: 28, md: 36, lg: 48 }[size]
  const fontSize = { sm: '$1', md: '$2', lg: '$4' }[size]
  const initials = name.split(' ').map(word => word[0]).slice(0, 2).join('').toUpperCase()
  const dotColor = { online: '$statusComplete', away: '$statusPending', offline: '$statusDraft' }

  return (
    <ZStack width={dim} height={dim}>
      <YStack
        width={dim} height={dim} rounded={dim / 2}
        bg="$blue3" items="center" justify="center"
        aria-label={name}
      >
        <Text fontSize={fontSize} fontWeight="600" color="$blue10">{initials}</Text>
      </YStack>
      {statusDot && (
        <YStack
          position="absolute" b={0} r={0}
          width={10} height={10} rounded={5}
          bg={dotColor[statusDot]}
          borderWidth={2} borderColor="$background"
        />
      )}
    </ZStack>
  )
}
```

---

### `<InfoRow>`

Label/value pair for detail screens. Consistent alignment and spacing across all detail views.

```tsx
import { XStack, Text } from 'tamagui'

export function InfoRow({
  label,
  value,
  mono,
}: {
  label: string
  value: string | number
  mono?: boolean
}) {
  return (
    <XStack justify="space-between" py="$2" items="center">
      <Text color="$color10" fontSize="$4" flex={1}>{label}</Text>
      <Text
        fontSize="$4" fontWeight="500"
        fontFamily={mono ? '$mono' : undefined}
        color="$color12" text="right" flex={1}
        numberOfLines={1}
      >
        {String(value)}
      </Text>
    </XStack>
  )
}
```

Usage: `<InfoRow label="Reference" value="INS-2024-047" mono />`

---

### `<ActionRow>`

Settings/navigation list row. Consistent tap target, chevron, and press state.

```tsx
import { XStack, Text, YStack, useTheme } from 'tamagui'
import { Ionicons } from '@expo/vector-icons'

type IoniconName = React.ComponentProps<typeof Ionicons>['name']

export function ActionRow({
  iconName,
  label,
  subtitle,
  onPress,
  destructive,
}: {
  iconName?: IoniconName
  label: string
  subtitle?: string
  onPress: () => void
  destructive?: boolean
}) {
  const theme = useTheme()

  return (
    <XStack
      items="center" gap="$3" py="$3" px="$4" minH={48}
      pressStyle={{ bg: '$color3' }}
      onPress={onPress}
      role="button"
      aria-label={label}
    >
      {iconName && (
        <Ionicons
          name={iconName}
          size={18}
          color={destructive ? theme.statusOverdue.val : theme.color10.val}
        />
      )}
      <YStack flex={1} gap="$0.5">
        <Text fontSize="$4" color={destructive ? '$statusOverdue' : '$color12'}>{label}</Text>
        {subtitle && <Text fontSize="$2" color="$color10">{subtitle}</Text>}
      </YStack>
      <Ionicons name="chevron-forward" size={16} color={theme.color10.val} />
    </XStack>
  )
}
```

---

### `<LoadingState>`

Skeleton state that mirrors list, detail, or form geometry. Use it while the
first data request is pending; never replace a populated list with a spinner.

```tsx
<LoadingState variant="list" rows={6} />
<LoadingState variant="detail" rows={5} />
<LoadingState variant="form" rows={4} />
```

Choose `rows` from the expected first viewport, not the total result count.

---

### `<ErrorState>`

Full-screen recoverable failure with a visible retry. Pass user-facing copy;
log raw connector/service errors separately.

```tsx
<ErrorState
  title="Inspections unavailable"
  message="We couldn't load this queue."
  onRetry={refetch}
/>
```

---

### `<EmptyState>`

Domain-named empty result with an optional useful action. Filter-empty states
name the active filter and use a clear/reset action.

```tsx
<EmptyState
  icon="clipboard-outline"
  title="No inspections scheduled"
  message="This site has no visits in the selected range."
  actionLabel="Clear date range"
  onAction={clearRange}
/>
```

---

### `<BottomActionBar>`

Safe-area-aware pinned action surface. Scroll content bottom padding must equal
this rendered height plus the safe-area inset. Selection mode replaces the
normal bar; never stack two bottom bars.

```tsx
<BottomActionBar>
  <Button testID="cta-primary" onPress={save}>Save inspection</Button>
</BottomActionBar>
```

---

### `<FloatingActionButton>`

One obvious create/quick action above native bottom chrome. Prefer `extended`
with a visible label; icon-only still requires the `label` accessibility name.

```tsx
<FloatingActionButton
  label="New inspection"
  iconName="add"
  extended
  onPress={openCreate}
/>
```

Do not use a FAB when a pinned bottom primary action already owns the screen.

---

### `<BatchActionBar>`

Selection-mode replacement for the normal pinned CTA. The screen owns selected
IDs and confirmation; the component owns count, Select all, Exit, safe area,
and 1–3 versus 4+ action layout.

```tsx
{selectionMode ? (
  <BatchActionBar
    selectedCount={selectedIds.size}
    actions={[
      { key: 'approve', label: 'Approve', onPress: approveSelected },
      { key: 'reject', label: 'Reject', destructive: true, onPress: confirmRejectSelected },
    ]}
    onSelectAll={selectAllVisible}
    onExit={exitSelection}
  />
) : (
  <BottomActionBar>{normalPrimaryAction}</BottomActionBar>
)}
```

Enter via row long-press or a visible Select header action. Never render a
permanent checkbox column, and never mount this bar beside the normal bar.

---

### `<FilterChipRow>`

Single-select horizontal filter row for 1–4 values. For 5–8 values add the
planned More overflow; above 8 use a searchable filter sheet instead.

```tsx
<FilterChipRow
  options={[
    { key: 'all', label: 'All', count: 12 },
    { key: 'critical', label: 'Critical', count: 3 },
  ]}
  selectedKey={filter}
  onChange={setFilter}
/>
```

---

### `<CarouselRow>`

Browsable visual collection with snap-to-start, trailing bleed, announced
position, and caller-owned offset persistence. Use only for 3+ hero-eligible
images on a non-queue screen.

```tsx
const [carouselOffset, setCarouselOffset] = React.useState(0)

<CarouselRow
  entity="cr_product"
  items={products}
  keyExtractor={(product) => product.cr_productid}
  itemWidth={280}
  initialOffset={carouselOffset}
  onOffsetChange={setCarouselOffset}
  renderItem={(product) => (
    <YStack>
      <EntityImage source={product.cr_imageurl} width={280} height={180} />
      <Text>{product.cr_name}</Text>
    </YStack>
  )}
/>
```

Never auto-advance. One or two items use a static row. Working queues use their
normal scan-efficient list even when records have images.

---

### `<ScreenHeader>`

Compact in-content header for a non-modal screen. Title, status, metadata, and
the optional right action remain one hierarchy; do not wrap this in a card.

```tsx
<ScreenHeader
  title="North Dock Inspection"
  subtitle="Loading Gate A"
  status={<StatusPill status="in-progress" />}
  rightAction={<Button chromeless onPress={openMore}>More</Button>}
/>
```

---

### `<ModalHeader>`

Balanced Cancel/title/Save row for modal or form-sheet workflows. Keep Save
disabled while submitting and preserve entered values after failure.

```tsx
<ModalHeader
  title="New request"
  onCancel={confirmCancel}
  onSave={submit}
  saving={isSubmitting}
/>
```

---

### `<FormField>`

Consistent visible label wrapper for one input/control. The child owns helper
and validation copy; never use placeholder text as the only field label.

```tsx
<FormField label="Received quantity">
  <Input value={quantity} keyboardType="number-pad" onChangeText={setQuantity} />
</FormField>
```

Use the planner's field-role control instead of defaulting every value to
`Input`.

---

### `<RowPick>`

Single-select row used inside lookup/choice sheets. Store the record ID, not a
display label or Dataverse bind string.

```tsx
<RowPick
  label={site.cr_name}
  subtitle={site.cr_address}
  selected={site.cr_siteid === selectedSiteId}
  onPress={() => setSelectedSiteId(site.cr_siteid)}
/>
```

---

### `<EntityImage>`

Safe display boundary for Dataverse base64/data URIs and remote URLs. Always
pass fixed numeric dimensions or an explicit aspect-ratio container, plus a
meaningful accessible description on the surrounding image control.

```tsx
<YStack aspectRatio={4 / 3} width="100%">
  <EntityImage
    source={product.cr_imageurl}
    width={320}
    height={240}
    borderRadius={12}
    fallbackIcon="image-outline"
  />
</YStack>
```

Use the shipped local placeholder for failure/offline; never replace a missing
domain image with another remote stock URL.

---

### `<SortControl>`

Visible sort state for a List. Keys use `<logical-field>:<asc|desc>`; labels are
domain copy. Two or three options render inline; four or more use the sheet
trigger and the screen owns the single-select `RowPick` sheet.

```tsx
const sorts = [
  { key: 'cr_createdat:desc', label: 'Newest', orderBy: 'cr_createdat desc' },
  { key: 'cr_validfrom:asc', label: 'Valid from', orderBy: 'cr_validfrom asc' },
]

<SortControl
  options={sorts}
  selectedKey={sortKey}
  onChange={(key) => {
    setSortKey(key)
    listRef.current?.scrollToOffset({ offset: 0, animated: false })
  }}
/>
```

The results container uses `testID="sort-results"` and
`dataSet={{ sortReset: 'top' }}`. Never hide the active sort behind an unlabeled
icon.

---

## Screen shell

```tsx
import { YStack } from 'tamagui'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

export default function Screen() {
  const insets = useSafeAreaInsets()
  return (
    <YStack flex={1} bg="$background" pt={insets.top} p="$4" gap="$4">
      {/* content */}
    </YStack>
  )
}
```

## Card (with shadow + press)

Cards separate from background via **fill difference**, not borders. Use `bg="$color2"` on a `$background` screen — the contrast is enough. Only add `borderWidth` if the card is on `$color2` (same as itself).

```tsx
<YStack bg="$color2" rounded="$4" p="$4" gap="$2" {...shadows.md}
  pressStyle={{ scale: 0.98 }} onPress={onPress}
  role="button" aria-label={`Open ${title}`}>
  <H5>{title}</H5>
  <Paragraph color="$color10" numberOfLines={2}>{description}</Paragraph>
</YStack>
```

**Do NOT** add `borderWidth={1} borderColor="$borderColor"` to every card. If every surface has a border, the screen looks like a wireframe. Reserve borders for list item separators only.

## Shadow levels

```tsx
const shadows = {
  sm: { boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)' },
  md: { boxShadow: '0 2px 8px rgba(0, 0, 0, 0.08)' },
  lg: { boxShadow: '0 4px 16px rgba(0, 0, 0, 0.12)' },
} as const
```

- `sm` — subtle card lift, input focus
- `md` — standard cards, headers
- `lg` — FABs, modals, sheets

## Buttons

```tsx
// Primary
<Button bg="$blue10" size="$4" onPress={onSave}>
  <Button.Text color="$color1">Save inspection</Button.Text>
</Button>

// Destructive (inside AlertDialog only)
<Button theme="red" onPress={onDelete}>Delete</Button>

// FAB
<Button circular size="$5" bg="$blue10" icon={<Ionicons name="add" size={22} color="white" />} {...shadows.lg}
  position="absolute" b="$6" r="$4" aria-label="Add new" />
```

## Input with label

```tsx
<YStack gap="$2">
  <Label htmlFor="email" fontSize="$3" color="$color10">Email</Label>
  <Input id="email" size="$4" bg="$color3" borderWidth={0}
    focusStyle={{ borderWidth: 2, borderColor: '$blue8' }}
    value={email}
    onChange={event => setEmail(event.target?.value ?? event.nativeEvent?.text ?? '')} />
  {error && <Text color="$red10" fontSize="$2">{error}</Text>}
</YStack>
```

## Choice / picklist select

Use for Dataverse choice columns. Options come from the generated const in `src/generated/models/<Entity>Model.ts` — keys are int values as strings, values are label strings (e.g. `{ '100000000': 'Active', '100000001': 'OnHold' }`).

`react-hook-form` + `Controller` pattern (preferred):

```tsx
import { Cr123_Projectstatus } from '../generated/models/Cr123_ProjectModel';

// Inside <Controller render={({ field }) => ( ... )} />:
<YStack gap="$2">
  <Label fontSize="$3" color="$color10">Status</Label>
  <Select
    value={String(field.value ?? '')}
    onValueChange={v => field.onChange(Number(v))}
  >
    <Select.Trigger size="$4" bg="$color3" borderWidth={0}
      focusStyle={{ borderWidth: 2, borderColor: '$blue8' }}>
      <Select.Value placeholder="Select status" />
    </Select.Trigger>
    <Select.Content>
      <Select.ScrollUpButton />
      <Select.Viewport>
        {Object.entries(Cr123_Projectstatus).map(([val, label], i) => (
          <Select.Item key={val} value={val} index={i}>
            <Select.ItemText>{label}</Select.ItemText>
          </Select.Item>
        ))}
      </Select.Viewport>
      <Select.ScrollDownButton />
    </Select.Content>
  </Select>
  {field.invalid && <Text color="$red10" fontSize="$2">{field.error?.message}</Text>}
</YStack>
```

**Key rules:**
- `value` and `onValueChange` use strings — Tamagui `Select` requires string values. Convert: `String(field.value)` in, `Number(v)` out.
- Import the const from `src/generated/models/` — never hardcode option values.
- On submit, the int reaches Dataverse directly: `cr123_status: formData.status` (already a number after `Number(v)`).
- For display on list/detail screens, use the `formattedValue(record, '<columnLogicalName>')` helper from `@/utils` (which reads the OData formatted-value annotation under the hood). If annotations are unavailable, fall back to the generated option const: `Cr123_Projectstatus[String(record.cr123_status)] ?? String(record.cr123_status ?? '')`. NEVER invent/read a separate `*name` shadow property and NEVER inline the raw annotation key.

## Empty state

```tsx
const theme = useTheme()

<YStack flex={1} items="center" justify="center" p="$6" gap="$3">
  <Ionicons name="mail-open-outline" size={48} color={theme.color10.val} />
  <H4>No inspections yet</H4>
  <Paragraph text="center" color="$color10">Create your first inspection to get started.</Paragraph>
  <Button bg="$blue10" onPress={onAdd}>
    <Button.Text color="$color1">New inspection</Button.Text>
  </Button>
</YStack>
```

Icons by content: `Inbox` lists, `FileX` documents, `SearchX` search, `Users` people.

## Loading skeleton

Match populated layout shape — not generic rectangles:

```tsx
<YStack gap="$3" p="$4">
  {Array.from({ length: 5 }).map((_, i) => (
    <YStack key={i} bg="$color2" rounded="$4" p="$4" gap="$2">
      <YStack height={16} width="60%" bg="$color4" rounded="$2" />
      <YStack height={12} width="90%" bg="$color4" rounded="$2" />
    </YStack>
  ))}
</YStack>
```

## Error state

```tsx
const theme = useTheme()

<YStack flex={1} items="center" justify="center" p="$6" gap="$3">
  <Ionicons name="alert-circle" size={40} color={theme.red10.val} />
  <H4>Something went wrong</H4>
  <Paragraph text="center" color="$color10">{error.message}</Paragraph>
  <Button onPress={onRetry}>Try again</Button>
</YStack>
```

## Status badge

Uses tinted background + text-weight color (not fully saturated fill + white text). This makes badges sit politely in the layout instead of screaming.

```tsx
function StatusBadge({ label, type }: { label: string; type: 'success' | 'warning' | 'error' | 'info' | 'neutral' }) {
  const colors = {
    success: { bg: '$green3', text: '$green10' },
    warning: { bg: '$yellow3', text: '$yellow10' },
    error:   { bg: '$red3',   text: '$red10' },
    info:    { bg: '$blue3',  text: '$blue10' },
    neutral: { bg: '$color3', text: '$color10' },
  }
  const c = colors[type]
  return (
    <XStack bg={c.bg} px="$2" py="$1" rounded="$10" items="center">
      <Text fontSize="$1" fontWeight="600" color={c.text}>{label}</Text>
    </XStack>
  )
}
```

**Never** use `bg="$green9" color="white"` for status pills — fully saturated pills on white text look alarming and break the 60/30/10 rule. Exception: field/ops apps where status must pop in bright outdoor light.

Alternative — dot prefix: `<YStack width={6} height={6} rounded={3} bg="$green10" />` before text. Even quieter than pills.

## Inline composites

```tsx
const theme = useTheme()

// Section header with action
<XStack items="center" justify="space-between" mb="$2">
  <Text fontSize="$5" fontWeight="600" color="$color11">{title}</Text>
  <Button size="$2" chromeless onPress={onAction}><Text fontSize="$3" color="$blue10">{action}</Text></Button>
</XStack>

// Stat card
<YStack bg="$color2" rounded="$4" p="$3" gap="$1" width="47%" {...shadows.sm}>
  <Text fontSize="$2" color="$color10">{label}</Text>
  <Text fontSize="$8" fontWeight="700">{value}</Text>
</YStack>

// Info row (detail screens)
<XStack justify="space-between" py="$2">
  <Text color="$color10" fontSize="$4">{label}</Text>
  <Text fontSize="$4" fontWeight="500">{value}</Text>
</XStack>

// Action row with chevron
<XStack items="center" gap="$3" py="$3" px="$4" pressStyle={{ bg: '$color3' }}
  onPress={onPress} role="button">
  {icon}
  <Text flex={1} fontSize="$4">{label}</Text>
  <Ionicons name="chevron-forward" size={16} color={theme.color10.val} />
</XStack>
```

## Monospace data values

```tsx
<Text fontFamily="$mono" fontSize="$3" color="$color10">INS-2024-0047</Text>  // ID
<Text fontFamily="$mono" fontSize="$2">2024-03-15 14:32</Text>              // timestamp
<Text fontFamily="$mono" fontSize="$7" fontWeight="700">$1,247.50</Text>    // currency
```

## Bottom sheet

```tsx
<Sheet modal open={open} onOpenChange={setOpen} snapPointsMode="fit" dismissOnSnapToBottom>
  <Sheet.Overlay /><Sheet.Handle />
  <Sheet.Frame p="$4" gap="$3">{/* content */}</Sheet.Frame>
</Sheet>
```

## Confirm dialog (destructive)

```tsx
<AlertDialog>
  <AlertDialog.Trigger asChild><Button theme="red">Delete</Button></AlertDialog.Trigger>
  <AlertDialog.Portal><AlertDialog.Overlay />
    <AlertDialog.Content><YStack gap="$3">
      <AlertDialog.Title>Delete inspection?</AlertDialog.Title>
      <AlertDialog.Description>This can't be undone.</AlertDialog.Description>
      <XStack gap="$3" justify="flex-end">
        <AlertDialog.Cancel asChild><Button>Cancel</Button></AlertDialog.Cancel>
        <AlertDialog.Action asChild><Button theme="red" onPress={onDelete}>Delete</Button></AlertDialog.Action>
      </XStack>
    </YStack></AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog>
```

## Keyboard wrapper (forms)

```tsx
<KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
  <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
    {/* form fields */}
  </ScrollView>
</KeyboardAvoidingView>
```

---

## Typography setup (dual-font pairing)

When the plan's `## Design` specifies a font pairing, add this to `tamagui.config.ts`. Full pairing catalog → [typography-and-tone.md](typography-and-tone.md).

This matches the standalone template's Tamagui 2 + Config v5 customization region.

```tsx
// tamagui.config.ts
import { createFont } from '@tamagui/core'
import { animations } from '@tamagui/config/v5-rn'

// Example: Editorial pairing (Lora + Inter)
const headingFont = createFont({
  family: 'Lora',
  size:          { 4: 16, 5: 20, 6: 24, 7: 28, 8: 34, 9: 42 },
  lineHeight:    { 4: 22, 5: 26, 6: 30, 7: 34, 8: 40, 9: 48 },
  weight:        { 4: '400', 6: '600', 7: '700' },
  letterSpacing: { 4: 0, 5: 0, 6: -0.3, 7: -0.5, 8: -0.7, 9: -1.0 },
})

const bodyFont = createFont({
  family: 'Inter',
  size:          { 1: 11, 2: 12, 3: 13, 4: 16, 5: 18 },
  lineHeight:    { 1: 16, 2: 18, 3: 20, 4: 24, 5: 28 },
  weight:        { 4: '400', 5: '500', 6: '600', 7: '700' },
  letterSpacing: { 1: 0.4, 2: 0.2, 3: 0, 4: 0 },
})

const customConfig = {
  ...defaultConfig,
  animations,
  fonts: { ...defaultConfig.fonts, heading: headingFont, body: bodyFont },
}
```

Usage: `<H3 fontFamily="$heading">Title</H3>` for headings, `<Text fontFamily="$body">Label</Text>` for UI chrome.

## Content prose block (detail screens)

For reading-oriented screens (detail body, help, onboarding). Generous spacing + max-width for comfortable reading.

```tsx
<YStack gap="$8" maxW={520} px="$5">
  <YStack gap="$2">
    <Text fontFamily="$body" fontSize="$2" letterSpacing={0.8} textTransform="uppercase" color="$color10">
      Tuesday, 14 May
    </Text>
    <H3 fontFamily="$heading" letterSpacing={-0.5}>{title}</H3>
  </YStack>

  <Paragraph fontFamily="$heading" fontSize="$5" lineHeight={28} color="$color12">
    {bodyText}
  </Paragraph>

  <Separator />

  <Text fontFamily="$body" fontSize="$2" color="$color10" letterSpacing={0.4} textTransform="uppercase">
    {wordCount} words · {readTime} minutes
  </Text>
</YStack>
```

Key patterns: `gap="$8"` between major sections, serif for prose, sans for metadata, tracked uppercase for labels.

## Section break (editorial spacing)

For content-heavy screens, use generous gaps between major sections. This is the single biggest quality lever.

```tsx
// Between major content sections — generous gap
<YStack gap="$8">
  <YStack gap="$2">{/* Section 1: header + content */}</YStack>
  <YStack gap="$2">{/* Section 2: header + content */}</YStack>
  <YStack gap="$2">{/* Section 3: header + content */}</YStack>
</YStack>

// With separator between concept changes
<YStack gap="$8">
  <YStack gap="$2">{/* Section 1 */}</YStack>
  <Separator />
  <YStack gap="$2">{/* Section 2 (different concept) */}</YStack>
</YStack>
```

Compare: `gap="$4"` (16px) feels cramped. `gap="$8"` (32px) feels designed. Use `$8` to `$10` between sections, `$2` to `$3` within sections.

## Named palette tokens

When the plan specifies a custom palette, override Tamagui's default tokens. Full methodology → [color-palette-architecture.md](color-palette-architecture.md).

```tsx
// Inside the tamagui.config.ts customization markers — warm ochre brand
const customConfig = {
  ...defaultConfig,
  animations,
  themes: {
    ...defaultConfig.themes,
    light: {
      ...defaultConfig.themes.light,
      background: '#F7F3EC',       // default page background
      surface0: '#F7F3EC',         // semantic page background
      surface1: '#FBF8F2',         // lightly elevated
      surface2: '#EFE8DA',         // card fill
      surface3: '#E4DCC9',         // hairlines
      color4: '#C9BEA3',           // surface4 — muted borders
      color12: '#1C1B17',          // text0 — primary ink
      color11: '#3A372F',          // text1 — secondary
      color10: '#6B6557',          // text2 — tertiary
      color9: '#948C7A',           // text3 — faintest
      blue10: '#A8763E',           // repurpose as brand accent
    },
    dark: {
      ...defaultConfig.themes.dark,
      background: '#0E0D0B',       // default page background
      surface0: '#0E0D0B',         // semantic page background
      surface1: '#14130F',         // lightly elevated
      surface2: '#1E1C18',         // card fill
      surface3: '#2D2A22',         // borders
      color4: '#3A372F',           // surface4 dark
      color12: '#F2EAD8',          // text0 dark (cream, not white)
      color11: '#D4CCB8',          // text1 dark
      color10: '#948C7A',          // text2 dark
      color9: '#6B6557',           // text3 dark
      blue10: '#C8965E',           // accent brightens in dark mode
    },
  },
}
