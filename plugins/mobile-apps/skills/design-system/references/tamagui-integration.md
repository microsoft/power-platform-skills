# Tamagui Integration

Internal reference used by `/create-mobile-app` Step 9b after `/design-system` writes `brand/tokens.ts`. This is not a user-invocable skill.

`/design-system` and this reference deliberately complement each other: `/design-system` captures the user's brand/design intent and writes artifacts; this reference translates those artifacts into Tamagui config/provider wiring. A default app still runs this reference in alias-only mode so generated screens have the same `$surface*` and `$accent*` token contract as a branded app.

## Goal

Keep generated screens on one stable token contract:

- Always provide `$surface0`-`$surface3` and `$accentBase` / `$accentSoft` / `$accentDeep` / `$accentOnAccent`.
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
    accentSoft: brand.accent ?? theme.blue3,
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
import { createTokens } from '@tamagui/core';
import { animations } from '@tamagui/config/v5-rn';
import { tokens as brandTokens } from './brand/tokens';

const tokens = createTokens({
  ...defaultConfig.tokens,
  space: { ...defaultConfig.tokens.space, ...brandTokens.space },
  size: { ...defaultConfig.tokens.size, ...brandTokens.size },
  radius: { ...defaultConfig.tokens.radius, ...brandTokens.radius },
});

const darkBrandColors = {
  primary: brandTokens.color.primary,
  accent: brandTokens.color.accent,
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

The generated typography object is not automatically consumed by
`createTokens` above. Shared branded primitives must explicitly map its
family/size/weight/tracking roles, or the integration must report typography
as not yet applied. Never report the design system fully integrated when only
colors, spacing, sizes, and radii are wired.

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