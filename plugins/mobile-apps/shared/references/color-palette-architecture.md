# Color Palette Architecture

Read only when choosing, importing, refreshing, or checking a palette. Industry names do not choose palettes. Begin with supplied brand, task hierarchy, semantic meaning, lighting, and contrast.

## Semantic roles, not a style preset

| Layer | Contract |
|---|---|
| Surfaces | `surface0`–`surface3`, `mediaSurface`; group and separate content according to the task |
| Text | `text0`–`text3`; primary/secondary/metadata/disabled roles, all essential text remains readable |
| Accent | `accentDeep`, `accentBase`, `accentSoft`, `accentOnAccent`; action, selection and focus with readable foregrounds |
| Status | Host success/warning/danger/info foreground/background pairs; text/icon labels as well as color |

The host owns alias derivation. Resolve actual installed theme keys rather than guessing `surface0 == color1` or `text2 == color10`. The host provider's `surface4` currently maps from the exported app theme's `color6`; do not introduce an incompatible alternative mapping.

## Choose and validate colors

1. Preserve supplied brand colors where they can fulfill their roles accessibly. A logo color need not be the CTA fill, and its hue does not require tinting every surface.
2. Choose light/dark surfaces and text as separate coherent palettes. Either may be warm, cool, neutral, flat, or layered if it helps the work; there is no blanket pure-black ban or required industry hue.
3. Use accent for useful attention. Additional category/media colors may be appropriate; fixed 60/30/10 ratios and single-accent rules are design heuristics, not validation gates.
4. Derive usable accent variants through the existing host helper, then measure contrast. HSL lightness or a saturation percentage is not a WCAG contrast test and must not choose the on-accent foreground.
5. Validate text/background pairs (4.5:1 for normal text; 3:1 for qualifying large text) and required non-text indicators/control boundaries (3:1). Include status pills, focus, selection, error, and both themes. See [WCAG contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
6. Fix unreadable combinations by changing the specific foreground/background treatment and record deviations from imported branding. Do not lower safety/error visibility to satisfy an aesthetic desaturation rule.

Store concrete approved brand values in `brand/tokens.ts` and describe their roles in `brand/design-system.md`. For custom fully designed dark palettes, use the already-established project's shape/imports; do not create a new sidecar format just for preview.

## Native integration

Use [Tamagui integration](../../skills/design-system/references/tamagui-integration.md), which owns the working configuration/provider example:

- `createPowerAppsTamaguiConfig` remains the factory.
- `withPowerAppsSemanticAliases` resolves each app theme.
- Export `appLightTheme` / `appDarkTheme`; both Tamagui and `PowerAppsProvider` read those values.
- Ordinary single-palette input applies light surfaces/text while dark keeps baseline dark surfaces/text and carries approved accent/status values. Do not spread the entire light palette into dark.
- If explicit dark overrides are approved, resolve them through the same host helper and keep aliases/provider values synchronized. Do not override numbered colors after resolving aliases and leave the aliases stale.
- Preserve existing auth, schema, offline, service, and provider ownership. No local duplicate color parser or contrast/alias helper.

## Preview integration

Follow [HTML token mapping](./tamagui-html-mapping.md). Read imported brand tokens and resolved config, not just inline color objects. Emit every used alias in both advertised themes, including `--surface0` and `--surface1`. Compare representative surface/text/accent/status pairs against actual inputs. Do not silently preview a generic blue or white palette when the app imports different brand colors.
