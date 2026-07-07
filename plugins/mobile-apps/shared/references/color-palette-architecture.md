# Color Palette Architecture

> **When to read this file:** Only when the plan's `## Design` section specifies a custom palette. If using Tamagui defaults with no brand color, skip this file entirely.

---

## Three-Layer Palette Model

Every custom design defines three semantic layers in `tamagui.config.ts`. This replaces arbitrary token overrides with a coherent system.

### Layer 1: Surface Scale (backgrounds)

Five stops from lightest to darkest. In dark mode, the scale inverts.

| Token | Light mode role | Maps to Tamagui |
|---|---|---|
| `surface0` | Lightest — modal/elevated surfaces | `$background` override |
| `surface1` | Base background — primary screen fill | `$backgroundStrong` |
| `surface2` | Sunken — pressed state, card fills, secondary areas | `$color2` |
| `surface3` | Hairlines, dividers, subtle borders | `$color3` |
| `surface4` | Muted borders, disabled fills | `$color4` |

### Layer 2: Text Scale (foreground)

Four stops from primary to faintest.

| Token | Role | Maps to Tamagui |
|---|---|---|
| `text0` | Primary text — headings, body | `$color12` |
| `text1` | Secondary — subtitles, descriptions | `$color11` |
| `text2` | Tertiary — metadata, timestamps, captions | `$color10` |
| `text3` | Faintest — placeholder, disabled text | `$color9` |

### Layer 3: Accent Triad

One brand hue, three variants. This enforces the single-accent-color discipline.

| Token | Role | Usage |
|---|---|---|
| `accentDeep` | Dark variant for text-on-light and pressed states | Links, pressed buttons |
| `accentBase` | Mid variant for interactive elements | Primary buttons, active tab, focus ring |
| `accentSoft` | Light tint for backgrounds and badges | Badge fills, selection highlight, avatar backgrounds |
| `accentOnAccent` | Text color on accent-filled backgrounds | Button label on primary button |

---

## Building a Palette from a Brand Hex

Input: one hex color (the brand's primary color).
Output: full three-layer palette.

### Step 1: Generate the accent triad

Convert the brand hex to HSL.

```
accentBase  = brand hex as-is
accentDeep  = same H, same S, L - 15%  (darken for text/pressed states)
accentSoft  = same H, S - 30%, L + 35% (desaturate + lighten for backgrounds)
accentOnAccent = if accentBase lightness > 55% → use text0; else → use surface0
```

### Step 2: Generate surface scale from accent

For warm palettes (H between 20–60):
```
surface0 = H of accent, S: 10%, L: 98%   (warm near-white)
surface1 = H of accent, S: 12%, L: 96%   (warm cream)
surface2 = H of accent, S: 14%, L: 91%   (warm sunken)
surface3 = H of accent, S: 12%, L: 85%   (warm border)
surface4 = H of accent, S: 10%, L: 75%   (warm muted)
```

For cool palettes (H between 180–280):
```
surface0 = H of accent, S: 5%, L: 98%    (cool near-white)
surface1 = H of accent, S: 6%, L: 97%    (cool gray-white)
surface2 = H of accent, S: 8%, L: 93%    (cool sunken)
surface3 = H of accent, S: 6%, L: 87%    (cool border)
surface4 = H of accent, S: 5%, L: 78%    (cool muted)
```

For neutral palettes (all other H values):
```
surface0 = 0, 0%, 99%   (true near-white)
surface1 = 0, 0%, 97%   (true off-white)
surface2 = 0, 0%, 93%   (true light gray)
surface3 = 0, 0%, 87%   (true mid border)
surface4 = 0, 0%, 78%   (true muted)
```

### Step 3: Generate text scale

Text colors are always near-neutral with a hint of the accent hue.

```
text0 = H of accent, S: 8%,  L: 10%    (primary — near-black with hue tint)
text1 = H of accent, S: 6%,  L: 22%    (secondary)
text2 = H of accent, S: 5%,  L: 40%    (tertiary)
text3 = H of accent, S: 4%,  L: 55%    (faintest)
```

### Example: Brand hex `#A8763E` (ochre)

```
HSL: H=32, S=48%, L=45%

accentBase:     hsl(32, 48%, 45%) → #A8763E
accentDeep:     hsl(32, 48%, 30%) → #8B5E2D
accentSoft:     hsl(32, 18%, 80%) → #E8D9BD
accentOnAccent: L=45% < 55% → use surface0

surface0: hsl(32, 10%, 98%) → #FBF8F2
surface1: hsl(32, 12%, 96%) → #F7F3EC
surface2: hsl(32, 14%, 91%) → #EFE8DA
surface3: hsl(32, 12%, 85%) → #E4DCC9
surface4: hsl(32, 10%, 75%) → #C9BEA3

text0: hsl(32, 8%, 10%)  → #1C1B17
text1: hsl(32, 6%, 22%)  → #3A372F
text2: hsl(32, 5%, 40%)  → #6B6557
text3: hsl(32, 4%, 55%)  → #948C7A
```

This produces the exact Introspect palette — a warm paper-and-ink system from a single brand color.

---

## Semantic Color Desaturation

Tamagui's default `$red10`, `$green10`, `$yellow10` are saturated for maximum visibility. For most apps, desaturate them to sit politely in the palette.

### When to desaturate

| Industry | Desaturation | Reason |
|---|---|---|
| Field / Ops | None (keep full saturation) | Status colors must pop in bright outdoor light |
| Finance | 20% desaturation | Conservative palette, trust signals |
| Healthcare | 15% desaturation | Warm palette, nothing should alarm |
| Education | 10% desaturation | Bright but not aggressive |
| Enterprise / Productivity | 20% desaturation | Professional, understated |
| E-commerce | Standard | Brand colors dominate anyway |
| Editorial / Content | 25% desaturation | Whisper, don't shout |

### How to desaturate in Tamagui

Override the theme color tokens:

```tsx
// tamagui.config.ts — inside themes override
const desaturatedTokens = {
  red10:    '#9B4A3F',  // terracotta (from ~#EF4444)
  green10:  '#5C7A4F',  // moss (from ~#22C55E)
  yellow10: '#B8893A',  // dimmer ochre (from ~#EAB308)
}
```

Apply by spreading into your light and dark theme definitions.

---

## Industry-Default Palettes

Pre-built palette configs. Use these when the user specifies an industry but not a specific brand color.

### Finance

```
Surface base: cool gray (H=220, S=5%)
Accent: blue — hsl(215, 55%, 48%) → #3B6FA0
Status: desaturated 20%
```
- Conservative, trust-building. Blue accent used sparingly for interactive elements only.
- Dark mode: true dark surfaces (not warm), blue accent brightens 15%.

### Healthcare

```
Surface base: warm cream (H=35, S=12%)
Accent: sage/teal — hsl(165, 35%, 42%) → #468C7A
Status: desaturated 15%
```
- Warm, non-clinical. Sage accent feels calming without the institutional blue.
- Dark mode: warm dark surfaces (hsl(35, 8%, 8%)), accent lightens slightly.

### Field / Ops

```
Surface base: neutral gray (H=0, S=0%)
Accent: orange/amber — hsl(28, 80%, 52%) → #D4802A
Status: full saturation
```
- High contrast for outdoor readability. Orange accent is highly visible.
- Dark mode: OLED-friendly (#000000 base option), accent stays bright.

### Education

```
Surface base: near-white (H=0, S=0%)
Accent: bright blue — hsl(220, 70%, 55%) → #4A7FD9
Status: desaturated 10%
```
- Clean, bright, energetic. Blue accent works for interactive and gamification elements.
- Dark mode: slightly warm dark (#121215), accent brightens.

### Productivity

```
Surface base: cool neutral (H=220, S=3%)
Accent: minimal blue — hsl(215, 45%, 52%) → #4A7AAE
Status: desaturated 20%
```
- Near-monochrome. Accent used at strict 10% ratio. Dense layouts need minimal color distraction.
- Dark mode: true neutral dark (#121212), accent barely shifts.

### E-commerce / Consumer

```
Surface base: true white (H=0, S=0%)
Accent: brand-dependent (use brand hex process above)
Status: standard saturation
```
- Brand color drives everything. Surface stays neutral so product imagery pops.
- Dark mode: brand accent is the star, surfaces are pure dark.

---

## Dark Mode Inversion Rules

Dark mode is not a raw theme swap. It is a designed inversion.

### Surface inversion

| Light | Dark | Rule |
|---|---|---|
| surface0 (lightest) | `hsl(H, S-5%, 5-7%)` | Darkest — main background |
| surface1 | `hsl(H, S-3%, 8-10%)` | Slightly lighter |
| surface2 | `hsl(H, S-2%, 12-14%)` | Card/elevated surfaces |
| surface3 | `hsl(H, S-2%, 18-20%)` | Borders (lighter than light mode) |
| surface4 | `hsl(H, S-1%, 25-28%)` | Strong borders, disabled |

**Never use pure `#000000`** unless the plan explicitly requests OLED mode. Default dark base should be `#0A0A0A` to `#121212`.

### Text inversion

| Light | Dark | Rule |
|---|---|---|
| text0 (darkest, L~10%) | `hsl(H, S-4%, 88-92%)` | Cream/warm white, not pure #FFF |
| text1 (L~22%) | `hsl(H, S-3%, 78-82%)` | Slightly dimmer |
| text2 (L~40%) | `hsl(H, S-2%, 55-60%)` | Metadata stays muted |
| text3 (L~55%) | `hsl(H, S-1%, 40-44%)` | Faintest stays faint |

### Accent inversion

- `accentBase`: increase lightness by 10-15% for contrast on dark surfaces
- `accentDeep`: increase lightness by 8-10%
- `accentSoft`: decrease lightness by 50-60% (becomes a dark tint, not a light wash)

### Shadows in dark mode

**No shadows.** Replace with surface elevation:
- Cards use `surface2` background on `surface0` base (one step lighter = elevation)
- Add hairline top border: `borderTopWidth={0.5}` with `borderColor="$color4"`

### Concrete Tamagui override

```tsx
// tamagui.config.ts
const config = createTamagui({
  ...defaultConfig,
  themes: {
    ...defaultConfig.themes,
    dark: {
      ...defaultConfig.themes.dark,
      background: '#0E0D0B',        // surface0 dark
      backgroundStrong: '#14130F',   // surface1 dark
      color2: '#1E1C18',            // surface2 dark (cards)
      color3: '#2D2A22',            // surface3 dark (borders)
      color4: '#3A372F',            // surface4 dark
      color12: '#F2EAD8',           // text0 dark (cream, not white)
      color11: '#D4CCB8',           // text1 dark
      color10: '#948C7A',           // text2 dark
      color9: '#6B6557',            // text3 dark
    },
  },
})
```

---

## Integration

- **`design-planning.md` Step 1c** decides whether to use a custom palette and which industry default to start from
- **`tamagui-custom-tokens.md`** covers the mechanics of wiring tokens into `tamagui.config.ts` — refer to that file for the full config setup
- **`tamagui-component-recipes.md`** "Named palette tokens" recipe provides the copy-paste implementation block
