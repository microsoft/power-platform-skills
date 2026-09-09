# Compact Brand Artifact Contract

Read only while writing or reconciling brand artifacts. The ordinary contract is `brand/design-system.md` + `brand/tokens.ts`; `_design_preview.html` visualizes the primary journey. Gallery and history are optional.

## `brand/design-system.md`

Use these headings for downstream compatibility; concise tables/bullets are enough. Do not pad sections, manufacture negatives, or copy every screen spec.

```markdown
# <App> — Design System

## Brand
<Primary job/context, supplied brand versus inference, consequential design rationale>

## Palette
| Token | Value | Role |
|---|---|---|
<bg, surface, primary, accent, text, textMuted, border; concrete resolved values>

## Status palette
<statusSuccess, statusWarning, statusDanger, statusInfo; foreground/background use>

## Typography
| Role | Family | Size | Weight | Line-height ratio | Tracking em | Tamagui binding |
|---|---|---|---|---|---|---|
<Only needed roles; body/heading plus caption/data/etc. where used>
<Local asset/loading path or supported fallback; no invented font availability>

## Spacing
<Named spacing, size and radius values; preserve host numeric token scale>

## Components
<Only relevant decisions: hierarchy, composition, density, navigation, surfaces,
media purpose/crop, input/action/state treatments. Per-screen differences are allowed.>

## Motion
<Functional purpose or none; reduced-motion behavior>

## Negatives
<Explicit user prohibitions and actual safety/accessibility constraints only;
if none beyond shared constraints, say so. Style suggestions are not build gates.>

## Provenance
<Input/source, inferred assumptions, confirmation state, date, integration gaps>
```

Prefer existing camelCase color keys in both files; normalize legacy hyphenated labels when comparing drift. Legacy headings such as `## Negatives (HARD RULES)` remain readable. Explicit negatives are requirements; invented style prohibitions are not.

## `brand/tokens.ts`

Keep the established plain export; no script execution, dependency, or JSON sidecar is needed. Example shape below is illustrative, not a default palette/style:

```ts
export const tokens = {
  color: {
    bg: '#ffffff', surface: '#f4f5f7',
    primary: '#224e73', accent: '#224e73',
    text: '#17222b', textMuted: '#4d5c67', border: '#74838f',
    statusSuccess: '#22683b', statusWarning: '#805400',
    statusDanger: '#a12424', statusInfo: '#224e73',
  },
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, '2xl': 32 },
  size: { buttonHeight: 48, inputHeight: 48, iconSize: 24 },
  radius: { sm: 4, md: 8, lg: 16, full: 9999 },
  typography: {
    heading: { family: 'System', size: 24, weight: '600', lineHeight: 1.25, tracking: 0 },
    body: { family: 'System', size: 16, weight: '400', lineHeight: 1.5, tracking: 0 },
  },
} as const;

export type BrandTokens = typeof tokens;
```

`System` denotes the supported platform fallback, not a new downloadable font. Choose actual families from the project's resolved host/fonts. Preserve additional existing keys and role names consumed by code. Numbered space/size keys retain the defaultConfig scale; named brand keys are additive.

For typography, `size` is native logical units, `lineHeight` is a ratio, and `tracking` is em. Bind roles explicitly in the spec; convert to native absolute lineHeight/letterSpacing when configuring `createFont`, and preserve equivalent units in HTML. A typography object not consumed by config/screens is not wired typography.

## Runtime consumers and validation

- Screen builders read the compact spec and actual tokens. Their task-specific composition remains model-authored.
- [Tamagui integration](./tamagui-integration.md) imports `tokens`, extends default token scales, resolves semantic aliases, and maps both themes into the host provider.
- `/preview-screens` reads imported brand tokens **and** actual config/font bindings. It does not assume raw brand keys equal resolved semantic aliases.
- Light and dark must independently pass contrast checks. If an existing `brand/tokens.dark.ts` or named-theme import is used, preserve/reconcile it; new ordinary projects need no extra palette file.
- Check spec/token values, used token references, font availability/bindings, and required artifact existence. No minimum decorative component count, mandatory reference brands, or fixed list of preset names.
