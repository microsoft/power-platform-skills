# Product Experience Contract

Canonical schema for the product and visual decisions that drive a generated Power Apps mobile experience. This contract deliberately separates what the app does from how it looks.

## Ownership

| Dimension | Meaning | Owner | Approval |
|---|---|---|---|
| Industry context | Business domain and vocabulary | Requirements planning | Gate 1 |
| Product archetype | Primary product structure and repeated user loop | Requirements planning | Gate 1 |
| Workflow capabilities | Behaviors the app supports | Architecture planning | Gate 2 |
| Operating context | Where/how the app is used: indoor, outdoor, gloves, one hand, safety critical | Requirements planning | Gate 1 |
| Visual personality | Emotional and stylistic character | Experience planning | Gate 3 |
| Visual ambition | Template, tailored, premium, or bespoke depth | Experience planning | Gate 3 |
| Content emphasis | Image-led, object-led, data-led, relationship-led, task-led, or timeline-led | Experience planning | Gate 3 |
| Home composition | The landing-screen composition pattern | Screen planning | Gate 3 |
| Navigation mood | Functional, atmospheric, cinematic, or reference-driven | Experience planning | Gate 3 |
| Density | Sparse, comfortable, compact, or dense | Experience planning | Gate 3 |
| Reference source | Screenshot, Figma, sketch, sibling app, or structured design intake | Design intake | Gate 3 |
| Reference fidelity | None, directional, high, or strict-structural | Design intake | Gate 3 |
| Media strategy | Record media, local UI media, generated placeholder, or no media | Experience planning | Gate 3 |

Industry and workflow MUST NOT select visual personality, palette, typography, density, radius, media, or Home composition. They may suggest defaults that remain independently reviewable.

## Plan Section

Every new plan includes this top-level section between `## App Requirements` and `## Data Model`:

```markdown
## Product Experience

- Contract version: 1
- Industry context: <slug>
- Product archetype: <slug from product-archetypes.md>
- Classification confidence: <high | medium | low>
- Classification evidence: <comma-separated requirement evidence>
- Workflow capabilities: <comma-separated capability slugs>
- Operating context: <comma-separated context slugs>
- Visual personality: <slug from visual-personalities.md>
- Visual ambition: <template | tailored | premium | bespoke>
- Content emphasis: <image-led | object-led | data-led | relationship-led | task-led | timeline-led>
- Home composition: <slug from home-compositions.md>
- Navigation mood: <functional | atmospheric | cinematic | reference-driven>
- Navigation silhouette: <tab/drawer/header geometry and fixed chrome behavior>
- Density: <sparse | comfortable | compact | dense>
- Reference fidelity: <none | directional | high | strict-structural>
- Media strategy: <record-media | local-ui-media | generated-placeholder | mixed | none>
- Media source: <Dataverse field, local asset, generated source, or none>
- Media fallback: <loading, error, and empty behavior with stable geometry>

### First Viewport Contract

| Field | Requirement |
|---|---|
| Signature component | <name> |
| Viewport share | <0.20-0.65> |
| Minimum height | <integer dp> |
| Media | <required | optional | forbidden> |
| Headline minimum | <integer sp> |
| Supporting metrics maximum | <0-4> |
| Primary action | <integrated | in-flow | bottom-dock | native-navigation> |
| Next section visible | <yes | no> |
| Duplicate action with tab | <allowed | forbidden> |

### Reference Contract

_None._
```

When screenshots, Figma, or another visual source exists, replace `_None._` with:

```markdown
### Reference Contract

- Source: <design-intake path or source identifier>
- Fidelity: <directional | high | strict-structural>
- Required hierarchy: <ordered composition>
- Required media ratio: <range or none>
- Required typography scale: <description>
- Required navigation silhouette: <description>
- Required repeated motifs: <comma-separated motifs>
- Forbidden drift: <comma-separated anti-patterns>
- Explicit non-goals: <what must not be copied>
```

Reference fidelity governs hierarchy and composition, not trademark copying. Recreate visual principles with original assets and copy.

## Runtime Measurement IDs

Signature-screen implementations expose these non-visible React Native
`testID` values so `/visual-qa` can measure the rendered contract:

- `experience-signature`
- `experience-headline`
- `experience-media` when media is required/optional
- `experience-primary-action`
- `experience-next-section` when next-section visibility is required
- `experience-metric-1` through `experience-metric-4` as used

The IDs do not change visible UI or accessibility labels. Use each ID once per
screen. Reference-specific motifs may add `experience-motif-<slug>`.

## Inference Rules

1. Identify the primary repeated user loop before matching an archetype.
2. Treat supporting workflows as capabilities, not as the product archetype.
3. Cite evidence from the approved brief.
4. Use `low` confidence when two archetypes explain the primary loop equally well.
5. Present the low-confidence choice inside Gate 1; do not add a fifth approval.
6. Infer a least-assumptive visual personality only when the user provides no aesthetic or reference signal. Gate 3 still reviews it.
7. A supplied screenshot or design intake overrides personality defaults and creates a binding Reference Contract.

## Downstream Contract

- `native-app-planner` writes this section.
- `screen-planner` chooses Home and per-screen compositions from it.
- `/design-system` materializes palette, type, geometry, media source/fallback, navigation, and component rules from it.
- `screen-builder` treats First Viewport and Reference Contract fields as binding.
- `validate-experience-contract.js` blocks incomplete or contradictory plans.
- `validate-screen-composition.js` checks source-level materialization.
- `/visual-qa` verifies the runtime result at representative viewports.
