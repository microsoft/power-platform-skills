# MODIFY Screen Brief Artifact

Project one Modify dispatch row into its compatible `[working directory]/*.screen-plan.md` builder brief. Keep it self-sufficient with the shared plan and target YAML.

## Screen Brief — MODIFY

```markdown
# Screen Plan: [Logical Screen]

## Assignment

- Action: Modify
- Target file: `[working directory]/[File].pa.yaml`
- YAML key: [existing key]
- Control name prefix: [Prefix]

## Current State

[Concise summary of relevant existing controls and layout]

## Changes

1. [Exact required change]

## Layout and Visual Impact

- Applied policies: [named policies from `${PLUGIN_ROOT}/references/LayoutPolicies.md` for changed regions]
- Breakpoint source: [one screen-level width expression for coordinated nested branches,
  or every reachable cross-branch combination]
- Instance-specific measurements: [available width, longest label, gallery
  Height/TemplateSize, named color pair; include amount, Save/primary action, and all
  receipt fields]
- Text fit: [longest-value budget for changed text-bearing controls]
- Visual contract: [shared type, spacing, surface, and action roles that changed controls
  must preserve]
- Record presentation: [canonical identity field and full visible text binding; placement
  of paired review decisions on each eligible record, or N/A]

## Required Record Fields

| Field key                         | Record surface | Required field | Source field | Bound control | Exact formula | Placement and visibility |
| --------------------------------- | -------------- | -------------- | ------------ | ------------- | ------------- | ------------------------ |
| [key copied from the plan index]  | [Card/row/detail] | [Visible meaning] | [Record field] | [Control] | [Exact binding] | [Hierarchy, sizing, normal-state visibility] |

[Copy every affected Required Record Fields row and every preserved row on a record
surface whose source, formula, visibility, hierarchy, or layout changes. Do not allow a
modified card or row to retain only one secondary value while required identity or detail
fields disappear.]

## Controls to Add

[Name, type, placement, properties; or "None"]

## Controls to Remove

[Names; or "None"]

## Properties to Update

[Control -> property -> exact value; or "None"]

## State-Driven Surface Visibility

[Copy every changed or affected plan row owned by this screen. Preserve whole-surface
gating on the named control; child visibility and navigation are not substitutes.]

| Surface key | Surface control | State predicate | Visible and hidden states |
| ----------- | --------------- | --------------- | ------------------------- |
| [key copied from plan] | [Surface control] | [Exact `=state predicate`] | [Both states] |

## Required Actions

| Action                              | Preconditions    | Entry point and event                           | Source and stable ID                          | Transition and postcondition                  | Mutation write set                   | Receipt proof set                                 | Observer and evidence                                    |
| ----------------------------------- | ---------------- | ----------------------------------------------- | --------------------------------------------- | --------------------------------------------- | ------------------------------------ | ------------------------------------------------- | -------------------------------------------------------- |
| [Action copied from the plan index] | [Eligible state] | [Visible entry and Control.OnSelect / OnChange] | [Named source and immutable identity, or N/A] | [Exact formula operation and resulting state] | [Every changed field/status, or N/A] | [Identity plus every labeled bound value, or N/A] | [Formula/control reading the source plus visible result] |

[Copy every affected Action Contract and preserve unaffected behavior. Include the target
source and deterministic visible result bound to the changed stable ID for mutations. Copy
the exact mutation write set and receipt proof set from the Action Contract. For create/edit
changes, define finite-choice values and defaults, stable identity, visible Edit entry,
prepopulation, save-by-ID, reset, cancel behavior, and the exact reveal receipt. Name its
control, visibility state, and one labeled binding per proof-set field. Keep changed
success, boundary, rejection, persistence, and recalculation paths separate.]

## Data Entry Label Contracts

| Required input | Persistent visible label | Shared field region |
| -------------- | ------------------------ | ------------------- |
| [changed or affected input] | [exact sibling label binding; native visible Label only for ModernNumberInput] | [immediate parent field row/group containing both] |

[Copy every changed or affected plan-index Data Entry Label Contract owned by this screen.
Preserve the exact input/label binding and shared immediate parent.]

## Mutation Lifecycle Evidence

[Copy every changed or affected mutation lifecycle row for this screen. Preserve the receipt, canonical
source, requested destination, same stable ID, synchronization/focus behavior, and exact
observer formulas.]

## Mutation Field Ledger

[Copy every changed or affected mutation field-ledger row. Changed fields must retain write/proof parity;
preserved fields must keep canonical pre-state sourcing and post-state evidence.]

## Continuation Contracts

[Include only when this screen participates in an affected create-to-later
edit/delete/relationship/approval/transition continuation. Preserve the returned-ID target
and clear continuation identity/mode on downstream completion or cancellation.]

## Functional Test Scenarios

| Scenario                                                    | Given            | When                      | Then                   | Evidence surface                      | Boundary or negative case            |
| ----------------------------------------------------------- | ---------------- | ------------------------- | ---------------------- | ------------------------------------- | ------------------------------------ |
| [Changed or regression scenario copied from the plan index] | [Concrete state] | [Exact local interaction] | [Source postcondition] | [Observer/control reading the source] | [Required boundary behavior, or N/A] |

[Copy every affected scenario, including preservation checks for behavior sharing a
changed source, field, control, or observer.]


## Relevant Data Source Schemas

[Only the fields this edit reads or writes; omit if none]

## Relevant API Details

[Only the operations this edit calls; omit if none]

## Required Variants

[Control type -> exact variant, for any control this edit adds whose definition includes a
Variants section; omit if none]

## Changed or Added Control Definitions

[For each control type receiving a new property, enum, or variant — including types
already present in the app: valid input property names, plus the full enum name and
compile-ready literal for each enum property this edit sets. Write
`Precision: =DecimalPrecision.'1'`, not a bare member list; omit if none]
```
