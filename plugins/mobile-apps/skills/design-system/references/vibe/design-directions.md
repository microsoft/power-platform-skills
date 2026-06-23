# Design Directions — overview

Three named gestalts the internal `/design-system` style picker uses. Each is a bundle of ~12 design tokens chosen to maximise contrast against the other two so the user can decide at a glance.

## Why three?

- **Two** isn't a choice — it's a forced binary
- **Six** is decision paralysis — people decide worse with more options
- **Three** gives genuine choice without overwhelm and matches the "Goldilocks" intuition the brain is wired for

The three are intentionally far apart in look, not "shades of beige". If the user picks one, they're picking a clear identity, not a nuance.

## The three directions

### 1. Inspection
**Reference apps:** Uber Driver, Lyft Driver, ServiceTitan, Procore, Field Service Lightning, Square for Restaurants

For someone outside, in gloves, in sunlight, with one hand on a clipboard. Glance-first, tap-second. High contrast, fully saturated status colors, big touch targets, no decorative motion (jitters in moving vehicles).

**Pick when:** field operations, work orders, deliveries, audits, dispatch, inspections, anything outdoor or hands-busy.

→ [direction-inspection.md](./direction-inspection.md)

### 2. SaaS
**Reference apps:** Microsoft Teams mobile, Asana, Slack, Salesforce mobile, Notion (the trustworthy default), GitHub mobile

The look people inside an org expect. Familiar, professional, doesn't surprise. Cool gray base + one brand color, hairline-bordered cards, row-with-chevron lists, subtle motion. The "safe and trusted" pick.

**Pick when:** internal tools, employee-facing dashboards, task trackers, request systems, anything where Microsoft 365 family resemblance is a feature.

→ [direction-saas.md](./direction-saas.md)

### 3. Product
**Reference apps:** Linear, Notion (consumer side), Spotify, Airbnb, Headspace, Robinhood, Apple Music

Apps you'd download by choice. Type-led, warm or rich-dark surfaces, single muted accent, sentence-style rows over icon-rich cards, generous whitespace, asymmetric layouts. The premium feel.

**Pick when:** consumer-facing apps, employee experience apps where retention matters (HR onboarding, learning, wellness), executive dashboards that need to look "designed."

→ [direction-product.md](./direction-product.md)

## How they map to the existing surface vocabulary

Existing `surface` token in `shared/references/design-planning.md`:

| Direction | Surface (existing token) | Plus |
|---|---|---|
| Inspection | `strong-cards` | High-contrast bg, status stripe on card |
| SaaS | `subtle-depth` | Hairline border + mild shadow on raised |
| Product | `editorial` | Flat warm bg, full-bleed sections, asymmetry |

The new direction names *bundle* the existing tokens with palette + typography + tone choices, so the user picks one thing instead of nine.

## What gets locked when a direction is picked

Picking one direction cascades into ~30 downstream decisions in the screen-builder. The user never has to think about these individually:

| Cascaded decision | Picked from direction's bundle |
|---|---|
| Card border style | Inspection: status stripe / SaaS: hairline / Product: none |
| List row layout | Inspection: card-with-stripe / SaaS: row-with-chevron / Product: sentence |
| Empty state | Inspection: icon+sentence+big button / SaaS: icon+ghost button / Product: type-led, no icon |
| Loading skeleton | Inspection: solid blocks / SaaS: shimmer / Product: type-shaped lines |
| Error state | All three: inline + retry — but copy tone differs |
| Status color saturation | Inspection: full / SaaS: desaturated / Product: monochrome+accent |
| Primary button shape | Inspection: 56pt+ rectangular / SaaS: rectangular / Product: pill |
| Primary action position | Inspection: bottom-pinned / SaaS: top-right + / Product: in-flow accent |
| Heading font | Inspection: sans / SaaS: sans / Product: display |
| Body letter-spacing | Inspection: 0 / SaaS: 0 / Product: -0.02em on titles |
| Density | Inspection: comfortable-to-dense / SaaS: comfortable / Product: sparse |
| Motion | Inspection: none / SaaS: subtle / Product: liberal-tasteful |
| Accent count | Inspection: status-driven multi / SaaS: 1 brand color / Product: 1 muted |
| Tone of copy | Inspection: direct / SaaS: professional / Product: conversational |

This is the contract: **one human decision unlocks 30+ machine decisions, consistently**.

## Hybrid handling

Most apps fit one direction cleanly. Occasionally the right answer is a merge — "Product look but Inspection's data density" for a dashboard that needs to look premium AND fit a lot of data. The skill handles this by picking dimensions across bundles:

```
Hybrid = Product.{surface, palette, typography, motion} + Inspection.{density, list_style}
```

Hybrids are documented in the plan with their composition (`Picked: Hybrid (Product base + Inspection data density)`) so downstream agents know what to do.

## When NOT to use directions

- The user has a brand book or design system already (use their tokens directly, skip the picker)
- The app is a pure utility with one screen (overkill — let the default ride)
- The user explicitly asks for "Microsoft default look" (they want SaaS without the picker — just lock it)
