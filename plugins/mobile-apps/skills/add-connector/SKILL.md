---
name: add-connector
description: Use when the user wants to add a Power Platform connector to a mobile app and there is no dedicated /add-* skill for that connector (Dataverse and SharePoint have their own skills).
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, Skill
model: sonnet
---

**📋 Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** | **Connector reference: [connector-reference.md](${CLAUDE_SKILL_DIR}/../../shared/connector-reference.md)** — read both first.

# Add Connector (Generic)

Fallback skill for any connector not covered by a dedicated `/add-*` skill. For common connectors, prefer the dedicated skills:

- `/add-dataverse` — Dataverse tables
- `/add-sharepoint` — SharePoint Online

(More dedicated skills will land in v1: `/add-teams`, `/add-excel`, `/add-onedrive`, `/add-azuredevops`, `/add-office365`.)

The native host runtime (`power-apps-native-host`) handles connector routing, connection resolution, and OAuth consent through `PowerAppsHostProvider` in `app/_layout.tsx` — no separate executor wiring is needed.

## Workflow

1. Check Memory Bank → 2. Identify Connector → 3. Add Connector → 4. Inspect & Configure → 5. Build → 6. Update Memory Bank

---

### Step 1 — Check Memory Bank

Check for `memory-bank.md` per [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md).

Also confirm we're inside a Power Apps mobile app:

```bash
test -f power.config.json && test -f app.config.js
```

If either is missing, instruct the user to run `/create-mobile-app` first and stop.

### Step 2 — Identify Connector

**If `$ARGUMENTS` is provided or the caller already specified the connector**, use it directly and skip the question below.

Otherwise, ask the user which connector they want to add. Browse available connectors: [Connector Reference](https://learn.microsoft.com/en-us/connectors/connector-reference/).

**Before proceeding, check if the connector has a dedicated skill. If it does, delegate immediately and STOP:**

| Connector API name      | Delegate to        |
| ----------------------- | ------------------ |
| `sharepointonline`      | `/add-sharepoint`  |
| `commondataservice`     | `/add-dataverse`   |

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

To remove a flow later:

```bash
npx power-apps remove-flow --flow-id <flow-guid> --non-interactive
```

After `add-flow`, continue at Step 4 and inspect the generated service/model files the same way as connector data sources.

### Step 3 — Add Connector

**First, get the connection ID or connection reference** (see [connector-reference.md](${CLAUDE_SKILL_DIR}/../../shared/connector-reference.md)):

Run the `/list-connections` skill with the connector API ID (for example `shared_office365users`). Capture the exact `connectionId` from `create-connection`, or the `connectionRef` from `list-connection-references` if the caller is solution-aware. If creation cannot complete in the CLI, direct the user to create one using the environment-specific Connections URL — construct it from the active environment ID in context (from `power.config.json` `environmentId` or a prior step):
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

**For Dataverse actions/functions rather than tables, discovery is available but this plugin only adds Dataverse table CRUD:**

```bash
npx power-apps find-dataverse-api --search '<operation-name>' --json
```

Surface the matching operation metadata and STOP with a clear note that this plugin can add Dataverse table CRUD through `/add-dataverse`, but does not add Dataverse actions/functions.

If the user actually needs Dataverse table CRUD, stop and delegate to `/add-dataverse`; do not add Dataverse tables from this generic connector skill.

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

Help the user write code using the generated service methods.

### Step 5 — Build

**Print before starting:**
> "→ Regenerating connector schemas + running tsc to verify the new connector wires in cleanly (~10–20 seconds)."

`npx power-apps add-data-source` (Step 3) wrote new files into `.power/schemas/<connector>/`. The `connectorSchemas.ts` consumed by `app/_layout.tsx` is now stale — regenerate it before type-checking so the new connector is wired into the runtime schema map:

```bash
npm run generate-schemas
npx tsc --noEmit
```

Fix TypeScript errors before proceeding. Common gotcha: the new generated service may import a peer dependency you don't have installed yet — if so, `npx expo install <missing-package>` (NOT plain `npm install`, so versions stay Expo-compatible).

Do NOT deploy yet — that's `/deploy`'s job after all data sources are added.

### Step 6 — Update Memory Bank

Update `memory-bank.md` with: connector added, configured operations, build status.

## Remove a data source or flow

If the user asks to remove a connector/table/stored procedure that this skill added, use the matching Power Apps CLI command with explicit arguments:

```bash
npx power-apps delete-data-source --api-id <apiId> --data-source-name '<data-source-or-table-name>' --non-interactive
npx power-apps delete-data-source --api-id shared_sql --data-source-name '<procedure>' --sql-stored-procedure '<procedure>' --non-interactive
npx power-apps remove-flow --flow-id <flow-guid> --non-interactive
```

Then run `npm run generate-schemas` and `npx tsc --noEmit` before reporting success.

## Runtime connector handling

The native host runtime handles all connector routing automatically via `PowerAppsHostProvider` in `app/_layout.tsx`. When a screen calls a generated service method:

1. `PowerAppsHostProvider` resolves the connection from `connectionReferences` in `power.config.json`
2. If the connection requires OAuth consent, `ConnectionSetupScreen` is shown automatically
3. `NativePowerAppsBridge` dispatches the call with the correct auth token

No separate executor or provider wiring is needed — Dataverse and non-Dataverse connectors use the same unified pipeline.

## Notes

- Generated files in `src/generated/` are produced directly by `npx power-apps add-data-source`. Differences in behavior come from runtime wiring in this mobile plugin.
- This skill never modifies `app.config.js` or `playerConfig.ts` — connector discovery is dynamic at runtime.
