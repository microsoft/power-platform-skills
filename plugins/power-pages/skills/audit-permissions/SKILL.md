---
name: audit-permissions
description: >-
  Audits existing table permissions on a Power Pages site by analyzing them against site code
  and Dataverse metadata, then GRADES the configuration with deterministic 1–5 scores across
  3 security/usability/correctness categories (9 dimensions). Detection is anchored by a
  recurring-issue catalog so findings and severities stay consistent run-to-run. Generates an
  HTML report with an at-a-glance verdict and per-category scores in the Overview plus a
  single list of **major/minor** issues (each major issue labelled permissions-only or upstream-caused with a short justification), and suggested fixes.
  Use when the user wants to review, verify, check, score,
  or grade table permissions for security issues.
user-invocable: true
argument-hint: "[optional: specific table or concern]"
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, Agent
model: opus
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Audit Permissions

Audit existing table permissions on a Power Pages code site. Analyze permissions against the site code and Dataverse metadata, then generate a visual HTML report with **deterministic 1–5 category scores**, an advisory verdict, findings, reasoning, and suggested fixes.

The skill has two parts:

1. **Audit checks** (evidence + remediation) — the per-table A–K checklist that compares every permission against real code usage and Dataverse metadata. It is the **primary issue detector**: it catches concrete, code-grounded problems (missing CRUD, append/appendto, `$expand` gaps, broken parent chains, over-provisioned grants) and emits each as a **major/minor** issue with concrete evidence and a fix.
2. **Scoring** (reproducible result) — a **3-category** rubric (9 dimensions) anchored by a **recurring-issue catalog** of fixed detection triggers + severities, followed by a **single consolidation** into root causes and **one batched root-cause attribution** pass for major issues. It turns the findings into **pure-formula 1–5 category scores** so two runs on the same configuration yield the same numbers.

> **Golden rule of scoring:** you only ever **find and label issues** (`major` / `minor`). You do NOT invent the numeric score. The 1–5 numbers come from a **fixed formula** applied to the issue counts (see [Appendix A](#appendix-a--scoring-model)). Same issue set ⇒ same score.

## Workflow

1. **Verify Site Deployment** — Check that `.powerpages-site` folder and table permissions exist
2. **Gather Configuration** — Read web roles, table permissions, site code, run the shared schema validator, and build the deterministic preflight cross-reference
3. **Analyze & Discover** — Query Dataverse for relationships and lookup columns using deterministic scripts
4. **Run Audit Checks** — Compare permissions against code usage and best practices (A–K checklist)
5. **Score the Configuration** — Detect/label issues by the 3 categories using the recurring-issue catalog, consolidate to distinct root causes (major/minor), compute the 1–5 category scores and the verdict
6. **Root-cause attribution** — In a single batched pass, label every major issue as permissions-only or caused by an upstream artifact, with a one-sentence justification shown in the report
7. **Generate Report** — Create the HTML report (score overview + findings + inventory) and validate it
8. **Present Findings & Track** — Summarize, record skill usage, and ask the user if they want to fix issues

**Important:** Do NOT ask the user questions during analysis. Autonomously gather all data, then present findings.

## Audit completion telemetry

At the very start of Step 1, before site verification, initialize local run state:

```bash
node "${PLUGIN_ROOT}/scripts/emit-audit-permissions-telemetry.js" --action start
```

Parse the JSON stdout and retain its `auditRunId` as `<AUDIT_RUN_ID>` for this invocation. The command does not emit a telemetry event; the existing generic skill invocation event is the start signal. The local run state provides the opaque random ID and start time needed for completion telemetry. Never derive the ID from, or replace it with, a site, environment, tenant, user, path, or report value.

Telemetry is best-effort and must never block the audit. If the initialization command fails or returns no `auditRunId`, continue the audit without completion telemetry. Do not invent an id and do not search local state for the latest run.

On every controlled terminal failure after a run id was returned, close the run before stopping:

```bash
node "${PLUGIN_ROOT}/scripts/emit-audit-permissions-telemetry.js" \
  --action complete \
  --runId "<AUDIT_RUN_ID>" \
  --outcome failure \
  --failureStage "<FAILURE_STAGE>"
```

Use exactly one of these fixed failure stages:

- `site_verification`
- `configuration_gathering`
- `schema_validation`
- `relationship_discovery`
- `audit_checks`
- `scoring`
- `root_cause_attribution`
- `report_rendering`
- `report_validation`
- `metrics_validation`
- `unknown_controlled_failure`

Do not pass error messages, paths, table names, finding content, or other user/site data to the telemetry script. A telemetry completion failure does not change the audit outcome and must not trigger a second completion attempt.

## Task Tracking

At the start of Step 1, create all tasks upfront using `TaskCreate`. Mark each task `in_progress` when starting and `completed` when done.

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Verify site deployment | Verifying site deployment | Check .powerpages-site folder and table permissions exist |
| Gather configuration | Gathering configuration | Read web roles, table permissions, site code; run validator; build preflight |
| Discover relationships | Discovering relationships | Query Dataverse for lookup columns and relationships |
| Run audit checks | Running audit checks | Create per-table tasks and run checklist (A–K) for each table, then cross-validate |
| Score configuration | Scoring configuration | Detect/label by the 3 categories via the recurring-issue catalog, consolidate to root causes, compute 1–5 scores |
| Root-cause attribution | Attributing root causes | Label every major issue permissions-only or upstream-caused in a single pass |
| Generate report | Generating report | Create and validate the HTML report and display it in browser |
| Present findings | Presenting findings | Summarize results, record usage, and offer to fix issues |

**Note:** The "Run audit checks" phase creates **additional per-table tasks** dynamically in Step 4.2. These per-table tasks track the systematic A–K checklist for each table independently.

---

## Step 1: Verify Site Deployment

Use `Glob` to find:

- `**/powerpages.config.json` — identifies the project root
- `**/.powerpages-site/table-permissions/*.tablepermission.yml` — existing permissions

If no `.powerpages-site` folder exists, stop and tell the user to deploy first using `/deploy-site`.
If no table permissions exist, note this as a critical finding (the site may have no data access configured) and continue the audit — there may still be code references that need permissions.

Before stopping because `.powerpages-site` is absent, close completion telemetry with `failureStage: site_verification` as described above.

---

## Step 2: Gather Configuration

### Single-pass performance contract

Gather all local evidence in **one bounded pass** before making judgments:

1. Read web roles, table permissions, site settings, and `.datamodel-manifest.json` in grouped operations.
2. Scan source files once for API operations, entity sets, selects, filters, lookups, expands, uploads, routes, imports, and feature/auth gates. Prefer one grouped search plus targeted reads of only the matching regions; never read an entire source tree file-by-file.
3. Locate the permission plan once. Extract all authorization-relevant statements in one operation into `planClaims`; do not reopen or re-extract the plan later.
4. Freeze these facts in `audit-evidence.json`. Steps 4–6 consume only this ledger plus any gated Dataverse results.

Do not rescan source code or the plan to gain confidence. A second read is allowed only when a specific ledger field is missing and the exact file/region needed is known. Record the added evidence once, then continue. Never perform multiple searches for differently worded versions of the same plan claim.

### 2.1 Read Web Roles

Read all files matching `**/.powerpages-site/web-roles/*.yml`. Keys may carry a publisher prefix — try `mspp_<key>`, then `adx_<key>`, then the bare `<key>` (first found wins). Extract `id`, `name`, `anonymoususersrole`, `authenticatedusersrole` from each. If YAML fails to parse or its root isn't an object, record a **parse error** (feeds preflight `IS`).

### 2.2 Read Table Permissions

Read all files matching `**/.powerpages-site/table-permissions/*.tablepermission.yml`. Using the same prefix rule, for each permission extract:

- `entityname` (permission name)
- `entitylogicalname` (table)
- `scope` (numeric code) → map to a label: `756150000 = Global`, `756150001 = Contact`, `756150002 = Account`, `756150003 = Parent`, `756150004 = Self`; anything else → `Unknown(<code>)`; missing → scope `-1`, label `Unknown`
- `read`, `create`, `write`, `delete`, `append`, `appendto` (boolean flags)
- `adx_entitypermission_webrole` (array of web role UUIDs) → resolve each GUID to a role name via §2.1; unresolved → mark `<unresolved:…>`
- `contactrelationship`, `accountrelationship` (if Contact/Account scope)
- `parententitypermission`, `parentrelationship` (if parent scope)

Record a **parse error** on failure (feeds preflight `IS`).

### 2.3 Analyze Site Code

In the single source pass, search the site source code for:

- Web API calls (`/_api/`)
- Lookup bindings (`@odata.bind`)
- File uploads (`uploadFileColumn`, `uploadFile`, `upload*Photo`, `upload*Image`)
- `$expand` usage (`$expand`, `buildExpandClause`, `ExpandOption`)

Also check for `.datamodel-manifest.json` in the project root for the authoritative table list. It has `{ environmentUrl?, tables: [{ logicalName, displayName, status?, columns: [{ logicalName, type }] }] }`. If missing or `tables` isn't an array, treat the data model as absent.

Additionally scan **Web API artifacts** (used by the root-cause attribution in Step 6 — best-effort):

- **Central client**: present if any of `src/shared/powerPagesApi.ts(x)` or `src/lib/powerPagesApi.ts` exists.
- **Service files** under `src/shared/services/**` (`.ts/.tsx/.js/.jsx`): record which data-model table logical names and which HTTP methods (`GET/POST/PATCH/PUT/DELETE`) appear in each.
- **Wildcard column selects**: record every occurrence of `$select=*` (or a `$select` whose value is `*`) in any scanned source file, together with its file path and the table being queried.
- **Type files** under `src/types/**`: extract property names of the first `interface`/`type` literal; infer the table from filename/content when possible.
- **Web API site settings** in `.powerpages-site/site-settings/` (files named `Webapi-*` / `Webapi/*`): parse `name` + `value`. Split `name` on `/`: `Webapi/<entitySet>/enabled` → kind `enabled`; `.../fields` → kind `fields`; `Webapi/error` → `error`; else `other`. `webapiEnabledEntitySets` = entity sets whose `enabled` value is exactly `"true"`. For every `fields` setting also record **`isWildcard`** — true when the trimmed value is `*`, or when any comma-separated entry is `*`. A list that names column logical names is NOT a wildcard, however long it is.

Also scan **authentication/registration site settings** in `.powerpages-site/site-settings/` regardless of filename. Parse `name` + `value` for settings under `Authentication/Registration/`, including `Enabled`, `OpenRegistrationEnabled`, `ExternalLoginEnabled`, and `InvitationEnabled`. Also parse each external provider's `Authentication/<Type>/<Provider>/RegistrationEnabled`; a configured provider (any settings under `Authentication/<Type>/<Provider>/`) without that setting counts as `true`, the server default. Compare names case-insensitively and treat a value as enabled only when its trimmed value is case-insensitively `"true"`. Record missing settings as `unknown`, not `false`.

Build an **audience reachability profile** before judging permissions:

- A role with `authenticatedusersrole: true` is automatically assigned to every signed-in site user; it is a broad baseline role, not proof of staff, employee, teacher, parent, or other trusted-persona membership.
- **Open registration** is proven when `OpenRegistrationEnabled` is `true` and either local registration is on (`Authentication/Registration/Enabled` is `true`) or `ExternalLoginEnabled` is not `false` (missing counts as `true`, the server default) and at least one configured external provider's `RegistrationEnabled` is `true`. External-only sites often omit `Authentication/Registration/Enabled`. With open registration, any visitor can create an account and enter that broad Authenticated Users audience.
- External login or invitation enablement may provide additional entry paths, but do not assume they are open to the public without supporting configuration evidence.
- Carry this profile into every per-table scope and audience check. Do not evaluate a role name or permission in isolation from how users acquire that role.

Build a map of: which tables are referenced in code, which CRUD operations are performed on each, which lookup relationships are used, and which related tables are fetched via `$expand` (these need read permissions too).

Also build a **capability matrix** before judging missing access. One row per authorization-relevant capability:

`persona | route/component | reachability | table | operation | current grant | plan claim | evidence`

Classify `reachability` mechanically:

- `reachable` — the page/component is registered in the deployed router or invoked by another reachable component, and no explicit feature flag or authorization gate disables it for that persona.
- `disabled` — an explicit false feature flag, server-side authorization gate, build exclusion, or unreachable/unregistered component prevents the capability from running.
- `ambiguous` — code exists but neither reachability nor exclusion can be established.

A UI condition based on the signed-in user's own data (for example an `isAccountAdmin` field or a role flag on their profile record) never makes a capability `disabled` — it identifies the persona that uses it. Plan or comment wording such as "deferred", "future phase" or "not yet supported" never makes a routed capability `disabled` or `ambiguous`.

Use this evidence precedence everywhere in the audit: **reachable implementation > explicit runtime gate/build exclusion > implementation plan > comments/names**. A plan cannot make a routed, callable feature hypothetical merely by calling its persona "back-office." Conversely, dead, unregistered, explicitly disabled, or server-gated code does not establish a required portal permission. If reachability is ambiguous and conflicts with the plan, emit at most one **minor** `internal-consistency` issue for the conflict; do not presume a broken flow.

After the source pass, do not reopen routes, pages, services, or the permission plan during scoring. Reachability and plan claims are frozen ledger facts, not questions to reconsider in Step 5.

### 2.4 Run Shared Schema Validator

Run the shared validator against the existing site:

```bash
node "${PLUGIN_ROOT}/scripts/validate-permissions-schema.js" --projectRoot "<PROJECT_ROOT>"
```

Parse the JSON output and carry the findings into the audit as **major/minor** issues. Map:

- `error` findings → **major** issue
- `warning` findings → **major** issue (unless purely forward-looking/cosmetic → **minor**)
- `info` findings → **minor** issue

These findings should be included in the final report even if the later code/Dataverse analysis also finds additional issues. Exception: drop the validator's "no associated web roles" warning for a Parent-scope child permission whose parent chain is valid (see check B).

If the validator reports wildcard field access in a `Webapi/<table>/fields` setting, add this finding as a **major** `security-posture` issue (one per affected setting):

- **Title:** `Unsupported wildcard Web API fields for <table>`
- **Reasoning:** The fields setting uses wildcard access, which is unsupported beginning September 14, 2026
- **Fix:** Replace the wildcard using `${PLUGIN_ROOT}/references/webapi-field-allowlist.md`: LogicalNames for ordinary columns, `_<LogicalName>_value` for lookup reads, and exact Navigation Properties used by `@odata.bind`
- **Details:** Include the site-setting file path and setting name from the validator finding

After Step 3.1 determines the environment URL, rerun the shared validator with live relationship verification only when the Step 3 discovery gate is open. Merge any additional findings:

```bash
node "${PLUGIN_ROOT}/scripts/validate-permissions-schema.js" --projectRoot "<PROJECT_ROOT>" --validate-dataverse-relationships --envUrl "<envUrl>"
```

Use this Dataverse-backed relationship validation only for local runs that need relationship evidence. Do **not** require it in CI or other offline contexts, and do not run it for Global-only/read-only designs with no relationship-dependent reachable flow.

### 2.5 Deterministic preflight cross-reference (grader ground truth)

Purely mechanical cross-checks over the parsed YAML + data model + Web API artifacts. **Emit ALL that apply.** Number IDs per prefix in encounter order (`IS1`, `IS2`, `DM1`, …). These are **ground truth**: carry them into the right dimension's issue list in Step 5 and never drop or downgrade them.

| Condition | id prefix | dimension | severity |
|---|---|---|---|
| Web-role YAML parse error | IS | internal-consistency | major |
| Table-permission YAML parse error | IS | internal-consistency | major |
| Permission references a web-role GUID not defined in any role | IS | internal-consistency | major |
| Web role has a **blank id** | IS | internal-consistency | major |
| Permission has a **blank `entitylogicalname`** | DM | data-model-alignment | major |
| Permission grants **no privileges** (all 6 CRUD bits false) | TC | table-coverage | major |
| Permission has **no scope** (`scope < 0`) | SC | scope-correctness | major |
| Permission scope code **unrecognized** (`Unknown(code)`) | SC | scope-correctness | minor |
| Permission grants **write/create/delete to an Anonymous role** | AH | anonymous-access-hygiene | major |
| Permission targets a table **not in the data model** (only when a valid data-model manifest exists) | DM | data-model-alignment | major |
| Web API site-setting YAML parse error | IS | internal-consistency | major |
| `-enabled` entity set with **no matching `-fields`** whitelist | IS | internal-consistency | major |
| `-fields` whitelist with **no matching `-enabled`** setting | IS | internal-consistency | major |
| Type file declaring 1–6 properties absent from the data model (only when a valid data-model manifest exists) | DM | data-model-alignment | minor |

---

### 2.6 Freeze the Evidence Ledger

`<OUTPUT_DIR>` is `<PROJECT_ROOT>/docs/` when working in a website (a project root with `powerpages.config.json`); otherwise it is the system temp directory. The temporary files and the final report all go there.

Before running judgment-based checks, write a temporary `<OUTPUT_DIR>/audit-evidence.json` containing the normalized facts gathered so far: roles, permissions, data-model tables/columns, service operations, route/component reachability, capability matrix, lookup/expand usage, client-side row filters, implementation-plan claims, authentication reachability, and preflight issues. Sort tables, permissions, routes, and capabilities by stable identifiers.

Steps 4–6 MUST reason from this ledger instead of rescanning and selectively rediscovering evidence. If live Dataverse discovery adds facts in Step 3, append those facts and rewrite the ledger once before Step 4. Do not change a `reachability` classification during scoring unless new evidence is added to the ledger. Delete `audit-evidence.json` after the final HTML report passes validation.

---

## Step 3: Analyze & Discover (Dataverse API)

Use deterministic Node.js scripts for all Dataverse API calls. These scripts handle auth token acquisition, HTTP requests, and JSON parsing consistently.

### Dataverse discovery gate

Before calling `pac env who` or any Dataverse query script, compute `needsLiveDiscovery`. It is `true` only when at least one reachable capability has one of these unresolved dependencies:

- Contact, Account, or Parent scope whose relationship name must be verified
- create/write code that binds or changes a lookup
- `$expand` or related-table access whose target cannot be resolved from local metadata
- file/image upload whose relationship or target metadata is unresolved

It is `false` when none of those dependencies apply — for example, Global-only/read-only flows, explicit Administrator-only CRUD unused by reachable site code, and cases fully resolved by the manifest and local source. When `false`, skip all of Step 3, record `liveDiscovery: "not-needed"` in the evidence ledger, and continue to Step 4. When `true`, first confirm the active Dataverse environment URL matches the manifest environment URL; if it does not, skip live queries and record the mismatch instead of querying the wrong environment.

### 3.1 Get Environment URL

```bash
pac env who
```

Extract the `Environment URL` (e.g., `https://org12345.crm.dynamics.com`) and use it as `<envUrl>` in subsequent script calls.

### 3.2 Query Lookup Columns

For each table that has permissions with `create` or `write` enabled, use the lookup query script:

```bash
node "${PLUGIN_ROOT}/skills/audit-permissions/scripts/query-table-lookups.js" --envUrl "<envUrl>" --table "<table_logical_name>"
```

The script returns a JSON array of `{ logicalName, targets }` for each lookup column. Capture this output for the maps described below.

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

```bash
node "${PLUGIN_ROOT}/skills/audit-permissions/scripts/query-table-relationships.js" --envUrl "<envUrl>" --table "<parent_table>"
```

The script returns a JSON array of `{ schemaName, referencedEntity, referencingEntity, referencingAttribute }`. Use `schemaName` to validate the `parentrelationship` value in parent-scope permissions.

### Error Handling

If any script exits with code 1, skip the API-dependent checks and note which checks were skipped in the report. Do NOT stop the entire audit for auth errors. Use the data model manifest and code analysis as fallback.

---

## Step 4: Run Audit Checks

Use per-table task tracking to systematically run every audit check. **These code- and Dataverse-grounded checks are the primary issue detectors** — they catch concrete problems (missing CRUD, append/appendto, `$expand` gaps, broken parent chains, over-provisioned grants) that rubric judgment alone would miss, which is what makes the issue set richer and the score more faithful. Each failed check emits **one provisional candidate** (title, responsible table, evidence, and a suggested fix); Step 5 assigns its final **major**/**minor** severity and dimension. A check that passes produces **no candidate**. Where a check says to search the service code, look the fact up in the evidence ledger (Step 2.6); search the source only when the ledger lacks it.

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

For each table, mark its task `in_progress` and run through the following checks **in order**. For every issue, note the **specific evidence** (file path, permission name, code pattern) that supports it. Skip checks that don't apply to this table.

**Do not finalize severity or dimension in Step 4.** Each check below carries a provisional audit tier (`critical`, `warning`, or `info`) and emits a factual candidate as `{ sourceId, auditTier, title, table, reasoning, fix, evidence, reachability? }`. A check that passes yields no candidate. Step 5 is the **only** place that assigns the final `major|minor` severity and canonical dimension, using fixed catalog rules before generic policy. This prevents whichever audit path runs first from locking in a different score.

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
- Exception: a Parent-scope (`756150003`) child permission may leave its roles empty — it inherits role association through the parent chain. Raise no finding when its `parententitypermission` resolves to an existing permission; a broken chain is reported by check I.
- If roles are assigned → `pass`

**C. Scope Appropriateness**

Is the scope the least-privileged option that fits?

- Search the service code for scope-relevant patterns: contact-scoped filters (`getCurrentContactId`, `_contactid_value`, `contactid`) and account-scoped filters (`_accountid_value`, `parentcustomerid`)
- For EACH Global-read permission, resolve every assigned role and apply the Step 2.3 audience reachability profile. Then inspect the table's selected/whitelisted columns, data-model columns, UI purpose, and implementation plan to determine whether the data is explicitly public or intended for a narrower persona.
- **Mandatory cross-artifact trigger, evaluated separately per affected table:** emit a finding when ALL four conditions hold: (1) open registration is proven (Step 2.3 audience reachability profile); (2) the assigned web role has `authenticatedusersrole: true`, so every registered account receives it; (3) that role is attached to this table's permission with `read: true` and Global scope; and (4) the table carries per-person, roster, grade, contact, or internal operational data, or the site intent limits it to staff/teachers/another purpose-specific persona → finding:
  - **Severity:** `critical`
  - **Title:** `Self-registered users can read all <table> records`
  - **Reasoning:** State the full evidence chain: registration setting(s) → automatic Authenticated Users membership → permission role binding → Global scope → exposed columns/intended audience. Authentication alone does not establish trusted-persona membership.
  - **Fix:** Remove the baseline Authenticated Users role from this permission and assign a purpose-specific role provisioned only to verified users; where access is record-relative, use Contact, Account, Parent, or Self scope instead of Global.
- If Global scope (`756150000`) with `write` or `delete` enabled → finding:
  - **Severity:** `warning`
  - **Title:** `Global scope with write/delete on <table>`
  - **Reasoning:** Any user with this role can modify/delete any record in this table
  - **Fix:** Narrow to Contact or Account scope, or remove write/delete if not needed
- If Global scope has only `read`, pass ONLY when the table and exposed columns are explicitly public/non-sensitive and every assigned role is an intended audience. Otherwise evaluate it under the mandatory trigger above and recurring issues C3/C4; read-only access can still be a major confidentiality exposure.
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

## Step 5: Score the Configuration

This is the **scoring overlay**. You already have the evidence: the audit issues (Step 4) and the deterministic preflight issues (Step 2.5). Now turn them into a category-organized issue set and a reproducible 1–5 score. The audit checks supply most of the detected issues; the **recurring-issue catalog** below plus the **grader severity policy** ([Appendix C](#appendix-c--severity-policy--auditgrader-bridge)) finalize `major`/`minor`; the **formula** ([Appendix A](#appendix-a--scoring-model)) decides the number. Detection and scoring are organized by **CATEGORY** (each category owns 3 dimensions — [Appendix A](#appendix-a--scoring-model) / [Appendix B](#appendix-b--the-9-dimensions)).

### 5.1 Detect & label issues by category (catalog-anchored)

Assess the **3 categories**; within each, reason across its 3 dimensions together. Populate each issue from three sources:

1. **Preflight issues** (Step 2.5) — keep each with its **fixed id, dimension, and severity** verbatim.
2. **Audit candidates** (Step 4, plus the Step 1 no-permissions observation) — these are factual observations, not final labels. Match each candidate against the recurring catalog first. Only unmatched candidates use the generic [Appendix C](#appendix-c--severity-policy--auditgrader-bridge) policy. Step 5 assigns every final severity and dimension exactly once.
3. **Recurring-issue catalog + rubric judgment** — run the catalog below as a CHECKLIST, then add anything the A–K checks didn't already cover (e.g., an entirely read-only management site → an intent-coverage failure).

**RECURRING ISSUE CATALOG — DETECTION + SEVERITY (the primary lever for run-to-run consistency).** Test EACH pattern against the artifacts; whenever a pattern's TRIGGER holds, raise exactly ONE issue for it in the stated dimension with the FIXED severity — on every run, no matter how obvious or minor it seems. Match on the described SHAPE, not on specific table/role names (names in parentheses are illustrations). **Patterns are evaluated PER affected table-group and are NOT mutually exclusive**: if one table hits a MAJOR pattern and a different table hits a similar MINOR pattern (e.g. C2 on a PII table AND C14 minor on a draft-content table), raise BOTH as separate issues — the ordering only resolves severity WITHIN one table-group, it never suppresses a finding on a different table.

- **[C1]** Anonymous write, create, or delete — raised by the preflight `AH` row (Step 2.5); do not raise it again here.
- **[C2]** PII / contact columns (email, phone, guardian or parent contact, address) readable by the Anonymous role → dim `anonymous-access-hygiene` · **major**.
- **[C3]** A role has GLOBAL-scope access to a per-person / per-owner table carrying PII or sensitive operational data (personal records, contact PII, grades, rosters) — reaching every record. Mutating grant → `privilege-calibration`; read-only → `security-posture` · **major**. This explicitly includes the baseline Authenticated Users role: when open registration lets any visitor acquire that role, treat it as a broad external audience, not as trusted staff. Evaluate and emit this pattern separately for each affected table; do not merge Student and Teacher (or other disjoint table exposures) into one issue.
- **[C4]** A role is granted access (any CRUD) beyond its natural need-to-know / need-to-act → dim `privilege-calibration` · **major** only when the extra access reaches another audience's sensitive records (PII, confidential, financial); otherwise **minor**. C4 never applies to a case covered by C3, C9, C16, C17 or C18.
- **[C5]** The site requires authoring/management but NO role has any Create/Write/Delete on ANY table (entirely read-only) — raise ONCE for the whole site → dim `intent-coverage` · **major** *(if the authoring is expected to be performed by the intentionally-omitted `Administrators` role, do NOT raise it — see the ADMINISTRATORS EXCEPTION below)*.
- **[C6]** A table the site clearly needs to expose (referenced by service/UI code, or an obvious end-user entity) has NO permission granting the required access → dim `table-coverage` · **major** *(if the only missing grant would be for the `Administrators` role, do NOT raise it — see the ADMINISTRATORS EXCEPTION)*.
- **[C7]** The site needs purpose-specific personas (e.g. distinct student / teacher / staff / admin audiences) but only generic Anonymous/Authenticated roles exist → dim `role-completeness` · **major** *(a missing `Administrators` role/persona is NOT a gap — see the ADMINISTRATORS EXCEPTION)*.
- **[C8]** A web role is defined but referenced by NO table permission (orphaned) while every persona the site needs is still served by another role → dim `role-completeness` · **minor**.
- **[C9]** GLOBAL-scope READ of inherently-public / non-sensitive shared reference data (announcements, facilities, public faculty/leadership listings) is the correct scope → **no issue**. Record the public audience in the inventory/context, but do not lower the security score or require a fix.
- **[C10]** A scope/permission that only matters under a HYPOTHETICAL future change ("if guardians authenticate later, a Contact or Parent scope would be better") → dim `scope-correctness` · **minor**.
- **[C11]** No `permissions-plan.html` present, or only a generic/boilerplate plan ("Global is the broadest scope") → dim `internal-consistency` · **minor**.
- **[C12]** A data-model table with no permission whose user-facing status is genuinely unclear — the implementation plan or data model describes it as user-facing, but no code uses it (likely a planned feature never built) → dim `table-coverage` · **minor**. Clearly backend/system tables with no permission are correct, so raise no issue.
- **[C13]** Wildcard `*` column exposure — a Web API query with `$select=*`, or any other column list set to `*` → dim `security-posture` · **major**, one issue per affected table. A `Webapi/<table>/fields` wildcard is reported through the Step 2.4 validator finding instead. An explicitly enumerated column list is never this issue, however long.
- **[C14]** A portal-readable table mixes allowed and restricted rows, and the only separation is a client-controlled `$filter`/query predicate. Client filtering is not an authorization boundary. If bypass exposes **sensitive or confidential content** (PII, credentials/secrets, financial/health data, internal staff or agent notes, private case details, security data) → dim `security-posture` · **major**. If bypass exposes only non-sensitive content that is merely unpublished, draft, or workflow-incomplete → dim `security-posture` · **minor**. If Dataverse permissions, column security, a server-side endpoint, or a separate protected table enforces the separation, C14 does not trigger.
- **[C15]** A purpose-specific persona has at least one `reachable` portal capability but lacks the persona web role and the permissions needed across that capability's tables/operations → emit exactly ONE consolidated dim `role-completeness` · **major** issue. Absorb the resulting missing-table and missing-operation symptoms into it. If the persona role exists and only one table is uncovered, use C6 `table-coverage`; if the table permission exists and only an operation bit is missing, use `intent-coverage`. `disabled` code does not trigger C15. `ambiguous` code conflicting with the plan produces only the minor `internal-consistency` issue described in Step 2.3.
- **[C16]** **Staff shared work queue** — a staff/back-office persona role (not Anonymous, not the baseline Authenticated Users role) has Global scope on a shared work-queue table (cases, tickets, requests, tasks) or its child tables. If the role's reachable pages read or update those records across owners → **no issue** (do NOT raise C3 or C4). Global write/create that no reachable staff page uses → fold into the role's C18 issue (**minor**). Global delete that no reachable staff page performs → dim `privilege-calibration` · **major**. Any mutation by Anonymous or a customer/baseline role stays C1/C3 **major**.
- **[C17]** **Child-table parity** — a child-table permission (comments, attachments, notes, escalations) whose reach equals the same role's grant on the parent table (for example Global child under a Global parent, or Parent scope under it) → **no issue**. A child grant broader than the role's parent grant → apply C3 (**major** when the child holds sensitive content).
- **[C18]** **Unused grants** — permissions that no reachable code uses for a role (unused tables, unused create/write/delete bits, unneeded append/appendto), including explicit Administrators permissions → emit exactly ONE issue per role, dim `privilege-calibration` · **minor**, listing every unused grant. Do not split it per table. A C16 unused delete stays a separate **major** issue.

**ADMINISTRATORS EXCEPTION (respect strongly).** By design, a site should **not** create table permissions for the `Administrators` web role — admin authoring normally happens outside the portal (the model-driven app or Dataverse directly), so explicit Administrators CRUD permissions are unnecessary and add security noise. The `Administrators` web role does not bypass table permissions for portal data access. Therefore:
- The **absence** of Administrators table permissions is CORRECT when no `reachable` site code performs the admin work — NEVER raise a missing-permission, table-coverage, role-completeness, or entirely-read-only issue *solely* because the `Administrators` role lacks table permissions. This includes an under-exposure gap (C5 read-only site, C6 missing grant, C7 missing persona) that exists only because the authoring/CRUD belongs to the intentionally-omitted `Administrators` role.
- If `reachable` site code performs admin-only CRUD through the portal (for example a routed admin page calling the Web API) with no grant, the exception does not apply: raise C6 or C15 as for any other role.
- This exception applies ONLY to the `Administrators` role and ONLY to under-exposure/usability gaps. It NEVER downgrades an over-exposure (security) finding — if Administrators (or any role) actually holds an over-broad grant, score it by the security rules as usual.

**NOVEL ISSUES (not covered by C1–C18):** still detect them — do NOT restrict yourself to the catalog. Assign severity by the [Appendix C](#appendix-c--severity-policy--auditgrader-bridge) security-first policy. A novel issue is NOT automatically minor: if it exposes data to the wrong audience, over-scopes access, or breaks a required flow, it is **major**.

Number LLM-derived issue ids per canonical dimension prefix (`IC`, `PC`, `SC`, `RC`, `TC`, `AH`, `DM`, `IS`, `SP`). Within each dimension, continue after the highest preflight id already used for that prefix (or start at 1 when there is none), so generated ids never collide with fixed preflight ids. The issue id prefix MUST match the issue's final dimension after consolidation. Record each issue as `{id, dimension, severity, title, reasoning, fix}` plus the evidence that supports it — the shape of a report finding (Step 7.2). **Do not assign a per-dimension 1–5 score** — scoring happens at the category level after consolidation.

### 5.2 Consolidate to distinct root causes (major/minor)

Consolidate the full pooled issue list into **distinct root causes**, then classify each into exactly ONE category by **dominant impact**. The number of issues after this step equals the number of root causes.

- **Merge** issues describing the SAME underlying misconfiguration on the same table(s) for the same audience into ONE — even across dimensions/categories. Never let a broad description ("all tables Global") absorb separate per-table exposures; C3 issues stay one per affected table. Enumerate all impacts in the description; set severity to the **highest** among merged.
- **One category per root cause — by DOMINANT IMPACT:** over-exposure = too much access (data exposed to the wrong audience, anonymous mutation, PII readable too widely, Global on per-owner data); under-exposure = too little access (missing required CRUD flow, user-facing table with no permission, missing persona/role); correctness = structural (references a table absent from the model, dangling role link, wrong/invalid scope, missing design doc). When a root cause could touch two categories, pick its WORST real-world consequence. Reassign the merged issue a `dimension` within the chosen category.
- **Under-exposure dimension tie-breaker (first match wins):** missing persona role spanning one or more reachable capabilities → `role-completeness`; existing persona role but missing table permission → `table-coverage`; existing role and table permission but missing CRUD/append bit → `intent-coverage`. Never choose among these dimensions by prose emphasis.
- **Plan/code conflict tie-breaker:** for `reachable` capabilities, implementation wins and the applicable C6/C7/C15 issue remains major; for `disabled` capabilities, the plan wins and no under-exposure issue is raised; for `ambiguous` capabilities, raise only the minor `internal-consistency` conflict.
- **Do NOT merge distinct exposures on different tables.** Two exposure/PII issues on DISJOINT table sets, or with different audiences/severities, are SEPARATE root causes — keep BOTH (e.g. anonymous-PII on student/teacher tables (major) vs over-broad Global read of public announcements/facilities (minor)). Only merge on the same tables. When in doubt, keep separate. C16 and C18 are one issue per role by definition.
- **Preserve every preflight issue** (Step 2.5) as its own standalone issue with its fixed id + severity. If an audit/rubric issue duplicates a preflight one, merge it **into** the preflight issue (keep the preflight id; severity is the higher of the two).
- Never invent new problems; every consolidated issue traces to at least one source issue. Never downgrade a major to shrink the count.

The consolidated issues are what feed scoring and all later phases. Re-bucket each under its (possibly reassigned) dimension. **This single consolidated `major`/`minor` list is the one issue set for everything downstream** — it becomes the report's `FINDINGS_DATA` (Step 7.2), the Overview's Major/Minor counts, and the input to the score. One issue set, one tally, so more issues ⇒ lower score.

### 5.3 Compute scores (pure formula)

Apply [Appendix A](#appendix-a--scoring-model) exactly: one 1–5 score per category from its pooled issues (no overall score), the verdict from the major count, and issue counts `{ major, minor, total }` over all consolidated issues.

### 5.4 Verdict (prose)

Write a **2–3 sentence** grader verdict: the top thing the config gets right, the top thing it gets wrong, and the verdict. State the verdict verbatim — **"Safe to go"** when there are **zero major** issues, **"Needs revision"** when there is **at least one major** issue. Minor issues never change it. **Do NOT tell the user whether to deploy, release, or ship** — the verdict summarises the findings; the decision is theirs. Prose only. Use it as the report's `SUMMARY` (Step 7.2).

If the data-model manifest is missing (`SCORECARD_DATA` is `null`), skip the verdict: write a 2–3 sentence summary that says this is a partial audit, and use neither verdict phrase.

---

## Step 6: Root-cause Attribution (batched)

Analyze **all MAJOR issues in a SINGLE batched pass** (after consolidation; skip minors). The site evidence is shared, so classify every major issue together in one reasoning step. For each, decide whether it is purely a permissions-design fault or is caused, wholly or partly, by an upstream artifact. Be **conservative — default to `permissions`** unless upstream evidence is clear (false upstream attribution is worse than missing one).

Root-cause values:
- `permissions` — genuine permission-design issue; nothing upstream forces it. Fix it in the permission or web-role YAML.
- `data-model` — the manifest is missing a table/column or uses a wrong publisher prefix.
- `webapi-code` — site code (`src/shared/services/*`, `src/types/*`, pages) references tables/columns in a way that forces the permission shape or relies on a browser-side rule.
- `webapi-settings` — `Webapi-*-enabled` / `-fields` YAML forces the grant (or gap).
- `mixed` — an upstream cause AND a permissions-side mistake both contribute.

For each major issue decide `rootCause` and write `explanation`; they become the finding's `rootCause` and `rootCauseReason` in Step 7.2.

`explanation` is shown to the user next to the major issue, so write **one plain-language sentence** that justifies the label: for `permissions`, say why the permission configuration alone is at fault; otherwise, name the specific upstream file or setting and what it forces.

---

## Step 7: Generate Report

### 7.1 Determine Output Location

- **If working in context of a website** (project root with `powerpages.config.json` exists): write to `<PROJECT_ROOT>/docs/permissions-audit.html`
- **Otherwise**: write to the system temp directory

This folder is the `<OUTPUT_DIR>` defined in Step 2.6.

### 7.2 Prepare Data

**Do NOT generate HTML manually or read/modify the template yourself.** Use the `render-audit-report.js` script which mechanically reads the template and replaces placeholder tokens with your data.

Write a temporary JSON data file (e.g., `<OUTPUT_DIR>/audit-data.json`) with these keys:

```json
{
  "SITE_NAME": "The site name (from powerpages.config.json or folder name)",
  "AUDIT_DESC": "Security audit of table permissions for Contoso Portal",
  "SUMMARY": "2-3 sentence summary of the audit results",
  "FINDINGS_DATA": [/* array of finding objects */],
  "INVENTORY_DATA": [/* array of current permission objects */],
  "SCORECARD_DATA": {/* grader overlay — see below; use null if scoring was skipped */}
}
```

`SITE_NAME`, `AUDIT_DESC`, `SUMMARY`, `FINDINGS_DATA`, `INVENTORY_DATA` are the **required** keys the render script validates. `SCORECARD_DATA` is an extra key the enhanced template consumes — **always include it** (object or `null`) so no placeholder is left unreplaced. In `SCORECARD_DATA.reportPaths`, list the absolute path to the HTML report — the Overview tab renders it so the user can open the report.

**FINDINGS_DATA format** — this is the single consolidated **major/minor** issue list from Step 5.2 (one entry per issue; it is exactly what the score is computed from). Use the canonical issue id from Step 5 (e.g. `AH1`). For **major** issues, copy `rootCause` and `explanation` from that issue's Step 6 entry; omit both fields for minor issues:

```json
{
  "id": "AH1",
  "severity": "major",
  "title": "Staff email/phone readable by Anonymous",
  "table": "contoso_staff",
  "dimension": "anonymous-access-hygiene",
  "scope": "Global",
  "permission": "Staff - Public Read",
  "reasoning": "Staff email/phone are in the $select and the Webapi field whitelist, and Staff-Public-Read grants the Anonymous role Global read — public internet can read staff PII.",
  "fix": "Restrict staff read to a purpose-specific role assigned only to verified users, or drop contoso_email/contoso_phone from the whitelist and $select.",
  "details": "Staff-Public-Read.tablepermission.yml; Webapi-contoso_staff-fields.sitesetting.yml; src/shared/services/staffService.ts:85",
  "rootCause": "mixed",
  "rootCauseReason": "The anonymous Global read grant is a permission mistake, and the Web API fields setting also whitelists contoso_email and contoso_phone."
}
```

- `id`: The canonical issue id from Step 5 — the same id used in Step 6.
- `severity`: **`major`** or **`minor`** — the only two tiers (never critical/warning/info/pass).
- `table`: The table logical name this issue relates to (or `null` for general issues)
- `dimension`: The grader dimension the issue rolls up to (via the Appendix C bridge)
- `scope`: The current scope if applicable (numeric code or friendly name), or `null`
- `permission`: The permission name if this issue is about an existing permission, or `null`
- `reasoning`: Detailed explanation of why this is an issue — reference specific code files, line patterns, or Dataverse metadata
- `fix`: Actionable suggestion for how to resolve the issue
- `details`: Additional context like file references, column names, or relationship details
- `rootCause`: Major issues only — the Step 6 root cause (`permissions`, `mixed`, `data-model`, `webapi-code`, or `webapi-settings`)
- `rootCauseReason`: Major issues only — the Step 6 `explanation`, one sentence justifying the root cause

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

**SCORECARD_DATA format** (from Step 5; the report reads only these fields):

```json
{
  "categories": [
    { "name": "Over-Exposure (Security)", "score": 3.10 },
    { "name": "Under-Exposure (Usability & Coverage)", "score": 4.21 },
    { "name": "Correctness (Validity & Alignment)", "score": 3.48 }
  ],
  "reportPaths": [
    { "label": "HTML report", "path": "<PROJECT_ROOT>/docs/permissions-audit.html" }
  ]
}
```

The report surfaces this data automatically. The **Overview** tab leads with the **Audit Summary**, then an **Issues** row (**major** and **minor** counts — the single problem tally, which is exactly what drives the score) and a **Verdict** section (**Safe to go** / **Needs revision**, computed from the major count in `FINDINGS_DATA`, plus the per-category 1–5 score bars), plus the report paths. Every issue is **major** or **minor** — there is no critical/warning/info/pass tier anywhere in the report. The **Issues** tab lists each major/minor issue with its evidence and fix; each major issue also shows a root-cause badge (**Permissions only**, **Permissions + upstream**, or **Upstream: data model / site code / Web API settings**) and the one-sentence justification.

### 7.3 Render the HTML File

Run the render script (it creates the output directory if needed):

```bash
node "${PLUGIN_ROOT}/scripts/render-audit-report.js" --output "<OUTPUT_PATH>" --data "<DATA_JSON_PATH>"
```

The render script refuses to overwrite existing files. Before calling it, check if the default output path (`<PROJECT_ROOT>/docs/permissions-audit.html`) already exists. If it does, choose a new descriptive filename based on context — e.g., `permissions-audit-apr-2026.html`, `permissions-audit-post-migration.html`. Pass the chosen name via `--output`, and use the same path in `reportPaths`.

### 7.4 Validate the report

Run the semantic validator on the rendered report:

```bash
node "${PLUGIN_ROOT}/skills/audit-permissions/scripts/validate-audit.js" \
  --report "<OUTPUT_PATH>" \
  --data "<DATA_JSON_PATH>" \
  --auditRunId "<AUDIT_RUN_ID>"
```

When local run initialization returned no run id, omit `--data` and `--auditRunId`; report validation must still run.

Do not present or copy a report until validation succeeds. The validator reads `FINDINGS_DATA`, `INVENTORY_DATA`, and `SCORECARD_DATA` from the report and checks unique issue ids whose prefix matches the dimension, major/minor severities, non-empty `title`/`reasoning`/`fix`, a valid `rootCause` and `rootCauseReason` on every major finding (and none on minor findings), that the inventory is an array, the three category scores recomputed from the findings, that `SUMMARY` states the verdict matching the major count (and neither verdict phrase on a partial audit), and leftover placeholders. When the run id and data path are supplied, the same deterministic command revalidates the source data, derives the closed aggregate metrics, and records successful completion and elapsed duration.

If validation fails, delete the report you just rendered, fix the named problem in the data file, render again to the same path, and rerun the validator. Do not repeat evidence gathering to fix a validation error.

The validator reports `telemetryStatus` as `recorded_success`, `recorded_failure` (the report is valid but its source data could not be reconciled, so the run was recorded with `failureStage: metrics_validation`), `disabled` (telemetry is hard-disabled for this plugin, so nothing was recorded), `failed`, or `not_requested`. Telemetry is best-effort: none of `recorded_failure`, `disabled`, or `failed` invalidates the report. Do not retry with a reduced payload and do not expose report data in diagnostic output.

Delete the temporary `audit-data.json` and `audit-evidence.json` files only after report validation succeeds. The telemetry status does not affect cleanup.

### 7.5 Open in Browser

Open the actual HTML output path in the user's default browser.

---

## Step 8: Present Findings & Track

### 8.1 Record Skill Usage

> Reference: `${PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "AuditPermissions"`.

### 8.2 Present Summary

<!-- gate: audit-permissions:6.fix-offer | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · audit-permissions:6.fix-offer):** Offer to apply auto-fixes for major/minor issues. The report has already been written; declining here just leaves the HTML report in place — no Dataverse / filesystem mutation.
>
> **Trigger:** Phase 8 has tallied findings and the report is saved.
> **Why we ask:** Tooling could silently invoke the table-permissions-architect agent — accept-by-default would write or mutate permission YAML against the user's intent.
> **Cancel leaves:** Nothing — the report stays at its saved path. No web-role / table-permission files written.

Present a summary to the user:

1. **Verdict** — when `SCORECARD_DATA` is non-null, show **Safe to go** or **Needs revision** plus the three category scores; otherwise state that this is a partial audit and omit both verdict phrases and scores.
2. **Major issues count** — these need immediate attention
3. **Minor issues count** — nice-to-have / forward-looking
4. **Report location** — where the HTML report was saved
5. **Ask the user** using `AskUserQuestion`: "Would you like me to fix any of these issues? I can create or update table permissions to resolve the major issues."

If the user wants fixes applied:

- **For 403 / Web API access issues** (missing table permissions, missing CRUD flags, incorrect scope, missing append/appendto, missing `$expand` read coverage — any finding that would result in a 403 Forbidden response from the Power Pages Web API): Spawn the **table-permissions-architect** agent using the `Agent` tool. Pass it a prompt that includes the specific tables, the required CRUD flags, scope recommendations, and relationship details from the findings. The agent will analyze the site, propose a permissions plan, and create the correct table permission YAML files after user approval. Example prompt: `"Create table permissions for the following tables based on audit findings: <table1> needs Global scope with read:true; <table2> needs Parent scope under <parent_table> with read:true, create:true, append:true; <table3> needs appendto:true for lookups from <source_table>. The site project root is <PROJECT_ROOT>."`
- **For non-permission issues** (e.g., unused permissions, scope-narrowing suggestions, other minor issues): explain what manual changes are needed or suggest running `/integrate-webapi` so the Web API settings architect can address site-setting-level issues.

---

## Appendix A — Scoring model

Scoring is a **pure function of the consolidated issues** — reproduce it exactly.

### Categories

| Category | Dimensions |
|---|---|
| **Over-Exposure (Security)** | privilege-calibration, anonymous-access-hygiene, security-posture |
| **Under-Exposure (Usability & Coverage)** | intent-coverage, table-coverage, role-completeness |
| **Correctness (Validity & Alignment)** | scope-correctness, data-model-alignment, internal-consistency |

### Score-from-issues formula

For a set of issues, let `nMajor` and `nMinor` be the counts. Then:

```
load    = 1.0 * nMajor + 0.25 * nMinor
penalty = tanh(0.2 * load)          # tanh maps [0,∞) → [0,1); penalty(0)=0
score   = 5 - 4 * penalty           # 0 issues → 5.00 ; grows → 1.00
score   = round(score * 100) / 100  # 2 decimals
```

Constants: `MAJOR_LOAD = 1.0`, `MINOR_LOAD = 0.25`, `PENALTY_STEEPNESS = 0.2`.

- **Category score** = `scoreFromIssues(pooled deduplicated issues of that category's dimensions)`. The category is the scoring unit — do NOT average per-dimension scores.
- **There is no overall score.** The three category scores are reported side by side and never combined into a single number.

Reference points (0.2 steepness): 0 issues → 5.00; 1 major → 4.21; 2 major → 3.48; 3 major → 2.85; 1 minor → 4.80; the first major always hurts most (diminishing returns).

### Final verdict

The verdict is driven by **severity**, not by any score:

| Condition | Verdict | Meaning |
|---|---|---|
| **0 major issues** | **Safe to go** | No major issues were identified. |
| **≥ 1 major issue** | **Needs revision** | One or more major issues were identified; review and address them. |

Minor issues never change the verdict — they are still recorded and still lower their category score, but they are left to the user's judgement. State the verdict phrase verbatim in Step 5.4 and in the report.

The verdict is **advisory**. It summarises what the audit found; it is not an approval or a release gate, and the decision to act on it rests with the human reviewer. Never instruct the user to deploy or not deploy.

---

## Appendix B — The 9 dimensions

Use each dimension's definition to decide where an issue belongs. Order is canonical for output.

**1. Intent Coverage** — `IC` · *Under-Exposure* — Does every authorization-relevant capability in the request map to at least one (role × table × op) grant? **Usability rule:** if the request implies managing/authoring records but NO role has ANY Create/Write/Delete on the relevant tables (read-only everywhere), that's a coverage FAILURE → a **major** issue.

**2. Privilege Calibration** — `PC` · *Over-Exposure* — Per (role, table, op): is each CRUD bit right-sized — not over- or under-granted?

**3. Scope Correctness** — `SC` · *Correctness* — Does scope (Global/Contact/Account/Parent/Self) match the data-ownership model? Per-user → Contact; public bulletin → Global; child records reached through a parent record → Parent; the user's own contact record → Self.

**4. Role Completeness** — `RC` · *Under-Exposure* — Are all personas implied by the request present as web roles? Spurious roles? Anonymous + Authenticated correct?

**5. Table Coverage (Permissions)** — `TC` · *Under-Exposure* — Every user-facing table has ≥1 permission; system/non-user-facing tables correctly excluded.

**6. Anonymous Access Hygiene** — `AH` · *Over-Exposure* — Anonymous gets minimal read only where the request implies public content; no anonymous write/create/delete unless justified.

**7. Data Model Alignment** — `DM` · *Correctness* — Every table referenced in a permission resolves to a real data-model table; no phantom/misnamed tables.

**8. Internal Consistency** — `IS` · *Correctness* — YAML valid; every web-role GUID in a permission resolves; `permissions-plan.html` aligns with the YAML.

**9. Security Posture** — `SP` · *Over-Exposure* — Overall least-privilege. No surprising broad grants on sensitive tables (Contact, system tables); no avoidable delete/write on shared records. If Web API field whitelists exist, check they don't broadly expose sensitive PII columns.

---

## Appendix C — Severity policy & audit↔grader bridge

### Severity policy (apply rules IN ORDER; first match wins)

Only two severities exist: **major** (a real problem — breaks the site or leaks data, or a genuinely sub-optimal config that should be fixed) and **minor** (cosmetic / forward-looking / nice-to-have). There is no "info" tier in the grader (audit `info` findings map to `minor`).

**Default stance — SECURITY FIRST / LEAST PRIVILEGE.** Access should be granted only where the role's real-world use case requires it, scoped as narrowly as possible. Reaching or mutating records beyond that need is **over-granted → major**, even for an otherwise-"authorized" role.

1. **Realized vs hypothetical.** Major = the problem is true **right now** (a flow is broken, or data is exposed to an audience that shouldn't see it). Minor = only matters under a hypothetical future change, or is cosmetic. Tell-tale minor language: "if … later", "could", "should be revisited".
2. **Need-to-know / over-scope.** Major = a role can read/mutate records **beyond its need** — EITHER an unauthorized audience (Anonymous, or a role outside the data's intended audience) reaches it, OR an authorized role gets **Global** scope over per-owner / per-relationship data (personal records, PII, grades, rosters, guardian contact) so it reaches **every** record instead of its own subset. Especially severe for PII (email, phone, guardian contact, addresses). Minor = over-broad scope only on genuinely **public/shared reference** data (announcements, facilities, public directory). Staff roles working a shared work queue follow C16, and child tables matching their parent's reach follow C17.
3. **Mutation vs read.** Major = an unwanted **mutating** grant (write/create/delete for a role that shouldn't have it; anonymous mutation is always major). An over-broad **read** is minor unless rule (2) makes it major. Absence of needed mutation (a management/authoring site with NO Create/Write/Delete anywhere) is a broken flow → major under rule (1).

**Anchor examples.** The recurring-issue catalog (C1–C18, Step 5.1) is the primary anchor set — label any case it covers exactly as the catalog says. Two further recurring cases:
- Global-scope read of PII-bearing internal tables by staff/teacher/admin → **major** (r2).
- A role with **Global** scope over per-owner operational data beyond need (a teacher who can read/edit ALL students' grades, not just their own class) → **major** (r2).

### Audit finding → grader dimension bridge

Map each Step-4 finding into a dimension, then apply the severity policy above to set `major`/`minor`. (Audit `critical` almost always → `major`; audit `info` → `minor`; audit `warning` → apply the policy.)

| Audit check / finding | Grader dimension | Typical grader severity |
|---|---|---|
| A. Missing permission for referenced table | intent-coverage (+ table-coverage) | major |
| A. Unused permission (not referenced in code) | privilege-calibration (C18, one issue per role) | minor |
| B. Permission has no web role | role-completeness | major; none for a Parent-scope child with a valid parent chain |
| C. Global scope with write/delete | privilege-calibration / security-posture | major, except staff shared work queues (C16) and child-table parity (C17) |
| C. Scope could be narrower | scope-correctness | major if per-owner/PII, else minor |
| D. Missing read | intent-coverage | major |
| E. Missing create · F. Missing write · G. Missing delete | intent-coverage | major |
| E/F/G. Enabled-but-not-used | privilege-calibration (C18, one issue per role) | minor |
| F. File upload but write disabled | intent-coverage | major |
| F. Write without read | privilege-calibration | major |
| H. Missing append · H2. Missing appendto | privilege-calibration / intent-coverage | major |
| H. Append enabled but not needed | privilege-calibration (C18, one issue per role) | minor |
| I. Broken parent chain | internal-consistency | major |
| J. Missing read on `$expand` table | intent-coverage | major |
| PII readable by anonymous | anonymous-access-hygiene / security-posture | major |
| Schema-validator `error` / `warning` / `info` | internal-consistency (or the specific dimension) | error→major, warning→policy, info→minor |

---

## Critical Constraints

- **Read-only analysis**: This skill only reads existing configuration and code. It does NOT modify any files unless the user explicitly asks to fix issues (Step 8). Scoring and report generation are all non-mutating.
- **Never invent the score**: always derive it from consolidated issue counts via [Appendix A](#appendix-a--scoring-model). Same issues ⇒ same score.
- **Preflight issues are ground truth**: carry Step-2.5 issues (id, dimension) through consolidation and scoring; never drop or downgrade them — a merged duplicate may only raise the severity.
- **One issue per root cause**: do not split a single root cause into multiple issues; do not over-merge independent problems.
- **Final labels happen once**: Step 4 emits factual candidates; Step 5 alone assigns final severity, dimension, and issue id.
- **Reachability beats prose**: routed/callable portal behavior outranks contradictory plan text; explicit runtime/build exclusion outranks dormant source code; ambiguity is minor correctness, not presumed under-exposure.
- **Client filters are not authorization**: classify bypassable restricted rows by content sensitivity — confidential/sensitive exposure is major, non-sensitive draft/workflow exposure is minor.
- **Least privilege / security first** governs dimension severities (Appendix C) and the recurring-issue catalog (Step 5.1). A staff role is NOT entitled to every record — only its related records.
- **Administrators need no table permissions** unless reachable site code performs admin-only CRUD: otherwise never flag their absence; see the ADMINISTRATORS EXCEPTION in Step 5.1.
- **Deterministic API calls**: Always use the Node.js scripts (`query-table-lookups.js`, `query-table-relationships.js`) for Dataverse API queries — never use inline PowerShell `Invoke-RestMethod` calls.
- **No questions during analysis**: Autonomously gather all data, run checks, score, and present findings. Only ask the user at the end about fixing issues.
- **Security**: Never log or display auth tokens. The scripts handle token acquisition internally via `getAuthToken()`.
- **Graceful degradation**: If Dataverse API scripts fail (exit code 1), skip API-dependent checks (H/H2 append/appendto validation, I parent chain integrity) and note in the report which checks were skipped. If the data-model manifest is missing, still emit the audit findings; set `SCORECARD_DATA` to `null` rather than fabricating a score — the report then shows a partial-audit notice instead of a verdict and scores, and `SUMMARY` states no verdict (Step 5.4).
- **Don't invent files or tables** not present in the inputs.
