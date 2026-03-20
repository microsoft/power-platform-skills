---
name: integrate-serverlogic
description: >
  This skill should be used when the user asks to "create server logic", "add server-side code",
  "write server logic", "add server endpoint", "create API endpoint", "add backend logic",
  "write server-side JavaScript", "integrate server logic", "add server logic function",
  "add server-side processing", "create serverlogic", "add serverlogics", or wants to create,
  edit, or manage Power Pages Server Logic files — server-side JavaScript that runs securely
  on the Power Pages runtime. This skill orchestrates the full lifecycle: understanding
  requirements, fetching latest documentation, implementing the server logic code, configuring
  site settings, and deploying. Use this skill whenever the user mentions "server logic",
  "server-side code", or wants to move logic from the browser to the server in their Power Pages site.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Task, TaskCreate, TaskUpdate, TaskList, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_search, mcp__plugin_power-pages_microsoft-learn__microsoft_code_sample_search, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_fetch
model: opus
hooks:
  Stop:
    - hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/integrate-serverlogic/scripts/validate-serverlogic.js"'
          timeout: 15
        - type: prompt
          prompt: >
            If Server Logic work was being performed in this session (via /power-pages:integrate-serverlogic),
            verify before allowing stop: 1) The site was verified to exist with powerpages.config.json,
            2) Microsoft Learn documentation was fetched as source of truth before writing code,
            3) The server logic .js file was created in .powerpages-site/server-logic/<name>/ with only allowed
            top-level functions (get, post, put, patch, del), and a .serverlogic.yml metadata file was created
            with a valid id (UUID) and non-empty adx_serverlogic_adx_webrole array, 4) Every function returns a string
            (JSON.stringify for objects), 5) No external dependencies or browser APIs were used,
            6) Proper error handling (try/catch) exists in every function, 7) Server.Logger calls
            were added for diagnostics, 8) Site settings were configured if needed,
            9) The user was given the API URL and test guidance, 10) Client-side integration
            guidance was provided (how to call the server logic from frontend code).
            If any of these are incomplete, return { "ok": false, "reason": "<specific issues>" }.
            If no Server Logic work happened or everything is complete, return { "ok": true }.
          timeout: 30
---

# Integrate Server Logic

Create and manage Power Pages Server Logic — server-side JavaScript that runs securely on the Power Pages runtime, hidden from the browser and protected by web roles and table permissions. Server Logic enables secure external API integrations, Dataverse operations, and custom business logic without exposing sensitive code or credentials to the client.

## Core Principles

- **Microsoft Learn is the source of truth**: Always fetch the latest documentation before writing code. The Server Logic feature is in preview and the SDK may change — never rely on cached knowledge alone.
- **No browser APIs, no dependencies**: Server Logic runs in a sandboxed server environment with ECMAScript 2023 support. There is no `fetch`, `XMLHttpRequest`, `setTimeout`, or any DOM API. No npm packages are available.
- **Five functions only**: A server logic file can only export these top-level functions: `get`, `post`, `put`, `patch`, `del`. The name `delete` is a reserved word in JavaScript and cannot be used.
- **Always return a string**: Every function must return a string. Use `JSON.stringify()` when returning objects or arrays.
- **Use TaskCreate/TaskUpdate**: Track all progress throughout all phases — create the todo list upfront with all phases before starting any work.

> **Prerequisites:**
> - An existing Power Pages code site created via `/power-pages:create-site`
> - The site **must** be deployed at least once (`.powerpages-site` folder must exist) — server logic files live inside `.powerpages-site/server-logic/`, so deployment is required before any server logic can be created

**Initial request:** $ARGUMENTS

---

## Workflow

1. **Verify Site Exists** — Locate the Power Pages project, explore existing patterns, and verify prerequisites
2. **Understand Requirements** — Determine what the server logic should do and which HTTP methods are needed
3. **Fetch Latest Documentation** — Query Microsoft Learn for the most current Server Logic SDK reference
4. **Review Implementation Plan** — Present the plan to the user and confirm before writing code
5. **Implement Server Logic** — Create the .js and .serverlogic.yml files in `.powerpages-site/server-logic/<name>/`
6. **Configure Site Settings** — Set up ServerLogic site settings if needed
7. **Client-Side Integration** — Help wire the server logic into the site's frontend code
8. **Verify & Test Guidance** — Validate the code and provide testing instructions
9. **Review & Deploy** — Present summary and offer deployment

---

## Phase 1: Verify Site Exists

**Goal**: Locate the Power Pages project root and confirm prerequisites

**Actions**:

### 1.1 Locate Project

Look for `powerpages.config.json` in the current directory or immediate subdirectories:

```powershell
Get-ChildItem -Path . -Filter "powerpages.config.json" -Recurse -Depth 1
```

**If not found**: Tell the user to create a site first with `/power-pages:create-site`.

### 1.2 Read Existing Config

Read `powerpages.config.json` to get the site name and configuration:

```powershell
Get-Content "<PROJECT_ROOT>/powerpages.config.json" | ConvertFrom-Json
```

### 1.3 Detect Framework

Read `package.json` to determine the frontend framework (React, Vue, Angular, or Astro). This is needed for Phase 7 (client-side integration guidance). See `${CLAUDE_PLUGIN_ROOT}/references/framework-conventions.md` for the full framework detection mapping.

### 1.4 Explore Existing Server Logics and Frontend Code

Use the **Explore agent** (via `Task` tool with `agent_type: "explore"`) to analyze the site for existing server logic patterns and frontend code that may call or need to call server logic endpoints.

**Prompt for the Explore agent:**

> "Analyze this Power Pages code site for server logic context. Check:
> 1. Does `.powerpages-site/server-logic/` exist? If yes, list all subdirectories and their .js files. Summarize what each server logic does (which functions it implements, what SDK features it uses). Also read the corresponding .serverlogic.yml files to check web role assignments.
> 2. Search the frontend source code (`src/**/*.{ts,tsx,js,jsx,vue,astro}`) for any existing calls to `/_api/serverlogics/` — these indicate server logic endpoints already being consumed.
> 3. Look for `shell.safeAjax` calls or CSRF token handling patterns (`__RequestVerificationToken`, `_layout/tokenhtml`) — these show how the site currently makes authenticated API calls.
> 4. Check for any TODO/FIXME comments mentioning server logic, backend, or server-side processing.
> 5. Look for hardcoded API URLs, mock data, or placeholder fetch calls that might need to be replaced with server logic calls.
> 6. Check for any existing service layer or API utility files in `src/shared/`, `src/services/`, or similar directories that could be reused for server logic integration.
> 7. Read `.powerpages-site/web-roles/*.webrole.yml` files to list available web roles and their GUIDs — these are needed when creating the server logic metadata YAML.
> Report all findings so we can avoid duplicating work and match existing patterns."

From the Explore agent's findings, note:
- **Existing server logic files** — what's already implemented (avoid conflicts)
- **Frontend calling patterns** — how the site makes API calls (match this pattern in Phase 7)
- **Existing service/utility files** — reuse these when adding client-side integration
- **Gaps** — frontend code that references server logic endpoints that don't exist yet

### 1.5 Check Deployment Status (Mandatory)

Look for the `.powerpages-site` folder:

```
Glob: **/.powerpages-site
```

**If not found**: The site **must** be deployed before server logic can be created — server logic files live inside `.powerpages-site/server-logic/`. Tell the user:

> "The `.powerpages-site` folder was not found. Server logic files are stored inside this folder, so the site must be deployed at least once before creating server logic. Would you like to deploy now?"

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| The `.powerpages-site` folder is required for server logic. Would you like to deploy the site now? | Yes, deploy now (Required), Cancel |

**If "Yes, deploy now"**: Invoke `/power-pages:deploy-site` first, then continue to Phase 2.

**If "Cancel"**: Stop the workflow — server logic cannot be created without `.powerpages-site`.

**Output**: Confirmed project root, `.powerpages-site` exists, existing server logics (if any), available web roles

---

## Phase 2: Understand Requirements

**Goal**: Determine what the server logic should do and which HTTP methods are needed

**Actions**:

### 2.1 Analyze User Request

From the user's request, determine:

- **Purpose**: What should the server logic do? (e.g., "proxy an external exchange rate API", "CRUD operations on a Dataverse table", "aggregate data from multiple sources", "validate and process form submissions")
- **Server logic name**: A descriptive, URL-friendly name for the endpoint (e.g., `exchangerate`, `order-processor`, `data-aggregator`)
- **HTTP methods needed**: Which of the 5 functions should be implemented (get, post, put, patch, del)

### 2.2 Identify SDK Features Needed

Based on the purpose, identify which Server SDK features are required:

| Feature | When to use |
|---------|-------------|
| `Server.Connector.HttpClient` | Calling external REST APIs (NOT Dataverse) |
| `Server.Connector.Dataverse` | Reading/writing Dataverse records |
| `Server.Context` | Accessing request parameters, headers, body |
| `Server.User` | User-scoped operations, role checks |
| `Server.Logger` | Always — every function should log entry/exit and errors |
| `Server.Sitesetting` | Reading configuration values |
| `Server.Website` | Accessing site metadata |

### 2.3 Confirm with User

If the requirements are ambiguous, use `AskUserQuestion` to clarify:

| Question | Context |
|----------|---------|
| What should this server logic endpoint do? | If the purpose is unclear |
| Which HTTP methods do you need? | If not specified — suggest based on the use case (e.g., read-only = GET, form processing = POST) |
| Does this need to call external APIs, Dataverse, or both? | Determines which connectors to use |
| What's the server logic name? | Suggest a URL-friendly name based on the purpose |

**Output**: Clear understanding of purpose, name, HTTP methods, and SDK features needed

---

## Phase 3: Fetch Latest Documentation

**Goal**: Discover and read all current Server Logic documentation from Microsoft Learn before writing any code

This step is critical because Server Logic is a preview feature and the SDK surface may change. The documentation on Microsoft Learn is the authoritative source — not cached instructions or training data. New documentation pages may be added at any time, so **never rely on a hardcoded list of URLs**. Instead, search first to discover all available pages, then fetch the relevant ones.

**Actions**:

### 3.1 Discover All Server Logic Documentation

Search Microsoft Learn to find every available documentation page:

```
mcp__plugin_power-pages_microsoft-learn__microsoft_docs_search("Power Pages Server Logic")
```

From the results, collect all unique page URLs that are actual documentation (under `learn.microsoft.com/.../power-pages/configure/...`). Exclude release-plan announcements, blog posts, and unrelated pages.

### 3.2 Fetch Core Reference Pages

From the discovered URLs, identify and fetch the **core reference pages** — these are always required regardless of the user's use case:

- The **overview** page (typically `server-logic-overview`) — feature capabilities, site settings, security model, API URL format
- The **authoring** page (typically `author-server-logic`) — creating server logic, client-side calling patterns, CSRF token, response format
- The **server objects / SDK reference** page (typically `server-objects`) — full SDK: Server.Logger, Server.Context, Server.Connector, Server.User, Server.Website, Server.Sitesetting

Fetch these in parallel. Extract and note:
- All SDK method signatures, parameter types, and return types
- Current supported HTTP methods and function signatures
- Site settings and their defaults
- Security model (web roles, table permissions, CSRF)
- Client-side calling patterns and response format
- Any new methods or breaking changes vs. the known SDK reference below

### 3.3 Fetch Use-Case-Specific Pages

From the discovered URLs, identify and fetch pages relevant to the user's specific use case (determined in Phase 2):

| User needs | Look for pages about |
|-----------|---------------------|
| Dataverse CRUD | Dataverse operations, table interactions |
| External API calls | External services, HttpClient |
| Azure Functions | Azure Function HTTP trigger |
| Microsoft Graph / SharePoint | Graph API, SharePoint integration |
| Any other scenario | Fetch any tutorial/how-to page that matches |

If the search results contain pages you haven't seen before or that don't match the patterns above, read them anyway — they may document new capabilities.

### 3.4 Search for Code Samples

```
mcp__plugin_power-pages_microsoft-learn__microsoft_code_sample_search("Power Pages server logic")
```

### 3.5 Reconcile with Known SDK

Compare what Microsoft Learn documents with the SDK reference below. If there are discrepancies, **Microsoft Learn wins** — update your understanding accordingly and note any changes. If Microsoft Learn documents new SDK methods, properties, or patterns not listed here, use those new capabilities when appropriate.

#### Known SDK Reference (verify against docs)

- **Server.Logger**: `Log(message)`, `Warn(message)`, `Error(message)`
- **Server.Context**: `QueryParameters["key"]`, `Headers["key"]`, `Body`, `HttpMethod`, `Url`, `ActivityId`, `FunctionName`, `ServerLogicName`
- **Server.Connector.HttpClient**: `GetAsync(url, headers?)`, `PostAsync(url, jsonBody, headers?, contentType?)`, `PatchAsync(url, jsonBody, headers?, contentType?)`, `PutAsync(url, jsonBody, headers?, contentType?)`, `DeleteAsync(url, headers?)`
- **Server.Connector.Dataverse**: `CreateRecord(entitySetName, payload)`, `RetrieveRecord(entitySetName, id, options)`, `RetrieveMultipleRecords(entitySetName, options)`, `UpdateRecord(entitySetName, id, payload)`, `DeleteRecord(entitySetName, id)`, `InvokeCustomApi(httpMethod, url, payload)`
- **Server.User**: `fullname`, `firstname`, `lastname`, `emailaddress1`, `contactid`, `Roles`, `Token`, and many other contact properties
- **Server.Website**: `adx_websiteid`, `adx_name`, `adx_primarydomainname`, `adx_defaultlanguage`, etc.
- **Server.Sitesetting**: `Get(name)`

**Output**: Up-to-date SDK reference verified against all relevant Microsoft Learn documentation pages

---

## Phase 4: Review Implementation Plan

**Goal**: Present the implementation plan to the user and confirm before writing any code

**Actions**:

### 4.1 Present Plan

Show the user a clear summary of what will be built:

| Item | Value |
|------|-------|
| **Server logic name** | `<name>` |
| **JS file** | `.powerpages-site/server-logic/<name>/<name>.js` |
| **YAML metadata** | `.powerpages-site/server-logic/<name>/<name>.serverlogic.yml` |
| **API URL** | `https://<site-url>/_api/serverlogics/<name>` |
| **Functions to implement** | get, post, put, patch, del (whichever are needed) |
| **Web roles assigned** | List web roles (from `.powerpages-site/web-roles/`) |
| **SDK features used** | HttpClient / Dataverse / Context / User / Sitesetting / etc. |
| **External APIs called** | List any external URLs or services (if applicable) |
| **Dataverse tables accessed** | List any tables (if applicable) |
| **Site settings needed** | ServerLogic/AllowedDomains, etc. (if applicable) |

For each function, briefly describe what it will do:

| Function | Purpose |
|----------|---------|
| `get` | e.g., "Retrieve exchange rates from external API" |
| `post` | e.g., "Create a new order record in Dataverse" |

If the documentation fetched in Phase 3 revealed new SDK methods or patterns relevant to this task, highlight them here.

### 4.2 Confirm with User

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| Here's the implementation plan for server logic **<name>**. Does this look correct? | Approve and implement (Recommended), Request changes, Cancel |

**If "Request changes"**: Ask what needs to change, update the plan, and present again.

**If "Cancel"**: Stop the workflow.

**Output**: User-approved implementation plan

---

## Phase 5: Implement Server Logic

**Goal**: Create the server logic .js file following all constraints verified in Phase 3

**Actions**:

### 5.1 Create Server Logic Folder

Create the server logic folder inside `.powerpages-site/server-logic/` (note: singular `server-logic`, no trailing 's'):

```powershell
New-Item -ItemType Directory -Path "<PROJECT_ROOT>/.powerpages-site/server-logic/<name>" -Force
```

### 5.2 Read Web Roles

Read all web role YAML files to get the available web role GUIDs. These are needed for the metadata YAML in step 5.4.

```
Glob: <PROJECT_ROOT>/.powerpages-site/web-roles/*.webrole.yml
```

For each file, read the `id` field. By default, assign **all available web roles** (typically Administrators, Anonymous Users, Authenticated Users) to the server logic. The user can narrow this down if needed.

Example web role file content:
```yaml
adx_anonymoususersrole: false
adx_authenticatedusersrole: true
description: Role for authenticated users
id: a1b2c3d4-e5f6-7890-abcd-ef1234567890
name: Authenticated Users
```

Collect all `id` values into an array for the YAML.

### 5.3 Create the Server Logic File

Create `<PROJECT_ROOT>/.powerpages-site/server-logic/<name>/<name>.js` with these mandatory patterns:

#### Structure Rules

1. **Only top-level functions**: The file can only contain these 5 functions at the top level: `get`, `post`, `put`, `patch`, `del`. Only include the functions the user needs.
2. **Each function returns a string**: Use `JSON.stringify()` for objects/arrays.
3. **Each function has try/catch**: Every function must wrap its logic in a try/catch block.
4. **Each function logs**: Use `Server.Logger.Log()` at entry and `Server.Logger.Error()` in catch blocks.
5. **No imports or requires**: No `import`, `require`, or external dependencies.
6. **No browser APIs**: No `fetch`, `XMLHttpRequest`, `setTimeout`, `setInterval`, `console.log`, or DOM APIs.
7. **Async when needed**: Mark functions as `async` only when they use `await` (HttpClient or Dataverse calls).

#### Code Template

```javascript
// Server Logic: <name>
// Purpose: <description>
// API URL: https://<site-url>/_api/serverlogics/<name>

async function get() {
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

#### SDK Usage Patterns

Apply the correct SDK patterns based on what the server logic needs:

#### External API Calls (Server.Connector.HttpClient)

HttpClient is for external APIs only — it blocks access to Dataverse URLs. All methods are async and return an `HttpResponse` with a `Body` property.

```javascript
async function get() {
    try {
        Server.Logger.Log("Fetching external data");
        const response = await Server.Connector.HttpClient.GetAsync(
            "https://api.example.com/data",
            { "Content-Type": "application/json" }
        );
        return response.Body;
    } catch (err) {
        Server.Logger.Error("External API call failed: " + err.message);
        return JSON.stringify({ status: "error", message: err.message });
    }
}
```

#### Dataverse Operations (Server.Connector.Dataverse)

Use Dataverse connector for CRUD operations on Dataverse tables. These methods are synchronous (no `await` needed except for `InvokeCustomApi`).

```javascript
function get() {
    try {
        Server.Logger.Log("Retrieving records");
        const id = Server.Context.QueryParameters["id"];

        if (id) {
            const record = Server.Connector.Dataverse.RetrieveRecord(
                "accounts", id, "?$select=name,telephone1"
            );
            return JSON.stringify({ status: "success", data: record });
        }

        const records = Server.Connector.Dataverse.RetrieveMultipleRecords(
            "accounts", "?$select=name,telephone1&$top=50"
        );
        return JSON.stringify({ status: "success", data: records });
    } catch (err) {
        Server.Logger.Error("Dataverse retrieval failed: " + err.message);
        return JSON.stringify({ status: "error", message: err.message });
    }
}
```

#### Request Context (Server.Context)

```javascript
function post() {
    try {
        Server.Logger.Log("Processing POST request");

        const body = Server.Context.Body;           // Request body as string
        const method = Server.Context.HttpMethod;    // "POST"
        const authHeader = Server.Context.Headers["Authorization"];
        const param = Server.Context.QueryParameters["filter"];

        // Parse JSON body
        const data = JSON.parse(body);

        // Process data...

        return JSON.stringify({ status: "success", received: data });
    } catch (err) {
        Server.Logger.Error("POST processing failed: " + err.message);
        return JSON.stringify({ status: "error", message: err.message });
    }
}
```

#### User Info and Role Checks (Server.User)

```javascript
function get() {
    try {
        const userRoles = Server.User.Roles;
        const userName = Server.User.fullname;
        Server.Logger.Log("Request from user: " + userName);

        // Check if user has required role
        if (!userRoles || !userRoles.includes("Administrator")) {
            return JSON.stringify({
                status: "error",
                message: "Insufficient permissions"
            });
        }

        // Proceed with authorized logic...

        return JSON.stringify({ status: "success", user: userName });
    } catch (err) {
        Server.Logger.Error("Authorization check failed: " + err.message);
        return JSON.stringify({ status: "error", message: err.message });
    }
}
```

### 5.4 Create the Metadata YAML

Create `<PROJECT_ROOT>/.powerpages-site/server-logic/<name>/<name>.serverlogic.yml` with the following structure. **Fields must be alphabetically sorted** to match PAC CLI conventions:

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

- **`id` field is mandatory** — Generate a new UUID (v4). PAC CLI crashes with `Expected Guid for primary key 'id'` if this is missing.
- **`adx_serverlogic_adx_webrole`** — Array of web role GUIDs from step 5.2. By default, include all available web roles. The user can customize this.
- **`name`** — Must match the folder name and `.js` file name (the URL-friendly name used in `/_api/serverlogics/<name>`).
- **`display_name`** — Human-readable name (e.g., "Exchange Rate API", "Order Processor").
- **Alphabetical field ordering** — Fields must be sorted alphabetically: `adx_serverlogic_adx_webrole`, `description`, `display_name`, `id`, `name`.

To generate a UUID, use:

```powershell
node -e "const crypto = require('crypto'); console.log(crypto.randomUUID())"
```

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

After creating both files:

```powershell
git add .powerpages-site/server-logic/<name>/
git commit -m "Add server logic: <name>"
```

**Output**: Server logic `.js` and `.serverlogic.yml` files created, validated, and committed

---

## Phase 6: Configure Site Settings

**Goal**: Set up site settings for the server logic feature

**Actions**:

### 6.1 Configure Server Logic Site Settings

The `.powerpages-site` folder is guaranteed to exist at this point (verified in Phase 1.5).

The following site settings control server logic behavior. Only create settings that differ from defaults or are specifically needed:

| Setting | Description | Default | When to configure |
|---------|-------------|---------|-------------------|
| `ServerLogic/Enabled` | Enable/disable server logic feature | `true` | Only if explicitly disabled and needs re-enabling |
| `ServerLogic/AllowedDomains` | Restrict which external domains HttpClient can call | All domains | When the server logic calls external APIs and you want to restrict to specific domains for security |
| `ServerLogic/TimeoutInSeconds` | Maximum execution time (up to 240s) | `120` | When operations need more than 2 minutes (e.g., complex aggregations, slow external APIs) |
| `ServerLogic/AllowNetworkingToAllDomains` | Allow networking across domains | `true` | Set to `false` when restricting via AllowedDomains |

Use the existing site setting creation script:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" --projectRoot "<PROJECT_ROOT>" --name "ServerLogic/AllowedDomains" --value "api.example.com,api.other.com" --description "Restrict server logic external API calls to these domains"
```

### 6.2 Git Commit

If any settings were created:

```powershell
git add -A
git commit -m "Add server logic site settings for <name>"
```

**Output**: Site settings configured and committed (or skipped if not needed/deployed)

---

## Phase 7: Client-Side Integration

**Goal**: Help the user call the server logic endpoint from their site's frontend code, matching existing patterns discovered in Phase 1

Server logic creates the backend — but without frontend code to call it, the endpoint is unused. This phase creates or updates frontend code to consume the server logic API, using the patterns and conventions already established in the codebase.

**Actions**:

### 7.1 Determine Integration Approach

Based on the Explore agent's findings from Phase 1.4:

**If the site already has a service layer or API utility** (e.g., `powerPagesApi.ts`, a shared fetch wrapper, or `shell.safeAjax` usage):
- Create a thin service function that calls the server logic endpoint using the existing utility
- Follow the same naming conventions and file locations

**If the site has no existing API patterns**:
- Create a lightweight helper function for calling the server logic with CSRF token handling
- Place it in `src/shared/` or `src/services/` following framework conventions

### 7.2 Create Server Logic Client Service

Create a frontend service file for the server logic endpoint. The exact implementation depends on the framework and existing patterns, but the core pattern is:

**For sites using `shell.safeAjax` (jQuery-based Power Pages sites):**

```javascript
// Call server logic with CSRF token handled automatically
function callServerLogic(method, queryParams, body) {
    return new Promise((resolve, reject) => {
        let url = '/_api/serverlogics/<name>';
        if (queryParams) {
            url += '?' + new URLSearchParams(queryParams).toString();
        }
        shell.safeAjax({
            type: method,
            url: url,
            contentType: 'application/json',
            data: body ? JSON.stringify(body) : undefined,
            success: function(res) { resolve(res); },
            error: function(xhr) { reject(xhr); }
        });
    });
}
```

**For SPA code sites (React/Vue/Angular/Astro) with `powerPagesApi.ts`:**

```typescript
import { powerPagesFetch } from '../shared/powerPagesApi';

const SERVER_LOGIC_BASE = '/_api/serverlogics/<name>';

export async function callServerLogic<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    params?: Record<string, string>,
    body?: unknown
): Promise<T> {
    const url = params
        ? `${SERVER_LOGIC_BASE}?${new URLSearchParams(params)}`
        : SERVER_LOGIC_BASE;
    return powerPagesFetch<T>(url, {
        method,
        body: body ? JSON.stringify(body) : undefined,
    });
}
```

**For SPA code sites without an existing API client:**

```typescript
async function getCSRFToken(): Promise<string> {
    const response = await fetch('/_layout/tokenhtml');
    const html = await response.text();
    const match = html.match(/value="([^"]+)"/);
    if (!match) throw new Error('Failed to get CSRF token');
    return match[1];
}

export async function callServerLogic<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    params?: Record<string, string>,
    body?: unknown
): Promise<T> {
    const token = await getCSRFToken();
    let url = '/_api/serverlogics/<name>';
    if (params) url += '?' + new URLSearchParams(params).toString();

    const response = await fetch(url, {
        method,
        headers: {
            'Content-Type': 'application/json',
            '__RequestVerificationToken': token,
        },
        body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
        throw new Error(`Server logic call failed: ${response.status}`);
    }

    return response.json();
}
```

### 7.3 Create Framework-Specific Hook (Optional)

If the site uses React, Vue, or Angular, create a hook/composable/service that wraps the server logic call with loading/error state:

**React:**
```typescript
export function useServerLogic<T>(method: string, params?: Record<string, string>) {
    const [data, setData] = useState<T | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    // ... fetch on mount, expose refetch
}
```

Only create this if the pattern matches what the site already uses (e.g., the site has `useProducts` hooks from webapi integration).

### 7.4 Update Existing Components

If the Explore agent in Phase 1.4 found frontend components with TODO comments, placeholder fetch calls, or mock data that should be replaced with the server logic call:
- Update those components to import and use the new service function
- Replace hardcoded data or placeholder URLs with the real server logic call
- Add loading and error states if the component lacks them

### 7.5 Ask User About Integration Scope

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| I've created the server logic backend. Would you like me to also create the frontend code to call it? | Yes, create frontend integration (Recommended), No, I'll handle the frontend myself |

**If "No"**: Skip to Phase 8, but provide the API URL and a code snippet the user can copy.

### 7.6 Git Commit

If frontend integration code was created:

```powershell
git add -A
git commit -m "Add client-side integration for server logic: <name>"
```

**Output**: Frontend service/hook created, existing components updated (if applicable), committed

---

## Phase 8: Verify & Test Guidance

**Goal**: Validate the code and provide the user with everything needed to test the server logic

**Actions**:

### 8.1 Final Code Validation

Re-read the created `.js` file and verify:

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

Re-read the `.serverlogic.yml` file and verify:

- [ ] `id` field exists and is a valid UUID
- [ ] `adx_serverlogic_adx_webrole` array is non-empty (at least one web role)
- [ ] `name` matches the folder name and `.js` file name
- [ ] `display_name` and `description` are populated
- [ ] Fields are alphabetically sorted
- [ ] File names match: folder name, `.js` name, `.serverlogic.yml` name, and `name` field all use the same value

### 8.2 Provide API URL

Tell the user the endpoint URL:

```
https://<site-url>/_api/serverlogics/<server-logic-name>
```

### 8.3 Test Guidance

Provide testing instructions:

1. **Deploy the site first** — The server logic must be deployed via `/power-pages:deploy-site` before it can be called
2. **CSRF token required** — All API calls to server logic endpoints require a Cross-Site Request Forgery (CSRF) token in the request headers. Fetch the token from `/_layout/tokenhtml` and include it as `__RequestVerificationToken` header.
3. **Authentication** — Server logic respects the site's authentication. Calls from authenticated sessions use cookie-based auth automatically. Anonymous access depends on governance settings.
4. **Testing from browser console**:

```javascript
// Fetch CSRF token first
const tokenResponse = await fetch('/_layout/tokenhtml');
const tokenHtml = await tokenResponse.text();
const token = tokenHtml.match(/value="([^"]+)"/)?.[1];

// Call the server logic
const response = await fetch('/_api/serverlogics/<name>', {
    method: 'GET', // or POST, PUT, PATCH, DELETE
    headers: {
        'Content-Type': 'application/json',
        '__RequestVerificationToken': token
    }
});
const result = await response.json();
console.log(result);
```

5. **Check diagnostics** — Server.Logger output can be viewed in Power Pages design studio diagnostics

**Output**: Code validated, API URL provided, test guidance given

---

## Phase 9: Review & Deploy

**Goal**: Present a summary of all work performed and offer deployment

**Actions**:

### 9.1 Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "IntegrateServerlogic"`.

### 9.2 Present Summary

Present a summary of everything that was done:

| Step | Status | Details |
|------|--------|---------|
| Server Logic JS | Created | `.powerpages-site/server-logic/<name>/<name>.js` |
| Server Logic YAML | Created | `.powerpages-site/server-logic/<name>/<name>.serverlogic.yml` |
| Functions | Implemented | get, post, put, patch, del (as needed) |
| SDK Features Used | — | HttpClient / Dataverse / Context / User / etc. |
| Site Settings | Created/Skipped | ServerLogic/AllowedDomains, etc. |
| Client-Side Service | Created/Skipped | `src/shared/services/<name>Service.ts` (or equivalent) |
| Components Updated | X files / None | Frontend components wired to call server logic |
| API URL | — | `/_api/serverlogics/<name>` |

### 9.3 Ask to Deploy

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| The server logic is ready. To make it live, the site needs to be deployed. Would you like to deploy now? | Yes, deploy now (Recommended), No, I'll deploy later |

**If "Yes, deploy now"**: Invoke the `/power-pages:deploy-site` skill to deploy the site.

**If "No, I'll deploy later"**: Acknowledge and remind:

> "No problem! Remember to deploy your site using `/power-pages:deploy-site` when you're ready. The server logic endpoint won't be accessible until the site is deployed."

### 9.4 Post-Deploy Notes

After deployment (or if skipped), remind the user:

- **Test the endpoint**: Call `/_api/serverlogics/<name>` with the appropriate HTTP method and CSRF token
- **Check logs**: Use Server.Logger output in Power Pages design studio diagnostics to debug issues
- **Security**: Server logic is protected by web roles and table permissions — ensure users have appropriate roles
- **Timeout**: Default execution timeout is 120 seconds (configurable up to 240s via `ServerLogic/TimeoutInSeconds`)
- **Anonymous access**: If the site's governance control disables anonymous access, anonymous users cannot invoke server logic that integrates with external systems
- **Preview feature**: Server Logic is currently in preview — monitor Microsoft Learn for updates

**Output**: Summary presented, deployment completed or deferred, post-deploy guidance provided

---

## Important Notes

### Throughout All Phases

- **Use TaskCreate/TaskUpdate** to track progress at every phase
- **Always fetch Microsoft Learn docs** in Phase 3 before writing code — the docs are the source of truth
- **Ask for user confirmation** at key decision points
- **Commit at milestones** — after server logic code and after site settings
- **Validate thoroughly** — server logic has strict constraints and violations cause runtime errors

### Key Decision Points (Wait for User)

1. At Phase 1.5: Deploy now or cancel (if `.powerpages-site` missing — mandatory)
2. At Phase 2: Confirm requirements (purpose, name, HTTP methods)
3. At Phase 4: Approve implementation plan before writing code
4. At Phase 7.5: Create frontend integration or skip
5. At Phase 9.3: Deploy now or deploy later

### HttpClient vs Dataverse — Choosing the Right Connector

This is a common source of confusion. The two connectors serve different purposes and are mutually exclusive for Dataverse access:

- **Server.Connector.HttpClient**: For calling **external** REST APIs (non-Dataverse). It actively blocks requests to Dataverse URLs. Use this for third-party APIs, Azure Functions, or any service outside Dataverse.
- **Server.Connector.Dataverse**: For **Dataverse** operations only. Provides typed CRUD methods (CreateRecord, RetrieveRecord, etc.) that handle authentication automatically. Use this for reading/writing Power Platform data.

If the user needs both external API calls and Dataverse operations in the same server logic, use both connectors — HttpClient for external calls and Dataverse for Dataverse operations. They coexist in the same file.

### Progress Tracking

Before starting Phase 1, create a task list with all phases using `TaskCreate`:

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Verify site exists | Verifying site prerequisites | Locate project root, detect framework, explore existing server logics and frontend patterns, verify .powerpages-site exists (mandatory) |
| Understand requirements | Gathering requirements | Determine purpose, name, HTTP methods, and SDK features needed |
| Fetch latest documentation | Fetching Microsoft Learn docs | Query Microsoft Learn for current Server Logic SDK reference and samples |
| Review implementation plan | Reviewing plan with user | Present plan (name, functions, SDK features, external APIs) and confirm before writing code |
| Implement server logic | Writing server logic code | Read web roles, create .js and .serverlogic.yml in .powerpages-site/server-logic/<name>/, validate code |
| Configure site settings | Configuring site settings | Set up ServerLogic/* site settings if needed |
| Client-side integration | Wiring frontend to server logic | Create service function, framework hook, update existing components to call server logic endpoint |
| Verify and test guidance | Validating and providing test guidance | Final validation, API URL, CSRF token instructions, testing guide |
| Review and deploy | Reviewing summary and deploying | Present summary, ask about deployment, provide post-deploy guidance |

Mark each task `in_progress` when starting it and `completed` when done via `TaskUpdate`.

---

**Begin with Phase 1: Verify Site Exists**
