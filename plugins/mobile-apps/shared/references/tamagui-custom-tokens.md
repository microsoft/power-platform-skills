# Tamagui Custom Tokens

How to customize tokens and themes without breaking Tamagui's defaults.

These examples target Tamagui 2 with Config v5 and the standalone template's customization markers. Keep custom imports and the `customConfig` value between the marker lines so template upgrades preserve them.

## Rule #1 — Extend, don't replace

Pass only the overrides to the native-host factory. It preserves the complete
Config v5 baseline:

```ts
import {
  createPowerAppsTamaguiConfig,
  withPowerAppsSemanticAliases,
} from '@microsoft/power-apps-native-host/config/tamaguiConfig'
import { defaultConfig } from '@tamagui/config/v5'

// CUSTOMIZATION START - DO NOT REMOVE OR RENAME
const customConfig = {
  tokens: { ...defaultConfig.tokens, /* non-color overrides */ },
  themes: {
    ...defaultConfig.themes,
    light: {
      ...withPowerAppsSemanticAliases(defaultConfig.themes.light),
      /* light overrides */
    },
    dark: {
      ...withPowerAppsSemanticAliases(defaultConfig.themes.dark),
      /* dark overrides */
    },
  },
}
// CUSTOMIZATION END - DO NOT REMOVE OR RENAME

export const tamaguiConfig = createPowerAppsTamaguiConfig(customConfig)
```

Replacing the whole config means you lose all the built-in themes (light, dark, red, blue, etc.) and have to rebuild them. Don't.

## Adding brand colors

Config v5 color values live in themes. Define each custom name in both root themes so `$brand500` follows the active light/dark theme.

```ts
import {
  createPowerAppsTamaguiConfig,
  withPowerAppsSemanticAliases,
} from '@microsoft/power-apps-native-host/config/tamaguiConfig'
import { defaultConfig } from '@tamagui/config/v5'

// CUSTOMIZATION START - DO NOT REMOVE OR RENAME
const lightBrandColors = {
  brand50:  '#FFF4E6',
  brand100: '#FFD9B3',
  brand500: '#FF5A00',  // primary
  brand700: '#CC4600',
  brand900: '#7A2A00',
}

const darkBrandColors = {
  brand50:  '#2A1408',
  brand100: '#4A230B',
  brand500: '#FF7A1A',
  brand700: '#FF9A4A',
  brand900: '#FFD9B3',
}

const themes = {
  ...defaultConfig.themes,
  light: {
    ...withPowerAppsSemanticAliases(defaultConfig.themes.light),
    ...lightBrandColors,
  },
  dark: {
    ...withPowerAppsSemanticAliases(defaultConfig.themes.dark),
    ...darkBrandColors,
  },
}

const customConfig = {
  themes,
}
// CUSTOMIZATION END - DO NOT REMOVE OR RENAME

export const tamaguiConfig = createPowerAppsTamaguiConfig(customConfig)
```

Use it as `<Button bg="$brand500" />`.

## Adding a brand theme

A "theme" in Tamagui is a set of colors keyed to semantic slots. To add a brand theme that works in light and dark:

```ts
const customConfig = {
  themes: {
    ...defaultConfig.themes,
    light: withPowerAppsSemanticAliases(defaultConfig.themes.light),
    dark: withPowerAppsSemanticAliases(defaultConfig.themes.dark),

    // Light brand
    light_brand: {
      ...withPowerAppsSemanticAliases(defaultConfig.themes.light),
      background: lightBrandColors.brand500,
      color: '#fff',
      borderColor: lightBrandColors.brand700,
    },

    // Dark brand
    dark_brand: {
      ...withPowerAppsSemanticAliases(defaultConfig.themes.dark),
      background: darkBrandColors.brand700,
      color: '#fff',
      borderColor: darkBrandColors.brand900,
    },
  },
}
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
    px: 1,
    0: 0,
    1: 4,
    2: 8,
    3: 12,
    4: 16,
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
import { createFont } from '@tamagui/core'

const headingFont = createFont({
  family: 'Inter-Bold',
  size: { 4: 16, 5: 20, 6: 28, 7: 34 },
  lineHeight: { 4: 24, 5: 28, 6: 36, 7: 42 },
  weight: { 4: '600' },
  letterSpacing: { 4: 0 },
})

const customConfig = {
  fonts: {
    ...defaultConfig.fonts,
    heading: headingFont,
    mono: defaultConfig.fonts.body,
  },
}
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
  card: 12,
  pill: 999,
}
```

## Status semantic tokens

Named status colors used by `StatusPill` and `StatTile`. Define mode-specific values, then merge them into the root themes:

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

const darkStatusColors = {
  statusOverdueBg:    '#3B1210',
  statusCompleteBg:   '#12351F',
  statusInProgressBg: '#102A43',
  statusPendingBg:    '#3A2A0A',
  statusDraftBg:      '#28282C',
  statusCancelledBg:  '#28282C',
  statusOverdue:      '#FF8A84',
  statusComplete:     '#75D69C',
  statusInProgress:   '#8EC8FF',
  statusPending:      '#F5C46B',
  statusDraft:        '#B4B4BC',
  statusCancelled:    '#B4B4BC',
}

const themes = {
  ...defaultConfig.themes,
  light: {
    ...withPowerAppsSemanticAliases(defaultConfig.themes.light),
    ...statusColors,
  },
  dark: {
    ...withPowerAppsSemanticAliases(defaultConfig.themes.dark),
    ...darkStatusColors,
  },
}
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

## Config version

The standalone template uses Tamagui 2 with `@tamagui/config/v5`. Keep
`createPowerAppsTamaguiConfig` imported from the native host, keep
`createTokens` and `createFont` on `@tamagui/core`, preserve the template's
`declare module 'tamagui'` augmentation, and keep customization code between
the marker lines. Use `createTokens` for non-color token groups; put color
values in `light` and `dark` themes.
