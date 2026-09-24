# Edit Workflow

Use this workflow when the user's intent changes an existing app. This includes a
targeted mutation against an existing `BlankScreen` or `PopulatedScreen`, and an addition
to an existing app that creates a `MissingTargetScreen`. Do not select CreateWorkflow
merely because an existing target screen has no meaningful visible leaf controls.

## 1. Assess EditFootprint

Read the current target screen before choosing a route. Read additional `[working directory]/*.pa.yaml`
files only when the request or routing decision requires their current content. The
reference-reuse contract does not apply to `[working directory]`.

Before reading any `/references` file named below, reuse it when its complete contents
were successfully returned earlier in this same context. Do not reread it merely because
a new turn started. Reread only after a failed, partial, truncated, or insufficient prior
result. A top-level context cannot assume that a planner or builder context loaded a
reference, and those contexts cannot assume that the top-level context loaded one.

Assess the complete `EditFootprint` as one coherent contract before choosing a route. Do
not emit this object as JSON. Record the equivalent fields:

- `existingScreensModified`
- `newScreensCreated`
- `controlsAdded`
- `controlsRemoved`
- `controlsReparented`
- `hierarchyModeChanged`
- `appConfigurationChanged`
- `behaviorKinds`
- `sharedStateIntroduced`
- `dataResourcesIntroduced`
- `mutationsIntroduced`
- `componentKindsIntroduced`
- `discoveryCertainty`
- `existingHierarchyHealth`: `ResponsiveRoot`, `ValidFixedLayout`, `BlankScreen`,
  `MalformedGeneratedHierarchy`, or `Unknown`

Also compose one in-memory `RouteAssessment` before routing. It is a structured decision
record, not a file or emitted JSON. Record:

- `affectedScreens`
- `affectedFiles`
- `screensCreated`
- `requestedLeafControls`
- `newGalleryTemplateCount`
- `localCollections`
- `localVariables`
- `externalDependencies`
- `persistentMutations`
- `stableIdentityCertainty`
- `schemaCertainty`
- `completeChangeSetCertainty`
- `firstFailedGate`
- `selectedRoute`

Behavior kinds are: static presentation, local presentation formulas, direct screen
navigation, notification, local variable update, shared state, lifecycle behavior, data
query, record mutation, and external API invocation. The first five can qualify for
Simple or Bounded Structural Edit. Shared state, lifecycle behavior, and record mutation
can qualify for Bounded Behavioral Edit only through the local-state gates in section 4.

For a possible Bounded Behavioral Edit, compose one `ChangeSet` in working memory before
writing. Do not emit it as JSON or create it as a file. It contains:

- `affectedFiles`
- `stateInitialization`
- `controlPropertyChanges`
- `controlsAdded`
- `behaviorFormulas`
- `stableIdentity`
- `schemaEvidence`
- `applicabilityChecks`
- `runtimeAssumptions`

`Unknown` hierarchy health fails closed to Planned Edit. Classify by semantic coupling and
destructive impact, not by screen count or a named scenario. Do not use a numeric
complexity score.

### Choose the route

Evaluate the gates in this authoritative order:

1. Select **Simple Edit** immediately when every condition in section 2 is true.
2. Only when a Simple Edit gate fails or is uncertain, record the first such gate and
   evaluate **Bounded Structural Edit**. Select it immediately when every gate in section
   3 is true.
3. Only when a Bounded Structural Edit gate fails or is uncertain, record the first such
   gate and evaluate **Bounded Behavioral Edit**. Select it immediately when every gate
   in section 4 is true.
4. Select **Planned Edit** only after a Bounded Behavioral Edit gate fails or is
   uncertain. Record that first failed or uncertain gate in `firstFailedGate`.

When a route is rejected, `firstFailedGate` means that route's first failed or uncertain
gate; replace the prior rejected route's value as evaluation advances. A selected
bounded route therefore retains the reason the immediately preceding route was rejected,
while Planned Edit retains the first failed or uncertain Bounded Behavioral gate.

Set `selectedRoute` once a route succeeds. Stop routing at that point. Later table rows,
examples, capability names, or broad heuristics cannot override a successful earlier
route. A gallery, collection, local record mutation, or lifecycle formula is not by
itself a Planned Edit; its capabilities and certainty determine whether section 4
succeeds.

| Request and starting state | Expected route |
|---|---|
| Add one button or label to existing blank `Screen1` (`BlankScreen`) | Simple Edit |
| Add one button to an existing root container | Simple Edit |
| Add a static label and button to one existing screen | Bounded Structural Edit |
| Add one static screen and a direct navigation button | Bounded Structural Edit |
| Add one destination screen and a Back button | Bounded Structural Edit |
| Add a control to a target screen that does not exist (`MissingTargetScreen`) | Not Simple Edit; use structural routing |
| Bind an existing gallery and checkbox to one local collection, then add a count label | Bounded Behavioral Edit |
| Add one new gallery bound to one bounded local collection, one Checkbox template child that updates local selection, and a same-screen count label | Bounded Behavioral Edit |
| Add a local selected-state counter or filter to one existing screen | Bounded Behavioral Edit |
| Add a gallery backed by an external data source | Planned Edit |
| Change an existing gallery template hierarchy | Planned Edit |
| Add a screen backed by a collection | Planned Edit |
| Add conditional navigation based on a data record | Planned Edit |
| Move existing controls into AutoLayout | Planned Edit |
| Add two new screens | Planned Edit |

Scope is part of every route contract. Do not add visible controls, variables,
collections, mutation receipts, status labels, or other artifacts only to manufacture
acceptance evidence. Every addition must implement requested product behavior or be
required by the control schema. Additional product behavior discovered after routing
requires a fresh `RouteAssessment` and route reassessment before any write.

## 2. Simple Edit

Treat the edit as Simple Edit only when all are true:

- The target screen exists, so `AppStartingState` is `BlankScreen` or `PopulatedScreen`,
  never `MissingTargetScreen`
- At most two property mutations in total, across at most two existing controls, and at
  most one new leaf control
- At most one existing screen changes
- No new screen, data source, or connector
- No control is removed or reparented, and no container, layout mode, or existing control
  hierarchy changes
- Behavior is limited to static presentation, local presentation formulas, notification,
  or local variable update
- The insertion preserves the current hierarchy and layout strategy

Adding one leaf control to the `Children` of an existing screen or container is not a
structural layout change by itself. Keep that edit simple when the insertion can preserve
the current hierarchy and layout strategy. In particular, adding one button or label
directly to an existing blank screen qualifies for Simple Edit when every other condition
above holds.

The common one-leaf path is self-contained:

1. Use the current read of the target screen as the source for the edit. Identify the
   exact existing screen or parent `Children` block and preserve its current hierarchy,
   control family, indentation, and layout mode. Add the new leaf to the current screen or
   to the existing parent that already owns neighboring controls, preserving the current
   hierarchy exactly.
2. Call `describe_control` for the new control. Copy its exact `Control`, `Variant`,
   component, layout, required-property, and enum contracts. Set only properties requested
   by the user or required by that returned schema.
3. Choose a collision-resistant app-wide name that includes a control-type abbreviation,
   a target-screen-specific prefix, and a descriptive role or short suffix. Control names
   are app-wide even when only one screen changes.
4. Choose placement from the current screen read without another reference read or tool
   call. Honor explicit user positioning first. When the existing parent owns child
   placement through AutoLayout, omit `X` and `Y`. Otherwise, place the first leaf in an
   empty manual-layout parent at `X: =24` and `Y: =24`. For an additional leaf, anchor to
   the last existing direct leaf sibling with `X: =PreviousSibling.X` and
   `Y: =PreviousSibling.Y + PreviousSibling.Height + 16`. Replace `PreviousSibling` with
   that sibling's exact control name.
5. Apply one targeted `edit`. The virtual workspace canonicalizes app YAML to LF. Build
   the smallest unique `old_str` from the exact lines returned by the current
   target-screen read and join multiline matches with LF, never CRLF. Prefer a unique
   single-line match when it safely identifies the insertion point. Do not reconstruct
   surrounding content from memory. Keep the change confined to the intended parent.
6. Do not create a container, introduce AutoLayout, convert layout mode, or reparent
   existing controls. Do not require `ResponsiveRoot`, `NestedVisibleChildren`, or another
   layout policy. Keep valid YAML structure and use formula-leading `=` where the schema
   requires a formula.
7. Call `compile_canvas` once. If it succeeds cleanly, return the summary immediately.
8. If the edit explicitly fails because content is stale or `old_str` was not found,
   reread the target screen once, rebuild `old_str` from that exact output, and retry.
   Do not reread or retry after another kind of edit failure without first diagnosing it.
9. If schema details are unsupported or uncertain, a prior required read failed or was
   partial or truncated, the edit reports a conflict, or compiler diagnostics occur, load
   only the reference relevant to that problem. A diagnostic repair may use
   `${PLUGIN_ROOT}/references/YamlSyntax.md`, `${PLUGIN_ROOT}/references/ControlGuide.md`, or
   `${PLUGIN_ROOT}/references/ValidationWorkflow.md` as needed, then apply a targeted repair and
   recompile. Do not read layout references before an ordinary one-leaf edit unless the
   request explicitly changes layout behavior. Do not unconditionally read those files,
   `${PLUGIN_ROOT}/references/LayoutGuide.md`, or `${PLUGIN_ROOT}/references/LayoutPolicies.md` before the edit.
10. Do not present a plan or wait for approval. Do not update `[working directory]/App.pa.yaml` unless an
   app-level change is actually required; adding one leaf control to a screen does not
   require an app-level change.
11. Stop after the final summary. Do not invoke `canvas-app-planner` or
   `canvas-screen-builder`. Do not create `[working directory]/canvas-app-plan.md`,
   `[working directory]/canvas-app-shared.md`, screen-plan files, or `[working directory]/canvas-app-acceptance.md`.

## 3. Bounded Structural Edit

Every condition must be true. One failed or uncertain gate rejects this route and
continues the ordered evaluation at Bounded Behavioral Edit.

### File footprint

- At most one existing screen is modified.
- At most one new screen is created.
- `[working directory]/App.pa.yaml` does not require collections, named formulas, lifecycle formulas, or
  data resource changes.
- `[working directory]/_EditorState.pa.yaml` may change only to add or reorder the affected screen.

### Control footprint

- The edit adds at most six controls.
- No existing control is removed.
- No existing control is reparented.
- No existing container changes variant.
- No existing layout mode changes.
- Every new control type can be resolved with `describe_control`.
- No Canvas Component, Code Component, GridLayout, gallery, or form is introduced.

### Behavior footprint

- Behavior is limited to static presentation, local presentation formulas, direct
  `Navigate(...)`, `Back()`, notification, or local variable update.
- No shared variable coordinates multiple screens or actions.
- No collection is introduced.
- No lifecycle behavior is introduced.
- No connector, API, or external data source is introduced.
- No record create, update, delete, approval, relationship, or status mutation is
  introduced.
- The visible result can be verified from final YAML and formulas.

### Structural footprint

- A valid existing root container is preserved.
- New controls are inserted into the correct existing container.
- A new screen uses `ResponsiveRoot` from `${PLUGIN_ROOT}/references/LayoutPolicies.md`.
- The edit does not require moving existing controls into a new root.
- A malformed existing generated hierarchy is not extended.
- Hierarchy health is not `Unknown`.

One exception is allowed. If the current request created the malformed hierarchy and no
successful compile has completed yet, repair it within the same direct operation.

### Certainty

- Every affected file is known before editing.
- Every target hierarchy location is known before editing.
- Every required formula is known before editing.
- Every required control creation keyword and variant is known before editing.

After approval, the top-level agent performs the edit without planner or builder
delegation:

1. Read the affected app YAML files.
2. Rebuild the `EditFootprint` and confirm every bounded structural gate.
3. Read only the guidance required by the edit, including
   `${PLUGIN_ROOT}/references/LayoutPolicies.md` when establishing or inserting into a screen
   hierarchy. Read `${PLUGIN_ROOT}/references/LayoutGuide.md` when establishing a new screen hierarchy.
4. Call `describe_control` for each new control type.
5. Determine the exact insertion point for every new control.
6. Compute all file mutations before writing.
7. Edit each affected file at most once when possible.
8. Apply `ResponsiveRoot` and `NestedVisibleChildren` to every newly generated screen.
   Prefer modern controls. Interactive controls meet `TouchTarget44`.
9. Update `[working directory]/_EditorState.pa.yaml` when a screen is added.
10. Compare the final YAML with the approved observable result.
11. Read `${PLUGIN_ROOT}/references/ValidationWorkflow.md` and follow it, including `compile_canvas`.
12. Repair only compiler diagnostics or direct-contract mismatches.
13. Repeat the final comparison after any repair.
14. Finish immediately after the final successful compile.

The bounded route must not:

- Invoke `canvas-app-planner`.
- Invoke `canvas-screen-builder`.
- Create `[working directory]/canvas-app-plan.md`.
- Create `[working directory]/canvas-app-shared.md`.
- Create screen-plan files.
- Create `[working directory]/canvas-app-acceptance.md`.
- Perform broad API or data-source discovery.
- Redesign unaffected screens.

This scenario is eligible because it introduces no data, shared state, mutation,
component, or destructive hierarchy change: add another button that navigates to a new
screen after click, insert the button into the existing current parent, create one static
destination screen with `ResponsiveRoot`, and update `_EditorState.pa.yaml`.

## 4. Bounded Behavioral Edit

Every condition must be true. One failed or uncertain gate is Planned Edit.

### ChangeSet footprint

- Exactly one existing screen is modified and no screen is created or removed.
- The only affected app files are the target screen and, when local initialization is
  necessary, `[working directory]/App.pa.yaml`.
- `[working directory]/_EditorState.pa.yaml` is unchanged.
- At most three requested leaf controls are added.
- At most one new gallery is added. Its `newGalleryTemplateCount` is bounded by the
  requested template children and all of those children count toward the leaf-control
  limit.
- Existing controls may receive bounded property or event-formula changes, but none is
  removed, renamed, reparented, or moved between layout modes.
- No container variant, screen root, existing gallery template hierarchy, or existing
  layout mode changes.
- An existing gallery's template hierarchy cannot be changed. One newly added gallery
  may contain bounded requested template children only when its complete template
  hierarchy, creation keywords, properties, formulas, and stable identity are fully
  known before writing.

### State and behavior footprint

- State is local to the app session and supports only the affected screen.
- At most one local collection or one app variable is introduced.
- A collection is compact and initialized deterministically in `App.OnStart` or an
  existing screen-local lifecycle formula without replacing unrelated initialization.
- Record mutation is limited to that local collection and uses one stable identity field.
- Formulas may update local selection, visibility, filtering, ordering, counters, or
  other derived presentation on the same screen.
- No connector, API, external data source, component contract, form submission,
  cross-screen coordination, authorization rule, or persistent record mutation is added.
- No create/delete lifecycle, approval workflow, relationship mutation, navigation graph,
  or external side effect is added.
- Every postcondition is statically observable from the same local source.

### Discovery and certainty

- The current target screen and current `App.pa.yaml` content required by the edit are
  known before writing.
- Every control type receiving a new property or event has exact schema evidence from
  `describe_control` or already carries that property in the target YAML.
- Every affected formula, source, field, stable ID, and observer is known before writing.
- Runtime initialization assumptions are explicit. When new `App.OnStart` state is
  required, report that runtime execution was not performed and that the current
  authoring session may need `OnStart` rerun or app restart.
- The complete `ChangeSet` passes a pre-write check for unsupported properties, duplicate
  keys, missing formula prefixes, YAML-sensitive `: ` scalars, stable-ID continuity, and
  observer/write-source parity.

The top-level agent performs this route directly without approval, planner, builder, or
planning artifacts:

1. Read the target screen and `[working directory]/App.pa.yaml` once. Do not probe optional planner or
   acceptance artifacts.
2. Compose and validate the complete `ChangeSet` in working memory.
3. Call `describe_control` only for control types receiving a property or creation
   keyword not already proven by the target YAML.
4. Read `${PLUGIN_ROOT}/references/BehaviorCore.md` when the change adds an action and
   `${PLUGIN_ROOT}/references/MutationBehavior.md` only when a local mutation needs stable-ID or receipt
   guidance. Do not read data, layout, design, or full QA references unless the requested
   change uses those capabilities or a diagnostic requires them.
5. Preserve the existing hierarchy. Place new manual-layout leaves from the current
   screen read and let an existing AutoLayout parent own placement.
6. Compute the final app and screen mutations before writing. Apply each affected file at
   most once before the first compile.
7. Quote YAML-sensitive formula scalars before writing. In particular, formulas containing
   record literals such as `{Selected: true}` must use a quoted scalar or block scalar.
8. Compare the composed result with the `ChangeSet`. Confirm stable identity, mutation
   write, derived observer, placement, and supported property names.
9. Call `compile_canvas` once after every intended app-YAML mutation has been applied.
   Do not compile `App.pa.yaml` separately.
10. If compilation reports diagnostics, repair all instances of the same root cause in
    one pass, then recompile. Do not add unrelated editor-state or acceptance-artifact
    changes.
11. After a clean compile, return immediately. State that behavior is statically verified
    and name runtime evaluation as not run when no runtime tool executed it.

The bounded behavioral route must not:

- Present a plan or wait for approval.
- Invoke `canvas-app-planner` or `canvas-screen-builder`.
- Create or read planner, screen-plan, shared-plan, or acceptance artifacts.
- Read `${PLUGIN_ROOT}/references/QAChecks.md` preemptively.
- Compile intermediate partial changes.
- Modify `_EditorState.pa.yaml`.
- Claim that `App.OnStart` ran or that an interaction refreshed immediately without
  runtime evidence.

## 5. Planned Edit

Planned Edit is selected only after the ordered Simple, Bounded Structural, and Bounded
Behavioral gates have been evaluated and the first failed or uncertain Bounded Behavioral
gate is recorded in `RouteAssessment.firstFailedGate`. Capability names alone do not
select this route. Use Planned Edit for capability-qualified failures, including:

- Move existing controls into a new container.
- Convert ManualLayout to AutoLayout.
- Add more than one new screen.
- Add a gallery whose source is external, persistent, shared, or uncertain; add more than
  one gallery; or change an existing gallery's template hierarchy.
- Add a form, connector, API, or external data source.
- Add a collection or variable that is shared across screens, persistent, externally
  synchronized, or uncertain, or that exceeds the bounded local-state gates.
- Add create, edit, delete, approval, rejection, or status mutation against persistent or
  external data.
- Add shared cross-screen state or coordination.
- Add local state whose source, initialization, identity, or observer cannot be expressed
  as one bounded `ChangeSet`.
- Add conditional navigation based on data, authorization, or workflow state.
- Add a lifecycle formula that coordinates shared or external state, performs persistent
  effects, replaces unrelated initialization, or cannot be completely assessed before
  writing.
- Add Canvas Components, Code Components, or GridLayout.
- Change existing information architecture.
- Repair a malformed hierarchy that requires reparenting existing controls.
- Perform an edit whose complete target hierarchy or formula cannot be determined before
  writing.

The bounded local gallery-selection scenario in section 4 remains Bounded Behavioral
Edit: one newly added gallery bound to one compact local collection, one Checkbox
template child that mutates selection by stable identity, and one same-screen count label.
Do not route it to Planned Edit merely because it contains a gallery, collection, local
record mutation, or deterministic local initialization.

Read:

- `${PLUGIN_ROOT}/references/YamlSyntax.md` — file structure, syntax rules, parse-error triage
- `${PLUGIN_ROOT}/references/ControlGuide.md` — control selection, per-control properties, enums
- `${PLUGIN_ROOT}/references/LayoutGuide.md` — responsive layout, scrolling, color contrast
- `${PLUGIN_ROOT}/references/LayoutPolicies.md` — named layout contracts
- `${PLUGIN_ROOT}/references/PowerFxGuide.md` — state, events, named formulas, mock data
- `${PLUGIN_ROOT}/references/DesignGuide.md` — aesthetic direction and design process

Determine:

- Requested capability families from `${PLUGIN_ROOT}/references/BehaviorCore.md`, with
  `${PLUGIN_ROOT}/references/MutationBehavior.md` and `${PLUGIN_ROOT}/references/DataBehavior.md` loaded only when
  their capability families are present
- Every changed action's precondition, source-of-truth transition, and visible postcondition
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

### Functional Changes
| Capability | Existing behavior | Required transition | Visible success |
|------------|-------------------|---------------------|-----------------|
| [Changed behavior] | [Current reachable path or gap] | [Source, stable ID, and exact postcondition] | [Bound receipt plus downstream observer] |

### Approach
[How the edit preserves and extends the current app]
```

Wait for user approval. Revise and re-present if requested.

## 6. Invoke the Planner


Before delegation, use the top-level skill's MCP connection for discovery introduced by
the edit. List resources only when the edit introduces resources not already present.
Call `describe_control` for every type receiving a property, enum, or variant not already
carried in its target YAML, and call `describe_api` and `get_data_source_schema` only for
APIs and data sources involved in the edit. Also call `describe_control` for every Canvas
or Code Component used by the plan, and make those component calls last so the packet
contains the freshest Studio snapshot. Preserve the exact results as the discovery
packet. Do not delegate these calls: task agents do not reliably inherit the configured
MCP connection.


Invoke the `canvas-app-planner` agent with `Task` and:

```text
Mode: EDIT
Working directory: `[working directory]`
Plan index: `[working directory]/canvas-app-plan.md`
Shared plan: `[working directory]/canvas-app-shared.md`
Plugin root: `${PLUGIN_ROOT}`
Edit requirements: [user requirements]
Approved plan: [full approved plan]
Current app state: [palette, variables, layout, screens, controls]
Synced files: [absolute working-directory paths]
Discovery packet: [complete results gathered above]
```

The planner writes the plan index, shared plan, and one screen brief per dispatch row. It
does not edit any `.pa.yaml` file in EDIT mode.

If it returns `Status: Discovery Packet Blocked`, gather the named missing result in this
top-level context and re-invoke it with the completed packet. If writing is blocked, apply
its complete inline artifact payloads verbatim as required by the skill before entering
Planned Build Handoff.

Wait for the planner to finish, then return to **Planned Build Handoff** in the
`canvas-app` skill.
