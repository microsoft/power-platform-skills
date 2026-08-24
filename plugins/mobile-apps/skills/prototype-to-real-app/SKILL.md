---
name: prototype-to-real-app
description: Use when the user wants to graduate an existing neutral-domain Power Apps mobile prototype to a selected environment, Dataverse, auth, and real connectors without rewriting screens or feature hooks.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, Skill
model: opus
---

**Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** - read first.

# Prototype To Real App

Convert a `/create-mobile-prototype` project in place. The neutral domain model,
repository interfaces, TanStack Query hooks, navigation, screens, and design
remain canonical. Graduation binds a real environment, reconciles Dataverse
metadata, and replaces only repository/connector adapters.

## Inputs

- `--working-dir <path>`: defaults to current directory.
- `--environment <environment-id>`: optional; ask when absent.
- `--no-sample-data`: do not seed approved fixture records.
- `--skip-auth-registration`: leave client ID unresolved and report a blocker.
- `--force`: reconstruct missing state only after explicit confirmation and
  strong neutral-prototype evidence.

## Invariants

- Never scaffold/copy a new app or invoke `/create-mobile-app` as a creation
  workflow.
- `.tmp/prototype-domain-model.json` remains canonical before and after
  graduation. Do not replace domain keys/types with Dataverse logical names.
- Screens and feature hooks remain unchanged and may import only `@/data`.
  Generated service imports are allowed only in
  `src/data/repositories/dataverseRepositories.ts` or an approved connector
  adapter boundary.
- Prototype review/approval cannot authorize real mutation. Obtain normal
  explicit confirmation immediately before binding/provisioning.
- Do not mutate until environment, tenant, solution, publisher, schema
  decisions, operation impact, and fresh reconciliation are visible.
- Do not set `dataMode: dataverse` until generated services, repository
  adapters, connector adapters, auth, and final validation all pass.
- Conversion is resumable through `.mobile-app/state.json`; never hide partial
  completion by weakening validation or deleting prototype evidence.

## Progress

```text
-> [real 1/9] Verifying the neutral prototype baseline...
-> [real 2/9] Selecting and resolving the target environment...
-> [real 3/9] Planning and approving real persistence changes...
-> [real 4/9] Binding the existing app and applying Dataverse changes...
-> [real 5/9] Reconciling domain semantics with live metadata...
-> [real 6/9] Generating Dataverse and connector repository adapters...
-> [real 7/9] Seeding approved fixtures and restoring auth...
-> [real 8/9] Running unchanged-screen and runtime validation...
-> [real 9/9] Committing lifecycle state and reporting readiness...
```

## Resume Model

Read `.mobile-app/state.json` first:

| State | Action |
|---|---|
| `prototype` | Start at Step 1. |
| `transitioning` to `dataverse` | Recheck the previous phase, then resume exactly at `transition.phase`. |
| `dataverse` with passing dispatcher result | Return `DONE`; use ordinary sync only for later plan changes. |
| Missing state with strong domain manifest/model/provider markers | With `--force`, show inferred facts and ask before reconstructing schema v2 state. |
| Conflicting markers | Stop and report them; never guess. |

Update phase only after its postconditions pass. On failure, leave the current
phase and print the exact resume invocation.

## Workflow

### 1. Verify The Neutral Prototype

Require:

```bash
test -f "$PROJECT_DIR/native-app-plan.md"
test -f "$PROJECT_DIR/.tmp/prototype-domain-model.json"
test -f "$PROJECT_DIR/.mobile-app/prototype-domain-manifest.json"
test -f "$PROJECT_DIR/.mobile-app/state.json"
test -f "$PROJECT_DIR/src/data/contracts.ts"
test -f "$PROJECT_DIR/src/data/repositories/mockRepositories.ts"
test -f "$PROJECT_DIR/src/data/repositories/dataverseRepositories.ts"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-app.js" \
  --project-root "$PROJECT_DIR" --scope all
```

Require lifecycle schema version 2 and `dataMode: prototype`. Reject a legacy
`src/generated/.prototype-manifest.json`; run the compatibility migrator from
`/create-mobile-prototype` first.

Record hashes of `app/`, `src/components/`, non-generated `src/hooks/`, and the
screen contract. These are the unchanged-screen baseline. Archive the local
prototype approval as historical context; never pass it to Dataverse mutation.

### 2. Resolve Environment And Planning Facts

Resolve/list the user-selected environment through the existing environment
skill. Verify environment ID, URL, tenant, and display name agree. Ask for one
environment choice when absent.

Use the neutral domain as planning input to the data-model architect. Inspect
live metadata and choose reuse/extend/create per entity and field. Resolve the
real publisher prefix, solution, ownership, alternate keys, choice values,
relationships, and generated service requirements. Keep domain keys in one
column and real Dataverse names in a separate mapping column.

Write a real `.tmp/dataverse-schema-contract.json`; do not edit the domain
model to make it look like Dataverse. Update plan review sections and execution
contracts, then validate them.

### 3. Explicit Real-Mutation Approval

Present one final mutation summary immediately before the first external write:

- environment, tenant, solution, and publisher;
- tables reused/extended/created;
- columns, relationships, choices, keys, and ownership;
- generated data sources and connector bindings;
- sample-data and offline intent;
- unresolved conflicts or destructive changes.

Draft and record the normal real-app receipt:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/plan-checkpoints.js" \
  --project-root "$PROJECT_DIR" \
  --action draft \
  --workflow create-mobile-app
node "${CLAUDE_SKILL_DIR}/../../scripts/plan-checkpoints.js" \
  --project-root "$PROJECT_DIR" \
  --action approve \
  --workflow create-mobile-app \
  --section all \
  --response approve
```

No approval, no mutation. After approval, atomically set lifecycle state to
`dataMode: transitioning`, preserve all hashes, record the environment, and set
phase `binding`.

### 4. Bind And Apply Dataverse

Archive prototype-only `power.config.json` and review receipts without
overwriting earlier archives. Bind the existing directory with `power-apps
init`; if it proposes source, screen, package, or plan replacement, stop.

Verify bound environment facts exactly, configure app registration unless
skipped, then apply the approved schema through `/add-dataverse`. Use fresh live
reconciliation and mutation receipts; never pass the prototype receipt.

Require `.datamodel-manifest.json` plus a generated service for every mapped
entity. Advance phase to `reconciliation` only after metadata and generated
services validate.

### 5. Reconcile Domain To Dataverse

Run the conservative reconciler:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/reconcile-domain-dataverse.js" \
  --project-root "$PROJECT_DIR"
```

It writes:

- `.tmp/dataverse-reconciliation-report.json` with exact entity/field/choice/
  operation matches, warnings, and conflicts;
- `.tmp/dataverse-repository-mapping.json` only when no blocker remains.

Review every ambiguous entity/field, unsupported image/file transform, choice
label/value mismatch, money currency ambiguity, missing service, and missing
operation. Resolve conflicts in approved planning/mapping inputs and rerun.
Never make a best-effort adapter from a blocked report.

### 6. Generate Repository And Connector Adapters

Generate the Dataverse implementation behind existing interfaces:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/gen-dataverse-repositories.js" "$PROJECT_DIR"
npm --prefix "$PROJECT_DIR" run type-check
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-app.js" \
  --project-root "$PROJECT_DIR" --scope domain
```

This may overwrite only
`src/data/repositories/dataverseRepositories.ts`. It maps real rows, choices,
money, IDs, filters, sort, cursors, and writes into canonical domain records.
Do not modify screen files, domain model/types, contracts, or hooks.

For every planned non-Dataverse connector, run the owning connector skill and
place its calls behind the approved repository/adapter boundary. Raw connector
calls in screens are blockers. Verify native wrappers but do not rebuild them.

Advance phase to `seeding` only when every required adapter is real and all
connector throw-stubs are gone.

### 7. Optional Sample Data And Auth

Unless `--no-sample-data`, transform approved neutral fixtures through the
reviewed repository mapping and seed via `/add-sample-data` in dependency order.
Preserve stable IDs when supported; remap references through the insertion
result. Never seed generic rows or exceed approved inventory/relationship
constraints.

Switch runtime configuration only after adapters pass:

```bash
node "${CLAUDE_SKILL_DIR}/../create-mobile-prototype/scripts/configure-prototype-runtime.js" \
  "$PROJECT_DIR" dataverse
```

This restores the real predev/schema generation command and auth guards. The
same `PrototypeDataProvider` remains mounted under `PowerAppsProvider`; its
repository factory now selects Dataverse adapters from `dataMode`.

If offline behavior is required, run `/setup-offline-profile` only now, preview
its scope, and assign it after explicit approval. Advance phase to `validation`.

### 8. Prove Screens Did Not Change

Recompute the baseline hashes. Any change under screen/navigation/shared UX
files must be explained by an independently approved non-data fix; adapter
generation itself must produce no screen diff.

Run:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/compile-screen-build-pack.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-app.js" \
  --project-root "$PROJECT_DIR" --scope all --record
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-composition.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-shells.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-experience-media.js" \
  --project-root "$PROJECT_DIR"
```

Exercise the critical flow against real data, including one list/get, one
mutation when approved, choice formatting, money, relationships, offline/error
states, auth redirect, and media fallback. Never replace a failing real adapter
with mock data to pass validation.

### 9. Commit Lifecycle State

Only after all gates pass, atomically set:

- `dataMode: dataverse`;
- the verified environment facts;
- `transition: null`;
- current plan/screen/execution/Dataverse manifest hashes;
- current `lastDomainModelHash`, `lastRepositoryMappingHash`, and
  `lastFixtureRevision`;
- passing `lastValidation` metadata and `lastSyncAt`.

Completion output must report environment/solution, reconciled mappings,
created/extended/reused tables, generated repository/connector adapters,
sample-data result, auth/offline status, unchanged-screen proof, and validation
results. Report `--skip-auth-registration` as a blocker, not a successful fully
wrapped app.