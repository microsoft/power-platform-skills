# Create Workflow

Use this workflow only when `[working directory]` has no meaningful screen content.

## 1. Read Guidance

Read:

- `${PLUGIN_ROOT}/references/YamlSyntax.md` — file structure, syntax rules, parse-error triage
- `${PLUGIN_ROOT}/references/ControlGuide.md` — control selection, per-control properties, enums
- `${PLUGIN_ROOT}/references/LayoutGuide.md` — responsive layout, scrolling, color contrast
- `${PLUGIN_ROOT}/references/PowerFxGuide.md` — state, events, named formulas, mock data
- `${PLUGIN_ROOT}/references/DesignGuide.md` — aesthetic direction and design process

## 2. Design the App

Determine:

- Requested capability families from `${PLUGIN_ROOT}/references/BehaviorGuide.md`
- Every user action, precondition, source-of-truth transition, and visible postcondition
- Stable IDs, mutable fields, status values, relationships, and persistence semantics
- Screen count, purpose, and navigation
- Controls and layout strategy for each screen
- Data sources, connectors, collections, or mock data
- Aesthetic direction with exact RGBA values
- Target device and users

Use AutoLayout for phone, tablet, multi-device, or unknown targets. ManualLayout is
acceptable for desktop-only, fixed dashboards.

The landing screen must reuse `[working directory]/Screen1.pa.yaml`; every additional screen gets a new
file.

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
[Data sources, connectors, collections, or mock data; stable IDs; mutable fields; status values; and session versus durable persistence]

### Functional Scope
| Capability | User path | Source transition | Visible success |
|------------|-----------|-------------------|-----------------|
| [Requested behavior] | [Reachable entry point and action] | [Source, stable ID, and exact postcondition] | [Bound receipt plus downstream observer] |

### Aesthetic Direction
[Direction and exact RGBA palette]
```

List every requested behavior in Functional Scope before decorative or optional screens. Do not present the plan as ready when a named action has only a control and no source transition or visible success state.

When the request explicitly identifies itself as a noninteractive automation run and says
that a reasonable plan is pre-approved, construct the complete plan internally and continue
directly to the planner. Do not pause, ask for confirmation, or end the turn after planning.

Otherwise, wait for user approval. Revise and re-present if requested.

## 4. Invoke the Planner


Before delegation, use the top-level skill's MCP connection to call `list_controls`,
`list_apis`, and `list_data_sources`; call `describe_control` for every control type in
the approved plan; and call `describe_api` and `get_data_source_schema` only for APIs and
data sources the plan uses. For Canvas or Code Components, make their `describe_control`
calls last so the packet contains the freshest Studio snapshot. Preserve the exact
results as the discovery packet. Do not delegate these calls: task agents do not
reliably inherit the configured MCP connection.


Invoke the `canvas-app-planner` agent with `Task` and:

```text
Mode: CREATE
Working directory: `[working directory]`
Plan index: `[working directory]/canvas-app-plan.md`
Shared plan: `[working directory]/canvas-app-shared.md`
Plugin root: `${PLUGIN_ROOT}`
Requirements: [user requirements]
Approved plan: [full approved plan]
Target users and device: [stated or inferred]
Discovery packet: [complete results gathered above]
```

The planner uses the discovered resources, writes `[working directory]/App.pa.yaml`, the plan index,
shared plan, and one screen brief per dispatch row. It does not redesign the approved
plan.

If it returns `Status: Discovery Packet Blocked`, gather the named missing result in this
top-level context and re-invoke it with the completed packet. If writing is blocked, apply
its complete inline artifact payloads verbatim as required by the skill before entering
Planned Build Handoff.

Wait for the planner to finish, then return to **Planned Build Handoff** in the
`canvas-app` skill.
