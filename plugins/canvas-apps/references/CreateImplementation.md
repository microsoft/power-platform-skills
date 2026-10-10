# CREATE Implementation

Enter only with current Approved/Preapproved discovery and matching input revisions. You own `[working directory]/create-bindings.md`, `[working directory]/App.pa.yaml`, `[working directory]/_EditorState.pa.yaml`, compilation and targeted repairs. Builders own one assigned screen each. This is the fifth stage, not another implementation-planning pass.

## Shared Contract

Read current YAML, `${PLUGIN_ROOT}/references/CreateBuilderCore.md`, `${PLUGIN_ROOT}/references/CreateConformance.md`, `${PLUGIN_ROOT}/references/CreateNavigationState.md` and `${PLUGIN_ROOT}/references/CreateValidation.md`. Load other topic modules from the core's ownership map only as needed. Use discovered resource contracts and the core's direct-description policy when configuring controls, not saved metadata snapshots.

Write compact `[working directory]/create-bindings.md` with `Revision:` and `Inputs:` for the approved tuple:

| Contract | Required content |
|---|---|
| Screens | Logical S-ID, final YAML key, absolute target path, unique prefix, composition path/revision |
| Shared data/state | Canonical source/schema identifiers and types, stable identity, shared variable/collection/formula names/defaults, persistence scope |
| Dataset bounds | Per-source classification, exact justified maximum or unknown, source/subset invariants and invalidating changes |
| Cross-screen actions | A-ID, source/destination, owned typed identities/context, preserved/reset values, return restoration and observable destination |
| Shared presentation | Exact identity/nav labels and control identities, type/color/spacing/surface values, shell mode, header/rail sizing and reflow |
| Initialization | Responsibility/location, with app-level work owned by the coordinator; state producers and recovery |
| Build status | Per-screen Pending/Written/NeedsRepair, consumed revisions, current diagnostic identities/root causes, repairs and progress evidence |

## Shared Presentation and Shell

Translate approved design/discovery once into concrete shared bindings, including intentional screen-family differences. Fix navigation placement/order/control identities, local breakpoint source, fixed/scrolling regions, remaining-space sizing, structural shadow/border treatments and confirmation/focus strategy. Use the core's shell/layout rules rather than inventing a universal template.

Reconcile every composition with this contract before dispatch, including gallery versus page scroll ownership. Incompatibility returns to the affected discovery/layout decision through `${PLUGIN_ROOT}/references/CreateWorkflow.md`. Builders choose content-specific implementation but must not independently invent shared values or infer them from peer screens. Do not generate screen skeletons.

## Shared Initialization

Apply `${PLUGIN_ROOT}/references/CreateNavigationState.md` for landing-screen identity, round-trip ownership and state producers. Apply `${PLUGIN_ROOT}/references/CreateMutations.md` for approved mock initialization or persisted-data restoration. Establish shared variable/source types without relying on future screens to type bare Blank defaults.

For list sources, reconcile discovery's dataset bounds using `${PLUGIN_ROOT}/references/CreateGalleryLayout.md` before dispatch. Carry their exact justification into bindings/assignments; invalidated layout assumptions require targeted reconciliation, not silent truncation.

Write initialization before screens and call `compile_canvas`. Conformance's compile/repair procedure must clear App-level, syntax, creation-keyword and shared-schema errors before dispatch; do not build against broken shared bindings.

## Screen Waves

Invoke `canvas-create-builder` with `Task` once per pending screen, in waves of **at most three**. Supply:

- Original request/clarifications and approved revision tuple.
- Logical screen ID, target path, YAML key and unique prefix.
- Its composition, relevant R/A IDs, shared design and bindings paths/revisions.
- Relevant discovery query identities, constraints and data/API contracts.
- Relevant dataset bounds and source/subset invariants, including unknown bounds.

Check each result against its assignment and actual YAML using conformance's independent inspection procedure. Record current status in bindings. A missing candidate/resource contract or disproved feasibility returns to discovery; shared-binding defects are yours. Never edit a file while its builder is running.

Compile after each wave before the next, following conformance's diagnostic tiers, allowed pending-screen references and same-turn progress policy. Repair in place; implementation-only binding corrections must reach already written consumers and undispatched assignments. Do not regenerate completed screens or restart planning for compiler errors.

On resume after cancellation or another user turn, reconcile synchronized YAML against bindings before dispatch: unapplied edits may be gone and recorded status is advisory. Reuse valid screens and patch missing/partial work from the approved composition.

## Finish Wiring

Wait for every builder/follow-up and finish cross-screen wiring. Apply final screen ordering to `[working directory]/_EditorState.pa.yaml`, preserving valid unrelated entries; builders never edit it. Complete `${PLUGIN_ROOT}/references/CreateValidation.md`'s cross-screen and final-compile gates. Legacy plan/acceptance files are not CREATE prerequisites.
