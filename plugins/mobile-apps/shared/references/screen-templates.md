# Screen Templates

Small selection index. Start from actor/task/entry/decision/outcome/recovery in the [screen planning contract](screen-planning/spec-contract.md), then read **only the selected section** below. Do not preload every archetype or pattern.

Archetypes and presets are optional composition examples, not a universal shell. Supporting entities do not need separate screens. A list, form, or repeated management structure is valid when the user actually performs that job; custom workspaces can compose existing primitives without a new catalogue key.

## Catalogue keys (referenced from per-screen specs)

Use an existing key when it fits, with the app-specific reason and values in the spec. Read its description on demand. The approved UX contract determines the composition; accessibility, supported data access, navigation, and recovery are not optional.

### Row style keys (List screens)

`status-stripe-card`, `avatar-row`, `stat-card`, `media-tile`, `sentence-row`, `timeline-row`, `checklist-row`.

[Selected row recipe](screen-templates/catalogue-and-archetypes.md#row-style-keys-list-screens).

### Hero type keys (Detail screens)

`status-header-band`, `stat-grid`, `image-hero`, `identity-block`, `summary-card`, `timeline-header`, `minimal-header`.

[Selected hero recipe](screen-templates/catalogue-and-archetypes.md#hero-type-keys-detail-screens). A hero is not mandatory; task-critical content can speak for itself.

### Operational pattern keys (Home + workflow screens)

`home-dashboard`, `assignment-dashboard`, `walkaround-stepper`, `wizard-progress-stepper`, `floating-action-menu`, `scan-geofence-gate`, `severity-filtered-queue`, `dispatch-signoff-queue`, `audit-timeline`.

[Selected workflow recipe](screen-templates/catalogue-and-archetypes.md#operational-pattern-keys-home--workflow-screens). Home is not automatically a dashboard. No tile/row quotas; no automatic signature or location gate from a domain label.

### Calendar pattern keys (Calendar / schedule / appointment screens)

`expandable-calendar-agenda`, `month-agenda`, `calendar-list-range`, `timeline-day-list`.

[Selected calendar recipe](screen-templates/catalogue-and-archetypes.md#calendar-pattern-keys-calendar--schedule--appointment-screens). Native date input is distinct from calendar management; optional JavaScript dependencies require [planning evidence](javascript-dependency-planning.md).

### Control pattern keys (field and row controls)

`checkbox-field`, `numeric-stepper`, `line-item-stepper-row`, `searchable-lookup-sheet`, `segmented-control`, `recurrence-rule-editor`.

[Selected control recipe](screen-templates/catalogue-and-archetypes.md#control-pattern-keys-field-and-row-controls).

## Archetypes on demand

| Job/composition | Reference section |
|---|---|
| Browse, choose, triage, or manage a collection | [List](screen-templates/catalogue-and-archetypes.md#archetype-list) |
| Read or decide from focused content | [Detail](screen-templates/catalogue-and-archetypes.md#archetype-detail) |
| Capture/edit with validation and preserved work | [Form](screen-templates/catalogue-and-archetypes.md#archetype-form) |
| Host sign-in/consent flow | [Auth](screen-templates/catalogue-and-archetypes.md#archetype-auth) |
| Frequent peer destination, not a fixed Home composition | [Tab-root](screen-templates/catalogue-and-archetypes.md#archetype-tab-root) |
| Focused filter/picker/action or self-contained flow | [Modal / Sheet](screen-templates/catalogue-and-archetypes.md#archetype-modal--sheet) |
| First-use or no-content guidance | [Empty / Onboarding](screen-templates/catalogue-and-archetypes.md#archetype-empty--onboarding) |

## Shared state and accessibility requirements

Keep [loading](screen-templates/catalogue-and-archetypes.md#loading-state-choices), [error recovery](screen-templates/catalogue-and-archetypes.md#error-state-guidelines), and [accessibility](accessibility-checklist.md) contracts across all compositions. Native and generated service constraints still apply to every recipe.

## Typography by Archetype

Read the selected row of [typography guidance](screen-templates/catalogue-and-archetypes.md#typography-by-archetype) only when applying the approved font direction.

## Copy Tone by Archetype

Use [copy examples](screen-templates/catalogue-and-archetypes.md#copy-tone-by-archetype) only for the relevant surface and chosen tone. Do not copy inspection nouns into unrelated domains.

## Micro-interactions

For a needed interaction, select [feedback examples](screen-templates/catalogue-and-archetypes.md#micro-interactions) or [universal patterns](universal-patterns.md). Respect reduced motion, use truthful completion feedback, and provide visible gesture alternatives. `expo-haptics` remains runtime-banned.
