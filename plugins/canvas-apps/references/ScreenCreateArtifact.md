# CREATE Screen Brief Artifact

Project one Create dispatch row into its compatible `[working directory]/*.screen-plan.md` builder brief. Keep it self-sufficient with the shared plan.

## Screen Brief — CREATE

```markdown
# Screen Plan: [Logical Screen]

## Assignment

- Action: Create
- Target file: `[working directory]/[File].pa.yaml`
- YAML key: [key]
- Control name prefix: [Prefix]

## Specification

- Purpose: [description]
- Layout: [root and child structure citing `ResponsiveRoot` and `NestedVisibleChildren`.
  For record rows, name the canonical human-readable identity field and text binding that
  renders its full value, then define how that text, status, and required lifecycle
  actions remain visible or immediately reachable on phone. Avatar initials do not
  satisfy identity. When review requires both Approve and Reject/Decline, keep both
  decisions on the same eligible row or same immediately reachable detail; do not drop
  one to fit the layout.]
- Applied policies: [TouchTarget44, HorizontalReflow, FieldGroups, GalleryRows,
  ScrollableRoot, LongestLabelFit, ContrastPairs as needed]
- Breakpoint source: [one screen-level width expression used by coordinated parent Height,
  nested child LayoutDirection, and related formulas; if sources differ, enumerate every
  reachable cross-branch combination]
- Instance-specific measurements: [available width, longest label, gallery
  Height/TemplateSize, named color pair, protected amount/Save/receipt controls]
- Text fit: [single-line or wrapping behavior and longest-value width/height budget for
  each text-bearing control]
- Visual hierarchy: [title, section, body, caption, primary action, and focal content
  roles copied from the shared Visual Contract]
- Core visualization: [bound source, meaningful first-render records, relationship or
  comparison encoding, populated controls, and truthful empty state; omit only when this
  screen owns no core visualization]
- Grid contract: [for each GridLayout, exact columns, rows, column minimum, row minimum,
  height and child-position formulas; omit when there is no GridLayout]
- Controls: [prefixed control names and purpose]
- Column headers: [for any grid or repeated row of inputs, the exact visible header
  strings — "Mon", "Tue", … . A row of identical unlabelled inputs is unusable, and
  `AccessibleLabel` is not a substitute for a visible header. Omit if the screen has no
  repeated input row.]
- Data binding: [sources, fields and variables; identify small screen-local read-only
  tables that stay inline in `Items`, versus shared or mutable collections owned by App.
  For entities with multiple date/status fields, define which field drives each visible
  view and ensure displayed labels, seed data and filters use that same meaning.]
- Navigation: [targets and triggers]
- State: [OnVisible initialization]

## Required Record Fields

| Field key                         | Record surface | Required field | Source field | Bound control | Exact formula | Placement and visibility |
| --------------------------------- | -------------- | -------------- | ------------ | ------------- | ------------- | ------------------------ |
| [key copied from the plan index]  | [Card/row/detail] | [Visible meaning] | [Record field] | [Prefixed control] | [Exact binding] | [Hierarchy, sizing, normal-state visibility] |

[Copy every Required Record Fields row owned by this screen. Each row names a concrete
visible control inside the record surface, its exact formula, and enough layout detail to
prove that the value is visible in the normal state. A combined control may satisfy
multiple rows only when its formula references every named source field. Do not replace
requested text with an icon, tooltip, accessible label, record ID, or time-only summary.]

## State-Driven Surface Visibility

[Copy every plan row owned by this screen. Implement the named surface control's own
`Visible` property with the exact planned predicate or a provably equivalent Boolean
form. Do not substitute child visibility or navigation.]

| Surface key | Surface control | State predicate | Visible and hidden states |
| ----------- | --------------- | --------------- | ------------------------- |
| [key copied from plan] | [Prefixed surface control] | [Exact `=state predicate`] | [Both states] |

## Required Actions

| Action                              | Preconditions    | Entry point and event                                   | Source and stable ID                          | Transition and postcondition                  | Mutation write set                   | Receipt proof set                                 | Observer and evidence                                    |
| ----------------------------------- | ---------------- | ------------------------------------------------------- | --------------------------------------------- | --------------------------------------------- | ------------------------------------ | ------------------------------------------------- | -------------------------------------------------------- |
| [Action copied from the plan index] | [Eligible state] | [Visible entry and PrefixedControl.OnSelect / OnChange] | [Named source and immutable identity, or N/A] | [Exact formula operation and resulting state] | [Every changed field/status, or N/A] | [Identity plus every labeled bound value, or N/A] | [Formula/control reading the source plus visible result] |

[Copy every Action Contract owned by this screen. Include the exact input, binding, event,
source operation, and immediate visible evidence needed to implement each row. For
create/edit, include finite-choice values and defaults, stable identity, prepopulation,
save-by-ID, reset, cancel behavior, and the in-viewport mutation receipt's control,
visibility state, and labeled binding for every proof-set field. Preserve write-set/proof-set
parity from the Action Contract. Expand every success, boundary, rejection, persistence,
and recalculation path assigned by the plan. Keep paired review decisions as separate rows
but require both controls on the same eligible record surface.]

## Data Entry Label Contracts

| Required input | Persistent visible label | Shared field region |
| -------------- | ------------------------ | ------------------- |
| [input owned by this screen] | [exact sibling label binding; native visible Label only for ModernNumberInput] | [immediate parent field row/group containing both] |

[Copy every plan-index Data Entry Label Contract owned by this screen. Name the exact
input, label control and binding, and their shared immediate parent so the builder can
implement the contract without reading the plan index.]

## Mutation Lifecycle Evidence

[Copy every mutation lifecycle row owned or observed by this screen from the plan index, including the
receipt, canonical observer, requested destination observer, same-ID trace,
synchronization step when sources differ, and destination focus.]

## Mutation Field Ledger

[Copy every mutation field-ledger row owned by this screen. Keep each Changed field aligned
with the Required Action write set, proof set, receipt binding, and observer. Implement
each Preserved row from canonical pre-state and retain its post-state evidence.]

## Continuation Contracts

[Copy this section only when the screen creates a record for a later
edit/delete/relationship/approval/transition or owns that later action. Bind the
continuation to the returned stable ID and implement both successful-completion and
cancellation clearing.]

## Functional Test Scenarios

| Scenario                              | Given            | When                      | Then                   | Evidence surface                           | Boundary or negative case            |
| ------------------------------------- | ---------------- | ------------------------- | ---------------------- | ------------------------------------------ | ------------------------------------ |
| [Scenario copied from the plan index] | [Concrete state] | [Exact local interaction] | [Source postcondition] | [Local or downstream observer and receipt] | [Required boundary behavior, or N/A] |

[Copy every Functional Test Matrix row exercised by this screen. The builder must be able
to trace each row through concrete formulas without reading another brief.]


## Relevant Data Source Schemas

[Only the fields this screen reads or writes; omit if none]

## Relevant API Details

[Only the operations and parameters this screen calls; omit if none]

## Required Variants

[Control type -> exact variant to use, for every control type whose definition includes a
Variants section; omit if none]

## Control Definitions

[For each control type used on this screen: the complete list of valid input property
names, plus the full enum name for each enum property this screen sets. Not the whole
describe_control response.

Give each enum property the **compile-ready literal**, not a list of members. Write
`Precision: =DecimalPrecision.'1'`, never `Enum name: DecimalPrecision; values: 0, 1, 2`.
A member list is transcribed literally by the builder and a member starting with a digit
then fails to compile.]
```
