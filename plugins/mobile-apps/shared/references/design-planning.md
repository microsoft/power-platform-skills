# Design Planning Reference

Shared workflow for turning an approved app prompt into a coherent native design
contract. It is used during Gate 3 planning. It does not contain archetype,
personality, composition, palette, typography, or component catalogues.

Read these references first:

- [product-experience-contract.md](product-experience-contract.md)
- [reference-fidelity.md](reference-fidelity.md)
- [mobile-ux-boundaries.md](mobile-ux-boundaries.md)

## Principle

The model owns aesthetic, hierarchy, composition, and component decisions. Those
decisions must be derived from evidence in the prompt and plan, then bounded by
native platform, accessibility, and interaction constraints.

Industry contributes vocabulary and business constraints only. Never map an
industry word, product label, or isolated adjective directly to a palette,
font, density, radius, Home layout, card style, or motion policy.

## Evidence Precedence

Resolve conflicts in this order:

1. Binding `design-intake.md` and explicit visual references.
2. Explicit user brand notes, assets, colors, typography, and negatives.
3. Approved Product Experience composition, media, navigation, and First
   Viewport requirements.
4. Audience, repeated workflow, task frequency, content, and operating context.
5. Existing project brand artifacts when editing an app.
6. Model reasoning for unresolved details.
7. `mobile-ux-boundaries.md` as the non-negotiable final constraint.

A higher-precedence source may change an inferred visual choice but may not
override touch targets, safe areas, readable contrast, idempotent interactions,
or other hard boundaries.

## Reasoning Workflow

### 1. Understand the product

- Describe the primary repeated user loop in one sentence.
- Identify the people, objects, decisions, and time pressure in that loop.
- Separate supporting capabilities from the product's primary structure.
- Record physical and operational constraints such as gloves, one-handed use,
  intermittent connectivity, safety criticality, and phone/tablet targets.

### 2. Establish hierarchy

- Decide what must dominate the first viewport and why.
- Assign one owner for the primary action.
- Define how neighboring tab roots differ in silhouette while sharing one visual
  grammar.
- Describe Home as a concrete hierarchy of content, geometry, and actions. Do
  not reduce it to a named template or a generic KPI dashboard.

### 3. Infer the visual system

Choose palette, typography, spacing, density, surface treatment, radius,
iconography, status treatment, and motion as one system. Explain consequential
choices through their product evidence. Examples may inform reasoning, but they
must never become keyword-to-preset mappings.

When no visual signal exists, produce a restrained, app-specific system from the
audience, workflow, content, and operating context. Do not default to stock blue,
generic cards, or a universal font merely because the prompt is quiet.

### 4. Check coherence

- The palette provides readable text and distinguishable status states.
- Typography reflects hierarchy without breaking Dynamic Type.
- Density matches task frequency and operating conditions.
- Components expose one clear interaction owner and stable state geometry.
- Motion communicates state or spatial change; decorative motion is omitted.
- Home and repeated workflow screens feel related but are not layout clones.
- Every major choice can be traced to prompt evidence, a supplied reference, or
  a hard boundary.

## Plan Output

Write all three plan sections below. Values are free-form and evidence-backed;
angle-bracket text describes the required meaning, not an allowed-value list.

### `## Product Experience`

Follow `product-experience-contract.md`. Include the repeated-loop description,
workflow capabilities, operating context, visual character, Home composition,
media strategy, First Viewport Contract, and Reference Contract.

### `## Design Direction`

This is a compact machine-readable handoff for screen planners and builders:

```yaml
density: <information and spacing strategy with rationale>
surface: <background, grouping, border, and elevation strategy>
motion: <allowed motion and its purpose>
list_style: <default entity-row grammar, not a catalogue key>
tone: <copy character and concrete wording guidance>
primary_action_shape: <shape and affordance rationale>
primary_action_position: <placement and ownership>
status_treatment: <single status cue strategy and contrast behavior>
empty_state: <content hierarchy and recovery action>
heading_font: <approved family or project default>
body_font: <approved family or project default>
```

Add fields only when another downstream consumer needs them. Do not encode a
preset name, composition key, or industry alias.

### `## Design`

```markdown
## Design

- Aesthetic rationale: <why the expression fits this audience and workflow>
- Palette: <semantic palette direction and contrast rationale>
- Typography: <families, scale, weights, line height, Dynamic Type behavior>
- Density and spacing: <app-level rhythm>
- Surface treatment: <grouping, borders, elevation, and card restraint>
- Hero visual principle: <how dominant content is treated across the app>
- Accent strategy: <where accent is and is not used>
- Status strategy: <one non-duplicated cue system>
- Motion policy: <purpose, intensity, and reduced-motion behavior>
- Radius policy: <coherent shape language>
- Iconography: <set and visual character>
- Copy tone: <voice, labels, errors, and empty-state behavior>
- One memorable thing: <specific visual impression grounded in the product>
- Negatives: <app-specific patterns that would break the intended experience>
```

The `/design-system` skill converts these decisions into
`brand/design-system.md`, `brand/tokens.ts`, and `brand/design-system.html`.

## Screen Planner Handoff

Pass Product Experience, Design Direction, Design, and any design intake
verbatim. The screen planner owns per-screen hierarchy and domain-specific
deltas. It must not translate the handoff through another catalogue.

Per-screen specs should state:

- the most important fields and decision on the screen;
- the screen-specific visual hierarchy;
- the workflow arrangement and primary-action owner;
- the exact data, navigation, native capability, and state contracts;
- only those visual overrides that intentionally differ from the app-level
  direction.

## Integration Mapping

`/design-system` runs before screen generation and should normally produce
`brand/tokens.ts`.

| Condition | Step 9b action |
|---|---|
| `brand/tokens.ts` exists | Import it through `skills/design-system/references/tamagui-integration.md` in brand-import mode and expose semantic aliases. |
| `brand/tokens.ts` is missing | Record a concern and apply alias-only recovery. Do not claim full design integration. |

Run `npx tsc --noEmit` after Tamagui config or provider changes.

## Validation

Before Gate 3 approval, verify:

1. Product, Design Direction, and Design agree on hierarchy and action ownership.
2. Home has a concrete first viewport rather than a named layout key.
3. No aesthetic choice is justified only by industry or a preset label.
4. Reference requirements and forbidden drift are represented when applicable.
5. Every hard rule in `mobile-ux-boundaries.md` remains satisfiable.
6. The preview reflects the written contract and uses original assets and copy.