# Tamagui Integration

Internal reference used by `/create-mobile-app` Step 9b, `/edit-app`, and
standalone design application after `/design-system` writes `brand/tokens.ts`.
This is not a user-invocable skill. Read only when applying or checking integration.

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
import { defaultConfig } from '@tamagui/config/v5';
import {
  createPowerAppsTamaguiConfig,
  withPowerAppsSemanticAliases,
} from '@microsoft/power-apps-native-host/config/tamaguiConfig';

// CUSTOMIZATION START - DO NOT REMOVE OR RENAME THE COMMENT
import { tokens as brandTokens } from './brand/tokens';

const tokens = {
  ...defaultConfig.tokens,
  space: { ...defaultConfig.tokens.space, ...brandTokens.space },
  size: { ...defaultConfig.tokens.size, ...brandTokens.size },
  radius: { ...defaultConfig.tokens.radius, ...brandTokens.radius },
};

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

Pass raw token values to `createPowerAppsTamaguiConfig`; the host factory owns
normalization. Do not wrap these groups in `createTokens()` first: its normalized
variables do not satisfy the host's raw-token type contract. Preserve the installed
numeric scale and add named brand tokens as shown, without casts or a second factory.

The ordinary generated schema has one palette. Light mode receives its approved
surfaces, text, accents, and statuses. Dark mode keeps Config v5 dark surfaces
and text while carrying the approved accent and status colors.

For an explicitly designed dark palette, preserve the project's existing import
shape (including `brand/tokens.dark.ts` if consumed) and pass its approved color
roles through `withPowerAppsSemanticAliases(defaultConfig.themes.dark, ...)`.
Do not spread the full light palette into dark. Additional existing token keys
or named themes must not disappear on refresh; merge them into the existing
customization rather than replacing the whole config with this example.

Never copy `parseColorChannels`, `readableForeground`, or
`withSemanticAliases` into the app. The host helper owns those rules.

Never remap brand space keys (`xs`, `sm`, `md`, `lg`, `xl`, `2xl`, `3xl`,
`4xl`) onto Tamagui numeric keys. Preserve the default numeric scale.

## Typography binding

The palette example above does not apply `brandTokens.typography`. Read the
approved role-to-font/size bindings and current font loading. A role is a complete
native tuple: **family, size, weight, line-height, tracking**. Plain Tamagui `Text`
with only `fontFamily` and `fontSize` does not reliably acquire the role's intended
weight. A heading can therefore look like regular body text even though the
configured font size is correct.

Aim for excellent native design; preserving the accepted preview's hierarchy and
layout is the minimum handoff quality, not an optional aspiration. Compare actual
native text roles, wrapping, associated icons, and alignment across repeated
items with the accepted composition. Dropped typography, missing icons, or uneven
repeated layouts are implementation regressions to repair—not acceptable
variation in generation quality. Adapt for native metrics and accessibility
without silently weakening the approved hierarchy.

Copy these focused samples into the app when absent; merge rather than overwrite
an existing customized implementation:

- [`src/tokens/native-typography.ts`](../../../shared/samples/src/tokens/native-typography.ts)
  — `createNativeTypography`, `assertNativeFontDefaults`, and their role/props types.
- [`src/components/TypographyText.tsx`](../../../shared/samples/src/components/TypographyText.tsx)
  — a small `Text` wrapper that applies all five fields and preserves normal text
  props, wrapping, accessibility, and font scaling.

From the generated app directory, the initial copy is:

```bash
mkdir -p src/tokens src/components
test -e src/tokens/native-typography.ts || \
  cp "${PLUGIN_ROOT}/shared/samples/src/tokens/native-typography.ts" src/tokens/native-typography.ts
test -e src/components/TypographyText.tsx || \
  cp "${PLUGIN_ROOT}/shared/samples/src/components/TypographyText.tsx" src/components/TypographyText.tsx
```

The existence guards preserve concurrent/customized implementations; they do not
prove an older copy satisfies the current contract. Review and merge an existing
helper before using it. Exported APIs are `createNativeTypography(baseFonts,
bindings, options?)`, `assertNativeFontDefaults(config)`, `NativeTypographyRole`,
`NativeTypographyTextProps`, and `TypographyText`.

In `tamagui.config.ts`, extend the brand-import example **before** `customConfig`:

```ts
import {
  createNativeTypography,
  assertNativeFontDefaults,
} from './src/tokens/native-typography';

// Reuse this baseline if already obtained elsewhere in the config.
// Read host-owned fonts, including mono; do not recreate the host fallback.
const hostConfig = createPowerAppsTamaguiConfig({});
export const nativeTypography = createNativeTypography(
  { ...hostConfig.fonts }, // Also merge any existing custom fonts here.
  {
    // Illustrative bindings only: use the actual approved roles and scale keys.
    body: { font: 'body', sizeToken: 4, role: brandTokens.typography.body },
    heading: { font: 'heading', sizeToken: 8, role: brandTokens.typography.heading },
  },
);
```

Add `fonts: nativeTypography.fonts` to `customConfig`. Preserve existing fonts,
themes, and token customizations; the host factory can replace the entire `fonts`
property when supplied, so passing only a customized body font can drop `mono`
and other fonts. After the **final** factory call, before its default export:

```ts
export const tamaguiConfig = createPowerAppsTamaguiConfig(customConfig);
assertNativeFontDefaults(tamaguiConfig);
export default tamaguiConfig;
```

Do not add a second final export or remove the `Conf`/module augmentation block.
The baseline call above is only to read host defaults; the final config, with all
overrides applied, is the one passed to `PowerAppsProvider` and validated.

Expose the resulting role props through the app's token layer, for example in
`src/tokens/typography.ts`:

```ts
import { nativeTypography } from '../../tamagui.config';
export const typography = nativeTypography.text;
```

Consume the complete tuple at actual text call sites, including shared heading,
label, metadata, and body primitives used by the journey:

```tsx
import { Text } from 'tamagui';
import { TypographyText } from '@/components/TypographyText';
import { typography } from '@/tokens/typography';

<TypographyText typography={typography.heading}>Review findings</TypographyText>
<Text {...typography.body}>Resolve the outstanding items before submitting.</Text>
```

The token-layer module must not be imported back into `tamagui.config.ts`; the
config imports only the independent `native-typography` helper. Existing shared
components can use the spread directly without introducing a wrapper. Do not
leave role-bound text on `fontSize`/family-only props, override role metrics later
in a `style` array, disable font scaling, or force a one-line heading to conceal
layout problems. Define only the roles the task needs; no font size or domain
preset is required.

### Default size and metric consistency

`createNativeTypography` merges each role into `createFont`, converts ratio
line-height and em tracking to native logical units, and returns explicit text
props. It retains unrelated fonts, scale entries, and font sections. Its default
binding follows the original numbered slot, **not a hardcoded `$4` or size**:
Tamagui v5 can start with `size.true === size[4] === 15`; changing only `size[4]`
to 14 or another value leaves `true` without a numbered match. The helper updates
`true` size, weight, line-height, and tracking together when that default slot
is customized. Tamagui resolves a default through the first matching size slot:
if another earlier slot has the same size but different metrics, the helper rejects
that collision rather than silently selecting the wrong weight or changing unrelated
roles. Choose a nonconflicting default binding or deliberately harmonize the metrics.

If the original default has multiple matching slots, explicitly choose the
approved one instead of guessing:

```ts
// Third createNativeTypography argument; select the actual approved slot.
{ defaultSizeTokens: { body: 5 } }
```

The same option deliberately moves an existing default. Non-default role changes
leave the current default tuple alone. Two roles cannot overwrite the same
font/size binding or give a shared font conflicting families; use separate slots
or separate font keys. Raw values and real Tamagui Variables are supported;
unresolved `$token`/CSS variable strings, missing numbers, invalid weights, and
non-finite metrics are errors rather than silently accepted fallbacks.

`assertNativeFontDefaults` checks the final resolved config (including parsed
Tamagui Variables), its selected default font, and every font's `true` size,
numbered match, and default metrics. Missing/unresolved configuration is **not**
a successful validation. This is runtime/config-helper validation, not a static
checker that evaluates arbitrary application source. Keep the assertion after
all subsequent font overrides as well.

Verify native loaded family/weight `face` entries when using separate font files.
For a binding, supply `face: { 700: { normal: 'Approved-Bold' } }` only when that
native name really is loaded. The helper removes stale face maps on family
changes and preserves an explicitly supplied map; it does not install/load assets
or prove their availability. If a family is unavailable, use the approved host
fallback and record it. See
[typography guidance](../../../shared/references/typography-and-tone.md).

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
Verify used typography bindings and real font availability too. Load the app so
the final-config assertion executes; type-checking alone does not execute it.
Confirm representative `Text` calls receive the complete role tuple. The plugin's
focused regression suite executes the real helper with installed host/Tamagui
configurations and type-checks the native wrapper:

```bash
POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT=1 \
MOBILE_SAMPLE_RUNTIME_REQUIRED=1 \
node --test "${PLUGIN_ROOT}/scripts/tests/native-typography.test.js"
```

That suite validates helper behavior, not an arbitrary generated app's font
loading or device rendering. This is a bounded helper/configuration contract:
integration copies and wires the helper, scaffolding applies its complete role
props, and final/edit validation type-checks and observes the final-config
assertion during app loading. Do not execute arbitrary imported application
source to manufacture static validation. If an existing config is unsupported,
the copied helper has not been reconciled, or the final assertion cannot be
observed, report typography consistency **unverified** rather than passing based
on source spelling, type-checking, or the plugin regression suite alone.

Refresh intent
from approved inputs; refresh implementation from current source/config via
[`/preview-screens`](../../preview-screens/SKILL.md). Browser review never verifies
native rendering or connector behavior.
