---
name: audit-permissions
description: >-
  Use this skill to audit existing table permissions on a Power Pages site.
  Trigger examples: "audit permissions", "check permissions", "review table permissions",
  "are my permissions correct", "permission security audit", "verify permissions setup",
  "check for permission issues", "permission health check".
  This skill analyzes existing table permissions against the site code and Dataverse metadata,
  generates an HTML audit report with findings grouped by severity (critical, warning, info, pass),
  and suggests fixes for any issues found.
user-invocable: true
argument-hint: "[optional: specific table or concern]"
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: opus
hooks:
  Stop:
    - hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/audit-permissions/scripts/validate-audit.js"'
          timeout: 15
        - type: prompt
          prompt: >
            If a permissions audit was being performed in this session (via /power-pages:audit-permissions),
            verify before allowing stop: 1) The site's permissions structure was analyzed (web roles,
            table permissions, code references), 2) An HTML audit report was generated with findings
            and inventory, 3) The report was opened in the default browser or
            the file path was communicated, 4) A summary with finding counts was presented. If any of
            these are incomplete, return { "ok": false, "reason": "<specific issues>" }. If no audit
            work happened or everything is complete, return { "ok": true }.
          timeout: 30
---

# Audit Permissions

Audit existing table permissions on a Power Pages code site. Analyze permissions against the site code and Dataverse metadata, then generate a visual HTML audit report with findings, reasoning, and suggested fixes.

## Workflow

1. **Verify Site Deployment** — Check that `.powerpages-site` folder and table permissions exist
2. **Gather Configuration** — Read all web roles, table permissions, and site code
3. **Analyze & Discover** — Query Dataverse for relationships and lookup columns using deterministic scripts
4. **Run Audit Checks** — Compare permissions against code usage and best practices
5. **Generate Report** — Create the HTML audit report and display in browser
6. **Present Findings & Track** — Summarize findings, record skill usage, and ask user if they want to fix issues

**Important:** Do NOT ask the user questions during analysis. Autonomously gather all data, then present findings.

## Task Tracking

At the start of Step 1, create all tasks upfront using `TaskCreate`. Mark each task `in_progress` when starting and `completed` when done.

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Verify site deployment | Verifying site deployment | Check .powerpages-site folder and table permissions exist |
| Gather configuration | Gathering configuration | Read web roles, table permissions, and site code |
| Discover relationships | Discovering relationships | Query Dataverse for lookup columns and relationships |
| Run audit checks | Running audit checks | Create per-table tasks and run checklist (A–K) for each table, then cross-validate |
| Generate audit report | Generating audit report | Create HTML report and display in browser |
| Present findings | Presenting findings | Summarize results, record usage, and offer to fix issues |

**Note:** The "Run audit checks" phase creates **additional per-table tasks** dynamically in Step 4.2. These per-table tasks track the systematic A–K checklist for each table independently.

---

## Step 1: Verify Site Deployment

Use `Glob` to find:
- `**/powerpages.config.json` — identifies the project root
- `**/.powerpages-site/table-permissions/*.tablepermission.yml` — existing permissions

If no `.powerpages-site` folder exists, stop and tell the user to deploy first using `/power-pages:deploy-site`.
If no table permissions exist, note this as a critical finding (the site may have no data access configured) and continue the audit — there may still be code references that need permissions.

---

## Step 2: Gather Configuration

### 2.1 Read Web Roles

Read all files matching `**/.powerpages-site/web-roles/*.yml`. Extract `id`, `name`, `anonymoususersrole`, `authenticatedusersrole` from each.

### 2.2 Read Table Permissions

Read all files matching `**/.powerpages-site/table-permissions/*.tablepermission.yml`. For each permission, extract:
- `entityname` (permission name)
- `entitylogicalname` (table)
- `scope` (numeric code)
- `read`, `create`, `write`, `delete`, `append`, `appendto` (boolean flags)
- `adx_entitypermission_webrole` (array of web role UUIDs)
- `parententitypermission`, `parentrelationshipname` (if parent scope)

### 2.3 Analyze Site Code

Search the site source code for:

- Web API calls (`/_api/`)
- Lookup bindings (`@odata.bind`)
- File uploads (`uploadFileColumn`, `uploadFile`, `upload*Photo`, `upload*Image`)
- `$expand` usage (`$expand`, `buildExpandClause`, `ExpandOption`)

Also check for `.datamodel-manifest.json` in the project root for the authoritative table list.

Build a map of: which tables are referenced in code, which CRUD operations are performed on each, which lookup relationships are used, and which related tables are fetched via `$expand` (these need read permissions too).

---

## Step 3: Analyze & Discover (Dataverse API)

Use deterministic Node.js scripts for all Dataverse API calls. These scripts handle auth token acquisition, HTTP requests, and JSON parsing consistently.

### 3.1 Get Environment URL

```powershell
pac env who
```

Extract the `Environment URL` (e.g., `https://org12345.crm.dynamics.com`). Store as `$envUrl`.

### 3.2 Query Lookup Columns

For each table that has permissions with `create` or `write` enabled, use the lookup query script:

```powershell
$lookups = node "${CLAUDE_PLUGIN_ROOT}/skills/audit-permissions/scripts/query-table-lookups.js" --envUrl "$envUrl" --table "<table_logical_name>"
```

The script returns a JSON array of `{ logicalName, targets }` for each lookup column. Use this to build the append/appendto map:
- The **source table** (with the lookup) needs `append: true`
- Each **target table** in `targets` needs `appendto: true`

### 3.3 Query Relationships

For tables with parent-scope permissions, verify the relationship names using the relationship query script:

```powershell
$rels = node "${CLAUDE_PLUGIN_ROOT}/skills/audit-permissions/scripts/query-table-relationships.js" --envUrl "$envUrl" --table "<parent_table>"
```

The script returns a JSON array of `{ schemaName, referencedEntity, referencingEntity, referencingAttribute }`. Use `schemaName` to validate the `parentrelationshipname` value in parent-scope permissions.

### Error Handling

If any script exits with code 1, skip the API-dependent checks and note which checks were skipped in the report. Do NOT stop the entire audit for auth errors. Use the data model manifest and code analysis as fallback.

---

## Step 4: Run Audit Checks

Use per-table task tracking to systematically run every audit check. Each check produces a finding with severity, title, reasoning, and a suggested fix. Findings can be `critical`, `warning`, `info`, or `pass`.

### 4.1 Build Audit Inventory

First, build a combined list of all tables to audit from two sources:

1. **Tables referenced in code** (from Step 2.3) — these may or may not have permissions
2. **Tables with existing permissions** (from Step 2.2) — these may or may not be referenced in code

The union of these two sets is the complete audit scope. Each table will be audited from both directions: "does the code need a permission that doesn't exist?" and "does the permission match what the code actually does?"

### 4.2 Create Per-Table Audit Tasks

For each table in the audit inventory, create a task:

```
TaskCreate:
  subject: "Audit <table_logical_name>"
  activeForm: "Auditing <table_display_name> permissions"
  description: "Run all audit checks for <table_logical_name>"
```

Also create a summary task:

```
TaskCreate:
  subject: "Compile audit findings"
  activeForm: "Compiling audit findings"
  description: "Combine all per-table findings into the final report"
```

Use `TaskList` at any point to review progress and see which tables still need auditing.

### 4.3 Per-Table Audit Checklist

For each table, mark its task `in_progress` and run through the following checks **in order**. For every finding, note the **specific evidence** (file path, permission name, code pattern) that supports it. Skip checks that don't apply to this table.

**A. Permission Existence**

Does this table have a table permission?
- If the table is referenced in code but has **no permission** → finding:
  - **Severity:** `critical`
  - **Title:** `Missing permission for <table>`
  - **Reasoning:** Which code files reference this table and what operations they perform
  - **Fix:** Create a permission with the appropriate scope and CRUD flags
- If a permission exists but the table is **not referenced in code** → finding:
  - **Severity:** `info`
  - **Title:** `Unused permission for <table>`
  - **Reasoning:** The table is not referenced in any source code — the permission may be unnecessary
  - **Fix:** Review whether this permission is still needed
- If both exist → `pass`, proceed to remaining checks

**B. Web Role Association**

Does the permission have web role(s) assigned?
- Check `adx_entitypermission_webrole` — if empty or missing → finding:
  - **Severity:** `warning`
  - **Title:** `Permission <name> has no web role association`
  - **Reasoning:** A permission without a web role has no effect — no users will receive this access
  - **Fix:** Associate with the appropriate web role
- If roles are assigned → `pass`

**C. Scope Appropriateness**

Is the scope the least-privileged option that fits?
- Search the service code for scope-relevant patterns: contact-scoped filters (`getCurrentContactId`, `_contactid_value`, `contactid`) and account-scoped filters (`_accountid_value`, `parentcustomerid`)
- If Global scope (`756150000`) with `write` or `delete` enabled → finding:
  - **Severity:** `warning`
  - **Title:** `Global scope with write/delete on <table>`
  - **Reasoning:** Any user with this role can modify/delete any record in this table
  - **Fix:** Narrow to Contact or Account scope, or remove write/delete if not needed
- If Global scope with only `read` → `pass` (acceptable for public reference data)
- If code uses contact-scoped filters but permission uses Global → finding:
  - **Severity:** `warning`
  - **Title:** `Scope could be narrower for <table>`
  - **Reasoning:** Code filters by current contact but permission grants Global access
  - **Fix:** Narrow to Contact scope
- Otherwise → `pass`

**D. Read Permission**

Is `read` correctly set?
- Search the service code for GET/list/get patterns for this table: API calls to `/_api/<entity_set>`, list/get functions (`list<TableName>`, `get<TableName>`)
- If code reads this table but `read: false` → finding:
  - **Severity:** `critical`
  - **Title:** `Missing read permission for <table>`
  - **Reasoning:** Code reads from this table but permission does not grant read access
  - **Fix:** Enable `read: true`
- If `read: true` and code reads → `pass`

**E. Create Permission**

Is `create` correctly set?
- Search the service code for POST/create patterns: POST method usage (`method: 'POST'`), create functions (`create<TableName>`)
- If code creates records but `create: false` → finding:
  - **Severity:** `critical`
  - **Title:** `Missing create permission for <table>`
  - **Reasoning:** Code creates records in this table but permission does not grant create access
  - **Fix:** Enable `create: true`
- If `create: true` but no create patterns in code → finding:
  - **Severity:** `info`
  - **Title:** `Create enabled but not used for <table>`
  - **Reasoning:** No create operations found in code — permission may be overly permissive
  - **Fix:** Consider disabling `create` if not needed
- If matched → `pass`

**F. Write Permission**

Is `write` correctly set?
- Search the service code for PATCH/update/upload patterns: PATCH method usage (`method: 'PATCH'`), update functions (`update<TableName>`), file upload patterns (`uploadFileColumn`, `uploadFile`, `upload*Photo`, `upload*Image`, `upload*File`)
- If code updates records but `write: false` → finding:
  - **Severity:** `critical`
  - **Title:** `Missing write permission for <table>`
  - **Reasoning:** Code updates records (or uploads files) in this table but permission does not grant write access
  - **Fix:** Enable `write: true`
- If file upload patterns found but `write: false` → finding:
  - **Severity:** `warning`
  - **Title:** `File upload detected but write is disabled on <table>`
  - **Reasoning:** File uploads use PATCH which requires write permission
  - **Fix:** Enable `write: true`
- If `write: true` but `read: false` → finding:
  - **Severity:** `warning`
  - **Title:** `Write enabled without read on <table>`
  - **Reasoning:** Users can modify records they cannot see, which is unusual and likely unintended
  - **Fix:** Enable `read: true`
- If `write: true` but no write patterns in code → finding:
  - **Severity:** `info`
  - **Title:** `Write enabled but not used for <table>`
  - **Reasoning:** No update operations found in code — permission may be overly permissive
  - **Fix:** Consider disabling `write` if not needed
- If matched → `pass`

**G. Delete Permission**

Is `delete` correctly set?
- Search the service code for DELETE patterns: DELETE method usage (`method: 'DELETE'`), delete functions (`delete<TableName>`)
- If code deletes records but `delete: false` → finding:
  - **Severity:** `critical`
  - **Title:** `Missing delete permission for <table>`
  - **Reasoning:** Code deletes records in this table but permission does not grant delete access
  - **Fix:** Enable `delete: true`
- If `delete: true` but no delete patterns in code → finding:
  - **Severity:** `info`
  - **Title:** `Delete enabled but not used for <table>`
  - **Reasoning:** No delete operations found in code — permission may be overly permissive
  - **Fix:** Consider disabling `delete` if not needed
- If matched → `pass`

**H. Append/AppendTo**

Are `append` and `appendto` correctly set?
- If this table has `create` or `write` enabled, search the service code for lookup column usage (`@odata.bind` patterns for this table, from Step 3.2)
- If lookups exist and `append: false` → finding:
  - **Severity:** `critical`
  - **Title:** `Missing append on <table>`
  - **Reasoning:** This table sets lookup column `<column>` during create/write, which requires append permission. Users will see "You don't have permission to associate or disassociate"
  - **Fix:** Enable `append: true`
- If this table is the TARGET of a lookup from another table that has create/write, and `appendto: false` → finding:
  - **Severity:** `critical`
  - **Title:** `Missing appendto on <table>`
  - **Reasoning:** Table `<source_table>` has a lookup to this table and sets it during create/write. The target table needs appendto permission.
  - **Fix:** Enable `appendto: true`
- If correctly set → `pass`

**I. Parent Chain Integrity**

If the permission has Parent scope (`756150003`):
- Verify `parententitypermission` references a valid permission ID that exists
- Verify `parentrelationshipname` is a valid Dataverse relationship (if API available, using Step 3.3 results)
- If broken → finding:
  - **Severity:** `critical`
  - **Title:** `Broken parent chain for <permission>`
  - **Reasoning:** The parent permission reference is invalid — this permission will not grant any access
  - **Fix:** Correct the parent permission ID and/or relationship name
- If valid → `pass`

**J. $expand Related Table Coverage**

Is this table fetched via `$expand` on another table's query?
- Check the `$expand` analysis from Step 2.3 (search site source code for `$expand`, `buildExpandClause`, `ExpandOption`)
- If this table is expanded from another table but has no table permission with `read: true` for the same web role → finding:
  - **Severity:** `critical`
  - **Title:** `Missing read permission for expanded table <table>`
  - **Reasoning:** This table is fetched via `$expand` on `<parent_table>` in `<service_file>`, but has no read permission. Power Pages enforces table permissions on every entity in the query.
  - **Fix:** Create a table permission with `read: true` for the same web role. For collection-valued expansions (one-to-many), use Parent scope with the relationship name. For single-valued expansions (lookups to reference data), use Global scope with read-only access.
- If properly covered → `pass`

**K. Record Findings & Complete**

After all checks, mark the table's task as `completed` via `TaskUpdate`.

### 4.4 Cross-Table Validation

After all per-table audits are complete, run these cross-table checks:

1. **Append/AppendTo consistency:** For every table with `append: true`, verify each lookup target has `appendto: true` and vice versa
2. **$expand coverage:** For every `$expand` usage, verify the expanded table has `read: true`
3. **Parent chain completeness:** For every Parent scope permission, verify the parent permission exists and is valid
4. **Web role consistency:** If two related tables (e.g., parent and child) are accessed by the same feature, verify they share the same web role assignment

Use `TaskList` to review all completed audits, then mark the "Compile audit findings" task as `in_progress` and proceed to Step 5.

---

## Step 5: Generate Report

### 5.1 Determine Output Location

- **If working in context of a website** (project root with `powerpages.config.json` exists): write to `<PROJECT_ROOT>/docs/permissions-audit.html`
- **Otherwise**: write to the system temp directory

### 5.2 Prepare Data

**Do NOT generate HTML manually or read/modify the template yourself.** Use the `render-plan.js` script which mechanically reads the template and replaces placeholder tokens with your data.

Write a temporary JSON data file (e.g., `<OUTPUT_DIR>/audit-data.json`) with these keys:

```json
{
  "SITE_NAME": "The site name (from powerpages.config.json or folder name)",
  "AUDIT_DESC": "Security audit of table permissions for Contoso Portal",
  "SUMMARY": "2-3 sentence summary of the audit results",
  "FINDINGS_DATA": [/* array of finding objects */],
  "INVENTORY_DATA": [/* array of current permission objects */]
}
```

**FINDINGS_DATA format:**

```json
{
  "id": "f1",
  "severity": "critical",
  "title": "Missing permission for cra5b_product",
  "table": "cra5b_product",
  "scope": null,
  "permission": null,
  "reasoning": "The table cra5b_product is referenced in src/services/productService.ts with GET requests to /_api/cra5b_products, but no table permission exists for this table.",
  "fix": "Create a table permission with Global scope and read-only access for the Anonymous Users role.",
  "details": "Referenced in: src/services/productService.ts (line 23), src/components/ProductList.tsx (line 45)"
}
```

- `severity`: One of `critical`, `warning`, `info`, `pass`
- `table`: The table logical name this finding relates to (or `null` for general findings)
- `scope`: The current scope if applicable (numeric code or friendly name), or `null`
- `permission`: The permission name if this finding is about an existing permission, or `null`
- `reasoning`: Detailed explanation of why this is an issue — reference specific code files, line patterns, or Dataverse metadata
- `fix`: Actionable suggestion for how to resolve the issue (or `null` for `pass` findings)
- `details`: Additional context like file references, column names, or relationship details

**INVENTORY_DATA format:**

```json
{
  "name": "Product - Anonymous Read",
  "table": "cra5b_product",
  "scope": "Global",
  "roles": ["Anonymous Users"],
  "read": true,
  "create": false,
  "write": false,
  "delete": false,
  "append": false,
  "appendto": true
}
```

### 5.3 Render the HTML File

Run the render script (it creates the output directory if needed):

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/render-audit-report.js" --output "<OUTPUT_PATH>" --data "<DATA_JSON_PATH>"
```

Delete the temporary data JSON file after the script succeeds.

### 5.4 Open in Browser

Open the generated HTML file in the user's default browser:

```powershell
Start-Process "<OUTPUT_PATH>"
```

---

## Step 6: Present Findings & Track

### 6.1 Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "AuditPermissions"`.

### 6.2 Present Summary

Present a summary to the user:

1. **Critical findings count** — these need immediate attention
2. **Warning findings count** — should be addressed
3. **Report location** — where the HTML file was saved
5. **Ask the user** using `AskUserQuestion`: "Would you like me to fix any of these issues? I can create or update table permissions to resolve the critical and warning findings."

If the user wants fixes applied, use the `${CLAUDE_PLUGIN_ROOT}/scripts/create-table-permission.js` script for new permissions or explain what manual changes are needed for existing permissions. For complex fixes, suggest running `/power-pages:setup-permissions` to architect a complete permissions plan.

---

## Critical Constraints

- **Read-only analysis**: This skill only reads existing configuration and code. It does NOT modify any files unless the user explicitly asks to fix issues.
- **Deterministic API calls**: Always use the Node.js scripts (`query-table-lookups.js`, `query-table-relationships.js`) for Dataverse API queries — never use inline PowerShell `Invoke-RestMethod` calls.
- **No questions during analysis**: Autonomously gather all data, run checks, and present findings. Only ask the user at the end about fixing issues.
- **Security**: Never log or display auth tokens. The scripts handle token acquisition internally via `getAuthToken()`.
- **Graceful degradation**: If Dataverse API scripts fail (exit code 1), skip API-dependent checks (4.3 append/appendto validation, 4.6 relationship verification) and note in the report which checks were skipped.
