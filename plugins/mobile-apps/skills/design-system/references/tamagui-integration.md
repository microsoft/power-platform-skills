# Tamagui Integration

Internal reference used by `/create-mobile-app` Step 9b after `/design-system`
writes `brand/tokens.ts`. This is not a user-invocable skill.

The native host owns the baseline Tamagui contract. Generated applications
must extend that contract rather than copying its semantic aliases, color
parsing, contrast selection, animations, or font fallback into each app.

## Goal

- Keep `$surface0`-`$surface3`, `$mediaSurface`, `$accent*`, `$text*`, status
  foreground/background pairs, and `fonts.mono` available in every app.
- Use `createPowerAppsTamaguiConfig` as the only Tamagui config factory.
- Use `withPowerAppsSemanticAliases` when applying `brand/tokens.ts`.
- Export the resolved light and dark app themes so `PowerAppsProvider` and
  Tamagui consume the same semantic values.
- Do not add an outer `TamaguiProvider`, `PortalProvider`, app-owned `Toaster`,
  `GestureHandlerRootView`, or `QueryClientProvider`.

## Mode Selection

| Condition | Action |
|---|---|
| `brand/tokens.ts` exists | Apply the brand-import implementation below. |
| `## Design` requires custom tokens but `brand/tokens.ts` is missing | Materialize the approved tokens first, then use brand-import mode. |
| No custom design tokens exist | Verify the template calls `createPowerAppsTamaguiConfig({})`; make no config edit. |

The alias-only path is now a verification step. The host factory already
provides the complete semantic alias and font contract.

## Base Template

The current template starts with:

```ts
import { createPowerAppsTamaguiConfig } from '@microsoft/power-apps-native-host/config/tamaguiConfig';

// CUSTOMIZATION START - DO NOT REMOVE OR RENAME THE COMMENT
// Add or replace Tamagui configuration values here.
const customConfig = {};
// CUSTOMIZATION END - DO NOT REMOVE OR RENAME THE COMMENT

export const tamaguiConfig = createPowerAppsTamaguiConfig(customConfig);
export default tamaguiConfig;

export type Conf = typeof tamaguiConfig;
declare module 'tamagui' {
  interface TamaguiCustomConfig extends Conf {}
}
```

Keep `createPowerAppsTamaguiConfig`, the exports, and the `declare module
'tamagui'` block. Replace only the customization region and add the required
imports.

## Brand Import

When `brand/tokens.ts` exists, update `tamagui.config.ts` to this shape:

```ts
import { createTokens } from '@tamagui/core';
import { defaultConfig } from '@tamagui/config/v5';
import {
  createPowerAppsTamaguiConfig,
  withPowerAppsSemanticAliases,
} from '@microsoft/power-apps-native-host/config/tamaguiConfig';

// CUSTOMIZATION START - DO NOT REMOVE OR RENAME THE COMMENT
import { tokens as brandTokens } from './brand/tokens';

const tokens = createTokens({
  ...defaultConfig.tokens,
  space: { ...defaultConfig.tokens.space, ...brandTokens.space },
  size: { ...defaultConfig.tokens.size, ...brandTokens.size },
  radius: { ...defaultConfig.tokens.radius, ...brandTokens.radius },
});

export const appLightTheme = withPowerAppsSemanticAliases(
  defaultConfig.themes.light,
  brandTokens.color,
);

export const appDarkTheme = withPowerAppsSemanticAliases(
  defaultConfig.themes.dark,
  {
    primary: brandTokens.color.primary,
    accent: brandTokens.color.accent,
    statusSuccess: brandTokens.color.statusSuccess,
    statusWarning: brandTokens.color.statusWarning,
    statusDanger: brandTokens.color.statusDanger,
    statusInfo: brandTokens.color.statusInfo,
  },
);

const customConfig = {
  tokens,
  themes: {
    ...defaultConfig.themes,
    light: appLightTheme,
    dark: appDarkTheme,
  },
};
// CUSTOMIZATION END - DO NOT REMOVE OR RENAME THE COMMENT

export const tamaguiConfig = createPowerAppsTamaguiConfig(customConfig);
export default tamaguiConfig;

export type Conf = typeof tamaguiConfig;
declare module 'tamagui' {
  interface TamaguiCustomConfig extends Conf {}
}
```

The generated schema has one palette. Light mode receives its approved
surfaces, text, accents, and statuses. Dark mode keeps Config v5 dark surfaces
and text while carrying the approved accent and status colors.

Never copy `parseColorChannels`, `readableForeground`, or
`withSemanticAliases` into the app. The host helper owns those rules.

Never remap brand space keys (`xs`, `sm`, `md`, `lg`, `xl`, `2xl`, `3xl`,
`4xl`) onto Tamagui numeric keys. Preserve the default numeric scale.

## Root Provider Wiring

Tamagui components read the themes above through `useTheme()`. Shared host
components and navigation read `ThemeTokens` through `useThemeTokens()`.
Build the provider themes from the exported app themes so both channels use
the same semantic colors:

```tsx
import {
  PowerAppsProvider,
  lightTheme as hostLightTheme,
  darkTheme as hostDarkTheme,
} from '@microsoft/power-apps-native-host';
import type { ThemeTokens } from '@microsoft/power-apps-native-host';

import tamaguiConfig, {
  appDarkTheme,
  appLightTheme,
} from '../tamagui.config';

const brandedLightTheme: ThemeTokens = {
  ...hostLightTheme,
  surface0: appLightTheme.surface0,
  surface1: appLightTheme.surface1,
  surface2: appLightTheme.surface2,
  surface3: appLightTheme.surface3,
  surface4: appLightTheme.color6,
  text0: appLightTheme.text0,
  text1: appLightTheme.text1,
  text2: appLightTheme.text2,
  text3: appLightTheme.text3,
  accentDeep: appLightTheme.accentDeep,
  accentBase: appLightTheme.accentBase,
  accentSoft: appLightTheme.accentSoft,
  accentOnAccent: appLightTheme.accentOnAccent,
};

const brandedDarkTheme: ThemeTokens = {
  ...hostDarkTheme,
  surface0: appDarkTheme.surface0,
  surface1: appDarkTheme.surface1,
  surface2: appDarkTheme.surface2,
  surface3: appDarkTheme.surface3,
  surface4: appDarkTheme.color6,
  text0: appDarkTheme.text0,
  text1: appDarkTheme.text1,
  text2: appDarkTheme.text2,
  text3: appDarkTheme.text3,
  accentDeep: appDarkTheme.accentDeep,
  accentBase: appDarkTheme.accentBase,
  accentSoft: appDarkTheme.accentSoft,
  accentOnAccent: appDarkTheme.accentOnAccent,
};

<PowerAppsProvider
  tamaguiConfig={tamaguiConfig}
  defaultTheme={colorScheme === 'dark' ? 'dark' : 'light'}
  theme={brandedLightTheme}
  darkTheme={brandedDarkTheme}
>
  <Slot />
</PowerAppsProvider>
```

Preserve the existing auth, app config, schema map, offline profile, telemetry,
and custom provider props when applying this change.

`SafeAreaProvider` owns context only. Do not wrap `<Slot />` in a root
`SafeAreaView`; rendered routes own their visible safe-area edges.

## Validation

After Tamagui or provider changes:

```bash
npx tsc --noEmit
```

Also verify that `tamagui.config.ts` contains no local color parser or semantic
alias implementation and that both provider themes map every
surface/text/accent value from `appLightTheme` / `appDarkTheme`.
