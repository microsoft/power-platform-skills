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
  child grouping, minimum widths/heights, gaps, padding and resulting section size.]
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

## Controls to Add
[Name, type, placement, properties; or "None"]

## Controls to Remove
[Names; or "None"]

## Properties to Update
[Control -> property -> exact value; or "None"]

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
