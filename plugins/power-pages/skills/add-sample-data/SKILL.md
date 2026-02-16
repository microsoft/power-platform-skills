---
name: add-sample-data
description: >
  This skill should be used when the user asks to "add sample data",
  "populate tables", "seed data", "add test records", "generate sample records",
  "insert demo data", "fill tables with data", "create test data",
  or wants to populate their Dataverse tables with sample records
  so they can test and demo their Power Pages site.
user-invocable: true
allowed-tools: ["Read", "Write", "Bash", "Grep", "Glob", "AskUserQuestion", "Task", "EnterPlanMode", "ExitPlanMode", "mcp__plugin_power-pages_microsoft-learn__microsoft_docs_search", "mcp__plugin_power-pages_microsoft-learn__microsoft_code_sample_search", "mcp__plugin_power-pages_microsoft-learn__microsoft_docs_fetch"]
model: opus
hooks:
  Stop:
    - hooks:
        - type: prompt
          prompt: >
            If sample data was being added in this session (via /power-pages:add-sample-data),
            verify before allowing stop: 1) Tables were discovered (from .datamodel-manifest.json or OData API),
            2) The user selected which tables to populate and approved the sample data plan,
            3) All approved records were inserted via OData API, 4) A verification summary was presented
            showing record counts per table. If incomplete, return { "ok": false, "reason": "<specific issues>" }.
            Otherwise return { "ok": true }.
          timeout: 30
---

# Add Sample Data

Populate Dataverse tables with sample records via OData API so users can test and demo their Power Pages sites.

## Workflow

1. **Verify Prerequisites** → PAC CLI auth + Azure CLI token
2. **Discover Tables** → Read `.datamodel-manifest.json` or query OData API
3. **Select Tables & Configure** → User picks tables and record count
4. **Generate & Review Sample Data Plan** → Preview sample records, get approval
5. **Insert Sample Data** → OData POST calls with relationship handling
6. **Verify & Summarize** → Confirm record counts, present summary

---

## Step 1: Verify Prerequisites

Follow the prerequisite steps in `${CLAUDE_PLUGIN_ROOT}/references/dataverse-prerequisites.md` to verify PAC CLI auth, acquire an Azure CLI token, and confirm API access. Store the environment URL as `$envUrl`.

---

## Step 2: Discover Tables

Find the custom tables available in the user's Dataverse environment.

### Path A: Read `.datamodel-manifest.json` (Preferred)

Check if `.datamodel-manifest.json` exists in the project root (written by the `setup-datamodel` skill). If it exists, read it — it already contains table logical names, display names, and column info.

```powershell
# Check if manifest exists
Test-Path ".datamodel-manifest.json"
```

See `${CLAUDE_PLUGIN_ROOT}/references/datamodel-manifest-schema.md` for the full manifest schema.

### Path B: Query OData API (Fallback)

If no manifest exists, discover custom tables via OData:

```powershell
$tables = Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/EntityDefinitions?`$select=LogicalName,DisplayName,EntitySetName&`$filter=IsCustomEntity eq true" -Headers $headers
```

For each discovered table, fetch its custom columns:

```powershell
$columns = Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/EntityDefinitions(LogicalName='<table>')/Attributes?`$select=LogicalName,DisplayName,AttributeType,RequiredLevel&`$filter=IsCustomAttribute eq true" -Headers $headers
```

### 2.1 Present Available Tables

Show the user the list of discovered tables with their columns so they can choose which to populate.

---

## Step 3: Select Tables & Configure

Use `AskUserQuestion` to gather user preferences:

### 3.1 Select Tables

Ask which tables they want to populate (use `multiSelect: true`). List all discovered tables as options.

### 3.2 Select Record Count

Ask how many sample records per table:

| Option | Description |
|--------|-------------|
| **5 records** | Quick test — just enough to verify the setup |
| **10 records** | Light demo data for basic testing |
| **25 records** | Fuller dataset for realistic demos |
| **Custom** | Let the user specify a number |

### 3.3 Determine Insertion Order

Analyze relationships between selected tables. Parent/referenced tables must be inserted first so their IDs are available for child/referencing table lookups.

Build the insertion order:
1. Tables with no lookup dependencies (parent tables) → insert first
2. Tables that reference already-inserted tables → insert next
3. Continue until all tables are ordered

---

## Step 4: Generate & Review Sample Data Plan

### 4.1 Enter Plan Mode

Use `EnterPlanMode` to present a preview of the sample data to be created.

### 4.2 Generate Contextual Sample Data

For each selected table, generate sample records with contextually appropriate values based on column names and types:

- **String columns**: Generate realistic values matching the column name (e.g., "Email" → `jane.doe@example.com`, "Phone" → `(555) 123-4567`, "Name" → realistic names)
- **Memo columns**: Generate short descriptive text relevant to the column name
- **Integer/Decimal/Currency columns**: Generate reasonable numeric values
- **DateTime columns**: Generate dates within a sensible range (past year to next month)
- **Boolean columns**: Mix of `true` and `false` values
- **Picklist/Choice columns**: Query valid options first (see references/odata-record-patterns.md), then use actual option values
- **Lookup columns**: Reference records from parent tables that will be/were already inserted

### 4.3 Present Preview

For each table, show a markdown table previewing the sample records:

```markdown
### Project (cr123_project) — 5 records

| Name | Description | Status | Start Date |
|------|-------------|--------|------------|
| Website Redesign | Modernize the corporate website | 100000000 (Active) | 2025-03-15 |
| Mobile App | Build iOS and Android app | 100000001 (Planning) | 2025-04-01 |
| ... | ... | ... | ... |
```

Show relationship handling: which lookup fields reference which parent table records.

### 4.4 Get User Approval

Use `ExitPlanMode` to present the plan. The user can:

- **Approve** — Proceed to Step 5
- **Request changes** — Modify the sample data and re-present
- **Cancel** — Stop the skill

---

## Step 5: Insert Sample Data

Execute OData POST calls to create the sample records. Refer to `references/odata-record-patterns.md` for full patterns.

### 5.1 Get Entity Set Names

For each table, get the entity set name (needed for the API URL):

```powershell
$entityDef = Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/EntityDefinitions(LogicalName='<table>')?`$select=EntitySetName" -Headers $headers
$entitySetName = $entityDef.EntitySetName
```

### 5.2 Get Picklist Options

For any picklist/choice columns, query valid option values before insertion:

```powershell
$picklistMeta = Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/EntityDefinitions(LogicalName='<table>')/Attributes(LogicalName='<column>')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?`$expand=OptionSet" -Headers $headers
```

Use the actual `Value` integers from the option set in your sample data.

### 5.3 Insert Parent Tables First

Insert records into parent/referenced tables first to capture their IDs:

```powershell
$body = @{
    cr123_name = "Sample Record"
    cr123_description = "A sample record for testing"
} | ConvertTo-Json

$response = Invoke-RestMethod -Method Post -Uri "$envUrl/api/data/v9.2/<EntitySetName>" -Headers $headers -Body $body -ContentType "application/json"
```

Capture the returned record ID from the `OData-EntityId` response header or by querying back:

```powershell
# The ID is in the response headers
# Or query: GET {envUrl}/api/data/v9.2/<EntitySetName>?$filter=cr123_name eq 'Sample Record'&$select=cr123_<table>id
```

Store parent record IDs for use in child table lookups.

### 5.4 Insert Child Tables with Lookups

For child/referencing tables, use `@odata.bind` syntax to set lookup fields:

```powershell
$body = @{
    cr123_name = "Child Record"
    "cr123_ParentId@odata.bind" = "/<ParentEntitySetName>(<parent_guid>)"
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "$envUrl/api/data/v9.2/<ChildEntitySetName>" -Headers $headers -Body $body -ContentType "application/json"
```

### 5.5 Track Progress

Track each insertion attempt:
- Record table name, record number, success/failure
- On failure, log the error message but continue with remaining records
- Do NOT attempt automated rollback on failure

### 5.6 Refresh Token Periodically

Refresh the Azure CLI token every 20 records to avoid expiration:

```powershell
$token = az account get-access-token --resource "$envUrl" --query accessToken -o tsv
$headers["Authorization"] = "Bearer $token"
```

---

## Step 6: Verify & Summarize

### 6.1 Verify Record Counts

For each table that was populated, query the record count:

```powershell
$count = Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/<EntitySetName>?`$count=true&`$top=0" -Headers $headers
```

The `@odata.count` field in the response gives the total record count.

### 6.2 Present Summary

Present a summary table:

| Table | Records Requested | Records Created | Failures |
|-------|-------------------|-----------------|----------|
| `cr123_project` (Project) | 10 | 10 | 0 |
| `cr123_task` (Task) | 10 | 9 | 1 |

Include:
- Total records created across all tables
- Any failures with error details
- Lookup relationships that were established

### 6.3 Suggest Next Steps

After the summary, suggest:
- Review the data in the Power Pages maker portal or model-driven app
- If the site is not yet built: `/power-pages:create-site`
- If the site is ready to deploy: `/power-pages:deploy-site`
