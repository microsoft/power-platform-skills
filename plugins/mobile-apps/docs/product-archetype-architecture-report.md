# Product Experience Architecture Report

Date: 2026-08-20
Plugin: `power-platform-skills/mobile-app` v0.3.0
Scope: prompt intake, experience planning, design materialization, screen
generation, validation, and visual QA

## Summary

The mobile plugin separates what an app does from how it should feel and look.
It no longer classifies prompts through product, personality, Home composition,
row, hero, workflow, or palette registries. The model derives those decisions
from the approved prompt and references while a small hard-boundary document
protects native ergonomics, accessibility, safe areas, resilient states, and
idempotent interactions.

This avoids two recurrent failures:

1. Industry keywords selecting an unrelated visual preset.
2. Different app prompts producing the same dashboard or card layout with
   renamed labels.

## Decision Ownership

| Dimension | Purpose | Owner | Approval |
|---|---|---|---|
| Industry context | Vocabulary and business constraints | Requirements planning | Gate 1 |
| Product structure | Primary repeated user loop | Requirements planning | Gate 1 |
| Workflow capabilities | Behaviors and integrations | Architecture planning | Gate 2 |
| Operating context | Physical and ergonomic constraints | Requirements planning | Gate 1 |
| Visual character | Emotional and stylistic expression | Experience planning | Gate 3 |
| Home composition | Landing hierarchy, geometry, and action ownership | Screen planning | Gate 3 |
| Media and references | Inspectable content and binding visual evidence | Experience planning | Gate 3 |
| First viewport | Measurable dominant composition | Experience planning | Gate 3 |

Industry and product labels never choose palette, typography, density, radius,
surface treatment, motion, or Home composition.

## Prompt Flow

```mermaid
flowchart LR
  P[User prompt] --> G1[Gate 1: requirements]
  G1 --> G2[Gate 2: architecture]
  G2 --> G3[Gate 3: experience]
  G3 --> G4[Gate 4: implementation]
  G4 --> D[Design artifacts]
  D --> S[Screen plans and builders]
  S --> V[Static validators]
  V --> Q[Native visual QA]
```

1. `/create-mobile-app` preserves the prompt and confirms requirements.
2. `native-app-planner` describes the repeated loop, operating context, and
   experience in free-form evidence-backed fields.
3. `screen-planner` writes a graph plus per-screen hierarchy, workflow, data,
   navigation, and state contracts without pattern keys.
4. `/design-system` materializes `brand/design-system.md`, `brand/tokens.ts`,
   and `brand/design-system.html` from the approved intent.
5. `screen-builder` turns each screen contract into Tamagui and Expo code using
   semantic tokens and mobile boundaries.
6. Contract, route, data, composition, TypeScript, and native visual checks
   validate the result.

## Evidence Precedence

Design decisions resolve conflicts in this order:

1. Binding visual intake and explicit user references.
2. Explicit brand notes and assets.
3. Approved composition, media, navigation, and First Viewport requirements.
4. Audience, workflow, content, and operating context.
5. Existing brand artifacts when editing an app.
6. Model reasoning for unresolved details.
7. Hard mobile UX boundaries.

## Canonical Contracts

- [product-experience-contract.md](../shared/references/product-experience-contract.md)
- [design-planning.md](../shared/references/design-planning.md)
- [mobile-ux-boundaries.md](../shared/references/mobile-ux-boundaries.md)
- [reference-fidelity.md](../shared/references/reference-fidelity.md)
- [four-gate-planning.md](../shared/references/four-gate-planning.md)

## Planning and Materialization

- [native-app-planner.md](../agents/native-app-planner.md) owns Gates 2 and 3.
- [screen-planner.md](../agents/screen-planner.md) owns screen hierarchy and
  per-screen implementation contracts.
- [design-system/SKILL.md](../skills/design-system/SKILL.md) owns brand artifacts.
- [screen-builder.md](../agents/screen-builder.md) owns one screen at a time and
  cannot replace approved hierarchy with a sample layout.
- [tamagui-integration.md](../skills/design-system/references/tamagui-integration.md)
  imports generated tokens and exposes semantic aliases.

## Executable Validation

- [validate-experience-contract.js](../scripts/validate-experience-contract.js)
  verifies concrete fields, reference fidelity, media consistency, and First
  Viewport geometry without aesthetic registries.
- [validate-screen-composition.js](../hooks/validate-screen-composition.js)
  checks signature geometry, headline size, metrics, media fallbacks, action
  ownership, and runtime measurement IDs.
- [visual-qa/SKILL.md](../skills/visual-qa/SKILL.md) verifies native screenshots
  and rendered view geometry across required platforms and viewports.

## Non-Negotiable Boundaries

The single [mobile-ux-boundaries.md](../shared/references/mobile-ux-boundaries.md)
contract protects minimum touch targets, safe areas, native input ergonomics,
loading/empty/error behavior, hardware independence, and idempotent data paths.
It constrains unsafe outcomes without prescribing an aesthetic.

## Regression Coverage

The Node test corpus covers free-form Product Experience values, First Viewport
ranges, media/source consistency, screen composition, status rendering,
preflight dependencies, route contracts, and active local links. A retired
catalogue name or legacy UI key in the active corpus is treated as regression.