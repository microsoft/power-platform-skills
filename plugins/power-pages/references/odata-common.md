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

PowerShell helper:

```powershell
$token = az account get-access-token --resource "$envUrl" --query accessToken -o tsv
$headers = @{
  Authorization  = "Bearer $token"
  "Content-Type" = "application/json"
  Accept         = "application/json"
}
```

### Token Refresh

Azure CLI tokens expire after ~60 minutes. Refresh before each major step or every 20 records:

```powershell
$token = az account get-access-token --resource "$envUrl" --query accessToken -o tsv
$headers["Authorization"] = "Bearer $token"
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

For transient errors (401, 429, 5xx):

```powershell
$maxRetries = 2
for ($i = 0; $i -le $maxRetries; $i++) {
    try {
        $result = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $body -ContentType "application/json"
        break
    } catch {
        $statusCode = $_.Exception.Response.StatusCode.value__
        if ($statusCode -eq 401) {
            # Refresh token and retry
            $token = az account get-access-token --resource "$envUrl" --query accessToken -o tsv
            $headers["Authorization"] = "Bearer $token"
        } elseif ($statusCode -in @(429, 500, 502, 503)) {
            Start-Sleep -Seconds 5
        } else {
            throw
        }
    }
}
```
