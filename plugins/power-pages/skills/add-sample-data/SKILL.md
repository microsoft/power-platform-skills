---
name: add-sample-data
description: >-
  Populates Dataverse tables with sample records for testing and demoing a Power Pages site.
  Use when the user wants to add sample data, seed data, generate test records, or insert
  demo data into their tables.
user-invocable: true
allowed-tools: Read, Write, Bash, Grep, Glob, AskUserQuestion, Task, TaskCreate, TaskUpdate, TaskList, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_search, mcp__plugin_power-pages_microsoft-learn__microsoft_code_sample_search, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_fetch
model: sonnet
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Add Sample Data

Populate Dataverse tables with sample records via OData API so users can test and demo their Power Pages sites.

## Core Principles

- **Respect insertion order**: Always insert parent/referenced tables before child/referencing tables so lookup IDs are available when needed.
- **Use TaskCreate/TaskUpdate**: Track all progress throughout all phases -- create the todo list upfront with all phases before starting any work.
- **Fail gracefully**: On insertion failure, log the error and continue with remaining records -- never attempt automated rollback.

**Initial request:** $ARGUMENTS

---

## Phase 1: Verify Prerequisites

**Goal**: Confirm PAC CLI auth, acquire an Azure CLI token, and verify API access

**Actions**:

1. Create todo list with all 6 phases (see [Progress Tracking](#progress-tracking) table)
2. Follow the prerequisite steps in `${CLAUDE_PLUGIN_ROOT}/references/dataverse-prerequisites.md` to verify PAC CLI auth, acquire an Azure CLI token, and confirm API access. Store the environment URL as `$envUrl`.

**Output**: Authenticated session with valid token and confirmed API access

---

## Phase 2: Discover Tables

**Goal**: Find the custom tables available in the user's Dataverse environment

**Actions**:

### Path A: Read `.datamodel-manifest.json` (Preferred)

Check if `.datamodel-manifest.json` exists in the project root (written by the `setup-datamodel` skill). If it exists, read it -- it already contains table logical names, display names, and column info.

```powershell
# Check if manifest exists
Test-Path ".datamodel-manifest.json"
```

See `${CLAUDE_PLUGIN_ROOT}/references/datamodel-manifest-schema.md` for the full manifest schema.

### Path B: Query OData API (Fallback)

If no manifest exists, discover custom tables via OData:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> GET "EntityDefinitions?\$select=LogicalName,DisplayName,EntitySetName&\$filter=IsCustomEntity eq true"
```

For each discovered table, fetch its custom columns:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> GET "EntityDefinitions(LogicalName='<table>')/Attributes?\$select=LogicalName,DisplayName,AttributeType,RequiredLevel&\$filter=IsCustomAttribute eq true"
```

### 2.1 Present Available Tables

Show the user the list of discovered tables with their columns so they can choose which to populate.

**Output**: List of discovered tables with their columns presented to the user

---

## Phase 3: Select Tables & Configure

**Goal**: Gather user preferences on which tables to populate and how many records to create

**Actions**:

### 3.1 Select Tables

Use `AskUserQuestion` to ask which tables they want to populate (use `multiSelect: true`). List all discovered tables as options.

### 3.2 Select Record Count

Use `AskUserQuestion` to ask how many sample records per table:

| Option | Description |
|--------|-------------|
| **5 records** | Quick test -- just enough to verify the setup |
| **10 records** | Light demo data for basic testing |
| **25 records** | Fuller dataset for realistic demos |
| **Custom** | Let the user specify a number |

### 3.3 Determine Insertion Order

Analyze relationships between selected tables. Parent/referenced tables must be inserted first so their IDs are available for child/referencing table lookups.

Build the insertion order:

1. Tables with no lookup dependencies (parent tables) -- insert first
2. Tables that reference already-inserted tables -- insert next
3. Continue until all tables are ordered

**Output**: Confirmed table selection, record count, and insertion order

---

## Phase 4: Generate & Review Sample Data

**Goal**: Generate contextually appropriate sample records and get user approval before inserting

**Actions**:

### 4.1 Generate Contextual Sample Data

For each selected table, generate sample records with contextually appropriate values based on column names and types:

- **String columns**: Generate realistic values matching the column name (e.g., "Email" -> `jane.doe@example.com`, "Phone" -> `(555) 123-4567`, "Name" -> realistic names)
- **Memo columns**: Generate short descriptive text relevant to the column name
- **Integer/Decimal/Currency columns**: Generate reasonable numeric values
- **DateTime columns**: Generate dates within a sensible range (past year to next month)
- **Boolean columns**: Mix of `true` and `false` values
- **Picklist/Choice columns**: Query valid options first (see references/odata-record-patterns.md), then use actual option values
- **Lookup columns**: Reference records from parent tables that will be/were already inserted

### 4.2 Present Sample Data Preview

For each table, show a markdown table previewing the sample records directly in the conversation:

```markdown
### Project (cr123_project) -- 5 records

| Name | Description | Status | Start Date |
|------|-------------|--------|------------|
| Website Redesign | Modernize the corporate website | 100000000 (Active) | 2025-03-15 |
| Mobile App | Build iOS and Android app | 100000001 (Planning) | 2025-04-01 |
| ... | ... | ... | ... |
```

Show relationship handling: which lookup fields reference which parent table records.

**Output**: Sample data plan ready for insertion. Proceed directly to Phase 5.

---

## Phase 5: Insert Sample Data

**Goal**: Execute OData POST calls to create all approved sample records with correct relationship handling

**Actions**:

Refer to `references/odata-record-patterns.md` for full patterns.

### 5.1 Get Entity Set Names

For each table, get the entity set name (needed for the API URL):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> GET "EntityDefinitions(LogicalName='<table>')?\$select=EntitySetName"
```

### 5.2 Get Picklist Options

For any picklist/choice columns, query valid option values before insertion:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> GET "EntityDefinitions(LogicalName='<table>')/Attributes(LogicalName='<column>')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?\$expand=OptionSet"
```

Use the actual `Value` integers from the option set in your sample data.

### 5.3 Insert Parent Tables First

Insert records into parent/referenced tables first to capture their IDs:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> POST "<EntitySetName>" --body '{"cr123_name":"Sample Record","cr123_description":"A sample record for testing"}' --include-headers
```

The `--include-headers` flag includes the `OData-EntityId` response header, which contains the created record ID. Parse the GUID from the response to use in child table lookups.

Store parent record IDs for use in child table lookups.

### 5.4 Insert Child Tables with Lookups

For child/referencing tables, use `@odata.bind` syntax to set lookup fields:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> POST "<ChildEntitySetName>" --body '{"cr123_name":"Child Record","cr123_ParentId@odata.bind":"/<ParentEntitySetName>(<parent_guid>)"}' --include-headers
```

### 5.5 Track Progress

Track each insertion attempt:

- Record table name, record number, success/failure
- On failure, log the error message but continue with remaining records
- Do NOT attempt automated rollback on failure

### 5.6 Refresh Token Periodically

The `dataverse-request.js` script handles 401 token refresh internally. For long-running operations (many records), periodically re-run `verify-dataverse-access.js` to confirm the session is still valid:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-dataverse-access.js" <envUrl>
```

**Output**: All approved records inserted with parent-child relationships established

---

## Phase 6: Verify & Summarize

**Goal**: Confirm record counts and present a final summary to the user

**Actions**:

### 6.1 Verify Record Counts

For each table that was populated, query the record count:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> GET "<EntitySetName>?\$count=true&\$top=0"
```

The `@odata.count` field in the response gives the total record count.

### 6.2 Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "AddSampleData"`.

### 6.3 Present Summary

Present a summary table:

| Table | Records Requested | Records Created | Failures |
|-------|-------------------|-----------------|----------|
| `cr123_project` (Project) | 10 | 10 | 0 |
| `cr123_task` (Task) | 10 | 9 | 1 |

Include:

- Total records created across all tables
- Any failures with error details
- Lookup relationships that were established

### 6.4 Suggest Next Steps

After the summary, suggest:

- Review the data in the Power Pages maker portal or model-driven app
- If the site is not yet built: `/create-site`
- If the site is ready to deploy: `/deploy-site`

**Output**: Verified record counts and summary presented to the user

---

## Important Notes

### Throughout All Phases

- **Use TaskCreate/TaskUpdate** to track progress at every phase
- **Ask for user confirmation** at key decision points (see list below)
- **Respect insertion order** -- always insert parent tables before child tables
- **Fail gracefully** -- log errors and continue, never rollback automatically
- **Refresh tokens** every 20 records to avoid expiration

### Key Decision Points (Wait for User)

1. After Phase 2: Confirm which tables to populate
2. After Phase 3: Confirm record count and insertion order
3. After Phase 6: Review summary and decide next steps

### Progress Tracking

Before starting Phase 1, create a task list with all phases using `TaskCreate`:

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Verify prerequisites | Verifying prerequisites | Confirm PAC CLI auth, acquire Azure CLI token, verify API access |
| Discover tables | Discovering tables | Read .datamodel-manifest.json or query OData API for custom tables |
| Select tables and configure | Configuring tables | User picks tables, record count, and determine insertion order |
| Generate and review sample data | Generating sample data | Generate contextual sample records, present preview, get user approval |
| Insert sample data | Inserting records | Execute OData POST calls with relationship handling and token refresh |
| Verify and summarize | Verifying results | Confirm record counts, present summary, suggest next steps |

Mark each task `in_progress` when starting it and `completed` when done via `TaskUpdate`. This gives the user visibility into progress and keeps the workflow deterministic.

---

**Begin with Phase 1: Verify Prerequisites**
