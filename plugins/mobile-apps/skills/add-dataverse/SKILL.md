---
name: add-dataverse
description: Use when the user wants to add Dataverse tables (existing or new) to a Power Apps mobile app, extend an existing Dataverse table with new columns, or apply an approved data model plan.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, EnterPlanMode, ExitPlanMode, Task
model: opus
---

**📋 Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** — read first.

# Add Dataverse

Two paths:

- **Existing tables only** — skip to Step 5 (just runs `npx power-apps add-data-source` per table)
- **New / extended tables** — full workflow with Web API mutations in dependency order

## Workflow

1. Verify project & auth → 2. Resolve plan/operation manifest → 3. Setup Dataverse Web API auth → 4. Validate manifest or reconcile live metadata → 5. Execute sequential metadata phases → 6. Add data sources → 6b. Publish fallback customizations → 6c. Verify tables → 6d. Write manifest → 7. Inspect generated files → 8. Type-check → 8.5. Offline profile reconciliation → 9. Summary

For a plugin-generated app with `.tmp/mobile-plan-execution-contract.json`,
run `validate-mobile-plan-execution-contract.js` before resolving an operation
manifest. Require `.tmp/experience-screen-contract.json` schema version 3 and
reconcile every `screens[].data.operations[]` field, write, pagination, and
relationship binding against the proposed schema. A schema mutation that would
orphan an operation is blocking until the foreground re-plans it. Standalone
unmanaged data-source use may continue without these generated-plan artifacts.

---

### Step 1 — Verify project & auth

Confirm Power Apps mobile app:

```bash
test -f power.config.json && test -f app.config.js
node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-environment.js" "$(node -e \"console.log(require('./power.config.json').environmentId)\")"
```

Capture the **environment URL** (`https://orgXXX.crm.dynamics.com`), **environment ID**, and **tenant ID** from `resolve-environment.js` — needed for Step 3. If only the environment URL is available, pass that URL instead of the ID.

### Step 2 — Resolve plan

Look for `native-app-plan.md` in the project root:

```bash
test -f native-app-plan.md
```

Before reading plan content, inspect `$ARGUMENTS` for the five fast-path
artifact flags in Step 2a. When all are present, only confirm
`native-app-plan.md` exists for hash validation; do not parse its Data Model
section or build operations/service lists from Markdown.

**If present and `<operation_manifest_mode> = fallback`:** read the
`## Data Model` section. Extract:
- The target reconciliation table (`reuse` / `extend` / `create` / `adapt` / `defer` decisions and evidence)
- The Mermaid ER diagram (informational)
- The "Creation Order" tier list
- Every table referenced by `## Screens`, identity resolution, related-entity fields, forms, dashboards, or shared hooks, including standard reused tables such as `systemuser`, `contact`, and `account`

Build `SERVICE_REQUIRED_TABLES` as the union of:
1. every non-deferred row in Target Reconciliation (`reuse`, `extend`, `create`, or `adapt`);
2. every table in Creation Order;
3. every table named by screen/hook data requirements.

**Hard rule:** `reuse` means "do not mutate schema"; it does **not** mean "skip generated service." If app code reads or writes a reused table, that table must be in `SERVICE_REQUIRED_TABLES`.

Carry forward any `adapt` (auto-renamed) and `defer` (out-of-scope this run) decisions with their recorded reasons, and apply the alias map to every name you use. A data-modelling conflict never halts this skill — it resolves to `adapt` or `defer` and is reported in Step 9.

**If absent:** check `$ARGUMENTS` for diagram hints (`*.png`, `*.jpg`, `*.jpeg` filename, `erDiagram` keyword, `||--o{` cardinality syntax). 

- **Diagram hint present** → Path A (Step 2.5).
- **No hint AND `$ARGUMENTS` describes what the app does** (the typical case) → silently take Path B (Step 2.6 — spawn architect). No prompt.
- **No hint AND `$ARGUMENTS` is empty / non-descriptive** → only then prompt with `AskUserQuestion`:

  > "How would you like to define the data model?
  > (a) I have an existing ER diagram to upload (PNG/JPG path, Mermaid syntax, or text description)
  > (b) Let the data-model-architect agent analyze and propose one (default)
  > (c) Cancel — I'll plan it elsewhere first"

  Default the answer to (b) so empty/cancel input auto-proceeds. The 99% case (user gave a description but no diagram) skips this prompt entirely.

#### Step 2a — Approved operation-manifest fast path

When `$ARGUMENTS` supplies all five paths below, record
`<operation_manifest_mode> = candidate`:

- `--schema-contract <working_dir>/.tmp/dataverse-schema-contract.json`
- `--approval-receipt <working_dir>/.tmp/mobile-plan-status.json`
- `--execution-reconciliation <working_dir>/.tmp/dataverse-execution-reconciliation.json`
- `--operation-manifest <working_dir>/.tmp/dataverse-operation-manifest.json`
- `--publish-checkpoint <working_dir>/.tmp/dataverse-publish-pending.json`

Do not reconstruct tables, columns, relationships, keys, payloads, tiers, or
service requirements from Markdown on this path. The gate-owned approval receipt binds
the exact structured contract content/hash, final plan hash, and final
screen/service dependency list; `native-app-plan.md` remains the human review
artifact.

An entirely absent fast-path handoff means
`<operation_manifest_mode> = fallback` and preserves the standalone workflow
below, beginning with Step 2 initialization. A partially supplied handoff, or
a supplied manifest/contract/reconciliation/checkpoint that is malformed, stale,
incomplete, or bound to different context/files, must fail closed: print the
exact validation errors and return control to the orchestrator. Never jump to
Step 4 without Step 2 initialization, partially trust a candidate, or mix its
operations with agent-derived operations.

### Step 2.5 — Path A: Parse user-provided diagram

Used when the user has an existing diagram from another tool (Visio, dbdiagram.io, screenshot, hand-drawn).

Accept three input formats:

| Format | How |
|---|---|
| **Image path** (`*.png` / `*.jpg` / `*.jpeg`) | Use `Read` on the file path. The vision-capable model extracts entities, columns, relationships. |
| **Mermaid syntax** | User pastes a `erDiagram` block in chat. Parse the entities, columns, and `\|\|--o{` cardinalities directly. |
| **Text description** | User types a structured description ("Account has many ServiceVisits; each ServiceVisit has many WorkItems and Photos"). Spawn `data-model-architect` agent in `parse-only` mode with the text as input. |

Whichever format, normalize into the same structure used by the planner agent:

```yaml
publisherPrefix: <from detected publisher prefix or user>
tables:
  - logicalName: contoso_servicevisit
    displayName: Service Visit
    status: new   # new | extend | reuse
    columns: [...]
    relationships: [...]
```

Then:
1. Query existing Dataverse (Step 4 logic) to mark each table as `new`, `modified`, or `reused`.
2. Generate a Mermaid ER diagram from the parsed structure for visual confirmation.
3. Present back to the user via `EnterPlanMode` for approval.
4. On `ExitPlanMode`, write the approved data model into `native-app-plan.md` `## Data Model` section (creating the file if it doesn't exist).
5. Continue to Step 3.

### Step 2.6 — Path B: Spawn architect agent

If the user picked Path B (or the user-provided diagram parse failed), spawn the `mobile-app:data-model-architect` agent via `Task` (the `mobile-app:` plugin-name prefix is required) with the user's high-level requirements as input. The agent returns one fenced JSON `data-model-draft` with `dataModelMarkdown`, `dataverseSchemaContract`, and `warnings`; it never writes a project file. The foreground workflow validates the returned contract, inserts `dataModelMarkdown` into `native-app-plan.md`, and presents that foreground-owned draft for approval before continuing to Step 3.

If they need new tables and refuse both paths, recommend they run `/setup-datamodel` (alias of this skill) explicitly, or `real-app-planner` through `/create-mobile-app` for a full app-level plan. STOP if neither.

### Step 3 — Setup Dataverse Web API auth

Required only if creating or extending tables. Skip to Step 5 for read-only `add-data-source`.

#### Step 3a — Environment consistency check

`npx power-apps` and `az` authenticate independently — they can point to different accounts. Verify `power.config.json` resolves and `az` can token for the target tenant before making any Dataverse API calls:

```bash
ENV_JSON=$(node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-environment.js" "$(node -e \"console.log(require('./power.config.json').environmentId)\")")
echo "$ENV_JSON"
az account show --query "{user: user.name, tenant: tenantId}" -o json
```

Compare the resolved environment URL with `<envUrl>` captured in Step 1. If they differ, **STOP** and warn:

> "⚠️ Environment mismatch detected:
> - resolver reports: `<resolved_env_url>`
> - This project targets: `<envUrl>`
>
> The Dataverse API token comes from `az`, which must target the same tenant as the selected environment. Run:
> ```bash
> az login --tenant <tenant-id>      # switch az to the right tenant
> ```
> Then re-run `/add-dataverse`."

**Do NOT proceed with table creation if environments don't match** — you'll create tables in the wrong org.

#### Step 3b — Acquire token

```bash
az account show --query "user.name" -o tsv
```

If empty, instruct `az login` and stop.

**Script invocation contract — read this once, all subsequent calls in this skill follow it:**

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> <METHOD> <apiPath> \
  [--body '<json>'] [--include-headers] \
  --tenant-id '<tenantId-from-resolve-environment>'
```

- Three positional args, in order: `<envUrl>`, `<METHOD>` (GET / POST / PATCH / DELETE), `<apiPath>` (everything after `/api/data/v9.2/`).
- **Body is a flag, not positional.** `--body '<json>'` — required for POST/PATCH, never for GET/DELETE. Forgetting `--body` and passing the JSON as a 4th positional arg returns a usage error.
- `--include-headers` adds response headers (needed for `OData-EntityId` after a record create).
- Output is JSON: `{ "status": <code>, "data": <body> }`. Token refresh on 401 and back-off on 429 are automatic — never wrap with manual retry.

**Pass the resolved tenant explicitly (HARD — saves discovery and survives fresh shells).** `resolve-environment.js` already returned `tenantId` in Step 1. Substitute that literal value into every `--tenant-id` argument; do not rely on an exported or shell-local variable because separate tool executions may use fresh shells.

If the tenant is unknown, omit `--tenant-id` — discovery still works, it is just slower.

Acquire a Dataverse access token and verify connectivity:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET WhoAmI \
  --tenant-id '<tenantId-from-resolve-environment>'
```

The explicit tenant is also reused for token refresh after a 401 and takes
priority over shell environment variables and Azure account discovery.

`WhoAmI` is the Dataverse identity endpoint — capital W/A/I (case-sensitive). The response gives `UserId`, `BusinessUnitId`, `OrganizationId` but **does NOT include the publisher prefix**. To get the publisher prefix, query the solution's publisher (defaults to `Default`; pass a different solution name if the env uses a custom solution):

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/detect-publisher-prefix.js" <envUrl> [solutionName] \
  --tenant-id '<tenantId-from-resolve-environment>'
# solutionName defaults to "Default" if omitted
```

This runs the OData query:
`/api/data/v9.2/solutions?$select=uniquename&$expand=publisherid($select=customizationprefix)&$filter=uniquename eq '<solutionName>'`

Capture `customizationprefix` from the solution's publisher (typical value: `cr123` → schema names like `cr123_jobsite`). Also capture the solution `uniquename` — needed for the `--solution` flag on every Step 5 / 5b POST so artifacts land in our solution rather than landing wherever Dataverse defaults. Write both to `memory-bank.md` Power Platform context block.

Requires the user to hold **System Administrator** or **System Customizer** in this environment.

When `<operation_manifest_mode> = candidate`, validate the manifest now against
the resolved environment, tenant (when available), publisher, solution, current
plan bytes, structured-schema bytes, and fresh reconciliation bytes:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/build-dataverse-operation-manifest.js" \
  --validate "<operation-manifest-path>" \
  --contract "<schema-contract-path>" \
  --approval-receipt "<approval-receipt-path>" \
  --reconciliation "<execution-reconciliation-path>" \
  --plan "<working_dir>/native-app-plan.md" \
  --environment-id "<environmentId>" \
  --env-url "<envUrl>" \
  --tenant-id "<tenantId>" \
  --publisher-prefix "<customizationprefix>" \
  --solution "<solution-uniquename>" \
  --publish-checkpoint "<publish-checkpoint-path>" \
  --require-executable
```

Validation deterministically rebuilds the expected manifest from the bound
structured schema, fresh reconciliation, plan, context, and pending-publish checkpoint, then
compares the complete decisions, services, aliases, phases, API paths, and
bodies. If validation fails, print every reported mismatch and fail closed to
the orchestrator. Do not execute or salvage individual operations and do not
switch a supplied candidate to the standalone fallback.

Validate with `--require-executable`. Step 8 already performed the one fresh
bounded reconciliation for every approved exact table and all of its
columns/relationships/keys, including the child/parent/M:N relationship
capability managed properties. Missing capability evidence fails closed. If
the manifest remains non-executable, report its
verification conflicts to the orchestrator. Do not add another read loop,
change an approved decision, or enter fallback mode. A non-executable
candidate authorizes no metadata write.

If validation with `--require-executable` succeeds, set
`<operation_manifest_mode> = valid` and continue directly to Step 5's manifest
execution branch. This is the fast-v2 path: it skips the repeated
agent-driven full reconciliation, not any safety check.

### Step 4 — Reconcile every planned table and column against the target

If `<operation_manifest_mode> = valid`, print:

> `✓ Approved operation manifest validated — complete fresh reconciliation and derived metadata coverage are bound to this environment.`

Use its `decisions` as the reconciliation matrix and skip the remainder of
Step 4/4a. Continue to Step 5. A valid manifest has no `unverified` items; its
explicit `reuse`, `adapt`, and `defer` rows remain visible in the final
summary.

**Print before starting:**
> "→ Reconciling every planned table and column against live target metadata before any write…"

Do not use the custom-table list as the source of truth, and do not issue one request per table. Fetch **every** plan entry (`Reuse`, `Extend`, or `Create`) — including standard and managed dependencies — in a **single** filtered query that also expands their columns:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
  "EntityDefinitions?\$select=MetadataId,LogicalName,SchemaName,IsCustomEntity,IsManaged,IsCustomizable,CanCreateAttributes,PrimaryIdAttribute,PrimaryNameAttribute&\$filter=LogicalName eq '<table1>' or LogicalName eq '<table2>'&\$expand=Attributes(\$select=MetadataId,LogicalName,AttributeType,AttributeTypeName,RequiredLevel,IsManaged,IsCustomizable,IsPrimaryId,IsPrimaryName,SourceType,SourceTypeMask)" \
  --tenant-id '<tenantId-from-resolve-environment>'
```

Build the `$filter` by OR-ing every planned logical name. This is the [documented way to query multiple table definitions at once](https://learn.microsoft.com/power-apps/developer/data-platform/query-schema-definitions#basic-retrievemetadatachanges-example), and it replaces 2N requests (one entity GET plus one attributes GET per table) with one. Keep the `$expand` `$select` list to base `AttributeMetadata` properties only — a single query [cannot cast to a derived column type](https://learn.microsoft.com/power-apps/developer/data-platform/query-schema-definitions#evaluate-other-options-to-retrieve-schema-definitions), so fetch `OptionSet` details separately for the rare column that needs them.

Read the results as follows:

- **A planned name present in `value[]`** — the table exists. Cache its expanded `Attributes` as that table's **attribute snapshot** for Steps 5a and 5b.
- **A planned name absent from `value[]`** — the table does not exist. This is the equivalent of a 404 in the matrix below.
- Interpret `IsCustomizable` and `CanCreateAttributes` as managed properties and read their `.Value` fields.

If the batched query itself fails (non-2xx), retry it once; if it fails again, split it into per-table queries so one unreadable name cannot hide the rest. Any name still unreadable after that is `unverified`: STOP before writes for that reconciliation scope. Authentication, permission, timeout, and malformed-response failures are not evidence that a name is free. If the URL would exceed a practical length with very many tables, split it into a few filtered queries — still far fewer than one request per table.

**Only if the plan contains alternate keys or M:N relationships**, add the matching expands so Steps 5b and 5d never need their own per-item probes. `EntityDefinitions` also supports expanding [`Keys`, `ManyToManyRelationships`, `ManyToOneRelationships`, and `OneToManyRelationships`](https://learn.microsoft.com/power-apps/developer/data-platform/query-schema-definitions#evaluate-other-options-to-retrieve-schema-definitions):

```text
&$expand=Attributes($select=...),Keys($select=SchemaName,KeyAttributes,EntityKeyIndexStatus),ManyToManyRelationships($select=SchemaName)
```

Do not add these expands when the plan has no keys or M:N relationships — they enlarge the response for no benefit, and standard tables carry many of both.

#### Step 4a — Targeted derived-metadata barrier

The base attribute snapshot is sufficient for ordinary columns, but it cannot
prove that a same-named lookup, choice, Boolean, or computed column has the same
semantics. Before classifying any such existing column as compatible:

1. Write the planned derived-column contract to
   `<working_dir>/.tmp/derived-metadata-expected.json`. Each row contains:
   `table`, `logicalName`, `kind`, `type`, `sourceType`, plus:
   - `lookupTarget` for lookups;
   - exact integer/label `options` for Choice, MultiSelect Choice, and Boolean;
   - exact `sourceTypeMask` and serialized `formulaDefinition` for an explicitly
     approved, maker-created computed dependency.
2. Build one `BATCH-METADATA` GET operation list for the affected existing
   tables only. Reuse one process/token and query:
   - `ManyToOneRelationships` once per child table containing planned lookups;
   - the applicable derived attribute collections
     (`PicklistAttributeMetadata`, `MultiSelectPicklistAttributeMetadata`,
     `BooleanAttributeMetadata`) once per table/type, expanding `OptionSet`;
   - the applicable typed attribute collection once per table/type for any
     explicitly reused computed column, selecting
     `LogicalName,SourceType,SourceTypeMask,FormulaDefinition`.

   Do not issue one process per column and do not scan every customizable table.
   The exact planned names from Step 4 are the scope.
   Write the operation array to
   `<working_dir>/.tmp/derived-metadata-operations.json`, then run:

   ```bash
   node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> \
     BATCH-METADATA derived-reconciliation \
     --operations "$(cat <working_dir>/.tmp/derived-metadata-operations.json)" \
     --tenant-id '<tenantId-from-resolve-environment>'
   ```

   Do not pass `--continue-on-error`; the first unreadable required metadata
   collection must stop the barrier.
3. Any non-2xx response, missing result slot, malformed option metadata, absent
   lookup target, or unavailable `FormulaDefinition` makes that scope
   `unverified`. **STOP before writes.** Authentication, throttling, permission,
   and parse failures are never compatibility evidence.
4. Normalize the live results into
   `<working_dir>/.tmp/derived-metadata-live.json`. Each row uses:
   `table`, `logicalName`, `type`, `sourceType`, `sourceTypeMask`,
   `lookupTargets`, `options: [{ value, label }]`, and `formulaDefinition`.
   Lookup target arrays must contain exactly the approved target. Choice
   mappings must be non-empty with unique integer values and non-empty labels;
   Boolean mappings must contain exactly values 0 and 1. Then run:

   ```bash
   node "${PLUGIN_ROOT}/scripts/validate-derived-metadata.js" \
     --expected "<working_dir>/.tmp/derived-metadata-expected.json" \
     --actual "<working_dir>/.tmp/derived-metadata-live.json"
   ```

5. A lookup is compatible only when its complete target set matches. Planned choice
   values must exist with the same labels; extra live values are allowed.
   Ordinary planned columns require `SourceType` 0. A maker-created computed
   dependency is reusable only when its source type, source-type mask, and exact
   `FormulaDefinition` match the approved artifact; the `Invalid` mask bit
   always blocks reuse.

This phase is read-only and uses the V2 long-lived executor. It must not add
per-column child-process/token overhead back into the fast path.

Build and print a reconciliation matrix before Step 5:

| Target result | Table decision | Column decisions | Action |
|---|---|---|---|
| Present; all planned base and derived metadata compatible | `reuse` | existing columns `reuse` | No schema write. |
| Present; custom columns missing; table customizable and can create attributes | `extend` | compatible `reuse`; absent custom `create` | Queue missing ordinary columns for sequential creation; relationships remain Pass 2. |
| Absent; plan says Create; logical name uses the verified publisher prefix | `create` | ordinary columns `create` inline; lookups deferred | Create once after the complete-payload self-check. |
| Absent; plan says Reuse/Extend or dependency is standard/managed/required-existing | `defer` | dependent columns `defer` | Never recreate a standard or managed table. Drop the dependent lookups/columns from this run, continue with everything else, and list them under Deferred in Step 9. |
| Present; same-name column has incompatible `AttributeType` / `AttributeTypeName.Value` | `extend` | incompatible column `adapt` | Auto-rename the planned column via the probe sequence below, record it in the alias map, and create it alongside the existing one. Never modify or delete the existing column. |
| Present; columns missing but `IsCustomizable.Value=false` or `CanCreateAttributes.Value=false` | `reuse` | missing columns `defer` | The target cannot be extended by this workflow. Reuse the columns that do exist, drop the rest from this run, and list them under Deferred in Step 9. |
| Batched query failed (non-2xx) after retry and per-table split | `unverified` | unknown | STOP before writes for the affected reconciliation scope and surface the concrete environment/auth/permission error. |

`replace` is not an automatic state in this workflow. Replacing a table or column requires an explicitly approved migration with dependency analysis and data movement, so a conflict resolves to `adapt` (rename beside it) or `defer` (leave it out) instead — both of which leave existing data untouched.

**Decide-before-write barrier (HARD):** finish reconciliation for every table and column before the first metadata write. Every item must come out of Step 4 as `reuse`, `extend`, `create`, `adapt`, or `defer` — never as an unresolved conflict. Deciding renames up front is what keeps relationships, screens, and sample data pointing at the same names.

**No dead ends (HARD):** a data-modelling conflict must never stop the run. Adapt it (rename beside the existing object) or defer it (drop it from this run), then keep going and report it in Step 9. Only environment faults stop this skill — failed auth, an environment mismatch, or a target the user has no privilege to write to. Those are not data-modelling problems and the user cannot resolve them by editing the plan.

**Idempotency criterion (HARD):** re-running this skill against an already-applied plan MUST perform **zero** metadata writes. Every table, column, relationship, key, and calc column resolves to `reuse` or an "already exists, skipped" outcome from the Step 4 snapshot. If a re-run issues any POST, the reconciliation missed something — report it rather than writing. Use this as the acceptance check after any change to Steps 4, 5, or 5a–5d.

### Step 5 — Create / extend tables

#### Valid operation-manifest execution branch

When `<operation_manifest_mode> = valid`, do not have an agent rebuild request
bodies. Read `execution.phases` in this fixed order:

1. `tableCreates` — dependency-tier table creates with all ordinary columns
   inline;
2. `extensions` — missing ordinary columns on existing tables;
3. `relationships` — lookups/1:N and M:N after both endpoints exist;
4. `alternateKeys` — after target tables and columns exist;
5. `publish` — one `PublishXml` operation only when earlier phases contain
   writes or a bound publish-pending checkpoint requires retry.

For each non-empty phase, write just that phase's `operations` array to
`<working_dir>/.tmp/dataverse-operation-phase-<name>.json`. Read
`integritySha256` and `binding.reconciliationSha256` from the validated
manifest, then execute every phase with the same project-local atomic journal:

```bash
EXECUTION_JOURNAL="<working_dir>/.tmp/dataverse-metadata-execution-journal.json"
ALL_MANIFEST_OPERATIONS="<working_dir>/.tmp/dataverse-operation-all.json"
# Write the flattened operations from every manifest phase to ALL_MANIFEST_OPERATIONS once.

node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> \
  BATCH-METADATA "manifest-<phase-name>" \
  --operations "$(cat <working_dir>/.tmp/dataverse-operation-phase-<name>.json)" \
  --solution "<solution-uniquename>" \
  --tenant-id "<tenantId>" \
  --journal "$EXECUTION_JOURNAL" \
  --manifest-file "$OPERATION_MANIFEST" \
  --manifest-hash "<manifest.integritySha256>" \
  --reconciliation-hash "<manifest.binding.reconciliationSha256>" \
  --manifest-operations "$(cat "$ALL_MANIFEST_OPERATIONS")"
```

Wait for the entire phase to finish before starting the next. This executor is
not OData `$batch`; it sends one request at a time, reuses one token, preserves
manifest order, and stops on the first non-2xx response. Never pass
`--continue-on-error`, never parallelize phases or operations, and never
execute `service.requiredTables` through BATCH-METADATA.
The runner verifies the manifest file's integrity hash, requires the supplied
operation array to equal one complete manifest phase byte-for-byte, and rejects
that phase until every operation in preceding phases is journal-complete.

The runner atomically writes `inFlight` before each request and records each
successful operation before moving to the next. Completed fingerprints are
based on stable request identity, not the positional index; the complete
manifest's unique zero-based order is validated separately. Completed
fingerprints are skipped on an exact resume. If a process may have exited after Dataverse
accepted a request but before the journal completion write, the runner fails
with `UNCERTAIN_METADATA_OPERATION`; do not replay the old operation array.
Transport loss during a metadata mutation is immediately uncertain and is
never retried in-process; reads may retain transport retry behavior.
Perform a new bounded exact reconciliation, rebuild and revalidate the full
manifest, then resume with both new hashes. The runner mechanically treats an
uncertain operation omitted by the new manifest as already applied/superseded,
or retries it only when the fresh reconciliation proves it is still required.

If `summary.metadataOperationCount` is zero, issue **zero metadata POSTs** and
print `↻ Dataverse schema already fully applied — zero metadata writes.` This
is the required idempotent rerun behavior after successful publish. A manifest
with zero schema operations but one checkpoint-driven `PublishXml` operation
must run that publish retry; it is not a zero-write completion.

The manifest builder writes
`<working_dir>/.tmp/dataverse-publish-pending.json` before any schema POST when
publish will be required. Leave this checkpoint in place after any schema or
publish failure. Delete it only after the validated `publish` phase returns
success. The next build validates its environment/solution/plan/contract
binding and integrity, merges its table list into the publish phase, and
therefore retries `PublishXml` even when every schema create is now
idempotently skipped.

On a hidden POST-time name collision, stop at the failed operation and discard
all not-yet-run phase arrays. The execution script must not choose `Adapt` or a
rename. Return to the existing planning revision path so the structured schema
artifact carries the approved `Adapt` names. Then perform a fresh bounded
reconciliation and regenerate the complete aliases, downstream relationship
and key bodies, service-required names, phases, manifest hashes, and phase
files. Revalidate before resuming through the journal. Never continue an old
array after a rename. Any non-collision failure stops the metadata path with
its exact result.

Before overwriting the old manifest, preserve its path. After the revised plan
and structured schema are approved through the existing flow, the top-level
planner/orchestrator must refresh the structured service dependencies and
`mobile-plan-status.json` receipt. This skill cannot create or restamp it.
Bind the contract through that pre-existing receipt, then roll the existing
publish checkpoint forward:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/build-dataverse-operation-manifest.js" \
  --roll-forward-checkpoint "$PUBLISH_CHECKPOINT" \
  --previous-manifest "$OPERATION_MANIFEST" \
  --journal "$EXECUTION_JOURNAL" \
  --contract "$SCHEMA_CONTRACT" \
  --approval-receipt "$APPROVAL_RECEIPT" \
  --plan "<working_dir>/native-app-plan.md" \
  --output "$PUBLISH_CHECKPOINT" \
  --environment-id "<environmentId>" \
  --env-url "<envUrl>" \
  --tenant-id "<tenantId>" \
  --publisher-prefix "<customizationprefix>" \
  --solution "<solution-uniquename>"
```

This retains prior checkpoint bindings/tables as integrity-protected history,
keeps earlier successful tables publication-pending, and maps only the
journal-proven failed collision table to its revised in-contract alias. It
fails closed if a completed write would disappear from the revised contract or
change definition: completed tables/inline columns, extension columns,
relationships (including cascade behavior), and alternate keys must each map
to an equivalent revised structured component. It also rejects any unrelated
out-of-contract publish target. Only after this succeeds may Step 8 overwrite
the operation manifest.

The manifest builder never emits calculated/rollup/formula creation. Reused
computed dependencies have already crossed the exact derived-metadata barrier;
unsupported projections are explicit `defer` rows. After the `publish` phase succeeds, delete the publish checkpoint and continue
to Step 6. When there were zero writes and no checkpoint, continue without
deleting anything. Skip the
fallback mutation instructions in Steps 5a–5d and skip Step 6b because publish
was already part of the validated phase order.

**Print before starting:**
> "→ Creating/extending <N> tables in tier order (sequential — Dataverse serializes metadata writes). For each: pre-flight check, then 'Creating <table>…' before the POST and '✓ <table>' on 2xx response."

> **⚠️ Concurrency rule — do not violate.** All Dataverse metadata operations in Steps 5, 6, and 6b are **strictly sequential**: issue one HTTP request, wait for a 2xx response, then issue the next. Do NOT parallelize or use OData `$batch`. Dataverse serializes metadata writes via an exclusive lock; parallel calls return `429 TooManyRequests`, `MetadataLockHeldException`, or `404 EntityNotFound` for lookups whose parent hasn't committed yet.
>
> Specifically:
> - **Within a tier:** create tables one at a time.
> - **Across tiers:** Tier 0 fully done (all tables + all columns committed) before any Tier 1 POST.
> - **Lookups:** POST to `/RelationshipDefinitions` only **after** both endpoint tables exist and have returned 2xx.
> - **Extensions:** column POSTs to an existing table are also serial — same lock applies.

For multiple already-reconciled operations, prefer the local `BATCH-METADATA`
executor. It is **not** OData `$batch`: one Node process reuses one token and
issues requests strictly one at a time in array order, stopping on the first
non-2xx response by default.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> \
  BATCH-METADATA schema-writes \
  --operations '<ordered-json-array>' \
  --solution '<solution-uniquename-from-memory-bank>' \
  --tenant-id '<tenantId-from-resolve-environment>'
```

Each operation is `{ "index", "method", "apiPath", "body" }`; an operation may
override the command-level `solution`. Build the array only after the full
metadata snapshot and desired/live diff. Preserve dependency order: new tables
with ordinary columns inline, extension columns, relationships, projections,
then alternate keys. Never pass `--continue-on-error` for schema creation. The
result includes per-operation `status` and `durationMs`; after a failure,
reconcile that component and resume with only the remaining operations.

#### Step 5a — Pre-flight collision check (from the Step 4 snapshot)

Before each create, confirm the target name is actually free: name-prefix collisions from stale solutions, reserved system names, and soft-deleted tombstones all fail the POST, and Dataverse takes ~1 minute to return the conflict error. A failure here can leave Tier 0 partially created and make a Tier 1 lookup fail on a phantom parent. Step 4 already collected this evidence for every planned name, so this step reads it rather than re-querying.

**For every `Create` entry, resolve its target state from the Step 4 batch — do not re-query per table.** Step 4 already fetched every planned logical name, so reuse that result:

| Step 4 result for this name | Meaning | Action |
|---|---|---|
| **Absent from `value[]`** | Name is free | Proceed with POST. |
| **Present** + `IsCustomEntity: true` + `MetadataId` matches memory-bank | We created this earlier — idempotent re-run | Skip the POST, mark as created, continue. |
| **Present** + `IsCustomEntity: true` + `MetadataId` *not* in memory-bank | Foreign collision | Reconcile live columns and customization properties below; never auto-extend an uncustomizable target. |
| **Present** + `IsCustomEntity: false` | Reserved system table name | Auto-recover via rename (see below). |

Only re-probe a single name when Step 4's batch did not cover it (for example a rename candidate generated later in this step):

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
  "EntityDefinitions(LogicalName='<prefix>_<table>')?\$select=MetadataId,LogicalName,IsCustomEntity,IsManaged,IsCustomizable,CanCreateAttributes" \
  --tenant-id '<tenantId-from-resolve-environment>'
```

Tombstones and hidden collisions are **not** reliably visible to either form — Dataverse can report a name as free and still reject the POST minutes later. Those are caught by the POST-time collision rescue below, which is the real safety net:

| POST response | Meaning | Action |
|---|---|---|
| **5xx** with `0x80060890` or message `"object with same name exists in solution"` | Tombstone (soft-deleted, ~30 min purge TTL) | Auto-recover via rename (see below). |
| **400** with `0x80044363`, `"schema name ... is not unique"`, or `"same name already exists"` | Hidden Dataverse collision / recent-delete tombstone | Auto-recover via rename (see below), then retry the POST once. |

**Important:** treat a POST-time collision as a recoverable name conflict, not a data-model failure — the schema name can stay reserved internally after a delete even when metadata reports it as free.

#### Auto-recovery — reuse/extend first, rename as last resort

**Priority order when Step 5a hits a name collision:**

1. **Adopt as Extend (preferred)** — only if the existing table is the same concept, every same-name column is type-compatible, planned missing columns are custom additions, and live `IsCustomizable.Value` plus `CanCreateAttributes.Value` both permit extension. Add only the missing columns via Step 5b and log `→ Extending existing <original> with <N> missing columns.`
2. **Adopt as Reuse** — if the existing table's schema already covers all planned columns: skip Step 5b for this entry, keep it in Step 6 for service generation. No prompt. Log `→ Reusing existing <original> (all required columns present).`
3. **Rename and Create (last resort)** — only when the existing table is a fundamentally different entity (e.g., planned table is an inspection log but existing `<original>` is a payroll record — incompatible concept, incompatible columns). Prompt the user before proceeding.

**When to auto-decide vs. prompt:**

| Situation | Action |
|---|---|
| Foreign collision + compatible concept/schema + extension allowed | Auto-Extend (no prompt) |
| Foreign collision + all planned columns present | Auto-Reuse (no prompt) |
| Foreign collision + incompatible column or extension forbidden | Auto-rename the conflicting column beside it, or defer it (no prompt) |
| Foreign collision + incompatible concept | Prompt (see below) |
| Reserved system name | Auto-rename (no prompt) |
| Tombstone (0x80060890 / same-name-exists) | Auto-rename (no prompt) |

**For the incompatible-concept case only** — prompt via `AskUserQuestion`:

```
| Option | What it means |
|---|---|
| Rename and Create (default) | Use a free custom logical name for the genuinely different entity. Existing table stays untouched. |
| Reuse existing as-is | Point the generated services at the existing table and skip the planned columns it lacks. |
```

Never offer Extend for an incompatible concept or column shape. This prompt is a preference, not a gate: an empty, skipped, or unanswered response defaults to **Rename and Create** so the run always proceeds.

Maintain a run-level logical-name alias map for every auto-rename. Example:

```json
{ "cr3e9_aircraft": "cr3e9_aircraftv2" }
```

Before building any later table, column, lookup relationship, sample-data payload, service-reference text, or screen data spec, resolve logical names through this map. A rename that only changes the table POST but leaves relationships/screens/sample data pointing at the old name is a bug.

**Auto-rename probe sequence** (cap at 4 probes — only used for reserved/tombstone cases):

```
<original>v2  →  <original>v3  →  <original>2  →  <original>copy
```

For each candidate in order, GET `EntityDefinitions(LogicalName='<candidate>')?$select=MetadataId,IsCustomEntity`:
- 404 → free, **take it**, stop probing.
- 200 or 5xx (collision) → next candidate.

If all 4 collide, keep probing `<original>3`, `<original>4`, … through `<original>20`. This sequence is designed never to dead-end: if even those collide, use `<original><4-char run token>`, which is unique to this run. Never abandon a table for want of a free name.

**On a successful auto-rename, do these in order BEFORE the POST:**

1. **Update `native-app-plan.md`** — `Edit` with `replace_all: true` to swap the old logical name for the new one across the entire `## Data Model` section (Mermaid ER, Reuse/Extend/Create table, Creation Order, Notes). This catches downstream relationship POSTs in this same Step 5 too.
2. **Update `## Screens` per-screen specs** — same `replace_all` sweep for any service / data-source references using the old name.
3. **Append to `memory-bank.md` Collision history** — `<original> → <new>` with reason (foreign / reserved / tombstone) and timestamp.
4. **Update the run-level alias map** — every later metadata payload and plan edit resolves `<original>` to `<new>` before use.
5. **Inform the user — single line, no prompt:**
   > `→ Collision on <original> (<foreign|reserved|tombstone>). Renamed to <new> and updated plan + memory-bank. Continuing.`

Then proceed with the POST using `<new>`.

#### Post-create collision rescue — hidden tombstone / recent delete

If the Step 5b table POST fails after a 404 preflight with any Dataverse name-collision signature, **do not fail the run**:

- HTTP `400` with code `0x80044363`
- message contains `schema name` and `not unique`
- message contains `same name already exists`
- message contains `object with same name exists in solution`

First attempt auto-Extend: compare the plan against that table's attribute snapshot from Step 4 (re-fetch only if it is absent). If ≥50% overlap, switch to Extend path (add missing columns). Otherwise, run the auto-rename probe sequence, update `native-app-plan.md`, `## Screens`, `memory-bank.md`, and the run-level alias map, then retry the table POST exactly once with the resolved name. Print:

> `→ Dataverse still has <original> reserved from a recent delete/hidden collision. Using <new> and continuing.`

If the retry also returns a collision signature, continue probing the remaining candidates, then the numeric tail, then the run-token form described above.

**On successful POST**, immediately re-GET to capture the server-assigned `MetadataId` and write it to memory-bank (Step 6d updates `.datamodel-manifest.json`; you also append to `memory-bank.md` under "Created tables" with the GUID and solution name). This lets future `/add-dataverse` runs distinguish "we own this" from "name collision."

#### Step 5b — Create / extend

Run this step in two explicit passes:

1. **Pass 1 — tables + ordinary columns:** create every new table with all planned non-lookup columns inline, then extend existing tables with any missing non-lookup columns. Computed formula definitions are never synthesized by this workflow.
2. **Pass 2 — lookups + relationships:** only after Pass 1 has succeeded for every tier, create the planned `RelationshipDefinitions`. A lookup is created by its relationship and must not appear in a table's initial `Attributes` array.

Both passes remain strictly sequential. Do not use `$batch` for metadata writes.

For each `Create` decision, in **tier order** (Tier 0 → Tier 1 → Tier 2 → …), POST a new EntityDefinition. Skip if Step 5a returned a known-self match (idempotent).

> **⚠️ Inline ALL planned columns into the Create POST body — do NOT POST columns individually.**
>
> Dataverse accepts all non-lookup columns in the initial table's `Attributes: [...]` array. Inline form: 1 round trip, ~3-8s. Per-column form: N+1 round trips, each ~3-8s. For a 5-column table that's roughly 24s saved on the lock-serialized metadata path. Do not describe this metadata create as transactionally atomic: if the request fails after Dataverse starts processing it, the table or some attributes may remain, which is why the recovery path below exists.
>
> **Wrong** (N round trips):
> ```json
> { "SchemaName": "...", "Attributes": [{ /* primary only */ }] }
> // then 4× POST /Attributes for the rest
> ```
>
> **Right** (1 round trip):
> ```json
> {
>   "SchemaName": "...",
>   "Attributes": [
>     { /* primary name */ },
>     { /* column 2 */ },
>     { /* column 3 */ },
>     { /* column 4 */ },
>     { /* column 5 */ }
>   ]
> }
> ```
>
> The per-column POST path remains valid for two cases only: (1) Extend on an existing table, (2) retry-after-partial-failure when Step 5a's pre-flight shows the table exists but some columns don't.

**Solution targeting (HARD):** every Step 5 / 5b POST MUST pass `--solution <uniquename>` so Dataverse routes the new artifact into our solution rather than the unmanaged default. Read the solution name from `memory-bank.md` Power Platform context (captured in Step 3b). Without this flag, multi-project environments end up with cross-solution leakage and the foreign-collision class of bug returns. The script translates `--solution` to the `MSCRM.SolutionUniqueName` HTTP header.

**Scratch files:** When writing request body JSON to disk (e.g. table definitions, column metadata, relationship payloads), always write to `<working_dir>/.tmp/`, never to `/tmp/`. Keeping request bodies project-local prevents cross-project writes and makes cleanup deterministic. Create the folder if it doesn't exist: `mkdir -p <working_dir>/.tmp`.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> POST EntityDefinitions \
  --body '<json-body-with-all-columns-inline>' \
  --solution '<solution-uniquename-from-memory-bank>' \
  --tenant-id '<tenantId-from-resolve-environment>'
```

**Complete-payload self-check (HARD — do this before the POST, no extra tooling):** re-read the body you just built against the plan and confirm all five statements. If any fails, fix the body and re-check; never POST a partial table and repair it with per-column POSTs.

1. **Every planned ordinary column is present** — String, Memo, Integer, BigInt, Decimal, Money, DateTime, Boolean, Choice, MultiSelect Choice, Image, and File. Count `Attributes[]` and compare with the plan's column count for this table.
2. **No lookup metadata is inline** — no `LookupAttributeMetadata`, `CustomerAttributeMetadata`, or `OwnerAttributeMetadata`. Those are created by their relationship in Pass 2.
3. **No deferred or server-owned column is inline** — no primary-id column and no calculated/rollup column (Step 5c owns those).
4. **Exactly one `IsPrimaryName: true` attribute exists**, and `PrimaryNameAttribute` matches its `SchemaName` (lowercased logical form).
5. **No duplicate `SchemaName`** in `Attributes[]` (compare case-insensitively).

Microsoft documents both halves of this contract: [ordinary columns may be included when the table is created](https://learn.microsoft.com/power-apps/developer/data-platform/webapi/create-update-column-definitions-using-web-api#create-columns), while a [lookup is created with its one-to-many relationship](https://learn.microsoft.com/power-apps/developer/data-platform/webapi/create-update-entity-relationships-using-web-api#create-a-one-to-many-relationship). `dataverse-request.js` stays the only script in this path — it already owns auth, retry, `--solution` routing, and 401/429 handling.

Body skeleton — **all planned columns inline in `Attributes: [...]`** (this example shows primary + 3 additional; expand the array to fit every column from the plan):

> **⚠️ `IsAvailableOffline` + `ChangeTrackingEnabled` MUST be set to `true` at create time** for any table the app intends to make available offline. Without these two flags the table cannot be added to a `mobileofflineprofile`, and `/setup-offline-profile` will have to fix them via a separate metadata PUT (the `/enable-tables-offline` skill handles that, but it doubles the metadata-lock-serialized round trips). Empirically verified 2026-05-18 in the chanel-rm demo: 7 custom tables created without these flags caused 7 prereq-revert drift entries; fixed by post-hoc enablement. Default these to `true` for all UserOwned tables created by `/add-dataverse` unless the user has explicitly opted out of offline support. The flags are no-ops at runtime for apps that don't use offline profiles.

```json
{
  "@odata.type": "Microsoft.Dynamics.CRM.EntityMetadata",
  "SchemaName": "cr123_jobsite",
  "DisplayName": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "Label": "Job Site", "LanguageCode": 1033 }] },
  "DisplayCollectionName": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "Label": "Job Sites", "LanguageCode": 1033 }] },
  "OwnershipType": "UserOwned",
  "HasActivities": false,
  "HasNotes": false,
  "IsAvailableOffline": true,
  "ChangeTrackingEnabled": true,
  "PrimaryNameAttribute": "cr123_sitename",
  "Attributes": [
    {
      "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
      "SchemaName": "cr123_sitename",
      "DisplayName": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "Label": "Site Name", "LanguageCode": 1033 }] },
      "MaxLength": 200,
      "FormatName": { "Value": "Text" },
      "RequiredLevel": { "Value": "ApplicationRequired" },
      "IsPrimaryName": true
    },
    {
      "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
      "SchemaName": "cr123_address",
      "DisplayName": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "Label": "Address", "LanguageCode": 1033 }] },
      "MaxLength": 500,
      "FormatName": { "Value": "Text" },
      "RequiredLevel": { "Value": "None" }
    },
    {
      "@odata.type": "Microsoft.Dynamics.CRM.IntegerAttributeMetadata",
      "SchemaName": "cr123_squarefeet",
      "DisplayName": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "Label": "Square Feet", "LanguageCode": 1033 }] },
      "RequiredLevel": { "Value": "None" },
      "MinValue": 0,
      "MaxValue": 2147483647,
      "Format": "None"
    },
    {
      "@odata.type": "Microsoft.Dynamics.CRM.BooleanAttributeMetadata",
      "SchemaName": "cr123_active",
      "DisplayName": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "Label": "Active", "LanguageCode": 1033 }] },
      "RequiredLevel": { "Value": "None" },
      "DefaultValue": true,
      "OptionSet": {
        "@odata.type": "Microsoft.Dynamics.CRM.BooleanOptionSetMetadata",
        "TrueOption": { "Value": 1, "Label": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "Label": "Yes", "LanguageCode": 1033 }] } },
        "FalseOption": { "Value": 0, "Label": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "Label": "No", "LanguageCode": 1033 }] } }
      }
    }
  ]
}
```

For each `Extend` decision, POST a new column to the existing table.

> **⚠️ Table-level pre-flight (HARD — required for idempotent re-runs).** Reuse the complete attribute snapshot fetched for this table in Step 4. If the table was discovered only during collision recovery, or no current snapshot exists, fetch all attributes exactly once:
>
> ```bash
> node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
>   "EntityDefinitions(LogicalName='<table>')/Attributes?\$select=MetadataId,LogicalName,SchemaName,AttributeType,AttributeTypeName,RequiredLevel,IsManaged,IsCustomizable,IsPrimaryId,IsPrimaryName" \
>   --tenant-id '<tenantId-from-resolve-environment>'
> ```
>
> Build a local `{ lowerCaseLogicalName → { AttributeType, AttributeTypeName, IsManaged, IsCustomizable } }` map and classify **every** planned non-lookup column before issuing any POST. Prefer `AttributeTypeName.Value` when `AttributeType` is `Virtual`, so File and Image columns are not incorrectly treated as compatible generic virtual attributes:
>
> | Snapshot result | Action |
> |---|---|
> | Name exists and `AttributeType` matches | Skip it and log `↻ <column> (already exists, skipped)`. |
> | Name exists and `AttributeType` differs | Dataverse does not allow column-type changes via API, so **auto-rename the planned column** using the same probe sequence (`<column>v2` → `<column>v3` → `<column>2` → …), add it to the alias map, and create it beside the existing one. Log `→ <column> exists as <existingType>; created <newName> as <plannedType> instead.` Never modify or delete the existing column. |
> | Name is absent | Add it to the ordered missing-column queue. |
>
> This single snapshot catches partial creates, corrected re-runs, and network-drop recovery without paying one GET round trip per column.

After the complete comparison passes, POST the missing-column queue **one column at a time, sequentially** (no `$batch`; always pass `--solution`):

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> POST \
  "EntityDefinitions(LogicalName='<table>')/Attributes" \
  --body '<column-json>' \
  --solution '<solution-uniquename-from-memory-bank>' \
  --tenant-id '<tenantId-from-resolve-environment>'
```

**Recovery after a partial Create:** do not re-POST the whole `EntityDefinitions` body because the table now exists and Dataverse returns `0x80060888`. Fetch that table's complete attribute snapshot once, run the same local comparison, and sequentially POST only the missing non-lookup columns. This is the only time a table originally classified as Create should use the per-column path.

Column shapes that have non-obvious gotchas (handle carefully):
- **Pass-2 barrier (HARD)** — do not create any lookup or relationship while Pass 1 is still creating or extending tables. Accumulate relationship definitions, wait until every table and ordinary column has returned 2xx, then process the relationships sequentially in dependency order.
- **Lookup** — POST to `/RelationshipDefinitions`, not `/Attributes`.

  > **⚠️ Do NOT improvise the body. Copy the skeleton below verbatim and replace only the placeholders in `<>` brackets.**
  >
  > Fields that cause silent failure if added:
  > - **Do NOT include `ReferencingAttribute`.** Dataverse auto-creates the foreign-key column from `Lookup.SchemaName`. Including it causes `404: Could not find an attribute with specified name` because the column doesn't exist yet at POST time.
  > - **Do NOT include `Lookup.LogicalName`.** It's read-only metadata; including it returns `400 Bad Request`.
  > - **Do NOT include `ReferencedAttribute`.** Dataverse resolves the primary key of the referenced entity automatically. The reference is optional and omitting it is the correct default.
  >
  > Required fields: `SchemaName`, `ReferencedEntity`, `ReferencingEntity`, `Lookup.{@odata.type, SchemaName, DisplayName, RequiredLevel}`, `AssociatedMenuConfiguration`, `CascadeConfiguration` (including `RollupView`). Anything else is invented — drop it.

  ```json
  {
    "@odata.type": "Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
    "SchemaName": "<prefix>_<Parent>_<Child>",
    "ReferencedEntity": "<parent_table_logical_name>",
    "ReferencingEntity": "<child_table_logical_name>",
    "Lookup": {
      "@odata.type": "Microsoft.Dynamics.CRM.LookupAttributeMetadata",
      "SchemaName": "<Prefix>_<Parent>Id",
      "DisplayName": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "<Parent Display Name>", "LanguageCode": 1033 }] },
      "RequiredLevel": { "Value": "None" }
    },
    "AssociatedMenuConfiguration": { "Behavior": "UseCollectionName", "Group": "Details", "Order": 10000 },
    "CascadeConfiguration": {
      "Assign": "NoCascade",
      "Delete": "RemoveLink",
      "Merge": "NoCascade",
      "Reparent": "NoCascade",
      "Share": "NoCascade",
      "Unshare": "NoCascade",
      "RollupView": "NoCascade"
    }
  }
  ```

  Invocation (apiPath is `RelationshipDefinitions`, body via `--body`, always pass `--solution`):

  ```bash
  node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> POST \
    RelationshipDefinitions \
    --body '<json-body-from-skeleton-above>' \
    --solution '<solution-uniquename-from-memory-bank>' \
    --tenant-id '<tenantId-from-resolve-environment>'
  ```

  **Pre-flight the lookup (HARD — required for idempotent re-runs).** A lookup can only pre-exist if the **referencing (child) table** already existed at Step 4, so when the child was created in this run, skip the probe and POST. Otherwise look for the lookup's foreign-key column — the lowercased `Lookup.SchemaName`, e.g. `<prefix>_<parent>id` — in that child table's Step 4 attribute snapshot:

  | Snapshot result | Action |
  |---|---|
  | Present with `AttributeType: Lookup` | Skip the POST and log `↻ <SchemaName> (relationship already exists, skipped)`. |
  | Present with any other `AttributeType` | A non-lookup column already owns that name. Auto-rename the lookup's `Lookup.SchemaName` via the probe sequence, record it in the alias map, and POST the relationship with the new name. Never overwrite the existing column. |
  | Absent | POST the relationship. |

  This costs no extra round trip: the referencing attribute is an ordinary attribute on the child table, so it is already in the snapshot Step 4 fetched. Without this check a re-run POSTs a duplicate relationship and fails the run mid-Pass-2.

- **Many-to-Many (M:N)** — also POST to `/RelationshipDefinitions`, but with `ManyToManyRelationshipMetadata`. Dataverse creates an auto-named intersect table.

  > **⚠️ Do NOT improvise the body.** Required fields: `SchemaName`, `Entity1LogicalName`, `Entity2LogicalName`, `IntersectEntityName`, and the two `AssociatedMenuConfiguration` blocks. Do not include lookup or cascade fields — those are 1:N concepts.

  ```json
  {
    "@odata.type": "Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata",
    "SchemaName": "<prefix>_<table1>_<table2>",
    "Entity1LogicalName": "<table1_logical_name>",
    "Entity2LogicalName": "<table2_logical_name>",
    "IntersectEntityName": "<prefix>_<table1>_<table2>",
    "Entity1AssociatedMenuConfiguration": {
      "Behavior": "UseLabel",
      "Group": "Details",
      "Label": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "<Table2 Plural>", "LanguageCode": 1033 }] },
      "Order": 10000
    },
    "Entity2AssociatedMenuConfiguration": {
      "Behavior": "UseLabel",
      "Group": "Details",
      "Label": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "<Table1 Plural>", "LanguageCode": 1033 }] },
      "Order": 10000
    }
  }
  ```

  **Pre-flight M:N:** a relationship can only pre-exist on a table that already existed at Step 4. If **either** endpoint was just created in this run, skip the probe — nothing can be there. Otherwise read `ManyToManyRelationships` from that table's Step 4 snapshot: present → skip (already exists); absent → proceed. Query `RelationshipDefinitions(SchemaName='<prefix>_<table1>_<table2>')?$select=SchemaName` only when the snapshot did not cover it.

  **In the generated service:** M:N relationships are queried via the intersect entity name (e.g., `cr123_tag_inspection`) — the SDK does not expose a direct M:N navigation helper; the screen-builder must query the intersect table directly. Flag this in the Step 7 summary if any M:N relationships are created.

- **Column `@odata.type` and required fields — reference table (verified against Dataverse OData API):**

  | Dataverse type | `@odata.type` | Required extra fields |
  |---|---|---|
  | Single-line text | `Microsoft.Dynamics.CRM.StringAttributeMetadata` | `MaxLength` (200), `FormatName: { "Value": "Text" }` — values: `Text`, `Email`, `Url`, `Phone`, `TextArea` |
  | Multi-line text | `Microsoft.Dynamics.CRM.MemoAttributeMetadata` | `MaxLength` (10000), `Format: "TextArea"` |
  | Whole number | `Microsoft.Dynamics.CRM.IntegerAttributeMetadata` | `MinValue`, `MaxValue`, `Format: "None"` |
  | Decimal | `Microsoft.Dynamics.CRM.DecimalAttributeMetadata` | `MinValue`, `MaxValue`, `Precision` (2) |
  | Currency (Money) | `Microsoft.Dynamics.CRM.MoneyAttributeMetadata` | `MinValue`, `MaxValue`, `Precision` (2), `PrecisionSource` (2) |
  | Date/Time | `Microsoft.Dynamics.CRM.DateTimeAttributeMetadata` | `Format: "DateAndTime"` or `"DateOnly"`, `DateTimeBehavior: { "Value": "UserLocal" }` |
  | Boolean | `Microsoft.Dynamics.CRM.BooleanAttributeMetadata` | `DefaultValue`, `OptionSet` with `TrueOption`/`FalseOption` |
  | Choice (picklist) | `Microsoft.Dynamics.CRM.PicklistAttributeMetadata` | `OptionSet` with `IsGlobal: false`, `OptionSetType: "Picklist"`, `Options[]` — **option integer values start at `100000000` and increment by 1** |
  | Lookup | via `RelationshipDefinitions` — see 1:N skeleton above | — |
  | Image | `Microsoft.Dynamics.CRM.ImageAttributeMetadata` | `MaxHeight`, `MaxWidth` |
  | File | `Microsoft.Dynamics.CRM.FileAttributeMetadata` | `MaxSizeInKB` |

  **Common mistake:** omitting `FormatName` on String columns and `DateTimeBehavior` on DateTime columns. Both are required — Dataverse rejects the POST without them.

- **Choice (option set)** — set `OptionSet.IsGlobal: false` for local picklists. Full body (option values start at `100000000` and increment by 1):

  ```json
  {
    "@odata.type": "Microsoft.Dynamics.CRM.PicklistAttributeMetadata",
    "SchemaName": "<Prefix>_<ColumnName>",
    "DisplayName": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "<Display Name>", "LanguageCode": 1033 }] },
    "RequiredLevel": { "Value": "None" },
    "OptionSet": {
      "@odata.type": "Microsoft.Dynamics.CRM.OptionSetMetadata",
      "IsGlobal": false,
      "OptionSetType": "Picklist",
      "Options": [
        { "Value": 100000000, "Label": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "Option 1", "LanguageCode": 1033 }] } },
        { "Value": 100000001, "Label": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "Option 2", "LanguageCode": 1033 }] } }
      ]
    }
  }
  ```
- **Image** — `@odata.type: Microsoft.Dynamics.CRM.ImageAttributeMetadata`, `MaxHeight`/`MaxWidth` required
- **File** — `@odata.type: Microsoft.Dynamics.CRM.FileAttributeMetadata`, `MaxSizeInKB` required

If the column type is not a simple string/int/boolean, surface a one-line confirmation to the user before posting.

After all mutations, re-run the existing-tables query (Step 4) to confirm everything landed.

### Step 5c — Enforce the supported computed-column boundary

Dataverse metadata exposes `FormulaDefinition`, but Microsoft explicitly does
not support defining calculated, rollup, or formula expressions through code.
Legacy workflow XAML and generated formula serialization must not be synthesized.

- Do not invoke `create-calculated-column.js`; it is a fail-closed guard for
  legacy callers.
- Cross-entity fields must use a supported formatted lookup annotation or
  bounded chained fetch as documented in `data-performance.md`.
- For a hot list field that cannot use either path, mark it
  `external-projection-required` and omit it from this mutation run. The user
  may create a formula column in Power Apps or supply another server-owned
  projection outside this PR, then rerun Step 4a to validate and reuse it.
- Never create an ordinary copied field without an explicit refresh owner.

Reference:
https://learn.microsoft.com/power-apps/developer/data-platform/specialized-columns

### Step 5d — Create alternate keys for unique business identifiers

**Print before starting:**
> "→ Creating alternate keys for columns marked unique in the data model (one HTTP call per key). Skip if no unique columns are planned."

**Run condition:** the `## Data Model` section marks a non-primary column as unique / alternate key / natural key. Common examples: QR Code Value, SKU, external ID, employee number, asset tag. Skip primary IDs and skip columns whose type Dataverse cannot index as an alternate key (file/image, memo/long text, multi-select choice, calculated/rollup, customer/owner lookups).

**Ordering:** run after the target table and target columns exist, and before Step 6b publish. Alternate-key index activation is asynchronous; creation may return success while the key status is `Pending`.

**Do NOT use the `CreateEntityKey` action route.** In practice it can return 404 depending on route shape / environment. The reliable metadata route is POSTing to the table's `Keys` navigation collection:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> POST \
  "EntityDefinitions(LogicalName='<table>')/Keys" \
  --body '<entity-key-json>' \
  --solution '<solution-uniquename-from-memory-bank>' \
  --tenant-id '<tenantId-from-resolve-environment>'
```

Body skeleton:

```json
{
  "@odata.type": "Microsoft.Dynamics.CRM.EntityKeyMetadata",
  "SchemaName": "<prefix>_<table>_<column>_key",
  "DisplayName": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "Label": "<Column display> Key", "LanguageCode": 1033 }] },
  "KeyAttributes": ["<column_logical_name>"]
}
```

**Pre-flight each key before POST** so re-runs are idempotent. A key can only pre-exist on a table that already existed at Step 4, so for a table created in this run, skip straight to the POST. Otherwise read `Keys` from that table's Step 4 snapshot. Query it directly only when the snapshot did not cover that table:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
  "EntityDefinitions(LogicalName='<table>')?\$select=LogicalName&\$expand=Keys(\$select=SchemaName,KeyAttributes,EntityKeyIndexStatus)" \
  --tenant-id '<tenantId-from-resolve-environment>'
```

| Existing key state | Action |
|---|---|
| Same `SchemaName` or same `KeyAttributes` exists with `Active` / `Pending` | Skip POST; record the key in `.datamodel-manifest.json`. |
| Same `SchemaName` exists with `Failed` | Surface the failure and stop; Dataverse requires deleting/recreating the key manually or changing the planned key name. |
| No matching key | POST to `EntityDefinitions(LogicalName='<table>')/Keys`. |

**After POST:** a `204` response is success. Re-query the `Keys` expand above and capture `EntityKeyIndexStatus`. If it is `Pending`, continue the scaffold but add a memory-bank follow-up: `alternate key <schema> pending index activation`. Do not rely on duplicate enforcement in manual tests until the status reaches `Active`.

Add alternate keys to `.datamodel-manifest.json` for the table:

```json
"alternateKeys": [
  { "schemaName": "cr123_item_code_key", "keyAttributes": ["cr123_code"], "indexStatus": "Pending" }
]
```

### Step 6 — Add data sources

**Print before starting:**
> "→ Generating TypeScript services for <N> tables via `npx power-apps add-data-source` (sequential). Print '✓ <table>Service.ts' after each."

When `<operation_manifest_mode> = valid`, set `SERVICE_REQUIRED_TABLES` from
`service.requiredTables[].logicalName`. Keep the manifest's resolved adapted
names and exclude only explicit deferred rows. Service generation remains
sequential outside BATCH-METADATA.

For each table in `SERVICE_REQUIRED_TABLES` (regardless of reuse/extend/create), generate the TS layer from the app root. Do not derive this list from Creation Order alone because reused tables are intentionally absent from creation tiers. The CLI reads the environment ID from `power.config.json`; pass the environment URL resolved earlier in the skill:

```bash
npx power-apps add-data-source --api-id dataverse --org-url <envUrl> --resource-name <table-logical-name>
```

Run **one at a time — sequentially**, not in parallel. The Power Apps CLI writes `src/generated/connectorSchemas.ts` and other generated files non-atomically; concurrent invocations corrupt them.

After generation, verify each required table appears in `power.config.json` `databaseReferences.default.cds.dataSources` and that a matching file exists in `src/generated/services/`. If any reused or custom table is missing, STOP before screen generation:

```text
BLOCKED: required Dataverse service missing for <logical-name>. Schema action=<reuse|extend|create>; app usage=<screens/hooks that require it>.
```

### Step 6b — Publish customizations

When `<operation_manifest_mode> = valid`, skip this step: the validated
manifest's final `publish` phase already ran and its pending checkpoint was
deleted, or the manifest proved there were zero metadata writes and no pending
publish retry.

**Print before starting:**
> "→ Publishing customizations (PublishXml) so new tables/columns become queryable. ~5–20 seconds."

Only after **every** Step 5 metadata POST and **every** Step 6 `npx power-apps add-data-source` has returned successfully, publish so the new tables and columns are available to the runtime. `PublishXml` takes the same exclusive metadata lock as the create/extend calls — do not run it concurrently with anything from Steps 5 or 6.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> POST \
  "PublishXml" \
  --body "{\"ParameterXml\":\"<importexportxml><entities><entity>cr123_table1</entity><entity>cr123_table2</entity></entities></importexportxml>\"}" \
  --tenant-id '<tenantId-from-resolve-environment>'
```

Build the entity list from all tables that were **created or extended** in Steps 4–5. Skip reused-as-is tables — they don't need republishing.

If the publish call returns a non-2xx status, report the error and stop — do not proceed. The user must resolve before the tables are usable.

### Step 6c — Verify tables exist

Confirm every created or extended table is queryable after publish with **one** filtered query, not one request per table:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
  "EntityDefinitions?\$select=LogicalName,DisplayName&\$filter=LogicalName eq '<table1>' or LogicalName eq '<table2>'" \
  --tenant-id '<tenantId-from-resolve-environment>'
```

- **Every expected name present in `value[]`** → confirmed.
- **Any expected name missing** → that table did not survive publish — report which ones and stop.

### Step 6d — Write `.datamodel-manifest.json`

After all tables are verified, write the manifest to the project root using the `Write` tool:

```json
{
  "environmentUrl": "<envUrl>",
  "generatedAt": "<ISO timestamp>",
  "aliases": {
    "tables": { "<approved original logical name>": "<final logical name>" },
    "columns": { "<final table logical name>": { "<approved original column>": "<final column>" } }
  },
  "tables": [
    {
      "logicalName": "cr123_jobsite",
      "displayName": "Job Site",
      "status": "new",
      "entitySetName": "cr123_jobsites",
      "primaryIdAttribute": "cr123_jobsiteid",
      "primaryNameAttribute": "cr123_sitename",
      "dependencyTier": 0,
      "customEntity": true,
      "sharedSystemTable": false,
      "metadataId": "<server-assigned GUID from Step 5a re-GET>",
      "solution": "<solution unique name, e.g. PowerAppsDefault>",
      "columns": [
        {
          "logicalName": "cr123_sitename",
          "schemaName": "cr123_SiteName",
          "displayName": "Site Name",
          "type": "String",
          "requiredLevel": "ApplicationRequired"
        },
        {
          "logicalName": "cr123_status",
          "schemaName": "cr123_Status",
          "displayName": "Status",
          "type": "Choice",
          "requiredLevel": "None",
          "options": [
            { "value": 100000000, "label": "Draft" },
            { "value": 100000001, "label": "Complete" }
          ]
        },
        {
          "logicalName": "cr123_regionid",
          "schemaName": "cr123_Region",
          "displayName": "Region",
          "type": "Lookup",
          "requiredLevel": "None",
          "target": "cr123_region",
          "targetEntitySetName": "cr123_regions"
        }
      ]
    }
  ]
}
```

`metadataId` and `solution` are required for `status: "new"` or `"extended"` entries — they're how Step 5a distinguishes "we own this on a re-run" from "name collision." Reused tables can omit both.

The manifest is a machine handoff, not a creation log. Include **every
non-deferred service-required table confirmed in Step 6c**, including tables
reused with no schema changes. Reused rows use `status: "reused"`; adapted
rows use `status: "adapted"` and their final names. This is required so
screen binding, prototype conversion, sample data, and offline reconciliation
see the same complete app data surface.

Before writing, enrich every table and column from the live metadata already
collected in Steps 4, 4a, and 6c:

- exact `EntitySetName`, `PrimaryIdAttribute`, and `PrimaryNameAttribute`;
- dependency tier from the approved model;
- exact logical/schema/display names and Dataverse type;
- Lookup target logical name and target `EntitySetName`;
- Choice, MultiSelect Choice, and Boolean integer/label options;
- File/Image limits and requiredness when present;
- run-level table/column aliases created by Adapt/collision handling;
- `customEntity` and `sharedSystemTable` so sample-data workflows can require
  confirmation before writing shared standard tables.

Never guess an entity-set plural or lookup navigation name. If any required
fact is absent from the current cache, perform one bounded live metadata read
for that table/derived column before writing the manifest.

Validate the completed file before Step 7:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-datamodel-manifest.js" \
  "<working_dir>/.datamodel-manifest.json"
```

Any validation error is blocking. Repair or enrich the manifest from live
metadata; do not let screen generation, sample data, conversion cleanup, or
offline reconciliation proceed from a partial manifest.

### Step 7 — Inspect generated files

```text
Glob: src/generated/services/*Service.ts
Glob: src/generated/models/*Model.ts
```

For each table, check the generated service exposes the expected methods:

```text
Grep pattern="async (create|getAll|getById|update|delete|upload|downloadFile|downloadImage)" path="src/generated/services/<Table>Service.ts"
```

If the table has file or image columns, confirm the service includes `upload`, `downloadFile`, `downloadImage`, `deleteFileOrImage` — and the model exposes `<Table>FileColumnName` / `<Table>ImageColumnName` union types.

**File/image column UI controls:** When a generated table has File or Image columns, note this in the summary so screen-builders apply the host controls from `@microsoft/power-apps-native-host`:
- **File columns** → `<FilePicker>`; upload bytes separately via the generated service's upload method after the main create/update.
- **Image columns** → `<ImagePicker>`; capture `PickedImageInfo` via `onImageChange` and persist through generated `upload(...)` after the main create/update.
- **Read/view flows** → use generated `downloadFile(...)` / `downloadImage(...)` helpers for existing attachments/previews.

Full usage pattern and the native-wrapper boundary live in [`/add-native`](../add-native/SKILL.md#fileimage-picker-ownership); screen-builder keeps only the concise JSX enforcement rule.

**PDF/signature artifact schema guidance:** If the approved plan mentions generated PDFs, PDF evidence packets, approvals, signatures, sign-off, ink, or drawings, preserve the storage decision in the Dataverse model instead of defaulting to text fields.

| User need | Dataverse shape | Write pattern |
|---|---|---|
| Generated PDF report that must be retained | File column on the parent record, or child Evidence/Attachment table with a File column | Create/update parent row first, then call generated `Service.upload(parentId, '<fileColumn>', file)` |
| Generated PDF report that is only transient | No Dataverse column required | Generate locally with `expo-print` only when present; share with `expo-sharing` only when present; do not route local URI to native PDF viewer |
| Captured signature/sign-off image | Image column when the latest signature belongs on the parent row | Strip `data:image/png;base64,` if the generated service expects raw base64, then include image payload in the update body |
| Multiple signatures, sketches, evidence images, or audit attachments | Child Evidence/Attachment table with Image/File columns and lookup to parent | Create child row first, then include Image payload or upload File bytes through generated service helpers |

Signature image normalization example:

```ts
const signatureBase64 = signatureDataUri.replace(/^data:image\/png;base64,/, '');
const result = await Cr123_approvalService.update(approvalId, {
  cr123_signatureimage: signatureBase64,
  cr123_signedat: new Date().toISOString(),
});

if (!result.success) {
  throw new Error(result.error?.message ?? 'Signature image was not saved.');
}
```

File upload after parent row exists example:

```ts
const save = await Cr123_inspectionService.update(inspectionId, {
  cr123_reportgeneratedat: new Date().toISOString(),
});

if (!save.success) {
  throw new Error(save.error?.message ?? 'Inspection was not saved.');
}

const upload = await Cr123_inspectionService.upload(inspectionId, 'cr123_reportfile', reportFile);

if (!upload.success) {
  throw new Error(upload.error?.message ?? 'Inspection report was not uploaded.');
}
```

### Step 8 — Type-check

**Print before starting:**
> "→ Regenerating connector schemas + running tsc to verify generated services compile (~15–30 seconds)."

`npx power-apps add-data-source` (Step 5) wrote new files into `.power/schemas/<connector>/`. The `connectorSchemas.ts` consumed by `app/_layout.tsx` is now stale — regenerate it before type-checking, otherwise the new tables won't be wired into the runtime schema map and `tsc` will pass against an out-of-date snapshot:

```bash
npm run generate-schemas
npx tsc --noEmit
```

Fix any errors. Common: missing peer dependencies — `npx expo install <package>`.

### Step 8.5 — Offline profile reconciliation

A schema change here (new table or new column) can leave an existing Mobile Offline Profile behind — new tables never sync to devices and new columns come down blank. Reconcile the profile with what you just created.

**Skip this step entirely when `$ARGUMENTS` contains `--skip-planning`** (the orchestrator-invoked path). `/create-mobile-app`, `/setup-datamodel`, and `/edit-app` own offline reconciliation in their own flow, so running it here too would double-prompt.

Otherwise (manual `/add-dataverse`), run the local, no-network delta check:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/offline-profile-delta.js"
```

Branch on the JSON `status` per [offline-profile-reconciliation.md](${CLAUDE_SKILL_DIR}/../../shared/references/offline-profile-reconciliation.md):

| `status` | Action |
|---|---|
| `no-manifest` / `no-profile` / `in-sync` | Continue to Step 9 silently. For `no-profile` (no offline profile exists) do not nag — the app may not use offline. |
| `error` | `offline-profile.json` is unreadable — the script prints `status: error` and **exits non-zero**. Do NOT treat this as an `/add-dataverse` failure (the tables are already created): surface the `error` string, **skip reconciliation** (never drive the update workflows against a corrupt file), and finish with `DONE_WITH_CONCERNS` telling the user to fix `offline-profile.json`. |
| `delta` | Prompt the user (one `AskUserQuestion`, default = update now) to add the missing tables / new columns. For `missingTables[]`, read and execute `${CLAUDE_SKILL_DIR}/../add-table-to-offline-profile/SKILL.md`; for `tablesWithNewColumns[]`, read and execute `${CLAUDE_SKILL_DIR}/../edit-offline-profile/SKILL.md` with `--table <t> --columns add:<newColumns>`. Re-run the delta check; it should read `in-sync`. Follow the exact prompt + ordering in the reconciliation reference. |

### Step 9 — Summary

```
✅ Dataverse added
─────────────────────────────────────────────
Environment   : <envUrl>
Tables reused : <list>
Tables extended: <list (columns added)>
Tables created : <list (in tier order)>
Adapted       : <renamed table/column → new name, and why. Omit the line if none.>
Deferred      : <items left out of this run and why, e.g. "cr123_note (target not customizable)". Omit the line if none.>
Operation manifest: <validated path, operation count, or "standalone fallback">

Generated services:
  src/generated/services/<Table>Service.ts × N
Generated models:
  src/generated/models/<Table>Model.ts × N

Type-check: PASS

Sample usage:

  import { Cr123_jobsiteService } from '../../src/generated/services/Cr123_jobsiteService';

  const result = await Cr123_jobsiteService.getAll({
    select: ['cr123_sitename', 'cr123_address'],
    filter: 'statecode eq 0',
    orderBy: ['cr123_sitename asc'],
    top: 50,
  });
  const sites = result.data ?? [];

⚠️  First call triggers Dataverse OAuth consent via the native player's
    `<scheme>://oauth-callback` deep link.

Next:
  /add-sample-data        # Seed each new table with 5-10 realistic rows so the
                          # app's home screen shows real-looking data on first launch.
─────────────────────────────────────────────
```

After printing the summary, **offer one-click sample-data seeding** — but only when invoked manually (not from `/create-mobile-app`, which handles this in its own Step 8.5).

- **If `$ARGUMENTS` contains `--skip-planning`** (the orchestrator-invoked path): skip the prompt. The orchestrator invokes `/add-sample-data` separately.
- **Otherwise (manual invocation)**, if the manifest contains any tables, ask:

  > "Seed <N> tables with sample records so the app shows real-looking data on first launch? (yes / no — default: yes)"

  Default to "yes" so empty input auto-proceeds. On "yes", invoke `/add-sample-data`. On "no", print "→ Skipped sample data. Run `/add-sample-data` later to populate." and stop.

## Key Rules

- **Always** use generated services (e.g., `Cr123_jobsiteService.getAll()`) — never `fetch` / `axios` directly.
- Result data lives at `result.data`, not `result` itself.
- Don't edit files under `src/generated/` — they are regenerated on every `npx power-apps add-data-source`.
- Picklist (Choice) fields, virtual fields, lookups, and file/image columns each have non-obvious gotchas. Keep `references/dataverse-reference.md` aligned with this skill.
- A valid operation manifest removes repeated agent reconciliation; it does not
  change Dataverse's serialized metadata-lock latency. Real matched A/B runs
  remain required before claiming an end-to-end timing range.
- **When a Dataverse Web API behavior is uncertain (lookup write syntax, `$expand` nav property names, choice column shape, batch semantics, error format), query the `microsoft-learn` MCP server before guessing.** See [shared/shared-instructions.md → Microsoft Learn MCP](../../shared/shared-instructions.md#microsoft-learn-mcp-authoritative-microsoft-docs). Guessed Dataverse syntax silently 400s.

## Reference

- [`scripts/dataverse-request.js`](../../scripts/dataverse-request.js) — bundled in this plugin
- [`scripts/build-dataverse-operation-manifest.js`](../../scripts/build-dataverse-operation-manifest.js) — deterministic contract/snapshot reconciliation, binding, validation, and ordered BATCH-METADATA phase generation
- [shared/references/offline-profile-reconciliation.md](../../shared/references/offline-profile-reconciliation.md) — Step 8.5 offline delta check + reconciliation flow
