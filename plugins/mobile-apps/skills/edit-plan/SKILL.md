---
name: edit-plan
description: Use when the user wants to change one approved section of an existing native-app-plan.md without applying app, Dataverse, connector, native, or design mutations yet; records a lifecycle-aware pending change for /edit-app --apply-plan.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task
model: opus
---

**Shared instructions: [shared-instructions.md](../../shared/shared-instructions.md)** - read first.

# Edit Plan

Surgically update one approved section of `native-app-plan.md`, re-run that
section's approval gate, keep its machine-readable planning artifacts
consistent, and record a durable pending-apply handoff. This skill does not
change app source, generated services, Dataverse, connectors, native wrappers,
brand files, sample data, or lifecycle sync hashes.

Use `/edit-app` instead when the user expects the app to change in the same
request.

## Inputs

- `--working-dir <path>` - default current directory.
- `--section <data-model|native|connectors|screens|design>` - optional when the
  request makes the section unambiguous.
- Free-text change request in `$ARGUMENTS`.

## Non-Negotiables

- Require an existing app plan and `.mobile-app/state.json` (or migrate a
  compatible legacy state per `lifecycle-state.md`).
- Stop when `dataMode: transitioning`; `/prototype-to-real-app` owns changes
  until conversion completes.
- Edit exactly one major section per invocation. A cross-section feature
  belongs to `/edit-app`, where all dependencies can be approved together.
- In prototype mode, Data Model edits must produce a complete normalized schema
  contract marked `planningMode: "prototype"` and
  `executionEligible: false`. Never invoke Dataverse.
- In Dataverse mode, this workflow may perform read-only discovery but must not
  create an executable operation manifest or write metadata.
- Leave `lastSyncedPlanHash` and `lastDataverseManifestHash` unchanged. Their
  mismatch is how `/edit-app` and `/sync-from-plan` detect unapplied work.
- Never tell the user to invoke raw screen-builder agents or a partial `/add-*`
  chain. The single supported apply handoff is `/edit-app --apply-plan`.

## Workflow

### Step 1 - Verify Plan, State, And Pending Work

Require:

```bash
test -f "$PROJECT_DIR/native-app-plan.md"
test -f "$PROJECT_DIR/package.json"
test -f "$PROJECT_DIR/.mobile-app/state.json"
test -f "$PROJECT_DIR/.tmp/mobile-plan-execution-contract.json"
node -e "const c=require(process.argv[1]); if(c.schemaVersion!==3) process.exit(1)" \
  "$PROJECT_DIR/.tmp/experience-screen-contract.json"
```

Read the plan, lifecycle state, memory bank, current structured schema contract
when present, real Dataverse manifest when present, and
`.mobile-app/plan-change.json` when present.

If the screen contract is v1/v2 or the execution contract is absent, stop with
`BLOCKED: legacy plan requires explicit schema-v3 re-plan before editing`.
Never infer missing operations from existing TSX or Markdown.

If a pending plan change already exists, show its sections/request/hash and ask:

- **Apply first** - invoke `/edit-app --apply-plan` and stop.
- **Replace pending change** - continue only after explicit confirmation; keep
  the old record in memory-bank history.
- **Cancel** - no mutation.

Reject a plan whose current SHA-256 does not match the pending record unless the
user chooses to replace it. Do not silently stack untracked edits.

### Step 2 - Select One Section

Infer from the request or ask:

| Section | Examples |
|---|---|
| Data Model | Add/rename/remove entity, field, relationship, choice, file/image column |
| Native Capabilities | Add/remove camera, location, files, sharing, secure storage |
| Connectors | Add/remove SharePoint, Outlook, Teams, Office 365 Users, other connector |
| Screens | Add/remove/reorder screen, navigation, states, fields, actions |
| Design Direction | Change one of palette, typography, components, density, negatives, or motion |

If the request changes more than one section, stop and route to `/edit-app`.
Data fields and the screens that consume them are one cross-section feature,
not two independent plan-only edits.

Capture the exact current section and the current plan hash before drafting.

### Step 3 - Draft The Replacement Section

#### Data Model

Spawn `mobile-app:data-model-architect` in edit mode with the current section,
full app requirements, relevant screen contracts, and the user's request.

For `dataMode: prototype`, pass:

```text
Dataverse planning mode: prototype
Target environment: NOT SUPPLIED
Publisher prefix: cr (prototype placeholder only)
Mode: edit; preserve unaffected table/column identities and stable choice values.
```

Require one fenced `data-model-draft` JSON response with `dataModelMarkdown`,
`dataverseSchemaContract`, and warnings. The foreground workflow validates the
returned contract and writes the approved section/sidecar; the agent never
writes a project or scratch file. For prototypes, the contract must retain
`planningMode: "prototype"` and `executionEligible: false`. The agent must not
reset unchanged option integers, primary keys, logical names, relationships, or
alternate keys merely because one field changed.

For `dataMode: dataverse`, pass the current real manifest and environment facts
for read-only reconciliation. Draft Reuse/Extend/Create/Adapt/Defer decisions,
but do not write metadata or create a real operation manifest. Mark any target
fact that could not be verified as `Unverified` and block application until it
is resolved by `/edit-app`.

#### Native Capabilities

Edit the capability matrix inline. Gate every added native capability against
the current template allowlist and runtime bans. Preserve unaffected rows.

#### Connectors

Follow `shared/references/connector-planning.md` Infer -> Confirm -> Record.
Dataverse is not a connector. In prototype mode connectors remain planned
throw-stubs; no connection is created.

#### Screens

Spawn `mobile-app:screen-planner` in edit mode with the locked Data Model,
Native Capabilities, Connectors, Design Direction, existing Screen Map,
Navigation Contracts, and per-screen specs. Preserve unaffected routes and
contracts. A screen edit must not invent a missing data field or capability;
route that request to `/edit-app` instead.

#### Design Direction

Edit only the selected design dimension in the plan. Do not invoke
`/design-system` here because that mutates `brand/`; `/edit-app --apply-plan`
owns the later brand/token update.

Parse every agent result using the literal first-line status protocol. On
`NEEDS_USER_APPROVAL`, persist or request the matching outer textual approval
before applying the plan; do not classify it as `BLOCKED` or silently continue. Retry
`NEEDS_CONTEXT` at most twice, surface `DONE_WITH_CONCERNS`, and stop on
`BLOCKED` or malformed status.

### Step 4 - Gate The Section

Show a section-scoped before/after diff plus impact preview:

- app screens/routes likely affected;
- mock or real data services affected;
- native/connector/design specialists needed when applied;
- sample-data implications;
- whether prototype seed rows need schema-preserving regeneration;
- expected final validation gates.

Ask Approve / Revise / Cancel. Revision loops only this section. Cancel leaves
the plan and machine artifacts unchanged.

For Data Model edits, approval covers both the human section and the exact
machine schema contract hash. If either changes after approval, approval is
invalid.

Every section edit also reconciles `.tmp/mobile-plan-execution-contract.json`:
preserve all requirement IDs/source text, update `satisfiedBy` targets and
native/dependency/connector facts when affected, and validate all schema-v3
screen operations against the resulting data/execution contracts. A data or
screen edit writes the corresponding updated sidecar in the same foreground
transaction. Do not leave an old execution contract beside a new plan.

### Step 5 - Write Plan And Pending-Apply Record

Replace only the approved section; preserve all other plan bytes. Validate
`native-app-plan.md` and any updated schema contract through
`validate-mobile-files.js`.

Write `.mobile-app/plan-change.json`:

```json
{
  "schemaVersion": 1,
  "status": "approved-pending-apply",
  "dataMode": "prototype",
  "sections": ["Data Model"],
  "request": "<concise user request>",
  "previousPlanSha256": "<hash before edit>",
  "approvedPlanSha256": "<hash after edit>",
  "structuredContractSha256": "<hash or null>",
  "screenContractSha256": "<hash of .tmp/experience-screen-contract.json>",
  "executionContractSha256": "<hash of .tmp/mobile-plan-execution-contract.json>",
  "affectedScreens": ["<screen ids, or empty when none>"],
  "sampleDataImpact": "preserve-compatible-seeds|none|review-required",
  "createdAt": "<ISO timestamp>"
}
```

Use the actual lifecycle mode. `structuredContractSha256` is required for a
Data Model edit and otherwise preserves the current value when one exists.
`screenContractSha256` and `executionContractSha256` are always required.

After the updated plan and sidecars validate, remove
`.tmp/screen-build-pack.json`. The approved pending record preserves the hashes
needed by `/edit-app --apply-plan`; deleting the derived pack prevents preview,
debug, deploy, or direct sync from treating the previous operations as current.
`/edit-app --apply-plan` recompiles it after mode-specific specialists finish.

Do not update lifecycle sync hashes. Append one Plan history row to
`memory-bank.md` with section, request, pending status, and new plan hash.

Print the unified section diff and pending record path.

### Step 6 - Apply Handoff

Return:

```text
DONE

Plan section updated: <section>
App/data mutations: not applied
Pending handoff: .mobile-app/plan-change.json
Next: /edit-app --apply-plan --working-dir <PROJECT_DIR>
```

`/edit-app --apply-plan` must verify the approved plan/contract hashes, apply
mode-specific specialists, preserve compatible prototype seeds, run one
`/sync-from-plan`, and mark the pending record applied. The user must not need
to repeat the request or re-approve the same section.