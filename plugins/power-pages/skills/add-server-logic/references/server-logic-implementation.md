# Server logic implementation

Read when implementing or updating approved server logic files.

## Create the endpoint folder

For each approved server logic item:

- **If the approved plan says `reuse`**: Do not create a new folder. Reuse the existing server logic as-is and only update the surrounding integration work if needed.
- **If the approved plan says `update` / extend**: Reuse the existing folder and update the existing `.js` / `.serverlogic.yml` files rather than creating duplicates.
- **If the approved plan says `create`**: Create the folder inside `.powerpages-site/server-logic/` (note: singular `server-logic`, no trailing 's'). Ensure the folder name matches that endpoint name exactly.

## Assign web roles

Use the web-role authoring workflow to determine which roles the approved endpoints need and create any missing roles before writing metadata.

Do **not** assume every server logic should get every available role. Instead, determine the minimum set of roles required for each server logic based on its purpose, security model, and the approved plan.

Example web role file content:
```yaml
adx_anonymoususersrole: false
adx_authenticatedusersrole: true
description: Role for authenticated users
id: a1b2c3d4-e5f6-7890-abcd-ef1234567890
name: Authenticated Users
```

Use that workflow when:

- The site has no suitable existing web roles
- The approved plan includes proposed roles that do not exist yet
- The role assignments need to be refined before metadata can be created

After the Create Web Role skill completes, read the resulting web role YAML files and collect the `id` and `name` values needed for each server logic's metadata YAML.

## Create the server logic file

Repeat this step for each approved server logic item. Create or update `<PROJECT_ROOT>/.powerpages-site/server-logic/<name>/<name>.js` according to the approved plan status (`create`, `update`, or `reuse`) and follow these mandatory patterns:

#### Structure Rules

1. **Only top-level functions**: The file can only contain these 5 functions at the top level: `get`, `post`, `put`, `patch`, `del`. Only include the functions the user needs.
2. **Each function returns a string**: Use `JSON.stringify()` for objects/arrays.
3. **Each function has try/catch**: Every function must wrap its logic in a try/catch block.
4. **Each function logs**: Use `Server.Logger.Log()` at entry and `Server.Logger.Error()` in catch blocks.
5. **No imports or requires**: No `import`, `require`, or external dependencies.
6. **No browser APIs**: No `fetch`, `XMLHttpRequest`, `setTimeout`, `setInterval`, `console.log`, or DOM APIs.
7. **Async when needed**: Mark functions as `async` only when they use `await` (HttpClient calls). Dataverse connector methods (`Server.Connector.Dataverse.*`) are **synchronous** - do NOT use `async`/`await` with them.
8. **Callbacks**: Use arrow functions or named helpers nested inside a handler.

#### Prohibited Script Patterns

The Power Pages server-side script validator rejects scripts containing certain patterns at runtime. Violations surface as `RTSL01: Script validation failed: prohibited pattern found - Pattern: <regex>` in diagnostics, and the function silently falls through without executing user code.

| Pattern | Regex | Caveat |
|---------|-------|--------|
| JavaScript `with` statement | `with\s*\(` (case-insensitive) | The regex matches the substring `with(` **anywhere** in the file - including inside string literals and inside other identifiers. OData filter functions like `startswith(`, `endswith(`, and `groupwith(` will trip it because they end with `with(`. |
| Anonymous functions and `Function` constructor | `Function\s*\(` (case-insensitive) | The runtime scans raw source, including comments, strings, and longer identifiers. Anonymous callbacks such as `.map(function (r) { ... })` are rejected. Use arrow callbacks or named nested helpers; top-level `function get()` remains valid. |

**Workaround for OData functions** - split the literal so `with(` is not contiguous in source:

```javascript
// ❌ Triggers validator: "startswith(" contains the substring "with("
var query = "$filter=startswith(name,'INV-')";

// ✅ Split the literal - server still receives "startswith(name,...)"
var query = "$filter=startswith" + "(name,'INV-')";
```

The same trick applies to `endswith(`, `groupwith(`, and any other identifier that ends with `with(`.

These restrictions apply to server logic `.js` files, not frontend JavaScript. The local validator mirrors these runtime checks in `${PLUGIN_ROOT}/skills/add-server-logic/scripts/validate-serverlogic.js`.

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

When a server logic item is identified as validate-and-execute (see Phase 2.1.1), use this pattern. The key difference: the server logic reads the current state, validates the business rule, AND writes the result to Dataverse - all in one call. The client never writes the protected field directly.

```javascript
// Server Logic: <name>
// Purpose: Validate and execute <describe the operation>
// Pattern: Validate-and-execute - this endpoint both validates the business rule
//          and performs the Dataverse write. The client should NOT write <protected fields>
//          via Web API - all writes to those fields go through this endpoint.
// API URL: https://<site-url>/_api/serverlogics/<name>

function post() {
    try {
        Server.Logger.Log("<name> POST called");

        const body = JSON.parse(Server.Context.Body);
        const entityId = body.entityId;
        const targetStatus = body.targetStatus;

        // 1. Read the current record from Dataverse
        const readResponse = JSON.parse(Server.Connector.Dataverse.RetrieveRecord("<table-name>", entityId, "$select=<status-field>"));
        if (readResponse.IsSuccessStatusCode === false || !(readResponse.StatusCode >= 200 && readResponse.StatusCode < 300)) {
            throw new Error("Dataverse read failed: " + readResponse.StatusCode);
        }
        const current = JSON.parse(readResponse.Body);
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

        // 3. Execute the write - server performs the Dataverse update
        const updateData = {};
        updateData["<status-field>"] = targetStatus;
        const writeResponse = JSON.parse(Server.Connector.Dataverse.UpdateRecord("<table-name>", entityId, JSON.stringify(updateData)));
        if (writeResponse.IsSuccessStatusCode === false || !(writeResponse.StatusCode >= 200 && writeResponse.StatusCode < 300)) {
            throw new Error("Dataverse update failed: " + writeResponse.StatusCode);
        }

        Server.Logger.Log("<name> transition executed: " + currentStatus + " → " + targetStatus);

        // 4. Return the result - client receives confirmation, not a validation flag
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
4. It returns a success/failure result - NOT a `{ valid: true/false }` flag for the client to act on
5. The client calls this one endpoint - it does NOT make a separate Web API PATCH call

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
        Server.Logger.Log("<name> POST called - invoking custom action <custom-action-name>");

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

        const response = JSON.parse(result);
        if (response.IsSuccessStatusCode === false || !(response.StatusCode >= 200 && response.StatusCode < 300)) {
            throw new Error("Dataverse custom action failed: " + response.StatusCode);
        }
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
        Server.Logger.Log("<name> POST called - invoking bound action <custom-action-name>");

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

        const response = JSON.parse(result);
        if (response.IsSuccessStatusCode === false || !(response.StatusCode >= 200 && response.StatusCode < 300)) {
            throw new Error("Dataverse bound action failed: " + response.StatusCode);
        }
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
        Server.Logger.Log("<name> GET called - invoking custom function <custom-function-name>");

        // Pass parameters as query string for functions
        const param1 = Server.Context.QueryParameters["param1"];
        const queryString = "<custom-function-name>(Param1='" + param1 + "')";

        const result = Server.Connector.Dataverse.InvokeCustomApi(
            "GET",
            queryString,
            null
        );

        const response = JSON.parse(result);
        if (response.IsSuccessStatusCode === false || !(response.StatusCode >= 200 && response.StatusCode < 300)) {
            throw new Error("Dataverse custom function failed: " + response.StatusCode);
        }
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
- `InvokeCustomApi` is **synchronous** - do NOT use `async`/`await`
- The server logic can add additional validation, transformation, or logging around the custom action call - it doesn't have to be a pass-through
- When Custom API response properties are known (from Phase 2.1.2), map them to the response object for clarity

#### Dataverse Response Shape (Critical for Frontend Integration)

`Server.Connector.Dataverse.*` returns a JSON string. Parse it with `JSON.parse(result)` before accessing `StatusCode`, `Body`, or `Headers`; `Body` is another JSON string. Check the connector status before reporting success. Parse read bodies explicitly; an empty or malformed read body is an error, not an empty record set. Successful writes can have an empty body, so do not parse it unless the operation returns a payload. Pass read query options without a leading `?`; the connector inserts the query separator.

Before writing the function, pick a response shape and record it for Phase 9: **Approach A - raw passthrough** (return the connector string unchanged), **Approach B - wrapped passthrough** (return `{ status, data: result }`, where `data` remains a string), or **Approach C - normalized** (parse the connector result and its `Body` server-side, then return a feature-specific shape). Prefer Approach C for feature endpoints.

Read `${PLUGIN_ROOT}/skills/add-server-logic/references/frontend-integration-reference.md` -> "Dataverse Connector Response Format" before implementing Dataverse reads or writes. It contains server/client parsing examples and explains how to extract a GUID from the `CreateRecord` connector's `OData-EntityId` URL.

#### Referencing Secrets in Code

When the server logic needs a secret value identified in Phase 2.3, **never hardcode the value**. Instead, read it at runtime from a site setting backed by an environment variable:

```javascript
const apiKey = Server.Sitesetting.Get("ExternalApi/ExchangeRateApiKey");
```

Use the site setting name planned in Phase 2.3. The actual environment variable and site setting YAML will be created in Phase 7.

#### SDK Usage Guidance

Do **not** duplicate Microsoft Learn SDK usage patterns inline in this skill. Use the documentation fetched in Phase 3 as the source of truth for connector methods, signatures, and supported patterns, then apply only the task-specific notes that were captured in the approved plan.

## Create the metadata YAML

For each approved server logic item where the plan status is `create`, generate the metadata file with the writer script instead of hand-authoring the YAML. The script generates a UUID, writes the fields in the correct order, and returns the created file path as JSON. **Skip this step for `update` / `reuse` items** - the YAML already exists and should be updated manually if needed.

```bash
node "${PLUGIN_ROOT}/skills/add-server-logic/scripts/create-serverlogic-metadata.js" --projectRoot "<PROJECT_ROOT>" --name "<name>" --displayName "<human-readable display name>" --description "<description of what this server logic does>" --webRoleIds "<uuid1,uuid2,uuid3>"
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

- **`id` field is mandatory** - The script generates a new UUID (v4). PAC CLI crashes with `Expected Guid for primary key 'id'` if this is missing.
- **`adx_serverlogic_adx_webrole`** - Array of web role GUIDs from step 5.2. Include only the roles required for that server logic item.
- **`name`** - Must match the folder name and `.js` file name (the URL-friendly name used in `/_api/serverlogics/<name>`).
- **`display_name`** - Human-readable name (e.g., "Exchange Rate API", "Order Processor").
- **Alphabetical field ordering** - Fields must be sorted alphabetically: `adx_serverlogic_adx_webrole`, `description`, `display_name`, `id`, `name`.

## Validate the code

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
| Runtime patterns | Apply the raw-source checks in "Prohibited Script Patterns" |
| Dataverse results | Apply the parsing and status checks in "Dataverse Response Shape" |
| ECMAScript 2023 compliant | Standard JS features only (optional chaining, nullish coalescing, etc. are fine) |
