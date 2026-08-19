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
| Requirement | Planned affordance | Fidelity |
|-------------|--------------------|----------|
| [Concrete noun or interaction from the request] | [Visible control and exact behavior] | Exact / Approximation: [reason] |

## Action Contracts
| Requested action | Entry point | Owner screen | Control and event | Required behavior | Observable result |
|------------------|-------------|--------------|-------------------|-------------------|-------------------|
| [Concrete prompt- or approved-plan-derived action] | [Visible control the user starts from] | [Screen] | [PrefixedControl.OnSelect / OnChange] | [Exact navigation, filter, search, mutation, or state transition] | [Visible persisted outcome in a list, detail, filter, dashboard, or confirmation] |

[Include only actions stated by the request or approved plan. Do not infer universal CRUD
for every supporting entity from broad words such as "manage". However, role-scoped
management of all primary records implies reachable list/detail, correction/update, and
remove/cancel flows for those records. Decompose each included action into its complete
reachable flow; do not combine create, edit, delete, search, filter, review, or approval
into one row. A meaningful review workflow requires separate approve and reject/decline
contracts. A requested period or cycle requires a visible selector/filter and period-bound
results. A requested export or report requires a visible trigger and observable output
whose contents match the requested view. Include minimum supporting setup actions when
they are necessary to exercise an explicitly requested mutation, metric, relationship,
comparison, or ranking over local/mock data.]

## Working Directory
[absolute working directory]

## Discovery Summary
- Controls: [relevant controls]
- Data sources: [used sources or none]
- Connectors: [used connectors or none]

## Dispatch
| Action | Screen | Target File | YAML Key | Name Prefix | Screen Brief |
|--------|--------|-------------|----------|-------------|--------------|
| Create | [Landing] | [working directory]/Screen1.pa.yaml | Screen1 | [Prefix] | [working directory]/Screen1.screen-plan.md |
| Create | [Additional] | [working directory]/[Name].pa.yaml | [Name] | [Prefix] | [working directory]/[Name].screen-plan.md |
```

## Plan Index — EDIT

```markdown
# Canvas App Plan

## Mode
EDIT

## Requirements
[Original edit requirements]

## Requirement Coverage
| Requirement | Planned affordance | Fidelity |
|-------------|--------------------|----------|
| [Concrete noun or interaction from the request] | [Visible control and exact behavior] | Exact / Approximation: [reason] |

## Action Contracts
| Requested action | Entry point | Owner screen | Control and event | Required behavior | Observable result |
|------------------|-------------|--------------|-------------------|-------------------|-------------------|
| [Concrete prompt- or approved-plan-derived action] | [Visible control the user starts from] | [Screen] | [PrefixedControl.OnSelect / OnChange] | [Exact navigation, filter, search, mutation, or state transition] | [Visible persisted outcome in a list, detail, filter, dashboard, or confirmation] |

[Include only actions stated by the request or approved plan. Preserve unaffected existing
actions, and do not expand the edit into universal CRUD. Preserve the semantic contracts
for role-scoped primary-record management, paired review decisions, requested periods or
cycles, and requested export/report output.]

## Working Directory
[absolute working directory]

## Discovery Summary
- Existing screens: [names]
- Layout: [ManualLayout / AutoLayout / mixed]
- Data sources: [used sources or none]

## Dispatch
| Action | Screen | Target File | YAML Key | Name Prefix | Screen Brief |
|--------|--------|-------------|----------|-------------|--------------|
| Modify | [Existing] | [working directory]/[File].pa.yaml | [existing key] | [Prefix] | [working directory]/[File].screen-plan.md |
| Create | [New] | [working directory]/[File].pa.yaml | [new key] | [Prefix] | [working directory]/[File].screen-plan.md |

## App Changes
### Before builders
[Shared definitions screens bind to — collections, named formulas, app variables, OnStart
seed data — or "None"]
### After builders
[Changes referencing screens that do not exist yet, such as StartScreen — or "None"]
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
- Target file: [working directory]/[File].pa.yaml
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
  sizing belongs only on descendants.]
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
| Action | Entry point | Control and event | Required formula behavior | Observable result |
|--------|-------------|-------------------|---------------------------|-------------------|
| [Action copied from the plan index] | [Visible local entry point] | [PrefixedControl.OnSelect / OnChange] | [Exact formula operation or binding] | [What the user sees after completion] |

[Copy every Action Contract owned by this screen. For search and filter actions, name the
input and the Items formula fields it affects. For mutations, name the data operation, target
source or collection, refresh/update behavior, and visible control that proves the result.
For constraints and advanced behaviors, include separate rows for every required success,
boundary, rejection, persistence, and recalculation path from the plan. Give approve and
reject/decline separate rows. For period/cycle actions, name the selector, bound field, and
result control. For export/report actions, name the trigger, exported scope, output format,
and visible success or download evidence. For every mutation, state how its bound
observable result is visible immediately after the handler: in the current viewport,
through handler navigation, or through an immediately visible entry control.]

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
- Target file: [working directory]/[File].pa.yaml
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

## Controls to Add
[Name, type, placement, properties; or "None"]

## Controls to Remove
[Names; or "None"]

## Properties to Update
[Control -> property -> exact value; or "None"]

## Required Actions
| Action | Entry point | Control and event | Required formula behavior | Observable result |
|--------|-------------|-------------------|---------------------------|-------------------|
| [Action copied from the plan index] | [Visible local entry point] | [Prefixed or preserved Control.OnSelect / OnChange] | [Exact formula operation or binding] | [What the user sees after completion] |

[Copy every Action Contract affected by this screen. Preserve unaffected actions. For
mutations, identify the target source or collection and the visible post-action result.
For constraints and advanced behaviors, include separate rows for every changed success,
boundary, rejection, persistence, and recalculation path. For every mutation, state how
the changed record is visible in the immediate post-action state or reached by explicit
navigation in the handler.]

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
