# Foreground Dataverse snapshot and bounded evidence

Load only for required Dataverse planning, including revisions that request exact-name expansion.
The snapshot is evidence, not permission to write. Connector-only runs skip all commands here.

Resolve the approved environment in foreground using `scripts/resolve-environment.js`;
require a nonempty resolved Dataverse URL and tenant. Do not make a child rediscover them.
Build `<DATAVERSE_CONCEPTS>` from **every domain noun and workflow family** in the confirmed brief,
preserving multiword/header-child families. Add required-existing/standard names to
`<EXPLICIT_TABLES>` and stable proposed custom names to `<PROPOSED_TABLES>` for collision checks.
Do not invent names for unsettled concepts.

The existing snapshot helper owns normalized evidence and candidate selection: full inventory,
required exact-name details outside advisory capacity, no speculative alternatives for exact-covered
concepts, best candidate for every unresolved concept, then at most 3 advisory candidates/concept
with a target of 40 unique advisory tables. Exceed 40 only to preserve one per unresolved concept.

```bash
SNAPSHOT_PATH="<working_dir>/.tmp/dataverse-foreground-planning-snapshot.json"
EVIDENCE_PATH="<working_dir>/.tmp/dataverse-planning-evidence.md"
node "${PLUGIN_ROOT}/scripts/create-dataverse-snapshot.js" \
  --env-url "$ACTIVE_ENV_URL" --tenant-id "$ACTIVE_TENANT_ID" \
  --output "$SNAPSHOT_PATH" --concepts "<DATAVERSE_CONCEPTS>" \
  --tables "<EXPLICIT_TABLES>" --proposed-tables "<PROPOSED_TABLES>"
node "${PLUGIN_ROOT}/scripts/render-dataverse-planning-evidence.js" \
  --snapshot "$SNAPSHOT_PATH" --output "$EVIDENCE_PATH"
```

Print factual `DATAVERSE_SNAPSHOT_PROGRESS` lines immediately. Surface actual inventory,
candidate/detail attempted/loaded/failed counts, exact requested/loaded/unavailable names,
proposed collisions/missing names and measured timings from the normalized snapshot.
Keep the first available environment/snapshot milestone visible promptly; never fabricate one
to meet a timing expectation. While the architect runs, print each new milestone ID in
`.tmp/data-model-planning-status.json` once with its recorded counts/elapsed time.
If a host only returns final output, surface that limitation, not simulated live progress.

Environment/token/inventory/required exact metadata/detail/parsing/evidence failure is
`BLOCKED: Dataverse planning metadata unavailable for exact target decisions`.
Do not treat unreadable data as empty inventory or send an unresolved Unverified contract to
mutation. Advisory detail failures remain recorded in `detailLoadFailures` and the appendix;
they do not fail required exact targets. Proposed missing names are collision results only,
not missing required tables and not automatic detail candidates.

**Dataverse planning forwarding is verbatim.** Forward the same absolute snapshot/evidence paths
unchanged to every architect dispatch/revision.
Snapshot-only means no live OData, environment resolution or Bash discovery inside the child.
See [dataverse-planning-benchmark.md](dataverse-planning-benchmark.md) for fixture evaluation.

## Exact-name expansion (once)

On `NEEDS_CONTEXT: detailed-dataverse-metadata:<logical names>`, require a validated required-mode
base snapshot. Sort/deduplicate names; reuse inventory, at most one bounded exact-name metadata
query for absent names; never rerun broad inventory.

```bash
node "${PLUGIN_ROOT}/scripts/create-dataverse-snapshot.js" \
  --env-url "$ACTIVE_ENV_URL" --tenant-id "$ACTIVE_TENANT_ID" \
  --base-snapshot "$SNAPSHOT_PATH" --output "$SNAPSHOT_PATH" \
  --tables "<exact comma-separated logical names>"
node "${PLUGIN_ROOT}/scripts/render-dataverse-planning-evidence.js" \
  --snapshot "$SNAPSHOT_PATH" --output "$EVIDENCE_PATH"
```

Print requested/loaded/unavailable names and measured expansion timing, then redispatch once
with unchanged paths. A second detailed-metadata request is BLOCKED, never deferred to mutation.

## Proposed-name expansion (once, independently)

On `NEEDS_CONTEXT: proposed-dataverse-names:<logical names>`, require the same validated base.
Sort/deduplicate names and perform one collision-only expansion:

```bash
node "${PLUGIN_ROOT}/scripts/create-dataverse-snapshot.js" \
  --env-url "$ACTIVE_ENV_URL" --tenant-id "$ACTIVE_TENANT_ID" \
  --base-snapshot "$SNAPSHOT_PATH" --output "$SNAPSHOT_PATH" \
  --proposed-tables "<exact comma-separated logical names>"
node "${PLUGIN_ROOT}/scripts/render-dataverse-planning-evidence.js" \
  --snapshot "$SNAPSHOT_PATH" --output "$EVIDENCE_PATH"
```

Missing proposals are not required-table failures and do not trigger detail reads. Redispatch
once; a second proposed-name request is BLOCKED. A collision needing compatibility facts may
use the separate one-time detailed-metadata expansion. Either signal in connector-only is BLOCKED.
