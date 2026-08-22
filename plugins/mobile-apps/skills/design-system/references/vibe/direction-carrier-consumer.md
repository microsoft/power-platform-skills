# Direction: Carrier Consumer

Passenger-facing airline commerce: crisp carrier confidence with product-first
merchandising. It is for browsing, comparing, reserving, and buying products in
an airline context, not for running a turnaround or triaging operational risk.

## Reference Apps

Modern carrier booking apps, airport retail storefronts, premium travel
commerce, and compact mobile product catalogues.

## Gestalt

> Calm travel context around vivid, inspectable products. The merchandise is
> the visual anchor; flight context supports the decision without competing
> with it.

## Bundle

```yaml
direction: carrier-consumer
surface: editorial-commerce
background: crisp-light
palette: aviation-ink + coral + sea-glass
typography: display-sans + utility-sans
heading_font: DM Sans
body_font: Inter
body_size: 15pt
list_style: product-card-row
density: comfortable
motion: subtle-purposeful
status_saturation: semantic-soft
empty_state: product-led-explanation-action
primary_action_shape: rectangular-soft
primary_action_position: in-flow-or-bottom-pinned
accent_color: cabin-coral (#C43D4F)
tone: concise-premium
```

## Visual Rules

### Surface

- `surface0`: `#FFFFFF` page background.
- `surface1`: `#F2F7FA` travel-context band and product-card fill.
- `surface2`: `#E3EEF3` selected and loading states.
- `surface3`: `#C5D5DD` separators.
- Use full-width page bands and unframed sections. Cards belong only to repeated
  products; do not wrap the whole catalogue or hero in a card.

### Palette

- `ink`: `#10283B`; `inkMuted`: `#405A68`.
- Primary commerce accent: cabin coral `#C43D4F`; pressed `#982E3C`; soft
  `#F8E5E8`; on-accent `#FFFFFF`.
- Context accent: sea glass `#167C80`, used for flight availability and service
  facts, never as a second primary command color.
- Status tones remain semantic and soft. Inventory warnings use dark amber text
  on pale amber, not white on orange.

### Typography

- DM Sans headings, Inter body, with system fallbacks and Arabic glyph coverage.
- Product name: 24/32, 600. Price: 22/28, 700 with tabular numerals. Supporting
  facts: 14/20, 400.
- Global letter spacing is 0. Never uppercase product categories or status.

### Product Imagery

- The first viewport shows the actual hero product image from seed/record data.
- One image uses `featured-product-card`; 2-4 use `product-card-row`; 5-12 use
  `product-card-grid`; larger catalogues use `product-list-search`.
- Use fixed aspect ratios and `contentFit="contain"` when product inspection is
  important. Never replace product evidence with an atmospheric aircraft photo.

### Product Rows And Cards

- Show product name, price, availability, and one differentiating attribute in a
  fixed order. Do not duplicate the name in a section heading.
- Use 8px radius, quiet fill contrast, and no nested cards.
- A browse row can lead with image; a checkout row can lead with quantity and
  price. Route context such as flight number stays in a compact page band.

### Actions

- One brand-filled command per screen: Add to order, Reserve onboard, or Buy.
- Secondary quantity, save, and compare controls are outlined or chromeless.
- Checkout actions may pin above safe area; catalogue actions remain in flow.

### Motion

- 160-220ms product-image and cart-state transitions.
- No decorative auto-advance, parallax, or animated aircraft motifs.
- Preserve carousel and scroll position when returning from product detail.

## Negatives

- Never use high-visibility operations stripes as product decoration.
- Never use safety orange as the brand accent.
- Never let flight status dominate product title, price, or image.
- Never use generic stock travel photography when product imagery is available.
- Never hide price or availability behind a tap.
- Never render more than one filled full-width primary action.

## Canonical Tokens

```ts
const tokens = {
  color: {
    surface0: '#FFFFFF',
    surface1: '#F2F7FA',
    surface2: '#E3EEF3',
    surface3: '#C5D5DD',
    ink: '#10283B',
    inkMuted: '#405A68',
    accentBase: '#C43D4F',
    accentDeep: '#982E3C',
    accentSoft: '#F8E5E8',
    accentOn: '#FFFFFF',
    context: '#167C80',
  },
};
```

## When To Use

- Passenger-facing onboard or airport retail.
- Airline product catalogues, duty-free ordering, travel accessories, beauty,
  watches, food, upgrades, or loyalty commerce.
- Briefs combining aviation context with buying, browsing, reserving, product,
  catalogue, or merchandise language.

## When Not To Use

- Crew task lists, safety checks, turnaround, maintenance, tarmac, dispatch, or
  flight operations: use `airline`.
- General consumer retail with no carrier context: use `product`.
- Outdoor inspection and rugged field work: use `inspection`.
