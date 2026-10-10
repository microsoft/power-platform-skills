# Plan Model

The planner keeps one compact `PlanModel` in working memory. Do not write this model as a
file. Use it for planned edits to existing apps. Project it with the `PlanIndexEdit.md`
reference, `SharedPlanArtifact.md`, and the `ScreenCreateArtifact.md` or
`ScreenModifyArtifact.md` references required by the dispatch actions.

Downstream contracts retain artifact filenames, required headings, and dispatch columns.
The coordinator's handoff gate is defined in `${PLUGIN_ROOT}/references/PlannedEditHandoff.md`.

Before the planner runs, the top-level orchestrator writes one immutable planning input at
`[working directory]/canvas-app-requirements.md`. The planner may consume it but must not modify it.

## Planning and implementation ownership

The index owns semantic coverage, acceptance examples, dispatch, and coordinator-owned mutations. The shared plan owns cross-file interfaces. Screen briefs carry only the relevant semantics, data types, source/field identities, stable state names, affected dependencies, desired transitions, preservation constraints, and observable success/error/boundary cases.

Require exact syntax for approved literal property edits, existing bindings that must be preserved, coordinator-owned `App.pa.yaml` / `_EditorState.pa.yaml` changes, and shared cross-file interfaces. Keep exact names and types wherever another file consumes them. These are contracts, not permission to prescribe every local control name, event body, observer expression, or geometry formula.

For builder-owned details, specify implementation intent and constraints: inputs, canonical source, stable ID, field types, write set, expected transition, feedback mode, and acceptance examples. The builder chooses supported file-local formulas, controls, grouping, and numeric geometry, then returns actual final control/property/formula bindings and layout evidence. It need not return to the planner for a missing local formula or sizing recipe. Escalate a missing shared decision or an incompatible preservation/feasibility contract.

Artifact column names such as `Exact formula` and `Receipt proof set` remain stable. At planning time a local formula cell may contain explicit implementation intent; preserved or literal bindings remain exact. Receipt cells state `Feedback: Receipt` requirements or `Feedback: Preserve` existing-feedback/static-proof requirements from `${PLUGIN_ROOT}/references/MutationBehavior.md`. At acceptance time use exact final-YAML evidence and verify it against the semantic contract; an intent cell is never substitute evidence.

## Original Requirements Contract

```markdown
# Canvas App Original Request Contract

Contract version: 1
Target device: [Phone / Tablet / Responsive / Unknown / Fixed desktop]

## Original Request

[Original user request and approved clarifications, without planner summarization]

## Change and Preservation Contract

[The approved compact contract and feasibility decisions from EditConformance; do not add another artifact.]

## Capability Inventory

| Requirement key | Original request clause | Capability family | Required outcome / scope | Required action(s) | Scenario(s) | Specialized contract mappings |
| --------------- | ----------------------- | ----------------- | ------------------------ | ------------------ | ----------- | ----------------------------- |
| [stable key] | [One independently testable original clause] | [BehaviorCore family] | [Fields, relationships, lifecycle, alert rule, aggregation scope, or visible outcome] | [Stable Action Contract keys] | [Stable Functional Test Matrix keys] | [e.g. `Temporal ordering=meeting-start`, or N/A] |
```

Every mapping uses stable exact keys rather than prose matching. Use `Fixed desktop` only
for an explicitly fixed desktop-only request; `Unknown` is responsive and requires
viewport containment. Do not use placeholders or create rows for unrequested universal
CRUD.

## Working-memory shape

```text
PlanModel
  mode: EDIT
  requirements: original approved request
  changeAndPreservation: approved delta, allowedChanges, preserve, dependencies, assumptions, evidence
  coverage[]: requirement, plannedAffordance, fidelity
  requiredRecordFields[]: fieldKey, screen, recordSurface, requiredField, sourceField, presentation
  stateDrivenSurfaces[]: surfaceKey, ownerScreen, surfaceControl, statePredicate, visibleAndHiddenStates
  actionContracts[]: action, preconditions, entryPoint, ownerScreen, controlAndEvent, sourceAndStableId, transition, writeSet, proofSet, feedbackMode, observerAndEvidence
  mutationLifecycle[]: action, receipt, canonicalSource, destination, stableIdContinuity, synchronization, destinationFocus
  mutationFieldLedger[]: action, field, classification, canonicalPreState, writeOrPreservation, receiptBinding, postStateObserver
  continuationContracts[]: createAction, returnedIdBinding, downstreamAction, downstreamTarget, successClear, cancellationClear
  functionalTests[]: scenario, given, when, then, evidenceSurface, boundaryOrNegative, actionRef
  directionalMutation[]: selectedId, operationState, invalidGates, directionalTransitions, observer, feedbackEvidence
  compoundSequence[]: pair, sameRecordId, sequence, secondOpOldValueBinding
  dataEntryLabels[]: requiredInput, visibleLabel, sharedFieldRegion
  layout[]: screenOrContainer, appliedPolicies, instanceMeasurements, protectedControls
  workingDirectory: absolute app path
  discovery: controls, dataSources, connectors, existingScreens, layoutHealth
  dispatch[]: action, screen, targetFile, yamlKey, namePrefix, screenBrief
  appChanges: beforeBuilders, afterBuilders
  editorStateChanges: screensOrder, componentDefinitionsOrder, or None
  shared: aestheticDirection, visualContract, layoutStrategy, namedState, controlNaming, crossScreenContracts, yamlConventions, imagery
  screens[]: assignment, specificationOrChanges, changeAndPreservation, ownedActions, ownedTests, ownedRecordFields, controlDecisions, variants, schemas, apis
```

Keep lists instance-specific. Reference named policies from `${PLUGIN_ROOT}/references/LayoutPolicies.md`
instead of repeating cosmetic arithmetic.

## Validation before the first write

Validate the in-memory `PlanModel` fail-closed before writing any plan
artifact. If any check fails, repair the model in memory and re-validate. Do not write
partial artifacts.

1. **Coverage.** Every concrete requested noun and interaction has a coverage row. Any
   approximation is explicit and does not claim an unavailable interaction is exact.
2. **Action and test coherence.** Every Action Contract has at least one success test.
   Every required invalid, blocked, empty, reset, or boundary path has a test. Every test
   names an Action Contract that exists. Opposing directions have separate contracts and
   tests. Owned Required Actions and Functional Test Scenarios on each screen match the
   index rows for that screen.
3. **Unique dispatch files and prefixes.** Every dispatch row has `Action`, `Screen`,
   `Target File`, `YAML Key`, `Name Prefix`, and `Screen Brief`. No two rows share a
   target file or name prefix. `Create` adds a screen to the existing app; `Modify`
   preserves the target screen's existing YAML key.
4. **Complete builder context.** Each dispatch row's screen object includes assignment
   fields, the specification or scoped change list, every owned action and test, every owned
   required record field, its relevant Change and Preservation Contract, and Control Decisions naming exact query identities and feasibility constraints for changed/added types. Builders obtain control metadata directly; no copied property inventory or file-local formula recipe is required. No unresolved semantic, shared-interface, preservation, or assignment decision remains; explicitly builder-owned implementation intent is not a missing decision.
5. **App and editor changes.** Include `App Changes` with `Before builders` and `After builders`, using `None`
   when a group is empty. Every model includes `Editor State Changes` as exact final order
   lists or `None`.
6. **Required control discovery.** Every material feasibility choice has tool-backed support. Candidate identities and existing versions to preserve are explicit. Builders describe changed/added types directly; planner discovery settles feasibility, not an exhaustive property catalog.

Do not write files from an invalid model. The coordinator reads the projected Markdown
artifacts under `${PLUGIN_ROOT}/references/PlannedEditHandoff.md`; this validation does not replace that
handoff gate or final actual-YAML acceptance under `${PLUGIN_ROOT}/references/ValidationWorkflow.md`.
