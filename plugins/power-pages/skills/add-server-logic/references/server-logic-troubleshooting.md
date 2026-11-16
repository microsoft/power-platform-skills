# Server logic troubleshooting

Read when a deployed server logic endpoint returns an error or unexpected response.

## Troubleshooting Server Logic Execution Errors

When a deployed server logic endpoint returns an error or unexpected response, the underlying cause is usually hidden inside the `X-Ms-UserTrace` response header - a base64-encoded blob containing the runtime diagnostic logs. The Power Pages Edge browser extension shows the same data, but inspecting the response header is the fastest path when iterating against a live site.

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

If the browser's network view does not show response headers, use its JavaScript evaluation capability to read them. Server logic requests require a CSRF token, including GET:

```javascript
const tokenResponse = await fetch('/_layout/tokenhtml', { credentials: 'include' });
const tokenHtml = await tokenResponse.text();
const token = tokenHtml.match(/value="([^"]+)"/)?.[1];
if (!token) throw new Error('Failed to get CSRF token');
const res = await fetch('/_api/serverlogics/<name>', {
    method: 'GET',
    credentials: 'include',
    headers: { '__RequestVerificationToken': token }
});
const trace = res.headers.get('X-Ms-UserTrace');
return { status: res.status, body: await res.text(), trace };
```

### 3. Decode the `X-Ms-UserTrace` Header

The header value is base64-encoded JSON. Decode it.

The decoded payload contains the diagnostic log entries - including the actual error message, the prohibited pattern (if script validation failed).

After fixing, use the site's deployment workflow after approval, then restart the site so the change is picked up immediately.

---
