---
name: add-server-logic
description: >-
  Creates, edits, and manages Power Pages Server Logic files — server-side JavaScript that
  runs securely on the Power Pages runtime. Orchestrates the full lifecycle: gathering
  requirements, fetching documentation, implementing code, configuring site settings, and
  deploying. Use when the user wants to add server-side code, create API endpoints, or move
  logic from the browser to the server in their Power Pages site.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Skill, Task, TaskCreate, TaskUpdate, TaskList, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_search, mcp__plugin_power-pages_microsoft-learn__microsoft_code_sample_search, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_fetch
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Add Server Logic

Create and manage one or more Power Pages Server Logic files — server-side JavaScript that runs securely on the Power Pages runtime, hidden from the browser and protected by web roles and table permissions. Server Logic enables secure external API integrations, Dataverse operations, and custom business logic without exposing sensitive code or credentials to the client.

## Core Principles

- **Microsoft Learn is the source of truth**: Always fetch the latest documentation before writing code. The Server Logic feature is in preview and the SDK may change — never rely on cached knowledge alone.
- **No browser APIs, no dependencies**: Server Logic runs in a sandboxed server environment with ECMAScript 2023 support. There is no `fetch`, `XMLHttpRequest`, `setTimeout`, or any DOM API. No npm packages are available.
- **Five functions only**: A server logic file can only export these top-level functions: `get`, `post`, `put`, `patch`, `del`. The name `delete` is a reserved word in JavaScript and cannot be used.
- **Always return a string**: Every function must return a string. Use `JSON.stringify()` when returning objects or arrays.
- **Use TaskCreate/TaskUpdate**: Track all progress throughout all phases — create the todo list upfront with all phases before starting any work.

> **Prerequisites:**
> - An existing Power Pages code site created
> - The site **must** be deployed at least once (`.powerpages-site` folder must exist) — server logic files live inside `.powerpages-site/server-logic/`, so deployment is required before any server logic can be created

**Initial request:** $ARGUMENTS

---

## Workflow

1. **Verify Site Exists** — Locate the Power Pages project, explore existing patterns, and verify prerequisites
2. **Understand Requirements** — Determine the user intent and whether the solution needs one or more server logic files
3. **Fetch Latest Documentation** — Query Microsoft Learn for the most current Server Logic SDK reference
4. **Review Implementation Plan** — Present the plan to the user and confirm before writing code
5. **Implement Server Logic** — Create the approved `.js` and `.serverlogic.yml` files in `.powerpages-site/server-logic/<name>/`
6. **Configure Table Permissions** — *(Conditional: only if Server.Connector.Dataverse is used)* Set up table permissions for Dataverse tables accessed by the server logic
7. **Manage Secrets & Environment Variables** — *(Conditional: only if the server logic requires secrets)* Store sensitive values securely using Azure Key Vault (recommended) or direct environment variables in Dataverse
8. **Configure Site Settings** — Set up ServerLogic site settings if needed
9. **Client-Side Integration** — Help wire the server logic into the site's frontend code
10. **Verify & Test Guidance** — Validate the code and provide testing instructions
11. **Review & Deploy** — Present summary and offer deployment

---

## Phase 1: Verify Site Exists

**Goal**: Locate the Power Pages project root and confirm prerequisites

**Actions**:

1. Create todo list with all 11 phases (see [Progress Tracking](#progress-tracking) table)

### 1.1 Locate Project

Look for `powerpages.config.json` in the current directory or immediate subdirectories

**If not found**: Tell the user to create a site first with `/create-site`.

### 1.2 Read Existing Config

Read `powerpages.config.json` to get the site name and configuration:

### 1.3 Detect Framework

Read `package.json` to determine the frontend framework (React, Vue, Angular, or Astro). This is needed for Phase 8 (client-side integration guidance). See `${CLAUDE_PLUGIN_ROOT}/references/framework-conventions.md` for the full framework detection mapping.

### 1.4 Explore Existing Server Logic and Frontend Code

Use the **Explore agent** (via `Task` tool with `agent_type: "explore"`) to analyze the site for existing server logic patterns and frontend code that may call or need to call server logic endpoints.

**Prompt for the Explore agent:**

> "Analyze this Power Pages code site for server logic context. Check:
> 1. Does `.powerpages-site/server-logic/` exist? If yes, list all subdirectories and their .js files. Summarize what each server logic does (which functions it implements, what SDK features it uses). Also read the corresponding .serverlogic.yml files to check web role assignments.
> 2. Search the frontend source code (`src/**/*.{ts,tsx,js,jsx,vue,astro}`) for any existing calls to `/_api/serverlogics/` — these indicate server logic endpoints already being consumed.
> 3. Look for CSRF token handling patterns (`__RequestVerificationToken`, `_layout/tokenhtml`) — these show how the site currently makes authenticated API calls.
> 4. Check for any TODO/FIXME comments mentioning server logic, backend, or server-side processing.
> 5. Look for hardcoded API URLs, mock data, or placeholder fetch calls that might need to be replaced with server logic calls.
> 6. Check for any existing service layer or API utility files in `src/shared/`, `src/services/`, or similar directories that could be reused for server logic integration.
> 7. Read `.powerpages-site/web-roles/*.webrole.yml` files to list available web roles and their GUIDs — these are needed when creating the server logic metadata YAML.
> 8. For each existing server logic, assess whether it can be reused or safely extended for the requested capability instead of creating a brand-new server logic file. Call out any strong reuse candidates and explain why.
> Report all findings so we can avoid duplicating work and match existing patterns."

From the Explore agent's findings, note:
- **Existing server logic files** — what's already implemented, and which ones are candidates for reuse or extension
- **Frontend calling patterns** — how the site makes API calls (match this pattern in Phase 9)
- **Existing service/utility files** — reuse these when adding client-side integration
- **Gaps** — frontend code that references server logic endpoints that don't exist yet

### 1.5 Check Deployment Status (Mandatory)

Look for the `.powerpages-site` folder:


**If not found**: The site **must** be deployed before server logic can be created — server logic files live inside `.powerpages-site/server-logic/`. Tell the user:

> "The `.powerpages-site` folder was not found. Server logic files are stored inside this folder, so the site must be deployed at least once before creating server logic. Would you like to deploy now?"

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| The `.powerpages-site` folder is required for server logic. Would you like to deploy the site now? | Yes, deploy now (Required), Cancel |

**If "Yes, deploy now"**: Invoke `/deploy-site` first, then continue to Phase 2.

**If "Cancel"**: Stop the workflow — server logic cannot be created without `.powerpages-site`.

**Output**: Confirmed project root, `.powerpages-site` exists, existing server logic (if any), available web roles

---

## Phase 2: Understand Requirements

**Goal**: Determine the user intent, identify whether one or more server logic files are needed, and capture the required HTTP methods for each item

**Actions**:

### 2.1 Analyze User Request

From the user's request, determine:

- **Intent shape**: Does the request map to a single server logic or multiple server logic?
- **Reuse opportunities**: Can an existing server logic satisfy or be safely extended for part of the request?
- **Server logic inventory**: For each required server logic, capture the purpose, suggested endpoint name, and whether it should be reused, extended, or created new
- **HTTP methods needed**: Which of the 5 functions should be implemented for each server logic (`get`, `post`, `put`, `patch`, `del`)

Prefer reuse or safe extension of an existing server logic when it already matches the domain, security model, and lifecycle of the requested capability. Only create a new server logic when reuse would make the existing file confusing, over-broad, or unsafe.

Prefer multiple server logic files when the use case naturally separates into different responsibilities, security boundaries, or lifecycle concerns. Examples:

- Separate read vs. write workflows with different web role requirements
- Distinct integrations with different external systems or site settings
- Independent business capabilities that would be harder to test or reason about if merged into one endpoint

### 2.1.1 Identify Validate-and-Execute Patterns

For each planned server logic item, determine whether it should **validate-and-execute** — meaning the server logic both validates a business rule AND performs the resulting Dataverse write, rather than just returning a validation result for the client to act on.

A server logic item should validate-and-execute when **any** of these are true:

| Condition | Example |
|-----------|---------|
| It enforces a state machine or lifecycle | Order status: Draft → Submitted → Approved |
| The write is conditional on a business rule that must be tamper-proof | "Only allow bid submission before the deadline" |
| The operation spans multiple tables atomically | Award a bid + reject all others + update event status |
| The write involves a computed or derived value | Server calculates a score and writes it |
| The client should not have direct write access to the field | Status fields with strict transition rules |

For each validate-and-execute item, note:
- **Which Dataverse writes the server logic will perform** (UpdateRecord, CreateRecord, etc.)
- **Which fields are being written** — these fields should NOT be writable via Web API from the client
- **What the server logic returns to the client** — typically a success/failure result with the before/after state, NOT a validation flag that the client acts on

**Anti-pattern to avoid**: A server logic item that only validates and returns `{ valid: true/false }`, expecting the client to make a separate Web API call to perform the write. This allows the client to skip validation and write directly.

### 2.1.2 Discover Dataverse Custom Actions

If any planned server logic item involves Dataverse operations, check whether the user's Dataverse environment has existing custom actions (Custom APIs or Custom Process Actions) that could be leveraged instead of building logic from scratch.

**Step 1 — Fetch custom actions:**

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/list-custom-actions.js" "<ENV_URL>"
```

The script outputs a JSON object with:
- `customApis` — Modern Custom APIs with full request parameters and response properties
- `customProcessActions` — Legacy Custom Process Actions (activated only)
- `total` — Total count of both types combined

Each entry includes: `name`, `displayName`, `description`, `type` (`action` or `function`), `binding` (`unbound`, `entity`, or `entityCollection`), `boundEntity`, and `source` (`customApi` or `customProcessAction`). Custom APIs also include `requestParameters` and `responseProperties` arrays.

**Step 2 — Present and ask the user:**

If custom actions are found (`total > 0`), present a summary to the user grouped by binding type (unbound vs. entity-bound) and ask whether any should be used:

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| Your Dataverse environment has `<total>` custom action(s). Would you like to use any of these in your server logic instead of writing the logic from scratch? | Yes, let me choose which ones to use; No, build everything from scratch |

Present the list clearly — for each action show: name, description, type (action/function), binding, and bound entity (if applicable). Group them as **Unbound** and **Entity-bound** for readability.

If the user says **No**, skip to Phase 2.2.

**Step 3 — Map custom actions to server logic items:**

If the user says **Yes**, for each server logic item being created, ask which custom action (if any) it should wrap:

Use `AskUserQuestion` for each server logic item:

| Question | Context |
|----------|---------|
| For the `<server-logic-name>` endpoint, which custom action should it use? | Present the list of custom actions with their names, descriptions, and binding types. Include **"None — build from scratch"** as an option. |

Record the mapping for each server logic item. For items that wrap a custom action, note:
- The custom action name (used in the `InvokeCustomApi` call)
- Whether it's a function (`GET`) or action (`POST`)
- The binding type and bound entity (if applicable)
- The request parameters and response properties (if available from Custom APIs)

This mapping will be used in Phase 5.3 when generating the server logic code, and will appear in the HTML plan (Phase 4) to indicate which items wrap existing custom actions.

### 2.2 Identify SDK Features Needed

Based on each planned server logic item's purpose, identify which Server SDK features are required:

| Feature | When to use |
|---------|-------------|
| `Server.Connector.HttpClient` | Calling external REST APIs (NOT Dataverse) |
| `Server.Connector.Dataverse` | Reading/writing Dataverse records (CRUD + `InvokeCustomApi` for Dataverse Custom APIs) |
| `Server.Context` | Accessing request parameters, headers, body |
| `Server.User` | User-scoped operations, role checks |
| `Server.Logger` | Always — every function should log entry/exit and errors |
| `Server.Sitesetting` | Reading site setting configuration values |
| `Server.EnvironmentVariable` | Reading Dataverse environment variable values directly via `Server.EnvironmentVariable.get(name)` — an alternative to `Server.Sitesetting` for non-secret config |
| `Server.Website` | Accessing site metadata |

### 2.3 Identify Secret Values

Determine whether any server logic item requires secret or sensitive configuration values that should not be hardcoded. Common examples:

| Scenario | Secret needed |
|----------|---------------|
| Calling an authenticated external API | API key, client secret, bearer token |
| Connecting to a third-party service | Connection string, access token |
| OAuth2 client credentials flow | Client ID + client secret |
| Webhook verification | Signing secret, shared key |

For each identified secret, capture:
- **Secret name**: A descriptive name (e.g., `ExchangeRateApiKey`, `PaymentGatewaySecret`)
- **Purpose**: Why the secret is needed
- **Site setting name**: The name the server logic will use with `Server.Sitesetting.Get()` (e.g., `ExternalApi/ExchangeRateApiKey`)
- **Environment variable schema name**: The Dataverse environment variable schema name (e.g., `cr5b4_ExchangeRateApiKey`)

These values will be used in Phase 7 to create the environment variables and site settings.

### 2.3.1 Key Vault Decision

If secrets were identified in Phase 2.3, ask the user now whether they want to use Azure Key Vault. This decision must happen before Phase 4 so the implementation plan can show the chosen secret management approach.

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| This server logic requires secret values (e.g., API keys, client secrets). Azure Key Vault is the recommended way to store secrets securely. Would you like to use Azure Key Vault? | Yes, use Azure Key Vault (Recommended), No, store directly as environment variable |

Record the user's choice — it will be shown in the HTML plan (Phase 4) and executed in Phase 7.

### 2.4 Confirm with User

If the requirements are ambiguous, use `AskUserQuestion` to clarify:

| Question | Context |
|----------|---------|
| What should this server logic solution do overall? | If the purpose is unclear |
| Should this be one server logic or multiple server logic? | If the request could reasonably be modeled either way |
| Which HTTP methods does each server logic need? | If not specified — suggest based on the use case (e.g., read-only = GET, form processing = POST) |
| Does each server logic need to call external APIs, Dataverse, or both? | Determines which connectors to use |
| What should each server logic be named? | Suggest URL-friendly names based on the responsibilities |
| Does the server logic need any secret or sensitive values (API keys, client secrets, tokens)? | If the server logic calls authenticated external APIs or services |

**Output**: Clear understanding of the overall intent, the list of server logic items to reuse/extend/create, their HTTP methods, SDK features needed, and any secrets required

---

## Phase 3: Fetch Latest Documentation

**Goal**: Discover and read all current Server Logic documentation from Microsoft Learn before writing any code

This step is critical because Server Logic is a preview feature and the SDK surface may change. The documentation on Microsoft Learn is the authoritative source.

**Actions**:

### 3.1 Follow the Documentation Reference

Use the reference document below as the source of truth for how to discover, classify, fetch, and reconcile Server Logic documentation:

> Reference: `${CLAUDE_PLUGIN_ROOT}/skills/add-server-logic/references/server-logic-docs.md`

Follow that reference to:

- Search Microsoft Learn dynamically for all current Server Logic docs
- Fetch the core reference pages and any relevant scenario-specific pages
- Search for current code samples
- Reconcile the discovered documentation with the known SDK baseline in the reference

### 3.2 Extract Task-Specific Notes

From the fetched docs, extract and note the items that matter for the current task:

- All SDK method signatures, parameter types, and return types
- Current supported HTTP methods and function signatures
- Site settings and their defaults
- Security model (web roles, table permissions, CSRF)
- Client-side calling patterns and response format
- Any new methods or breaking changes discovered in Microsoft Learn

**Output**: Up-to-date SDK reference verified against all relevant Microsoft Learn documentation pages

---

## Phase 4: Review Implementation Plan

**Goal**: Present the implementation plan to the user and confirm before writing any code

**Actions**:

### 4.1 Prepare the Plan Data

Build the server logic plan data and render the HTML plan before asking for approval.

> Reference: `${CLAUDE_PLUGIN_ROOT}/skills/add-server-logic/references/server-logic-plan-data-format.md`

The rendered plan should summarize:

- The number of server logic items being created or reused
- Each endpoint name, API URL, and files to be created
- The functions that will be implemented and what each one does
- The SDK features, external services, and Dataverse tables involved for each item
- The web roles, security constraints, and site settings that apply to each item
- Any secrets or sensitive values that will be stored as environment variables (with or without Azure Key Vault). If the user chose Azure Key Vault in Phase 2.3.1, populate `SECRETS_DATA` with `useKeyVault: true` and the list of secrets — the HTML plan will render a Key Vault banner explaining the security benefits and show which secrets each server logic depends on. If no secrets are needed, set `SECRETS_DATA` to `null`.
- The expected next steps after approval

### 4.2 Render the HTML Plan

Generate the HTML plan file from the template and open it in the user's default browser before asking for approval.

When working inside a Power Pages project, write the plan to:

```text
<PROJECT_ROOT>/docs/serverlogic-plan.html
```

Create the `docs/` folder if it does not already exist. Keep this HTML file inside the repository so it can be reviewed and committed with the rest of the server logic work.

Do **not** hand-author the HTML. Use the render script:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/render-serverlogic-plan.js" --output "<OUTPUT_PATH>" --data "<DATA_JSON_PATH>"
```

The render script refuses to overwrite existing files. Before calling it, check if the default output path (`<PROJECT_ROOT>/docs/serverlogic-plan.html`) already exists. If it does, choose a new descriptive filename based on context — e.g., `serverlogic-plan-exchange-rate.html`, `serverlogic-plan-apr-2026.html`. Pass the chosen name via `--output`.

### 4.3 Present Plan Summary

Do **not** present a second detailed plan in the CLI. The HTML file is the single detailed plan artifact.

In the CLI, give only a brief summary that points the user to the HTML plan open in the browser. Keep it to:

- Total server logic count
- Whether the plan is creating, updating, or reusing items
- Whether web roles, table permissions, or site settings are involved
- The actual output path returned by the render script
- A note that the browser-opened HTML contains the full details

Do not restate the per-server-logic breakdown, rationale, role assignments, or function details inline in the CLI unless the user explicitly asks for a text version. Tell the user where the detailed HTML plan file was saved, that it has been opened in the browser for review, and that the repo copy of the plan will be committed with the implementation artifacts unless the user asks to discard it.

### 4.4 Confirm with User

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| Here's the implementation plan for this server logic work. Does it look correct? | Approve and implement (Recommended), Request changes, Cancel |

**If "Request changes"**: Ask what needs to change, update the plan, and present again.

**If "Cancel"**: Stop the workflow.

**Output**: User-approved implementation plan

---

## Phase 5: Implement Server Logic

**Goal**: Create each approved server logic `.js` file and metadata YAML following the constraints verified in Phase 3

**Actions**:

### 5.1 Create Server Logic Folder

For each approved server logic item:

- **If the approved plan says `reuse`**: Do not create a new folder. Reuse the existing server logic as-is and only update the surrounding integration work if needed.
- **If the approved plan says `update` / extend**: Reuse the existing folder and update the existing `.js` / `.serverlogic.yml` files rather than creating duplicates.
- **If the approved plan says `create`**: Create the folder inside `.powerpages-site/server-logic/` (note: singular `server-logic`, no trailing 's'). Ensure the folder name matches that endpoint name exactly.

### 5.2 Read or Create Web Roles

Use the **Create Web Role** skill to determine which web roles are required for the approved server logic plan and to create any missing roles before writing metadata.

Do **not** assume every server logic should get every available role. Instead, determine the minimum set of roles required for each server logic based on its purpose, security model, and the approved plan.

Example web role file content:
```yaml
adx_anonymoususersrole: false
adx_authenticatedusersrole: true
description: Role for authenticated users
id: a1b2c3d4-e5f6-7890-abcd-ef1234567890
name: Authenticated Users
```

In the skill workflow, explicitly invoke the **Create Web Role** skill when:

- The site has no suitable existing web roles
- The approved plan includes proposed roles that do not exist yet
- The role assignments need to be refined before metadata can be created

After the Create Web Role skill completes, read the resulting web role YAML files and collect the `id` and `name` values needed for each server logic's metadata YAML.

### 5.3 Create the Server Logic File

Repeat this step for each approved server logic item. Create or update `<PROJECT_ROOT>/.powerpages-site/server-logic/<name>/<name>.js` according to the approved plan status (`create`, `update`, or `reuse`) and follow these mandatory patterns:

#### Structure Rules

1. **Only top-level functions**: The file can only contain these 5 functions at the top level: `get`, `post`, `put`, `patch`, `del`. Only include the functions the user needs.
2. **Each function returns a string**: Use `JSON.stringify()` for objects/arrays.
3. **Each function has try/catch**: Every function must wrap its logic in a try/catch block.
4. **Each function logs**: Use `Server.Logger.Log()` at entry and `Server.Logger.Error()` in catch blocks.
5. **No imports or requires**: No `import`, `require`, or external dependencies.
6. **No browser APIs**: No `fetch`, `XMLHttpRequest`, `setTimeout`, `setInterval`, `console.log`, or DOM APIs.
7. **Async when needed**: Mark functions as `async` only when they use `await` (HttpClient calls). Dataverse connector methods (`Server.Connector.Dataverse.*`) are **synchronous** — do NOT use `async`/`await` with them.

#### Code Template

```javascript
// Server Logic: <name>
// Purpose: <description>
// API URL: https://<site-url>/_api/serverlogics/<name>

function get() {
    try {
        Server.Logger.Log("<name> GET called");

        // Access query parameters
        // const id = Server.Context.QueryParameters["id"];

        // Your logic here...

        return JSON.stringify({
            status: "success",
            method: "GET",
            data: null // replace with actual data
        });
    } catch (err) {
        Server.Logger.Error("<name> GET failed: " + err.message);
        return JSON.stringify({
            status: "error",
            method: "GET",
            message: err.message
        });
    }
}
```

#### Validate-and-Execute Template

When a server logic item is identified as validate-and-execute (see Phase 2.1.1), use this pattern. The key difference: the server logic reads the current state, validates the business rule, AND writes the result to Dataverse — all in one call. The client never writes the protected field directly.

```javascript
// Server Logic: <name>
// Purpose: Validate and execute <describe the operation>
// Pattern: Validate-and-execute — this endpoint both validates the business rule
//          and performs the Dataverse write. The client should NOT write <protected fields>
//          via Web API — all writes to those fields go through this endpoint.
// API URL: https://<site-url>/_api/serverlogics/<name>

function post() {
    try {
        Server.Logger.Log("<name> POST called");

        const body = JSON.parse(Server.Context.Body);
        const entityId = body.entityId;
        const targetStatus = body.targetStatus;

        // 1. Read the current record from Dataverse
        const current = Server.Connector.Dataverse.RetrieveRecord("<table-name>", entityId, "?$select=<status-field>");
        const currentStatus = current["<status-field>"];

        // 2. Validate the transition
        const allowedTransitions = {
            "Draft": ["Submitted"],
            "Submitted": ["Approved", "Rejected"],
            "Approved": ["Fulfilled"]
        };

        const allowed = allowedTransitions[currentStatus] || [];
        if (!allowed.includes(targetStatus)) {
            return JSON.stringify({
                status: "error",
                message: "Invalid transition: " + currentStatus + " → " + targetStatus + " is not allowed",
                currentStatus: currentStatus,
                targetStatus: targetStatus,
                allowedTargets: allowed
            });
        }

        // 3. Execute the write — server performs the Dataverse update
        const updateData = {};
        updateData["<status-field>"] = targetStatus;
        Server.Connector.Dataverse.UpdateRecord("<table-name>", entityId, JSON.stringify(updateData));

        Server.Logger.Log("<name> transition executed: " + currentStatus + " → " + targetStatus);

        // 4. Return the result — client receives confirmation, not a validation flag
        return JSON.stringify({
            status: "success",
            previousStatus: currentStatus,
            newStatus: targetStatus,
            entityId: entityId
        });
    } catch (err) {
        Server.Logger.Error("<name> POST failed: " + err.message);
        return JSON.stringify({
            status: "error",
            message: err.message
        });
    }
}
```

**Key differences from the basic template:**
1. The server logic reads the current state from Dataverse (not trusting the client's view)
2. It validates the business rule server-side
3. It writes the result to Dataverse via `Server.Connector.Dataverse.UpdateRecord`
4. It returns a success/failure result — NOT a `{ valid: true/false }` flag for the client to act on
5. The client calls this one endpoint — it does NOT make a separate Web API PATCH call

#### Custom Action Wrapping Template

When a server logic item wraps a Dataverse custom action (mapped in Phase 2.1.2), use this pattern with `Server.Connector.Dataverse.InvokeCustomApi`. The server logic acts as a portal-friendly wrapper, exposing the custom action through a `/_api/serverlogics/<name>` endpoint with proper web role authorization.

**Unbound action:**

```javascript
// Server Logic: <name>
// Purpose: Wraps Dataverse custom action "<custom-action-name>" for portal consumption
// Custom Action: <custom-action-name> (unbound, action)
// API URL: https://<site-url>/_api/serverlogics/<name>

function post() {
    try {
        Server.Logger.Log("<name> POST called — invoking custom action <custom-action-name>");

        const body = JSON.parse(Server.Context.Body);

        // Build the request payload matching the custom action's input parameters
        const payload = JSON.stringify({
            // "<ParameterName>": body.<clientFieldName>
        });

        const result = Server.Connector.Dataverse.InvokeCustomApi(
            "POST",
            "<custom-action-name>",
            payload
        );

        Server.Logger.Log("<name> custom action completed successfully");

        return JSON.stringify({
            status: "success",
            data: result
        });
    } catch (err) {
        Server.Logger.Error("<name> POST failed: " + err.message);
        return JSON.stringify({
            status: "error",
            message: err.message
        });
    }
}
```

**Entity-bound action:**

```javascript
function post() {
    try {
        Server.Logger.Log("<name> POST called — invoking bound action <custom-action-name>");

        const body = JSON.parse(Server.Context.Body);
        const entityId = body.entityId;

        const payload = JSON.stringify({
            // "<ParameterName>": body.<clientFieldName>
        });

        // Include the entity set and record ID, followed by the fully qualified action name
        const result = Server.Connector.Dataverse.InvokeCustomApi(
            "POST",
            "<entity-set-name>(" + entityId + ")/Microsoft.Dynamics.CRM.<custom-action-name>",
            payload
        );

        Server.Logger.Log("<name> bound action completed for entity " + entityId);

        return JSON.stringify({
            status: "success",
            data: result,
            entityId: entityId
        });
    } catch (err) {
        Server.Logger.Error("<name> POST failed: " + err.message);
        return JSON.stringify({
            status: "error",
            message: err.message
        });
    }
}
```

**Unbound function (read-only, GET):**

```javascript
function get() {
    try {
        Server.Logger.Log("<name> GET called — invoking custom function <custom-function-name>");

        // Pass parameters as query string for functions
        const param1 = Server.Context.QueryParameters["param1"];
        const queryString = "<custom-function-name>(Param1='" + param1 + "')";

        const result = Server.Connector.Dataverse.InvokeCustomApi(
            "GET",
            queryString,
            null
        );

        Server.Logger.Log("<name> custom function completed successfully");

        return JSON.stringify({
            status: "success",
            data: result
        });
    } catch (err) {
        Server.Logger.Error("<name> GET failed: " + err.message);
        return JSON.stringify({
            status: "error",
            message: err.message
        });
    }
}
```

**Key points:**
- **Unbound actions**: Use the action name as the URL, pass parameters as JSON body
- **Entity-bound actions**: Include the entity set and record ID in the URL path, followed by `Microsoft.Dynamics.CRM.<action-name>`
- **Functions (GET)**: Use `"GET"` as the HTTP method and pass parameters inline in the URL using OData function call syntax
- **Actions (POST)**: Use `"POST"` as the HTTP method and pass parameters as JSON body payload
- `InvokeCustomApi` is **synchronous** — do NOT use `async`/`await`
- The server logic can add additional validation, transformation, or logging around the custom action call — it doesn't have to be a pass-through
- When Custom API response properties are known (from Phase 2.1.2), map them to the response object for clarity

#### Referencing Secrets in Code

When the server logic needs a secret value identified in Phase 2.3, **never hardcode the value**. Instead, read it at runtime from a site setting backed by an environment variable:

```javascript
const apiKey = Server.Sitesetting.Get("ExternalApi/ExchangeRateApiKey");
```

Use the site setting name planned in Phase 2.3. The actual environment variable and site setting YAML will be created in Phase 7.

#### SDK Usage Guidance

Do **not** duplicate Microsoft Learn SDK usage patterns inline in this skill. Use the documentation fetched in Phase 3 as the source of truth for connector methods, signatures, and supported patterns, then apply only the task-specific notes that were captured in the approved plan.

### 5.4 Create the Metadata YAML

For each approved server logic item where the plan status is `create`, generate the metadata file with the deterministic writer script instead of hand-authoring the YAML. The script generates the UUID, writes the fields in the correct order, and returns the created file path as JSON. **Skip this step for `update` / `reuse` items** — the YAML already exists and should be updated manually if needed.

```powershell
node "${CLAUDE_PLUGIN_ROOT}/skills/add-server-logic/scripts/create-serverlogic-metadata.js" --projectRoot "<PROJECT_ROOT>" --name "<name>" --displayName "<human-readable display name>" --description "<description of what this server logic does>" --webRoleIds "<uuid1,uuid2,uuid3>"
```

The generated `<PROJECT_ROOT>/.powerpages-site/server-logic/<name>/<name>.serverlogic.yml` file has this structure:

```yaml
adx_serverlogic_adx_webrole:
  - <web-role-guid-1>
  - <web-role-guid-2>
  - <web-role-guid-3>
description: <description of what this server logic does>
display_name: <human-readable display name>
id: <generated-uuid>
name: <name>
```

**Critical requirements:**

- **`id` field is mandatory** — The script generates a new UUID (v4). PAC CLI crashes with `Expected Guid for primary key 'id'` if this is missing.
- **`adx_serverlogic_adx_webrole`** — Array of web role GUIDs from step 5.2. Include only the roles required for that server logic item.
- **`name`** — Must match the folder name and `.js` file name (the URL-friendly name used in `/_api/serverlogics/<name>`).
- **`display_name`** — Human-readable name (e.g., "Exchange Rate API", "Order Processor").
- **Alphabetical field ordering** — Fields must be sorted alphabetically: `adx_serverlogic_adx_webrole`, `description`, `display_name`, `id`, `name`.

### 5.5 Validate the Code

Before saving, verify the code against these constraints:

| Constraint | Check |
|-----------|-------|
| Only allowed top-level functions | No functions other than get, post, put, patch, del |
| Every function returns a string | All code paths return a string (including catch blocks) |
| try/catch in every function | Every function body is wrapped in try/catch |
| Server.Logger in every function | Log at entry, Error in catch |
| No external dependencies | No `import`, `require`, `module.exports` |
| No browser APIs | No `fetch`, `XMLHttpRequest`, `setTimeout`, `console.log`, `document`, `window` |
| Async only when needed | Only functions using `await` are marked `async` |
| ECMAScript 2023 compliant | Standard JS features only (optional chaining, nullish coalescing, etc. are fine) |

### 5.6 Git Commit

After creating the approved server logic files, do a git commit for the server logic changes.

If the HTML plan was generated inside the project, include it in the same commit (use the actual output path from the render script's JSON response).

**Output**: Server logic `.js` and `.serverlogic.yml` files created, validated, and committed

---

## Phase 6: Configure Table Permissions (Conditional)

**Goal**: Set up table permissions for Dataverse tables accessed by `Server.Connector.Dataverse` in the server logic code

**This phase only runs when the server logic uses `Server.Connector.Dataverse`.** If the server logic only uses `Server.Connector.HttpClient` (external APIs) or doesn't access Dataverse at all, skip this phase entirely and proceed to Phase 7.

`Server.Connector.Dataverse` does **NOT** bypass table permissions — it respects them. Without table permissions configured, the Dataverse connector silently returns 0 records instead of the actual data. This is a common source of confusion.

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
| `accounts` | Yes | — | — | — |
| `contacts` | Yes | Yes | — | — |

### 6.2 Use the Table Permissions Architect

When any approved server logic item uses `Server.Connector.Dataverse`, invoke the `table-permissions-architect` agent at `${CLAUDE_PLUGIN_ROOT}/agents/table-permissions-architect.md` to determine and create the required table permissions.

**Prompt:**

> "Analyze this Power Pages code site and propose table permissions for Dataverse tables accessed by the approved server logic plan. The following tables need permissions:
>
> [list each table with required CRUD privileges from step 6.1, grouped by server logic item]
>
> Context:
> - These permissions are needed because the server logic uses `Server.Connector.Dataverse`, which respects table permissions — without them, the connector silently returns 0 records.
> - The scope should typically be **Global** for server logic that fetches all records, unless the server logic filters by the current user (in which case use **Contact** scope).
> - The web roles assigned to these server logic items are: [list web role names and GUIDs from Phase 5.2]
> - Project root: [path]
>
> Check for existing table permissions and web roles. If new web roles are needed, create them using the create-web-role.js script. Propose a plan, then after approval create the table permission YAML files using the deterministic scripts."

The agent will:
1. Discover existing table permissions and web roles
2. Create any missing web roles via `create-web-role.js` if needed
3. Propose a table permissions plan (with HTML visualization)
4. Present the plan via plan mode for user approval
5. After approval, create table permission YAML files in `.powerpages-site/table-permissions/` using `create-table-permission.js`

### 6.3 Git Commit

After table permissions (and any new web roles) are created, do a git commit for the table permissions changes.

**Output**: Table permissions (and web roles if created) configured for all Dataverse tables accessed by the server logic

---

## Phase 7: Manage Secrets & Environment Variables

**Goal**: Securely store any secret values (API keys, client secrets, connection strings) required by the server logic as environment variables in Dataverse, optionally backed by Azure Key Vault

**This phase only runs when the server logic requires secret or sensitive configuration values** (identified in Phase 2.3). If no secrets are needed, skip this phase and proceed to Phase 8.

**Actions**:

### 7.1 Recall Key Vault Decision

The user already chose whether to use Azure Key Vault in Phase 2.3.1 (before the plan was presented). Use that decision here — do **not** re-ask.

### 7.2a Azure Key Vault Path

If the user chose Azure Key Vault in Phase 2.3.1:

**Step 1 — List available Key Vaults:**

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/list-azure-keyvaults.js"
```

The script outputs a JSON array of Key Vaults (`name`, `resourceGroup`, `location`) from the user's Azure subscription.

**Step 2 — Select or create a Key Vault:**

If Key Vaults were found, present the list and ask which one to use:

Use `AskUserQuestion`:

| Question | Context |
|----------|---------|
| Which Azure Key Vault would you like to use for storing secrets? | Present the names from the script output |

If **no Key Vaults are found**, ask the user how to proceed:

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| No Azure Key Vaults were found in your subscription. Would you like to create one, or fall back to storing secrets directly as environment variables? | Create a new Key Vault (Recommended), Store directly as environment variable |

**If "Create a new Key Vault"**: Ask for a vault name, resource group, and location, then create it:

Use `AskUserQuestion`:

| Question | Context |
|----------|---------|
| What name, resource group, and Azure region would you like for the new Key Vault? | Vault names must be 3-24 characters, globally unique, start with a letter, and contain only alphanumerics and hyphens. Suggest a name based on the project/site name. |

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-azure-keyvault.js" \
  --name "<vault-name>" \
  --resourceGroup "<resource-group>" \
  --location "<location>"
```

The script outputs a JSON object with `name`, `resourceGroup`, and `location`. Use the created vault for the remaining steps.

**If "Store directly as environment variable"**: Skip the rest of Phase 7.2a and proceed to Phase 7.2b (direct environment variable path).

**Step 3 — Provide instructions for storing each secret in Key Vault:**

For each secret identified in Phase 2.3, give the user instructions to store the value themselves. Do **not** ask for the secret value — secret values must never pass through the conversation.

Present **both** methods (CLI and Azure Portal) so the user can choose whichever they prefer:

**Option A — Azure CLI (recommended for automation):**

Present the commands as a numbered list the user can copy and run. Use the stdin form so the secret value does not appear in process listings:

```
For each secret, run the following command (replacing <YOUR_SECRET_VALUE> with the actual value):

1. <secret-name>:
   printf '%s' '<YOUR_SECRET_VALUE>' | node "${CLAUDE_PLUGIN_ROOT}/scripts/store-keyvault-secret.js" \
     --vaultName "<selected-vault>" \
     --secretName "<secret-name>"
```

Tell the user each command outputs a JSON object with a `secretUri` and to share the output (which contains only the URI, not the secret) so the workflow can continue.

**Option B — Azure Portal:**

Provide these steps for each secret:

```
1. Go to the Azure Portal (https://portal.azure.com)
2. Search for "Key vaults" in the top search bar and select it
3. Select the Key Vault: <selected-vault>
4. In the left menu under "Objects", click "Secrets"
5. Click "+ Generate/Import" at the top
6. Fill in the fields:
   - Upload options: Manual
   - Name: <secret-name>
   - Secret value: paste your secret value here
   - Leave other fields as defaults
7. Click "Create"
8. After creation, click on the secret name, then click the current version
9. Copy the "Secret Identifier" URI and share it here so the workflow can continue
```

Tell the user the Secret Identifier URI looks like `https://<vault-name>.vault.azure.net/secrets/<secret-name>/<version>` and that this URI (not the secret value) is what should be shared back.

**Step 4 — Create environment variable in Dataverse:**

After the user shares the `secretUri` output from each command, create an environment variable definition in Dataverse that references the Key Vault secret. Use the `secret` type:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-environment-variable.js" "<ENV_URL>" \
  --schemaName "<prefix_SecretName>" \
  --displayName "<Secret Display Name>" \
  --type "secret" \
  --value "<secretUri-from-step-3>"
```

**Step 5 — Create site setting for the environment variable:**

For each environment variable, create a site setting YAML that maps to it:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "<SiteSetting/Name>" \
  --envVarSchema "<schemaName-from-step-4>"
```

This creates a site setting with `envvar_schema` and `source: 1`, which tells Power Pages to resolve the value from the Dataverse environment variable (backed by Key Vault).

### 7.2b Direct Environment Variable Path

If the user chose not to use Azure Key Vault:

**Step 1 — Create environment variables with placeholder values:**

For each secret identified in Phase 2.3, create the environment variable in Dataverse with a placeholder value:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-environment-variable.js" "<ENV_URL>" \
  --schemaName "<prefix_SecretName>" \
  --displayName "<Secret Display Name>" \
  --value "PLACEHOLDER_SET_ACTUAL_VALUE"
```

**Step 2 — Create site setting for the environment variable:**

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "<SiteSetting/Name>" \
  --envVarSchema "<schemaName-from-step-1>"
```

**Step 3 — Give the user steps to set the actual secret values:**

Do **not** ask for secret values — they must never pass through the conversation. Instead, tell the user to update each placeholder with the real value using one of these approaches:

1. **Power Apps maker portal** ([make.powerapps.com](https://make.powerapps.com)) — Go to **Solutions** → **Default Solution** → **Environment variables** → find the variable by display name → update the value

Present the list of environment variables that need updating (display name and schema name for each) so the user knows exactly which ones to set.

### 7.3 Verify Environment Variable Configuration

After creating all environment variables and site settings:

- Confirm each site setting YAML was created in `.powerpages-site/site-settings/`
- Verify each YAML contains `envvar_schema` and `source: 1`
- Confirm the server logic code references the correct site setting names via `Server.Sitesetting.Get("<SiteSetting/Name>")`

### 7.4 Git Commit

Do a git commit for the environment variable site setting changes.

**Output**: Environment variables created in Dataverse (with or without Azure Key Vault backing), site settings configured, server logic referencing correct setting names

---

## Phase 8: Configure Site Settings

**Goal**: Set up site settings for the server logic feature

**Actions**:

### 8.1 Configure Server Logic Site Settings

The `.powerpages-site` folder is guaranteed to exist at this point (verified in Phase 1.5).

The following site settings control server logic behavior. Only create settings that differ from defaults or are specifically needed:

| Setting | Description | Default | When to configure |
|---------|-------------|---------|-------------------|
| `ServerLogic/Enabled` | Enable/disable server logic feature | `true` | Only if explicitly disabled and needs re-enabling |
| `ServerLogic/AllowedDomains` | Restrict which external domains HttpClient can call | All domains | When the server logic calls external APIs and you want to restrict to specific domains for security |
| `ServerLogic/TimeoutInSeconds` | Maximum execution time | `120` | The platform caps this at **120 seconds** — values above 120 are silently clamped. Only configure when you need to lower the timeout, not raise it. |
| `ServerLogic/AllowNetworkingToAllDomains` | Allow networking across domains | `true` | Set to `false` when restricting via AllowedDomains |

Use the existing site setting creation script:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" --projectRoot "<PROJECT_ROOT>" --name "ServerLogic/AllowedDomains" --value "api.example.com,api.other.com" --description "Restrict server logic external API calls to these domains"
```

### 8.2 Git Commit

If any settings were created:

Do a git commit for the site settings changes.

**Output**: Site settings configured and committed (or skipped if not needed/deployed)

---

## Phase 9: Client-Side Integration

**Goal**: Help the user call the server logic endpoints from their site's frontend code, matching existing patterns discovered in Phase 1

Server logic creates the backend — but without frontend code to call it, the endpoints are unused. This phase creates or updates frontend code to consume the server logic APIs, using the patterns and conventions already established in the codebase.

**Actions**:

### 9.1 Ask User About Integration Scope

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| I've created the server logic backend. Would you like me to also fully integrate it into the frontend UI? | Yes, fully integrate it into the UI (Recommended), No, I'll handle the frontend myself |

**If "No"**: Skip to Phase 10, but provide the API URL and a code snippet the user can copy.

### 9.2 Follow the Frontend Integration Reference

Use the reference below for the frontend integration approach, examples, and framework-specific patterns:

> Reference: `${CLAUDE_PLUGIN_ROOT}/skills/add-server-logic/references/frontend-integration-reference.md`

Based on the Explore agent's findings from Phase 1.4 and the approved plan, choose the integration approach from that reference and apply it consistently across all server logic endpoints being wired into the frontend.

### 9.3 Create or Update Frontend Integration

Following the reference:

- Reuse the existing service layer or API utility when the site already has one
- Create a lightweight CSRF-aware helper only when the site has no established API client pattern
- Group multiple server logic endpoints into a coherent service module when that improves maintainability
- Add framework-specific hooks/composables/services only when the codebase already follows that pattern
- Fully integrate the server logic into the actual UI flow — do **not** stop at creating service/helper code
- Update the relevant pages, components, forms, buttons, or user journeys so the new backend behavior is reachable from the interface
- Replace placeholder data, mock handlers, or temporary actions when they are meant to be backed by the new server logic endpoints
- Add or preserve loading, success, empty, and error states so the UI behaves like a finished feature
- **For validate-and-execute endpoints**: The frontend must call the server logic endpoint for the protected operation (e.g., status transition) — it must NOT make a separate Web API PATCH for the same field. Ensure the UI for that operation (e.g., a "Submit" or "Approve" button) calls the server logic service function, not the Web API service

### 9.4 Git Commit

If frontend integration code was created:

Do a git commit for the frontend integration changes.

**Output**: Frontend service/hook created as needed, UI components/pages fully integrated, and changes committed

---

## Phase 10: Verify & Test Guidance

**Goal**: Validate the code and provide the user with everything needed to test the server logic

**Actions**:

### 10.1 Final Code Validation

Re-read each created `.js` file and verify:

- [ ] Only allowed top-level functions (get, post, put, patch, del)
- [ ] Every function returns a string
- [ ] try/catch in every function
- [ ] Server.Logger calls in every function
- [ ] No `import`, `require`, or external dependencies
- [ ] No browser APIs (`fetch`, `XMLHttpRequest`, `setTimeout`, `console.log`, `document`, `window`)
- [ ] Async only on functions that use await
- [ ] Correct SDK method usage (verified against Phase 3 documentation)
- [ ] HttpClient used only for external APIs (not Dataverse)
- [ ] Dataverse connector used for Dataverse operations

Re-read each `.serverlogic.yml` file and verify:

- [ ] `id` field exists and is a valid UUID
- [ ] `adx_serverlogic_adx_webrole` array is non-empty (at least one web role)
- [ ] `name` matches the folder name and `.js` file name
- [ ] `display_name` and `description` are populated
- [ ] Fields are alphabetically sorted
- [ ] File names match: folder name, `.js` name, `.serverlogic.yml` name, and `name` field all use the same value

### 10.2 Provide API URL

Tell the user each endpoint URL:

```
https://<site-url>/_api/serverlogics/<server-logic-name>
```

### 10.3 Test Guidance

Provide testing instructions:

1. **Deploy the site first** — The server logic must be deployed via `/deploy-site` before it can be called
2. **CSRF token required for non-GET requests** — POST, PUT, PATCH, and DELETE calls to server logic endpoints require a CSRF token. Fetch the token from `/_layout/tokenhtml` and include it as `__RequestVerificationToken` header. GET requests are **exempt** from antiforgery validation — no token is needed for read-only calls.
3. **Authentication** — Server logic respects the site's authentication. Calls from authenticated sessions use cookie-based auth automatically. Anonymous access depends on governance settings.
4. **Testing from browser console**:

Use the frontend integration reference from Phase 9 for the exact calling pattern that matches the site's stack.

5. **Check diagnostics** — Server.Logger output can be viewed in Power Pages design studio diagnostics

**Output**: Code validated, API URL provided, test guidance given

---

## Phase 11: Review & Deploy

**Goal**: Present a summary of all work performed and offer deployment

**Actions**:

### 11.1 Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "AddServerLogic"`.

### 11.2 Present Summary

Present a summary of everything that was done:

| Step | Status | Details |
|------|--------|---------|
| Server Logic JS | Created | List each created `.powerpages-site/server-logic/<name>/<name>.js` file |
| Server Logic YAML | Created | List each created `.powerpages-site/server-logic/<name>/<name>.serverlogic.yml` file |
| HTML Plan | Created/Updated | Actual path from render script output |
| Functions | Implemented | Summarize methods implemented per server logic item |
| SDK Features Used | — | Summarize features used per server logic item |
| Table Permissions | Created/Skipped | `accounts` (Read), `contacts` (Read, Create), etc. |
| Secrets & Env Vars | Created/Skipped | Environment variables (Key Vault-backed or direct), site settings with `envvar_schema` |
| Site Settings | Created/Skipped | ServerLogic/AllowedDomains, etc. |
| Client-Side Service | Created/Skipped | List created or updated frontend service files |
| UI Integration | Created/Skipped | Pages, components, forms, or actions fully wired to the server logic endpoints |
| API URL | — | List each `/_api/serverlogics/<name>` URL |

### 11.3 Ask to Deploy

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| The server logic work is ready. To make it live, the site needs to be deployed. Would you like to deploy now? | Yes, deploy now (Recommended), No, I'll deploy later |

**If "Yes, deploy now"**: Invoke the `/deploy-site` skill to deploy the site.

After deployment succeeds, use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| The site has been deployed. Would you like me to run `/test-site` to validate it now? | Yes, run `/test-site` (Recommended), No, skip testing |

**If "Yes, run `/test-site`"**: Invoke the `/test-site` skill.

**If "No, I'll deploy later"**: Acknowledge and remind:

> "No problem! Remember to deploy your site using `/deploy-site` when you're ready. The server logic endpoints won't be accessible until the site is deployed."

### 11.4 Post-Deploy Notes

After deployment (or if skipped), remind the user:

- **Test the endpoints**: Call each `/_api/serverlogics/<name>` URL with the appropriate HTTP method (include CSRF token for non-GET requests)
- **Recommended full-site validation**: After deployment, ask whether to run `/test-site` so the live site can be validated end to end
- **Check logs**: Use Server.Logger output in Power Pages design studio diagnostics to debug issues
- **Table permissions**: Table permissions were configured for Dataverse tables used by this server logic. If you add new Dataverse tables later, run the table permissions setup again — without permissions, `Server.Connector.Dataverse` silently returns 0 records
- **Timeout**: Default execution timeout is 120 seconds — this is also the platform maximum (values above 120 are silently clamped)
- **Anonymous access**: If the site's governance control disables anonymous access, anonymous users cannot invoke server logic that integrates with external systems
- **Preview feature**: Server Logic is currently in preview — monitor Microsoft Learn for updates
- **Environment variables with placeholder values**: If Phase 7 created environment variables with placeholder values, remind the user to update them with the actual secret values before testing. They can do this via:
  1. **Power Platform admin center** — **Environments** → select environment → **Environment variables** → find by display name → update value
  2. **Power Apps maker portal** — **Solutions** → open solution → **Environment variables** → edit value

**Output**: Summary presented, deployment completed or deferred, post-deploy guidance provided

---

## Important Notes

### Throughout All Phases

- **Use TaskCreate/TaskUpdate** to track progress at every phase
- **Always fetch Microsoft Learn docs** in Phase 3 before writing code — the docs are the source of truth
- **Ask for user confirmation** at key decision points
- **Commit at milestones** — after server logic code, table permissions (if any), secrets/environment variables (if any), site settings, and frontend integration (if any)
- **Validate thoroughly** — server logic has strict constraints and violations cause runtime errors

### Key Decision Points (Wait for User)

1. At Phase 1.5: Deploy now or cancel (if `.powerpages-site` missing — mandatory)
2. At Phase 2.1.2: Use existing Dataverse custom actions or build from scratch (if custom actions found)
3. At Phase 2: Confirm requirements (purpose, name, HTTP methods, secrets)
4. At Phase 4: Approve implementation plan before writing code
5. At Phase 6.2: Review and approve the `table-permissions-architect` plan (if Dataverse connector is used)
6. At Phase 2.3.1: Choose Azure Key Vault or direct environment variable (if secrets needed)
7. At Phase 7.2a Step 2: Create a new Key Vault or fall back to direct environment variable (if no vaults found)
8. At Phase 9.1: Create frontend integration or skip
9. At Phase 11.3: Deploy now or deploy later

### SDK Pattern Source of Truth

Do not treat this skill file as the canonical SDK reference. The Phase 3 Microsoft Learn fetch is the source of truth for SDK usage patterns, supported methods, signatures, and connector behavior. Keep only task-specific decisions in the plan and implementation notes.

### Progress Tracking

Before starting Phase 1, create a task list with all phases using `TaskCreate`:

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Verify site exists | Verifying site prerequisites | Locate project root, detect framework, explore existing server logics and frontend patterns, verify .powerpages-site exists (mandatory) |
| Understand requirements | Gathering requirements | Determine user intent, whether one or more server logic files are needed, the methods/features for each item, discover Dataverse custom actions, and any secrets required |
| Fetch latest documentation | Fetching Microsoft Learn docs | Query Microsoft Learn for current Server Logic SDK reference and samples |
| Review implementation plan | Reviewing plan with user | Present plan (server logic inventory, functions, SDK features, external APIs, secrets) and confirm before writing code |
| Implement server logic | Writing server logic code | Determine/create required web roles, create approved `.js` and `.serverlogic.yml` files, validate code |
| Configure table permissions | Setting up Dataverse table permissions | (Conditional) Parse `.js` files for Dataverse tables, launch `table-permissions-architect`, create permission YAML files |
| Manage secrets and environment variables | Configuring secrets and env vars | (Conditional) Recommend Azure Key Vault, list vaults, store secrets, create environment variables in Dataverse, create site settings with envvar_schema |
| Configure site settings | Configuring site settings | Set up ServerLogic/* site settings if needed |
| Client-side integration | Wiring frontend to server logic | Follow the frontend integration reference, create/update service files as needed, and fully wire the UI to the server logic endpoints |
| Verify and test guidance | Validating and providing test guidance | Final validation, API URLs, CSRF token instructions, testing guide |
| Review and deploy | Reviewing summary and deploying | Present summary, ask about deployment, provide post-deploy guidance |

Mark each task `in_progress` when starting it and `completed` when done via `TaskUpdate`. Use `TaskList` between phase transitions and before the final summary to confirm there are no incomplete work items left.

---

**Begin with Phase 1: Verify Site Exists**
