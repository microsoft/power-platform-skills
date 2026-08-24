# Reference Fidelity Contract

Use this contract whenever a user supplies a screenshot, Figma frame, sketch,
existing app, or other visual reference.

## Fidelity levels

| Level | Required outcome |
| --- | --- |
| none | No visual reference. Use the approved product direction. |
| directional | Preserve the broad tone, palette relationships, and density. Composition may adapt. |
| high | Preserve hierarchy, media prominence, typography relationships, navigation silhouette, and repeated motifs. |
| strict-structural | Preserve measurable structure and interaction placement with original assets and copy. Do not claim pixel parity without native evidence. |

## Design intake

Write PROJECT_DIR/design-intake.md before screen planning:

~~~markdown
# Design Intake

- Sources: local paths or approved identifiers
- Fidelity: directional | high | strict-structural
- Viewports represented: dimensions and orientation
- Audience/context: known or inferred

## Hierarchy
- ordered first-viewport regions

## Measured Geometry
| Element | Approximate viewport share / size |
| --- | --- |

## Typography
- display/body relationship
- approximate scale, weight, line-height, and wrapping

## Palette and Surfaces
- dominant, secondary, and accent roles
- contrast, border, radius, and elevation behavior

## Navigation Silhouette
- fixed versus scrolling chrome, tabs, drawers, headers, and floating controls

## Required Motifs
- each repeated visual motif and its owner screen

## Forbidden Drift
- patterns that would materially break the supplied composition

## Originality and Asset Policy
- recreate principles with original assets and copy
- list local/offline asset sources and fallbacks when required

## Runtime Markers
- experience-signature
- experience-headline
- experience-media
- experience-primary-action
- experience-next-section
- experience-motif-example
~~~

For high and strict-structural fidelity, Runtime Markers are required. Each
marker must become an exact React Native testID on the materializing screen or
shared component. Use one experience-motif slug per Required Motif.

## Extraction rules

- Measure composition before extracting color.
- Record first-viewport region order and approximate normalized shares.
- Distinguish fixed product chrome from browser, device, and debug overlays.
- Record typography ratios and wrapping behavior, not unverified font names.
- Record media crop, subject prominence, and fallback requirements.
- Record navigation geometry and whether actions are integrated, floating,
  in-flow, or bottom-pinned.
- Treat user corrections as authoritative changes to the intake.

## Binding rules

- High and strict-structural references create a Reference Contract inside the
  plan Design section that links to design-intake.md.
- Industry presets, generic retail templates, and design-preset defaults never
  override an approved design intake.
- Every affected screen spec names the required motifs it materializes.
- A required media motif needs a real source and fallback strategy before
  implementation.
- Forbidden Drift items are hard rules during planning, build, and polish.

## Runtime evidence

For high and strict-structural fidelity, collect real native captures after
Metro starts. Review iOS Home, Android Home, and one large-text Home capture
for hierarchy, normalized geometry, media, type hierarchy, navigation,
required motifs, forbidden drift, safe areas, clipping, overlap, and blank
assets. Static HTML preview output is useful for review but is not native
fidelity evidence.
