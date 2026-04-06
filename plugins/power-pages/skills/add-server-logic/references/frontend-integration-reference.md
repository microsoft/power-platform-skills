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

    const envelope = await powerPagesFetch<{ data: string; success: boolean; error: string | null }>(url, {
        method,
        body: body ? JSON.stringify(body) : undefined,
    });

    if (!envelope.success) {
        throw new Error(envelope.error ?? 'Server logic call failed');
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
