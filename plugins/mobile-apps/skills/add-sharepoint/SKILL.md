---
name: add-sharepoint
description: Use when the user wants to read or write SharePoint lists, manage documents in a SharePoint document library, or create a new SharePoint list from a Power Apps mobile app.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, EnterPlanMode, ExitPlanMode
model: sonnet
---

**📋 Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** — read first.

**References:**

- [sharepoint-reference.md](./references/sharepoint-reference.md) — Column encoding, choice fields, lookups, API patterns (CRITICAL)
- [api-authentication-reference.md](./references/api-authentication-reference.md) — Graph API auth, token, site ID
- [list-management-reference.md](./references/list-management-reference.md) — Query, create, extend lists and columns

# Add SharePoint

Two paths: **existing lists** (skip to Step 6) or **new lists** (full workflow).

## Workflow

1. Check Memory Bank → 2. Plan → 3. Setup Graph API Auth → 4. Review Existing Lists → 5. Create Lists → 6. Get Connection ID → 7. Discover Sites → 8. Discover Tables → 9. Add Connector → 10. Configure → 11. Type-check → 12. Update Memory Bank


---

### Step 1: Check Memory Bank

Check for `memory-bank.md` per [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md).

Also confirm this is a mobile app:

```bash
test -f power.config.json && test -f app.config.js && echo "OK" || echo "ERROR: not a mobile app"
```

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

**Print before starting:**
> "→ Creating SharePoint lists via Graph API (sequential per list, columns added after list exists)…"

Get explicit confirmation before creating. Use safe functions from [list-management-reference.md](./references/list-management-reference.md):

- `New-SharePointListIfNotExists`
- `Add-SharePointColumnIfNotExists`
- `Add-SharePointLookupColumn` (for cross-list references)

### Step 6: Get Connection ID

Get the SharePoint Online connection ID (see [connector-reference.md](${CLAUDE_SKILL_DIR}/../../shared/connector-reference.md)):

```bash
npx power-apps create-connection --api-id shared_sharepointonline --json
```

Use **`shared_sharepointonline`** as the `apiId` and capture **`connectionId`** from the output. Use these exact values in the commands below.

If `create-connection` cannot complete because browser-based connection creation is disabled or the connector needs interactive auth, direct the user to create one:

> Open `https://make.powerapps.com/environments/<environment-id>/connections` → **+ New connection** → search "SharePoint" → Create. Then provide the connection ID or rerun `/list-connections shared_sharepointonline`.

### Step 7: Discover Sites

**Print before starting:**
> "→ Discovering SharePoint sites accessible to this connection…"

```bash
npx power-apps list-datasets --api-id <apiId-from-list> --connection-id <connection-id> --json
```

Present the sites to the user and ask which one(s) they want to connect to. If the user already specified a site URL, confirm it appears in the list.

**If `npx power-apps list-datasets` fails or returns no results:**
- Auth, wrong user, or multiple accounts: follow shared-instructions command-failure handling and retry once.
- Empty list: Confirm the connection ID is for a SharePoint Online connection and the user has access to at least one site. STOP if the list is empty after confirming.

### Step 8: Discover Tables

**Print before starting:**
> "→ Discovering lists/document libraries on each selected site…"

For each selected site:

```bash
npx power-apps list-tables --api-id <apiId-from-list> --connection-id <connection-id> --dataset '<site-url>' --json
```

Present the tables to the user and ask which ones they want to add. Suggest tables that look relevant to their use case. If lists were created in Step 5, they should appear here.

### Step 9: Add Connector

**Print before starting:**
> "→ Running `npx power-apps add-data-source` per list (sequential, ~10–20 seconds each)."

SharePoint is a tabular datasource — requires `--connection-id`, `--dataset`, and `--resource-name`:

```bash
npx power-apps add-data-source --api-id <apiId-from-list> --connection-id <connectionId-from-list> --dataset '<site-url>' --resource-name '<table-name>'
```

Run once per list or document library.

### Step 10: Configure

**Read [sharepoint-reference.md](./references/sharepoint-reference.md) before writing any SharePoint code** — column encoding, choice fields, and lookups have critical gotchas.

Use `Grep` to find methods in `src/generated/services/SharePointOnlineService.ts` (generated files can be very large — see [connector-reference.md](${CLAUDE_SKILL_DIR}/../../shared/connector-reference.md#inspecting-large-generated-files)).

Sample usage:

```typescript
import { SharePointOnlineService } from '../../src/generated/services/SharePointOnlineService';

// Read items
const result = await SharePointOnlineService.GetItems({
  dataset: 'https://contoso.sharepoint.com/sites/projects',
  table: 'Project Milestones',
});
const items = result.value ?? [];

// Create item
await SharePointOnlineService.PostItem({
  dataset: 'https://contoso.sharepoint.com/sites/projects',
  table: 'Project Milestones',
  item: { Title: 'Launch review', Status: 'Not Started' },
});

// Update item (SharePoint IDs are integers, not GUIDs)
await SharePointOnlineService.PatchItem({
  dataset: 'https://contoso.sharepoint.com/sites/projects',
  table: 'Project Milestones',
  id: 42,
  item: { Status: 'Done' },
});
```

### Step 11: Type-check

**Print before starting:**
> "→ Regenerating connector schemas + running tsc to verify SharePoint services compile (~15–30 seconds)."

> **Native diff:** `npx tsc --noEmit` instead of `npm run build`. Do NOT run platform-specific native build commands here.

`npx power-apps add-data-source` wrote new files into `.power/schemas/sharepointonline/`. Regenerate `connectorSchemas.ts` before type-checking so the new list is wired into the runtime schema map:

```bash
npm run generate-schemas
npx tsc --noEmit
```

Fix TypeScript errors before proceeding.

### Step 12: Update Memory Bank

Update `memory-bank.md` with: connector added, site URL, lists/libraries connected (or created), type-check status.

> **Note:** No manual executor wiring needed. `PowerAppsHostProvider` in `app/_layout.tsx` handles SharePoint connector routing, connection resolution, and OAuth consent automatically at runtime.
