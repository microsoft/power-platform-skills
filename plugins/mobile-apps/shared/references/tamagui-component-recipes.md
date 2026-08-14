# Tamagui Component Recipes

Copy-paste snippets for mobile-app screens.

> **Prefer `src/components/`, `src/hooks/`, `src/utils/`** — the scaffold creates:
> - `src/components/index.tsx` — UI primitives: `StatusPill`, `StatTile`, `Hero`, `SectionHeader`, `AvatarInitials`, `InfoRow`, `ActionRow`, `Gradient`, `LoadingState`, `ErrorState`, `EmptyState`, `BottomActionBar`, `ScreenHeader`, `ModalHeader`, `FormField`, `RowPick`
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
  style,
  children,
}: {
  name: GradientName
  style?: object
  children?: React.ReactNode
}) {
  return (
    <LinearGradient colors={gradients[name]} style={[{ borderRadius: 12 }, style]}>
      {children}
    </LinearGradient>
  )
}
```

Usage: `<Gradient name="hero" style={{ height: 180 }}><Hero ... /></Gradient>`

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

### `<Hero>`

Gradient header for list and dashboard screens. Renders inside a `<Gradient>`.

```tsx
import { YStack, XStack, Text, Button } from 'tamagui'
import { Ionicons } from '@expo/vector-icons'
import type { GradientName } from '@/tokens'

type IoniconName = React.ComponentProps<typeof Ionicons>['name']

export function Hero({
  title,
  subtitle,
  gradient = 'hero',
  action,
}: {
  title: string
  subtitle?: string
  gradient?: GradientName
  action?: { label: string; iconName?: IoniconName; onPress: () => void }
}) {
  return (
    <Gradient name={gradient} style={{ borderRadius: 0 }}>
      <YStack px="$5" pt="$6" pb="$5" gap="$1">
        <XStack items="center" justify="space-between">
          <YStack gap="$1" flex={1}>
            <Text fontSize="$7" fontWeight="700" color="white" numberOfLines={1}>
              {title}
            </Text>
            {subtitle && (
              <Text fontSize="$3" color="rgba(255,255,255,0.8)" numberOfLines={2}>
                {subtitle}
              </Text>
            )}
          </YStack>
          {action && (
            <Button
              size="$3" chromeless borderColor="rgba(255,255,255,0.4)"
              borderWidth={1} onPress={action.onPress}
              icon={action.iconName ? <Ionicons name={action.iconName} size={16} color="white" /> : undefined}
            >
              <Button.Text color="white">{action.label}</Button.Text>
            </Button>
          )}
        </XStack>
      </YStack>
    </Gradient>
  )
}
```

Usage:
```tsx
<Hero
  title="Field Inspections"
  subtitle="14 open · 3 overdue"
  gradient="hero"
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
        style={mono ? { fontFamily: 'monospace' } : undefined}
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
    onChangeText={(value: string) => setEmail(value)} />
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

Use the `$mono` token only when `customConfig.fonts.mono` is registered. The portable fallback is:

```tsx
<Text style={{ fontFamily: 'monospace' }} fontSize="$3" color="$color10">INS-2024-0047</Text>
<Text style={{ fontFamily: 'monospace' }} fontSize="$2">2024-03-15 14:32</Text>
<Text style={{ fontFamily: 'monospace' }} fontSize="$7" fontWeight="700">$1,247.50</Text>
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
