# Edit Workflow

Use this workflow when the user's intent changes an existing app. This includes a
targeted mutation against an existing `BlankScreen` or `PopulatedScreen`, and an addition
to an existing app that creates a `MissingTargetScreen`. Do not select CreateWorkflow
merely because an existing target screen has no meaningful visible leaf controls.

## Change and Preservation Contract

Before mutation, identify the requested observable delta, allowed changes, relevant behavior/bindings/layout to preserve, affected dependencies, assumptions and acceptance evidence. Fix introduced or directly coupled defects needed for the requested result; report unrelated issues without expanding the edit. For Direct and sequential Partitioned, keep the contract in context, not a new artifact or approval step. Planned EDIT uses the compact contract in `${PLUGIN_ROOT}/references/EditConformance.md` within its existing artifacts.

Existing control names, creation keywords, live bindings and valid layout strategy are preservation constraints, not opportunities for modernization. On a later maker turn, reread current affected YAML and reconcile it with approved intent; do not trust stale planning artifacts or overwrite intervening edits. An implementation-only correction needs no new approval, but a material scope/UX/data compromise does.

For existing mutations whose feedback is not part of the requested change, record `Feedback: Preserve` with the existing feedback and source-bound observers. Do not add new receipt UI to satisfy generic mutation guidance. If current feedback itself prevents the requested outcome, identify the necessary change in the contract rather than silently expanding it.

## 1. Assess execution

Read the current target screen before choosing a route. Read additional `[working directory]/*.pa.yaml`
files only when the request or routing decision requires their current content. The
reference-reuse contract does not apply to `[working directory]`.

Before reading any `/references` file named below, reuse it when its complete contents
were successfully returned earlier in this same context. Do not reread it merely because
a new turn started. For a large reference, read only the already-known relevant section
or a bounded range when the whole file is not needed. Reread only after a failed,
partial, truncated, or insufficient prior result. A top-level context cannot assume that
a planner or builder context loaded a reference, and those contexts cannot assume that
the top-level context loaded one.

Assess the complete `EditFootprint` as one coherent contract before choosing a route.
Record the equivalent fields:

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

Convert the footprint into one complete assessment object, then call
`assess_edit_execution` before editing, once for the assessment plus at most one repair
retry after a `validationError`. `assessmentJson` takes that object directly:

```text
assess_edit_execution(
  assessmentJson="""{
    "coordinationScope": "SingleOwner | MultipleIndependentOwners",
    "affectedFiles": [
      { "filePath": "[working directory]/Screen1.pa.yaml", "owner": "top-level" }
    ],
    "discoveryCertainty": "Complete | Unresolved",
    "formulaCertainty": "Complete | Unresolved",
    "ownershipCertainty": "Complete | Unresolved",
    "hierarchyCertainty": "Complete | Unknown | MalformedRequiresDesign",
    "behaviorKinds": [
      "StaticPresentation | LocalPresentationFormula | DirectScreenNavigation | Notification | LocalVariableUpdate | Collection | Gallery | Formula | SharedState | CrossScreenLifecycle | ExternalResourceReference | RecordMutation | ComponentBehavior"
    ],
    "stateEffect": "None | Local | CrossScreenSharedLifecycle",
    "resourceEffect": "None | External",
    "mutationEffect": "None | RecordMutation",
    "componentEffect": "None | Resolved | Unresolved",
    "hierarchyImpact": "Preserve | Additive | Reparenting | LayoutConversion | Destructive",
    "hasWriteConflict": false,
    "dependenciesKnown": true,
    "sharedPrerequisitesKnown": true
  }"""
)
```

The `assessmentJson` argument takes the object shown above directly. Success returns
exactly `{"executionTier":"Direct|Partitioned|Planned","reasonCodes":[...]}`
and an invalid assessment returns
`{"validationError":{"code":"INVALID_ASSESSMENT","message":"...","violations":[{"property":"...","code":"...","message":"..."}]}}`.
Every problem is listed in `violations`, so one repair pass can fix all of them.

On that `validationError`, fix every listed `property` and retry once only when the current
app state already provides the missing or corrected facts. If the current app state still
cannot complete the assessment, do not call the tool again; route Planned.

Use `SingleOwner` when one execution owner can safely apply every known affected file.
Use `MultipleIndependentOwners` only when at least two distinct file owners have disjoint
writes, known dependencies, and known shared prerequisites. Do not label uncertain work
independent.

Collections, galleries, controls, and formulas are capability nouns, not risk decisions.
They can remain Direct or Partitioned when their formulas, ownership, hierarchy, and
effects are complete and local. A connector, API, or data source is Planned only when the
edit introduces or changes an external resource; merely mentioning an already-resolved
resource name is not itself a route.

Follow the returned `executionTier`:

1. `Direct` uses section 2. The top-level agent owns every affected file and completes
   the known change without planner or builder delegation.
2. `Partitioned` uses section 3. This slice does not
   provide parallel worker dispatch. Execute the files sequentially in the top-level
   agent only when doing so preserves the assessed ownership, dependencies, and disjoint
   write sets. Otherwise record that the policy selected Partitioned and use the existing
   Planned flow as a runtime fallback.
3. `Planned` uses section 4. Stable `reasonCodes` explain why the edit failed closed.

## 2. Direct

Direct requires one owner, complete discovery/formulas/ownership/hierarchy, known
dependencies and shared prerequisites, no write conflict, no destructive hierarchy
change, and no cross-screen shared lifecycle, external-resource change, record mutation,
or unresolved component behavior. A `MissingTargetScreen` can be Direct when the new
screen and every affected file are fully known and owned by the same executor.

Adding one leaf control to the `Children` of an existing screen or container is a common
Direct edit when the insertion preserves the current hierarchy and layout strategy.

Other Direct edits follow `${PLUGIN_ROOT}/references/EditConformance.md`: inspect affected files/dependencies, describe changed or added control contracts, apply the known scoped changes, compare delta and preservation evidence, then follow the direct route in ValidationWorkflow. Keep this work in the top-level agent without planning artifacts or a new approval step. New screens must be wired into `_EditorState.pa.yaml` and existing navigation as required; known file ownership does not exempt integration checks.

The common one-leaf path is self-contained:

1. Use the current read of the target screen as the source for the edit. Identify the
   exact existing screen or parent `Children` block and preserve its current hierarchy,
   control family, indentation, and layout mode. Add the new leaf to the current screen or
   to the existing parent that already owns neighboring controls, preserving the current
   hierarchy exactly.
2. Resolve the new control type before describing it. Treat an explicit catalog name or
   family-qualified request, such as `ModernButton`, `Classic/Button`, or "classic
   button", as the user's exact selection and do not substitute another type. Treat a
   purpose-only request, such as "add a button", as open control selection: call
   `list_controls`, choose a modern control that satisfies the purpose, and select
   `ModernButton` rather than `Classic/Button` for a generic button. This selection applies
   only to the new control; do not replace or retype existing controls. Then call
   `describe_control` for the selected type. Copy its exact `Control`, `Variant`,
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
5. Apply one targeted `apply_patch` or `Edit` using exact current source and its actual line endings. Keep anchors unique and the change confined to the intended parent; do not reconstruct surrounding content from memory.
6. Do not create a container, introduce AutoLayout, convert layout mode, or reparent
   existing controls. Do not require `ResponsiveRoot`, `NestedVisibleChildren`, or another
   layout policy. Keep valid YAML structure and use formula-leading `=` where the schema
   requires a formula.
   Before compilation, inspect the changed region and directly affected dependencies against the requested result and preservation constraints. Check placement, ancestor/sibling budgets and reachability where the insertion changes them. For a dotted enum name use `='ButtonCanvas.Appearance'.Primary` only when returned for that exact control; quote non-simple members such as `DecimalPrecision.'1'`. Use a YAML block scalar for formulas containing `: ` or record literals. This inline path needs no blanket QA/reference load; uncertainty or a coupled defect loads the applicable section of `${PLUGIN_ROOT}/references/EditConformance.md`.
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

## 3. Partitioned

Partitioned requires a complete contract for at least two independent file owners. Every
affected file, owner, dependency, shared prerequisite, target hierarchy, formula, control
creation keyword, and write set is known before editing. Writes do not overlap.

This first production slice does not add a parallel dispatcher. Prefer the top-level
sequential implementation below when it can honor each file's known write set without
cross-owner discovery or redesign:

1. Read the affected app YAML files.
2. Confirm that no evidence from those reads invalidates the assessed ownership,
   dependencies, shared prerequisites, or disjoint write sets. If it does, use the
   Planned runtime fallback instead of calling the assessment tool again.
3. Read `${PLUGIN_ROOT}/references/EditConformance.md` and only the guidance required by the edit, including
   `${PLUGIN_ROOT}/references/LayoutPolicies.md` when establishing or inserting into a screen
   hierarchy. Read `${PLUGIN_ROOT}/references/LayoutGuide.md` when establishing a new screen hierarchy.
4. Call `describe_control` for each changed or added control contract, preserving existing creation keywords and versions.
5. Determine the exact insertion point for every new control.
6. Compute all file mutations before writing.
7. Edit each affected file at most once when possible.
8. Apply `ResponsiveRoot` and `NestedVisibleChildren` to every newly generated screen.
   Prefer modern controls. Interactive controls meet `TouchTarget44`.
9. Update `[working directory]/_EditorState.pa.yaml` when a screen is added.
10. Compare the final YAML with the approved observable result.
11. Read `${PLUGIN_ROOT}/references/ValidationWorkflow.md` and follow it, including `compile_canvas`.
12. Repair introduced or directly coupled defects within the contract; report unrelated pre-existing diagnostics as directed by ValidationWorkflow.
13. Repeat the final comparison after any repair.
14. Finish immediately after the final successful compile. State that the deterministic
    policy selected Partitioned and that this slice executed the independent files
    sequentially rather than in parallel.

The sequential Partitioned route must not:

- Invoke `canvas-app-planner`.
- Invoke `canvas-screen-builder`.
- Create `[working directory]/canvas-app-plan.md`.
- Create `[working directory]/canvas-app-shared.md`.
- Create screen-plan files.
- Create `[working directory]/canvas-app-acceptance.md`.
- Perform broad API or data-source discovery.
- Redesign unaffected screens.

If the top-level agent cannot preserve independent ownership, needs cross-file discovery,
or would have to coordinate shared writes, do not simulate parallelism. Record
`executionTier: Partitioned` and use the Planned flow below as the runtime fallback,
including planner approval and the existing planner/build pipeline.

## 4. Planned

Use Planned when the policy returns Planned, or as the explicit runtime fallback for a
Partitioned decision that cannot be executed safely in this slice. Planned reason codes
cover:

- unresolved discovery, formulas, ownership, dependencies, or shared prerequisites;
- unknown or malformed hierarchy that requires design;
- reparenting, layout conversion, or another destructive hierarchy change;
- cross-screen lifecycle or shared-state coupling;
- external-resource changes;
- record create, edit, delete, approval, rejection, relationship, or status mutation;
- unresolved Canvas or Code Component behavior; or
- conflicting writes.

Read `${PLUGIN_ROOT}/references/EditConformance.md`. First establish the existing behavior, requested delta and preservation boundaries from current YAML. Load implementation guidance only for a concrete feasibility question or later implementation work, not to choose controls before understanding the change. Use relevant sections of `${PLUGIN_ROOT}/references/YamlSyntax.md`, `${PLUGIN_ROOT}/references/ControlGuide.md`, `${PLUGIN_ROOT}/references/LayoutGuide.md`, `${PLUGIN_ROOT}/references/LayoutPolicies.md` or `${PLUGIN_ROOT}/references/PowerFxGuide.md` on demand. When the requested edit requires visual design decisions, consult `${PLUGIN_ROOT}/references/DesignGuide.md` within the approved scope; it does not authorize redesigning unaffected screens. Read at most 100 lines per call, complete applicable sections and reuse those already covered.

Determine:

- An original-request capability inventory for every changed requirement, captured before
   reducing it to screens or implementation tasks
- Requested capability families from `${PLUGIN_ROOT}/references/BehaviorCore.md`, with
  `${PLUGIN_ROOT}/references/MutationBehavior.md` and `${PLUGIN_ROOT}/references/DataBehavior.md` loaded only when
  their capability families are present
- Every changed action's precondition, source-of-truth transition, and visible postcondition
- Screens to modify and exact changes
- Screens to create
- Existing palette, layout strategy, variables, and data bindings to preserve
- New controls, data sources, connectors, or shared state
- Required changes to `[working directory]/App.pa.yaml`

For changed time ordering, preserve typed Date/Time semantics or introduce a validated
canonical 24-hour sort key; do not retain direct sorting of mixed display strings.

Resolve material feasibility before approval in this top-level context. Describe candidate controls only when required to establish supported behavior, containment, focus or scroll ownership. List controls/resources only when their identities are unknown; retrieve schemas/API details only for affected resources. Preserve current bindings and known resource contracts. Record exact candidate query identities and constraints, not property catalogs. Pass these decisions and affected resource contracts to the planner; it confirms implementation details without changing the approved experience.

When a new capability needs an absent source, propose a mock-backed implementation with its data, demo identity and persistence/integration limitations disclosed in this approval. Do not replace an existing live binding with mock data. A failed discovery call is not evidence of absent sources; explicit mock rejection or unavailable indispensable capability remains a blocker. Approval of the disclosed proposal authorizes that mock scope without a separate permission round.

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
[Observable state/data changes, or "None"; exact implementation formulas follow approval]

### Functional Changes
| Capability | Existing behavior | Required transition | Visible success |
|------------|-------------------|---------------------|-----------------|
| [Changed behavior] | [Current reachable path or gap] | [Source, stable ID, and exact postcondition] | [Preserved feedback/source observer, or approved new result surface] |

### Approach
[How the edit preserves and extends the current app]

### Change and Preservation Contract
[Compact requested delta, allowed changes, preserve constraints, affected dependencies, assumptions and evidence from EditConformance; no property inventory]
```

Wait for user approval. Revise and re-present if requested.

## 5. Invoke the Planner

Before delegation, write `[working directory]/canvas-app-requirements.md` from the approved edit plan and
original request using the `Original Requirements Contract` template in
`${PLUGIN_ROOT}/references/PlanModel.md`. Include every requested edit clause and every existing
behavior made regression-sensitive by the edit. This artifact is orchestrator-owned and
the planner must not edit it.

Include the approved Change and Preservation Contract and feasibility decisions in that same requirements artifact. On resumption reconcile against current YAML first; reconstruct missing EDIT artifacts from approved intent only when it is still applicable. Do not restart CREATE or infer approval from a surviving filename.

Invoke the planner with every required task field:

```text
task(
  description="Plan the approved canvas app edit",
  agent_type="canvas-app-planner",
  name="canvas-app-planner-edit",
  mode="sync",
  prompt="""
Mode: EDIT
PLUGIN_ROOT: ${PLUGIN_ROOT}
Working directory: `[working directory]`
Plan index: `[working directory]/canvas-app-plan.md`
Shared plan: `[working directory]/canvas-app-shared.md`
Edit requirements: [user requirements]
Approved plan: [full approved plan]
Original requirements contract: `[working directory]/canvas-app-requirements.md`
Current app state: [palette, variables, layout, screens, controls]
Change and Preservation Contract: [approved contract in the requirements artifact]
Feasibility decisions: [candidate query identities, constraints, affected resource contracts and disclosed mock scope]
Execution policy decision: [Planned, or Partitioned with Planned runtime fallback]
Execution policy reason codes: [stable reason codes]
Synced files: [absolute [working directory] paths]
"""
)
```

The planner writes the plan index, shared plan, and one screen brief per dispatch row. It
does not edit any `.pa.yaml` file in EDIT mode.

Check the result before reading artifacts or dispatching, including replanning after a builder blocker. On `Status: Blocked`, a failed tool or an incomplete handoff, do not treat retained artifacts as successful output. Reconcile an implementation-only missing fact/contract against current YAML and resume targeted planning; return material scope, UX/data or version-migration decisions to the maker. Allow one evidence-backed retry for the same unresolved planning gap, then report a blocker rather than cycling planner/builder invocations. This limit does not apply to progress-based compiler repair.


Only after a successful, current planner handoff read `${PLUGIN_ROOT}/references/PlannedEditHandoff.md` for artifact acceptance, shared-file application and screen dispatch.
