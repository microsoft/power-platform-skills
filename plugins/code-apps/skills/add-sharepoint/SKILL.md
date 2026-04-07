---
name: add-sharepoint
description: Adds SharePoint Online connector to a Power Apps code app. Use when reading lists, managing documents, or integrating with SharePoint sites. Can also create new SharePoint lists.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, LSP, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion, Skill, EnterPlanMode, ExitPlanMode
model: opus
---

**📋 Shared Instructions: [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Cross-cutting concerns.

**References:**

- [sharepoint-reference.md](./references/sharepoint-reference.md) - Column encoding, choice fields, lookups, API patterns (CRITICAL)
- [api-authentication-reference.md](./references/api-authentication-reference.md) - Graph API auth, token, site ID
- [list-management-reference.md](./references/list-management-reference.md) - Query, create, extend lists and columns

# Add SharePoint

Two paths: **existing lists** (skip to Step 6) or **new lists** (full workflow).

## Workflow

1. Check Memory Bank → 2. Plan → 3. Setup Graph API Auth → 4. Review Existing Lists → 5. Create Lists → 6. Get Connection ID → 7. Discover Sites → 8. Discover Tables → 9. Add Connector → 10. Configure → 11. Build → 12. Update Memory Bank

---

### Step 1: Check Memory Bank

Check for `memory-bank.md` per [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md).

### Step 2: Plan

Ask the user:

1. Which SharePoint list(s) do they need?
2. Do the lists **already exist** on their site, or do they need to **create new** ones?

**If lists already exist:** Skip to Step 6.

**If creating new lists:**

- Ask about the data they need and design an appropriate schema
- Reuse existing lists when possible (don't duplicate)
- Enter plan mode with `EnterPlanMode`, present the list designs with columns and types
- Get approval with `ExitPlanMode`

### Step 3: Setup Graph API Auth (if creating lists)

See [api-authentication-reference.md](./references/api-authentication-reference.md) for full details.

```powershell
az account show   # Verify Azure CLI logged in

$api = Initialize-SharePointGraphApi -SiteUrl "https://<tenant>.sharepoint.com/sites/<site-name>"
$headers = $api.Headers
$siteId = $api.SiteId
```

Requires **Sites.Manage.All** permission.

### Step 4: Review Existing Lists (if creating lists)

**Always query existing lists first before creating:**

```powershell
$existingLists = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/sites/$siteId/lists?`$select=id,displayName,description,list&`$filter=list/hidden eq false" -Headers $headers
```

See [list-management-reference.md](./references/list-management-reference.md) for `Find-SimilarLists`, `Compare-ListSchemas`, and `Get-ListSchema` functions.

Present findings to user with `AskUserQuestion`:

- Lists that can be **reused** (already exist with matching columns)
- Lists that need **extension** (exist but missing columns)
- Lists that must be **created** (no match found)

### Step 5: Create Lists (if creating lists)

Get explicit confirmation before creating. Use safe functions from [list-management-reference.md](./references/list-management-reference.md):

- `New-SharePointListIfNotExists`
- `Add-SharePointColumnIfNotExists`
- `Add-SharePointLookupColumn` (for cross-list references)

### Step 6: Get Connection ID

Find the SharePoint Online connection ID (see [connector-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/connector-reference.md)):

Run the `/list-connections` skill. Find the SharePoint Online connection in the output. If none exists, direct the user to create one using the environment-specific Connections URL — construct it from the active environment ID in context (from `power.config.json` or a prior step): `https://make.powerapps.com/environments/<environment-id>/connections` → **+ New connection** → search for the connector → Create.

### Step 7: Discover Sites

List available SharePoint sites the user has access to:

```bash
pwsh -NoProfile -Command "pac code list-datasets -a sharepointonline -c <connection-id>"
```

Present the sites to the user and ask which one(s) they want to connect to. If the user already specified a site URL, confirm it appears in the list.

**If `pac code list-datasets` fails or returns no results:**
- Auth error: Run `pwsh -NoProfile -Command "pac auth list"` and re-authenticate if needed.
- Empty list: Confirm the connection ID is for a SharePoint Online connection and the user has access to at least one site. STOP if the list is empty after confirming.
- Any other non-zero exit: Report the exact error output. STOP.

### Step 8: Discover Tables

For each selected site, list the available lists and document libraries:

```bash
pwsh -NoProfile -Command "pac code list-tables -a sharepointonline -c <connection-id> -d '<site-url>'"
```

**If `pac code list-tables` fails or returns no results:**
- Confirm the site URL from Step 7 is exact (copy from the output — do not retype).
- If still empty, the user may not have access to that site's lists. Ask them to verify permissions in SharePoint.
- Any other non-zero exit: Report the exact error output. STOP.

Present the tables to the user and ask which ones they want to add. Suggest tables that look relevant to their use case (based on memory bank context or the user's stated requirements). If lists were created in Step 5, they should appear here.

### Step 9: Add Connector

SharePoint is a tabular datasource -- requires `-c` (connection ID), `-d` (site URL), and `-t` (list name):

```bash
pwsh -NoProfile -Command "pac code add-data-source -a sharepointonline -c <connection-id> -d '<site-url>' -t '<table-name>'"
```

Run the command for each list or library the user selected. The `-d` (dataset) is the SharePoint site URL from Step 7, `-t` (table) is the list/library name from Step 8.

### Step 10: Configure

**Read [sharepoint-reference.md](./references/sharepoint-reference.md) before writing any SharePoint code** -- column encoding, choice fields, and lookups have critical gotchas.

**Common operations:**

```typescript
// Get items from a SharePoint list
const items = await SharePointOnlineService.GetItems({
  dataset: "https://contoso.sharepoint.com/sites/your-site",
  table: "Your List Name"
});

// Create a new list item
await SharePointOnlineService.PostItem({
  dataset: "https://contoso.sharepoint.com/sites/your-site",
  table: "Your List Name",
  item: {
    Title: "New Item",
    Description: "Item description",
    Status: "Active"
  }
});

// Get files from a document library
const files = await SharePointOnlineService.ListFolder({
  dataset: "https://contoso.sharepoint.com/sites/your-site",
  id: "Shared Documents" // Library name or folder ID
});

// Get file content
const content = await SharePointOnlineService.GetFileContent({
  dataset: "https://contoso.sharepoint.com/sites/your-site",
  id: "file-server-relative-url"
});
```

**Key points:**

- `dataset` is always the full SharePoint site URL
- `table` is the list display name for list operations
- List column names in the API may differ from display names (spaces become `_x0020_`, special chars encoded)
- Document library operations use folder/file IDs or server-relative URLs
- Choice columns use **string values**, not integer picklist codes (unlike Dataverse)

Use `Grep` to find specific methods in `src/generated/services/SharePointOnlineService.ts` (generated files can be very large -- see [connector-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/connector-reference.md#inspecting-large-generated-files)).

### Step 11: Build

```powershell
npm run build
```

Fix TypeScript errors before proceeding. Do NOT deploy yet.

### Step 12: Update Memory Bank

Update `memory-bank.md` with: connector added, site URL, lists/libraries configured (or created), build status.
