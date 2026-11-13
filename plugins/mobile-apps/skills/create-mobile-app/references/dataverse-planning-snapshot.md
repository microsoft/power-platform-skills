# Foreground Dataverse planning snapshot and evidence

A step both build orders of `/create-mobile-app` run: [`make-it-real.md`](make-it-real.md) (screens first) and
[`data-model-first.md`](data-model-first.md) (data model first) each read it under their own numbered heading.
Fix it here and both orders get the fix.

Steps it names, by build order:

| Named here | Screens first | Data model first |
|---|---|---|
| this step | part of Step 10 | part of Step 3 |
| the auth step | Step 11 | Step 4 |
| the Apply data model step | Step 12 | Step 8 |
| the architecture gate | architecture gate | Gate 1 |
| the data model gate | data model gate | Gate 2 |

<!-- The step starts here; everything above is about the file. -->

This read-only helper recipe is also used by
[scoped Dataverse change planning](../../../shared/references/dataverse-change-planning.md).
Those callers supply their own request scope and approvals; they do not run
the create wizard or dispatch its native-app planner.

Apply [app-working-directory.md](../../../shared/references/app-working-directory.md)
before this recipe. Each shell block below and in Dataverse planning recovery
re-enters the owner's absolute root. Re-supply the selected identity and artifact
paths on every call; fresh-shell retries re-execute the complete guarded
attempt block, including its variable assignments and function definition.

Planning stays read-only. The resolver's `--no-cache` mode may read existing
identity metadata, but must not persist the environment cache, auth settings,
or telemetry cluster, and must not replay pending telemetry. Normal resolution
in the auth step retains those post-approval behaviors.

Branch on the `<dataverse_planning_mode>` approved at the architecture gate:

- `connector-only` — skip every command in this section. Set `SNAPSHOT_PATH`
  and `ARCHITECT_EVIDENCE_PATH` to empty/not supplied, print
  `↷ Foreground planning snapshot skipped — the confirmed brief is connector-only.`, and
  continue to planner dispatch. Connector-only planning does not perform
  Dataverse metadata reads; the skill's existing global prerequisites remain
  unchanged.
- `required` — resolve the already selected environment again in the
  foreground and create one normalized foreground planning snapshot as below. Do not make the
  nested planner or architect rediscover the tenant.

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/resolve-environment.js" "$ACTIVE_ENV_ID" --no-cache --require-tenant
```

The command validates both required fields before returning JSON. On exit `0`,
use its `environmentUrl` as `$ACTIVE_ENV_URL` and `tenantId` as
`$ACTIVE_TENANT_ID` in the following commands, replacing the previous values.
Read these fields directly from the structured command result; do not run
separate JSON-extraction commands. On a nonzero exit, follow foreground
recovery below and do not create a snapshot or reuse stale environment values.

Build `<working_dir>/.tmp/dataverse-concepts.json` as a JSON array of typed
concepts from the confirmed brief and the approved architecture; when the screens came first,
the approved Data Contract's entities and fields are the primary concepts. Account for
approved native capture/storage targets. Discover only app-owned Dataverse
records or explicitly approved Dataverse projections; exclude connector-owned
records from Dataverse candidate selection. Each item has `phrase`, `kind`,
`discoverTable`, and a short `evidence` quote. Use `kind: entity` and
`discoverTable: true` only for a plausible persistent business record with an
independent lifecycle; classify people/actors as `role`, fields as `attribute`,
workflow verbs as `action`, enum values as `status`, and operating limits as
`constraint`, all with `discoverTable: false`. Preserve multiword/header-child
families such as `medical assessments`, `care activities`, `release events`,
`custody transfers`, `test results`, and `evidence attachments`. Do not turn
every noun into an entity merely to increase recall. Add known standard or
required-existing logical names to `<EXPLICIT_TABLES>`. Build
`<PROPOSED_TABLES>` from the detected publisher prefix for every clearly
proposed custom table so collisions and missing names are explicit; leave a
name out rather than inventing it when the concept is not yet stable.

Detailed advisory discovery is quality-bounded:

- Keep the complete customizable-table inventory and ranking.
- Required exact-name tables are always detailed and do not consume advisory
  capacity.
- A concept credibly covered by an exact table does not receive speculative
  advisory alternatives.
- Every typed entity concept receives its primary candidate and at most one
  ambiguity candidate. Roles, attributes, actions, statuses, and constraints
  never trigger table discovery.
- A lower-ranked proposed-name collision is promoted only when its display
  phrase strongly matches a multiword entity concept.
- Strong exact/suffix/contains matches and explicit/collision candidates load
  full details. Weak advisory candidates load `core` details and cannot
  authorize Reuse, Extend, or Adapt until bounded expansion upgrades them.
- Inventory-only alternatives remain available for bounded exact-name
  expansion, at most once per newly selected logical name.

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
SNAPSHOT_PATH='<working_dir>/.tmp/dataverse-foreground-planning-snapshot.json'
CONCEPTS_PATH='<working_dir>/.tmp/dataverse-concepts.json'
ARCHITECT_EVIDENCE_PATH='<working_dir>/.tmp/dataverse-architect-evidence.json'
INVENTORY_CACHE_PATH='<working_dir>/.tmp/dataverse-inventory-cache.json'

run_dataverse_planning_attempt() {
if ! node "${PLUGIN_ROOT}/scripts/create-dataverse-snapshot.js" \
  --env-url "$ACTIVE_ENV_URL" \
  --tenant-id "$ACTIVE_TENANT_ID" \
  --output "$SNAPSHOT_PATH" \
  --concepts-file "$CONCEPTS_PATH" \
  --tables "<EXPLICIT_TABLES>" \
  --proposed-tables "<PROPOSED_TABLES>" \
  --progressive-detail \
  --combined-base-read \
  --read-concurrency 1 \
  --inventory-cache "$INVENTORY_CACHE_PATH"; then
  printf 'NEEDS_RECOVERY: dataverse-snapshot\n' >&2
  return 2
fi

if ! node "${PLUGIN_ROOT}/scripts/render-dataverse-architect-evidence.js" \
  --snapshot "$SNAPSHOT_PATH" \
  --output "$ARCHITECT_EVIDENCE_PATH" \
  || ! node "${PLUGIN_ROOT}/scripts/render-dataverse-architect-evidence.js" \
    --snapshot "$SNAPSHOT_PATH" --output "$ARCHITECT_EVIDENCE_PATH" --validate-only; then
  printf 'NEEDS_RECOVERY: dataverse-evidence\n' >&2
  return 2
fi

node -e '
  const s=require(process.argv[1]);
  const t=s.timings;
  const d=s.detailLoadSummary;
  console.log(`✓ Dataverse inventory: ${s.inventoryFacts.customizableTables} customizable + ${s.inventoryFacts.exactNameTables} bounded exact-name discoveries (${s.inventoryFacts.requiredExactNameTables} required, ${s.inventoryFacts.proposedCollisionTables} proposed collisions) (${t.inventoryRetrievalMs} ms)`);
  console.log(`✓ Candidate selection: ${s.candidateRanking.length} concepts → ${d.attemptedCandidates} detailed (${d.primaryCandidates || 0} primary, ${d.ambiguityCandidates || 0} ambiguity, ${d.strongCollisionCandidates || 0} strong collision, ${d.deferredCandidates || 0} deferred; ${t.candidateSelectionMs} ms)`);
  console.log(`✓ Detail loading: ${d.loadedCandidates} loaded (${d.coreCandidates || 0} core, ${d.fullCandidates || 0} full), ${d.failedCandidates} failed; ${s.tables.reduce((n,x)=>n+x.facts.columnCount,0)} columns, ${s.tables.reduce((n,x)=>n+x.facts.relationshipCount,0)} relationships, ${s.tables.reduce((n,x)=>n+x.facts.keyCount,0)} keys (${t.detailLoadingMs} ms)`);
  console.log(`✓ Exact names: requested [${s.exactNameResolution.requestedTables.join(", ")}], loaded [${s.exactNameResolution.loadedTables.join(", ")}], unavailable [${s.exactNameResolution.unavailableTables.join(", ")}]`);
  console.log(`✓ Proposed names: ${s.proposedNameChecks.collisions.length} collisions, ${s.proposedNameChecks.missing.length} missing; foreground planning snapshot total ${t.totalDurationMs} ms`);
' "$SNAPSHOT_PATH" || return 2
echo "✓ Compact architect evidence: $ARCHITECT_EVIDENCE_PATH"
}
run_dataverse_planning_attempt
```

`--combined-base-read` loads attributes, three relationship collections, and
alternate keys through one entity-definition GET per selected table, following
any nested continuation links before normalization. Typed constraints, choices,
lookup targets, and computed metadata remain separate full-detail GETs.
`--read-concurrency 1` is the production default. Concurrency `2` through `8`
is an explicit operator choice only; metadata writes are never sent
through this read worker pool. The inventory cache stores inventory-level facts
only, has a five-minute TTL, fails open on corruption or identity mismatch, and
is never read by `--reconcile-exact`. After any metadata publish, invalidate it
with `dataverse-inventory-cache.js --file "$INVENTORY_CACHE_PATH" --invalidate`.

**Foreground recovery, not agent termination.** A nonzero command result or
`NEEDS_RECOVERY` returns control to the foreground agent. Keep working on the
failure; only dependent summaries, architect dispatch, approval, and mutation
wait for trustworthy evidence. This also applies to environment resolution,
token acquisition, transport access, broad inventory, exact-name identity
resolution, parsing, and evidence validation failures in this step.

- Diagnose the actual error, then repair recoverable project-local command,
  path, or concept-input mistakes. Let the request executor handle its bounded
  transient retries; do not launch parallel retry loops or repeat an unchanged
  permanent error. Invalid cached or old-format metadata is regenerated from
  live reads, never edited into apparent validity.
- After a targeted repair, rerun `run_dataverse_planning_attempt` (or
  rerun the block with that invocation if the shell function is unavailable).
  Allow at most two repair-and-retry attempts per failing stage. Re-resolve the
  selected environment first if resolution failed.
- Resume automatically only after the current attempt succeeds and its fresh
  snapshot and matching evidence validate. File existence is not success:
  prior artifacts can survive a failed atomic write. Never substitute stale
  evidence, invent metadata, change the selected account/environment, relax
  validation, or downgrade a requirement to make the check pass.
- Ask the user only when recovery needs interactive sign-in, missing privileges,
  an explicit scope decision, or the bounded repairs are exhausted. Preserve
  the working context and resume this stage after that blocker is resolved;
  a recoverable command failure alone is not terminal `BLOCKED`.
- Individual table-detail failures do not stop planning. Keep the snapshot,
  record each failure in `detailLoadFailures`, list it in the evidence
  appendix, and classify the affected exact or advisory table as `Defer` at
  the data model gate unless the user chooses a materially different business design.
- `Defer` is non-executable. the Apply data model step still requires fresh complete evidence for
  every approved `Reuse`, `Extend`, `Create`, or `Adapt` operation; unresolved
  metadata never authorizes a write.
- `--proposed-tables` performs collision checks only. Missing proposed names
  are not required-table failures and must never be selected for detail loading
  solely because they were proposed.

The snapshot script emits factual `DATAVERSE_SNAPSHOT_PROGRESS` lines after
inventory, candidate selection, and detail loading. Print them immediately;
never replace them with estimates or percentages. Once the architect starts,
watch `<working_dir>/.tmp/data-model-planning-status.json` and print each new
milestone ID once with its counts and elapsed time. The first environment or
snapshot milestone must be visible within 30 seconds. The foreground
orchestrator owns this rendering; the architect only owns the status artifact.

For `required`, pass `SNAPSHOT_PATH` and `ARCHITECT_EVIDENCE_PATH` verbatim to
the planner prompt and every direct `data-model-architect` fallback/revision.
The model reads the compact sidecar, not the full snapshot; deterministic tools
retain the full snapshot for hash binding and validation. A supplied matching
pair activates the architect's `snapshot-only` path: no Bash discovery and no
live Dataverse calls inside the agent. For `connector-only`, pass the mode
explicitly and state that both paths are not supplied; never provide placeholder
file paths.

#### Planner completion dispatch
