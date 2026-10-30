---
name: add-connector
description: Adds any Power Platform connector to a Power Apps code app. Generic fallback for connectors not covered by a specific skill.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, LSP, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion, Skill
model: sonnet
---

**📋 Shared Instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** - Cross-cutting concerns.

# Add Connector (Generic)

Fallback skill for any connector not covered by a specific `/add-*` skill. For common connectors, prefer the dedicated skills:

- `/add-dataverse` -- Dataverse tables
- `/add-azuredevops` -- Azure DevOps
- `/add-teams` -- Microsoft Teams
- `/add-excel` -- Excel Online (Business)
- `/add-onedrive` -- OneDrive for Business
- `/add-sharepoint` -- SharePoint Online
- `/add-office365` -- Office 365 Outlook (calendar, email, contacts)
- `/add-workiq` -- Work IQ (M365 Copilot Search)

## Workflow

1. Check Memory Bank → 2. Identify Connector → 3. Add Connector → 4. Inspect & Configure → 5. Build → 6. Update Memory Bank

---

### Step 1: Check Memory Bank

Check for `memory-bank.md` per [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md).

### Step 2: Identify Connector

**If `$ARGUMENTS` is provided or the caller already specified the connector**, use it directly and skip the question below.

Otherwise, ask the user which connector they want to add. Browse available connectors: [Connector Reference](https://learn.microsoft.com/en-us/connectors/connector-reference/)

**Before proceeding, check if the connector has a dedicated skill. If it does, delegate immediately and STOP:**

| Connector API name          | Delegate to        |
| --------------------------- | ------------------ |
| `shared_a365copilotchatmcp` | `/add-workiq`      |
| `sharepointonline`          | `/add-sharepoint`  |
| `teams`                     | `/add-teams`       |
| `excelonlinebusiness`       | `/add-excel`       |
| `onedriveforbusiness`       | `/add-onedrive`    |
| `visualstudioteamservices`  | `/add-azuredevops` |
| `office365`                 | `/add-office365`   |
| `commondataservice`         | `/add-dataverse`   |

Match the API name with or without the `shared_` prefix (`pa connector list` shows it with the prefix, e.g. `shared_teams`).

Invoke the appropriate skill with the same `$ARGUMENTS` and **do not continue this skill's workflow**.

Common connector API names:

- `sharepointonline`, `teams`, `excelonlinebusiness`, `onedriveforbusiness`
- `visualstudioteamservices` (Azure DevOps), `azureblob`, `azurequeues`
- `office365`, `office365users`, `office365groups`
- `sql`, `commondataservice`

### Step 3: Add Connector

Get the connection as described in [connector-reference.md](${PLUGIN_ROOT}/shared/connector-reference.md#connections). On CLI 1.3.0+ (`PA_INLINE_CONNECTIONS=yes`), tell the user a connection may be created with their account, run the add without `-c` and with `--non-interactive`, and handle the result with the outcome table there. On older CLIs, run `/list-connections` first to find the connection ID (if none exists, create one with `pa connection create` as described in connector-reference.md) and pass `-c <connection-id>`.

```bash
# CLI 1.3.0+, connectors that only have actions (Teams, Office 365 Outlook, Azure DevOps, ...):
# the CLI finds or creates the connection
pa app add data-source --connector <connector-api-name> --non-interactive

# CLI 1.3.0+, connectors that also support tables (SharePoint, SQL Server, Excel): choose
# --as action (or a table, below). Without either, --non-interactive fails on the missing choice.
pa app add data-source --connector <connector-api-name> --as action --non-interactive

# Older CLIs: pass the connection ID
pa app add data-source --connector <connector-api-name> -c <connection-id>

# Tables (SharePoint, Excel, SQL, etc.) on any CLI: dataset and table, plus the connection ID used to find them
pa app add data-source --connector <connector-api-name> -c <connection-id> -d '<dataset>' --table '<table>'
```

To check whether a connector also supports tables, read `isTabular` from `pa connector list --search '<connector name>' --json`.

Finding a table's dataset and name (`pa connection list-datasets` / `list-tables`) needs a connection ID: unlike `add data-source`, these commands don't find or create connections, and without `-c` they fail in non-interactive mode. So for tables, look the connection up first, even on CLI 1.3.0+ (`pa connection list --search <connector-api-name> --json`).

**Parameter reference:**

- `--connector` (apiId) -- connector name (e.g., `sharepointonline`, `teams`). On the flat `power-apps` binary this is `--api-id`/`-a`.
- `-c` (connectionId) -- required on CLIs older than 1.3.0. On 1.3.0+ it's optional: without it the CLI reuses or creates the connection (see connector-reference.md). Get IDs from `/list-connections`.
- `-d` (dataset) -- required for tabular datasources (e.g., SharePoint site URL, SQL database). Not needed for Dataverse.
- `--table` (table) -- table/list name for tabular datasources (e.g., SharePoint list, Dataverse table logical name). On the flat `power-apps` binary this is `--resource-name`/`-t`.
- `--as` -- `table` or `action`, for connectors that support both (CLI 1.2.0+). Use `--as action` to add the connector's actions instead of a table.
- `--use-sso` -- use a single sign-on connection (CLI 1.3.0+). Ask the user first; see connector-reference.md.
- `--non-interactive` -- the CLI never prompts; it fails with a message that says what's missing instead. Pass it on every add on CLI 1.3.0+: if the CLI runs in a real terminal, it would otherwise show prompts the agent can't answer, such as the connection picker when `-c` is omitted.

### Step 4: Inspect & Configure

After adding, inspect the generated files. **Generated service files can be very large** -- use `Grep` to find specific methods instead of reading the entire file:

```
Grep pattern="async \w+" path="src/generated/services/<Connector>Service.ts"
```

Files to check:

- `src/generated/services/<Connector>Service.ts` -- available operations and their parameters
- `src/generated/models/<Connector>Model.ts` -- TypeScript interfaces (if generated)
- `.power/schemas/<connector>/` -- connector schema and configuration

For each method the user needs:

1. Grep for the method name to find its signature
2. Read just that method's section (use `offset` and `limit` parameters on Read)
3. Identify required vs optional parameters and response type

Help the user write code using the generated service methods.

### Step 5: Build

```bash
npm run build
```

Fix TypeScript errors before proceeding. Do NOT deploy yet.

### Step 6: Update Memory Bank

Update `memory-bank.md` with: connector added, configured operations, build status.
