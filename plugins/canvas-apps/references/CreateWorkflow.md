# Create Workflow

Use this workflow only when the working directory has no meaningful screen content.

## 1. Read Guidance

Read:

- `${PLUGIN_ROOT}/references/YamlSyntax.md` — file structure, syntax rules, parse-error triage
- `${PLUGIN_ROOT}/references/ControlGuide.md` — control selection, per-control properties, enums
- `${PLUGIN_ROOT}/references/LayoutGuide.md` — responsive layout, scrolling, colour contrast
- `${PLUGIN_ROOT}/references/PowerFxGuide.md` — state, events, named formulas, mock data
- `${PLUGIN_ROOT}/references/DesignGuide.md` — aesthetic direction and design process

## 2. Design the App

Determine:

- Screen count, purpose, and navigation
- Controls and layout strategy for each screen
- Data sources, connectors, collections, or mock data
- Aesthetic direction with exact RGBA values
- Target device and users

Use AutoLayout for phone, tablet, multi-device, or unknown targets. ManualLayout is
acceptable for desktop-only, fixed dashboards.

The landing screen must reuse `[working directory]/Screen1.pa.yaml`; every additional
screen gets a new file.

## 3. Present the Plan

Use this format:

```markdown
## Canvas App Plan

### Screens
| Action | Screen | File | Purpose | Key Controls |
|--------|--------|------|---------|--------------|
| Create | [Landing] | Screen1.pa.yaml | [purpose] | [controls] |
| Create | [Additional] | [Name].pa.yaml | [purpose] | [controls] |

### Data Strategy
[Data sources, connectors, collections, or mock data]

### Aesthetic Direction
[Direction and exact RGBA palette]
```

Wait for user approval. Revise and re-present if requested.

## 4. Invoke the Planner

Invoke the `canvas-app-planner` agent with `Task` and:

```text
Mode: CREATE
Working directory: [absolute working directory]
Plan index: [working directory]/canvas-app-plan.md
Shared plan: [working directory]/canvas-app-shared.md
Requirements: [user requirements]
Approved plan: [full approved plan]
Target users and device: [stated or inferred]
```

The planner discovers resources, writes `[working directory]/App.pa.yaml`, the plan index,
shared plan, and one screen brief per dispatch row. It does not redesign the approved
plan.

Wait for the planner to finish, then return to **Planned Build Handoff** in the
`canvas-app` skill.
