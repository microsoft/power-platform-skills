# Design Planning Reference

Shared logic for planning the visual design system for a Power Apps mobile app.
Used by foreground `/create-mobile-app`, `/edit-app`, and `/design-system` planning.

Read
[`product-experience-compiler.md`](product-experience-compiler.md) first.
Industry supplies vocabulary and content examples only. It must never
automatically select palette, typography, density, radius, Home composition, or
a direction preset.

Mobile-first rules apply throughout — no CSS variables, no Google Fonts, no keyframes. Everything maps to Tamagui tokens, `expo-font`, and `react-native-reanimated`.

---

## Least-Assumptive Baseline

When no brand or explicit aesthetic is supplied, materialize the approved UX
DNA using a neutral `polished-operational` expression. The result is still a
complete app-specific design system; it is not an inspection preset or a bare
Tamagui default.

| Layer | Default | Where it lives |
|---|---|---|
| Visual personality | Polished operational | Product Experience contract |
| Font | Inter | `@tamagui/font-inter` (already in template) |
| Theme | System light/dark auto-switch | `app/_layout.tsx` `useColorScheme()` |
| Tokens | Tamagui `defaultConfig` | `tamagui.config.ts` (already in template) |
| Brand color | None — uses Tamagui `$blue9` | — |
| Animation | Platform-native transitions only | Expo Router default |
| Border radius | Medium (`$4` Tamagui default) | — |

Always write the full `## Product Experience` and `## Design` blocks and
materialize semantic aliases. Screen-builders depend on `$surface*` and
`$accent*` aliases existing on every project.

---

## Step 1 — Independent Signal Detection

Scan requirements and wizard answers. Map matches to design decisions.

| If requirements mention… | Design decision |
|---|---|
| brand colors, company colors, hex code, `#xxxxxx`, "matches our app" | Custom brand tokens → apply `skills/design-system/references/tamagui-integration.md` |
| "dark mode first", "dark theme", "dark UI" | Default theme = dark |
| "playful", "consumer", "fun", "kids", "game" | Bold tokens, spring animations |
| "enterprise", "internal tool", "back office", "admin" | Reinforce default — no changes |
| "minimal", "clean", "simple" | Reinforce default — no changes |
| "professional", "corporate", "business" | Reinforce default — no changes |
| custom font name (e.g. "use Outfit", "we use DM Sans") | Install that font via `expo-font` |
| "no animations", "reduce motion" | Disable all animations, add `reduceMotion` config |

### Product-experience dimensions

Resolve visual decisions from independent fields:

| Product Experience field | Design consequence |
|---|---|
| Visual personality | Overall expression and composition budget |
| Content emphasis | Image/object/data/relationship/task/timeline hierarchy |
| Operating context | Target size, contrast, density, and reach constraints |
| Interaction tempo | Progressive disclosure, shortcuts, and motion restraint |
| Decision risk | Trust signals, confirmation, and evidence prominence |
| Media strategy | Image ratio, source, and stable fallback geometry |
| First viewport | Dominant region order and primary-action placement |
| Accessibility priorities | Type scale, touch targets, contrast, and alternatives |

Industry is recorded separately for vocabulary. It does not choose a row in a
style table.

### User stage detection

| If requirements mention… | User stage baseline |
|---|---|
| "onboarding", "first-time", "new users", "getting started" | New user — larger targets, inline hints, progressive disclosure |
| "daily use", "field workers", "operators", "staff" | Returning user (default) — standard density, efficiency-focused |
| "power users", "admins", "bulk operations", "advanced" | Power user — dense layout, batch actions, less chrome |

Default: **Returning user** (most Power Platform apps are for trained staff).

If no visual keywords match, preserve the Product Experience dimensions and use
the least-assumptive polished-operational expression. Never infer Productivity,
Field/Ops, or any other design preset from missing input.

---

## Step 1b — Aesthetic Direction

Choose a direction from explicit brand/aesthetic input or materialize one from
the approved visual personality and content emphasis. An operational product
may be premium or editorial; a consumer product may intentionally use utility
styling. Do not use industry as a lookup key.

---

## Step 1c — Palette Architecture

Decide whether to build a custom color palette or use Tamagui defaults. Full palette building methodology → see [color-palette-architecture.md](color-palette-architecture.md).

| Input | Palette action |
|---|---|
| User provides hex brand color | Build 3-variant accent scale (deep/base/soft) + tinted surface scale from brand hue |
| Product Experience has no brand color | Build a restrained accessible semantic palette appropriate to the approved personality and content emphasis |
| User says "minimal" or "clean" | Near-monochrome: single accent at strict 10% usage, desaturated status colors |
| User says "warm" or "organic" | Warm-tinted surfaces (cream/sand base), warm accent |
| No input (default) | Standard Tamagui tokens, no custom palette needed |

**Three-layer model:** If building a custom palette, define three semantic layers:
1. **Surface scale** (surface0–4) — backgrounds from lightest to darkest
2. **Text scale** (text0–3) — foreground from primary to faintest
3. **Accent triad** — deep/base/soft variants of one brand hue

**Status color desaturation:** For non-field apps, desaturate `$red10`/`$green10`/`$yellow10` by 15-25% so they sit politely in the palette. Field/ops apps keep full saturation for outdoor visibility.

Record the palette decision in `## Design`.

---

## Step 1d — Copy Tone Selection

Select a copy tone profile from the approved visual personality, primary user,
interaction tempo, and explicit brand voice. Full tone reference with example
strings → see [typography-and-tone.md](typography-and-tone.md).

| Tone | Voice | Button style | Empty state style | Error style |
|---|---|---|---|---|
| **Professional** | Direct, clear, no personality | Verb phrases ("Save report") | Statement + CTA ("No reports yet. Create one.") | Direct ("Could not load. Try again.") |
| **Warm** | Encouraging, human, peer-like | Softer verbs ("Add your first...") | Question ("Ready to start?") | Gentle ("Something went wrong. Let's try again.") |
| **Utilitarian** | Terse, no fluff, status-focused | Shortest verb ("Save", "Capture") | Minimal ("No items") | Status + retry ("Load failed. Retry.") |
| **Editorial** | Calm, considered, no emoji ever | Verbs as statements ("Begin writing") | Invitational ("What will you write about?") | Understated ("We couldn't load this.") |

Tone follows the approved visual personality, primary user, and interaction
tempo. Industry terminology may influence vocabulary but does not select tone.

**Universal microcopy rules (all tones):**
- No exclamation marks in UI text
- No emoji anywhere
- Buttons are verbs, never "OK"/"Submit"/"Yes"/"No"
- Errors state the problem + offer an action, never apologize

Record the tone in `## Design`.

---

## Step 2 — Aesthetic + Mood → Tamagui Decisions

Only used when deviating from default. Map the user's aesthetic + mood to concrete Tamagui + Expo choices:

| Aesthetic | Mood | Font | Font pairing | Brand token | Default theme | Animation | Tone |
|---|---|---|---|---|---|---|---|
| Clean + Professional | — | Inter (`@tamagui/font-inter`) | Single-family (weight only) | `$blue9` | System auto | None | Professional |
| Bold + Vibrant | Professional | `@tamagui/font-inter` bold weights | Single-family (weight only) | Custom `$accentBase` (strong hue) | Light | Spring (`withSpring`) | Professional |
| Bold + Vibrant | Playful/Consumer | Custom (`expo-font` + e.g. Nunito) | Single-family rounded | Custom `$accentBase` (saturated) | Light | Spring + bounce | Warm |
| Dark + Moody | Technical | `@tamagui/font-mono` | Inter + JetBrains Mono | `$green9` or `$violet9` neon | Dark forced | Fade (`withTiming`) | Utilitarian |
| Dark + Moody | Elegant | Custom serif (e.g. Playfair via `expo-font`) | Serif heading + Inter body | `$yellow9` gold/copper | Dark forced | Slow fade | Editorial |
| Warm + Organic | Professional | Inter + warm palette | Single-family (weight only) | Custom `$accentBase` (terracotta) | System auto | Gentle ease | Warm |
| Warm + Organic | Playful | Custom rounded (e.g. Nunito, Poppins) | Single-family rounded | Custom `$accentBase` (coral/sage) | System auto | Springy | Warm |

**Font installation:**
- `@tamagui/font-inter` / `@tamagui/font-mono` — already listed as optional deps in template, add to `tamagui.config.ts`
- Custom fonts (Nunito, Playfair, etc.) — `npx expo install expo-font`, add to `app/_layout.tsx` `useFonts()`

---

## Step 3 — Build the `## Design` Section

### If no explicit brand or aesthetic input:

```markdown
## Design

Product-experience-derived baseline.
- Product rationale: <one sentence tying the expression to primary user, goal, operating context, and content emphasis>
- Visual personality: polished-operational
- Content emphasis: <from Product Experience>
- First viewport: <from Product Experience>
- Signature experience: <from Product Experience>
- Aesthetic: Clean + Professional
- Aesthetic direction: Refined Minimal
- Font: Inter (template default)
- Typography: single-family, weight differentiation only
- Headline tracking: default (no override)
- Body line-height: 1.5x default
- Theme: System light/dark auto
- Tokens: Tamagui defaultConfig
- Palette: default (no custom palette)
- Animation: Platform-native transitions only
- Industry context: <vocabulary only; does not select design>
- User stage: returning (default)
- Copy tone: Professional
- Emotional design: standard confirmations, no custom peak moments
- Layout: cards for grouped content, edge-to-edge rows for dense lists
- Hero visual principle: <one phrase — e.g. "oversized stat with edge-to-edge row beneath it" or "clean header, content leads">
- Density target: comfortable
- Surface treatment: flat (no elevation, no card borders)
- Navigation mood: functional
- Card strategy: edge-to-edge rows for lists, bordered cards for grouped summary content
- Accent strategy: restrained — $blue9 at ≤10% of surface area
- Motion policy: functional-only — skeleton→data transitions and press feedback, nothing decorative
- One memorable thing: <one sentence — what a user will remember about this app visually. E.g. "monospace data values in every list row make it feel precise and trustworthy">
- tamagui-design-system: add-aliases
```

> **`add-aliases` mode** — even on the default path, Step 9b applies `skills/design-system/references/tamagui-integration.md` in alias-only mode to add `$surface0`–`$surface3`, `$accentBase`, `$accentSoft`, `$accentDeep`, and `$accentOnAccent` as named theme values over `defaultConfig`. This keeps `tamagui.config.ts` on `defaultConfig` for everything else, but gives the screen-builder a stable semantic contract regardless of whether a custom design system was configured.

### If deviating:

```markdown
## Design

- Aesthetic: <choice>
- Aesthetic direction: <Industrial / Editorial / Refined Minimal / Soft Organic / Bold Expressive>
- Mood: <choice>
- Font: <font name> via <@tamagui/font-* or expo-font>
- Typography: <single-family | paired: heading=X, body=Y>
- Headline tracking: <letterSpacing overrides, e.g., "-0.5 at $7+">
- Body line-height: <ratio, e.g., "1.6x for prose screens">
- Brand color token: $brand → <hex or Tamagui token>
- Palette: <default | custom: surface=warm cream, accent=ochre triad> (see color-palette-architecture.md)
- Default theme: <system auto | light forced | dark forced>
- Animation style: <none | spring | slow-fade | gentle-ease>
- Industry context: <vocabulary only>
- Visual personality: <approved personality>
- Content emphasis: <approved emphasis>
- Operating context: <approved context>
- Visual language: <materialization of personality + emphasis + context>
- User stage: <new | returning | power>
- Copy tone: <Professional | Warm | Utilitarian | Editorial> (see typography-and-tone.md)
- Emotional design: <peak moments to celebrate — e.g., "form completion summary, inspection streak counter">
- Layout: <cards vs edge-to-edge rows, density level>
- Hero visual principle: <one phrase describing the dominant visual treatment — e.g. "full-bleed hero image with gradient text overlay", "oversized numeric stat anchors every dashboard card", "whitespace is the hero — content floats">
- Density target: <sparse | comfortable | dense> — sparse = lots of breathing room, consumer; dense = maximum info, field/finance
- Surface treatment: <flat | subtle-depth | strong-cards | editorial> — flat = no shadows/borders; subtle-depth = 1px borders + mild elevation; strong-cards = clearly lifted cards; editorial = asymmetric layout with intentional blank space
- Navigation mood: <functional | atmospheric | cinematic> — functional = tab bar + stack, invisible chrome; atmospheric = blurred tab bar, large titles; cinematic = full-bleed transitions, no visible navigation chrome
- Card strategy: <edge-to-edge rows | bordered cards | floating cards | none> — choose one dominant pattern; mixing is a smell
- Accent strategy: <restrained | expressive | monochrome> — restrained = accent touches only (CTAs, active states); expressive = accent on surfaces and fills; monochrome = no accent, type weight does the work
- Motion policy: <none | functional-only | enriched | immersive> — functional-only = skeleton/data + press; enriched = + screen enter/exit + list stagger; immersive = + scroll parallax + celebration moments
- One memorable thing: <one sentence. Not a feature list — a visual impression. E.g. "completion screens use a quiet summary card with strong mono data, making every save feel like a receipt". This field must be concrete and specific — reject vague answers like "clean and modern">
- tamagui-design-system: required — brand tokens + theme variants
```

---

## Step 4 — Pass to foreground screen planning

Include the approved design values while authoring per-screen packs and work orders so screen implementation references the right tokens:

```
Approved design:
- Visual personality: polished-operational
- Content emphasis: task-led
- Operating context: one-handed, intermittent connectivity
- Aesthetic direction: Refined Minimal
- Font: Inter (default)
- Typography: single-family, weight differentiation
- Headline tracking: -0.3 at $8+ only
- Body line-height: 1.5x default
- Brand color: $blue9
- Palette: default
- Theme: system light/dark
- Animation: none
- Industry context: inspection (vocabulary only)
- Visual language: high contrast and large targets because the operating context requires them
- User stage: returning
- Copy tone: Utilitarian
- Emotional design: celebrate inspection completion with summary card
- Layout: edge-to-edge rows for inspection lists, cards for summary stats

Per-screen specs MUST use Tamagui primitives (XStack, YStack, Text, Button) with
token-based styling ($color, $background, $space.*) — never hardcoded hex or px values.
Animation: only add if design section specifies a style.
Color: follow the 60/30/10 rule (see mobile-design-philosophy.md Section 5).
Product patterns: apply only patterns that serve approved product jobs and
operating constraints.
Aesthetic direction: apply from mobile-design-philosophy.md Section 13.
Layout: question whether cards are needed — see Section 14 (edge-to-edge rows for dense lists).
Data values: use fontFamily="$mono" for IDs, timestamps, currency, coordinates.
Peak moments: note which screens have task-completion flows that deserve celebration.
Anti-patterns: ensure no items from Section 16 checklist are present.
Universal patterns: screen-builder will read universal-patterns.md. Include the
approved job/context that justifies each selected pattern; do not include one
merely because an industry keyword matched.
```

---

## Execution Mapping

| `## Design` says | Step 9b action |
|---|---|
| `tamagui-design-system: add-aliases` | **Always run** — apply `skills/design-system/references/tamagui-integration.md` in alias-only mode. This is the default path. Adds `$surface0`–`$surface3` and `$accent*` aliases over `defaultConfig`. No brand tokens, no theme overrides. |
| `tamagui-design-system: required` | Apply `skills/design-system/references/tamagui-integration.md` with brand tokens + theme from the `## Design` section. |
| Custom font only (no design-system line) | `npx expo install expo-font` + `useFonts()` in `app/_layout.tsx`. Also apply alias-only mode so semantic tokens exist for the screen-builder. |

**There is no "skip Step 9b" path.** Every plan now includes a `tamagui-design-system` line. `add-aliases` is the minimum — it always runs. `required` runs when there is a custom brand color, custom theme, or non-default font pairing.
