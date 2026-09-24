---
name: add-connector
description: Use when adding a Power Platform connector to an Expo/React Native Power Apps mobile app and no dedicated mobile connector skill exists.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, Skill
model: sonnet
---

**📋 Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** | **Connector reference: [connector-reference.md](${PLUGIN_ROOT}/shared/connector-reference.md)** — read both first.

# Add Connector (Generic)

**Entry routing:** use the shared [App feature entry points](../../shared/shared-instructions.md#app-feature-entry-points)
preflight before the workflow below.

Action connectors and cloud flows do not imply Dataverse Data Model changes.

**Removal branch:** after entry routing, if `--remove` or the approved scope
requests removal, execute
[data-source-removal.md](../../shared/references/data-source-removal.md) and return.
Do not run Steps 1-6, connection creation, or `add-data-source` for a removal.

**Refresh branch:** after entry routing, `--refresh` or an approved retained-source
refresh executes [Refresh a retained source](../../shared/references/data-source-removal.md#refresh-a-retained-source)
and returns before Steps 1-6. Preserve the exact `--data-source-name` and approved
binding identity; do not create connections or run `add-data-source`.

Fallback skill for any connector not covered by a dedicated `/add-*` skill. For common connectors, prefer the dedicated skills:

- `/add-dataverse` — Dataverse tables
- `/add-sharepoint` — SharePoint Online

(More dedicated skills will land in v1: `/add-teams`, `/add-excel`, `/add-onedrive`, `/add-azuredevops`, `/add-office365`.)

The native host runtime (`@microsoft/power-apps-native-host`) handles connector routing, connection resolution, and OAuth consent through `PowerAppsProvider` in `app/_layout.tsx` — no separate executor wiring is needed.

## Workflow

1. Check Memory Bank → 2. Identify Connector → 3. Add Connector → 4. Inspect & Configure → 5. Build → 6. Update Memory Bank

---

### Step 1 — Check Memory Bank

**Telemetry checkpoint: `validate_connector_project`**

Check for `memory-bank.md` per [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md).

Also confirm we're inside a Power Apps mobile app:

```bash
test -f power.config.json && test -f app.config.js
```

If either is missing, instruct the user to run `/create-mobile-app` first and stop.

### Step 2 — Identify Connector

**Telemetry checkpoint: `resolve_connector_request`**

**If `$ARGUMENTS` is provided or the caller already specified the connector**, use it directly and skip the question below.

Otherwise, ask the user which connector they want to add. Browse available connectors: [Connector Reference](https://learn.microsoft.com/en-us/connectors/connector-reference/).

Classify the requested operation before matching the delegation table. Dataverse
actions/functions follow the discovery-only branch below directly, skipping
connection lookup and data-source generation, never the table CRUD workflow.
If the operation is ambiguous, ask before delegating.
Use aliases only for routing; pass the exact discovered API ID to CLI commands.

**Dataverse actions/functions: discover and return here.**

```bash
npx --no-install power-apps find-dataverse-api --search '<operation-name>' --json
```

Surface the matching metadata and STOP this leaf with a clear note that this
plugin adds Dataverse table CRUD, not actions/functions. Do not enter Step 3,
invoke `/list-connections`, or generate a table service on this branch.
If the user actually needs table CRUD, use the delegation table below.

**Then check if this operation has a dedicated skill. If it does, delegate and STOP:**

| Connector API name      | Delegate to        |
| ----------------------- | ------------------ |
| `sharepointonline`, `shared_sharepointonline` | `/add-sharepoint` |
| `dataverse`, `commondataservice`, `shared_commondataservice`, `commondataserviceforapps`, `shared_commondataserviceforapps` (table CRUD only) | `/add-dataverse` |

Invoke the appropriate skill with the same `$ARGUMENTS` and **do not continue this skill's workflow**.

Common connector API names:

- `sharepointonline`, `teams`, `excelonlinebusiness`, `onedriveforbusiness`
- `azuredevops`, `azureblob`, `azurequeues`
- `office365`, `office365users`, `office365groups`
- `sql`, `commondataservice`

**Cloud flows are supported by the Power Apps CLI, but they are not connector data sources.** If the user wants to invoke an existing Power Automate cloud flow from the app, use the flow-specific commands instead of `add-data-source`:

```bash
npx power-apps list-flows --search '<flow-name-or-keyword>' --json
npx power-apps add-flow --flow-id <flow-guid> --non-interactive
```

To remove a flow later, use the removal branch, which verifies consumers and
approval before the CLI removes the app binding.

After `add-flow`, continue at Step 4 and inspect the generated service/model files the same way as connector data sources.

### Step 3 — Add Connector

**Telemetry checkpoint: `generate_connector_data_source`**

**First, preserve or resolve the connection binding** using
[connector-reference.md](../../shared/connector-reference.md#step-1--get-a-connection):

- Supplied `--connection-id` (or approved caller `connectionId`): reuse that exact
  ID for the confirmed connector/environment; skip `/list-connections` and creation.
- Supplied `--connection-ref` (or approved caller `connectionRef`): preserve that
  reference for generation; skip `/list-connections` and creation. Do not replace
  it with a newly selected ID.
- Missing binding only: invoke `/list-connections` with the connector API ID
  and current scoped context to resolve the missing value. Conflicting, blank,
  or ambiguous supplied values return to the owner instead of creating a fallback.

The commands below show the connection-ID path. For a reference binding,
replace `--connection-id <connectionId>` with
`--connection-ref '<connectionRef>'` on `add-data-source` only. Reuse supplied
dataset/table/procedure choices and skip their discovery. If discovery is still
needed and requires an ID, obtain the backing ID for the approved reference or
the missing concrete choices; do not create another connection or pass an
unsupported reference flag to a picker command.

If creation was needed but cannot complete in the CLI, direct the user to the
environment-specific Connections URL from `power.config.json` `environmentId`:
`https://make.powerapps.com/environments/<environment-id>/connections` → **+ New connection** → search for the connector → Create.

**Classify the connector before running `add-data-source`:**

| Connector shape | Examples | Required discovery | Add command |
| --- | --- | --- | --- |
| Action-style connector | Teams, Office 365 Users, Outlook, Azure DevOps | None after connection lookup | `npx power-apps add-data-source --api-id <apiId> --connection-id <connectionId>` |
| Table-based connector | Excel Online, OneDrive for Business, Azure Blob, SQL, SharePoint if not delegated | `list-datasets`, then `list-tables` | `npx power-apps add-data-source --api-id <apiId> --connection-id <connectionId> --dataset '<dataset>' --resource-name '<table>'` |
| SQL stored procedure | SQL Server | `list-datasets`, then `list-sqlStoredProcedures` if needed | `npx power-apps add-data-source --api-id shared_sql --connection-id <connectionId> --dataset '<database>' --sql-stored-procedure '<procedure>'` |

**For action-style connectors, print before starting:**
> "→ Running `npx power-apps add-data-source` for <connector>. ~10–30 seconds (writes generated services + connector schemas)."

Then run:

```bash
npx power-apps add-data-source --api-id <apiId> --connection-id <connectionId>
```

**For table-based connectors, discover datasets and tables first:**

```bash
npx power-apps list-datasets --api-id <apiId> --connection-id <connectionId> --json
npx power-apps list-tables --api-id <apiId> --connection-id <connectionId> --dataset '<dataset>' --json
```

Present the datasets/tables to the user if they did not specify them. Add one data source per selected table:

```bash
npx power-apps add-data-source --api-id <apiId> --connection-id <connectionId> --dataset '<dataset>' --resource-name '<table>'
```

**For SQL stored procedures, discover procedures only when the user asks to invoke a stored procedure rather than a table:**

```bash
npx power-apps list-sqlStoredProcedures --connection-id <connectionId> --dataset '<database>' --json
npx power-apps add-data-source --api-id shared_sql --connection-id <connectionId> --dataset '<database>' --sql-stored-procedure '<procedure>'
```

**Parameter reference:**

- `--api-id` / `-a` — connector API ID (often `shared_<connector>`, e.g., `shared_office365users`). Use the exact value provided by the caller or connector docs.
- `--connection-id` / `-c` — required for non-Dataverse connectors unless using `--connection-ref`. Get from `create-connection`, the maker portal, or caller context.
- `--connection-ref` / `-cr` — optional connection reference name when adding into a solution-aware app.
- `--dataset` / `-d` — required for table-based datasources (for example SharePoint site URL, Excel file/location, SQL database).
- `--resource-name` / `-t` — table/list/resource name for table-based datasources.
- `--sql-stored-procedure` / `-sp` — SQL stored procedure name when adding a stored procedure instead of a table.
- `--non-interactive` — use only on commands whose required options are fully supplied and whose implementation supports non-interactive omission of optional prompts. Do not add `--environment-id` to app-root verbs once `power.config.json` exists.
- `--solution-id` / `-s` — optional solution identifier when the data source should be added to a specific solution.

### Step 4 — Inspect & Configure

After adding, inspect the generated files. **Generated service files can be very large** — use `Grep` to find specific methods instead of reading the entire file:

```
Grep pattern="async \w+" path="src/generated/services/<Connector>Service.ts"
```

Files to check:

- `src/generated/services/<Connector>Service.ts` — available operations and their parameters
- `src/generated/models/<Connector>Model.ts` — TypeScript interfaces (if generated)
- `.power/schemas/<connector>/` — connector schema and configuration

For each method the user needs:

1. Grep for the method name to find its signature
2. Read just that method's section (use `offset` and `limit` parameters on Read)
3. Identify required vs optional parameters and response type

Return the needed method signatures and integration notes to the orchestrator.
Screen implementations belong to `/edit-app` or `/create-mobile-app`; in
implementation-only mode provide usage guidance without changing screens.

### Step 5 — Build

**Telemetry checkpoint: `validate_connector_integration`**

**Print before starting:**
> "→ Regenerating connector schemas + running tsc to verify the new connector wires in cleanly (~10–20 seconds)."

`npx power-apps add-data-source` (Step 3) wrote new files into `.power/schemas/<connector>/`. The `connectorSchemas.ts` consumed by `app/_layout.tsx` is now stale — regenerate it before type-checking so the new connector is wired into the runtime schema map:

```bash
npm run generate-schemas
npx tsc --noEmit
```

Fix TypeScript errors before proceeding. If a generated service requires a missing
dependency, inspect its package contents before choosing a repair. Do not install
native packages absent from the template. Return a JS-only dependency requirement
to the orchestrator for the approved exact-version
[JavaScript dependency plan](../../shared/references/javascript-dependency-planning.md);
in implementation-only mode obtain that approval before installation. Do not
install an unplanned package merely to silence TypeScript.

Do NOT deploy yet — that's `/deploy`'s job after all data sources are added.

### Step 6 — Update Memory Bank

Update `memory-bank.md` with: connector added, configured operations, build status.

## Remove a data source or flow

Apply the entry routing first for removals too. `/edit-app` must identify consuming
screens/services and approve their update or removal before deleting a dependency;
implementation-only removal must stop if it would leave broken consumers.

Read and execute
[data-source-removal.md](../../shared/references/data-source-removal.md) for the
supported command, scope preflight, generated/config cleanup checks, and
inventory reconciliation. This also covers sources originally added outside
this skill; use the actual registered identity rather than assuming its name.

## Runtime connector handling

The native host runtime handles all connector routing automatically via `PowerAppsProvider` in `app/_layout.tsx`. When a screen calls a generated service method:

1. `PowerAppsProvider` resolves the connection from `connectionReferences` in `power.config.json`
2. If the connection requires OAuth consent, `ConnectionSetupScreen` is shown automatically
3. `NativePowerAppsBridge` dispatches the call with the correct auth token

No separate executor or provider wiring is needed — Dataverse and non-Dataverse connectors use the same unified pipeline.

## Notes

- Generated files in `src/generated/` are produced directly by `npx power-apps add-data-source`. Differences in behavior come from runtime wiring in this mobile plugin.
- This skill never modifies `app.config.js` or `playerConfig.ts` — connector discovery is dynamic at runtime.
