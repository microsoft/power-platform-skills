---
name: add-sharepoint
description: Adds SharePoint Online connector to a Power Apps code app. Use when reading lists, managing documents, or integrating with SharePoint sites. Can also create new SharePoint lists.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, LSP, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion, Skill, EnterPlanMode, ExitPlanMode
model: opus
---

**📋 Shared Instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** - Cross-cutting concerns.

**References:**

- [sharepoint-reference.md](./references/sharepoint-reference.md) - Column encoding, choice fields, lookups, API patterns (CRITICAL)
- [api-authentication-reference.md](./references/api-authentication-reference.md) - Graph API auth, token, site ID
- [list-management-reference.md](./references/list-management-reference.md) - Query, create, extend lists and columns

# Add SharePoint

Two paths: **existing lists** (skip to Step 6) or **new lists** (full workflow).

## Workflow

1. Check Memory Bank → 2. Plan → 3. Setup Graph API Auth → 4. Review Existing Lists → 5. Create Lists → 6. Get Connection ID → 7. Discover Sites → 8. Discover Tables → 9. Add Connector (tables and/or actions) → 10. Configure → 11. Build → 12. Update Memory Bank

---

### Step 1: Check Memory Bank

Check for `memory-bank.md` per [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md).

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

Discovering sites and lists (Steps 7–8) needs a SharePoint connection ID on every CLI version: `pa connection list-datasets` and `list-tables` don't find or create connections the way `pa app add data-source` does on CLI 1.3.0+ (see [connector-reference.md](${PLUGIN_ROOT}/shared/connector-reference.md#connections)).

1. Run the `/list-connections` skill, filtered with `--search sharepointonline`.
2. Exactly one SharePoint connection: use its connection ID. Several: ask the user which one to use.
3. None: create one after asking the user.
   - **CLI 1.3.0+:** SharePoint supports single sign-on, so with the user's OK run:

     ```bash
     pa connection create --connector shared_sharepointonline --use-sso
     ```

     It creates the connection silently with the user's account and prints `Connection ID: <id>`.
   - **Older CLIs, or if the user wants a different sign-in type:** follow [Create a connection with the user](${PLUGIN_ROOT}/shared/connector-reference.md#create-a-connection-with-the-user), then repeat step 1.

### Step 7: Discover Sites

List available SharePoint sites the user has access to:

```bash
pa connection list-datasets --connector sharepointonline -c <connection-id>
```

Present the sites to the user and ask which one(s) they want to connect to. If the user already specified a site URL, confirm it appears in the list.

**If `pa connection list-datasets` fails or returns no results:**
- Auth error: Run `pa auth login` (or `power-apps login` on `power-apps`-only projects), then retry.
- Empty list: Confirm the connection ID is for a SharePoint Online connection and the user has access to at least one site. STOP if the list is empty after confirming.
- Any other non-zero exit: Report the exact error output. STOP.

### Step 8: Discover Tables

For each selected site, list the available lists and document libraries:

```bash
pa connection list-tables --connector sharepointonline -c <connection-id> -d '<site-url>'
```

**If `pa connection list-tables` fails or returns no results:**
- Confirm the site URL from Step 7 is exact (copy from the output — do not retype).
- If still empty, the user may not have access to that site's lists. Ask them to verify permissions in SharePoint.
- Any other non-zero exit: Report the exact error output. STOP.

Present the tables to the user and ask which ones they want to add. Suggest tables that look relevant to their use case (based on memory bank context or the user's stated requirements). If lists were created in Step 5, they should appear here.

### Step 9: Add Connector

SharePoint supports both tables and actions, so say which one you're adding. Pass the connection ID from Step 6, so the add doesn't need to look for a connection (on CLI 1.3.0+, also pass `--non-interactive`):

```bash
# Lists and libraries as tables: -c (connection ID), -d (site URL), and --table (list name)
pa app add data-source --connector sharepointonline -c <connection-id> -d '<site-url>' --table '<table-name>'

# Document library and file operations (CLI 1.2.0+): add the connector's actions
pa app add data-source --connector sharepointonline -c <connection-id> --as action
```

Run the table command for each list or library the user selected. The `-d` (dataset) is the SharePoint site URL from Step 7, `--table` is the list/library display name from Step 8. Add the actions only if the app needs file or folder operations; the CLI keeps them as a separate data source next to the tables.

### Step 10: Configure

**Read [sharepoint-reference.md](./references/sharepoint-reference.md) before writing any SharePoint code** -- column encoding, choice fields, and lookups have critical gotchas.

What the CLI generates depends on how you added SharePoint in Step 9 (CLI 1.3.0):

| Added with | Generated service | How you call it |
| --- | --- | --- |
| `--table '<list>'` | One service per list, named after it (for example `ProjectMilestonesService`), with `<List>Read` / `<List>Write` models | `getAll(options?)`, `get(id)`, `create(record)`, `update(id, changedFields)`, `delete(id)` |
| `--as action` | `SharePointService` | The connector's operations, with **positional** parameters: `GetItems(dataset, table, ...)`, `PostItem(dataset, table, item)`, `ListRootFolder(dataset)`, `ListFolder(dataset, id)`, `GetFileContent(dataset, id)`, and more |

These examples were verified against CLI 1.3.0. Grep `src/generated/services/` to confirm the service name and each method's exact signature before using it, especially in projects created with an older CLI.

**Common operations:**

```typescript
// Lists added as tables: one typed service per list
const result = await ProjectMilestonesService.getAll({ top: 50, orderBy: ["Title asc"] });
const milestones = result.data ?? [];
await ProjectMilestonesService.create({ Title: "New milestone" });
await ProjectMilestonesService.update(id, { Title: "Renamed milestone" });

// Connector actions (added with --as action) take positional parameters, for example
// PostItem(dataset, table, item): dataset is the full site URL, table is the list's display name.
const dataset = "https://contoso.sharepoint.com/sites/your-site";
const items = await SharePointService.GetItems(dataset, "Your List Name");
await SharePointService.PostItem(dataset, "Your List Name", { Title: "New Item", Status: "Active" });

// Files in document libraries
const root = await SharePointService.ListRootFolder(dataset);
const files = await SharePointService.ListFolder(dataset, "<folder-id>");
const content = await SharePointService.GetFileContent(dataset, "<file-id>");
```

**Key points:**

- `dataset` (action calls) is always the full SharePoint site URL
- `table` (action calls) and `--table` (Step 9) take the list's display name
- List column names in the API may differ from display names (spaces become `_x0020_`, special chars encoded)
- Document library operations use folder/file IDs or server-relative URLs
- Choice columns use **string values**, not integer picklist codes (unlike Dataverse)

Use `Grep` to find specific methods in the generated services (generated files can be very large -- see [connector-reference.md](${PLUGIN_ROOT}/shared/connector-reference.md#inspecting-large-generated-files)).

### Step 11: Build

```bash
npm run build
```

Fix TypeScript errors before proceeding. Do NOT deploy yet.

### Step 12: Update Memory Bank

Update `memory-bank.md` with: connector added, site URL, lists/libraries configured (or created), build status. Don't record the connection ID.
