# `brand/design-system.md` — Schema

This file documents the exact shape of `brand/design-system.md` that `/design-system` generates. Downstream agents/references (`screen-builder`, Tamagui integration, `/preview-screens`) read this file as the visual source of truth.

## Location

```
<project_root>/
├── brand/
│   ├── design-system.md     ← this schema
│   ├── tokens.ts            ← importable Tamagui tokens
│   ├── design-system.html   ← visual gallery (optional)
│   └── .history/            ← version snapshots
```

## Full schema

```markdown
# {{App Name}} — Design System
Generated: {{ISO 8601 timestamp}} | Design intent: {{concise free-form description}}

## Brand
- Identity: {{one-line description of app purpose and audience}}
- Voice: {{tone: direct | professional | conversational}}
- References: {{comma-separated reference apps, e.g. "ServiceTitan, Procore, Linear"}}
- Brand notes: {{user's free-text notes, or "none"}}

## Product Experience Link
- Contract version: 1
- Product archetype: {{prompt-grounded product-behavior description from native-app-plan.md}}
- Workflow capabilities: {{approved workflow descriptions}}
- Operating context: {{approved physical and operational constraints}}
- Visual personality: {{approved free-form visual character}}
- Visual ambition: {{approved quality and distinctiveness target}}
- Content emphasis: {{description of what dominates attention and why}}
- Home composition: {{approved free-form composition description}}
- Reference fidelity: {{none | directional | high | strict-structural}}

## Composition
- Signature component: {{name}}
- First viewport share: {{0.20-0.65}}
- Minimum height: {{integer dp}}
- Headline minimum: {{integer sp}}
- Supporting metrics maximum: {{0-4}}
- Primary action placement: {{integrated | in-flow | bottom-dock | native-navigation}}
- Next section visible: {{yes | no}}
- Duplicate action with tab: {{allowed | forbidden}}
- Cross-tab silhouettes: {{one line per tab root}}

## Media
- Strategy: {{record-media | local-ui-media | generated-placeholder | mixed | none}}
- Required on Home: {{yes | no}}
- Source: {{field/asset/source identifier or none}}
- Aspect/viewport ratio: {{range or none}}
- Loading fallback: {{description}}
- Error fallback: {{description}}
- Empty fallback: {{description}}

## Navigation
- Mood: {{free-form navigation character appropriate to the workflow}}
- Silhouette: {{tab/drawer/header geometry}}
- Primary-action owner: {{screen/component}}
- Safe-area behavior: {{description}}

## Signature Components
### {{Signature component name}}
- Purpose: {{domain-specific purpose}}
- Stable geometry: {{height/aspect/min/max}}
- Required content: {{fields/regions}}
- States: {{loading/error/empty/populated}}
- Reference motifs: {{none or list}}
- Forbidden drift: {{none or list}}

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
| Display  | {{font}}  | {{}} | {{}}   | {{}} | 0         |
| Heading  | {{font}}  | {{}} | {{}}   | {{}} | 0         |
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
- height: {{integer at least 44}}px
- border: {{border style — "1px solid border" or "2px primary on focus"}}
- radius: {{sm}}px
- focus: {{focus treatment}}

### List row
- style: {{entity- and workflow-specific row description}}
- height: {{integer at least 44}}px
- status: {{single clear status treatment appropriate to the content}}
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
- Product archetype: {{slug}} ({{confidence}})
- Visual personality: {{slug}}
- Visual ambition: {{level}}
- Design rationale: {{short explanation of consequential inferred choices}}
- Industry context: {{industry vocabulary only}}
- Brand notes: {{whether applied and to which sections}}
- Generated by: /design-system v0.1
- Source: {{input mode + file/URL if applicable}}
- Design intake: {{path or none}}
- Reference fidelity: {{level}}
- Confirmed: {{true|false|draft}}
- Locked at: {{ISO timestamp}}
```

## Validation rules

A valid `brand/design-system.md` MUST have:
1. A header with app name and direction
2. `## Product Experience Link` with archetype, personality, ambition, Home composition, and reference fidelity
3. `## Composition` with every First Viewport Contract field and tab silhouettes
4. `## Media` with strategy, source, and loading/error/empty fallbacks
5. `## Navigation` with mood, silhouette, action owner, and safe-area behavior
6. `## Signature Components` with stable geometry and states
7. `## Palette` with at least 7 tokens (bg, surface, primary, accent, text, text-muted, border)
8. `## Status palette` with 4 tokens
9. `## Typography` with at least 5 roles and tracking `0`
10. `## Negatives` with at least 3 rules, including any Reference Contract forbidden drift
11. `## Provenance` with archetype, personality, source, fidelity, and timestamp

Missing sections → skill surfaces error, asks user to re-run.

## How screen-builder uses this file

1. **Mandatory read** — builder MUST read `brand/design-system.md` if it exists in `<working_dir>/brand/`
2. **Structural priority** — `## Product Experience Link`, `## Composition`, `## Media`, `## Navigation`, and `## Signature Components` are binding and outrank generic samples.
3. **Token references** — all color/spacing/radius values come from this spec, never hardcoded hex
4. **Negatives are HARD RULES** — any pattern listed in `## Negatives` is forbidden. Violations are build failures unless they conflict with a higher-priority Reference Contract, which is `BLOCKED` for plan repair.
5. **Typography mapping** — `## Typography` role table maps to Tamagui font tokens ($heading, $body, $mono)
6. **Component shapes** — `## Components` defines the exact shape for buttons, cards, inputs, list rows

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
