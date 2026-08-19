# Stage Playbook

Every stage is an independent skill executed in validated 10-12 minute waves. It continues through as many waves as needed before the orchestrator advances.

## Required Order

1. `plan`
2. `screen-design`
3. `component-library`
4. `app-builder`
5. `native-capabilities`
6. `connections`
7. `dataverse-schema`
8. `dataverse-adapters`

No stage may invoke or implement a later stage. Native integration always precedes non-Dataverse connector integration, and connector integration always precedes Dataverse.

## State File

Create `.stages/mobile-app-state.md` after Stage 1 with:

```markdown
# Mobile App State

## Project
- Name:
- Workspace:
- Data mode: mock
- Last updated:

## Environment
- Environment ID:
- Environment URL:
- Solution:
- Publisher prefix:
- Power Apps identity:

## Template Compatibility
- Classification: compatible | compatible-with-deviations | incompatible
- Runtime versions: Expo / React Native / React / Tamagui / Power Apps host / offline
- Available scripts:
- Provider and auth shell:
- Host provider inputs and applicable provider exports:
- App provider composition order:
- App theme / typography roles / icon family:
- Root customization markers:
- Generated configuration: power config / offline profile
- Recorded at:
- Deviations or blockers:

## Stages
| Stage | Status | Checkpoint | Validated |
|---|---|---|---|
| 1. Plan | complete | Requirements, screen graph, and implementation plan | YYYY-MM-DD |
| 2. Screen design | pending | | |
| 3. Component library | pending | | |
| 4. App builder | pending | | |
| 5. Native capabilities | pending | | |
| 6. Connections | pending | | |
| 7. Dataverse schema | deferred | | |
| 8. Dataverse adapters | deferred | | |

## Routes
| Screen ID | Route | Workflow | Data/integrations specified | Status |
|---|---|---|---|---|

## Data Model
| Entity | Mock repository | Dataverse logical name | Status |
|---|---|---|---|

## Native Capabilities
| Capability | Wrapper | Workflow | Validation | Status |
|---|---|---|---|---|

## Connections
| Connector | Connection/reference | Adapter | Mock fallback | Status |
|---|---|---|---|---|

## Stage Handoffs

_One manifest per stage using `stage-contract.md`. The next stage consumes this record rather than chat history._

## Decisions
- YYYY-MM-DD: decision and reason

## Blocks
- None
```

Statuses are `pending`, `in-progress`, `complete`, `deferred`, or `blocked`. Update after each checkpoint, not only at the end.

Refresh `## Template Compatibility` whenever a stage changes dependencies, root configuration, provider/auth wiring, generated configuration, or routes that affect the auth shell. Later stages reuse the snapshot and verify only affected files, direct dependencies, and declared preconditions; they record any drift in their handoff.

## Timebox Rules

- Planning uses one open prompt plus at most two structured batches only when required information is missing, then covers one primary workflow and supporting workflows rather than speculative future modules.
- Screen design covers the approved screen set and produces one coherent specification package.
- Component library waves contain one related reusable component group.
- App builder waves contain at most three related screens.
- Native waves contain one related capability group.
- Connection waves contain one related connector group.
- Dataverse schema waves contain one dependency tier.
- Adapter waves contain one related repository group.
- At each wave boundary, validate, update state, and continue automatically. Do not stop for user confirmation except for the one required trial after App Builder completes and exposes the mock app in web review mode.

## Checkpoint Rules

Every checkpoint records:

1. artifact produced;
2. executable validation run;
3. result and unresolved risk;
4. review target and a concrete task the user can perform;
5. changed files and state update;
6. consumed inputs and exported outputs/contracts;
7. explicit next-stage preconditions;
8. next stage or wave;
9. whether a safety approval is required.

## Failure And Resume

- Never mark a stage complete after a failed gate.
- Keep the last working data mode available. A native, connector, or Dataverse failure must not break the approved mock app.
- Retry a failing command once only after identifying and applying a concrete local fix.
- Record partial Dataverse resource IDs immediately to prevent duplicate creation.
- On resume, reconcile the active stage's declared inputs, prior changed-files list, and owned external resources with live state. Do not rescan unrelated template files; live state wins for inspected discrepancies, which are appended as decisions.

## Interaction Gates

Do not ask for routine stage approval or permission to continue. Interrupt only for:

1. required product/environment information that cannot be inferred or discovered;
2. a material ambiguity that would change visible behavior or data semantics;
3. exact connector connection/data-source mutation approval;
4. exact Dataverse schema mutation approval;
5. destructive work, writes outside the project, or deployment.

Do not interrupt for file reads, commands, deterministic fixes, wave boundaries, completed stages, artifact review, or validation that the agent can perform.

After Stage 4 alone, stop with the web URL and one concrete workflow for the user to try. Record `Interaction: awaiting App Builder review`, keep Stage 5 pending, and resume only after feedback or an explicit continue response. This is a product trial gate, not approval for tenant mutation.