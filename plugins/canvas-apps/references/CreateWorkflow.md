# Create Workflow

Use this workflow only when the user's intent establishes a new app experience, such as a
request to create, design, or build an app. A blank scaffold supports this route, but the
absence of meaningful leaf controls does not select CreateWorkflow by itself. A targeted
mutation against an existing blank screen belongs to EditWorkflow.

Before reading any `/references` file named below, reuse it when its complete contents
were successfully returned earlier in this same context. Do not reread it merely because
a new turn started. Reread only after a failed, partial, truncated, or insufficient prior
result. This rule does not apply to `[working directory]`, whose YAML is synchronized and mutable each
turn. Top-level, planner, and builder contexts are separate; one context cannot assume
that another context loaded a reference.

## 1. Assess Complexity

Treat the request as **Simple CREATE** only when all are true:

- It targets one screen and reuses `[working directory]/Screen1.pa.yaml`.
- It adds at most one interactive leaf control and only a small number of static
  supporting controls.
- It uses no connector, API, data source, collection, gallery, or form.
- It uses no cross-screen navigation, GridLayout, Canvas Component, or Code Component.
- It performs no record mutation.
- Its only behavior is a local variable update or notification.
- Every required control type can be confirmed with `describe_control` before editing.

If any condition is false or uncertain, use **Planned CREATE**.

## 2. Simple Create

Simple CREATE uses the same structural invariants as a bounded structural edit, but starts
from a blank scaffold. For example, "Create an app with a button" uses Simple CREATE when
all complexity conditions above hold and retains responsive-root behavior.

1. Load `${PLUGIN_ROOT}/references/YamlSyntax.md`, `${PLUGIN_ROOT}/references/ControlGuide.md`,
   `${PLUGIN_ROOT}/references/LayoutGuide.md`, and `${PLUGIN_ROOT}/references/LayoutPolicies.md` only when their
   complete contents are not already available in this context. Load
   `${PLUGIN_ROOT}/references/PowerFxGuide.md` only when the request includes behavior and it is not
   already available here.
2. Determine the exact controls, properties, formulas, layout, and RGBA values.
3. Present the single-screen plan using the format in **Present the plan** below and wait
   for approval unless the request explicitly pre-approves a reasonable plan.
4. Call `describe_control` for every required control type.
5. Apply `ResponsiveRoot` and `NestedVisibleChildren`. The landing screen's sole top-level visible child is one AutoLayout root with `Width: =Parent.Width`,
   `Height: =Parent.Height`, `LayoutMinWidth: =0`, `LayoutMinHeight: =0`,
   `LayoutDirection: =LayoutDirection.Vertical`,
   `LayoutAlignItems: =LayoutAlignItems.Stretch`, and
   `LayoutOverflowY: =LayoutOverflow.Scroll`. Nest every visible control inside that
   root. Prefer modern controls. Interactive controls meet `TouchTarget44`.
6. Compute the complete changes to `[working directory]/App.pa.yaml` and `[working directory]/Screen1.pa.yaml` before
   editing. Edit each file at most once when it needs a change.
7. Reuse `${PLUGIN_ROOT}/references/ValidationWorkflow.md` when it was fully read earlier in this
   context; otherwise read it. Follow it, including `compile_canvas` and diagnostic
   repair.
8. Stop after the final summary. Do not invoke `canvas-app-planner` or
   `canvas-screen-builder`. Do not create `[working directory]/canvas-app-plan.md`,
   `[working directory]/canvas-app-shared.md`, screen-plan files, or `[working directory]/canvas-app-acceptance.md`.

## 3. Planned Create

### Read guidance

Load each reference only when its complete contents are not already available in this
context, and read it at most once otherwise:

- `${PLUGIN_ROOT}/references/YamlSyntax.md` — file structure, syntax rules, parse-error triage
- `${PLUGIN_ROOT}/references/ControlGuide.md` — control selection, per-control properties, enums
- `${PLUGIN_ROOT}/references/LayoutGuide.md` — responsive layout, scrolling, color contrast
- `${PLUGIN_ROOT}/references/LayoutPolicies.md` — named layout contracts
- `${PLUGIN_ROOT}/references/PowerFxGuide.md` — state, events, named formulas, mock data
- `${PLUGIN_ROOT}/references/DesignGuide.md` — aesthetic direction and design process

### Design the app

Determine:

- Requested capability families from `${PLUGIN_ROOT}/references/BehaviorCore.md`, with
  `${PLUGIN_ROOT}/references/MutationBehavior.md` and `${PLUGIN_ROOT}/references/DataBehavior.md` loaded only when
  their capability families are present
- Every user action, precondition, source-of-truth transition, and visible postcondition
- Stable IDs, mutable fields, status values, relationships, and persistence semantics
- Screen count, purpose, and navigation
- Controls and layout strategy for each screen
- Data sources, connectors, collections, or mock data
- Aesthetic direction with exact RGBA values
- Target device and users

Use AutoLayout for phone, tablet, multi-device, or unknown targets. Apply
`ResponsiveRoot` from `${PLUGIN_ROOT}/references/LayoutPolicies.md`. ManualLayout is acceptable for
desktop-only, fixed dashboards.

The landing screen must reuse `[working directory]/Screen1.pa.yaml`; every additional screen gets a new
file.

### Present the plan

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


Before delegation, use the top-level skill's MCP connection to gather only the discovery
the approved plan requires:

- Call `list_controls` only when a required control's discovery name is unknown.
- Call `list_apis` only when the plan uses an API or connector.
- Call `list_data_sources` only when the plan uses an external data source.
- Call `describe_control` for every control type in the approved plan.
- Call `describe_api` and `get_data_source_schema` only for APIs and data sources the
  plan uses.

Record an explicit `not required` entry in the discovery packet for every skipped
inventory call. For Canvas or Code Components, make their `describe_control` calls last
so the packet contains the freshest Studio snapshot. Preserve the exact results as the
discovery packet. Do not delegate these calls: task agents do not reliably inherit the
configured MCP connection.


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
