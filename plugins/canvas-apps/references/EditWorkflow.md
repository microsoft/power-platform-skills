# Edit Workflow

Use this workflow only when `[working directory]` already has meaningful content.

## 1. Assess Complexity

Read all `[working directory]/*.pa.yaml` files.

Treat the edit as **simple** only when all are true:

- At most two property mutations in total, across at most two existing controls
- At most one screen changes
- No new screen, data source, or connector
- No structural layout change

Anything else is **complex**.

## 2. Simple Edit

1. Read `${PLUGIN_ROOT}/references/YamlSyntax.md`. Also read `${PLUGIN_ROOT}/references/ControlGuide.md` when the edit
   touches control properties or enums, and `${PLUGIN_ROOT}/references/LayoutGuide.md` when it touches
   sizing, scrolling, or colour.
2. Use `describe_control` before adding a property not already present on that control.
3. Apply targeted edits directly to the `[working directory]` folder.
4. Read `${PLUGIN_ROOT}/references/ValidationWorkflow.md` and follow it.
5. Stop after the final summary; do not invoke planner or builder agents.

## 3. Complex Edit Planning

Read:

- `${PLUGIN_ROOT}/references/YamlSyntax.md` — file structure, syntax rules, parse-error triage
- `${PLUGIN_ROOT}/references/ControlGuide.md` — control selection, per-control properties, enums
- `${PLUGIN_ROOT}/references/LayoutGuide.md` — responsive layout, scrolling, colour contrast
- `${PLUGIN_ROOT}/references/PowerFxGuide.md` — state, events, named formulas, mock data
- `${PLUGIN_ROOT}/references/DesignGuide.md` — aesthetic direction and design process

Determine:

- Screens to modify and exact changes
- Screens to create
- Existing palette, layout strategy, variables, and data bindings to preserve
- New controls, data sources, connectors, or shared state
- Required changes to `[working directory]/App.pa.yaml`

Present:

```markdown
## Canvas Edit Plan

### Screens to Modify
| Action | Screen | File | Summary |
|--------|--------|------|---------|
| Modify | [Name] | [Name].pa.yaml | [changes] |

### Screens to Add
| Action | Screen | File | Purpose |
|--------|--------|------|---------|
| Create | [Name] | [Name].pa.yaml | [purpose] |

### App Changes
[Exact App.pa.yaml changes, or "None"]

### Approach
[How the edit preserves and extends the current app]
```

Wait for user approval. Revise and re-present if requested.

## 4. Invoke the Planner

Invoke the `canvas-app-planner` agent with `Task` and:

```text
Mode: EDIT
Working directory: `[working directory]`
Plan index: `[working directory]/canvas-app-plan.md`
Shared plan: `[working directory]/canvas-app-shared.md`
Edit requirements: [user requirements]
Approved plan: [full approved plan]
Current app state: [palette, variables, layout, screens, controls]
Synced files: [absolute working-directory paths]
```

The planner writes the plan index, shared plan, and one screen brief per dispatch row. It
does not edit any `.pa.yaml` file in EDIT mode.

Wait for the planner to finish, then return to **Planned Build Handoff** in the
`canvas-app` skill.
