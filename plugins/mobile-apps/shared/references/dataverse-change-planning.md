# Dataverse planning for scoped changes

Use this contract from `setup-datamodel`, `edit-app`, and standalone
`add-dataverse` when proposing Dataverse schema or a new table binding. It
adapts the existing create-flow planning helpers to the owner's current delta;
it does not invoke `/create-mobile-app` or add another approval gate.

## 1. Establish the scope before discovery

Retain one absolute `working_dir`, the current request, the existing plan, and
the owner's planning/implementation mode across every call and retry.
Planning is not implementation approval, including after an entry-mode choice
or an edit-impact preview.

- Connector-only, native/design-only, removal-only, and retained-service-only
  refresh requests skip this workflow. Use their existing scoped workflows;
  do not create empty Dataverse artifacts or require a data-model receipt.
  Mark planning paths as not supplied for this invocation; never consume old
  scratch artifacts merely because they remain on disk.
- For Dataverse changes, separate proposed schema/binding changes from retained
  context and retirements. Unaffected plan rows, screens, and generated services
  are not permission to replay schema work.
- The structured contract contains only the proposed delta and its necessary
  Dataverse dependencies. Represent existing dependencies as `reuse`, not
  `create`/`extend`; do not copy historical creation rows from the full plan.
  Preserve unrelated services outside this contract. A missing dependency that
  would require additional mutations goes into the proposal for approval.
- Preserve approved native capture/storage intent and connector ownership.
  Connector-owned records do not become Dataverse tables unless an explicit
  projection is part of the request. Diagram entities express desired intent,
  not evidence that a table exists or permission to replace it.

Read the selected environment ID from the owner's `power.config.json`.
Resolve missing context using the shared non-persisting environment rule:

```bash
cd "<working_dir>" || exit 1
node "${PLUGIN_ROOT}/scripts/resolve-environment.js" "<selected-environment-id>" --no-cache --require-tenant
```

Require the resulting environment ID, HTTPS URL, and tenant to match the
selected app and any supplied owner context. On conflict, return
`NEEDS_CONTEXT` to the owner before discovery; never select another environment
silently. Resolve authentication/access failures through the existing bounded
foreground recovery, not by enabling persistent resolution.

Scratch proposals, evidence, and the planning-only inventory cache may be
written under this app's `.tmp/`; `_dm_section.md` is a proposal. Planning must
not change auth/app configuration, the materialized manifest, generated
services, server schema/data, or the live plan before its owning approval.

## 2. Obtain the canonical compact evidence

Read and execute only
[Foreground Dataverse planning snapshot and evidence](../../skills/create-mobile-app/SKILL.md#foreground-dataverse-planning-snapshot-and-evidence),
ending before **Planner completion dispatch**. This is the shared helper recipe,
not permission to run the create wizard, its planner, scaffolding, or gates.
Bind its inputs as follows:

| Create-flow input | Existing-app/data-only meaning |
|---|---|
| `WORKING_DIR` / `<working_dir>` | The owner's absolute app root; enter it in every shell invocation. |
| `<dataverse_planning_mode>` | `required` only for this Dataverse delta. |
| confirmed brief / Gate 1-approved architecture | The current request and retained native/connector constraints; not mutation approval. |
| `ACTIVE_ENV_ID`, `ACTIVE_ENV_URL`, `ACTIVE_TENANT_ID` | The same verified selected environment. |
| publisher-prefix metadata | Reuse matching verified context or run the existing read-only prefix detector for this target. |
| typed concepts | Only unresolved app-owned entity concepts in this delta; roles/fields/actions/statuses/constraints are not tables. |
| `<EXPLICIT_TABLES>` | Exact existing targets and necessary dependencies, not every table used anywhere in the app. |
| `<PROPOSED_TABLES>` | Every proposed final custom logical name, including adapted names. |

Use the existing progressive/combined read helpers, production read concurrency
`1`, identity-scoped inventory cache, and recovery rules unchanged. Explicit
targets use exact-name evidence; do not add broad concepts merely to increase
coverage. A valid cache is planning evidence only, never write authorization.
Resolve placeholders before executing the recipe; do not carry shell variables
implicitly between tool calls.

The outputs are the owner's absolute `SNAPSHOT_PATH` and
`ARCHITECT_EVIDENCE_PATH`. Validate the compact evidence against the full
snapshot with `render-dataverse-architect-evidence.js --validate-only` as the
recipe requires. Never dispatch on failed/stale output. Agents read only the
compact sidecar; the full snapshot is an opaque validator input.

## 3. Produce a proposal on every path

Use this handoff for the architect, including retries:

```text
Task: mobile-app:data-model-architect
Context:
  working_dir: <absolute owner root>
  phase: planning
  proposal_only: <true for --plan-only or a planning-phase caller>
Prompt:
  Current request and proposed scope: <delta, retained constraints, dependencies>
  Existing Data Model: <context only; preserve unaffected decisions>
  Approved native capabilities and connector ownership: <current constraints>
  Dataverse planning mode: required
  Normalized Dataverse foreground planning snapshot (validator input only): <SNAPSHOT_PATH>
  Compact Dataverse architect evidence: <ARCHITECT_EVIDENCE_PATH>
  Structured schema contract output: <working_dir>/.tmp/dataverse-schema-contract.json
  Output proposal: <working_dir>/_dm_section.md
  Working directory: <working_dir>
  Plugin root: ${PLUGIN_ROOT}
  Return a scoped proposal and normalized contract; do not save the live plan,
  grant approval, run live discovery, or apply changes.
```

For a diagram, parsed text, existing-plan delta, or unavailable-agent inline
fallback, produce the same two outputs using the architect's
[structured schema contract](../../agents/data-model-architect.md#structured-dataverse-schema-contract-required-for-required-mode)
and validated compact evidence. Never use local models or Mermaid alone as
proof of current server metadata. Merge only the accepted delta into the full
plan later; do not replace its unaffected sections with the scoped contract.

## 4. Validate before the owner's existing gate

After every proposal or revision, normalize and validate:

```bash
cd "<working_dir>" || exit 1
node "${PLUGIN_ROOT}/scripts/build-dataverse-operation-manifest.js" \
  --normalize-contract "<working_dir>/.tmp/dataverse-schema-contract.json" \
  --output "<working_dir>/.tmp/dataverse-schema-contract.json"
```

Only if normalization succeeds:

```bash
cd "<working_dir>" || exit 1
node "${PLUGIN_ROOT}/scripts/validate-dataverse-planning-decisions.js" \
  --contract "<working_dir>/.tmp/dataverse-schema-contract.json" \
  --snapshot "<SNAPSHOT_PATH>"
```

`DONE` / `DONE_WITH_CONCERNS` from an agent is not a validation result. Verify
that the section and contract describe the same delta and that neither exceeds
the requested scope. Only exit `0` permits presenting an executable proposal
at the owner's existing approval gate. Surface `Adapt`/`Defer` and other
concerns there; a deferred required dependency cannot be described as complete.

Handle structured signals before generic agent retry limits, using
[Dataverse planning recovery](../../skills/create-mobile-app/SKILL.md#dataverse-planning-recovery):

| Result | Owner action |
|---|---|
| Exit `3`, `NEEDS_CONTEXT: detailed-dataverse-metadata:<names>` | Expand only names not already fully attempted, then regenerate/validate compact evidence and re-dispatch. |
| Exit `3`, `NEEDS_CONTEXT: proposed-dataverse-names:<names>` | Run the separate collision-only check for new final names; never reinterpret it as detail discovery. |
| Exit `4`, `NEEDS_REVISION: dataverse-plan-validation` | Revise automatically from the same evidence, with safe validator errors; no metadata read or user question for a routine correction. |
| `NEEDS_CONTEXT: dataverse-plan-revision:<classification>` | Use the inline revision fallback, not a generic context retry. |
| Exit `2`, invalid/mismatched artifacts, or a hard blocker | Report the failure and return to the artifact owner; no approval, mutation, stale-output fallback, or downgrade to success. |

The recipe's `DETAIL_ATTEMPTED_NAMES` and `PROPOSED_CHECKED_NAMES` are separate
monotonic sets. `core` detail remains eligible for full-detail expansion;
already-unavailable names are not fetched repeatedly. Continue for new names
derived from this request/evidence, not unrelated plan rows. On no progress,
revise inline using current evidence or explicitly defer unsupported work.
Ask the user only when a remaining alternative changes business semantics.
Never import creation's Gate 1/2 prompts into this owner.

For `--plan-only`, return the validated proposal (or explicit blocker) at the
owner's proposal boundary. `setup-datamodel` and `add-dataverse` do not save the
live plan; `edit-app` may save plan documents only after its explicit
plan-document approval. None of these modes grants implementation approval or
mints an execution receipt.

## 5. Carry the accepted scope into implementation

After the existing gate approves implementation, save only the accepted plan
delta. Carry the absolute `planning_snapshot`, `architect_evidence`, and
`schema_contract` paths in the leaf context. In `approved_scope`, record the
exact accepted operations/dependencies plus `contract_sha256` (SHA-256 of the
normalized contract file bytes) and `plan_sha256` (the final saved plan bytes).
These are evidence bindings in the existing invocation context, not a new
receipt format. Revisions or changed files require returning to the owner;
never recalculate these approval hashes after discovering a mismatch.

The existing five-artifact operation-manifest fast path remains
creation-receipt-owned. Its receipt requires `workflow: create-mobile-app`
and four approvals. Do not fabricate those approvals for setup/edit, weaken
receipt validation, or pass a partially populated fast-path argument set.
Setup/edit use the scoped standalone execution path with their real approval.
On resume without matching approval context, return `NEEDS_CONTEXT`; an old
plan or scratch artifact does not grant permission.

Before execution, `add-dataverse` checks these hashes, target identity, compact
evidence, and planning decisions, then performs its existing fresh bounded
live reconciliation for the scoped contract. It must not reconstruct mutation
scope from all rows in the saved Markdown plan, trust the planning cache as
current write evidence, or silently adapt names/requirements after approval.
Preserve verified unrelated services; a missing/out-of-scope binding returns
to the owner. A service-only refresh or app-binding retirement retains its
separate branch and does not become a schema mutation.

Keep both upstream publish/cache-invalidation recovery paths intact. Successful
publication plus failed cache cleanup is unfinished work, not permission to
replay writes. Preserve pending offline-retirement outcomes independently of
addition checks; this workflow never authorizes profile deletion.
