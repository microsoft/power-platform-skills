---
name: add-dataverse
description: Adds Dataverse tables to a Power Apps code app with generated TypeScript models and services. Can also create new Dataverse tables. Use when connecting to Dataverse, adding tables, creating schema, or querying Dataverse data.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, LSP, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion, Skill, EnterPlanMode, ExitPlanMode
model: opus
---

**📋 Shared Instructions: [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Cross-cutting concerns.

**References:**

- [dataverse-reference.md](./references/dataverse-reference.md) - Picklist fields, virtual fields, lookups, file/image columns, form patterns (CRITICAL)
- [api-authentication-reference.md](./references/api-authentication-reference.md) - Dataverse API auth, token, publisher prefix
- [table-management-reference.md](./references/table-management-reference.md) - Query, create, extend tables and columns
- [data-architecture-reference.md](./references/data-architecture-reference.md) - Relationship types, dependency tiers

# Add Dataverse

Two paths: **existing tables** (skip to Step 5) or **new tables** (full workflow).

## Workflow

1. Plan → 2. Setup API Auth → 3. Review Existing Tables → 4. Create Tables → 5. Add Data Source → 6. Review Generated Files → 7. Build

---

### Step 1: Plan

Check memory bank for project context. Ask the user:

1. Which Dataverse table(s) do they need? (e.g., `account`, `contact`, `cr123_customentity`)
2. Do the tables **already exist** in their environment, or do they need to **create new** ones?

**If tables already exist:** Skip to Step 5.

**If creating new tables:**

- Ask about the data they need and design an appropriate schema
- Use standard Dataverse tables when appropriate (`contact` for people, `account` for organizations)
- Build a dependency graph -- see [data-architecture-reference.md](./references/data-architecture-reference.md) for tier classification
- Enter plan mode with `EnterPlanMode`, present ER model with tables, columns, relationships, and creation order
- Get approval with `ExitPlanMode`

### Step 2: Setup API Auth (if creating tables)

See [api-authentication-reference.md](./references/api-authentication-reference.md) for full details.

```powershell
az account show   # Verify Azure CLI logged in
pwsh -NoProfile -Command "pac org who"       # Get environment URL

$api = Initialize-DataverseApi -EnvironmentUrl "https://<org>.crm.dynamics.com"
$headers = $api.Headers
$baseUrl = $api.BaseUrl
$publisherPrefix = $api.PublisherPrefix
```

Requires **System Administrator** or **System Customizer** security role.

### Step 3: Review Existing Tables (if creating tables)

**Always query existing tables first before creating:**

```powershell
$existingTables = Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions?`$filter=IsCustomEntity eq true&`$select=SchemaName,LogicalName,DisplayName" -Headers $headers
```

See [table-management-reference.md](./references/table-management-reference.md) for `Find-SimilarTables`, `Compare-TableSchemas`, and `Build-TableNameMapping` functions.

Present findings to user with `AskUserQuestion`:

- Tables that can be **reused** (already exist with matching columns)
- Tables that need **extension** (exist but missing columns)
- Tables that must be **created** (no match found)

### Step 4: Create Tables (if creating tables)

Get explicit confirmation before creating. Create in dependency order:

- **Tier 0**: Reference tables (no dependencies)
- **Tier 1**: Primary entities (reference Tier 0)
- **Tier 2**: Dependent tables (reference Tier 1)

Use safe functions from [table-management-reference.md](./references/table-management-reference.md):

- `New-DataverseTableIfNotExists`
- `Add-DataverseColumnIfNotExists`
- `Add-DataverseLookupIfNotExists` (from [data-architecture-reference.md](./references/data-architecture-reference.md))

### Step 5: Add Data Source

For each table:

```bash
pwsh -NoProfile -Command "pac code add-data-source -a dataverse -t <table-logical-name>"
```

Can add multiple tables by running the command for each one.

### Step 6: Review Generated Files

The command generates:

- `src/generated/models/{Table}Model.ts` -- TypeScript interfaces, plus `{Table}FileColumnName`, `{Table}ImageColumnName`, `{Table}UploadColumnName` union types if the table has file/image columns
- `src/generated/services/{Table}Service.ts` -- CRUD methods (create, get, getAll, update, delete) plus `upload`, `downloadFile`, `downloadImage`, `deleteFileOrImage` if file/image columns exist

Show the user a usage example:

```typescript
import { AccountsService } from "../generated/services/AccountsService";

const result = await AccountsService.getAll({
  select: ["name", "accountnumber"],
  filter: "statecode eq 0",
  orderBy: ["name asc"],
  top: 50
});
const accounts = result.data || [];
```

**Key rules:**

- Use generated services (e.g., `AccountsService.getAll()`), not fetch/axios
- Check `result.data` for actual data
- Don't edit generated files unless needed
- **Read [dataverse-reference.md](./references/dataverse-reference.md) before writing any Dataverse code** -- picklist fields, virtual fields, lookups, and file/image columns all have critical gotchas

### Step 7: Build

```powershell
npm run build
```

Fix TypeScript errors before proceeding. Do NOT deploy yet.

### Update Memory Bank

Record which tables were added (or created), generated files, and any schema notes.
