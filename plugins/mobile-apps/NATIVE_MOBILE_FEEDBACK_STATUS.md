# Native Mobile Experience Feedback Status

This document tracks the actionable recommendations from **Native Mobile
Experience Feedback 2026-08-15** against the mobile-app V2 reliability branch.
Several slides contain visual examples rather than separate requirements, so
the table groups them by product outcome.

| Recommendation | Status | V2 implementation or decision |
|---|---|---|
| Replace terminal-only planning with a visual review experience | Implemented | `mobile-app-plan.html` provides semantic sections, tables, metrics, blockers, review tabs, and concept-preview disclaimers. |
| Make long-running generation incremental and understandable | Implemented | A loopback-only, event-driven planning companion opens after Gate 1, shows factual architecture milestones, presents Gate 2 before long screen expansion, then progressively reveals Gate 3 screen batches and durable implementation outcomes without polling or periodic page reloads. |
| Provide a visual data model | Implemented | Mermaid ER definitions are rendered locally as entity, field, and relationship views without a CDN dependency. |
| Make the ER model editable | Implemented | The Plan HTML editor supports editing, adding, removing, and resetting entities, fields, and relationships. It exports a structured `mobile-er-revision.json` for Gate 2 validation. |
| Explain why architecture and data-model choices were made | Implemented | Reuse, extend, and create decisions require rationale, alternatives, trade-offs, assumptions, and scope boundaries. |
| Improve generated mobile UI quality | Implemented | The canonical mobile visual-quality contract now locks semantic typography, spacing rhythm, button hierarchy, surface discipline, composition recipes, preview fidelity, shared action primitives, and deterministic validation. |
| Use real imagery and richer domain context | Implemented | Imagery is scenario-gated. Every imagery-enabled screen must prove an approved Dataverse/camera/user-asset source, purpose, crop, fallback, and accessibility treatment; builders may not invent stock imagery. |
| Generate a privacy and device-impact Trust Report | Implemented | `mobile-app-trust-report.html` reports capabilities, permissions, privacy boundaries, authentication readiness, background behavior, network paths, offline state, storage considerations, and intentionally excluded capabilities. |
| Show outcome-driven implementation progress | Implemented | `mobile-app-status.json` stores durable delivery outcomes; the planning companion streams status changes in place and refreshes Plan artifacts only at meaningful delivery boundaries. |
| Improve the first app-launch experience | Implemented | `mobile-app-launch.html` includes player installation links, authentication and environment readiness, an embedded QR code, direct launch, troubleshooting, and links to the Plan and Trust Report. |
| Clarify offline planning and setup | Implemented differently | Offline setup is a separate post-Dataverse workflow based on live metadata rather than being mixed into initial requirements or data-model approval. |
| Automatically clone the native template and run `npm install` | Not recommended | `/create-mobile-app` requires an already materialized fresh template with dependencies installed. This prevents planning from starting against an incomplete or unauthenticated native-host dependency tree. |
| Reduce `npm install` duration | Outside plugin control | Package size, registry performance, network conditions, and Azure Artifacts authentication dominate installation time. The skill verifies the prepared template rather than hiding or duplicating installation. |
| Detect the environment from a PAC CLI authentication profile | Not applicable | The mobile workflow uses `npx power-apps` authentication and generated `power.config.json`, not PAC authentication profiles. |
| Generate polished visuals before understanding the data model | Not recommended | Screen fields, relationships, navigation, and operational states depend on the approved architecture. V2 reviews architecture before the experience to avoid attractive but infeasible mockups. |
| Add AI recommendations, carousels, gestures, and immersive patterns to every app | Scenario-dependent | These patterns are planned only when they improve the approved business workflow. They are not universal quality requirements. |
| Add generic stock photography or AI-generated business imagery | Not recommended | Generated apps should use real Dataverse images or explicitly approved bundled assets and must not invent business data. |
| Let browser ER edits directly update the plan or Dataverse | Cannot be done safely | A standalone Plan HTML file cannot securely mutate local project files. Revisions are exported, validated, and used to regenerate Gate 2 and dependent screen bindings before any Dataverse mutation. |
| Guarantee that a static preview exactly matches native rendering | Cannot be guaranteed | Plan previews are conceptual and post-build HTML previews remain static. Metro and the native player are authoritative. |
| Measure actual battery, network, storage, and operating-system permission behavior statically | Requires device testing | Static analysis can document expected behavior, but measured resource use and OS permission wording/enforcement require an iOS or Android device run. |

## Visual Quality Contract

`shared/references/mobile-visual-quality-contract.md` is now the single
cross-phase contract. Planning records one composition recipe per
generated/modified screen, `/design-system` materializes typography, spacing,
action, radius, surface, and imagery decisions, previews use the same recipes,
and the screen validator blocks screen-local numeric typography plus
undersized or unshaped direct primary actions.

For the Contoso Store Operations reference app, damage evidence already uses
real Dataverse images. Inventory remains quantity-focused because the reused
Product table has no approved image field. V2 should not add unrelated stock
photography; product thumbnails require an approved Product image column or
another verified business-owned image source.
