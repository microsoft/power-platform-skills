# Retiring an app data source

Use this reference when an approved edit removes or replaces an app's Dataverse
table binding, connector data source, SQL procedure, or cloud-flow binding.
Follow [app-edit-routing.md](app-edit-routing.md) first. Removing a source from
the app does not authorize deleting the server table, its columns/records, a
connection, a solution component, or the cloud flow itself.

## Removal is not schema-map generation

The template's `npm run generate-schemas` rebuilds the runtime connector schema
map. It does not infer unused tables from screen code, unregister sources, or
replace the Power Apps CLI's service/model generation.

The supported inverse of `add-data-source` is `delete-data-source`. The CLI
removes the source's schema registration, updates `power.config.json`, and
regenerates models/services from the remaining schemas. Follow it with
`npm run generate-schemas` to update the mobile runtime map.

For a source that remains in use but whose server schema changed, use the CLI's
`refresh-data-source` instead. Hiding a field or dropping it from a screen spec
does not mean deleting its server column or unregistering the whole table.

```bash
npx --no-install power-apps refresh-data-source --data-source-name '<registered-name>' --non-interactive
npm run generate-schemas
npx tsc --noEmit
```

Refresh only the approved retained source. Inspect per-source failure output as
well as generated artifacts; an exit code alone is not a refresh success check.

Sources: [Power Apps CLI reference](https://learn.microsoft.com/power-apps/developer/code-apps/reference/cli#pa-app-remove-data-source)
and [connecting to data](https://learn.microsoft.com/power-apps/developer/code-apps/how-to/connect-to-data#add-a-connection-to-a-code-app).
The grouped code-apps equivalent is `pa app remove data-source --connector ... --name ...`;
the mobile workflow below uses the template's flat `power-apps` binary.

## 1. Plan the removal, do not infer permission from absence

Before the owner writes the new plan, compare the old and proposed Data Model,
Connectors, Screens, and Generated Services sections with the actual local
configuration/schemas. Classify each source as retain, add, refresh, or
candidate removal. A missing row in a planner's output is a candidate, not consent.

For each candidate, resolve the exact stored data-source name, API ID, and
dataset/procedure/flow identity from `power.config.json` and `.power/schemas/`.
A display label, table logical name, and generated class name need not match.
Preserve original spelling; do not guess a CLI selector from a screen title.

Inspect remaining screens, navigation, hooks, shared helpers, native upload/sync
wrappers, lookup/identity reads, and offline requirements. Search imports and
actual service calls, not just table names in screen files. A source used only by
an identity helper, relationship lookup, or background tracker is still used.
Dynamic or ambiguous usage is a blocker to automatic removal, not proof of disuse.

Present the candidate list, dependent app files to change, and preserved server
data in the owner's mutation preview. Require explicit approval. Never mutate
configuration/generated files during planning or `--plan-only`.

## 2. Retire consumers before unregistering

The app owner adds/refreshes replacement sources first, then updates or removes
the approved consumers and verifies they no longer depend on the retiring source.
Keep the old binding available until those source edits are complete.

Only then call the appropriate leaf in removal mode, with the exact approved
removal list and `MOBILE_APP_ORCHESTRATING=1` context. A leaf call must not mix
addition and removal; do not run the normal add workflow or create a connection
before removing one. Implementation-only removal must stop if consumers remain.
Use the skill-only `--remove` argument or explicit removal intent to select this
branch; do not pass `--remove` to the Power Apps CLI.
If a replacement collides with the old registration and cannot be staged safely,
return the conflict to the owner for an explicit migration plan.

## 3. Execute only the approved app-local removal

Use the installed CLI from the app root. Confirm its removal options with
`npx --no-install power-apps delete-data-source --help` (or `remove-flow --help`)
if the installed surface differs. Do not fetch another CLI version as a fallback.

After approval, `--force` acknowledges the CLI's destructive-action prompt;
`--non-interactive` alone is not removal consent. The template-pinned CLI supports:

```bash
# Dataverse: use the registered data-source key, not a guessed display label.
npx --no-install power-apps delete-data-source --api-id dataverse --data-source-name '<registered-name>' --force --non-interactive

# Connector/table registration.
npx --no-install power-apps delete-data-source --api-id '<apiId>' --data-source-name '<registered-name>' --force --non-interactive

# SQL procedure: also use the exact stored procedure identity from its schema.
npx --no-install power-apps delete-data-source --api-id shared_sql --data-source-name '<registered-name>' --sql-stored-procedure '<procedure>' --force --non-interactive

# Removes the app binding, not the server flow.
npx --no-install power-apps remove-flow --flow-id '<flow-id>' --force --non-interactive
```

Run sequentially: each operation can regenerate the shared model/service output.
Do not manually delete `src/generated/` files, schema registrations, or
`power.config.json` entries to imitate the command.

**Scope preflight matters.** In the template-pinned CLI (0.15.3), non-Dataverse
cleanup matches source names across connection references and prunes empty
references. Before removal, check for same-named registrations in other
connectors/datasets and empty references used by remaining flows. If the command
could remove anything outside the approved scope, stop and report the CLI
limitation; do not run it and hope to repair collateral changes afterward.
Retain shared connection references and sources still needed by another consumer.

## 4. Verify the outputs, not just the exit code

Compare against the pre-removal inventory after every command:

- The exact source is absent from its `.power/schemas/` registration and from
  `databaseReferences` or `connectionReferences`/`dataSets` in `power.config.json`.
- Retired source-specific generated services/models and exports are no longer
  present. Shared helpers/models and remaining registrations still exist.
- App identity, environment, unrelated bindings, and flow dependencies are
  unchanged. Empty reference containers may be removed by the CLI only when
  nothing retained depends on them.

The flat CLI can return exit 0 for a not-found/no-op removal. Missing selectors,
unchanged registrations, stale generated outputs, or unexpected deletions are
failures to resolve, not success. Stop on a partial result, record what changed,
and recover through supported CLI operations with the owner; never hand-edit
generator-owned files or continue to deployment.

After verified removal:

```bash
npm run generate-schemas
npx tsc --noEmit
```

Confirm the runtime schema map excludes the retired source, including when the
last source was removed. Do not fabricate an empty map to hide a generator error.
Return manual `writtenFiles` separately from CLI/generator-owned outputs.

## 5. Reconcile the app inventory

Refresh the owner's Generated Services snapshot after removal. Update the
app-local `.datamodel-manifest.json` only after verifying the remaining Dataverse
services; remove retired app-inventory entries while preserving verified facts
for retained tables. If no Dataverse bindings remain, retain a valid empty
`tables` array rather than stale entries. Preserve historical ownership facts in
the existing history; this inventory update is not server schema deletion.
Do not reuse old plan-bound operation manifests or approval receipts to recreate
retired sources.

Check `offline-profile.json` before retiring an offline dependency. The existing
`offline-profile-delta.js` detects additions, not excess profile tables; `in-sync`
does not prove removal reconciliation. Profile items/associations can be shared
and are server configuration: do not silently remove them or edit the local
snapshot to pretend the server changed. Keep required bindings, or obtain a
separate approved profile migration; report any intentionally retained profile
coverage and unresolved offline work.

Update memory-bank with removed/retained sources, verification, and any partial
failure. In orchestrated mode return to the owner for final validation/preview.
