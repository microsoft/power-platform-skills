# OData Common Patterns

Shared reference for all skills that interact with the Dataverse OData Web API (v9.2). Covers authentication, token management, error handling, and retry logic.

---

## Authentication Header

All requests require the following headers:

```json
{
  "Authorization": "Bearer <token>",
  "Content-Type": "application/json",
  "Accept": "application/json",
  "OData-MaxVersion": "4.0",
  "OData-Version": "4.0"
}
```

To verify access and obtain a token:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-dataverse-access.js" <envUrl>
```

This outputs JSON with `token`, `userId`, `organizationId`, and `tenantId`.

For making requests, use `dataverse-request.js` which handles authentication headers automatically:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> GET /api/data/v9.2/entities
```

### Token Refresh

Azure CLI tokens expire after ~60 minutes. The `dataverse-request.js` script handles 401 token refresh automatically. For long-running operations (many records or multiple tables), re-run `verify-dataverse-access.js` periodically (every ~20 records or 3-4 tables) to confirm access is still valid:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-dataverse-access.js" <envUrl>
```

---

## Error Handling

### Common HTTP Status Codes

| Code | Meaning | Action |
|------|---------|--------|
| 200/204 | Success | Proceed |
| 400 | Bad request (malformed JSON, invalid field) | Fix the JSON body and retry |
| 401 | Unauthorized (token expired) | Refresh token and retry |
| 403 | Forbidden (insufficient privileges) | Inform user about permissions |
| 404 | Entity not found | Table/column/entity set doesn't exist — verify name and retry |
| 409 | Conflict (duplicate) | Table/column/record already exists — skip |
| 429 | Too many requests (throttled) | Wait 5 seconds, then retry |
| 500/502/503 | Server error | Wait 5 seconds, retry once, then report failure |

### Error Response Format

Dataverse OData errors follow this structure:

```json
{
  "error": {
    "code": "0x80060888",
    "message": "Entity 'cr123_project' already exists."
  }
}
```

Parse `error.message` for user-friendly reporting. Common error codes:

| Code | Meaning |
|------|---------|
| `0x80048408` | Privilege check failed |
| `0x80060888` | Entity already exists |
| `0x80044153` | Attribute already exists |
| `0x8004431A` | Relationship already exists |
| `0x80040237` | Record with matching key values already exists |

### Retry Pattern

The `dataverse-request.js` script handles retries internally:

- **401** — Automatically refreshes the token and retries
- **429 / 5xx** — Waits and retries automatically

No manual retry logic is needed. Simply call the script and check the returned status code:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> POST /api/data/v9.2/cr123_projects --body "{\"cr123_name\":\"My Project\"}"
```

The output is JSON: `{ "status": <code>, "data": {...} }`. If the request fails after retries, inspect `status` and `data.error.message` to determine the appropriate action from the error tables above.
