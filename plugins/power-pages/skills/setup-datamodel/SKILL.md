---
name: setup-datamodel
description: >
  This skill should be used when the user asks to "create Dataverse tables",
  "set up the data model", "setup dataverse", "create tables for my site",
  "setup dataverse schema", "create the database", "build my data model",
  or wants to create Dataverse tables, columns, and relationships for their
  Power Pages site based on a data model proposal.
user-invocable: true
allowed-tools: ["Read", "Write", "Bash", "Grep", "Glob", "AskUserQuestion", "Task", "EnterPlanMode", "ExitPlanMode", "mcp__plugin_power-pages_microsoft-learn__microsoft_docs_search", "mcp__plugin_power-pages_microsoft-learn__microsoft_code_sample_search", "mcp__plugin_power-pages_microsoft-learn__microsoft_docs_fetch"]
model: opus
hooks:
  Stop:
    - hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/setup-datamodel/scripts/validate-datamodel.js"'
          timeout: 30
        - type: prompt
          prompt: >
            If a Dataverse data model was being set up in this session (via /power-pages:setup-datamodel),
            verify before allowing stop: 1) A data model was obtained (either the data-model-architect agent
            was invoked OR the user uploaded an existing ER diagram that was parsed), 2) The user approved
            the proposal, 3) All approved tables were created, 4) A summary was presented.
            If incomplete, return { "ok": false, "reason": "<specific issues>" }. Otherwise return { "ok": true }.
          timeout: 30
---

# Set Up Dataverse Data Model

## Workflow

1. **Verify Prerequisites** → PAC CLI auth + Azure CLI token
2. **Choose Data Model Source** → Upload existing ER diagram or let AI figure it out
3. **Invoke Data Model Architect** → Spawn agent to analyze and propose data model (or parse uploaded diagram)
4. **Review Proposal** → Present proposal to user, get approval
5. **Pre-Creation Checks** → Query existing tables, skip duplicates
6. **Create Tables & Columns** → OData API POST calls
7. **Create Relationships** → OData API relationship definitions
8. **Publish & Verify** → Publish customizations, verify tables, write manifest, present summary

---

## Step 1: Verify Prerequisites

Follow the prerequisite steps in `${CLAUDE_PLUGIN_ROOT}/references/dataverse-prerequisites.md` to verify PAC CLI auth, acquire an Azure CLI token, and confirm API access. Store the environment URL as `$envUrl`.

---

## Step 2: Choose Data Model Source

Ask the user how they want to define the data model using the `AskUserQuestion` tool:

**Question**: "How would you like to define the data model for your site?"

| Option | Description |
|--------|-------------|
| **Upload an existing ER diagram** | Provide an image (PNG/JPG) or Mermaid diagram of your existing data model |
| **Let AI figure it out** | The AI agent will analyze your site's source code and propose a data model automatically |

### Path A: Upload Existing ER Diagram

If the user chooses to upload an existing diagram:

1. Ask the user to provide their ER diagram. Supported formats:
   - **Image file** (PNG, JPG) — Use the `Read` tool to view the image and extract tables, columns, relationships, and cardinalities from it
   - **Mermaid syntax** — The user can paste Mermaid ER diagram text directly in chat
   - **Text description** — A structured list of tables, columns, and relationships

2. Parse the diagram into the same structured format used by the data-model-architect agent:
   - Publisher prefix (ask the user, or retrieve from the environment via `pac env who`)
   - Table definitions: `logicalName`, `displayName`, `status` (new/modified/reused), `columns`, `relationships`
   - Column definitions: `logicalName`, `displayName`, `type`, `required`
   - Relationship definitions: type (1:N or M:N), referenced/referencing tables

3. Query existing Dataverse tables (same as Step 3 would) to mark each table as `new`, `modified`, or `reused`.

4. Generate a Mermaid ER diagram from the parsed data (if the user provided an image or text) for visual confirmation.

5. Proceed directly to **Step 4: Review Proposal** with the parsed data model.

### Path B: Let AI Figure It Out

If the user chooses to let AI figure it out, proceed to **Step 3: Invoke Data Model Architect** (the existing automated flow).

---

## Step 3: Invoke Data Model Architect

Use the `Task` tool to spawn the `data-model-architect` agent. This agent autonomously:

1. Analyzes the site's source code to infer data requirements
2. Queries existing Dataverse tables via OData GET requests
3. Identifies reuse opportunities (reuse, extend, or create new)
4. Proposes a complete data model with an ER diagram

Spawn the agent:

```
Task tool:
  subagent_type: general-purpose
  prompt: |
    You are the data-model-architect agent. Follow the instructions in
    the agent definition file at:
    ${CLAUDE_PLUGIN_ROOT}/agents/data-model-architect.md

    Analyze the current project and Dataverse environment, then propose
    a complete data model. Return:
    1. Publisher prefix
    2. Table definitions (logicalName, displayName, status, columns, relationships)
    3. Mermaid ER diagram
```

Wait for the agent to return its structured proposal before proceeding.

---

## Step 4: Review Proposal

Present the agent's data model proposal to the user for approval.

### 4.1 Enter Plan Mode

Use `EnterPlanMode` and write the proposal into the plan, including:

- Publisher prefix
- All proposed tables with columns (logical names + display names)
- Relationship descriptions
- Mermaid ER diagram
- Which tables are new vs. modified vs. reused

### 4.2 Get User Approval

Use `ExitPlanMode` to present the plan. The user can:

- **Approve** — Proceed to Step 5
- **Request changes** — Modify the proposal and re-present
- **Cancel** — Stop the skill

Only proceed to creation after explicit user approval.

---

## Step 5: Pre-Creation Checks

Before creating anything, refresh the token and verify what already exists to avoid duplicates.

### 5.1 Refresh Token

Re-acquire the Azure CLI token (tokens expire after ~60 minutes):

```powershell
$token = az account get-access-token --resource "$envUrl" --query accessToken -o tsv
```

### 5.2 Query Existing Tables

For each table in the approved proposal marked as `new`, check whether it already exists:

```powershell
$headers = @{ Authorization = "Bearer $token"; Accept = "application/json" }
Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/EntityDefinitions(LogicalName='<table_logical_name>')" -Headers $headers
```

- **If 404**: Table does not exist, proceed to create it
- **If 200**: Table already exists — skip creation, warn the user

For tables marked as `modified`, verify the table exists (it should) and check which columns are missing.

### 5.3 Build Creation Plan

From the pre-creation checks, build a list of:

- Tables to create (new tables that don't exist yet)
- Columns to add (new columns on existing/modified tables)
- Relationships to create
- Tables/columns to skip (already exist)

Inform the user of any skipped items.

---

## Step 6: Create Tables & Columns

Create each approved table and its columns using Dataverse OData Web API. Refer to `references/odata-api-patterns.md` for full JSON body templates.

### 6.1 Create Tables

For each new table, POST to the EntityDefinitions endpoint:

```powershell
$body = <JSON body from references/odata-api-patterns.md>
$headers = @{
  Authorization = "Bearer $token"
  "Content-Type" = "application/json"
  Accept = "application/json"
}
Invoke-RestMethod -Method Post -Uri "$envUrl/api/data/v9.2/EntityDefinitions" -Headers $headers -Body $body
```

Use the deep-insert pattern to create the table and its columns in a single POST request. See `references/odata-api-patterns.md` for the complete JSON structure.

### 6.2 Add Columns to Existing Tables

For tables marked as `modified`, add new columns one at a time:

```powershell
$body = <column JSON from references/odata-api-patterns.md>
Invoke-RestMethod -Method Post -Uri "$envUrl/api/data/v9.2/EntityDefinitions(LogicalName='<table>')/Attributes" -Headers $headers -Body $body
```

### 6.3 Track Progress

Track each creation attempt and its result (success/failure/skipped). Do NOT attempt automated rollback on failure — report failures and continue with remaining items.

### 6.4 Refresh Token if Needed

If creating many tables, refresh the token between batches (every 3–4 tables) to avoid expiration:

```powershell
$token = az account get-access-token --resource "$envUrl" --query accessToken -o tsv
```

---

## Step 7: Create Relationships

After all tables and columns exist, create relationships between them.

### 7.1 One-to-Many Relationships

Create lookup columns that establish 1:N relationships:

```powershell
$body = <relationship JSON from references/odata-api-patterns.md>
Invoke-RestMethod -Method Post -Uri "$envUrl/api/data/v9.2/RelationshipDefinitions" -Headers $headers -Body $body
```

### 7.2 Many-to-Many Relationships

Create M:N relationships (intersect tables are created automatically):

```powershell
$body = <M:N relationship JSON from references/odata-api-patterns.md>
Invoke-RestMethod -Method Post -Uri "$envUrl/api/data/v9.2/RelationshipDefinitions" -Headers $headers -Body $body
```

### 7.3 Track Relationship Creation

Track each relationship creation attempt. Report failures without rolling back.

---

## Step 8: Publish & Verify

### 8.1 Publish Customizations

Publish all customizations so the new tables and columns become available:

```powershell
$publishBody = @{
  ParameterXml = "<importexportxml><entities><entity>$( ($tables | ForEach-Object { $_.logicalName }) -join '</entity><entity>' )</entity></entities></importexportxml>"
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "$envUrl/api/data/v9.2/PublishXml" -Headers $headers -Body $publishBody -ContentType "application/json"
```

See `references/odata-api-patterns.md` for the full PublishXml pattern.

### 8.2 Verify Tables Exist

For each created table, run a verification query:

```powershell
Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/EntityDefinitions(LogicalName='<table>')?`$select=LogicalName,DisplayName" -Headers $headers
```

### 8.3 Write Manifest

After successful verification, write `.datamodel-manifest.json` to the project root. This file records which tables and columns were verified to exist, and is used by the validation hook.

```json
{
  "environmentUrl": "https://org12345.crm.dynamics.com",
  "tables": [
    {
      "logicalName": "cr123_project",
      "displayName": "Project",
      "status": "new",
      "columns": [
        { "logicalName": "cr123_name", "type": "String" },
        { "logicalName": "cr123_description", "type": "Memo" }
      ]
    }
  ]
}
```

Use the `Write` tool to create this file at `<PROJECT_ROOT>/.datamodel-manifest.json`. Only include tables and columns that were confirmed to exist in Step 8.2. See `${CLAUDE_PLUGIN_ROOT}/references/datamodel-manifest-schema.md` for the full schema specification.

### 8.4 Present Summary

Present a summary to the user:

| Table | Status | Columns | Relationships |
|-------|--------|---------|---------------|
| `cr123_project` (Project) | Created | 5 columns | 2 relationships |
| `contact` (Contact) | Reused | 1 column added | — |
| `cr123_task` (Task) | Created | 4 columns | 1 relationship |

Include:
- Total tables created/modified/reused/failed
- Total columns created/skipped/failed
- Total relationships created/failed
- Any errors encountered with details
- Location of the manifest file (`.datamodel-manifest.json`)

### 8.5 Suggest Next Steps

After the summary, suggest:
- Review created tables in the Power Pages maker portal
- Populate tables with sample data for testing: `/power-pages:add-sample-data`
- If the site is not yet built: `/power-pages:create-site`
- If the site is ready to deploy: `/power-pages:deploy-site`
