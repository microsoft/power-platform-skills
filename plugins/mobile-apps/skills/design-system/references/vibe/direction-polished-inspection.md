# Direction: Polished Inspection

**The MVP-first-run default for inspection / field-ops / asset-tracking apps.** Light surface, restrained Power-Platform green brand, status-loud pills, large tap targets. Demo-friendly polish without sacrificing field-ops ergonomics.

> Use this when the app needs to look "modern enterprise SaaS" in a demo room AND remain genuinely usable by an inspector with gloves. If the user wants outdoor-only dark + safety-orange (true field-utility look), pass `--direction inspection` to opt into that instead.

## Reference apps

Microsoft Dynamics 365 Field Service mobile, Salesforce Field Service, ServiceTitan (light theme), the equipment-inspector Power Apps template (`pa-wrap-tools-1/templates/equipment-inspector`), Procore (light), Notion enterprise

## Gestalt

> "Polished, type-confident, status-loud. Reads modern enterprise app in a demo room AND a warehouse. Field-ops bones, SaaS skin."

## Bundle

```yaml
direction: polished-inspection
surface: white-cards-on-cool-gray-canvas
background: light-default (system light/dark, light is default)
palette: cool-gray + power-platform-green
typography: sans-only
heading_font: Inter
body_font: Inter
body_size_min: 16pt
list_style: card-with-status-stripe
density: comfortable
motion: functional-only (skeleton + press + screen-enter)
status_saturation: full (kept on pills + stripes only)
status_pill_style: soft-tint-bg-with-full-hue-text
empty_state: icon-sentence-bigbutton
primary_action_shape: bottom-right-FAB-OR-rectangular-bottom-pinned
primary_action_min_height: 56pt
accent_color: power-platform-green (#007d48)
secondary_accents: none — no decorative colors
status_palette:
  overdue:    "#d30005"    # source: equipment-inspector "Out of Service"
  in_progress: "#0078d4"    # added — Microsoft Azure blue (WCAG AA on white)
  open:        "#b45309"    # added — warm amber (WCAG AA on white)
  closed:      "#007d48"    # source: equipment-inspector "Active"
tone: professional-utilitarian
```

## Provenance

- **Brand color `#007d48`** — pulled directly from `pa-wrap-tools-1/templates/equipment-inspector/src/components/EquipmentRow.tsx` line 7 ("Active — success green"). Identical to / adjacent to Microsoft Power Platform green family. Production-validated.
- **Danger color `#d30005`** — same source, line 9 ("Out of Service — danger red"). Production-validated.
- **Muted text `#707072`** — same source, line 8 ("Retired — muted").
- **Icon-only `#9e9ea0`** — same source, line 70 (chevron-forward color).
- **In-progress `#0078d4`** — added (source has no blue). Microsoft Azure blue (`btn-primary` standard). Passes WCAG AA against white (4.83:1).
- **Open `#b45309`** — added (source has no amber). Warm amber. Passes WCAG AA against white (4.93:1).

## Visual rules

### Surface
- **Background:** light by default (`#ffffff` page, `#f9fafb` canvas behind cards)
- **Theme:** system light/dark — light is the demo default
- **Cards:** `#ffffff` with 1px hairline border (`#e2e8f0`) AND a 4px **left status stripe** (color = status meaning)
- **Shadow:** single tier, very subtle — `shadowOpacity: 0.04, shadowRadius: 8` for raised cards. NO heavy drop shadows
- **Card spacing:** `gap="$3"` (~12pt) between cards — comfortable, not crammed

### Palette
- **Brand primary:** Power-Platform green `#007d48` — used ONLY for: primary CTA fill, FAB, active tab indicator, active tab text, links. Sparse usage (max 3-4 spots per screen)
- **Text:** `#0f172a` ink (NEVER pure black per Airbnb-influenced restraint), `#707072` muted body, `#9e9ea0` icons-only (fails AA at text size — hook will block text use)
- **Status colors (full saturation, kept on pills + stripes only):**
  - Overdue / Critical: `#d30005`
  - In progress: `#0078d4`
  - Open / Pending: `#b45309`
  - Done / Closed: `#007d48`
- **No decorative colors.** Every color carries meaning.

### Typography
- **Family:** Inter (default Tamagui font) — never serifs, never display fonts
- **Sizes:** body min 16pt, titles 18-22pt, page titles 28pt (modest weights — Airbnb-influenced restraint, NOT 36-52pt billboard sizes)
- **Weight:** 400 body, 600 titles, 700 page headers
- **Line-height:** 1.5 body, 1.25 titles
- **Numerals:** tabular for IDs, timestamps, counts (`fontFamily="$mono"` per source `EquipmentRow.tsx` line 65)
- **Status case:** sentence case ("Overdue", "In progress") — NOT UPPERCASE (less aggressive, more enterprise)

### List rows (card-with-status-stripe)

Source pattern from `EquipmentRow.tsx`:

```tsx
<Card flexDirection="row" overflow="hidden" borderWidth={1} borderColor="$borderColor">
  <YStack w={4} bg={statusColor(item.status)} />
  <YStack flex={1} p="$4" gap="$2">
    <XStack jc="space-between" ai="center">
      <Text fontSize="$5" fontWeight="600" col="$color12" flex={1}>{item.title}</Text>
      <StatusPill status={item.status} />
    </XStack>
    <Text fontSize="$3" col="$color10">{item.meta}</Text>
  </YStack>
</Card>
```

- 4px left bar = status hue (color-coded)
- Title left, status pill right, meta on second line
- Tap target: entire card, 64pt+ tall
- Mono font (`fontFamily="$mono"`) for serial numbers / IDs / timestamps

### Status pills (soft-tinted)

```tsx
<YStack bg={statusBg(item.status)} px="$2" py="$1" br="$10">
  <Text col={statusFg(item.status)} fontSize="$2" fontWeight="600">{label}</Text>
</YStack>
```

Where `statusBg` returns hue at ~10-15% alpha (`#fbe5e6` for red, `#e6f0fa` for blue, `#fef3c7` for amber, `#e0f2e8` for green) and `statusFg` returns the full hue. Sentence case label, weight 600. NEVER UPPERCASE.

### Primary action
- Bottom-right FAB (56pt circle) for single obvious create action — Power-Platform green fill, soft shadow
- OR rectangular bottom-pinned button (full-width, 56pt tall) for confirmation flows
- Color: `#007d48` on light bg
- Label: action verb + object — `"+ New inspection"`, `"Mark complete"`, `"Save & next"` — never `"Submit"` / `"OK"`

### Empty state
- Medium Ionicon (size 48) at top
- One-line explanation in 16pt
- Big primary action button below (bottom-aligned or near it)
- Sentence-case copy: `"No inspections yet"` not `"NO RECORDS FOUND"`

### Loading
- Solid skeleton blocks matching card shape (NOT shimmer — distracting)
- 3-5 cards visible

### Motion
- **Functional-only:** skeleton-while-loading, press feedback (`pressStyle={{ scale: 0.98 }}`), screen-enter (200ms fade-in)
- No parallax, no celebration, no list stagger

### Tone
- **Professional, sentence-case:** `"Overdue"` not `"OVERDUE"`, `"In progress"` not `"IN PROGRESS"`
- **No exclamation marks**: `"Inspection saved"` not `"Inspection saved!"`
- **Errors are statements, not apologies:** `"Couldn't sync. Tap to retry."` not `"We're sorry, your sync didn't go through."`

## Hard rules (encoded so screen-builders don't drift)

These are documented here for clarity, but the plugin's existing PostToolUse validators (`hooks/validate-color-contrast.js`, `hooks/validate-screen-quality.js`) enforce them automatically across every direction. The new preset inherits them for free.

| # | Rule | Enforced by |
|---|---|---|
| 1 | `#9e9ea0` MUST NOT be used for text smaller than 18pt — only icons, dividers, dot separators | `validate-color-contrast.js` |
| 2 | All status meaning MUST be carried by 2+ channels: color hue + text label, OR color hue + 4px stripe + text label. Never status-by-color-alone | `validate-screen-quality.js` |
| 3 | Brand `#007d48` is the ONLY brand accent. Status hues live in pills + stripes ONLY, never on chrome (FAB stays green, tab indicator stays green) | `validate-screen-quality.js` (palette warmth) |
| 4 | Status pills MUST be soft-tinted (bg = hue at ~10% alpha, text = full hue) — never solid saturated fills | `validate-screen-quality.js` (status pill style) |
| 5 | Touch targets ≥ 52pt (cards 64pt, FAB 56pt, buttons 48pt minimum) | `mobile-design-philosophy.md` Section 12 |

## When this fits well

- Power Apps / Dynamics 365 / Microsoft-stack inspection apps
- Field-ops apps where the demo audience is enterprise IT / stakeholders (not field workers)
- Apps that need to look polished out-of-the-box for first-run impressions
- Inspection / asset-tracking / equipment apps with status-driven workflows
- ~70% of mobile-app traffic (the new MVP default)

## When this misfits

- True outdoor-only field apps (full sun, full shift) → use `--direction inspection` (dark slate + safety orange)
- Consumer-facing marketplaces with photo content → use `--direction product` or a brand-specific spec
- Long-form content / reading apps → use `--direction product` (editorial typography)
- Apps that need celebration / playful motion → use `--direction product`
- Aviation / airline apps → carve-out exists, use `--direction airline` (FlightCheck preset)
