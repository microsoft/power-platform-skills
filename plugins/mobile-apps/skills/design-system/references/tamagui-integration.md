# Tamagui Integration

Internal reference used by `/create-mobile-app` Step 9b after `/design-system` writes `brand/tokens.ts`. This is not a user-invocable skill.

`/design-system` and this reference deliberately complement each other: `/design-system` captures the user's brand/design intent and writes artifacts; this reference translates those artifacts into Tamagui config/provider wiring. A default app still runs this reference in alias-only mode so generated screens have the same `$surface*` and `$accent*` token contract as a branded app.

## Goal

Keep generated screens on one stable token contract:

- Always provide `$surface0`-`$surface3`, `$mediaSurface`, and `$accentBase` / `$accentSoft` / `$accentDeep` / `$accentOnAccent`.
- Always provide runtime `$heading`, `$body`, and `$mono` roles matching the design recipe.
- Import `brand/tokens.ts` when it exists; it is the source of truth from `/design-system`.
- Do not add an outer `TamaguiProvider`, `PortalProvider`, app-owned `Toaster`, `GestureHandlerRootView`, or `QueryClientProvider`; current `PowerAppsProvider` owns the provider and portal infrastructure. In Tamagui 2, `Toaster` is a sibling component rather than a provider wrapper.

## Mode Selection

| Condition | Action |
|---|---|
| `brand/tokens.ts` exists | Import brand tokens into `tamagui.config.ts`, then add aliases. |
| `## Design` says `tamagui-design-system: required` but no brand tokens exist | Create brand/custom tokens from the approved `## Design`, then add aliases. |
| `## Design` says `tamagui-design-system: add-aliases` or no custom design tokens exist | Add aliases over `defaultConfig` only. |

Run `npx tsc --noEmit` after changing Tamagui config or root provider wiring.

## Alias Layer

Extend the Config v5 `light` and `dark` themes; do not replace `defaultConfig`.

This integration targets Tamagui 2 with Config v5, matching the current standalone template. Tamagui components generated from this config must use v2 APIs (`transition`, ARIA props, web-standard input props, and `boxShadow`).

The template owns the file shell and marks the safe edit region with:

```ts
// CUSTOMIZATION START - DO NOT REMOVE OR RENAME
// CUSTOMIZATION END - DO NOT REMOVE OR RENAME
```

Keep all added imports, token construction, and the `customConfig` replacement between those markers. Do not remove or rename either marker. Preserve the template's existing `createTamagui` and `defaultConfig` imports, exports, and `declare module '@tamagui/core'` block outside them.

```ts
import { createTamagui } from '@tamagui/core';
import { defaultConfig } from '@tamagui/config/v5';

// CUSTOMIZATION START - DO NOT REMOVE OR RENAME
import { animations } from '@tamagui/config/v5-rn';

type BrandColors = Partial<{
  bg: string;
  surface: string;
  primary: string;
  accent: string;
  accentSoft: string;
  mediaSurface: string;
  border: string;
  statusSuccess: string;
  statusWarning: string;
  statusDanger: string;
  statusInfo: string;
}>;

function withSemanticAliases(
  theme: typeof defaultConfig.themes.light,
  brand: BrandColors = {},
) {
  return {
    ...theme,
    surface0: brand.bg ?? theme.background,
    surface1: brand.surface ?? theme.color2,
    surface2: theme.color3,
    surface3: brand.border ?? theme.color4,
    accentDeep: brand.primary ?? theme.blue8,
    accentBase: brand.primary ?? theme.blue10,
    // Soft media/surface treatment must come from the deliberately light tint,
    // never from the saturated accent used for small emphasis.
    accentSoft: brand.accentSoft ?? theme.blue3,
    mediaSurface: brand.mediaSurface ?? theme.color3,
    accentOnAccent: theme.color1,
    statusComplete: brand.statusSuccess ?? theme.green10,
    statusCompleteBg: theme.green3,
    statusPending: brand.statusWarning ?? theme.yellow10,
    statusPendingBg: theme.yellow3,
    statusOverdue: brand.statusDanger ?? theme.red10,
    statusOverdueBg: theme.red3,
    statusInProgress: brand.statusInfo ?? theme.blue10,
    statusInProgressBg: theme.blue3,
  };
}

const themes = {
  ...defaultConfig.themes,
  light: withSemanticAliases(defaultConfig.themes.light),
  dark: withSemanticAliases(defaultConfig.themes.dark),
};

const customConfig = {
  ...defaultConfig,
  animations,
  themes,
};
// CUSTOMIZATION END - DO NOT REMOVE OR RENAME

export const tamaguiConfig = createTamagui(customConfig);
export default tamaguiConfig;
export type Conf = typeof tamaguiConfig;

declare module '@tamagui/core' {
  interface TamaguiCustomConfig extends Conf {}
}
```

## Brand Import

When `brand/tokens.ts` exists, reuse `withSemanticAliases`, map its colors into the root themes, and merge only its non-color token groups. Keep added imports inside the customization markers:

```ts
// CUSTOMIZATION START - DO NOT REMOVE OR RENAME
import { createFont, createTokens } from '@tamagui/core';
import { animations } from '@tamagui/config/v5-rn';
import { Platform } from 'react-native';
import { tokens as brandTokens } from './brand/tokens';

const platformSerifFamily = Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia' }) ?? 'serif';
const systemSansFamily = Platform.select({ ios: 'System', android: 'sans-serif', default: 'system-ui' }) ?? 'system-ui';
const systemMonoFamily = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) ?? 'monospace';

function runtimeFamily(family: string) {
  if (family === 'platform-serif') return platformSerifFamily;
  if (family === 'system-sans') return systemSansFamily;
  if (family === 'system-monospace') return systemMonoFamily;
  if (family.startsWith('bundled:')) return family.slice('bundled:'.length);
  throw new Error(`Unsupported design typography family: ${family}`);
}

const roleSizes = {
  1: brandTokens.typography.caption.size,
  2: brandTokens.typography.bodySm.size,
  3: brandTokens.typography.bodySm.size,
  4: brandTokens.typography.body.size,
  5: brandTokens.typography.title.size,
  6: brandTokens.typography.heading.size,
  7: brandTokens.typography.display.size,
};
const roleLineHeights = {
  1: Math.round(brandTokens.typography.caption.size * brandTokens.typography.caption.lineHeight),
  2: Math.round(brandTokens.typography.bodySm.size * brandTokens.typography.bodySm.lineHeight),
  3: Math.round(brandTokens.typography.bodySm.size * brandTokens.typography.bodySm.lineHeight),
  4: Math.round(brandTokens.typography.body.size * brandTokens.typography.body.lineHeight),
  5: Math.round(brandTokens.typography.title.size * brandTokens.typography.title.lineHeight),
  6: Math.round(brandTokens.typography.heading.size * brandTokens.typography.heading.lineHeight),
  7: Math.round(brandTokens.typography.display.size * brandTokens.typography.display.lineHeight),
};
const roleWeights = { 4: '400', 5: '500', 6: '600', 7: '700' } as const;
const headingFont = createFont({ family: runtimeFamily(brandTokens.typography.headingFamily), size: roleSizes, lineHeight: roleLineHeights, weight: roleWeights });
const bodyFont = createFont({ family: runtimeFamily(brandTokens.typography.bodyFamily), size: roleSizes, lineHeight: roleLineHeights, weight: roleWeights });
const monoFont = createFont({ family: runtimeFamily(brandTokens.typography.monoFamily), size: roleSizes, lineHeight: roleLineHeights, weight: roleWeights });

const tokens = createTokens({
  ...defaultConfig.tokens,
  space: { ...defaultConfig.tokens.space, ...brandTokens.space },
  size: { ...defaultConfig.tokens.size, ...brandTokens.size },
  radius: { ...defaultConfig.tokens.radius, ...brandTokens.radius },
});

const darkBrandColors = {
  primary: brandTokens.color.primary,
  accent: brandTokens.color.accent,
  accentSoft: brandTokens.color.accentSoft,
  mediaSurface: brandTokens.color.mediaSurface,
  statusSuccess: brandTokens.color.statusSuccess,
  statusWarning: brandTokens.color.statusWarning,
  statusDanger: brandTokens.color.statusDanger,
  statusInfo: brandTokens.color.statusInfo,
};

const themes = {
  ...defaultConfig.themes,
  light: withSemanticAliases(defaultConfig.themes.light, brandTokens.color),
  // The generated schema has one palette: carry accents/status into dark mode,
  // but retain Config v5's dark surfaces and readable status backgrounds.
  dark: withSemanticAliases(defaultConfig.themes.dark, darkBrandColors),
};

const customConfig = {
  ...defaultConfig,
  animations,
  tokens,
  themes,
  fonts: { ...defaultConfig.fonts, heading: headingFont, body: bodyFont, mono: monoFont },
};
// CUSTOMIZATION END - DO NOT REMOVE OR RENAME
```

Hard rule: never remap brand space keys (`xs`, `sm`, `md`, `lg`, `xl`, `2xl`, `3xl`, `4xl`) onto Tamagui numeric keys (`1`, `2`, `3`, `4`, `0.25`, etc.). Screen-builder and Tamagui components rely on the default numeric scale. If a comment says `Map brand space names to Tamagui numeric token keys`, delete that override block.

If `src/tokens/index.ts` exposes gradients or other app-owned semantic colors,
rewrite those values during integration to import and derive from
`brand/tokens.ts`. Do not leave the scaffold's Fluent-blue sample gradient in a
blue-and-coral, green, purple, or otherwise branded app. `brand/tokens.ts`
remains the only raw-color source; `src/tokens/index.ts` may transform those
values into gradients/shadows but must not introduce a second palette.

`platform-serif`, `system-sans`, and `system-monospace` are semantic family
names, not literal React Native families. Resolve them with `Platform.select`
as above. This gives editorial directions visible typographic character without
a network/font-install step. A `system-native` recipe is also valid, but its
recipe rationale remains mandatory. Shared headers, heroes, and section titles
consume `$heading`; controls and prose consume `$body`; data-only values may
use `$mono`. Never disable font scaling.

## Root Provider Wiring

Current templates pass design values through `PowerAppsProvider`:

```tsx
<PowerAppsProvider
  authConfig={authConfig}
  powerConfig={powerConfig}
  tamaguiConfig={tamaguiConfig}
  defaultTheme={colorScheme === 'dark' ? 'dark' : 'light'}
  theme={lightTheme}
  darkTheme={darkTheme}
>
  <Slot />
</PowerAppsProvider>
```

If `brand/tokens.ts` exists, spread brand values over `lightTheme` / `darkTheme` with nullish fallback; do not rename imported `lightTheme`/`darkTheme` into local constants with the same names.

## Common Fixes

| Symptom | Fix |
|---|---|
| `PortalDispatchContext cannot be null` | Pass config/theme props to `PowerAppsProvider`; do not add an outer `PortalProvider` unless on a verified legacy host. |
| Reanimated error | Ensure `react-native-reanimated/plugin` is last in `babel.config.js`. |
| Brand spacing blows up layouts | Remove numeric remapping of brand space keys; spread brand spaces verbatim. |
| Template upgrade creates a `tamagui.config.ts.rej` file | Move every custom import and config expression back between the customization markers; leave the v5 file shell unchanged. |
