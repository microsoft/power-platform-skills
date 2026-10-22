# MODIFY Screen Brief Artifact

Project one Modify dispatch row into its compatible `[working directory]/*.screen-plan.md` builder brief. Keep it self-sufficient with the shared plan and target YAML.

Follow `${PLUGIN_ROOT}/references/PlanModel.md` for planning versus implementation ownership. Preserve exact existing/shared bindings and approved literal edits; describe builder-owned formulas and geometry by intent. The builder returns concrete final control/property/formula evidence for acceptance.

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

## Change and Preservation Contract

[This file's slice of the approved contract: requested delta, allowed changes, preserved names/creation keywords/handlers/layout/bindings, affected dependencies, assumptions and evidence. Include relevant dataset bounds and their invariants. Refer to shared contracts rather than copying other screens.]

## Changes

1. [Required semantic change, affected dependencies, and acceptance example; exact syntax for an approved literal edit]

## Layout and Visual Impact

- Applied policies: [named policies from `${PLUGIN_ROOT}/references/LayoutPolicies.md` for changed regions]
- Breakpoint source: [preserved/shared width binding, or local responsive coordination intent;
  builder proves actual branches and any reachable cross-branch combinations]
- Instance-specific measurements: [known viewport/data/text bounds, preserved dimensions,
  and affected amount, Save/primary action, receipt-mode or preserved-feedback regions;
  builder supplies final numeric budgets]
- Text fit: [required longest values and wrapping/preservation constraints for changed text; builder proves final fit]
- Visual contract: [shared type, spacing, surface, and action roles that changed controls
  must preserve]
- Record presentation: [canonical identity field and required full visible text; exact binding when preserved; placement
  of paired review decisions on each eligible record, or N/A]

## Required Record Fields

| Field key                         | Record surface | Required field | Source field | Bound control | Exact formula | Placement and visibility |
| --------------------------------- | -------------- | -------------- | ------------ | ------------- | ------------- | ------------------------ |
| [key copied from the plan index]  | [Card/row/detail] | [Visible meaning] | [Record field and type] | [Existing/shared name or new local role] | [Exact preserved/literal binding, otherwise local binding intent] | [Preserved hierarchy or placement/visibility constraints; builder proves final bounds] |

[Copy every affected Required Record Fields row and every preserved row on a record
surface whose source, formula, visibility, hierarchy, or layout changes. Do not allow a
modified card or row to retain only one secondary value while required identity or detail
fields disappear.]

## Controls to Add

[Purpose, supported type, placement constraints, and behavior; exact name/properties only for shared interfaces or approved literal values; or "None"]

## Controls to Remove

[Names; or "None"]

## Properties to Update

[Control -> property -> exact approved literal value or preserved binding; otherwise required semantic change for builder implementation; or "None"]

## State-Driven Surface Visibility

[Copy every changed or affected plan row owned by this screen. Preserve whole-surface
gating on the named control; child visibility and navigation are not substitutes.]

| Surface key | Surface control | State predicate | Visible and hidden states |
| ----------- | --------------- | --------------- | ------------------------- |
| [key copied from plan] | [Existing/shared surface name or new local role] | [Required state semantics; exact preserved/literal/shared predicate when required] | [Both states] |

## Required Actions

| Action                              | Preconditions    | Entry point and event                           | Source and stable ID                          | Transition and postcondition                  | Mutation write set                   | Receipt proof set                                 | Observer and evidence                                    |
| ----------------------------------- | ---------------- | ----------------------------------------------- | --------------------------------------------- | --------------------------------------------- | ------------------------------------ | ------------------------------------------------- | -------------------------------------------------------- |
| [Action copied from the plan index] | [Eligible state] | [Existing/shared event or new local entry role and event] | [Named source, field types, and immutable identity, or N/A] | [Required operation and resulting state] | [Every changed field/status, or N/A] | [Feedback: Receipt - identity and fields to render; Feedback: Preserve - identity and static proof for every write; nonmutation: N/A] | [Required source observer and immediate receipt, or exact preserved feedback/observer bindings] |

[Copy every affected Action Contract and preserve unaffected behavior. Include the target
source and deterministic visible result bound to the changed stable ID for mutations. Copy
the mutation write set, feedback mode, and proof obligations from the Action Contract under `${PLUGIN_ROOT}/references/MutationBehavior.md`. For create/edit
changes, define finite-choice values and defaults, stable identity, visible Edit entry,
prepopulation, save-by-ID, reset, cancel behavior, and feedback semantics. Receipt mode specifies the immediate result fields and visibility lifecycle; Preserve mode names existing feedback and source-bound observers plus static field/write evidence, without adding UI or focus. Builders choose local formulas and return final bindings. Keep changed
success, boundary, rejection, persistence, and recalculation paths separate.]

## Data Entry Label Contracts

| Required input | Persistent visible label | Shared field region |
| -------------- | ------------------------ | ------------------- |
| [changed or affected input name or new local role] | [Required visible text; exact preserved binding; native visible Label only for ModernNumberInput] | [Preserved immediate parent or field grouping intent] |

[Copy every changed or affected plan-index Data Entry Label Contract owned by this screen.
Preserve existing input/label bindings and shared immediate parents; builders choose new local names/grouping and supply final evidence.]

## Mutation Lifecycle Evidence

[Copy every changed or affected lifecycle row with its feedback mode, canonical source, requested destination, same stable ID, and synchronization obligations. Preserve existing feedback/observer/focus bindings. Specify new receipt/focus behavior only for Receipt mode; builders supply actual local formulas.]

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

## Imagery Assignments

[Copy this screen's changed or added imagery rows from the shared plan, including the exact
URL or media asset name, target control or purpose, fit/crop intent, and accessible label.
Write "None" only when this edit adds or changes no imagery.]

## Relevant Data Source Schemas

[Exact source/field names, types, stable key, and relevant constraints for fields this edit reads, writes, or preserves; omit if none]

## Relevant API Details

[Only the operations this edit calls; omit if none]

## Required Variants

[Control type -> exact variant, for any control this edit adds whose definition includes a
Variants section; omit if none]

## Control Decisions

[For changed or added contracts: exact describe_control query identity, target instances, existing creation keywords to preserve, selected variant and material feasibility constraints. The builder describes each selected type directly. Do not copy property inventories or control-definition snapshots; direct metadata supplies supported inputs, outputs and enums. A current catalog response is not approval to upgrade existing versions. Write "None" only when no contract needs discovery.]
```
