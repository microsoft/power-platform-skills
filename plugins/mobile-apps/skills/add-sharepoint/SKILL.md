---
name: add-sharepoint
description: Use when the user wants to read or write SharePoint lists, manage documents in a SharePoint document library, or create a new SharePoint list from a Power Apps mobile app.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, EnterPlanMode, ExitPlanMode, Skill
model: sonnet
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` - if it outputs a message, show it to the user before proceeding.

**📋 Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**References:**

- [sharepoint-reference.md](./references/sharepoint-reference.md) — Column encoding, choice fields, lookups, API patterns (CRITICAL)
- [api-authentication-reference.md](./references/api-authentication-reference.md) — Graph API auth, token, site ID
- [list-management-reference.md](./references/list-management-reference.md) — Query, create, extend lists and columns

# Add SharePoint

**App root:** before any project read or command, execute
[app-working-directory.md](${PLUGIN_ROOT}/shared/references/app-working-directory.md).
Use its resolved absolute `working_dir` for every shell call and file tool,
including referenced commands and delegated skills; never inherit a prior `cd`.

**Entry routing:** use the shared [App feature entry points](../../shared/shared-instructions.md#app-feature-entry-points)
preflight before the workflow below.

**Invocation scope:** follow [Data-source invocation scope](../../shared/shared-instructions.md#data-source-invocation-scope)
before the workflow below. Standalone calls approve only their SharePoint
schema/binding delta and verify it here; they do not start a full-app workflow.

Keep SharePoint list/library schemas in Connectors, not the Dataverse
Data Model. Forward supplied site/list/connection choices and ask only for missing
values; return scope changes to the current owner, or ask the standalone user,
before mutation. Reuse supplied approval only for the exact current data delta.

**Removal branch:** after resolving invocation scope, `--remove` or an approved list/library
binding removal executes
[data-source-removal.md](../../shared/references/data-source-removal.md) and
returns. Do not create a connection/list or run Steps 1-12 for removal; the
SharePoint list/library and its contents remain on the server.

**Refresh branch:** after resolving invocation scope, `--refresh` or an approved retained-list
service refresh executes [Refresh a retained source](../../shared/references/data-source-removal.md#refresh-a-retained-source)
and returns before Steps 1-12. Preserve the exact `--data-source-name` and approved
binding identity; do not create a list/connection or run `add-data-source`.

Two paths: **existing lists** (skip to Step 6) or **new lists** (full workflow).

## Workflow

1. Check Memory Bank → 2. Plan → 3. Setup Graph API Auth → 4. Review Existing Lists → 5. Create Lists → 6. Get Connection ID → 7. Discover Sites → 8. Discover Tables → 9. Add Connector → 10. Configure → 11. Type-check → 12. Update Memory Bank


---

### Step 1: Check Memory Bank

Check for `memory-bank.md` per [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md).

Also confirm this is a mobile app:

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
if [ ! -f power.config.json ] || [ ! -f app.config.js ]; then
  echo "BLOCKED: working_dir is not an initialized app" >&2
  exit 1
fi
```

### Step 2: Plan

**Telemetry checkpoint: `plan_sharepoint_data_source`**

Reuse the supplied site/list and existing-vs-new decisions. Ask only for missing
values:

1. Which SharePoint list(s) do they need?
2. Do the lists **already exist** on their site, or do they need to **create new** ones?

For `--plan-only` or a planning-phase handoff, present the proposed site/list
bindings, any schema changes, and unresolved choices, then STOP before
implementation. Do not create connections/lists, generate services, or update
the app plan or memory-bank. Missing discovery access is not permission to
create a connection.

**If lists already exist:** Skip to Step 6.

**If creating new lists:**

- Ask about the data they need and design an appropriate schema
- Reuse existing lists when possible (don't duplicate)
- Enter plan mode with `EnterPlanMode`, present the list designs with columns and types
- Get approval with `ExitPlanMode`, unless the exact list/schema delta already
  has current owner approval. Read-only discovery that changes that delta must
  return for approval before Step 5.

### Step 3: Setup Graph API Auth (if creating lists)

See [api-authentication-reference.md](./references/api-authentication-reference.md) for full details.

```powershell
Set-Location -LiteralPath '<working_dir>' -ErrorAction Stop
az account show   # Verify Azure CLI logged in

$api = Initialize-SharePointGraphApi -SiteUrl "https://<tenant>.sharepoint.com/sites/<site-name>"
$headers = $api.Headers
$siteId = $api.SiteId
```

Requires **Sites.Manage.All** permission.

### Step 4: Review Existing Lists (if creating lists)

**Always query existing lists first before creating:**

```powershell
Set-Location -LiteralPath '<working_dir>' -ErrorAction Stop
$existingLists = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/sites/$siteId/lists?`$select=id,displayName,description,list&`$filter=list/hidden eq false" -Headers $headers
```

See [list-management-reference.md](./references/list-management-reference.md) for `Find-SimilarLists`, `Compare-ListSchemas`, and `Get-ListSchema` functions.

Present findings to user with `AskUserQuestion`:

- Lists that can be **reused** (already exist with matching columns)
- Lists that need **extension** (exist but missing columns)
- Lists that must be **created** (no match found)

### Step 5: Create Lists (if creating lists)

**Telemetry checkpoint: `create_sharepoint_lists`**

**Print before starting:**
> "→ Creating SharePoint lists via Graph API (sequential per list, columns added after list exists)…"

Require explicit current approval for the exact create/extend operations before
writing; reuse matching owner approval rather than prompting twice. Use safe
functions from [list-management-reference.md](./references/list-management-reference.md):

- `New-SharePointListIfNotExists`
- `Add-SharePointColumnIfNotExists`
- `Add-SharePointLookupColumn` (for cross-list references)

### Step 6: Get Connection ID

Apply [connector-reference.md](../../shared/connector-reference.md#step-1--get-a-connection)
before any lookup or creation. Use **`shared_sharepointonline`** as `apiId`.

- Supplied `--connection-id` or approved `connectionId`: reuse the exact ID;
  skip `create-connection` and `/list-connections`.
- Supplied `--connection-ref` or approved `connectionRef`: retain the exact
  reference for Step 9; skip `create-connection` and `/list-connections`.
- Missing binding only: use the approved solution-reference lookup when
  solution-aware, or obtain explicit approval to create a connection with the
  command below. Conflicting,
  blank, or wrong-environment supplied bindings must be clarified, not replaced.

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
$PA connection create --connector shared_sharepointonline --json
```

Only on the creation path, capture the returned `connectionId`. The following
picker examples use the ID path. With a reference, skip pickers when site/list
values are supplied; otherwise obtain the backing ID for that same reference or
ask for the missing choices. Do not create another connection for discovery.

If `pa connection create` cannot complete because browser-based connection creation is disabled or the connector needs interactive auth, direct the user to create one:

> Open `https://make.powerapps.com/environments/<environment-id>/connections` → **+ New connection** → search "SharePoint" → Create. Then provide the connection ID or rerun `/list-connections shared_sharepointonline`.

### Step 7: Discover Sites

Skip this picker when the approved site URL is already supplied.

**Print before starting:**
> "→ Discovering SharePoint sites accessible to this connection…"

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
$PA connection list-datasets --connector shared_sharepointonline --connection-id '<connectionId>' --json
```

Present the discovered sites only when a site choice is missing.

**If `pa connection list-datasets` fails or returns no results:**
- Auth, wrong user, or multiple accounts: follow shared-instructions command-failure handling and retry once.
- Empty list: Confirm the connection ID is for a SharePoint Online connection and the user has access to at least one site. STOP if the list is empty after confirming.

### Step 8: Discover Tables

Skip this picker for supplied list/library identities; reuse the approved values.

**Print before starting:**
> "→ Discovering lists/document libraries on each selected site…"

For each selected site:

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
$PA connection list-tables --connector shared_sharepointonline --connection-id '<connectionId>' --dataset '<site-url>' --json
```

Present the tables to the user and ask which ones they want to add. Suggest tables that look relevant to their use case. If lists were created in Step 5, they should appear here.

### Step 9: Add Connector

**Telemetry checkpoint: `generate_sharepoint_data_source`**

**Print before starting:**
> "→ Running `pa app add data-source` per list (sequential, ~10–20 seconds each)."

SharePoint is tabular: use `--dataset` and `--table` with the exact
binding selected in Step 6. Confirm approval covers this environment, connection
ID/reference, site, and list/library before registration. Ask the standalone
user to approve any newly resolved binding; return a changed child scope to its
owner. A picker selection alone is not execution approval.
Run only the applicable command:

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
# Supplied/resolved connection ID
$PA app add data-source --connector shared_sharepointonline --connection-id '<connectionId>' --dataset '<site-url>' --table '<table-name>'

# Supplied/resolved connection reference
$PA app add data-source --connector shared_sharepointonline --connection-ref '<connectionRef>' --dataset '<site-url>' --table '<table-name>'
```

Run once per list or document library.

### Step 10: Configure

Inspect and return service signatures and usage guidance to the user or current
owner. Do not independently edit screens or launch another app workflow;
explicitly report that this data-source operation did not wire screens.

**Read [sharepoint-reference.md](./references/sharepoint-reference.md) before writing any SharePoint code** — column encoding, choice fields, and lookups have critical gotchas.

Use `Grep` to find methods in `<working_dir>/src/generated/services/SharePointOnlineService.ts` (generated files can be very large — see [connector-reference.md](${PLUGIN_ROOT}/shared/connector-reference.md#inspecting-large-generated-files)).

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

**Telemetry checkpoint: `validate_sharepoint_integration`**

**Print before starting:**
> "→ Regenerating connector schemas + running tsc to verify SharePoint services compile (~15–30 seconds)."

> **Native diff:** `npx --no-install tsc --noEmit` instead of `npm run build`. Do NOT run platform-specific native build commands here.

`pa app add data-source` wrote new files into `.power/schemas/sharepointonline/`. Regenerate `connectorSchemas.ts` before type-checking so the new list is wired into the runtime schema map:

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
npm run generate-schemas
npx --no-install tsc --noEmit
```

Fix TypeScript errors before proceeding.

### Step 12: Update Memory Bank

Update `memory-bank.md` with: connector added, site URL, lists/libraries connected (or created), type-check status.

> **Note:** No manual executor wiring needed. `PowerAppsProvider` in `app/_layout.tsx` handles SharePoint connector routing, connection resolution, and OAuth consent automatically at runtime.
