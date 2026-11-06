# CREATE Screen Brief Artifact

Project one Create dispatch row into its compatible `[working directory]/*.screen-plan.md` builder brief. Keep it self-sufficient with the shared plan.

This artifact covers a new screen in Planned EDIT. Follow `${PLUGIN_ROOT}/references/PlanModel.md`: own semantic requirements and shared interfaces here, not every local formula or numeric layout. The builder returns the actual final control/property/formula bindings and layout evidence.

## Screen Brief — CREATE

```markdown
# Screen Plan: [Logical Screen]

## Assignment

- Action: Create
- Target file: `[working directory]/[File].pa.yaml`
- YAML key: [key]
- Control name prefix: [Prefix]

## Specification

### Change and Preservation Contract

[When adding this screen during EDIT, include its slice of the approved delta, allowed changes, preserved app behavior/style/bindings, affected dependencies, assumptions and evidence from `${PLUGIN_ROOT}/references/EditConformance.md`. Do not treat a new screen as permission to recreate the app.]

- Purpose: [description]
- Layout: [composition intent citing `ResponsiveRoot` and `NestedVisibleChildren`.
  For record rows, name the canonical human-readable identity field and text presentation that
  renders its full value, then define how that text, status, and required lifecycle
  actions remain visible or immediately reachable on phone. Avatar initials do not
  satisfy identity. When review requires both Approve and Reject/Decline, keep both
  decisions on the same eligible row or same immediately reachable detail; do not drop
  one to fit the layout.]
- Applied policies: [TouchTarget44, HorizontalReflow, FieldGroups, GalleryRows,
  ScrollableRoot, LongestLabelFit, ContrastPairs as needed]
- Breakpoint source: [shared width binding when required, otherwise local coordination intent;
  builder selects formulas and proves every reachable branch combination]
- Instance-specific measurements: [known viewport/data/text bounds and preserved/shared dimensions;
  protected amount/Save/receipt-mode or preserved-feedback regions; builder proves numeric budgets]
- Text fit: [single-line or wrapping requirements and longest required values; builder proves final width/height fit]
- Visual hierarchy: [title, section, body, caption, primary action, and focal content
  roles copied from the shared Visual Contract]
- Core visualization: [bound source, meaningful first-render records, relationship or
  comparison encoding, populated controls, and truthful empty state; omit only when this
  screen owns no core visualization]
- Grid contract: [item/data bounds, ordering, responsive column intent, minimum usable cell size,
  and overflow/reachability constraints; builder reads GridLayoutGuide and chooses final formulas; omit when there is no GridLayout]
- Controls: [local roles and purpose; exact names for shared interfaces only]
- Column headers: [for any grid or repeated row of inputs, the exact visible header
  strings — "Mon", "Tue", … . A row of identical unlabelled inputs is unusable, and
  `AccessibleLabel` is not a substitute for a visible header. Omit if the screen has no
  repeated input row.]
- Data binding: [sources, fields and variables; identify small screen-local read-only
  tables that stay inline in `Items`, versus shared or mutable collections owned by App.
  For entities with multiple date/status fields, define which field drives each visible
  view and ensure displayed labels, seed data and filters use that same meaning.]
- Navigation: [targets and triggers]
- State: [stable shared names/types and initialization/reset semantics; builder owns local initialization formulas]

## Required Record Fields

| Field key                         | Record surface | Required field | Source field | Bound control | Exact formula | Placement and visibility |
| --------------------------------- | -------------- | -------------- | ------------ | ------------- | ------------- | ------------------------ |
| [key copied from the plan index]  | [Card/row/detail] | [Visible meaning] | [Record field and type] | [Local role or shared control name] | [Local binding intent; exact shared/literal binding when required] | [Placement, text fit, normal-state visibility constraints] |

[Copy every Required Record Fields row owned by this screen. Each row specifies the visible role inside the record surface, source fields/types, and presentation requirements. The builder chooses local controls/formulas and returns exact bindings with normal-state layout evidence. A combined control may satisfy
multiple rows only when its final formula references every named source field. Do not replace
requested text with an icon, tooltip, accessible label, record ID, or time-only summary.]

## State-Driven Surface Visibility

[Copy every plan row owned by this screen. Implement whole-surface `Visible` gating with the required state semantics. Preserve exact shared/literal predicates when specified, or prove permitted Boolean equivalence. Do not substitute child visibility or navigation; return the final named surface and exact predicate.]

| Surface key | Surface control | State predicate | Visible and hidden states |
| ----------- | --------------- | --------------- | ------------------------- |
| [key copied from plan] | [Local surface role or shared name] | [Required state semantics; exact shared/literal predicate when required] | [Both states] |

## Required Actions

| Action                              | Preconditions    | Entry point and event                                   | Source and stable ID                          | Transition and postcondition                  | Mutation write set                   | Receipt proof set                                 | Observer and evidence                                    |
| ----------------------------------- | ---------------- | ------------------------------------------------------- | --------------------------------------------- | --------------------------------------------- | ------------------------------------ | ------------------------------------------------- | -------------------------------------------------------- |
| [Action copied from the plan index] | [Eligible state] | [Local entry role and event or shared control event] | [Named source, field types, and immutable identity, or N/A] | [Required operation and resulting state] | [Every changed field/status, or N/A] | [Feedback: Receipt - identity and fields to render; Feedback: Preserve - existing-action identity and static write proof; nonmutation: N/A] | [Required post-state observation and immediate receipt, or existing feedback/observer bindings to preserve] |

[Copy every Action Contract owned by this screen. Include input semantics, source operation, event role, and required evidence; retain exact existing/shared bindings. For
create/edit, include finite-choice values and defaults, stable identity, prepopulation,
save-by-ID, reset, cancel behavior, and the feedback mode from `${PLUGIN_ROOT}/references/MutationBehavior.md`. New mutations need Receipt-mode immediate result fields and visibility lifecycle; integration with an existing Preserve-mode action retains its feedback/observers and static field proof without new UI or focus. Builders choose local bindings. Preserve write-set/proof-set
parity from the Action Contract. Expand every success, boundary, rejection, persistence,
and recalculation path assigned by the plan. Keep paired review decisions as separate rows
but require both controls on the same eligible record surface.]

## Data Entry Label Contracts

| Required input | Persistent visible label | Shared field region |
| -------------- | ------------------------ | ------------------- |
| [input role or shared name owned by this screen] | [Required visible text; native visible Label only for ModernNumberInput] | [Immediate-parent field grouping intent] |

[Copy every plan-index Data Entry Label Contract owned by this screen. Specify required input/label semantics and co-location; the builder chooses local names, bindings, and grouping and returns their actual final evidence.]

## Mutation Lifecycle Evidence

[Copy every mutation lifecycle row owned or observed by this screen, including feedback mode, canonical/requested-destination observation, same-ID trace, and synchronization when sources differ. Include Receipt-mode result/focus intent or exact existing feedback/observer/focus contracts to preserve.]

## Mutation Field Ledger

[Copy every mutation field-ledger row owned by this screen. Keep each Changed field aligned
with the Required Action write set, mode-specific proof set, and observer. Implement
each Preserved row from canonical pre-state and retain its post-state evidence.]

## Continuation Contracts

[Copy this section only when the screen creates a record for a later
edit/delete/relationship/approval/transition or owns that later action. Bind the
continuation to the returned stable ID and implement both successful-completion and
cancellation clearing.]

## Functional Test Scenarios

| Scenario                              | Given            | When                      | Then                   | Evidence surface                           | Boundary or negative case            |
| ------------------------------------- | ---------------- | ------------------------- | ---------------------- | ------------------------------------------ | ------------------------------------ |
| [Scenario copied from the plan index] | [Concrete state] | [Concrete visible interaction] | [Source postcondition] | [Local/downstream observer and mode-specific feedback] | [Required boundary behavior, or N/A] |

[Copy every Functional Test Matrix row exercised by this screen. The builder must be able
to implement and trace each row through its final formulas without reading another brief.]

## Imagery Assignments

[Copy this screen's rows from the shared plan, including the exact URL or media asset name,
target control or purpose, fit/crop intent, and accessible label. Write "None" only when
the shared plan assigns no imagery to this screen.]

## Relevant Data Source Schemas

[Exact source/field names, types, stable key, and relevant constraints for fields this screen reads, writes, or preserves; omit if none]

## Relevant API Details

[Only the operations and parameters this screen calls; omit if none]

## Required Variants

[Control type -> exact variant to use, for every control type whose definition includes a
Variants section; omit if none]

## Control Decisions

[Exact describe_control query identity, target roles, selected variant and material feasibility constraints for each type. The builder describes selected controls directly for creation keywords, supported inputs/outputs and enum syntax. Do not copy property inventories or control-definition snapshots.]
```
