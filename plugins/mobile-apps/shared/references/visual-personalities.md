# Visual Personality Registry

Visual personality is independent of industry and product archetype. Any archetype may use any personality when the resulting controls remain usable and accessible.

## Personalities

### `utility`

- Character: terse, direct, high contrast, low decoration.
- Typography: highly legible sans; mono only for scanned values.
- Geometry: tight-to-medium radius; explicit controls.
- Motion: none or functional-only.
- Best when speed, harsh environments, gloves, or safety dominate.

### `polished-operational`

- Character: quiet, trustworthy, refined enterprise product.
- Typography: clear hierarchy with moderate display scale.
- Geometry: selective cards, hairline separators, restrained accent.
- Motion: functional or enriched.
- Best for repeated internal work that still needs stakeholder polish.

### `premium-brand-forward`

- Character: distinctive, image/object-led, generous hierarchy, branded navigation.
- Typography: expressive display role plus highly legible body/UI role.
- Geometry: deliberate large shapes; radius may be medium or loose when approved.
- Motion: enriched, never decorative noise.
- Best when retention, product identity, executive confidence, or customer-facing quality matters.

### `editorial`

- Character: content-led, asymmetric, typographic, spacious.
- Typography: distinctive display face with readable sans UI.
- Geometry: few cards, long section rhythm, strong content sequencing.
- Motion: subtle fades and scroll transitions.

### `immersive`

- Character: full-bleed media, atmospheric chrome, one dominant scene/object.
- Typography: high contrast over media or strong color fields.
- Geometry: screen-filling surfaces and integrated actions.
- Motion: enriched or immersive when it supports orientation.

### `playful-consumer`

- Character: energetic, friendly, colorful, progress/celebration oriented.
- Typography: rounded or expressive sans.
- Geometry: approachable controls and varied visual rhythm.
- Motion: enriched with restrained celebration moments.

### `reference-driven`

- Character: determined by an approved screenshot, Figma file, sibling app, or structured design intake.
- Defaults: none. The Reference Contract is authoritative.
- The builder must preserve required hierarchy, media ratio, motifs, and navigation silhouette while using original assets and copy.

## Visual Ambition

| Level | Meaning |
|---|---|
| `template` | Registered defaults with no custom composition beyond archetype requirements. |
| `tailored` | App-specific palette, typography, signature components, and Home composition. |
| `premium` | Distinct composition across primary screens, media strategy, runtime visual QA. |
| `bespoke` | Reference-driven or custom design language with strict structural fidelity and broad visual QA. |

## Selection Rules

- Requirements and operating context may recommend a personality but never lock it.
- Explicit aesthetic words, brand inputs, and visual references outrank recommendations.
- `premium`, `immersive`, and `reference-driven` require runtime screenshot QA.
- A utility workflow may have a premium personality.
- A consumer workflow may use utility styling when the user explicitly wants it.
- Personality controls expression; it does not remove workflow gates, accessibility, or safety information.

## Builder Translation

Personality controls composition budgets, not merely token values:

| Personality | First-viewport behavior | Surface strategy | Typical action placement |
|---|---|---|---|
| utility | task/status first | rows and compact bands | bottom-reachable |
| polished-operational | object/current work first | selective grouped surfaces | in-flow or bottom |
| premium-brand-forward | brand/object/media first | varied sections, fewer equal cards | integrated or in-flow |
| editorial | narrative/content first | mostly unframed | in-flow |
| immersive | scene/media first | full-bleed | integrated |
| playful-consumer | progress/recommendation first | varied colorful surfaces | in-flow/bottom |
| reference-driven | match Reference Contract | match Reference Contract | match Reference Contract |
