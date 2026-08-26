---
name: prototype-to-real-app
description: Use when the user wants to convert or graduate an existing mock-data Power Apps mobile prototype into a real app backed by a selected Power Platform environment, Dataverse, and real connector services without scaffolding a new project.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Task, Skill, EnterPlanMode, ExitPlanMode
model: opus
---

**Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** - read first.

# Prototype To Real App

Convert an existing `/create-mobile-prototype` project in place. Preserve its
approved product design, navigation, screens, and user-authored code while
replacing mock repository/auth integration with a selected Power Platform
environment, live Dataverse schema, generated repository adapters, and real
connectors.

## Inputs

- `--working-dir <path>` - default current directory.
- `--environment <environment-id>` - optional. Ask when absent.
- `--no-sample-data` - do not copy prototype scenarios into Dataverse.
- `--skip-auth-registration` - leave the client ID blank and report a final
  concern. Tenant/environment wiring is still required.
- `--force` - allow state reconstruction only when strong prototype markers
  exist and the user explicitly confirms.

## Non-Negotiables

- Do not invoke `/create-mobile-app`, scaffold a new app, or copy a template.
- Do not pass the prototype schema contract or approval receipt to the real
  operation-manifest fast path. They were approved without target metadata and
  are intentionally non-executable.
- Do not perform metadata writes until the selected environment, tenant,
  publisher prefix, solution, and a fresh live reconciliation are confirmed.
- Do not mark state `dataverse` before real services replace every mock and
  `/sync-from-plan --target-data-mode dataverse` passes.
- For neutral-domain prototypes, preserve
  `.tmp/prototype-domain-model.json`, `src/data/model.ts`, repository
  interfaces, hooks, screens, and navigation. Reconcile Dataverse behind those
  interfaces; do not rewrite screens to generated service calls.
- Do not delete a marker-bearing mock service merely to satisfy cleanup. First
  prove a real generated replacement exists and no app code imports the mock.
- Do not allow child data/native/connector skills to rebuild screens. This
  orchestrator invokes `/sync-from-plan` exactly once at the end.
- Preserve a resume checkpoint in `.mobile-app/state.json` before the first
  irreversible operation. Conversion is resumable, not rollback-based.

## Progress Contract

```text
-> [real 1/10] Checking prototype state and quality baseline...
-> [real 2/10] Confirming the Power Platform environment...
-> [real 3/10] Binding the existing project to that environment...
-> [real 4/10] Reconciling the prototype model against live Dataverse...
-> [real 5/10] Applying tables and real generated services...
-> [real 6/10] Replacing connector stubs and verifying native wrappers...
-> [real 7/10] Seeding Dataverse from prototype scenarios...
-> [real 8/10] Removing prototype runtime artifacts and restoring auth...
-> [real 9/10] Reconciling optional offline scope...
-> [real 10/10] Rebinding screens and running final gates...
```

## Resume Model

Read `.mobile-app/state.json` before doing anything:

| State | Action |
|---|---|
| `prototype` | Start at Step 1. |
| `transitioning` to `dataverse` | Verify the previous phase's postconditions, then resume from `transition.phase`. Never blindly skip a phase. |
| `dataverse` and cleanup check passes | Return `DONE`: already converted. Offer ordinary `/sync-from-plan` only when the plan changed. |
| Missing state with strong prototype markers | With `--force`, show the inferred facts and require confirmation before reconstructing state. Otherwise stop. |
| Conflicting markers | Stop and report them; do not guess. |

Update `transition.updatedAt` and `transition.phase` only after a phase's
postconditions pass. On failure, leave the current phase in state and report
the exact resume command.

## Workflow

### Step 1 - Verify Prototype And Quality Baseline

Require:

```bash
test -f "$PROJECT_DIR/package.json"
test -f "$PROJECT_DIR/app.config.js"
test -f "$PROJECT_DIR/native-app-plan.md"
test -f "$PROJECT_DIR/.mobile-app/state.json"
```

Require either the current neutral-domain markers:

```bash
test -f "$PROJECT_DIR/.tmp/prototype-domain-model.json"
test -f "$PROJECT_DIR/.mobile-app/prototype-domain-manifest.json"
test -f "$PROJECT_DIR/src/data/contracts.ts"
test -f "$PROJECT_DIR/src/data/repositories/mockRepositories.ts"
test -f "$PROJECT_DIR/src/data/repositories/dataverseRepositories.ts"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-app.js" \
  --project-root "$PROJECT_DIR" --scope domain
```

or, for a confirmed legacy prototype only,
`src/generated/.prototype-manifest.json`. Migrate that legacy prototype through
`create-mobile-prototype/scripts/migrate-legacy-prototype.js` before continuing
so conversion has one stable repository boundary.

For a fresh conversion, also require the non-executable planner artifacts:

```bash
node -e "const c=require(process.argv[1]); if(c.planningMode!=='prototype'||c.executionEligible!==false) process.exit(1)" \
  "$PROJECT_DIR/.tmp/dataverse-schema-contract.json"
test -f "$PROJECT_DIR/.tmp/mobile-plan-status.json"
```

Read `.tmp/final-validation.md`. It must be current for the plan hash and record
passing results for:

- `check-routes.js`
- `validate-screen-contracts.js`
- `validate-screen-quality.js --report`
- `validate-color-contrast.js --report`
- `npm run type-check`

If the file is absent, stale, or incomplete, invoke:

```text
/sync-from-plan --working-dir <PROJECT_DIR>
```

in prototype mode, then restart conversion. Do not discover weak screens only
after attaching a real backend.

Check that screens import data only from `@/data` and never import fixtures,
repositories, generated services, connectors, or seed JSON directly. Copy the
current `.tmp/screen-build-pack.json` to
`.tmp/pre-graduation-screen-build-pack.json` and record hashes of `app/`,
navigation, shared UX components, and hooks for the unchanged-UI audit.

### Step 2 - Resolve And Confirm Environment

Use current CLI auth handling from shared instructions:

```bash
npx power-apps auth-status --json
```

If the requested account is cached but inactive, use `auth-switch`; if absent,
use `login`. Do not use `az account set` to switch the standalone Power Apps
CLI.

Resolve the supplied/selected environment ID:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-environment.js" \
  "<environment-id>" > "$PROJECT_DIR/.resolved-environment.json"
```

Capture environment ID, URL, display name, tenant ID, and region. Verify Azure
CLI can acquire a token for that tenant because Dataverse helper scripts use
`az` independently from `npx power-apps`.

Show an explicit mutation gate:

```text
Environment: <display name>
ID: <environment ID>
URL: <Dataverse URL>
Tenant: <tenant ID>

This conversion can create or extend Dataverse tables, add data sources and
connections, insert sample rows, and optionally create an offline profile.
Proceed / Choose another environment / Cancel
```

After approval, write lifecycle state:

```json
{
  "dataMode": "transitioning",
  "environment": {
    "id": "<id>",
    "url": "<url>",
    "displayName": "<name>"
  },
  "transition": {
    "from": "prototype",
    "to": "dataverse",
    "phase": "binding",
    "startedAt": "<ISO>",
    "updatedAt": "<ISO>"
  }
}
```

Preserve the schema version and existing hashes.

### Step 3 - Archive Prototype Approvals And Bind Project

Prototype approvals are useful historical intent but unsafe execution input.
Before binding, create `.tmp/prototype-plan-artifacts/` and move these files
there on the first run:

- `.tmp/dataverse-schema-contract.json`
- `.tmp/mobile-plan-status.json`
- prototype `power.config.json` as `power.config.prototype.json`

Do not overwrite an existing archive on resume. Verify the archived contract
still has `planningMode: prototype` and `executionEligible: false`. Do not pass
any archived path as `--schema-contract`, `--approval-receipt`,
`--operation-manifest`, or related fast-path arguments.

Remove only the zero-environment prototype `power.config.json`, then bind the
existing project:

```bash
cd "$PROJECT_DIR"
npx power-apps init -t MobileApp \
  --display-name '<existing display name>' \
  --environment-id '<environment ID>' \
  --non-interactive
```

If `init` proposes to replace source, app, package, or plan files, stop and
surface the diff. Successful binding must change configuration only, not
scaffold another app.

Verify the new `power.config.json.environmentId` exactly matches the approved
environment and rerun `resolve-environment.js` from that ID. The resolved URL
and tenant must match Step 2.

Unless `--skip-auth-registration`, execute
`/set-app-registration-native` from the project root. The user may create the
Wrap registration and paste its client ID or explicitly skip. Always write the
resolved tenant/environment cache to `auth.config.json`; never invent a client
ID.

Advance transition phase to `dataverse`.

### Step 4 - Rebase Prefix And Perform Live Reconciliation

Detect the selected solution's real publisher prefix:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/detect-publisher-prefix.js" \
  "<environment-url>" \
  --tenant-id '<tenant-id>'
```

Then rebase only identifiers proven by the archived prototype contract:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/rebase-prototype-plan.js" \
  "$PROJECT_DIR" "<publisher-prefix>"
```

This writes an audit mapping and a still-non-executable rebased contract under
`.tmp/prototype-plan-artifacts/`; it does not recreate a real approval receipt.

Now read and execute `/add-dataverse` Step 4 as a **read-only preflight** from
the project root. Use its exact live batching, derived lookup/choice/Boolean
metadata checks, customization capability checks, and no-dead-end taxonomy.
Stop before Step 5 writes anything. Write the resulting matrix to
`.tmp/prototype-plan-artifacts/live-reconciliation.md`.

Present the live matrix in plan mode. Highlight every change from prototype
assumptions:

- Reuse or Extend instead of Create;
- publisher/name aliases;
- adapted columns or tables;
- deferred fields/dependencies;
- standard-table mappings;
- any user-visible field or relationship impact.

Ask Approve / Revise data intent / Cancel. On approval, replace the Data Model
section's prototype assumption matrix with the live decisions while preserving
its business schema and archived history. Any reconciliation drift between
this gate and `/add-dataverse` below returns to this gate.

Also write
`.tmp/prototype-plan-artifacts/live-name-map.json`, bound to the approved plan
hash, archived prototype-contract hash, environment ID/URL, and publisher
prefix. It must include every prototype table and field, including explicit
`defer` decisions:

```json
{
  "schemaVersion": 1,
  "approvedPlanSha256": "<hash>",
  "prototypeContractSha256": "<hash>",
  "environment": { "id": "<id>", "url": "<url>" },
  "publisherPrefix": "<prefix>",
  "tables": {
    "cr_inspection": {
      "logicalName": "cr123_inspection",
      "decision": "create",
      "columns": {
        "cr_name": { "logicalName": "cr123_name", "decision": "create" },
        "cr_siteid": { "logicalName": "cr123_siteid", "decision": "create" }
      }
    }
  }
}
```

Do not infer this map later from suffixes or generated filenames. It is the
identity bridge used by sample-data migration and field-binding repair.

### Step 5 - Apply Dataverse And Assert Postconditions

From the project root, execute `/add-dataverse --skip-planning`. This is the
standalone fallback path by design: pass no archived prototype contract,
receipt, reconciliation, operation manifest, or publish checkpoint.

`--skip-planning` suppresses duplicate sample-data/offline prompts. The child
must still perform its own fresh live reconciliation, execute metadata changes
sequentially, publish, add each required table through
`npx power-apps add-data-source`, write the real manifest, and type-check.

Resolve `MANIFEST_PATH` from `.datamodel-manifest.json`, then
`docs/plan-artifacts/.datamodel-manifest.json`. Assert:

- every non-deferred required table has a manifest entry and generated
  service;
- each table has exact logical name and entity set name when required by
  generated writes/seeding;
- lookups include schema name and target metadata;
- choice/Boolean columns include stable integer/label options;
- file/image columns and aliases match the approved live matrix;
- no old placeholder table name remains in current screen/data contracts.

Run the structural handoff validator:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-datamodel-manifest.js" \
  "$MANIFEST_PATH"
```

Reconcile `live-name-map.json` against the actual manifest and any final
Adapt/collision aliases chosen by `/add-dataverse`. If a final name differs
from the approved Step 4 matrix, return to the Step 4 gate. Otherwise enrich
the map with the final manifest facts and set:

- `approvedPlanSha256` from the final approved `native-app-plan.md` bytes;
- `prototypeContractSha256` from the immutable archived prototype contract;
- `dataverseManifestSha256` from the validated real manifest;
- the exact selected environment ID/URL.

Every non-deferred mapped table/column must resolve exactly once. The seed
migration planner rejects any stale hash or environment mismatch.

Run `npm run generate-schemas` and `npm run type-check`. Any missing manifest
fact or compile error blocks conversion.

Reconcile the neutral domain to the live manifest:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/reconcile-domain-dataverse.js" \
  --project-root "$PROJECT_DIR"
```

Require `.tmp/dataverse-reconciliation-report.json` with `status: "ready"`
and `.tmp/dataverse-repository-mapping.json`. Ambiguous entities or fields,
unsupported media/file transforms, choice mismatches, missing services, and
unsafe operations are blockers; resolve the approved mapping and rerun rather
than guessing.

Generate the real implementation behind the existing repository contracts:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/gen-dataverse-repositories.js" "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-app.js" \
  --project-root "$PROJECT_DIR" --scope domain
npm --prefix "$PROJECT_DIR" run type-check
```

This may replace only
`src/data/repositories/dataverseRepositories.ts`. It must not modify the
domain model, hooks, screens, shared UX, or navigation. Advance transition
phase to `connectors`.

### Step 6 - Replace Connector Stubs And Verify Native Wrappers

Read `## Connectors`. For each non-none row, sequentially execute
`/add-connector <api-name>` from the project root, following its connection,
dataset/table, and schema-generation prompts. Use the exact API ID mapping from
the connector reference; do not assume the prototype filename is the real
connector ID.

After each connector, place its calls behind the approved adapter under
`src/data/repositories/` and verify the matching domain hook remains unchanged.
A planned connector that cannot replace its fail-closed adapter is blocking
because leaving it would create a partly mocked real app.

Read `## Native Capabilities`. Existing prototype wrappers should already be
valid. Invoke `/add-native <capability>` only when a wrapper is missing or the
current allowlist contract requires repair. Do not duplicate wrappers or edit
native package/config boundaries.

Advance transition phase through `native` to `seeding`.

### Step 7 - Seed Dataverse From Prototype Scenarios

Keep seed JSON until this step completes. Unless `--no-sample-data`, ask once:

```text
Seed the real Dataverse tables from the prototype scenarios? Yes (default) / No
```

On yes, execute `/add-sample-data --from-seed` from the project root. It must
first validate the real manifest and run:

```bash
node "${CLAUDE_SKILL_DIR}/../add-sample-data/scripts/prepare-prototype-seed-migration.js" \
  "$PROJECT_DIR"
```

Require zero mapping blockers before any insert. The child then preserves
prototype GUIDs as real IDs, remaps choices by label, proves lookup parents in
the current environment, inserts by dependency tier, and journals live results.

Missing table/column/choice/lookup mappings or required-row failures are
conversion blockers. Approved deferred fields and unavailable media bytes may
return `DONE_WITH_CONCERNS`, because the row data remains valid and the exact
loss is reported. Never replace failed prototype mappings with generic rows.

Record inserted/existing/skipped counts and the migration-plan hash per table.

Advance transition phase to `cleanup`.

### Step 8 - Switch Repository Mode And Preserve The UI

Keep the neutral domain model, repository interfaces, query hooks, fixture
scenarios, and `PrototypeDataProvider`. The provider is shared infrastructure
despite its historical name; its repository factory switches adapters from
the lifecycle data mode. Do not rebind screen imports.

Verify every required Dataverse and connector adapter is real before switching
mode. Mock repositories may remain for development scenarios, but no
Dataverse-mode factory path may select them or a throw-stub.

If an explicitly migrated legacy prototype still has
`src/generated/.prototype-manifest.json`, run the existing cleanup transaction
only for artifacts listed in that manifest after proving each replacement:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/cleanup-prototype-artifacts.js" \
  "$PROJECT_DIR"
```

Never delete `src/data/`, `.tmp/prototype-domain-model.json`, or the domain
manifest during cleanup.

Switch the reversible runtime shell:

```bash
node "${CLAUDE_SKILL_DIR}/../create-mobile-prototype/scripts/configure-prototype-runtime.js" \
  "$PROJECT_DIR" dataverse
npm --prefix "$PROJECT_DIR" run generate-schemas
npm --prefix "$PROJECT_DIR" run type-check
```

Verify:

- `app/_layout.tsx` still mounts `PowerAppsProvider` with auth, power config,
  schema map, Tamagui config, and the established provider order;
- `app/index.tsx` now follows real `useAuth()` state because runtime data mode
  is Dataverse;
- `app/(app)/_layout.tsx` guards unauthenticated routes;
- `power.config.json` contains real database/connection references;
- screens still import only `@/data`;
- the Dataverse repository adapter is generated from the current mapping;
- no Dataverse-mode path selects a prototype mock or connector throw-stub.

Recompile the screen pack and prove the backend-only migration retained the UI
contract:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/compile-screen-build-pack.js" \
  --project-root "$PROJECT_DIR"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-ui-neutral-data-migration.js" \
  --project-root "$PROJECT_DIR" \
  --before ".tmp/pre-graduation-screen-build-pack.json" \
  --after ".tmp/screen-build-pack.json"
```

Advance transition phase to `sync`.

### Step 9 - Reconcile Optional Offline Scope

If the approved plan requests offline behavior or an offline profile already
exists, run the canonical local delta check from
`offline-profile-reconciliation.md`.

- No profile and no approved offline requirement: continue silently.
- Approved offline requirement with no profile: offer
  `/setup-offline-profile` now that real tables exist.
- Existing profile with delta: reconcile tables/columns through the documented
  specialist skills and recheck to `in-sync`.

Offline profile failure blocks deployment but need not undo completed online
conversion. Record it as a concern unless offline operation is a core approved
requirement, in which case stop before final success.

### Step 10 - Sync Once And Commit Dataverse State

Invoke exactly once:

```text
/sync-from-plan --working-dir <PROJECT_DIR> --target-data-mode dataverse
```

This treats the transition as a mandatory Dataverse field-binding rebind even
when the screen list is unchanged. It refreshes the generated-service snapshot,
updates exact lookup/choice/file bindings, rebuilds affected data screens,
runs route/contract/quality/contrast/TypeScript gates, renders preview, and
only then commits:

- `dataMode: "dataverse"`
- `transition: null`
- selected environment facts
- current plan and real manifest hashes
- final sync timestamp

After return, independently assert state is Dataverse, cleanup check passes in
`--check` mode, manifest hash is present, and `npm run type-check` succeeds.
Then rerun the full non-generated source gate so an unchanged prototype-era
shared hook cannot survive conversion:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-files.js" \
  --project-root "$PROJECT_DIR" --all-source
```

Run the changed-file dispatcher against every orchestrator-owned file as the
separate ownership/provenance gate.

If final sync fails, leave state `transitioning` at phase `sync`. Do not restore
prototype mode: real metadata/services may already be live and mock artifacts
have been removed. Repair and rerun this skill to resume safely.

## Summary Output

```text
DONE

Prototype converted to a real Power Apps mobile app.
Environment: <display name / ID>
Data mode: dataverse
Dataverse: <reuse / extend / create / adapt / defer summary>
Connectors: <real services added or none>
Native capabilities: <verified / repaired>
Sample data: <seeded / skipped / concerns>
Offline profile: <not requested / created / reconciled / concern>
Sync and validation: PASS
Preview: <path>
Next: /deploy
```

Use `DONE_WITH_CONCERNS` for skipped app registration, non-critical sample-data
failures, or non-core offline concerns. Never report success while lifecycle
state is `transitioning`, a mock marker remains, or a hard sync gate failed.