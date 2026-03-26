---
name: add-azuredevops
description: Adds Azure DevOps connector to a Power Apps code app. Use when querying work items, creating bugs, managing pipelines, or making ADO API calls.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, LSP, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion, Skill
model: sonnet
---

**📋 Shared Instructions: [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Cross-cutting concerns.

# Add Azure DevOps

## Workflow

1. Check Memory Bank → 2. Add Connector → 3. Apply HttpRequest Fix → 4. Configure → 5. Build → 6. Update Memory Bank

---

### Step 1: Check Memory Bank

Check for `memory-bank.md` per [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md).

### Step 2: Add Connector

**First, find the connection ID** (see [connector-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/connector-reference.md)):

Run the `/list-connections` skill. Find the Azure DevOps connection in the output. If none exists, direct the user to create one using the environment-specific Connections URL — construct it from the active environment ID in context (from `power.config.json` or a prior step): `https://make.powerapps.com/environments/<environment-id>/connections` → **+ New connection** → search for the connector → Create.

```bash
pwsh -NoProfile -Command "pac code add-data-source -a azuredevops -c <connection-id>"
```

### Step 3: Apply HttpRequest Fix (Required)

The generated code has a known issue: the `HttpRequest` method uses `parameters` as the parameter name, but the API expects `body`. Rename `parameters` to `body` in these 3 files:

Use the `Edit` tool to rename `parameters` to `body` in each file:

**1. `src/generated/services/AzureDevOpsService.ts`:**
Find the `HttpRequest` method. Rename the parameter and its usage:

```typescript
// BEFORE (generated):
async HttpRequest(parameters: any) {
  const params = { parameters: parameters, ... };

// AFTER (fixed):
async HttpRequest(body: any) {
  const params = { body: body, ... };
```

**2. `.power/appschemas/dataSourceInfo.ts`:**
Find the `visualstudioteamservices` → `HttpRequest` → `parameters` section. Rename the property key:

```typescript
// BEFORE (generated):
HttpRequest: {
  parameters: {
    parameters: { ... }

// AFTER (fixed):
HttpRequest: {
  parameters: {
    body: { ... }
```

**3. `.power/schemas/visualstudioteamservices/visualstudioteamservices.Schema.json`:**
Find the `/{connectionId}/httprequest` → `post` → `parameters` array. Change the `name` field:

```json
// BEFORE (generated):
{ "name": "parameters", "in": "body", ... }

// AFTER (fixed):
{ "name": "body", "in": "body", ... }
```

### Step 4: Configure

Ask the user what Azure DevOps operations they need (query work items, create items, trigger pipelines, etc.).

**HttpRequest** -- make arbitrary ADO REST API calls:

```typescript
await AzureDevOpsService.HttpRequest({
  Uri: "https://dev.azure.com/{org}/{project}/_apis/wit/wiql?api-version=7.2",
  Method: "POST",
  Body: JSON.stringify({
    query:
      "SELECT [System.Id], [System.Title] FROM WorkItems WHERE [System.TeamProject] = @project"
  })
});
```

Docs: [Azure DevOps REST API](https://learn.microsoft.com/en-us/rest/api/azure/devops/?view=azure-devops-rest-7.2)

Use `Grep` to find specific methods in `src/generated/services/AzureDevOpsService.ts` (generated files can be very large -- see [connector-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/connector-reference.md#inspecting-large-generated-files)).

### Step 5: Build

```powershell
npm run build
```

Fix TypeScript errors before proceeding. Do NOT deploy yet.

### Step 6: Update Memory Bank

Update `memory-bank.md` with: connector added, HttpRequest fix applied, build status.
