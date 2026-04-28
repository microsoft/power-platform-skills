# Frontend Integration Reference

Use this reference in Phase 9 of `add-server-logic` to decide how the site's frontend should call one or more server logic endpoints.

## Goal

Choose the lightest integration approach that matches the existing codebase patterns. Reuse established utilities when possible. Only introduce new helpers when the site does not already have a consistent API calling pattern.

Frontend integration is **not complete** when only a helper or service file exists. The endpoint must be wired into the actual user experience unless the user explicitly asks for backend-only work.

## Decision Order

1. Reuse an existing service layer or API wrapper if one already exists.
2. Reuse existing CSRF token handling patterns if the site already has them.
3. Create a new helper only when no suitable pattern exists.
4. Group related server logic endpoints into a coherent service module when multiple endpoints are being introduced together.
5. Add framework-specific hooks/composables/services only when the codebase already uses those abstractions.

## Existing Pattern Detection

Look for:

- `shell.safeAjax` usage in legacy or jQuery-based sites
- Shared fetch wrappers such as `powerPagesApi.ts`, `apiClient.ts`, or framework-specific service modules
- Existing CSRF token helpers built around `/_layout/tokenhtml`
- Existing hooks/composables/services that wrap backend calls with loading and error state

## Server Logic Response Envelope

Server logic endpoints return responses in a standard JSON envelope:

```json
{
  "requestId": "<activity-guid>",
  "success": true,
  "serverLogicName": "<endpoint-name>",
  "data": "<string returned by your function>",
  "error": null
}
```

- `data` contains the string returned by the invoked function (e.g., the `JSON.stringify(...)` result). Parse it with `JSON.parse(response.data)` when the function returns serialized JSON.
- On failure, `success` is `false`, `data` is `null`, and `error` contains the error message.
- `requestId` is the server-side activity GUID — useful for correlating with `Server.Logger` output in diagnostics.

All frontend helpers and service wrappers should unwrap `.data` from this envelope rather than treating the entire response body as the function's return value.

## Dataverse Connector Response Format

When a server logic function returns the raw result of a `Server.Connector.Dataverse.*` method, the shape that reaches the client is **double-wrapped**. This is the most common source of bugs in client integration code.

Reference: [Microsoft Learn — How to interact with Dataverse tables using server logic](https://learn.microsoft.com/en-us/power-pages/configure/server-logic-operations).

### Shape of `Server.Connector.Dataverse.*` return values

The Dataverse connector methods (`RetrieveRecord`, `RetrieveMultipleRecords`, `CreateRecord`, `UpdateRecord`, `DeleteRecord`, `InvokeCustomApi`) return an object that contains the raw Dataverse HTTP response. When that object is returned from the server logic function, it is serialized into the envelope's `data` string. Concretely the client sees:

```json
{
  "requestId": "…",
  "success": true,
  "serverLogicName": "dataverse-crud-operations",
  "data": "{\"Body\":\"{\\\"@odata.context\\\":\\\"…\\\",\\\"value\\\":[{…}, {…}]}\",\"StatusCode\":200,\"Headers\":{…}}",
  "error": null
}
```

To reach the Dataverse records the client must parse **twice**:

```javascript
const envelope = responseBody;             // server logic envelope
const outer = JSON.parse(envelope.data);    // { Body: "<json string>", StatusCode, Headers }
const body  = JSON.parse(outer.Body);       // { "@odata.context": "...", value: [...] } (for RetrieveMultipleRecords)
const records = body.value;                 // the actual array
```

For `RetrieveRecord`, `body` is the single record object (no `value` array). For `CreateRecord`, the new record's GUID is returned in the HTTP response header `entityid` — read it with `xhr.getResponseHeader('entityid')` (jQuery/safeAjax) or `response.headers.get('entityid')` (fetch).

### Three approaches — pick one and apply it consistently

For Dataverse-backed server logic there are three valid response shapes: **raw passthrough** (return the connector result as-is and parse it twice on the client), **server envelope that still wraps the connector result** (preserve the connector metadata but add an outer status wrapper), and **fully normalized** (unwrap everything server-side and return only what the UI needs). Pick one shape for each endpoint and apply it consistently across the server logic and the frontend integration.

**Approach A — Return the raw Dataverse response, double-parse on the client**

This is the pattern shown in the Microsoft Learn sample. Useful when the server logic is a thin CRUD passthrough driven by `entitySetName` query parameters.

Server logic:

```javascript
function get() {
    try {
        Server.Logger.Log("GET called");
        const entitySetName = Server.Context.QueryParameters["entitySetName"];
        const additionalParameters = Server.Context.QueryParameters["additionalParameters"];
        if (!Server.Context.QueryParameters["id"]) {
            return Server.Connector.Dataverse.RetrieveMultipleRecords(entitySetName, additionalParameters);
        }
        const id = Server.Context.QueryParameters["id"];
        return Server.Connector.Dataverse.RetrieveRecord(entitySetName, id, additionalParameters);
    } catch (err) {
        Server.Logger.Error("GET failed: " + err.message);
        return JSON.stringify({ status: "error", method: "GET", message: err.message });
    }
}
```

Client (matches the Microsoft Learn sample exactly):

```javascript
ajaxCall('Loading...', {
    type: 'GET',
    url: '/_api/serverlogics/dataverse-crud-operations?entitySetName=contacts&additionalParameters=$select=fullname,firstname,lastname,emailaddress1,telephone1',
    contentType: 'application/json'
}).done(res => {
    const outer = JSON.parse(res.data);
    const body  = JSON.parse(outer.Body);
    const rows  = (body.value || []).map(r => ({ ...r, id: r.contactid }));
    render(rows);
});
```

For `CreateRecord` the new id comes from a response header:

```javascript
success: (res, status, xhr) => {
    record.id = xhr.getResponseHeader('entityid');
    addRecord(record);
}
```

**Approach B — Server envelope that still wraps the connector result**

Use this when you want to add a stable top-level wrapper (e.g. `{ status, data }`) to every response but keep the raw connector result inside so generic handling code can read `Body`/`StatusCode`/`Headers` if needed.

Server logic:

```javascript
function get() {
    try {
        Server.Logger.Log("GET called");
        const entitySetName = Server.Context.QueryParameters["entitySetName"];
        const result = Server.Connector.Dataverse.RetrieveMultipleRecords(entitySetName);
        return JSON.stringify({ status: "success", data: result });
    } catch (err) {
        Server.Logger.Error("GET failed: " + err.message);
        return JSON.stringify({ status: "error", message: err.message });
    }
}
```

Client — note the extra `data` layer before reaching `Body`:

```typescript
const envelope = await powerPagesFetch<{ data: string | null; success: boolean; error: string | null }>(
    '/_api/serverlogics/contacts-crud',
    { method: 'GET' }
);
if (!envelope) throw new Error('Empty response from contacts-crud');
if (!envelope.success) throw new Error(envelope.error ?? 'Failed');
if (envelope.data == null) throw new Error('Missing response data from contacts-crud');
const payload = JSON.parse(envelope.data) as { status: string; data: { Body: string; StatusCode: number; Headers: Record<string, string> } };
const outer   = payload.data;                 // connector result still wrapped here
const body    = JSON.parse(outer.Body);       // { "@odata.context": "...", value: [...] }
const records = body.value;
```

Do **not** use the Approach A parsing path (`JSON.parse(envelope.data) → JSON.parse(outer.Body)`) against this shape — that skips the `payload.data` unwrap and reads `Body` off the wrong object.

**Approach C — Unwrap server-side and return a clean shape (recommended for most new code)**

Return a stable, documented shape from the function. Client code then only unwraps the outer envelope and parses `data` once. Prefer this when the server logic serves a specific feature (not a generic CRUD passthrough).

Server logic:

```javascript
function get() {
    try {
        Server.Logger.Log("getContacts GET called");
        const dvResponse = Server.Connector.Dataverse.RetrieveMultipleRecords(
            "contacts",
            "?$select=contactid,firstname,lastname,emailaddress1,telephone1"
        );
        const body = JSON.parse(dvResponse.Body);
        const contacts = (body.value || []).map(r => ({
            id: r.contactid,
            firstName: r.firstname,
            lastName: r.lastname,
            email: r.emailaddress1,
            phone: r.telephone1
        }));
        return JSON.stringify({ status: "success", contacts });
    } catch (err) {
        Server.Logger.Error("getContacts GET failed: " + err.message);
        return JSON.stringify({ status: "error", message: err.message });
    }
}
```

Client:

```typescript
const envelope = await powerPagesFetch<{ data: string | null; success: boolean; error: string | null }>(
    '/_api/serverlogics/getContacts',
    { method: 'GET' }
);
if (!envelope) throw new Error('Empty response from getContacts');
if (!envelope.success) throw new Error(envelope.error ?? 'Failed');
if (envelope.data == null) throw new Error('Missing response data from getContacts');
const payload = JSON.parse(envelope.data) as { status: string; contacts: Contact[] };
return payload.contacts;
```

For writes, return the new id from the server logic explicitly rather than relying on the `entityid` header:

```javascript
const dvResponse = Server.Connector.Dataverse.CreateRecord("contacts", JSON.stringify(body));
const newId = dvResponse.Headers && dvResponse.Headers.entityid;
return JSON.stringify({ status: "success", id: newId });
```

### When the response shape is unknown

If the frontend integration is failing because the exact Dataverse response shape is unclear for a specific operation (custom actions, bound actions, non-standard query options), invoke `/test-site` against the deployed site. The test-site skill captures live `/_api/serverlogics/` responses and reports the exact `envelope.data` and (when present) `outer.Body` shapes so the frontend integration can be written against the real response, not a guessed one.

### Key points for Dataverse-backed server logic

- `Server.Connector.Dataverse.*` methods return an object with `Body` (a JSON string), `StatusCode`, and `Headers`. They are **synchronous** — do not `await` them.
- When the server logic returns that object directly, the client must `JSON.parse(res.data)` to get the outer object and `JSON.parse(outer.Body)` to get the Dataverse payload.
- `RetrieveMultipleRecords` payloads have a `value` array; `RetrieveRecord` payloads are a single record object.
- `CreateRecord` returns the new record id via the `entityid` HTTP response header — not in the body.
- For non-trivial features, prefer unwrapping `Body` inside the server logic and returning a feature-specific shape (Approach C) so the client integration is obvious and stable.

## Recommended Approaches

### 1. Sites Using `shell.safeAjax`

If the site already uses `shell.safeAjax`, create thin wrappers around it instead of introducing a new fetch abstraction.

Use this shape:

```javascript
function callServerLogic(method, endpointName, queryParams, body) {
    return new Promise((resolve, reject) => {
        let url = `/_api/serverlogics/${endpointName}`;
        if (queryParams) {
            url += '?' + new URLSearchParams(queryParams).toString();
        }

        shell.safeAjax({
            type: method,
            url,
            contentType: 'application/json',
            data: body ? JSON.stringify(body) : undefined,
            success: function (res) { resolve(res); },
            error: function (xhr) { reject(xhr); }
        });
    });
}
```

### 2. SPA Sites with an Existing API Wrapper

If the site already has a helper such as `powerPagesFetch`, reuse it and add one or more thin server logic functions on top.

Use this shape:

```typescript
import { powerPagesFetch } from '../shared/powerPagesApi';

export async function callServerLogic<T = unknown>(
    endpointName: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    params?: Record<string, string>,
    body?: unknown
): Promise<T> {
    const url = params
        ? `/_api/serverlogics/${endpointName}?${new URLSearchParams(params)}`
        : `/_api/serverlogics/${endpointName}`;

    const envelope = await powerPagesFetch<{ data: string | null; success: boolean; error: string | null }>(url, {
        method,
        body: body ? JSON.stringify(body) : undefined,
    });

    if (!envelope) {
        throw new Error(`Empty response from ${endpointName}`);
    }
    if (!envelope.success) {
        throw new Error(envelope.error ?? 'Server logic call failed');
    }
    if (envelope.data == null) {
        throw new Error(`Missing response data from ${endpointName}`);
    }

    return JSON.parse(envelope.data) as T;
}
```

### 3. SPA Sites Without an Existing API Wrapper

If the site has no established API client, create a lightweight CSRF-aware helper and keep it narrowly scoped.

Use this shape:

```typescript
async function getCsrfToken(): Promise<string> {
    const response = await fetch('/_layout/tokenhtml');
    const html = await response.text();
    const match = html.match(/value="([^"]+)"/);
    if (!match) {
        throw new Error('Failed to get CSRF token');
    }
    return match[1];
}

export async function callServerLogic<T = unknown>(
    endpointName: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    params?: Record<string, string>,
    body?: unknown
): Promise<T> {
    const url = params
        ? `/_api/serverlogics/${endpointName}?${new URLSearchParams(params)}`
        : `/_api/serverlogics/${endpointName}`;

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };

    // CSRF token is required for non-GET requests only
    if (method !== 'GET') {
        headers['__RequestVerificationToken'] = await getCsrfToken();
    }

    const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
        throw new Error(`Server logic call failed: ${response.status}`);
    }

    return response.json();
}
```

## Multiple Server Logic Endpoints

When a single user request results in multiple server logic endpoints:

- Prefer one shared helper plus endpoint-specific wrapper functions
- Group related endpoints into one service module when they belong to the same feature area
- Keep endpoint names explicit rather than hiding them behind vague generic method names
- Share token handling and low-level request plumbing; keep business semantics in endpoint-specific functions

Example:

```typescript
export const orderServerLogic = {
    getSummary: () => callServerLogic('order-summary', 'GET'),
    submitOrder: (payload: unknown) => callServerLogic('order-submit', 'POST', undefined, payload),
};
```

## Framework-Specific Abstractions

Only add hooks/composables/services with loading/error state when the site already uses that pattern.

- **React**: `useServerLogic` or feature-specific hooks such as `useOrderSummary`
- **Vue**: composables such as `useServerLogic`
- **Angular**: injectable services returning observables or promises following existing conventions
- **Astro**: plain service modules are usually sufficient

## Component Updates

When integrating the new endpoints into existing UI:

- Make the feature reachable from the real UI flow — a button, form submission, page load, filter action, or other user-triggered path
- Replace mock data or placeholder URLs only when they clearly map to the approved server logic plan
- Preserve existing loading, empty, and error states when present
- Add loading/error handling if the component currently has none and the codebase pattern supports it
- Avoid broad refactors unrelated to the server logic integration

## Output Expectations

Phase 9 should leave behind:

- The frontend helper or service files needed to call the server logic endpoints
- Any framework-specific wrappers that match the site's existing architecture
- Updated components/pages/forms/actions wired to the new endpoints when the scope includes that work
- A summary of which frontend files were created or changed and which endpoints they call
