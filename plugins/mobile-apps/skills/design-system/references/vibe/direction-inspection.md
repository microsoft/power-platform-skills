# Direction: Inspection

For field, ops, and outdoor apps. Built so a technician with gloves on, in sunlight, can find what they need at a glance and tap large targets without precision.

## Reference apps

Uber Driver, Lyft Driver, ServiceTitan, Procore, Field Service Lightning, Square for Restaurants, Toast POS, Domino's Driver

## Gestalt

> "Glance first, tap second. Status carries meaning. Outdoor-readable. No decoration that distracts from the job."

## Bundle

```yaml
direction: inspection
surface: strong-cards
background: dark-slate
palette: slate + safety-orange
typography: sans-only
heading_font: Inter
body_font: Inter
body_size_min: 16pt
list_style: card-with-status-stripe
density: comfortable-to-dense
motion: none
status_saturation: full
empty_state: icon-sentence-bigbutton
primary_action_shape: rectangular-bottom-pinned
primary_action_min_height: 56pt
accent_color: safety-orange (#FF6A00)
secondary_accents: signal-green (#16A34A), warning-amber (#F59E0B), error-red (#DC2626)
tone: direct
```

## Visual rules

### Surface
- **Background:** dark slate (`#0f172a` or `#1e293b`) for outdoor contrast OR off-white (`#fafafa`) if the user explicitly requests light
- **Cards:** raised on background with a 4px **left status stripe** (color = status meaning)
- **No shadows** — they wash out in sunlight; use surface contrast (one step lighter) for elevation
- **Card spacing:** `gap="$3"` (~12pt) — tight enough to fit 6+ items above the fold

### Palette
- **Base:** slate range (`#0f172a` → `#94a3b8` → `#f8fafc`)
- **Primary accent:** safety orange `#FF6A00` (visible at 1m in sun)
- **Status colors (fully saturated, kept on pills + stripes only):**
  - Open / Pending: amber `#F59E0B`
  - In progress: blue `#3B82F6`
  - Done: green `#16A34A`
  - Overdue / Critical: red `#DC2626`
- **No decorative colors.** Every color carries meaning.

### Typography
- **Family:** Inter only (or Roboto on Android-first apps) — never serifs, never display fonts
- **Sizes:** body min 16pt, titles 20–28pt, page titles 32pt
- **Weight:** 400 body, 600 titles, 700 page headers, 600 numerals (data)
- **Line-height:** 1.5 body (readable in motion), 1.2 titles
- **Numerals:** tabular for IDs, timestamps, counts (`fontVariant: ['tabular-nums']`)
- **No italics** — hard to read in sun

### List rows
- **Card with status stripe:**
  ```tsx
  <Card flexDirection="row" overflow="hidden">
    <YStack w={4} bg={statusColor(item.status)} />
    <YStack flex={1} p="$4" gap="$2">
      <XStack jc="space-between" ai="center">
        <Text fontWeight="700" fontSize="$5">{item.title}</Text>
        <StatusPill status={item.status} />
      </XStack>
      <Text color="$color10">{item.meta}</Text>
    </YStack>
  </Card>
  ```
- 4px left bar = the most important affordance (color-coded status)
- Title left, status pill right, meta on second line
- Tap target: entire card, 64pt+ tall

### Empty state
- Big Ionicon (size 56) at top
- One-line explanation in 17pt
- Big primary action button below (full-width or near-full)
- Example: `<Ionicons name="clipboard-outline" size={56} color="$color10" />` + "No jobs assigned today" + `<Button bg="$blue10" color="$color1" size="$5">Refresh</Button>`

### Error state
- Inline above retry button (never `Alert.alert()`)
- Copy: `"Couldn't load jobs. Pull down to retry."` — direct, not apologetic

### Loading
- Solid skeleton blocks matching card shape (NOT shimmer — too distracting outdoors)
- 3–5 cards visible

### Primary action
- Bottom-pinned (above safe-area inset)
- Min 56pt tall, full-width with horizontal `$4` padding
- Color: safety orange (`#FF6A00`) on dark bg, or accent fill on light bg
- Label: action verb + object — `"Start inspection"`, `"Mark complete"`, `"Skip job"` — never `"Submit"` / `"OK"`

### Motion
- **None.** No fade-in, no stagger, no parallax. Cards appear instantly.
- One exception: `pressStyle={{ scale: 0.98 }}` on tappable cards (subtle press feedback)

### Status pills
- Saturated background, white text:
  ```tsx
  <YStack bg="#FF6A00" px="$2" py="$1" br="$2">
    <Text color="white" fontSize="$2" fontWeight="700">URGENT</Text>
  </YStack>
  ```
- ALL CAPS, weight 700, sized for readability at arm's length

### Tone
- **Direct, not polite:** `"Skip"` not `"Skip this one"`, `"Done"` not `"Mark as completed"`
- **No jargon:** `"3 jobs left"` not `"3 records pending"`
- **Errors are statements of fact:** `"No connection"` not `"We're sorry, your connection appears to have been lost"`

## When this fits well

- 50+ items per shift to triage
- Hands-busy operators
- Time-pressured workflows (every screen has a clear next action)
- Outdoor or moving-vehicle use
- Status changes are the primary user action

## When this misfits

- Consumer-facing (looks alarming with all the saturated colors)
- Long-form content (line height too tight for paragraphs)
- Low-frequency interactions (the urgency feels overwrought)
- Quiet contemplative tools (this is not a meditation app)
