# Tamagui Integration

Internal reference used by `/create-mobile-app` Step 9b after `/design-system` writes `brand/tokens.ts`. This is not a user-invocable skill.

`/design-system` and this reference deliberately complement each other: `/design-system` captures the user's brand/design intent and writes artifacts; this reference translates those artifacts into Tamagui config/provider wiring. A default app still runs this reference in alias-only mode so generated screens have the same `$surface*` and `$accent*` token contract as a branded app.

## Goal

Keep generated screens on one stable token contract:

- Always provide `$surface0`-`$surface3` and `$accentBase` / `$accentSoft` / `$accentDeep` / `$accentOnBase`.
- Import `brand/tokens.ts` when it exists; it is the source of truth from `/design-system`.
- Do not add outer `TamaguiProvider`, `PortalProvider`, `ToastProvider`, `GestureHandlerRootView`, or `QueryClientProvider`; current `PowerAppsProvider` composes them internally.

## Mode Selection

| Condition | Action |
|---|---|
| `brand/tokens.ts` exists | Import brand tokens into `tamagui.config.ts`, then add aliases. |
| `## Design` says `tamagui-design-system: required` but no brand tokens exist | Create brand/custom tokens from the approved `## Design`, then add aliases. |
| `## Design` says `tamagui-design-system: add-aliases` or no custom design tokens exist | Add aliases over `defaultConfig` only. |

Run `npx tsc --noEmit` after changing Tamagui config or root provider wiring.

## Alias Layer

Extend `defaultConfig.tokens.color`; do not replace `defaultConfig`.

```ts
import { defaultConfig } from '@tamagui/config/v4';
import { createTamagui, createTokens } from 'tamagui';

const aliasTokens = createTokens({
  ...defaultConfig.tokens,
  color: {
    ...defaultConfig.tokens.color,
    surface0: '#ffffff',
    surface0_dark: '#111113',
    surface1: '#f7f7f8',
    surface1_dark: '#1c1c1f',
    surface2: '#efeff1',
    surface2_dark: '#28282c',
    surface3: '#e3e3e7',
    surface3_dark: '#333338',
    accentDeep: '#005a9e',
    accentBase: '#0078d4',
    accentSoft: '#cce4f7',
    accentOnBase: '#ffffff',
  },
});

export const tamaguiConfig = createTamagui({
  ...defaultConfig,
  tokens: aliasTokens,
});

export default tamaguiConfig;
export type Conf = typeof tamaguiConfig;

declare module 'tamagui' {
  interface TamaguiCustomConfig extends Conf {}
}
```

## Brand Import

When `brand/tokens.ts` exists, merge its token objects without re-keying them:

```ts
import { tokens as brandTokens } from './brand/tokens';

const tokens = createTokens({
  ...defaultConfig.tokens,
  color: { ...defaultConfig.tokens.color, ...brandTokens.color, /* aliases here */ },
  space: { ...defaultConfig.tokens.space, ...brandTokens.space },
  size: { ...defaultConfig.tokens.size, ...brandTokens.size },
  radius: { ...defaultConfig.tokens.radius, ...brandTokens.radius },
});
```

Hard rule: never remap brand space keys (`xs`, `sm`, `md`, `lg`, `xl`, `2xl`, `3xl`, `4xl`) onto Tamagui numeric keys (`1`, `2`, `3`, `4`, `0.25`, etc.). Screen-builder and Tamagui components rely on the default numeric scale. If a comment says `Map brand space names to Tamagui numeric token keys`, delete that override block.

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