# `brand/design-system.md` — Schema

This file documents the human-readable `brand/design-system.md` companion that
`/design-system` generates. `brand/design-recipe.json` is the machine-readable
runtime source for screen hierarchy, media treatment, presentation, action
placement, and scoped negatives; `design-system.md` explains those choices to
makers and preserves compatibility with older consumers.

## Location

```
<project_root>/
├── brand/
│   ├── design-recipe.json   ← compact machine-readable runtime contract
│   ├── design-system.md     ← this schema
│   ├── tokens.ts            ← importable Tamagui tokens
│   ├── design-system.html   ← visual gallery (optional)
│   └── .history/            ← version snapshots
```

## Full schema

```markdown
# {{App Name}} — Design System
Generated: {{ISO 8601 timestamp}} | Direction: {{experience-derived direction | explicit brand direction | hybrid(...)}}

## Brand
- Identity: {{one-line description of app purpose and audience}}
- Voice: {{tone: direct | professional | conversational}}
- References: {{comma-separated reference apps, e.g. "ServiceTitan, Procore, Linear"}}
- Brand notes: {{user's free-text notes, or "none"}}
- Experience basis: {{audience + primary job + interaction/entry mode + visual character}}
- Brand role: {{app-brand | product-brand | integration | unknown}}
- Brand source: {{supplied | explicit | inferred | none}}
- Brand evidence: {{short named-organization evidence, or "none"}}
- Brand confidence: {{high | medium | low}}
- Inferred palette: {{intent + disclaimer, or "none"}}

## Palette
| Token       | Hex       | Usage                   |
|-------------|-----------|-------------------------|
| bg          | {{hex}}   | screen background       |
| surface     | {{hex}}   | cards, inputs, modals   |
| primary     | {{hex}}   | primary CTAs, links     |
| accent      | {{hex}}   | secondary accent        |
| text        | {{hex}}   | body text               |
| text-muted  | {{hex}}   | captions, meta          |
| border      | {{hex}}   | dividers, input borders |

## Status palette
| Token          | Hex       |
|----------------|-----------|
| status-success | {{hex}}   |
| status-warning | {{hex}}   |
| status-danger  | {{hex}}   |
| status-info    | {{hex}}   |

## Typography
| Role     | Family    | Size | Weight | Line | Tracking  |
|----------|-----------|------|--------|------|-----------|
| Display  | {{font}}  | {{}} | {{}}   | {{}} | {{}}      |
| Heading  | {{font}}  | {{}} | {{}}   | {{}} | {{}}      |
| Title    | {{font}}  | {{}} | {{}}   | {{}} | {{}}      |
| Body     | {{font}}  | 16   | 400    | 1.5  | 0         |
| Body-sm  | {{font}}  | 14   | 400    | 1.4  | 0         |
| Caption  | {{font}}  | 12   | 500    | 1.3  | {{}}      |
| Mono     | {{mono}}  | 14   | 400    | 1.4  | 0         |

## Spacing
{{scale: e.g. 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64}}

## Components

### Button
- Primary: bg {{primary}}, text white, radius {{md}}, height {{48|52}}px
- Secondary: bg transparent, border 1px {{border}}, text {{primary}}, same radius
- Tertiary: bg transparent, no border, text {{primary}}, underline on pressed
- Destructive: bg {{status-danger}}, text white, same radius

### Card
- bg: {{surface}}
- border: {{border policy — "1px border" or "shadow" or "none"}}
- radius: {{md}}px
- padding: {{lg}}px
- shadow: {{shadow policy — "none" or "0 1px 3px rgba(0,0,0,0.1)" etc.}}

### Input
- height: {{48|52}}px
- border: {{border style — "1px solid border" or "2px primary on focus"}}
- radius: {{sm}}px
- focus: {{focus treatment}}

### List row
- style: {{row-with-status-pill | card-with-meta | sentence}}
- height: {{56|64|72}}px
- status: {{4px left bar | pill badge | dot indicator}}
- chevron: {{yes | no}}

### Badge / Status pill
- size: {{caption}} font
- bg: {{status color at 15% opacity | solid}}
- text: {{status color | white}}
- radius: full (pill)

### Iconography
- Set: {{Ionicons | Lucide | SF Symbols}}
- Style: {{outlined | filled}}
- Size: 24px default

## Product Experience Primitives
- Primary composition: {{entryMode + primary job}}
- Focal point: {{firstViewport.focalPoint}}
- First viewport regions: {{ordered region list}}
- Visible primary action: {{firstViewport.primaryAction}}
- Signature motifs: {{2-5 motifs with their component treatment}}
- Forbidden defaults: {{experience contract hard negatives}}
- Runtime anchors: {{experience-region-* in order, experience-primary-action, experience-motif-*}}

| Motif | Foundation component | File | Runtime marker | Visual recipe |
|---|---|---|---|---|
| {{manifest motif}} | {{manifest component}} | {{manifest file}} | {{manifest testID}} | {{tokens, hierarchy, interaction, local/offline fallback}} |

## Motion
- Default: {{duration}}ms {{easing}}
- List enter: {{stagger description or "none"}}
- Screen transition: {{description or "default Expo Router"}}
- Forbidden: {{list of forbidden motion patterns}}

## Negatives (HARD RULES for screen-builder)
{{list of forbidden patterns, each prefixed with ✗}}
- ✗ {{forbidden pattern 1}}
- ✗ {{forbidden pattern 2}}
...

## Provenance
- Direction: {{full direction description}}
- Experience contract: {{schema version + confidence + source}}
- Domain context: {{optional vocabulary/compliance context, never a composition selector}}
- Brand notes: {{whether applied and to which sections}}
- Brand context: {{brandRole + brandSource + confidence; inferred palettes are not verified official guidance}}
- Generated by: /design-system v0.1
- Source: {{input mode + file/URL if applicable}}
- Confirmed: {{true|false|draft}}
- Locked at: {{ISO timestamp}}
```

## Optional explicit-direction examples

These examples may be used only when an explicit user brand direction chooses
them. They are never selected from industry keywords and never override the
Product Experience Contract's entry mode, primary action, motifs, or forbidden
defaults.

### Inspection

```markdown
## Palette
| Token       | Hex       | Usage                   |
|-------------|-----------|-------------------------|
| bg          | #f7f6f3   | screen background       |
| surface     | #ffffff   | cards, inputs           |
| primary     | #1e293b   | primary CTAs, headers   |
| accent      | #FF6A00   | safety-orange accent    |
| text        | #1a1a1a   | body text               |
| text-muted  | #6b6b6b   | meta, captions          |
| border      | #d8d6d0   | dividers                |

## Status palette
| Token          | Hex       |
|----------------|-----------|
| status-success | #2d7a3e   |
| status-warning | #c8881e   |
| status-danger  | #b8321a   |
| status-info    | #1e293b   |

## Typography
| Role     | Family | Size | Weight | Line | Tracking |
|----------|--------|------|--------|------|----------|
| Display  | Inter  | 28   | 700    | 1.2  | -0.01em  |
| Heading  | Inter  | 22   | 600    | 1.25 | -0.005em |
| Title    | Inter  | 18   | 600    | 1.3  | 0        |
| Body     | Inter  | 16   | 400    | 1.5  | 0        |
| Body-sm  | Inter  | 14   | 400    | 1.4  | 0        |
| Caption  | Inter  | 12   | 500    | 1.3  | 0.02em   |
| Mono     | JetBrains Mono | 14 | 400 | 1.4 | 0     |

## Negatives (HARD RULES)
- ✗ No shadows — use border for separation
- ✗ No serif fonts — Inter or JetBrains Mono only
- ✗ No decorative motion — functional only (150ms ease-out)
- ✗ No tap targets under 52px (gloved use)
- ✗ No saturated red except status-danger
- ✗ No chevrons on list rows — use status pills only
- ✗ No display serif fonts
```

### SaaS

```markdown
## Palette
| Token       | Hex       | Usage                   |
|-------------|-----------|-------------------------|
| bg          | #ffffff   | screen background       |
| surface     | #f8f9fa   | cards, sections         |
| primary     | #4f46e5   | primary CTAs, links     |
| accent      | #4f46e5   | (= primary, indigo)     |
| text        | #111827   | body text               |
| text-muted  | #6b7280   | secondary text          |
| border      | #e5e7eb   | dividers, input borders |

## Status palette
| Token          | Hex       |
|----------------|-----------|
| status-success | #dcfce7   |
| status-warning | #fef3c7   |
| status-danger  | #fecaca   |
| status-info    | #dbeafe   |

## Negatives (HARD RULES)
- ✗ No pill buttons — use standard radius
- ✗ No bold colors outside accent — keep neutral
- ✗ No decorative illustration in UI chrome
- ✗ No custom fonts — system-ui stack or Inter
- ✗ No card shadows heavier than 0 1px 3px rgba(0,0,0,0.1)
```

### Product

```markdown
## Palette
| Token       | Hex       | Usage                   |
|-------------|-----------|-------------------------|
| bg          | #faf8f5   | warm cream background   |
| surface     | #ffffff   | cards, modals           |
| primary     | #1a1614   | headings, primary text  |
| accent      | #7d9b76   | sage accent             |
| text        | #1a1614   | body text               |
| text-muted  | #8a857e   | secondary text          |
| border      | #e8e4de   | subtle dividers         |

## Negatives (HARD RULES)
- ✗ No chevrons on list rows — content-led, not action-led
- ✗ No status pills — use subtle text indicators
- ✗ No uppercase labels — sentence case only
- ✗ No information density — sparse is the aesthetic
- ✗ No system fonts — display heading must be visually distinct
- ✗ No flat/utilitarian card styling — editorial warmth required
```

## Validation rules

A valid `brand/design-system.md` MUST have:
1. A header with app name and direction
2. `## Palette` with at least 7 tokens (bg, surface, primary, accent, text, text-muted, border)
3. `## Status palette` with 4 tokens
4. `## Typography` with at least 5 roles
5. `## Negatives` with at least 3 rules
6. `## Product Experience Primitives` with primary composition, region order,
   primary action, motifs, forbidden defaults, and runtime anchors
7. `## Provenance` with direction, experience-contract summary, brand context, and timestamp

Missing sections → skill surfaces error, asks user to re-run.

## How screen-builder uses these artifacts

1. The build-pack compiler embeds the assigned screen slice from
   `brand/design-recipe.json`; that compact work order is the builder's normal
   runtime input.
2. Token references resolve through `brand/tokens.ts`; builders never invent
   hardcoded color, spacing, radius, or typography values.
3. Global and screen-scoped negatives remain distinct. Only rules explicitly
   scoped to the assigned screen may override its presentation recipe.
4. `brand/design-system.md` is read only as a compatibility fallback for an
   older pack or when a maker is reviewing/editing the human specification.

## How Tamagui Integration Uses tokens.ts

`brand/tokens.ts` is a plain TypeScript export. `/create-mobile-app` Step 9b imports it into `tamagui.config.ts` using [`tamagui-integration.md`](./tamagui-integration.md) and its `withSemanticAliases` helper:

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

const themes = {
  ...defaultConfig.themes,
  light: withSemanticAliases(defaultConfig.themes.light, brandTokens.color),
  dark: withSemanticAliases(defaultConfig.themes.dark, {
    primary: brandTokens.color.primary,
    accent: brandTokens.color.accent,
  }),
};

const customConfig = {
  ...defaultConfig,
  animations,
  tokens,
  themes,
};
// CUSTOMIZATION END - DO NOT REMOVE OR RENAME
```
