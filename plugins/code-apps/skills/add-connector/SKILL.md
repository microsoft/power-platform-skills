---
name: add-connector
description: Adds any Power Platform connector to a Power Apps code app. Generic fallback for connectors not covered by a specific skill.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, LSP, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion, Skill
model: sonnet
---

**📋 Shared Instructions: [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Cross-cutting concerns.

# Add Connector (Generic)

Fallback skill for any connector not covered by a specific `/add-*` skill. For common connectors, prefer the dedicated skills:

- `/add-dataverse` -- Dataverse tables
- `/add-azuredevops` -- Azure DevOps
- `/add-teams` -- Microsoft Teams
- `/add-excel` -- Excel Online (Business)
- `/add-onedrive` -- OneDrive for Business
- `/add-sharepoint` -- SharePoint Online
- `/add-office365` -- Office 365 Outlook (calendar, email, contacts)

## Workflow

1. Check Memory Bank → 2. Identify Connector → 3. Add Connector → 4. Inspect & Configure → 5. Build → 6. Update Memory Bank

---

### Step 1: Check Memory Bank

Check for `memory-bank.md` per [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md).

### Step 2: Identify Connector

**If `$ARGUMENTS` is provided or the caller already specified the connector**, use it directly and skip the question below.

Otherwise, ask the user which connector they want to add. Browse available connectors: [Connector Reference](https://learn.microsoft.com/en-us/connectors/connector-reference/)

**Before proceeding, check if the connector has a dedicated skill. If it does, delegate immediately and STOP:**

| Connector API name      | Delegate to        |
| ----------------------- | ------------------ |
| `sharepointonline`      | `/add-sharepoint`  |
| `teams`                 | `/add-teams`       |
| `excelonlinebusiness`   | `/add-excel`       |
| `onedriveforbusiness`   | `/add-onedrive`    |
| `azuredevops`           | `/add-azuredevops` |
| `office365`             | `/add-office365`   |
| `commondataservice`     | `/add-dataverse`   |

Invoke the appropriate skill with the same `$ARGUMENTS` and **do not continue this skill's workflow**.

Common connector API names:

- `sharepointonline`, `teams`, `excelonlinebusiness`, `onedriveforbusiness`
- `azuredevops`, `azureblob`, `azurequeues`
- `office365`, `office365users`, `office365groups`
- `sql`, `commondataservice`

### Step 3: Add Connector

**First, find the connection ID** (see [connector-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/connector-reference.md)):

Run the `/list-connections` skill. Find the connector in the output. If none exists, direct the user to create one using the environment-specific Connections URL — construct it from the active environment ID in context (from `power.config.json` or a prior step): `https://make.powerapps.com/environments/<environment-id>/connections` → **+ New connection** → search for the connector → Create.

```bash
# Non-tabular connectors (Teams, Azure DevOps, etc.)
pwsh -NoProfile -Command "pac code add-data-source -a <connector-api-name> -c <connection-id>"

# Tabular connectors (SharePoint, Excel, SQL, etc.) -- also need dataset and table
pwsh -NoProfile -Command "pac code add-data-source -a <connector-api-name> -c <connection-id> -d '<dataset>' -t '<table>'"
```

**Parameter reference:**

- `-a` (apiId) -- connector name (e.g., `sharepointonline`, `teams`)
- `-c` (connectionId) -- **required** for all non-Dataverse connectors. Get from `/list-connections`.
- `-d` (dataset) -- required for tabular datasources (e.g., SharePoint site URL, SQL database). Not needed for Dataverse.
- `-t` (table) -- table/list name for tabular datasources (e.g., SharePoint list, Dataverse table logical name)

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

```powershell
npm run build
```

Fix TypeScript errors before proceeding. Do NOT deploy yet.

### Step 6: Update Memory Bank

Update `memory-bank.md` with: connector added, configured operations, build status.
