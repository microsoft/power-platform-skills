# Direction: Product

For consumer-grade apps and premium employee experience. Type-led, warm or rich-dark, single muted accent, asymmetric layouts. Looks like an app you'd download by choice.

## Reference apps

Linear, Notion (consumer side), Spotify, Airbnb, Headspace, Robinhood, Apple Music, Vercel mobile, Mercury, Substack reader

## Gestalt

> "Type and space carry the design. One memorable accent. Restrained motion. The app earns attention by looking earned, not by demanding it."

## Bundle

```yaml
direction: product
surface: editorial
background: warm-cream-or-rich-dark
palette: cream + sage    # or: dark + rust / cream + coral / dark + electric-blue
typography: display-headings + sans-body
heading_font: Fraunces   # or Lora, Söhne, Inter Display
body_font: Inter
body_size: 16pt
heading_letter_spacing: -0.02em
list_style: sentence
density: sparse
motion: liberal-tasteful
status_saturation: monochrome-plus-accent
empty_state: type-led
primary_action_shape: pill
primary_action_position: in-flow-or-bottom-center
accent_color: sage (#7d9b76)   # or rust #b85c38, coral #e87a64, electric blue #5b6bff
tone: conversational
```

## Visual rules

### Surface
- **Background:**
  - **Light variant:** warm cream (`#faf8f5` or `#f8f5ef`) — never pure white
  - **Dark variant:** rich warm dark (`#1a1614` or `#1f1b1a`) — never pure black
- **Cards:** flat — no border, no shadow. Elevation comes from background contrast (one step lighter/darker fill).
- **Sections:** full-bleed (edge-to-edge images, hero blocks). Asymmetric layouts encouraged — content can be off-center.
- **Spacing:** `gap="$8"` to `gap="$10"` between major sections (sparse rhythm)

### Palette
- **Light variant base:** cream (`#faf8f5`) → warm gray (`#a8a29e`) → near-black (`#292524`)
- **Dark variant base:** rich dark (`#1a1614`) → warm gray (`#a8a29e`) → cream (`#faf8f5`)
- **Single accent (pick ONE):**
  - Sage `#7d9b76` (calm, organic)
  - Rust / terracotta `#b85c38` (warm, earthy)
  - Coral `#e87a64` (friendly, energetic)
  - Electric blue `#5b6bff` (modern, technical)
- **Accent usage:** primary action, hero element on landing screen, single highlight per screen. NOT pills, NOT icons, NOT borders.
- **Status colors:** **monochrome plus accent.** Pills use grayscale background with the accent color or a single muted hue:
  ```tsx
  <YStack bg="$color2" px="$3" py="$1" br="$10">
    <Text col="$color11" fontSize="$2" fontWeight="500">In progress</Text>
  </YStack>
  ```
  Critical-only badges may use a muted red, but everything else stays grayscale.

### Typography
- **Heading font:** Fraunces, Lora, Söhne, or Inter Display — distinct from body, more personality
- **Body font:** Inter or system sans
- **Sizes:** body 16pt, secondary 14pt, titles 22–32pt, page titles 36–48pt
- **Tracking:** `-0.02em` on titles ≥ 24pt (negative tracking — modern feel)
- **Weights:** 400 body, 500 medium, 600 titles. Avoid 700/800 on display fonts.
- **Italics:** allowed for system messages, captions, attribution. Used sparingly.
- **Line-height:** 1.7 body (reading-comfort), 1.1–1.2 titles (tight, magazine-like)

### List rows
- **Sentence style** (Linear / Claude inbox feel):
  ```tsx
  <YStack gap="$1" py="$3">
    <Text fontSize="$5" fontWeight="500">{item.title}</Text>
    <Text fontSize="$3" color="$color10" numberOfLines={1}>
      {item.meta}
    </Text>
  </YStack>
  ```
- **No icon, no avatar, no chevron, no badge** unless a badge is genuinely meaningful (overdue, requires-attention)
- Title is the only thing your eye lands on; meta is one quiet grey line below
- No separator between rows — the line break IS the separator. (Optional ultra-thin `borderBottomWidth={0.5} borderBottomColor="$color3"` if the list is very long.)
- Tap target: entire row block, generous vertical padding (`py="$4"` or more)

### Empty state
- **Type-led, no icon required:**
  ```tsx
  <YStack alignItems="flex-start" gap="$3" px="$5" py="$10">
    <Text fontSize="$8" fontWeight="500" letterSpacing={-0.5}>
      Nothing here yet.
    </Text>
    <Text fontSize="$5" color="$color10" lineHeight="$6">
      Your first inspection will show up once you save it.
    </Text>
    <Button bg="$blue10" color="$color1" mt="$3">Start one</Button>
  </YStack>
  ```
- Big quiet headline + supporting sentence + accent button
- Optional small icon allowed if the screen genuinely needs one for context — never required

### Error state
- Inline, type-led, no icon:
  > "Couldn't load this. Pull down to try again."
- Tone is matter-of-fact and short

### Loading
- **Type-shaped skeleton lines** (not shimmer cards):
  - A long grey line where the title would be
  - A shorter grey line where the meta would be
  - Match the populated layout exactly
- 3 such pairs is enough — avoid filling the whole screen with skeletons

### Primary action
- **Shape:** pill (`borderRadius="$10"` or fully rounded — `borderRadius: 999`)
- **Position:** in-flow on detail/form screens (after content, full-width with horizontal padding); bottom-center floating on landing screens
- **Color:** accent fill on neutral text, OR cream-fill-on-dark for dark variant
- **Label:** conversational verb + object — `"Save inspection"`, `"Create project"`, `"Send to review"`. Often slightly longer than SaaS — extra word for warmth.

### Motion
- **Liberal but tasteful:**
  - `FadeInUp` stagger on list items (max 5 staggered, rest instant) — `delay(index * 40)`
  - Smooth height transitions on inline-disclosure (Reanimated `LayoutAnimation` or `<AnimatePresence>`)
  - Hero parallax on detail screens (scroll-driven `interpolate`)
  - `pressStyle={{ scale: 0.97 }}` on tappable items
- **Avoid:** bounce, spring with overshoot, decorative loops
- **Page enter:** `FadeIn` with 250ms duration

### Status / badges
- Grayscale base + optional accent fill for one critical state per screen
- Lower-case sentence-case (not ALL CAPS), weight 500, fontSize 11–12pt
- Pills are pill-shaped (full radius) not rectangles

### Imagery
- Full-bleed photos allowed and encouraged on hero sections
- Avatars: circle, generous size (40pt+), or use initials with warm muted background
- Icons: thin-stroke (Ionicons outline variants — `*-outline` family), used sparingly. NEVER as decoration.

### Tone
- **Conversational, never corporate:** `"What do you want to track?"` not `"Enter project name"`
- **Sentences, not labels:** form fields can have sentence-style placeholders
- **No exclamations, no emojis** (unless the brand explicitly is playful)
- **Errors are matter-of-fact and short:** `"Couldn't save."` not `"There was an error processing your request"`
- **Empty states feel inviting, not blank:** `"Nothing here yet."` + `"Your first one will show up after you save it."`

## When this fits well

- Consumer-facing apps
- Premium employee experience (HR onboarding, learning, wellness, internal communications)
- Executive dashboards that need to feel "designed"
- Read-heavy content apps (knowledge base, internal documentation, news)
- Apps where retention and engagement matter
- Brand-led / marketing-adjacent apps

## When this misfits

- Outdoor / field use (low contrast, small accents disappear in sun)
- Data-dense workflows (sparse rhythm wastes screen real estate)
- Compliance / approval workflows (the warmth feels wrong for serious processes)
- Time-pressured operations (decoration slows decision-making)
- Apps where users value efficiency over experience (the design feels precious)
