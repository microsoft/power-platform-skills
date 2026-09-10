# Phase 6 of 10 — Data

**Steps:** 8, 8.5, then 6.85 (offline needs actual data). **Previous:** [5 — Authentication](phase-05-auth.md). **Next:** [7 — Integrations](phase-07-integrations.md).
[Phase index](../SKILL.md#load-only-the-active-phase). Validate required data work or record the approved connector-only skip before advancing.

### Step 8 — Apply data model

**Telemetry checkpoint: `apply_dataverse_data_model`**

Before applying or skipping data work, verify the current plan has completed
Information and interaction coverage for its approved detailed specs. On a legacy resume
with missing coverage or unresolved required support, return to Step 3.4 for the authoritative
plan audit and affected reapproval; a previously valid receipt alone does not establish UX
completeness. Do not discover/mutate extra schema opportunistically during execution.

For `connector-only`, verify the approved Data Model says zero Dataverse tables and no manifest
exists. Skip Steps 8/8.5; Step 6.85 records no-Dataverse not-applicable before Step 9.
Any nonempty Dataverse plan is a planning mismatch, not a skip.

For `required`, verify resolved context/config match the environment used in planning.
The foreground planning snapshot is evidence only; it never authorizes a write.
Before mutation, require current fully approved plan bytes, normalized schema and the
foreground-owned receipt. Step 8 consumes/verifies it and **cannot create or refresh it**.
If the receipt is missing, STOP as `BLOCKED`; this mutation phase must not synthesize it.
If design or another intervening step changed the plan, return to the relevant approval gate.

Perform one fresh bounded reconciliation of every exact/effective table including M:N intersect
names. Reload ordinary typed columns, lookups, M:N/1:N relationships and alternate keys;
create/adapt reruns also compare ownership, activities, notes, offline availability, change tracking,
labels/schema/primary-name identity. 1:N reuse needs matching complete CascadeConfiguration.
Missing or conflicting evidence is non-executable, not an invitation to invent schema decisions.

```bash
SCHEMA_CONTRACT="<working_dir>/.tmp/dataverse-schema-contract.json"
APPROVAL_RECEIPT="<working_dir>/.tmp/mobile-plan-status.json"
FOREGROUND_PLANNING_SNAPSHOT="<working_dir>/.tmp/dataverse-foreground-planning-snapshot.json"
RECONCILIATION_SCOPE="<working_dir>/.tmp/dataverse-reconciliation-scope.json"
EXECUTION_RECONCILIATION="<working_dir>/.tmp/dataverse-execution-reconciliation.json"
OPERATION_MANIFEST="<working_dir>/.tmp/dataverse-operation-manifest.json"
PUBLISH_CHECKPOINT="<working_dir>/.tmp/dataverse-publish-pending.json"
ACTIVE_SOLUTION_UNIQUE_NAME="Default"

test -f "$SCHEMA_CONTRACT" -a -f "$APPROVAL_RECEIPT" \
  -a -f "$FOREGROUND_PLANNING_SNAPSHOT" -a -f "<working_dir>/native-app-plan.md"
node "${PLUGIN_ROOT}/scripts/build-dataverse-operation-manifest.js" \
  --bind-plan "$SCHEMA_CONTRACT" --approval-receipt "$APPROVAL_RECEIPT" \
  --plan "<working_dir>/native-app-plan.md" --output "$SCHEMA_CONTRACT"
node "${PLUGIN_ROOT}/scripts/build-dataverse-operation-manifest.js" \
  --reconciliation-scope "$SCHEMA_CONTRACT" --output "$RECONCILIATION_SCOPE"
EXACT_TABLES=$(node -e "console.log(require(process.argv[1]).exactTables.join(','))" "$RECONCILIATION_SCOPE")
PROPOSED_TABLES=$(node -e "console.log(require(process.argv[1]).proposedTables.join(','))" "$RECONCILIATION_SCOPE")
node "${PLUGIN_ROOT}/scripts/create-dataverse-snapshot.js" \
  --env-url "$ACTIVE_ENV_URL" --tenant-id "$ACTIVE_TENANT_ID" \
  --solution "$ACTIVE_SOLUTION_UNIQUE_NAME" --tables "$EXACT_TABLES" \
  --proposed-tables "$PROPOSED_TABLES" --reconcile-exact --output "$EXECUTION_RECONCILIATION"
node "${PLUGIN_ROOT}/scripts/build-dataverse-operation-manifest.js" \
  --contract "$SCHEMA_CONTRACT" --approval-receipt "$APPROVAL_RECEIPT" \
  --reconciliation "$EXECUTION_RECONCILIATION" --plan "<working_dir>/native-app-plan.md" \
  --output "$OPERATION_MANIFEST" --environment-id "$ACTIVE_ENV_ID" \
  --env-url "$ACTIVE_ENV_URL" --tenant-id "$ACTIVE_TENANT_ID" \
  --publisher-prefix "$DETECTED_PUBLISHER_PREFIX" --solution "$ACTIVE_SOLUTION_UNIQUE_NAME" \
  --publish-checkpoint "$PUBLISH_CHECKPOINT"
node "${PLUGIN_ROOT}/scripts/build-dataverse-operation-manifest.js" \
  --validate "$OPERATION_MANIFEST" --contract "$SCHEMA_CONTRACT" \
  --approval-receipt "$APPROVAL_RECEIPT" --reconciliation "$EXECUTION_RECONCILIATION" \
  --plan "<working_dir>/native-app-plan.md" --environment-id "$ACTIVE_ENV_ID" \
  --env-url "$ACTIVE_ENV_URL" --tenant-id "$ACTIVE_TENANT_ID" \
  --publisher-prefix "$DETECTED_PUBLISHER_PREFIX" --solution "$ACTIVE_SOLUTION_UNIQUE_NAME" \
  --publish-checkpoint "$PUBLISH_CHECKPOINT" --require-executable
```

Check each exit before the next command. The manifest mechanically verifies Reuse/Extend/Create/
Adapt/Defer/Unverified decisions; it cannot change them. No opportunistic read loop, Markdown
schema parsing, or agent-reconciliation fallback on a binding error.

Invoke `/add-dataverse` with:

```text
--working-dir <working_dir>
--plan-section <native-app-plan.md#data-model>
--schema-contract <working_dir>/.tmp/dataverse-schema-contract.json
--approval-receipt <working_dir>/.tmp/mobile-plan-status.json
--execution-reconciliation <working_dir>/.tmp/dataverse-execution-reconciliation.json
--operation-manifest <working_dir>/.tmp/dataverse-operation-manifest.json
--publish-checkpoint <working_dir>/.tmp/dataverse-publish-pending.json
--skip-planning
```

The sub-skill owns sequential metadata writes, Tier 0→N ordering, publish and service generation.
A supplied-artifact/binding failure returns here, never silently enters standalone reconciliation.
Retain the publish checkpoint on schema/PublishXml failure; remove only after successful publish.
No non-executable manifest may authorize writes.

After successful return, run the Dataverse/generated-services gate:

```bash
npm run generate-schemas
npx tsc --noEmit
```

Check both exits. Do not continue until clean; batch repair generated-service/model or alias issues.
Do not hand-edit generated files, silently rename approved tables or hide failures with TODOs.
Record actual manifest/services and outcomes in the bank, not promised mutation duration.

### Step 8.5 — Seed sample data (auto)

Invoke `/add-sample-data --working-dir <working_dir>` for required mode after successful data apply.
It owns manifest reads, counts, dependency ordering and GUID tracking; tables with ≥5 rows are
skipped. A missing manifest is an incomplete Step 8: stop rather than claim successful data apply.
Seed failures may remain concerns only with a clearly reported empty-data outcome and working
empty states; the user can rerun the helper. Never invent sample rows in screen runtime.

### Step 6.85 — Offline profile (after data exists)

Run **here**, after Step 8 created the actual `.datamodel-manifest.json`, not after scaffold.
Skip only for approved zero-Dataverse scope or bank status `done`/`not-applicable`; print which.
No keyword heuristic may skip the question for a Dataverse-backed app.

Ask whether to set up a Mobile Offline Profile: Yes / later / not needed. Explain accurately:
this plugin authors the Dataverse profile; it does not scaffold an app-owned offline runtime,
and runtime support must be verified separately. Do not promise disconnected writes from
profile creation alone.

- Yes: invoke `/setup-offline-profile --working-dir <working_dir>`; it owns its three gates,
  actual table eligibility, profile mutations, `offline-profile.json` and bank updates.
- Later: leave status unset so the decision can be revisited.
- Not needed: persist `status: not-applicable`.

Do not auto-approve the helper's gates because new tables may already be offline-enabled.
Handle child status normally. Continue to Step 9 only after this decision.
