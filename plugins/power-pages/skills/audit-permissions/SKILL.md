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
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, mcp__plugin_power-pages_playwright__browser_resize, mcp__plugin_power-pages_playwright__browser_navigate, mcp__plugin_power-pages_playwright__browser_wait_for
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
            and inventory, 3) The report was displayed to the user via Playwright or
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
| Run audit checks | Running audit checks | Analyze permissions against code and best practices |
| Generate audit report | Generating audit report | Create HTML report and display in browser |
| Present findings | Presenting findings | Summarize results, record usage, and offer to fix issues |

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

Search the source code to understand which tables the site actually uses:

```text
Grep: "/_api/" in src/**/*.ts src/**/*.tsx src/**/*.js src/**/*.jsx
Grep: "@odata\.bind" in src/**/*.ts src/**/*.tsx
Grep: "uploadFileColumn|uploadFile|upload\w+Photo|upload\w+Image" in src/**/*.ts
```

Also check for `.datamodel-manifest.json` in the project root for the authoritative table list.

Build a map of: which tables are referenced in code, which CRUD operations are performed on each, and which lookup relationships are used.

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

Run every applicable check below. Each check produces a finding with severity, title, reasoning, and a suggested fix. Findings can be `critical`, `warning`, `info`, or `pass`.

### Check Categories

#### 4.1 Missing Permissions (Critical)

For each table referenced in site code (from Step 2.3), verify that a table permission exists. If a table is used in code but has no permission:
- **Severity:** `critical`
- **Title:** `Missing permission for <table>`
- **Reasoning:** Explain which code file references this table and what operations it performs
- **Fix:** Suggest creating a permission with the appropriate scope and CRUD flags

#### 4.2 Overly Broad Scope (Warning)

For each permission with Global scope (`756150000`) that has `write` or `delete` enabled:
- **Severity:** `warning`
- **Title:** `Global scope with write/delete on <table>`
- **Reasoning:** Explain why Global write/delete is risky — any user with this role can modify/delete any record
- **Fix:** Suggest narrowing to Contact or Account scope, or removing write/delete if not needed

For Global scope with only `read` enabled, this is acceptable for public reference data — mark as `pass`.

#### 4.3 Missing Append/AppendTo (Critical)

For each permission with `create` or `write` enabled, check if the table has lookup columns (from Step 3.2). If lookups exist:
- The **source table** (with the lookup) needs `append: true`
- The **target table** needs `appendto: true`

If these are missing:
- **Severity:** `critical`
- **Title:** `Missing append on <source_table>` or `Missing appendto on <target_table>`
- **Reasoning:** Explain which lookup column requires this and what error the user will see ("You don't have permission to associate or disassociate")
- **Fix:** Suggest enabling the missing flag

#### 4.4 Orphaned Permissions (Info)

For each permission, check if the table is actually referenced in the site code. If not:
- **Severity:** `info`
- **Title:** `Unused permission for <table>`
- **Reasoning:** The table is not referenced in any source code — the permission may be unnecessary
- **Fix:** Suggest reviewing whether this permission is still needed

#### 4.5 Missing Web Role Association (Warning)

For each permission where `adx_entitypermission_webrole` is empty or missing:
- **Severity:** `warning`
- **Title:** `Permission <name> has no web role association`
- **Reasoning:** A permission without a web role association has no effect — no users will receive this access
- **Fix:** Suggest associating with the appropriate web role

#### 4.6 Parent Chain Integrity (Critical)

For each permission with Parent scope (`756150003`):
- Verify `parententitypermission` references a valid permission ID that exists
- Verify `parentrelationshipname` is a valid Dataverse relationship (if API available, using Step 3.3 results)

If broken:
- **Severity:** `critical`
- **Title:** `Broken parent chain for <permission>`
- **Reasoning:** The parent permission reference is invalid — this permission will not grant any access
- **Fix:** Suggest correcting the parent reference

#### 4.7 Write Without Read (Warning)

For each permission with `write: true` but `read: false`:
- **Severity:** `warning`
- **Title:** `Write enabled without read on <table>`
- **Reasoning:** Users can modify records they cannot see, which is unusual and likely unintended
- **Fix:** Suggest enabling read

#### 4.8 File Upload Without Write (Warning)

If the code contains file upload patterns (detected in Step 2.3) but the table's permission has `write: false`:
- **Severity:** `warning`
- **Title:** `File upload detected but write is disabled on <table>`
- **Reasoning:** File uploads use PATCH which requires write permission
- **Fix:** Suggest enabling write on the permission

#### 4.9 Passed Checks

For each check that passes (e.g., a table has correct permissions, a scope is appropriate), create a `pass` severity finding briefly noting what was verified. This gives the user confidence that the audit was thorough.

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

1. Use `browser_resize` with **width: 1920** and **height: 1080**
2. Navigate Playwright to the file using `file:///` URL (convert backslashes to forward slashes)
3. Wait ~2 seconds for rendering

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
