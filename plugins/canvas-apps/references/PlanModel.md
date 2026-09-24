# Plan Model

The planner keeps one compact `PlanModel` in working memory. Do not write this model as a
file. Project it with the mode-specific `PlanIndexCreate.md` or `PlanIndexEdit.md`
reference, `SharedPlanArtifact.md`, and the `ScreenCreateArtifact.md` or
`ScreenModifyArtifact.md` references required by the dispatch actions.

Downstream contracts stay compatible: artifact filenames, required headings, dispatch
columns, and Planned Build Handoff checks are unchanged.

## Working-memory shape

```text
PlanModel
  mode: CREATE | EDIT
  requirements: original approved request
  coverage[]: requirement, plannedAffordance, fidelity
  requiredRecordFields[]: fieldKey, screen, recordSurface, requiredField, sourceField, presentation
  stateDrivenSurfaces[]: surfaceKey, ownerScreen, surfaceControl, statePredicate, visibleAndHiddenStates
  actionContracts[]: action, preconditions, entryPoint, ownerScreen, controlAndEvent, sourceAndStableId, transition, writeSet, proofSet, observerAndEvidence
  mutationLifecycle[]: action, receipt, canonicalSource, destination, stableIdContinuity, synchronization, destinationFocus
  mutationFieldLedger[]: action, field, classification, canonicalPreState, writeOrPreservation, receiptBinding, postStateObserver
  continuationContracts[]: createAction, returnedIdBinding, downstreamAction, downstreamTarget, successClear, cancellationClear
  functionalTests[]: scenario, given, when, then, evidenceSurface, boundaryOrNegative, actionRef
  directionalMutation[]: selectedId, operationState, invalidGates, directionalFormulas, observer, receiptValues
  compoundSequence[]: pair, sameRecordId, sequence, secondOpOldValueBinding
  dataEntryLabels[]: requiredInput, visibleLabel, sharedFieldRegion
  layout[]: screenOrContainer, appliedPolicies, instanceMeasurements, protectedControls
  workingDirectory: absolute app path
  discovery: controls, dataSources, connectors, existingScreens, layoutHealth
  dispatch[]: action, screen, targetFile, yamlKey, namePrefix, screenBrief
  appChanges: beforeBuilders, afterBuilders
  editorStateChanges: screensOrder, componentDefinitionsOrder, or None
  shared: aestheticDirection, visualContract, layoutStrategy, namedState, controlNaming, crossScreenContracts, yamlConventions, imagery
  screens[]: assignment, specificationOrChanges, ownedActions, ownedTests, ownedRecordFields, controlDefinitions, variants, schemas, apis
```

Keep lists instance-specific. Reference named policies from `${PLUGIN_ROOT}/references/LayoutPolicies.md`
instead of repeating cosmetic arithmetic.

## Validation before the first write

Validate the in-memory `PlanModel` fail-closed before writing `App.pa.yaml` or any plan
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
   target file or name prefix. CREATE's first row targets `[working directory]/Screen1.pa.yaml` with YAML
   key `Screen1`.
4. **Complete builder context.** Each dispatch row's screen object includes assignment
   fields, the specification or exact edit list, every owned action and test, every owned
   required record field, and a control definition for every type the builder must add or
   change, including creation keywords, input property names, and compile-ready `Enum
   name:` literals. No unresolved placeholder remains.
5. **App and editor changes.** CREATE includes the complete `App.pa.yaml` contents.
   EDIT includes `App Changes` with `Before builders` and `After builders`, using `None`
   when a group is empty. Every model includes `Editor State Changes` as exact final order
   lists or `None`.
6. **Required control discovery.** Every control type that will receive a new property,
   enum, variant, or new instance has a `describe_control` result. Missing discovery fails
   closed.

Do not write files from an invalid model. Downstream Planned Build Handoff still reads the
projected Markdown artifacts; this validation does not replace that orchestrator gate.
