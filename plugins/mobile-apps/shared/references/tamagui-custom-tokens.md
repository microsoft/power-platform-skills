# Tamagui Custom Tokens

How to customize tokens and themes without breaking Tamagui's defaults.

## Rule #1 — Extend, don't replace

Always spread `defaultConfig` first:

```ts
import { defaultConfig } from '@tamagui/config/v4'

export const tamaguiConfig = createTamagui({
  ...defaultConfig,
  tokens: { ...defaultConfig.tokens, /* overrides */ },
  themes: { ...defaultConfig.themes, /* overrides */ },
})
```

Replacing the whole config means you lose all the built-in themes (light, dark, red, blue, etc.) and have to rebuild them. Don't.

## Adding brand colors

```ts
import { defaultConfig } from '@tamagui/config/v4'
import { createTamagui, createTokens } from 'tamagui'

const brandColors = {
  brand50:  '#FFF4E6',
  brand100: '#FFD9B3',
  brand500: '#FF5A00',  // primary
  brand700: '#CC4600',
  brand900: '#7A2A00',
}

const tokens = createTokens({
  ...defaultConfig.tokens,
  color: {
    ...defaultConfig.tokens.color,
    ...brandColors,
  },
})

export const tamaguiConfig = createTamagui({
  ...defaultConfig,
  tokens,
})
```

Use it as `<Button bg="$brand500" />`.

## Adding a brand theme

A "theme" in Tamagui is a set of colors keyed to semantic slots. To add a brand theme that works in light and dark:

```ts
export const tamaguiConfig = createTamagui({
  ...defaultConfig,
  themes: {
    ...defaultConfig.themes,

    // Light brand
    brand_light: {
      background: '$brand500',
      color: '#fff',
      borderColor: '$brand700',
    },

    // Dark brand
    brand_dark: {
      background: '$brand700',
      color: '#fff',
      borderColor: '$brand900',
    },
  },
})
```

Wrap UI:
```tsx
<Theme name="brand">
  <Button>Primary action</Button>
</Theme>
```

## Customizing space / size

```ts
const tokens = createTokens({
  ...defaultConfig.tokens,
  space: {
    ...defaultConfig.tokens.space,
    // e.g. tighten mobile defaults
    $px: 1,
    $0: 0,
    $1: 4,
    $2: 8,
    $3: 12,
    $4: 16,
    // etc. — keep the $1–$10 scale intact
  },
})
```

**HARD RULE — do not re-key brand spacing onto Tamagui's integer slots.** The integer keys (`1`, `2`, `3`, `4`, …, plus `0.25`, `0.5`, `0.75`, `1.5`) ARE the default Tamagui `$1`–`$10` scale (~4/8/12/16/20… px). Built-in `Button`, `Input`, `XStack` defaults reference `$4` internally, and every screen built by `screen-builder` uses `px="$4"`, `gap="$4"`, `mx="$4"`. Overwriting `$4` with a brand value like 64 px doesn't break the type-checker — it silently inflates padding everywhere, wraps banner text character-by-character, and squishes list rows.

**Allowed:** spread `brandTokens.space` (which is keyed `xs/sm/md/lg/xl/2xl/...`) — those names don't collide with the integer scale, so the spread is a no-op for the defaults and only adds new tokens.

**Allowed:** add NEW named tokens (`$card`, `$gutter`).

**Banned:**
```ts
// ❌ NEVER — every one of these breaks default component padding
space: {
  ...defaultConfig.tokens.space,
  1:    brandTokens.space.lg,
  2:    brandTokens.space['2xl'],
  3:    brandTokens.space['3xl'],
  4:    brandTokens.space['4xl'],
  0.25: brandTokens.space.xs,
  0.5:  brandTokens.space.sm,
}
```
If a screen needs a brand-named gap, import it as a raw number from `brand/tokens.ts` (`brandTokens.space.lg`) — do not give it an integer alias.

The same rule applies to `size` and `radius` integer keys.

## Fonts

```ts
import { createFont } from 'tamagui'

const headingFont = createFont({
  family: 'Inter-Bold',
  size: { 4: 16, 5: 20, 6: 28, 7: 34 },
  lineHeight: { 4: 24, 5: 28, 6: 36, 7: 42 },
  weight: { 4: '600' },
  letterSpacing: { 4: 0 },
})

export const tamaguiConfig = createTamagui({
  ...defaultConfig,
  fonts: {
    ...defaultConfig.fonts,
    heading: headingFont,
  },
})
```

Load via `expo-font` in root layout:

```tsx
import { useFonts } from 'expo-font'
const [loaded] = useFonts({ 'Inter-Bold': require('./assets/Inter-Bold.ttf') })
if (!loaded) return null
```

## Radius

```ts
radius: {
  ...defaultConfig.tokens.radius,
  $card: 12,
  $pill: 999,
}
```

## Status semantic tokens

Named status colors used by `StatusPill` and `StatTile`. Add alongside brand colors:

```ts
const statusColors = {
  // Backgrounds (tinted, for pill/badge fill)
  statusOverdueBg:    '#FDECEA',
  statusCompleteBg:   '#E6F4EA',
  statusInProgressBg: '#E8F0FE',
  statusPendingBg:    '#FEF7E0',
  statusDraftBg:      '#F1F3F4',
  statusCancelledBg:  '#F1F3F4',
  // Foregrounds (saturated, for text/icon)
  statusOverdue:      '#C5221F',
  statusComplete:     '#137333',
  statusInProgress:   '#1A73E8',
  statusPending:      '#B06000',
  statusDraft:        '#5F6368',
  statusCancelled:    '#5F6368',
}

const tokens = createTokens({
  ...defaultConfig.tokens,
  color: {
    ...defaultConfig.tokens.color,
    ...brandColors,
    ...statusColors,
  },
})
```

Reference these in `StatusPill` via `$statusOverdue`, `$statusCompleteBg`, etc. Do NOT hardcode hex in screen files.

## Gradient tokens

Gradient arrays for use with the `<Gradient>` primitive (requires `expo-linear-gradient`):

```ts
export const gradients = {
  hero:    ['#0078d4', '#0a4f8f'] as const,   // brand hero headers
  danger:  ['#d23a3a', '#b81e1e'] as const,   // destructive / overdue heroes
  success: ['#107c10', '#054b05'] as const,   // completion heroes
  warm:    ['#ca5010', '#8a3500'] as const,   // warning / ops accent
  neutral: ['#323130', '#201f1e'] as const,   // dark neutral headers
} as const

export type GradientName = keyof typeof gradients
```

Store in `src/tokens/index.ts` (import via `@/tokens`) — used by both `<Gradient>` and `<Hero>`.

## When to stop

You probably need at most: 4–6 brand color tokens, named status tokens (above), maybe 1 custom font, maybe 2 custom radii. Don't rebuild the entire scale — Tamagui's defaults are tuned. Every deviation is a maintenance cost.

## Migration note

Tamagui v4 config uses `@tamagui/config/v4`. Older tutorials may import `/v3` — use v4 for new projects.
