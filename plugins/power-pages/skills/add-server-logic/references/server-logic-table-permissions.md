# Server logic table permissions

Read only when an approved server logic uses the Dataverse connector.

## Phase 6: Configure Table Permissions (Conditional)

**Goal**: Set up table permissions for Dataverse tables accessed by `Server.Connector.Dataverse` in the server logic code

**This phase only runs when the server logic uses `Server.Connector.Dataverse`.** If the server logic only uses `Server.Connector.HttpClient` (external APIs) or doesn't access Dataverse at all, skip this phase entirely and proceed to Phase 7.

`Server.Connector.Dataverse` does **NOT** bypass table permissions - it respects them. Without table permissions configured, the Dataverse connector silently returns 0 records instead of the actual data. This is a common source of confusion.

**Actions**:

### 6.1 Detect Dataverse Tables and Required Privileges

Parse the server logic `.js` file created in Phase 5 to identify which Dataverse tables are accessed and what CRUD operations are performed:

| Dataverse SDK Method | Required Table Permission |
|---------------------|--------------------------|
| `RetrieveMultipleRecords("tablename", ...)` | Read |
| `RetrieveRecord("tablename", ...)` | Read |
| `CreateRecord("tablename", ...)` | Create |
| `UpdateRecord("tablename", ...)` | Write |
| `DeleteRecord("tablename", ...)` | Delete |

Extract the entity set name (first argument) from each method call. Build a mapping:

| Table (entity set name) | Read | Create | Write | Delete |
|------------------------|:----:|:------:|:-----:|:------:|
| `accounts` | Yes | - | - | - |
| `contacts` | Yes | Yes | - | - |

### 6.2 Plan and create permissions

When an approved endpoint uses `Server.Connector.Dataverse`, use the available table-permission planning capability. It must inspect existing permissions and web roles, then propose the least-privilege scope and privileges for each table.

**Prompt:**

> "Inspect this Power Pages site and propose table permissions for Dataverse tables accessed by the approved server logic plan. The following tables need permissions:
>
> [list each table with required CRUD privileges from step 6.1, grouped by server logic item]
>
> Context:
> - These permissions are needed because the server logic uses `Server.Connector.Dataverse`, which respects table permissions - without them, the connector silently returns 0 records.
> - The scope should typically be **Global** for server logic that fetches all records, unless the server logic filters by the current user (in which case use **Contact** scope).
> - The web roles assigned to these server logic items are: [list web role names and GUIDs from Phase 5.2]
> - Project root: [path]
>
> Check for existing table permissions and web roles. If new roles are needed, propose them. Present the complete plan and wait for approval before creating any files. After approval, create the table-permission YAML files with the available scripts."

The planning capability must:
1. Discover existing table permissions and web roles
2. Create any missing web roles via `create-web-role.js` if needed
3. Present the permission plan for user approval
4. After approval, create table permission YAML files in `.powerpages-site/table-permissions/` using `create-table-permission.js`

### 6.3 Git Commit

After table permissions (and any new web roles) are created, do a git commit for the table permissions changes.

**Output**: Table permissions (and web roles if created) configured for all Dataverse tables accessed by the server logic

---
