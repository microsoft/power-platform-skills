# `## Design Direction` block schema

This file documents the exact shape of the `## Design Direction` markdown block that the internal `/design-system` style picker can write into `native-app-plan.md`. Downstream agents (`screen-planner`, `screen-builder`) read this block conditionally — if present, its values become defaults for per-screen design fields.

## Location in the plan

Inserted between `## Native Capabilities` (or `## Connectors`) and `## Design`. If `## Design` is absent, inserted before `## Screens`.

```
## Project
## Data Model
## Native Capabilities
## Connectors
## Design Direction       ← here
## Design                  ← (inherits/cascades from Direction)
## Screens
## Generated Services
```

## Block format

```markdown
## Design Direction

**Picked:** <Utility | Polished Operational | Premium Brand-forward | Hybrid (...)>
**Reference apps:** <comma-separated list>
**Picked at:** <ISO 8601 timestamp> (via /design-system style picker)

visual_personality: <utility | polished-operational | premium-brand-forward | editorial | immersive | playful-consumer | reference-driven>
visual_ambition: <template | tailored | premium | bespoke>
materialization_profile: <inspection | saas | product | custom | hybrid>
product_archetype: <copied unchanged from Product Experience>
home_composition: <copied/approved key from home-compositions.md>
content_emphasis: <image-led | object-led | data-led | relationship-led | task-led | timeline-led>
reference_fidelity: <none | directional | high | strict-structural>
surface: <strong-cards | subtle-depth | editorial>
background: <dark-slate | cool-gray-light | warm-cream | rich-dark>
palette: <named bundle, e.g. "slate + safety-orange">
typography: <"sans-only" | "display-headings + sans-body">
heading_font: <font name>
body_font: <font name>
body_size: <pt>
heading_letter_spacing: <em or 0>
list_style: <card-with-status-stripe | row-with-chevron | sentence>
density: <sparse | comfortable | comfortable-to-dense>
motion: <none | subtle | liberal-tasteful>
status_saturation: <full | desaturated | monochrome-plus-accent>
empty_state: <icon-sentence-bigbutton | icon-explanation-ghostbutton | type-led>
primary_action_shape: <rectangular | rectangular-bottom-pinned | pill>
primary_action_position: <bottom-pinned | top-right-or-in-flow | in-flow-or-bottom-center>
accent_color: <human-readable name (#hex)>
tone: <direct | professional | conversational>

first_viewport_signature: <component name>
first_viewport_share: <0.20-0.65>
first_viewport_min_height: <integer dp>
first_viewport_media: <required | optional | forbidden>
first_viewport_headline_min: <integer sp>
first_viewport_metrics_max: <0-4>
first_viewport_action: <integrated | in-flow | bottom-dock | native-navigation>
first_viewport_next_section_visible: <true | false>
duplicate_action_with_tab: <allowed | forbidden>
media_strategy: <record-media | local-ui-media | generated-placeholder | mixed | none>
media_source: <source identifier or none>
media_fallback: <loading/error/empty behavior>
navigation_silhouette: <one-line geometry>

> Downstream agents (`screen-planner`, `screen-builder`) MUST use these values
> as defaults for their own per-screen Surface / Density / List style / Motion
> fields unless a per-screen spec explicitly overrides.
```

## Hybrid bundles

Hybrids document their composition in the `Picked:` line and the bundle dimensions show the merged values:

```markdown
**Picked:** Hybrid (Product base + Inspection data density)
**Reference apps:** Linear (visual), ServiceTitan (density)

direction: hybrid
surface: editorial              # from Product
background: warm-cream          # from Product
palette: cream + sage           # from Product
typography: display-headings + sans-body  # from Product
list_style: card-with-status-stripe       # from Inspection (overrides Product's "sentence")
density: comfortable-to-dense   # from Inspection
motion: subtle                  # custom (between Product's "liberal" and Inspection's "none")
status_saturation: full         # from Inspection (data density needs status visibility)
... (rest from Product)
```

## How `screen-planner` uses this block

The planner's per-screen spec template (`agents/screen-planner.md` Step 4) includes these design fields:

- `Density mode` (sparse / comfortable / dense)
- `Surface style` (flat / subtle-depth / strong-cards / editorial)
- `Visual emphasis` (one phrase)
- `Restrained or expressive`
- `Animations` (per-event)

When `## Design Direction` is present, the planner first verifies its copied
Product Experience fields match `## Product Experience`, then pre-fills these
materialization fields from the bundle:
- `Density mode` ← `density`
- `Surface style` ← `surface`
- `Animations` ← derived from `motion`

A per-screen spec can still override (e.g., a celebration screen explicitly opts into `expressive` even in a `restrained` direction). Overrides are explicit annotations, not silent.

## How `screen-builder` uses this block

The builder reads the block once at Step 1 (after reading its assigned screen spec) and applies these defaults when choosing row/component patterns and writing components. Samples remain code/API references only:

- `list_style` → which list pattern family to adapt from the user/spec/design context; do not copy a `shared/samples/` layout with renamed fields
- `motion` → which entries from the animation vocabulary are allowed
- `tone` → button labels, error copy, empty-state copy
- `status_saturation` → which pill style to use
- `primary_action_shape` + `primary_action_position` → button placement and shape
- `empty_state` → which empty-state template to use
- `accent_color` → resolved into `$accentBase`

If `## Design Direction` is absent, the builder materializes the approved
Product Experience with the least-assumptive token choices and records a
concern. Missing Product Experience is not a valid fallback.

## Conditional reading (the play-out contract)

Both planner and builder use a single conditional check at the top of their workflow:

```text
Read native-app-plan.md
If "## Design Direction" section exists:
  Parse the bundle into a config object
  Use config values as defaults for design decisions
Else:
  Use least-assumptive materialization for approved Product Experience
```

This is the only integration point between the internal style picker and the rest of the system. If `## Design Direction` is absent, existing agents fall back to the `Else` branch automatically.

## Validation rules

- All bundle keys are required when the block exists (no partial bundles)
- `visual_personality` MUST be in `visual-personalities.md`
- `materialization_profile` MUST be one of: `inspection`, `saas`, `product`, `custom`, `hybrid`
- copied `product_archetype`, `home_composition`, and reference fields MUST match `## Product Experience`
- First Viewport values MUST be complete and within the ranges above
- media source/fallback MUST be present when media is required
- Color values MUST include a hex code in parentheses if a name is given
- `Picked at` MUST be a valid ISO 8601 timestamp
- `Reference apps` MUST be non-empty (at least 2 reference apps for clarity)

If the block is malformed, downstream agents should treat it as missing and fall back to the `Else` branch. They should NOT attempt to parse around errors.

## Re-running the style picker

Each `/design-system --reskin` run that uses the style picker REPLACES the existing `## Design Direction` block (does not append). The previous direction is logged in `memory-bank.md` under `## Design history` so the team has an audit trail.

If the user re-runs after screens have been built, `/edit-app` should be the next step to regenerate affected screens with the new direction's defaults.
