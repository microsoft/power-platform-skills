---
name: setting-up-web-api
description: Configures Web API access, table permissions, web roles, and site settings for Power Pages. Use when setting up table permissions, entity permissions, CRUD access, site settings for Web API, or updating frontend to fetch from Dataverse.
user-invocable: true
allowed-tools: ["Read", "Write", "Grep", "Glob", "Bash", "TodoWrite", "AskUserQuestion", "Skill", "Task"]
model: opus
---

**📋 [Shared Instructions](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Read before starting.

# Setup Web API

**References:** [site-settings](./site-settings-reference.md) | [web-roles](./web-roles-reference.md) | [table-permissions](./table-permissions-reference.md) | [frontend-integration](./frontend-integration-reference.md) | [troubleshooting](./troubleshooting.md)

## Workflow

1. **Check Context** → Read memory bank, get table name mapping from `/setup-dataverse`
2. **Create Site Settings** → `Webapi/{table}/enabled` and `fields` for each table
3. **Create Web Roles** → Verify/create Anonymous, Authenticated, custom roles
4. **Create Table Permissions** → Link to web roles with appropriate scope
5. **Update Frontend** → Replace ALL mock data with `/_api` calls
6. **Build and Upload** → Deploy and verify

---

## Step 1: Check Context

Read `memory-bank.md`. **Critical**: Get the **Table Name Mapping** - use actual logical names (may differ from `{prefix}_tablename` for reused tables).

If continuing from `/setup-dataverse`, list tables to configure. Otherwise ask for project path and tables.

---

## Step 2: Create Site Settings

See [site-settings-reference.md](./site-settings-reference.md).

For each table, create in `.powerpages-site/site-settings/`:
1. `Webapi-<table>-enabled.sitesetting.yml`
2. `Webapi-<table>-fields.sitesetting.yml` - **explicit field names only, never `*`**

Also create authoring tool setting per [authoring-tool-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/authoring-tool-reference.md).

---

## Step 3: Create Web Roles

See [web-roles-reference.md](./web-roles-reference.md).

Create roles **before** table permissions using YAML files in `.powerpages-site/web-roles/`.

| Feature | Role |
|---------|------|
| Public content | Anonymous Users |
| Form submissions | Anonymous Users (create-only) |
| User dashboard | Authenticated Users |
| Customer portal | Custom role |

**Steps:**
1. Check existing roles in `.powerpages-site/web-roles/` (created after first upload)
2. Create custom role YAML files as needed:
   ```yaml
   anonymoususersrole: false
   authenticatedusersrole: false
   id: <GENERATE_UUID>
   name: Customers
   ```
3. Upload to apply: `pac pages upload-code-site`

---

## Step 4: Create Table Permissions

See [table-permissions-reference.md](./table-permissions-reference.md).

| Data Type | Scope | Permissions | Role |
|-----------|-------|-------------|------|
| Public content | Global | Read | Anonymous |
| Form submissions | Global | Create | Anonymous |
| User data | Self | Read, Write | Authenticated |

Use `New-TablePermission` and link to web roles from Step 3.

---

## Step 5: Update Frontend

See [frontend-integration-reference.md](./frontend-integration-reference.md).

1. Create `src/services/webApi.ts` with CSRF token handling
2. Create entity-specific wrappers
3. **Replace ALL mock data** - search and destroy:

```powershell
# Find mock folders/files
Get-ChildItem -Path ./src -Directory -Recurse | Where-Object { $_.Name -match "^(mock|data|fixtures)$" }
Get-ChildItem -Path ./src -Recurse -Include "*.data.ts","*mock*.ts"
```

**Verify before Step 6:**
- [ ] No mock folders/files remain
- [ ] No inline hardcoded arrays
- [ ] All components use `webApi` service

---

## Step 6: Build and Upload

```powershell
pac auth list  # Show available environments
```

**Ask user which environment** to upload to using `AskUserQuestion` (show org names from auth list). Switch if needed: `pac auth select --index <n>`.

**Create skill tracking setting, build, and upload:**
```powershell
New-SkillTrackingSetting -ProjectRoot $projectRoot -SkillName "SetupWebApi"
npm run build  # Always build before upload
pac pages upload-code-site --rootPath "<PROJECT_ROOT>"
```

See [authoring-tool-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/authoring-tool-reference.md) for helper function.

**Test in browser console:**
```javascript
fetch('/_api/{prefix}_products').then(r => r.json()).then(d => console.log(d.value))
```

Update memory-bank.md. Cleanup per [cleanup-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/cleanup-reference.md).
