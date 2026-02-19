---
name: integrate-webapi
description: >
  This skill should be used when the user asks to "integrate web api", "add web api",
  "connect to dataverse", "add api integration", "set up web api calls",
  "integrate api for my tables", "add crud operations", "hook up web api",
  "add data fetching", "connect frontend to dataverse", or wants to integrate
  Power Pages Web API into their site's frontend code with proper permissions
  and deployment. This skill orchestrates the full integration lifecycle:
  code integration, permissions setup, and deployment.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Task, TaskCreate, TaskUpdate, TaskList
model: opus
hooks:
  Stop:
    - hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/integrate-webapi/scripts/validate-webapi-integration.js"'
          timeout: 15
        - type: prompt
          prompt: >
            If Web API integration was being performed in this session (via /power-pages:integrate-webapi),
            verify before allowing stop: 1) The site was analyzed and tables requiring Web API integration
            were identified, 2) The webapi-integration agent was invoked to create API client, types, and
            service files for each table, 3) All integration files were verified (types, services, hooks exist)
            and the project builds successfully, 4) Table permissions and site settings were configured
            (either via the webapi-permissions agent or by parsing a user-provided permissions diagram),
            5) The user was asked whether to deploy the site.
            If any of these are incomplete, return { "ok": false, "reason": "<specific issues>" }.
            If no Web API integration work happened or everything is complete, return { "ok": true }.
          timeout: 30
---

# Integrate Web API

Integrate Power Pages Web API into a code site's frontend. This skill orchestrates the full lifecycle: analyzing where integrations are needed, implementing API client code for each table, configuring permissions and site settings, and deploying the site.

## Core Principles

- **One table at a time**: Process tables sequentially because the first table creates the shared `powerPagesApi.ts` client that subsequent tables reuse, and each agent invocation may modify shared files.
- **Permissions require deployment**: The `.powerpages-site` folder must exist before table permissions and site settings can be configured. Integration code can be written without it, but permissions cannot.
- **Use TaskCreate/TaskUpdate**: Track all progress throughout all phases — create the todo list upfront with all phases before starting any work.

> **Prerequisites:**
> - An existing Power Pages code site created via `/power-pages:create-site`
> - A Dataverse data model (tables/columns) already set up via `/power-pages:setup-datamodel` or created manually
> - The site must be deployed at least once (`.powerpages-site` folder must exist) for permissions setup

**Initial request:** $ARGUMENTS

---

## Workflow

1. **Verify Site Exists** — Locate the Power Pages project and verify prerequisites
2. **Explore Integration Points** — Analyze site code and data model to identify tables needing Web API integration
3. **Review Integration Plan** — Present findings to the user and confirm which tables to integrate
4. **Implement Integrations** — Use the `webapi-integration` agent for each table
5. **Verify Integrations** — Validate all expected files exist and the project builds successfully
6. **Setup Permissions** — Choose permissions source (upload diagram or let the Web API Permissions Architect analyze), then configure table permissions and site settings
7. **Review & Deploy** — Ask the user to deploy the site and invoke `/power-pages:deploy-site` if confirmed

---

## Phase 1: Verify Site Exists

**Goal**: Locate the Power Pages project root and confirm that prerequisites are met

**Actions**:

### 1.1 Locate Project

Look for `powerpages.config.json` in the current directory or immediate subdirectories to find the project root.

```powershell
Get-ChildItem -Path . -Filter "powerpages.config.json" -Recurse -Depth 1
```

**If not found**: Tell the user to create a site first with `/power-pages:create-site`.

### 1.2 Read Existing Config

Read `powerpages.config.json` to get the site name:

```powershell
Get-Content "<PROJECT_ROOT>/powerpages.config.json" | ConvertFrom-Json
```

### 1.3 Detect Framework

Read `package.json` to determine the framework (React, Vue, Angular, or Astro). See `${CLAUDE_PLUGIN_ROOT}/references/framework-conventions.md` for the full framework detection mapping.

### 1.4 Check for Data Model

Look for `.datamodel-manifest.json` to discover available tables:

```text
**/.datamodel-manifest.json
```

If found, read it — this is the primary source for table discovery.

### 1.5 Check Deployment Status

Look for the `.powerpages-site` folder:

```text
**/.powerpages-site
```

**If not found**: Warn the user that the permissions phase (Phase 5) will require deployment first. The integration code (Phases 2–4) can still proceed.

**Output**: Confirmed project root, framework, data model availability, and deployment status

---

## Phase 2: Explore Integration Points

**Goal**: Analyze the site code and data model to identify all tables needing Web API integration

**Actions**:

Use the **Explore agent** (via `Task` tool with `agent_type: "explore"`) to analyze the site code and data model. The Explore agent should answer these questions:

### 2.1 Discover Tables

Ask the Explore agent to identify all Dataverse tables that need Web API integration by examining:

- `.datamodel-manifest.json` — List of tables and their columns
- `src/**/*.{ts,tsx,js,jsx,vue,astro}` — Source code files that reference table data, mock data, or placeholder API calls
- Existing `/_api/` fetch patterns in the code
- TypeScript interfaces or types that map to Dataverse table schemas
- Component files that display or manipulate data from Dataverse tables
- Mock data files or hardcoded arrays that should be replaced with API calls
- `TODO` or `FIXME` comments mentioning API integration

**Prompt for the Explore agent:**

> "Analyze this Power Pages code site and identify all Dataverse tables that need Web API integration. Check `.datamodel-manifest.json` for the data model, then search the source code for: mock data arrays, hardcoded data, placeholder fetch calls to `/_api/`, TypeScript interfaces matching Dataverse column patterns (publisher prefix like `cr*_`), TODO/FIXME comments about API integration, and components that display table data. For each table found, report: the table logical name, the entity set name (plural), which source files reference it, what operations are needed (read/create/update/delete), and whether an existing API client or service already exists in `src/shared/` or `src/services/`. Also check if `src/shared/powerPagesApi.ts` already exists."

### 2.2 Identify Existing Integration Code

The Explore agent should also report:

- Whether `src/shared/powerPagesApi.ts` (or equivalent API client) already exists
- Which tables already have service files in `src/shared/services/` or `src/services/`
- Which tables already have type definitions in `src/types/`
- Any framework-specific hooks/composables already created

This avoids duplicating work that was already done.

### 2.3 Compile Integration Manifest

From the Explore agent's findings, compile a list of tables needing integration:

| Table | Logical Name | Entity Set | Operations | Files Referencing | Existing Service |
|-------|-------------|-----------|------------|-------------------|-----------------|
| Products | `cr4fc_product` | `cr4fc_products` | CRUD | `ProductList.tsx`, `ProductCard.tsx` | None |
| Categories | `cr4fc_category` | `cr4fc_categories` | Read | `CategoryFilter.tsx` | None |

**Output**: Complete integration manifest listing all tables, their operations, referencing files, and existing service status

---

## Phase 3: Review Integration Plan

**Goal**: Present the integration manifest to the user and confirm which tables to integrate

**Actions**:

### 3.1 Present Findings

Show the user:
1. The tables that were identified for Web API integration
2. For each table: which files reference it, what operations are needed
3. Whether a shared API client already exists or needs to be created
4. Any tables that were skipped (already have services)

### 3.2 Confirm Tables

Use `AskUserQuestion` to confirm:

| Question | Options |
|----------|---------|
| I found the following tables that need Web API integration: **[list tables]**. Which tables should I integrate? | All of them (Recommended), Let me select specific tables, I need to add more tables |

If the user selects specific tables or adds more, update the integration manifest accordingly.

**Output**: User-confirmed list of tables to integrate

---

## Phase 4: Implement Integrations

**Goal**: Create Web API integration code for each confirmed table using the `webapi-integration` agent

**Actions**:

### 4.1 Invoke Agent Per Table

For each table, use the `Task` tool to invoke the `webapi-integration` agent at `${CLAUDE_PLUGIN_ROOT}/agents/webapi-integration.md`:

**Prompt template for the agent:**

> "Integrate Power Pages Web API for the **[Table Display Name]** table.
> - Table logical name: `[logical_name]`
> - Entity set name: `[entity_set_name]`
> - Operations needed: [read/create/update/delete]
> - Framework: [React/Vue/Angular/Astro]
> - Project root: [path]
> - Source files referencing this table: [list of files]
> - Data model manifest path: [path to .datamodel-manifest.json if available]
>
> Create the TypeScript types, CRUD service layer, and framework-specific hooks/composables. Replace any mock data or placeholder API calls in the referencing source files with the new service."

### 4.2 Process Tables Sequentially

Process tables **one at a time** (not in parallel), because:
- The first table creates the shared `powerPagesApi.ts` client — subsequent tables reuse it
- Each agent invocation may modify shared files

### 4.3 Verify Each Integration

After each agent completes, verify the output:
- Check that the expected files were created (types, service, hook/composable)
- Confirm the shared API client exists after the first table is processed
- Note any issues reported by the agent

### 4.4 Git Commit

After all integrations are complete, stage and commit:

```powershell
git add -A
git commit -m "Add Web API integration for [table names]"
```

**Output**: Integration code created for all confirmed tables, verified and committed

---

## Phase 5: Verify Integrations

**Goal**: Validate that all expected integration files exist, imports are correct, and the project builds successfully

**Actions**:

### 5.1 Verify File Inventory

For each integrated table, confirm the following files exist:
- **Type definition** in `src/types/` (e.g., `src/types/product.ts`)
- **Service file** in `src/shared/services/` or `src/services/` (e.g., `productService.ts`)
- **Framework-specific hook/composable** (e.g., `src/shared/hooks/useProducts.ts` for React, `src/composables/useProducts.ts` for Vue)

Also verify:
- **Shared API client** at `src/shared/powerPagesApi.ts` exists
- Each service file references `/_api/` endpoints
- Each service file imports from the shared API client

### 5.2 Verify Build

Run the project build to catch any import errors, type errors, or missing dependencies:

```powershell
npm run build
```

If the build fails, fix the issues before proceeding. Common issues:
- Missing imports between generated files
- Type mismatches between service and type definitions
- Framework-specific compilation errors

### 5.3 Present Verification Results

Present a table summarizing the verification:

| Table | Types | Service | Hook/Composable | API References |
|-------|-------|---------|-----------------|----------------|
| Products | `src/types/product.ts` | `src/shared/services/productService.ts` | `src/shared/hooks/useProducts.ts` | `/_api/cr4fc_products` |
| ... | ... | ... | ... | ... |

**Build status**: Pass / Fail (with details)

**Output**: All integration files verified, project builds successfully

---

## Phase 6: Setup Permissions

**Goal**: Configure table permissions and site settings for all integrated tables using the `webapi-permissions` agent

**Actions**:

### 5.1 Check Deployment Prerequisite

The permissions agent requires the `.powerpages-site` folder. If it doesn't exist:

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| The `.powerpages-site` folder was not found. The site needs to be deployed once before permissions can be configured. Would you like to deploy now? | Yes, deploy now (Recommended), Skip permissions for now — I'll set them up later |

**If "Yes, deploy now"**: Invoke `/power-pages:deploy-site` first, then resume this phase.

**If "Skip"**: Skip to Phase 7 with a note that permissions still need to be configured.

### 5.2 Choose Permissions Source

Ask the user how they want to define the permissions using the `AskUserQuestion` tool:

**Question**: "How would you like to define the Web API permissions for your site?"

| Option | Description |
|--------|-------------|
| **Upload an existing permissions diagram** | Provide an image (PNG/JPG) or Mermaid diagram of your existing permissions structure |
| **Let the Web API Permissions Architect figure it out** | The Web API Permissions Architect will analyze your site's code, data model, and Dataverse environment, then propose permissions automatically |

Route to the appropriate path:

#### Path A: Upload Existing Permissions Diagram

If the user chooses to upload an existing diagram:

1. Ask the user to provide their permissions diagram. Supported formats:
   - **Image file** (PNG, JPG) — Use the `Read` tool to view the image and extract web roles, table permissions, CRUD flags, scopes, and site settings from it
   - **Mermaid syntax** — The user can paste a Mermaid flowchart diagram text directly in chat
   - **Text description** — A structured list of web roles, table permissions, scopes, and site settings

2. Parse the diagram into the same structured format used by the webapi-permissions agent:
   - **Web roles**: Match with existing roles from `.powerpages-site/web-roles/` by name to get their UUIDs
   - **Table permissions**: Permission name, table logical name, web role UUID(s), scope, CRUD flags (read/create/write/delete/append/appendto), parent permission and relationship name (if Parent scope)
   - **Site settings**: `Webapi/<table>/enabled` and `Webapi/<table>/fields` — **CRITICAL: fields must list specific column logical names, NEVER use `*` wildcard**

3. Cross-check with existing configuration in `.powerpages-site/` to identify which permissions and site settings are new vs. already exist.

4. Generate a Mermaid flowchart from the parsed data (if the user provided an image or text) for visual confirmation.

5. Present the parsed permissions plan to the user for approval using `AskUserQuestion`:

   | Question | Options |
   |----------|---------|
   | Does this permissions plan look correct? | Approve and create files (Recommended), Request changes, Cancel |

6. Proceed directly to **section 5.4: Create Permission Files** with the parsed permissions data.

#### Path B: Let the Web API Permissions Architect Figure It Out

If the user chooses to let the Web API Permissions Architect figure it out, proceed to **section 5.3: Invoke Permissions Agent**.

### 5.3 Invoke Permissions Agent

Use the `Task` tool to invoke the `webapi-permissions` agent at `${CLAUDE_PLUGIN_ROOT}/agents/webapi-permissions.md`:

**Prompt:**

> "Analyze this Power Pages code site and set up Web API permissions. The following tables have been integrated with Web API: [list of tables integrated in Phase 4]. Check for existing web roles, table permissions, and site settings. Propose a complete permissions plan covering all integrated tables."

### 5.4 Create Permission Files

After the permissions data is available — either from the user's uploaded diagram (Path A) or from the `webapi-permissions` agent's approved plan (Path B) — create the actual YAML files:

- **Table permission files** in `.powerpages-site/table-permissions/`
- **Site setting files** in `.powerpages-site/site-settings/`

For each file that needs a UUID, generate one using the shared script:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/generate-uuid.js"
```

**CRITICAL YAML FORMATTING RULES when writing these files:**
- **Code site git format**: Table permission fields have `adx_` prefix stripped (e.g., `append`, `read`, `scope`) EXCEPT `adx_entitypermission_webrole` (M2M relationship keeps prefix). The display name field is `entityname` (NOT `entitypermissionname`). Entity reference lookups (like `parententitypermission`) store only the GUID, not a nested object.
- Boolean values MUST be unquoted: `value: true` — NEVER `value: "true"` or `value: "false"`
- Numeric values MUST be unquoted: `scope: 756150000` — NEVER `scope: "756150000"`
- UUIDs MUST be unquoted: `id: a1b2c3d4-...` — NEVER `id: "a1b2c3d4-..."`
- String values (like field lists) are also unquoted: `value: cr87b_name,cr87b_email`
- CRUD flags are unquoted booleans: `read: true` — NEVER `read: "true"`
- Fields MUST be alphabetically sorted
- Follow the exact YAML format specified by the permissions plan output

### 5.5 Git Commit

Stage and commit the permission files:

```powershell
git add -A
git commit -m "Add Web API permissions and site settings for [table names]"
```

**Output**: Table permissions and site settings created, verified, and committed

---

## Phase 7: Review & Deploy

**Goal**: Present a summary of all work performed and offer deployment

**Actions**:

### 7.1 Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "IntegrateWebApi"`.

### 7.2 Present Summary

Present a summary of everything that was done:

| Step | Status | Details |
|------|--------|---------|
| API Client | Created/Existed | `src/shared/powerPagesApi.ts` |
| Types | Created | `src/types/product.ts`, `src/types/category.ts` |
| Services | Created | `src/shared/services/productService.ts`, etc. |
| Hooks | Created | `src/shared/hooks/useProducts.ts`, etc. |
| Components Updated | X files | Mock data replaced with API calls |
| Table Permissions | Created | X permission files |
| Site Settings | Created | X setting files |

### 7.3 Ask to Deploy

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| The Web API integration and permissions are ready. To make everything live, the site needs to be deployed. Would you like to deploy now? | Yes, deploy now (Recommended), No, I'll deploy later |

**If "Yes, deploy now"**: Invoke the `/power-pages:deploy-site` skill to deploy the site.

**If "No, I'll deploy later"**: Acknowledge and remind:

> "No problem! Remember to deploy your site using `/power-pages:deploy-site` when you're ready. The Web API calls will not work until the site is deployed with the new permissions."

### 7.4 Post-Deploy Notes

After deployment (or if skipped), remind the user:

- **Test the API**: Open the deployed site and verify Web API calls work in the browser's Network tab
- **Check permissions**: If any API call returns 403, verify table permissions and site settings are correct
- **Disable innererror in production**: If `Webapi/error/innererror` was enabled for debugging, disable it before going live
- **Web roles**: Users must be assigned the appropriate web roles to access protected APIs

**Output**: Summary presented, deployment completed or deferred, post-deploy guidance provided

---

## Important Notes

### Throughout All Phases

- **Use TaskCreate/TaskUpdate** to track progress at every phase
- **Ask for user confirmation** at key decision points (see list below)
- **Process tables sequentially** — never in parallel, because the shared API client and shared files create ordering dependencies
- **Commit at milestones** — after integration code and after permission files
- **Verify each integration** — confirm expected files exist after each agent invocation

### Key Decision Points (Wait for User)

1. After Phase 2: Confirm which tables to integrate
2. After Phase 3: Approve integration plan
3. At Phase 6.1: Deploy now or skip permissions (if `.powerpages-site` missing)
4. At Phase 6.2: Choose permissions source (upload diagram or let the Web API Permissions Architect analyze)
5. At Phase 6.3/6.4: Approve permissions plan (via user review for Path A, or plan mode within the agent for Path B)
6. At Phase 7.2: Deploy now or deploy later

### Progress Tracking

Before starting Phase 1, create a task list with all phases using `TaskCreate`:

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Verify site exists | Verifying site prerequisites | Locate project root, detect framework, check data model and deployment status |
| Explore integration points | Analyzing code for integration points | Use Explore agent to discover tables, existing services, and compile integration manifest |
| Review integration plan | Reviewing integration plan with user | Present findings and confirm which tables to integrate |
| Implement integrations | Implementing Web API integrations | Invoke webapi-integration agent per table, verify output, git commit |
| Verify integrations | Verifying integrations | Validate all expected files exist, check imports and API references, run project build |
| Setup permissions | Configuring permissions and site settings | Choose permissions source (upload diagram or Web API Permissions Architect), create YAML files, git commit |
| Review and deploy | Reviewing summary and deploying | Present summary, ask about deployment, provide post-deploy guidance |

Mark each task `in_progress` when starting it and `completed` when done via `TaskUpdate`. This gives the user visibility into progress and keeps the workflow deterministic.

---

**Begin with Phase 1: Verify Site Exists**
