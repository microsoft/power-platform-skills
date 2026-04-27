---
name: audit-permissions
description: >-
  Audits existing table permissions on a Power Pages site by analyzing them against site code
  and Dataverse metadata. Generates an HTML audit report with findings grouped by severity
  (critical, warning, info, pass) and suggests fixes for issues found. Use when the user wants
  to review, verify, or check table permissions for security issues.
user-invocable: true
argument-hint: "[optional: specific table or concern]"
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, Agent
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Audit Permissions

Audit existing table permissions on a Power Pages code site. Analyze permissions against the site code and Dataverse metadata, then generate a visual HTML audit report with findings, reasoning, and suggested fixes.

## Workflow

1. **Verify Site Deployment** — Check that `.powerpages-site` folder and table permissions exist
2. **Gather Configuration** — Read all web roles, table permissions, and site code
3. **Run Local Schema Validation** — Use the shared validator to detect invalid permission/site-setting YAML before deeper analysis
4. **Analyze & Discover** — Query Dataverse for relationships and lookup columns using deterministic scripts
5. **Run Audit Checks** — Compare permissions against code usage and best practices
6. **Generate Report** — Create the HTML audit report and display in browser
7. **Present Findings & Track** — Summarize findings, record skill usage, and ask user if they want to fix issues

**Important:** Do NOT ask the user questions during analysis. Autonomously gather all data, then present findings.

## Task Tracking

At the start of Step 1, create all tasks upfront using `TaskCreate`. Mark each task `in_progress` when starting and `completed` when done.

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Verify site deployment | Verifying site deployment | Check .powerpages-site folder and table permissions exist |
| Gather configuration | Gathering configuration | Read web roles, table permissions, and site code |
| Run local schema validation | Validating local permissions schema | Run shared validator against existing table permission and site setting YAML |
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

If no `.powerpages-site` folder exists, stop and tell the user to deploy first using `/deploy-site`.
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
- `contactrelationship`, `accountrelationship` (if Contact/Account scope)
- `parententitypermission`, `parentrelationship` (if parent scope)

### 2.3 Analyze Site Code

Search the site source code for:

- Web API calls (`/_api/`)
- Lookup bindings (`@odata.bind`)
- File uploads (`uploadFileColumn`, `uploadFile`, `upload*Photo`, `upload*Image`)
- `$expand` usage (`$expand`, `buildExpandClause`, `ExpandOption`)

Also check for `.datamodel-manifest.json` in the project root for the authoritative table list.

Build a map of: which tables are referenced in code, which CRUD operations are performed on each, which lookup relationships are used, and which related tables are fetched via `$expand` (these need read permissions too).

### 2.4 Run Shared Schema Validator

Run the shared validator against the existing site:

```powershell
$schemaValidation = node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-permissions-schema.js" --projectRoot "<PROJECT_ROOT>"
```

Parse the JSON output and carry the findings into the audit. Treat:

- `error` findings as **critical**
- `warning` findings as **warning**
- `info` findings as **info**

These findings should be included in the final audit report even if the later code/Dataverse analysis also finds additional issues.

After Step 3.1 determines `$envUrl`, if this audit is running locally with Dataverse access available, rerun the shared validator with live relationship verification enabled and merge any additional findings:

```powershell
$schemaValidation = node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-permissions-schema.js" --projectRoot "<PROJECT_ROOT>" --validate-dataverse-relationships --envUrl "$envUrl"
```

Use this Dataverse-backed relationship validation only for local runs. Do **not** require it in CI or other offline contexts.

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

The script returns a JSON array of `{ logicalName, targets }` for each lookup column.

After querying **all** tables with create or write permissions, build two maps from the combined results:

1. **Source map** (table → lookup columns): For each queried table, record which lookup columns it has and their targets. Used in Section H2 to check `appendto` on the source table.
2. **Reverse target map** (target table → list of source tables): For each target table found in any lookup's `targets` array, record which source table(s) reference it. Used in Section H to check `append` on the target table.

Example: querying `order_item` returns `[{ logicalName: "cr4fc_orderid", targets: ["cr4fc_order"] }]`
- Source map: `order_item → [{ column: "cr4fc_orderid", targets: ["cr4fc_order"] }]`
- Reverse target map: `cr4fc_order → [{ sourceTable: "order_item", column: "cr4fc_orderid" }]`

Both maps are used in Sections H and H2:
- The **source table** (with the lookup) needs `appendto: true` — it links TO other records (checked via the source map)
- Each **target table** in `targets` needs `append: true` — other records link TO it (checked via the reverse target map)

### 3.3 Query Relationships

For tables with parent-scope permissions, verify the relationship names using the relationship query script:

```powershell
$rels = node "${CLAUDE_PLUGIN_ROOT}/skills/audit-permissions/scripts/query-table-relationships.js" --envUrl "$envUrl" --table "<parent_table>"
```

The script returns a JSON array of `{ schemaName, referencedEntity, referencingEntity, referencingAttribute }`. Use `schemaName` to validate the `parentrelationship` value in parent-scope permissions.

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

**H. Append (target table check)**

Does this table need `append: true`? Append is required on the **target** table — the table that other records link TO via lookup columns.

- Check the **reverse target map** from Step 3.2: is this table referenced as a lookup target by any other table that has `create` or `write` permissions?
- Also search the service code for `@odata.bind` references to this table's entity set (e.g., `/<entity_set>(`)
- If this table appears in the reverse target map (i.e., another table with create/write has a lookup to this table), but `append: false` → finding:
  - **Severity:** `critical`
  - **Title:** `Missing append on <table>`
  - **Reasoning:** Table `<source_table>` has lookup column `<column>` targeting this table and sets it during create/write. The target table needs append permission so records can be linked to it. Users will see "You don't have permission to associate or disassociate"
  - **Fix:** Enable `append: true`
- If `append: true` and justified → `pass`
- If `append: true` but this table does NOT appear in the reverse target map and no code references it as a lookup target → finding:
  - **Severity:** `info`
  - **Title:** `Append enabled but not needed on <table>`
  - **Reasoning:** No other table with create/write has a lookup to this table — append may be unnecessary
  - **Fix:** Consider disabling `append` if not needed

**H2. AppendTo (source table check)**

Does this table need `appendto: true`? AppendTo is required on the **source** table — the table that has lookup columns linking TO other records.

- Check the **source map** from Step 3.2: does this table have lookup columns?
- Also search the service code for `@odata.bind` patterns in create/update calls for this table
- If this table has lookup columns (in source map or code) AND has `create` or `write` enabled, but `appendto: false` → finding:
  - **Severity:** `critical`
  - **Title:** `Missing appendto on <table>`
  - **Reasoning:** This table sets lookup column `<column>` targeting `<target_table>` during create/write, which requires appendto permission. Users will see "You don't have permission to associate or disassociate"
  - **Fix:** Enable `appendto: true`
- If `appendto: true` and justified → `pass`

**I. Parent Chain Integrity**

If the permission has Parent scope (`756150003`):

- Verify `parententitypermission` references a valid permission ID that exists
- Verify `parentrelationship` is a valid Dataverse relationship (if API available, using Step 3.3 results)
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

1. **Append/AppendTo consistency:** Using the source map and reverse target map from Step 3.2, verify: (a) every source table (with lookups and create/write) has `appendto: true`, (b) every target table in the reverse map has `append: true`, (c) no table has `appendto: true` without lookup columns in the source map, (d) no table has `append: true` without being in the reverse target map
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

**Do NOT generate HTML manually or read/modify the template yourself.** Use the `render-audit-report.js` script which mechanically reads the template and replaces placeholder tokens with your data.

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
  "append": true,
  "appendto": false
}
```

### 5.3 Render the HTML File

Run the render script (it creates the output directory if needed):

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/render-audit-report.js" --output "<OUTPUT_PATH>" --data "<DATA_JSON_PATH>"
```

The render script refuses to overwrite existing files. Before calling it, check if the default output path (`<PROJECT_ROOT>/docs/permissions-audit.html`) already exists. If it does, choose a new descriptive filename based on context — e.g., `permissions-audit-apr-2026.html`, `permissions-audit-post-migration.html`. Pass the chosen name via `--output`.

Delete the temporary data JSON file after the script succeeds.

### 5.4 Open in Browser

Open the actual output path in the user's default browser.

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
4. **Ask the user** using `AskUserQuestion`: "Would you like me to fix any of these issues? I can create or update table permissions to resolve the critical and warning findings."

If the user wants fixes applied:

- **For 403 / Web API access issues** (missing table permissions, missing CRUD flags, incorrect scope, missing append/appendto, missing `$expand` read coverage — any finding that would result in a 403 Forbidden response from the Power Pages Web API): Spawn the **table-permissions-architect** agent using the `Agent` tool. Pass it a prompt that includes the specific tables, the required CRUD flags, scope recommendations, and relationship details from the audit findings. The agent will analyze the site, propose a permissions plan, and create the correct table permission YAML files after user approval. Example prompt: `"Create table permissions for the following tables based on audit findings: <table1> needs Global scope with read:true; <table2> needs Parent scope under <parent_table> with read:true, create:true, append:true; <table3> needs appendto:true for lookups from <source_table>. The site project root is <PROJECT_ROOT>."`
- **For non-permission issues** (e.g., unused permissions, scope narrowing suggestions, informational findings): explain what manual changes are needed or suggest running `/integrate-webapi` so the Web API settings architect can address site-setting-level issues.

---

## Critical Constraints

- **Read-only analysis**: This skill only reads existing configuration and code. It does NOT modify any files unless the user explicitly asks to fix issues.
- **Deterministic API calls**: Always use the Node.js scripts (`query-table-lookups.js`, `query-table-relationships.js`) for Dataverse API queries — never use inline PowerShell `Invoke-RestMethod` calls.
- **No questions during analysis**: Autonomously gather all data, run checks, and present findings. Only ask the user at the end about fixing issues.
- **Security**: Never log or display auth tokens. The scripts handle token acquisition internally via `getAuthToken()`.
- **Graceful degradation**: If Dataverse API scripts fail (exit code 1), skip API-dependent checks (H/H2 append/appendto validation, I parent chain integrity) and note in the report which checks were skipped.
