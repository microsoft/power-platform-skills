# Direction: Airline

Commercial-aviation brand language. Deep navy + crisp white surfaces + high-visibility status — the look of carrier mobile apps (Delta, United, Lufthansa, ANA) and ground-operations tools that read as both branded and operationally serious.

## Reference apps

Delta, United, American Airlines, Lufthansa, ANA, British Airways apps; airline crew and ground-ops apps; Boeing/Airbus operator portals.

## Gestalt

> "Confident, calm, signal-rich. Navy carries the brand; status colors stay loud so the eye finds what's wrong in <1s. No decorative chrome — the photo of the aircraft or the live status IS the chrome."

## Bundle

```yaml
direction: airline
surface: clean-light
background: white
palette: deep-aviation-blue + cool-gray
typography: sans-only
heading_font: Inter
body_font: Inter
body_size: 15pt
list_style: row-with-chevron
density: comfortable
motion: subtle
status_saturation: hi-vis
empty_state: icon-explanation-action
primary_action_shape: rectangular
primary_action_position: bottom-pinned-or-in-flow
accent_color: deep-aviation-blue (#0A4F8F)
tone: branded-operational
```

## Visual rules

### Surface

- **Background:** white (`#FFFFFF`) — the canonical airline-brand canvas, not cool-gray.
- **Surface ladder (explicit aliases — builders rely on these existing):**
  - `surface0`: `#FFFFFF` — page background
  - `surface1`: `#F4F6F9` — card fill
  - `surface2`: `#E6EAF0` — input fill / muted card
  - `surface3`: `#C9D0DA` — hairline / divider
- **Cards:** `surface1` fill on `surface0` background. 1px hairline `surface3` border. No shadow ring on light surfaces.

### Palette

- **Primary accent:** deep aviation blue `#0A4F8F`
- **Primary strong:** `#073968` (pressed state, dark surfaces)
- **Soft accent:** `#D6E4F2` (selected row bg, soft tint)
- **Accent usage:** primary buttons, active tab indicator, link text, primary stripe on detail headers.
- **Status colors (HI-VIS — saturated, never desaturated for airline ops):**
  - `statusCritical`: `#D23A3A` on `#FBE5E5` soft / `#7A1F1F` text
  - `statusModerate`: `#CA5010` on `#FBEAD9` soft / `#7A3700` text
  - `statusOk`: `#107C10` on `#E0F0E0` soft / `#0B4D0B` text
- **Why hi-vis:** ground-ops users glance at the screen for 1-2s in a noisy, time-pressured context. Pastel pills lose readability under those conditions; saturated pills don't.

### Typography

- **Family:** Inter (system fallback OK).
- **Heading sizes:** Display 28/700, H1 22/600, H2 18/600.
- **Body:** 15pt (slightly larger than saas default 14pt) for readability through cabin/glove/sun glare.
- **Numerals:** tabular-nums on flight times, gate numbers, durations — never proportional.

### List rows

- 56pt minimum height (touch-friendly on small devices).
- Primary line: 16/600 — flight number / record id.
- Secondary line: 14/400 — origin → destination, gate, or status detail.
- Trailing: status pill OR chevron — never both.

### Status pills

- Saturated bg keyed to status, white text (or alert-text on amber): `bg="statusCritical" col="white"`.
- Pill shape: 4-6px radius, padding `px="$2" py="$1"`.
- Always paired with an icon for accessibility (color-blind users).

### Cards / detail screens

- Header: aircraft hero image OR a 4px left status stripe on the top card (`bg="$accent"` — deep navy).
- Section dividers: 8pt vertical gap + 1px `surface3` line.

### Empty state

- Centered icon (24pt), one-line headline (16/600), one-line explanation (14/400 muted), single primary action (`bg="$accent" col="$surface0"`, 56pt height, full-width).

### Error state

- Same as empty but headline is `col="$statusCriticalText"` and icon is alert.

### Loading

- Skeleton rows in `surface2` fill, no animation more elaborate than a 1.2s gentle pulse.

## Motion

- `subtle` — FadeInDown on row enter, no decorative stagger.
- No card pressed lift on touch (touch ≠ pointer).
- Sheet transitions: 200ms ease-out.
- No spring physics on numeric counters or list reorders.

## Negatives — HARD RULES (screen-builder enforces)

- **NEVER** use safety-orange (`#FF6A00`) or any orange hue as primary or accent. Reserved for `statusModerate` only.
- **NEVER** use cool-gray as page background — always pure white. Carriers brand with white-and-navy, not gray-and-indigo.
- **NEVER** desaturate status pills. Hi-vis only.
- **NEVER** use shadow rings on cards on a white surface. Hairline borders only.
- **NEVER** use stack-only navigation when there are 3+ persistent contexts (Home / Schedule / Profile etc.) — use bottom tabs.
- **NEVER** put a primary action above the fold or inside a card; primary action is bottom-pinned (mobile) or top-right (tablet).

## Tamagui config snippet (canonical token bundle for `brand/tokens.ts`)

```ts
const brand = {
  primary:       '#0A4F8F', // deep aviation blue
  primaryStrong: '#073968',
  alert:         '#D23A3A', // critical
  warn:          '#CA5010', // moderate
  ok:            '#107C10', // resolved
  warnText:      '#7A3700',
  alertText:     '#7A1F1F',
  okText:        '#0B4D0B',
};

const tokens = {
  color: {
    surface0: '#FFFFFF',
    surface1: '#F4F6F9',
    surface2: '#E6EAF0',
    surface3: '#C9D0DA',
    accent:        brand.primary,
    accentStrong:  brand.primaryStrong,
    accentSoft:    '#D6E4F2',
    statusCritical:    brand.alert,
    statusCriticalSoft:'#FBE5E5',
    statusCriticalText:brand.alertText,
    statusModerate:    brand.warn,
    statusModerateSoft:'#FBEAD9',
    statusModerateText:brand.warnText,
    statusOk:          brand.ok,
    statusOkSoft:      '#E0F0E0',
    statusOkText:      brand.okText,
  },
};
```

## When to use this direction

- App brief includes any of: `airline`, `aviation`, `flight`, `aircraft`, `carrier`, `pilot`, `cabin crew`, `boarding`, `departure`, `tarmac`, `turnaround`, `ground ops`.
- App audience is commercial-aviation operators, ground crew, pilots, cabin crew, or airline back-office staff.
- App brand should read as carrier-affiliated rather than generic field-ops or generic SaaS.

## When NOT to use this direction

- Defense / military aviation (different palette — earth tones or cammo-inspired).
- General-aviation hobbyist apps (community-feel, less corporate).
- Drone or UAV ops apps (different operational context — use `field-ops` or a custom direction).

For those, use `signature` (slate + safety-orange) or a custom direction file.
