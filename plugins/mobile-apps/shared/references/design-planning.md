# Design Planning Reference

Shared logic for inferring and planning the visual design system for a Power Apps mobile app. Used by `native-app-planner` (Step 3c) and `setup-datamodel`.

Read these canonical contracts first:

- [product-experience-contract.md](product-experience-contract.md)
- [product-archetypes.md](product-archetypes.md)
- [visual-personalities.md](visual-personalities.md)
- [home-compositions.md](home-compositions.md)
- [reference-fidelity.md](reference-fidelity.md)

The dimensions are independent. Industry supplies vocabulary. Product archetype
describes the repeated loop. Workflow capabilities describe behavior. Operating
context supplies ergonomic constraints. Visual personality and Home composition
control expression. Never use an industry/archetype keyword as an automatic
palette, density, typography, radius, or composition selection.

Mobile-first rules apply throughout — no CSS variables, no Google Fonts, no keyframes. Everything maps to Tamagui tokens, `expo-font`, and `react-native-reanimated`.

---

## Least-Assumptive Baseline

The bundled Expo template ships a technically complete baseline. When no visual
signal exists, use `polished-operational` with `tailored` ambition as the draft
and review it at Gate 3. Do not treat the absence of adjectives as approval for
a generic dashboard or default blue UI.

| Layer | Default | Where it lives |
|---|---|---|
| Visual personality | Polished operational | `visual-personalities.md` |
| Font | Inter | `@tamagui/font-inter` (already in template) |
| Theme | System light/dark auto-switch | `app/_layout.tsx` `useColorScheme()` |
| Tokens | Tamagui `defaultConfig` | `tamagui.config.ts` (already in template) |
| Brand color | None — uses Tamagui `$blue9` | — |
| Animation | Platform-native transitions only | Expo Router default |
| Border radius | Medium (`$4` Tamagui default) | — |

Baseline = **`tamagui-design-system: add-aliases`** (the always-run minimum).
Record the full `## Product Experience` and `## Design` blocks. Screen-builders
depend on `$surface*` and `$accent*` aliases existing on every project, so this
minimum invocation is non-negotiable.

---

## Step 1 — Independent Signal Detection

Scan requirements, wizard answers, brand input, and reference input. Map only
explicit visual signals to visual decisions.

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
| "premium", "brand-forward", "designed", "polished" | `premium-brand-forward`; ambition `premium` |
| "editorial", "magazine", "content-led" | `editorial` |
| "immersive", "full-bleed", "cinematic" | `immersive` |
| screenshot, Figma, sketch, sibling app reference | `reference-driven`; create `design-intake.md` and a binding Reference Contract |

### Product and context detection

Classify the primary repeated loop using [product-archetypes.md](product-archetypes.md).
Record supporting behavior using capability slugs. Record industry vocabulary and
operating context separately. These fields inform content and ergonomics but do
not select a visual personality.

| Requirement evidence | Likely product archetype | Supporting capabilities/context |
|---|---|---|
| equipment lifecycle, downtime, preventive service, repairs, parts, warranty | `asset-maintenance-cmms` | inspection, QR lookup, issue triage, indoor/outdoor work |
| ordered checks, evidence, compliance, site sign-off | `field-inspection` | checklist, camera evidence, offline work |
| dispatch, route, technician, travel, labor, customer sign-off | `field-service-dispatch` | location, scheduling, signature |
| SKU, bin, cycle count, receiving, variance | `inventory-scan-first` | barcode scan, batch actions |
| account, contact, opportunity, follow-up, relationship health | `crm-relationship-workspace` | relationship history, scheduling |
| product catalog, collection, basket, order, fulfillment | `retail-catalog` | catalog browse, basket/order |
| workout, exercise, set, rep, recovery, personal record | `consumer-fitness` | progress tracking, media |
| appointment, patient, care plan, check-in | `healthcare-wellness` | scheduling, forms, progress tracking |
| no registry match | `custom` | describe the repeated loop explicitly |

Use `custom` only after checking the complete archetype registry. Never default
an ambiguous app to Productivity merely because it runs on Power Platform.

### User stage detection

| If requirements mention… | User stage baseline |
|---|---|
| "onboarding", "first-time", "new users", "getting started" | New user — larger targets, inline hints, progressive disclosure |
| "daily use", "field workers", "operators", "staff" | Returning user (default) — standard density, efficiency-focused |
| "power users", "admins", "bulk operations", "advanced" | Power user — dense layout, batch actions, less chrome |

Default: **Returning user** (most Power Platform apps are for trained staff).

If no visual keywords match, draft `polished-operational` and review it at Gate
3. If archetype confidence is low, include the top alternatives and evidence in
Gate 1 rather than silently selecting one.

---

## Step 1b — Visual Personality, Ambition, and Composition

Choose these independently after archetype detection. Explicit user/reference
signals outrank recommendations.

| Decision | Allowed values | Default when absent |
|---|---|---|
| Visual personality | `utility`, `polished-operational`, `premium-brand-forward`, `editorial`, `immersive`, `playful-consumer`, `reference-driven` | `polished-operational` |
| Visual ambition | `template`, `tailored`, `premium`, `bespoke` | `tailored` |
| Content emphasis | `image-led`, `object-led`, `data-led`, `relationship-led`, `task-led`, `timeline-led` | derived from approved primary loop |
| Home composition | key from `home-compositions.md` | choose deliberately from archetype candidates |
| Reference fidelity | `none`, `directional`, `high`, `strict-structural` | `none` |
| Media strategy | `record-media`, `local-ui-media`, `generated-placeholder`, `mixed`, `none` | explicit per composition |

An asset-maintenance app may therefore be `premium-brand-forward` with an
`asset-command` Home; a consumer app may be `utility`. This is valid, not a
hybrid exception.

---

## Step 1c — Palette Architecture

Decide whether to build a custom color palette or use Tamagui defaults. Full palette building methodology → see [color-palette-architecture.md](color-palette-architecture.md).

| Input | Palette action |
|---|---|
| User provides hex brand color | Build 3-variant accent scale (deep/base/soft) + tinted surface scale from brand hue |
| User names an industry, no brand color | Use industry-default palette from `color-palette-architecture.md` |
| User says "minimal" or "clean" | Near-monochrome: single accent at strict 10% usage, desaturated status colors |
| User says "warm" or "organic" | Warm-tinted surfaces (cream/sand base), warm accent |
| No input (default) | Standard Tamagui tokens, no custom palette needed |

**Three-layer model:** If building a custom palette, define three semantic layers:
1. **Surface scale** (surface0–4) — backgrounds from lightest to darkest
2. **Text scale** (text0–3) — foreground from primary to faintest
3. **Accent triad** — deep/base/soft variants of one brand hue

**Status color saturation:** derive it from operating context and measured
contrast. Outdoor/gloved/safety-critical contexts may use stronger status color;
indoor maintenance does not automatically require saturated Field/Ops styling.

Record the palette decision in `## Design`.

---

## Step 1d — Copy Tone Selection

Select a copy tone from audience, brand, and visual personality. Full tone
reference with example strings → see [typography-and-tone.md](typography-and-tone.md).

| Tone | Voice | Button style | Empty state style | Error style |
|---|---|---|---|---|
| **Professional** | Direct, clear, no personality | Verb phrases ("Save report") | Statement + CTA ("No reports yet. Create one.") | Direct ("Could not load. Try again.") |
| **Warm** | Encouraging, human, peer-like | Softer verbs ("Add your first...") | Question ("Ready to start?") | Gentle ("Something went wrong. Let's try again.") |
| **Utilitarian** | Terse, no fluff, status-focused | Shortest verb ("Save", "Capture") | Minimal ("No items") | Status + retry ("Load failed. Retry.") |
| **Editorial** | Calm, considered, no emoji ever | Verbs as statements ("Begin writing") | Invitational ("What will you write about?") | Understated ("We couldn't load this.") |

**Least-assumptive defaults:** `utility` → Utilitarian;
`polished-operational` → Professional; `premium-brand-forward` and
`playful-consumer` → Warm unless brand guidance says otherwise; `editorial` →
Editorial; `reference-driven` → derive from the approved reference.

**Universal microcopy rules (all tones):**
- No exclamation marks in UI text
- No emoji anywhere
- Buttons are verbs, never "OK"/"Submit"/"Yes"/"No"
- Errors state the problem + offer an action, never apologize

Record the tone in `## Design`.

---

## Step 2 — Personality + Context → Tamagui Decisions

Map the approved personality, ambition, operating context, and reference
contract to concrete Tamagui + Expo choices. This is a starting point, not a
replacement for composition fields.

| Visual personality | Context | Font | Font pairing | Brand token | Default theme | Animation | Tone |
|---|---|---|---|---|---|---|---|
| polished-operational | repeated internal work | Inter | Single-family (weight only) | custom or restrained semantic accent | System auto | Functional | Professional |
| utility | outdoor/gloved/safety-critical | Inter | Inter + mono for scanned/data values | high-contrast semantic accent | System auto | None | Utilitarian |
| premium-brand-forward | product/object-led | approved display family | Display + readable sans body | custom accent triad | approved light/dark | Enriched | Warm/brand |
| editorial | content-led | approved serif/display | Display + sans UI | muted accent | approved light/dark | Subtle | Editorial |
| immersive | media-led | expressive display | Display + sans UI | media-aware accent | approved light/dark | Enriched/immersive | Brand |
| playful-consumer | progress/celebration | rounded sans | Single-family rounded | saturated accessible accent | Light/system | Enriched | Warm |
| reference-driven | binding intake | from Reference Contract | from Reference Contract | from Reference Contract | from Reference Contract | from Reference Contract | from Reference Contract |

**Font installation:**
- `@tamagui/font-inter` / `@tamagui/font-mono` — already listed as optional deps in template, add to `tamagui.config.ts`
- Custom fonts (Nunito, Playfair, etc.) — `npx expo install expo-font`, add to `app/_layout.tsx` `useFonts()`

---

## Step 3 — Build the `## Design` Section

### If default (no deviations):

```markdown
## Design

Default stack — no customization needed.
- Industry rationale: <one sentence — e.g. "Detected as productivity/enterprise app; Refined Minimal is the standard for trained-staff internal tools">
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
- Industry: <detected or "productivity">
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
- Industry: <detected industry>
- Visual language: <from industry detection — e.g., "warm approachable palette, friendly microcopy">
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

## Step 4 — Pass to Screen Planner

Include the `## Design` section in the screen-planner prompt so per-screen specs reference the right tokens:

```
Approved design:
- Aesthetic direction: Refined Minimal
- Font: Inter (default)
- Typography: single-family, weight differentiation
- Headline tracking: 0
- Body line-height: 1.5x default
- Brand color: $blue9
- Palette: default
- Theme: system light/dark
- Animation: none
- Industry: field/ops
- Visual language: high contrast, large targets, camera-forward
- User stage: returning
- Copy tone: Utilitarian
- Emotional design: celebrate inspection completion with summary card
- Layout: edge-to-edge rows for inspection lists, cards for summary stats

Per-screen specs MUST use Tamagui primitives (XStack, YStack, Text, Button) with
token-based styling ($color, $background, $space.*) — never hardcoded hex or px values.
Animation: only add if design section specifies a style.
Color: follow the 60/30/10 rule (see mobile-design-philosophy.md Section 5).
Industry patterns: apply visual language from mobile-design-philosophy.md Section 12.
Aesthetic direction: apply from mobile-design-philosophy.md Section 13.
Layout: question whether cards are needed — see Section 14 (edge-to-edge rows for dense lists).
Data values: use fontFamily="$mono" for IDs, timestamps, currency, coordinates.
Peak moments: note which screens have task-completion flows that deserve celebration.
Anti-patterns: ensure no items from Section 16 checklist are present.
Universal patterns: screen-builder will read universal-patterns.md for industry-specific
patterns (sparklines for finance, offline sync for field, etc.). Include the industry in
per-screen specs so the builder knows which sections to apply.
```

---

## Execution Mapping

| `## Design` says | Step 9b action |
|---|---|
| `tamagui-design-system: add-aliases` | **Always run** — apply `skills/design-system/references/tamagui-integration.md` in alias-only mode. This is the default path. Adds `$surface0`–`$surface3` and `$accent*` aliases over `defaultConfig`. No brand tokens, no theme overrides. |
| `tamagui-design-system: required` | Apply `skills/design-system/references/tamagui-integration.md` with brand tokens + theme from the `## Design` section. |
| Custom font only (no design-system line) | `npx expo install expo-font` + `useFonts()` in `app/_layout.tsx`. Also apply alias-only mode so semantic tokens exist for the screen-builder. |

**There is no "skip Step 9b" path.** Every plan now includes a `tamagui-design-system` line. `add-aliases` is the minimum — it always runs. `required` runs when there is a custom brand color, custom theme, or non-default font pairing.
