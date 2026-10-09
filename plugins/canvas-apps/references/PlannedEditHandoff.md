# Planned EDIT Handoff

Use only after the Planned EDIT route in `${PLUGIN_ROOT}/references/EditWorkflow.md`, including its Partitioned fallback. `Create` dispatch rows add screens to an existing app; whole-app CREATE has a separate workflow.

The coordinator owns shared-file changes, dispatch, cross-file conformance and compilation. Apply `${PLUGIN_ROOT}/references/EditConformance.md` throughout and `${PLUGIN_ROOT}/references/ValidationWorkflow.md` at every compile/repair gate.

## Accept the planner handoff

Check the planner result before accepting artifacts, including after replanning. `Status: Blocked`, a failed tool or an incomplete handoff is not success even if old files remain. Use EditWorkflow's bounded reconciliation policy: implementation-only gaps return for targeted planning; material scope, UX/data or version-migration decisions return to the maker.

Read the current requirements, plan index, shared plan and every dispatched brief. Require:

| Contract | Acceptance condition |
|---|---|
| Approved scope | The coordinator-authored `[working directory]/canvas-app-requirements.md` retains contract version 1, original intent, device constraints and the Change and Preservation Contract. No unapproved upgrade, mock substitution, restructuring or cleanup. |
| Coverage | Every original capability key maps to its affected actions, required record fields, observers and success/negative scenarios. No requested clause disappears during planning. |
| Actions | Each action has an eligible entry, owner, source/stable identity, transition, observable result and relevant invalid/empty/cancel behavior. Opposing actions remain separate; shared-operation selectors do not also mutate. |
| Feedback | Each mutation uses `${PLUGIN_ROOT}/references/MutationBehavior.md`: `Feedback: Preserve` uses existing feedback/source-bound observers and static field proofs; `Feedback: Receipt` carries the approved result-surface contract. |
| Shared dependencies | Source/schema types, state ownership, initialization, navigation/return context and justified dataset bounds are coherent across consumers. Screen-local formula syntax may be chosen by its builder. |
| Dispatch | Every row has Action, Screen, Target File, YAML Key, Name Prefix and Screen Brief. Paths are absolute under `[working directory]`; files and new-control prefixes do not overlap. Modify preserves the existing screen key. |
| Builder context | The shared plan and all briefs exist and agree with dispatch. Each brief contains its relevant scope, preserved contracts, actions/scenarios, required fields, resource contracts and Control Decisions query identities. No unresolved shared decision or assignment placeholder remains. |
| Shared edits | `App Changes` has `Before builders` and `After builders` groups, each with exact coordinator-owned changes or `None`. `Editor State Changes` supplies exact final order lists or `None`. |

Validate semantics and ownership, not a second handwritten copy of the future screen YAML. Require exact values for approved literal edits, existing bindings to preserve and cross-file interfaces; obtain builder-local control/formula evidence from the written files.

If acceptance fails, send only the missing decisions and affected files to the planner under the bounded retry policy. Do not dispatch from an incomplete or stale plan.

## Apply shared prerequisites

Apply `Before builders` changes to `[working directory]/App.pa.yaml`, then call `compile_canvas`. Resolve App-level, structural and shared-schema errors before dispatch. The planner writes artifacts only; it neither edits app YAML nor compiles.

Keep future-screen references only when they match a known pending dispatch row. All other diagnostics follow ValidationWorkflow's scope and progress policy.

## Dispatch screen waves

Invoke `canvas-screen-builder` with `Task` once per row, in waves of at most three. Supply:

```text
Action: Create | Modify
Screen: <logical name>
Target file: [working directory]/<file>.pa.yaml
YAML screen key: <dispatch key>
Control name prefix: <prefix for new controls>
Shared plan: [working directory]/canvas-app-shared.md
Screen brief: [working directory]/<file>.screen-plan.md
```

Builders read their assigned context and describe changed/added controls directly. They do not inspect peer screens or discover missing shared resources. Wait for the complete wave before inspecting, repairing shared files or compiling.

For each result:

1. Confirm the target file contains the requested delta and preserves the scoped existing behavior. Added screens must have meaningful visible leaf controls, not just roots.
2. Require `QA scope:`, `Preservation:`, coverage/repairs/N/A lines, applicable numeric layout evidence and one concrete `Functional:` trace per assigned action. A trace names eligibility, event, source/stable ID, postcondition and observer.
3. Reuse valid file-local evidence; inspect changed assumptions and independently check affected cross-file behavior and critical geometry. Generic PASS claims do not establish correctness.
4. For missing local QA, request an inspection/repair of the existing screen, not regeneration. For `Status: Blocked`, reconcile the missing shared decision, query identity, version contract or assignment through the planner before resuming targeted work.
5. Compile before the next wave. Repair existing files in place; update shared contracts and undispatched briefs for systemic defects. Reconcile written consumers when shared assumptions change. Never regenerate screens to fix compiler diagnostics.

## Integrate and finalize

Wait for all builders and follow-ups. Apply `After builders` app changes and editor ordering, leaving `None` groups untouched.

Check affected cross-screen consumers, repeated navigation/presentation, stable identity through return paths, and required fields/actions against actual YAML. Follow ValidationWorkflow for detailed functional, mutation, layout and acceptance evidence. It owns the final gate; do not duplicate its acceptance tables in the handoff.

Finish every inspection and artifact write before finalization. No worker may remain running or queued. The final successful `compile_canvas` must follow the last mutation and be the final tool call before the summary.
