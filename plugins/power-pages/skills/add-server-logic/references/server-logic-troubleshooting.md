# Server logic troubleshooting

Read when a deployed server logic endpoint returns an error or unexpected response.

## Troubleshooting Server Logic Execution Errors

When a deployed server logic endpoint returns an error or unexpected response, inspect the `x-ms-user-trace` response header, which contains base64-encoded JSON diagnostic logs when the payload fits inline. Larger traces use `x-ms-user-trace-id` instead; that value is an identifier, not base64-encoded logs. The Power Pages Edge browser extension shows the same data.

Use this flow whenever a server logic call fails or returns a different response than expected:

### 1. Open the live site in a browser

Use an available browser automation capability to inspect the site:

1. Navigate to the deployed site URL from the site's activation workflow or the Power Pages admin center.
2. Ask the user to sign in if the endpoint requires authentication and wait for confirmation.
3. Trigger the action that calls the failing server logic endpoint (click the button, submit the form, etc.) - or call the endpoint directly with `fetch()`.

### 2. Capture the network response

Inspect network activity and locate the request to `/_api/serverlogics/<name>`. Note:

- The HTTP status code (e.g., 200, 400, 500)
- The response body (often a generic error or empty payload when validation fails)
- **Most importantly: the `X-Ms-UserTrace` response header** - this is where the actual diagnostic logs live

If the browser's network view does not show response headers, use its JavaScript evaluation capability to read them. GET requests are exempt from antiforgery validation:

```javascript
const res = await fetch('/_api/serverlogics/<name>', {
    method: 'GET',
    credentials: 'include'
});
const trace = res.headers.get('x-ms-user-trace');
const traceId = res.headers.get('x-ms-user-trace-id');
return { status: res.status, body: await res.text(), trace, traceId };
```

### 3. Inspect the trace

Decode `x-ms-user-trace` as base64-encoded JSON when present. If only `x-ms-user-trace-id` is present, use the Power Pages browser extension to inspect the trace; do not decode the identifier as logs. If neither header is present, report that response diagnostics are unavailable rather than treating the absence as success.

The decoded payload contains diagnostic log entries, including the prohibited pattern if script validation failed. For HTTP 200 responses with missing rows, log the connector result's type, parsed `StatusCode`, and record count. Confirm both JSON layers were parsed before investigating table permissions. Avoid logging record contents or secrets.

After fixing, use the site's deployment workflow after approval, then restart the site so the change is picked up immediately.

---
