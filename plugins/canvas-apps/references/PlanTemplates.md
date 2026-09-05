# Canvas App Plan Templates

The planner writes three artifact types:

1. `[working directory]/canvas-app-plan.md` — compact orchestration index
2. `[working directory]/canvas-app-shared.md` — cross-screen conventions
3. `[working directory]/[target-base].screen-plan.md` — one implementation brief per screen

## Contents

- Plan Index — CREATE
- Plan Index — EDIT
- Shared Plan
- Screen Brief — CREATE
- Screen Brief — MODIFY

## Plan Index — CREATE

```markdown
# Canvas App Plan

## Mode

CREATE

## Requirements

[Original requirements]

## Requirement Coverage

| Requirement                                     | Planned affordance                   | Fidelity                        |
| ----------------------------------------------- | ------------------------------------ | ------------------------------- |
| [Concrete noun or interaction from the request] | [Visible control and exact behavior] | Exact / Approximation: [reason] |

## Action Contracts

| Requested action            | Preconditions                             | Entry point                            | Owner screen | Control and event                     | Source and stable ID                          | Transition and postcondition                 | Mutation write set                   | Receipt proof set                                          | Observer and evidence                                              |
| --------------------------- | ----------------------------------------- | -------------------------------------- | ------------ | ------------------------------------- | --------------------------------------------- | -------------------------------------------- | ------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| [Concrete requested action] | [Eligible state and enabled/visible rule] | [Visible control the user starts from] | [Screen]     | [PrefixedControl.OnSelect / OnChange] | [Named source and immutable identity, or N/A] | [Exact operation and resulting source state] | [Every changed field/status, or N/A] | [Identity plus every value rendered after success, or N/A] | [Formula/control reading the post-state plus in-viewport evidence] |

[Include only actions stated by the request or approved plan and apply the relevant
acceptance paths from `${PLUGIN_ROOT}/references/BehaviorGuide.md`. Do not infer universal CRUD for
supporting entities. Role-scoped management of all primary records requires separate
list/select, edit/save, and remove/cancel rows. Keep other requested actions separate,
including paired approve and reject decisions. Add supporting setup only when required to
exercise requested behavior over local/mock data. For create/edit, include inputs, finite
choices, defaults, stable identity, prepopulation, cancel behavior, and a deterministic
post-save mutation receipt bound to the changed ID. For every mutation, enumerate the write
set and proof set. A create/edit proof set must contain every user-entered or user-selected
field in the write set. Name the receipt control, visibility state, and labeled binding for
each proof-set field. Do not use navigation, a notification, or a row somewhere in a longer
list as the Observable result.]

## Functional Test Matrix

| Scenario                 | Given                                   | When                                | Then                         | Evidence surface                              | Boundary or negative case                                     |
| ------------------------ | --------------------------------------- | ----------------------------------- | ---------------------------- | --------------------------------------------- | ------------------------------------------------------------- |
| [Action-path identifier] | [Deterministic seed and eligible state] | [Exact visible control interaction] | [Exact source postcondition] | [Observer formula/control and receipt fields] | [Blocked, empty, invalid, clear, or failure behavior, or N/A] |

[Include at least one success scenario for every Action Contract and one row for every
required boundary or negative path. Use concrete seeded IDs and values when the app uses
local/mock data. Every Then clause must be provable from the named source through the
Evidence surface; do not use appearance, navigation, or notification as proof.]

## Working Directory

[absolute working directory]

## Discovery Summary

- Controls: [relevant controls]
- Data sources: [used sources or none]
- Connectors: [used connectors or none]

## Dispatch

| Action | Screen       | Target File            | YAML Key | Name Prefix | Screen Brief                  |
| ------ | ------------ | ---------------------- | -------- | ----------- | ----------------------------- |
| Create | [Landing]    | `[working directory]/Screen1.pa.yaml` | Screen1  | [Prefix]    | `[working directory]/Screen1.screen-plan.md` |
| Create | [Additional] | `[working directory]/[Name].pa.yaml`  | [Name]   | [Prefix]    | `[working directory]/[Name].screen-plan.md`  |

## Editor State Changes

[Exact final ScreensOrder and ComponentDefinitionsOrder lists, or "None"]
```

## Plan Index — EDIT

```markdown
# Canvas App Plan

## Mode

EDIT

## Requirements

[Original edit requirements]

## Requirement Coverage

| Requirement                                     | Planned affordance                   | Fidelity                        |
| ----------------------------------------------- | ------------------------------------ | ------------------------------- |
| [Concrete noun or interaction from the request] | [Visible control and exact behavior] | Exact / Approximation: [reason] |

## Action Contracts

| Requested action            | Preconditions                             | Entry point                            | Owner screen | Control and event                     | Source and stable ID                          | Transition and postcondition                 | Mutation write set                   | Receipt proof set                                          | Observer and evidence                                              |
| --------------------------- | ----------------------------------------- | -------------------------------------- | ------------ | ------------------------------------- | --------------------------------------------- | -------------------------------------------- | ------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| [Concrete requested action] | [Eligible state and enabled/visible rule] | [Visible control the user starts from] | [Screen]     | [PrefixedControl.OnSelect / OnChange] | [Named source and immutable identity, or N/A] | [Exact operation and resulting source state] | [Every changed field/status, or N/A] | [Identity plus every value rendered after success, or N/A] | [Formula/control reading the post-state plus in-viewport evidence] |

[Include only actions stated by the request or approved plan. Preserve unaffected existing
actions, and do not expand the edit into universal CRUD. Preserve the semantic contracts
for role-scoped primary-record management, paired review decisions, requested periods or
cycles, and requested export/report output.]

## Functional Test Matrix

| Scenario                     | Given                     | When                        | Then                                       | Evidence surface                      | Boundary or negative case                    |
| ---------------------------- | ------------------------- | --------------------------- | ------------------------------------------ | ------------------------------------- | -------------------------------------------- |
| [Changed or regression path] | [Current or seeded state] | [Exact visible interaction] | [Exact preserved or changed postcondition] | [Observer/control reading the source] | [Required failure/boundary behavior, or N/A] |

[Cover every changed Action Contract and every existing action whose source, fields,
controls, or observer are touched by this edit. This is the regression contract.]

## Working Directory

[absolute working directory]

## Discovery Summary

- Existing screens: [names]
- Layout: [ManualLayout / AutoLayout / mixed]
- Data sources: [used sources or none]

## Dispatch

| Action | Screen     | Target File           | YAML Key       | Name Prefix | Screen Brief                 |
| ------ | ---------- | --------------------- | -------------- | ----------- | ---------------------------- |
| Modify | [Existing] | `[working directory]/[File].pa.yaml` | [existing key] | [Prefix]    | `[working directory]/[File].screen-plan.md` |
| Create | [New]      | `[working directory]/[File].pa.yaml` | [new key]      | [Prefix]    | `[working directory]/[File].screen-plan.md` |

## App Changes

### Before builders

[Shared definitions screens bind to — collections, named formulas, app variables, OnStart
seed data — or "None"]

### After builders

[Changes referencing screens that do not exist yet, such as StartScreen — or "None"]

## Editor State Changes

[Exact final ScreensOrder and ComponentDefinitionsOrder lists, or "None"]
```

## Shared Plan

```markdown
# Canvas App Shared Plan

## Aesthetic Direction

- Palette: [description]
- Primary background: RGBA([...])
- Accent: RGBA([...])
- Text primary: RGBA([...])
- Text secondary: RGBA([...])
- Typography: [scale and weights]

## Visual Contract

- Type roles: [exact title, section-heading, body, caption sizes and weights]
- Spacing scale: [approved gap and padding values]
- Surfaces: [page, panel, card, border, and shadow treatment]
- Actions: [exact primary, secondary, destructive, and disabled treatment]
- Density: [desktop, tablet, and phone composition rules]

## Layout Strategy

[Shared layout rules and target-device rationale. Record the breakpoint formulas and the
rule that responsive properties derive from current width rather than `OnVisible`
variables.]


## Named State

[Variables, named formulas, collections, and ownership]

## Control Naming

[Standard control-type abbreviations followed by the per-screen namespace, such as
`conDiscNavBar` and `btnDetailBack`, plus the rule that repeated UI blocks are
instantiated under each screen's own namespace]

## Cross-Screen Contracts

[Navigation targets and shared state expectations. For repeated navigation blocks, list
the exact items in order and prohibit extra screen-specific children. Use ModernButtons
for cross-screen navigation; reserve ModernTabList for panels within one screen.]

## YAML Conventions

- Formula prefix
- Multi-line formula syntax
- String and record-literal quoting
- Enum escaping
- App-specific conventions
```

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
- Layout: [root and child structure. For each fixed-height section and horizontal row
  with four or more substantive children, include a desktop/narrow/phone budget with
  child grouping, minimum widths/heights, gaps, padding and resulting section size.
  Prove all visible children remain inside their parent and do not overlap at each target
  width. The sole responsive root must use exact `Width: =Parent.Width`,
  `Height: =Parent.Height`, `LayoutMinWidth: =0`, and `LayoutMinHeight: =0`; breakpoint
  sizing belongs only on descendants. For record rows, name the canonical human-readable
  identity field and text binding that renders its full value, then define how that text,
  status, and required lifecycle actions remain visible or immediately reachable on phone.
  Avatar initials do not satisfy identity. When review requires both Approve and
  Reject/Decline, keep both decisions on the same eligible row or same immediately reachable
  detail; do not drop one to fit the layout.]
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

- Responsive bounds: [desktop, tablet, and phone width/height budgets for changed regions]
- Text fit: [longest-value budget for changed text-bearing controls]
- Visual contract: [shared type, spacing, surface, and action roles that changed controls
  must preserve]
- Record presentation: [canonical identity field and full visible text binding; placement
  of paired review decisions on each eligible record, or N/A]

## Controls to Add

[Name, type, placement, properties; or "None"]

## Controls to Remove

[Names; or "None"]

## Properties to Update

[Control -> property -> exact value; or "None"]

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
