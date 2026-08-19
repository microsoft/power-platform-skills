# Reference Fidelity Contract

Use when the user supplies screenshots, Figma, sketches, an existing app, or another visual reference.

## Fidelity Levels

| Level | Contract |
|---|---|
| `none` | No visual reference. Use approved personality and composition. |
| `directional` | Preserve broad tone, palette relationships, and density; composition may adapt. |
| `high` | Preserve hierarchy, media prominence, typography relationships, navigation silhouette, and repeated motifs. |
| `strict-structural` | Preserve measurable structure and interaction placement while using original assets/copy. Do not claim pixel parity without a visual diff. |

## Design Intake Output

Write `<working_dir>/design-intake.md`:

```markdown
# Design Intake

- Sources: <paths/URLs/identifiers>
- Fidelity: <level>
- Viewports represented: <dimensions>
- Audience/context: <known or inferred>

## Hierarchy
- <ordered first-viewport regions>

## Measured Geometry
| Element | Approximate viewport share / size |
|---|---|

## Typography
- Display/body relationship:
- Approximate scale:
- Weight/line-height behavior:

## Palette and Surfaces
- Dominant/secondary/accent roles:
- Contrast behavior:

## Navigation Silhouette
- <tabs/drawer/floating bar/header behavior>

## Required Motifs
- <motif list>

## Forbidden Drift
- <patterns whose presence would materially break fidelity>

## Originality and Asset Policy
- Recreate principles with original assets and copy.
- Do not copy logos, protected artwork, or proprietary text unless supplied for use.
```

## Extraction Rules

- Measure relative composition before extracting color.
- Identify what occupies the largest area and why.
- Record first-viewport content order.
- Distinguish fixed chrome from developer overlays.
- Record typography ratios, not just font names.
- Record repeated component silhouettes and navigation geometry.
- Detect whether primary actions are integrated, floating, in-flow, or bottom-pinned.
- Record edge behavior: text wrapping, next-card sliver, next-section visibility.
- Treat user corrections as authoritative updates to the intake.

## Planning Rules

- `high` and `strict-structural` references create a binding `### Reference Contract` in `## Product Experience`.
- Industry defaults cannot override the reference contract.
- Negatives are generated after reference analysis.
- Screen specs name which required motifs they materialize.
- A required image/media motif needs a real source and fallback strategy before implementation.

## Runtime QA

Capture representative iOS and Android viewports after Metro starts. Compare:

- First-viewport region order and relative size.
- Media presence and crop behavior.
- Typography hierarchy and wrapping.
- Surface/radius/border treatment.
- Navigation silhouette.
- Required motifs and forbidden drift.
- Safe areas, Dynamic Type, overlap, and blank assets.

Use structural/perceptual review, not exact pixel equality. Native fonts and chrome vary by platform.
