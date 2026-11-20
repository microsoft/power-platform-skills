# Apply data model

A step both build orders of `/create-mobile-app` run: [`make-it-real.md`](make-it-real.md) (screens first) and
[`data-model-first.md`](data-model-first.md) (data model first) each read it under their own numbered heading.
Fix it here and both orders get the fix.

Steps it names, by build order:

| Named here | Screens first | Data model first |
|---|---|---|
| this step | Step 12 | Step 8 |
| `Step <n>/<total>` in progress lines | 12/17 | 8/13 |
| the native capabilities step | Step 13 | Step 9 |

<!-- The step starts here; everything above is about the file. -->

If `<dataverse_planning_mode> = connector-only`, verify the approved
`## Data Model` says zero Dataverse tables and no `.datamodel-manifest.json`
exists, print `↷ Apply data model skipped — connector-only app has no Dataverse data model.`,
skip sample data and offline-profile setup, print
`↷ Offline profile skipped — no Dataverse tables in this app.`, and continue to the native capabilities step. A non-empty Dataverse plan in
this mode is a planning mismatch and must be corrected before continuing.

Otherwise open the Dataverse phase now. Creating tables is one of the longest waits in the run, and
with no phase open the plan reads "Waiting to start" through all of it:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id dataverse --status active
```

**Print before starting:**
> "→ [Step <n>/<total>] Preparing the approved Dataverse operation manifest, then invoking /add-dataverse for sequential metadata writes and service generation. Dataverse write time varies by environment; local manifest preparation is deterministic, not a wall-clock promise."

**Environment pre-check (before invoking /add-dataverse):** Verify that `.resolved-environment.json` / `power.config.json` match the environment captured in Step 1. If they differ, warn the user immediately — creating tables in the wrong environment is the #1 silent breakage in this step. `/add-dataverse` Step 3a does its own check, but catching it here saves a failed attempt.

For the fast-v2 `required` path, keep the foreground planning snapshot as
planning evidence only. It never authorizes a write. Without changing any
approval gate, this step must perform one fresh bounded reconciliation for every
exact table in the approved structured schema; each existing table reloads
ordinary typed columns, lookups, M:N/1:N relationships, and alternate keys.
Create/adapt table reruns also reload and compare creation-significant table
behavior: ownership, activities, notes, offline availability, change tracking,
labels/schema identity, and primary-name identity.
The exact/proposed scope also includes every effective M:N intersect entity
name, and 1:N reuse requires complete matching `CascadeConfiguration`
evidence. An absent or colliding intersect name, or missing/mismatched cascade
evidence, is non-executable.
This step also binds the structured artifact to the current fully approved plan
content hash and the gate-owned approval receipt's exact contract hash and
service dependencies. This step cannot create or refresh this receipt. Use
resolved context and these structured artifacts, never values inferred from
free-form Markdown:

```bash
SCHEMA_CONTRACT='<working_dir>/.tmp/dataverse-schema-contract.json'
APPROVAL_RECEIPT='<working_dir>/.tmp/mobile-plan-status.json'
FOREGROUND_PLANNING_SNAPSHOT='<working_dir>/.tmp/dataverse-foreground-planning-snapshot.json'
RECONCILIATION_SCOPE='<working_dir>/.tmp/dataverse-reconciliation-scope.json'
EXECUTION_RECONCILIATION='<working_dir>/.tmp/dataverse-execution-reconciliation.json'
OPERATION_MANIFEST='<working_dir>/.tmp/dataverse-operation-manifest.json'
PUBLISH_CHECKPOINT='<working_dir>/.tmp/dataverse-publish-pending.json'
ACTIVE_SOLUTION_UNIQUE_NAME="Default"

test -f "$SCHEMA_CONTRACT" -a -f "$APPROVAL_RECEIPT" \
  -a -f "$FOREGROUND_PLANNING_SNAPSHOT" \
  -a -f '<working_dir>/native-app-plan.md'

node "${PLUGIN_ROOT}/scripts/build-dataverse-operation-manifest.js" \
  --bind-plan "$SCHEMA_CONTRACT" \
  --approval-receipt "$APPROVAL_RECEIPT" \
  --plan '<working_dir>/native-app-plan.md' \
  --output "$SCHEMA_CONTRACT"

node "${PLUGIN_ROOT}/scripts/build-dataverse-operation-manifest.js" \
  --reconciliation-scope "$SCHEMA_CONTRACT" \
  --output "$RECONCILIATION_SCOPE"

EXACT_TABLES=$(node -e "console.log(require(process.argv[1]).exactTables.join(','))" "$RECONCILIATION_SCOPE")
PROPOSED_TABLES=$(node -e "console.log(require(process.argv[1]).proposedTables.join(','))" "$RECONCILIATION_SCOPE")

node "${PLUGIN_ROOT}/scripts/create-dataverse-snapshot.js" \
  --env-url "$ACTIVE_ENV_URL" \
  --tenant-id "$ACTIVE_TENANT_ID" \
  --solution "$ACTIVE_SOLUTION_UNIQUE_NAME" \
  --tables "$EXACT_TABLES" \
  --proposed-tables "$PROPOSED_TABLES" \
  --reconcile-exact \
  --output "$EXECUTION_RECONCILIATION"

node "${PLUGIN_ROOT}/scripts/build-dataverse-operation-manifest.js" \
  --contract "$SCHEMA_CONTRACT" \
  --approval-receipt "$APPROVAL_RECEIPT" \
  --reconciliation "$EXECUTION_RECONCILIATION" \
  --plan '<working_dir>/native-app-plan.md' \
  --output "$OPERATION_MANIFEST" \
  --environment-id "$ACTIVE_ENV_ID" \
  --env-url "$ACTIVE_ENV_URL" \
  --tenant-id "$ACTIVE_TENANT_ID" \
  --publisher-prefix "$DETECTED_PUBLISHER_PREFIX" \
  --solution "$ACTIVE_SOLUTION_UNIQUE_NAME" \
  --publish-checkpoint "$PUBLISH_CHECKPOINT"
```

The manifest builder mechanically verifies the approved `Reuse`, `Extend`,
`Create`, `Adapt`, `Defer`, and `Unverified` decisions. It must not invent or
change architecture decisions. Any mismatch is a non-executable verification
conflict and returns to the orchestrator; do not add another opportunistic read
loop or fall back to agent reconciliation. No operation may execute until:

```bash
node "${PLUGIN_ROOT}/scripts/build-dataverse-operation-manifest.js" \
  --validate "$OPERATION_MANIFEST" \
  --contract "$SCHEMA_CONTRACT" \
  --approval-receipt "$APPROVAL_RECEIPT" \
  --reconciliation "$EXECUTION_RECONCILIATION" \
  --plan '<working_dir>/native-app-plan.md' \
  --environment-id "$ACTIVE_ENV_ID" \
  --env-url "$ACTIVE_ENV_URL" \
  --tenant-id "$ACTIVE_TENANT_ID" \
  --publisher-prefix "$DETECTED_PUBLISHER_PREFIX" \
  --solution "$ACTIVE_SOLUTION_UNIQUE_NAME" \
  --publish-checkpoint "$PUBLISH_CHECKPOINT" \
  --require-executable
```

Invoke `/add-dataverse` with the working directory, approved plan, and exact
artifact paths:

```
Invoke skill: /add-dataverse

Context:
  MOBILE_APP_ORCHESTRATING=1
  orchestrator: create-mobile-app
  working_dir: <working_dir>
  phase: implementation
  approved_scope: <approved Data Model and bound operation-manifest artifacts>

Arguments:
  --working-dir <working_dir>
  --plan-section <native-app-plan.md#data-model>
  --schema-contract <working_dir>/.tmp/dataverse-schema-contract.json
  --approval-receipt <working_dir>/.tmp/mobile-plan-status.json
  --execution-reconciliation <working_dir>/.tmp/dataverse-execution-reconciliation.json
  --operation-manifest <working_dir>/.tmp/dataverse-operation-manifest.json
  --publish-checkpoint <working_dir>/.tmp/dataverse-publish-pending.json
  --skip-planning   (the planner already ran)
```

`/add-dataverse` validates the bindings and consumes valid phases immediately.
Any supplied artifact/binding failure returns to this orchestrator; it must
not silently enter standalone reconciliation. A non-executable manifest
authorizes no metadata writes.
The publish checkpoint is retained across schema/PublishXml failure and
deleted only after successful publish, so a rerun retries pending publication
even when schema writes are already idempotent.
It creates Tier 0 → N tables, applies extensions, runs
`pa app add data-source --connector dataverse --org-url <envUrl>
--table <name>` per service-required table from the app root,
type-checks, and returns. Real matched A/B runs are still required to quantify
the end-to-end time saved; do not present local manifest timing as a guaranteed
1–3 minute Dataverse result.

After `/add-dataverse` returns, run the **Dataverse/generated-services gate**:

```bash
npm run generate-schemas
npx --no-install tsc --noEmit
```

If this fails, do not continue to native capabilities, connectors, navigation, or screens. Capture the full error list once, batch-fix generated-service/model or alias-map issues, then rerun the gate. If the failure is a hidden Dataverse collision already recovered via an alias (for example `aircraft` → `aircraftv2`), make sure the alias is reflected in `native-app-plan.md`, `memory-bank.md`, and the Generated Services snapshot before rerunning.
