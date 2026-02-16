# OData API Patterns for Record Creation

Reference document for the `add-sample-data` skill. Contains patterns for inserting records, setting lookup bindings, handling different column types, and querying record counts via the Dataverse OData Web API (v9.2).

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

Azure CLI tokens expire after ~60 minutes. Refresh every 20 records or before each major step:

```powershell
$token = az account get-access-token --resource "$envUrl" --query accessToken -o tsv
$headers["Authorization"] = "Bearer $token"
```

---

## Get Entity Set Name

Entity set names are required for all record operations. They differ from logical names (e.g., `cr123_project` → `cr123_projects`).

**Endpoint:** `GET {envUrl}/api/data/v9.2/EntityDefinitions(LogicalName='<table>')?$select=EntitySetName`

```powershell
$entityDef = Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/EntityDefinitions(LogicalName='cr123_project')?`$select=EntitySetName" -Headers $headers
$entitySetName = $entityDef.EntitySetName  # e.g., "cr123_projects"
```

---

## Insert a Record

**Endpoint:** `POST {envUrl}/api/data/v9.2/<EntitySetName>`

```powershell
$body = @{
    cr123_name        = "Website Redesign"
    cr123_description = "Modernize the corporate website with a fresh design"
    cr123_startdate   = "2025-06-15T10:30:00Z"
    cr123_budget      = 15000.00
    cr123_isactive    = $true
    cr123_status      = 100000000
} | ConvertTo-Json

$response = Invoke-RestMethod -Method Post -Uri "$envUrl/api/data/v9.2/cr123_projects" -Headers $headers -Body $body -ContentType "application/json"
```

### Capturing the Created Record ID

The record ID is returned in the `OData-EntityId` response header. To capture it:

```powershell
$response = Invoke-WebRequest -Method Post -Uri "$envUrl/api/data/v9.2/cr123_projects" -Headers $headers -Body $body -ContentType "application/json"
$entityId = $response.Headers["OData-EntityId"] -replace '.*\(([^)]+)\).*', '$1'
```

Alternatively, use the `Prefer: return=representation` header to get the full record back:

```powershell
$headers["Prefer"] = "return=representation"
$response = Invoke-RestMethod -Method Post -Uri "$envUrl/api/data/v9.2/cr123_projects" -Headers $headers -Body $body -ContentType "application/json"
$recordId = $response.cr123_projectid
$headers.Remove("Prefer")
```

---

## Column Type Values

### String (SingleLine.Text)

Set as a plain string:

```json
{ "cr123_name": "Sample Value" }
```

### Memo (MultiLine.Text)

Set as a plain string (supports longer text):

```json
{ "cr123_description": "This is a longer description that can span multiple lines and paragraphs." }
```

### Integer (WholeNumber)

Set as an integer:

```json
{ "cr123_quantity": 42 }
```

### Decimal

Set as a decimal number:

```json
{ "cr123_rating": 4.75 }
```

### Currency (Money)

Set as a numeric value:

```json
{ "cr123_price": 99.99 }
```

### DateTime

Set as ISO 8601 format string:

```json
{ "cr123_startdate": "2025-06-15T10:30:00Z" }
```

For date-only fields:

```json
{ "cr123_birthdate": "2025-06-15" }
```

### Boolean

Set as `true` or `false`:

```json
{ "cr123_isactive": true }
```

### Choice / Picklist

Set as the integer option value (NOT the label text):

```json
{ "cr123_status": 100000000 }
```

Choice option values typically start at `100000000` and increment by 1.

### Lookup (Relationship Binding)

Use the `@odata.bind` annotation to reference a related record:

```json
{ "cr123_ProjectId@odata.bind": "/cr123_projects(00000000-0000-0000-0000-000000000001)" }
```

The format is: `"<lookup_logical_name>@odata.bind": "/<ReferencedEntitySetName>(<guid>)"`

---

## Getting Picklist Options

Before inserting records with picklist/choice columns, query the valid option values:

**Endpoint:** `GET {envUrl}/api/data/v9.2/EntityDefinitions(LogicalName='<table>')/Attributes(LogicalName='<column>')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$expand=OptionSet`

```powershell
$picklistMeta = Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/EntityDefinitions(LogicalName='cr123_project')/Attributes(LogicalName='cr123_status')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?`$expand=OptionSet" -Headers $headers

# Extract options
$options = $picklistMeta.OptionSet.Options
foreach ($opt in $options) {
    $value = $opt.Value          # e.g., 100000000
    $label = $opt.Label.LocalizedLabels[0].Label  # e.g., "Active"
}
```

Use these actual `Value` integers in your sample data — never guess option values.

---

## Lookup Binding Examples

### Single Lookup

A task referencing a project:

```powershell
$body = @{
    cr123_name = "Design mockups"
    cr123_duedate = "2025-07-01T00:00:00Z"
    "cr123_ProjectId@odata.bind" = "/cr123_projects($projectGuid)"
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "$envUrl/api/data/v9.2/cr123_tasks" -Headers $headers -Body $body -ContentType "application/json"
```

### Multiple Lookups

A record referencing multiple parent tables:

```powershell
$body = @{
    cr123_name = "Project Update Meeting"
    "cr123_ProjectId@odata.bind" = "/cr123_projects($projectGuid)"
    "cr123_ContactId@odata.bind" = "/contacts($contactGuid)"
} | ConvertTo-Json
```

---

## Querying Record Count

Verify how many records exist in a table after insertion:

**Endpoint:** `GET {envUrl}/api/data/v9.2/<EntitySetName>?$count=true&$top=0`

```powershell
$result = Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/cr123_projects?`$count=true&`$top=0" -Headers $headers
$recordCount = $result."@odata.count"
```

The `$top=0` ensures no actual records are returned — only the count.

---

## Batch Operations (Optional)

For inserting many records efficiently, use OData batch requests to send multiple operations in a single HTTP call.

**Endpoint:** `POST {envUrl}/api/data/v9.2/$batch`

**Headers:**

```powershell
$batchId = [guid]::NewGuid().ToString()
$batchHeaders = @{
    Authorization  = "Bearer $token"
    "Content-Type" = "multipart/mixed; boundary=batch_$batchId"
    Accept         = "application/json"
}
```

**Body format:**

```
--batch_<batchId>
Content-Type: multipart/mixed; boundary=changeset_<changesetId>

--changeset_<changesetId>
Content-Type: application/http
Content-Transfer-Encoding: binary
Content-ID: 1

POST /api/data/v9.2/<EntitySetName> HTTP/1.1
Content-Type: application/json

{"cr123_name": "Record 1"}
--changeset_<changesetId>
Content-Type: application/http
Content-Transfer-Encoding: binary
Content-ID: 2

POST /api/data/v9.2/<EntitySetName> HTTP/1.1
Content-Type: application/json

{"cr123_name": "Record 2"}
--changeset_<changesetId>--
--batch_<batchId>--
```

**Note:** Batch requests share a single transaction per changeset — if one operation fails, all operations in that changeset are rolled back. Keep changesets small (5-10 operations) to limit blast radius of failures.

---

## Error Handling

### Common HTTP Status Codes

| Code | Meaning | Action |
|------|---------|--------|
| 200/204 | Success | Proceed |
| 400 | Bad request (malformed JSON, invalid field) | Fix the JSON body and retry |
| 401 | Unauthorized (token expired) | Refresh token and retry |
| 403 | Forbidden (insufficient privileges) | Inform user about permissions |
| 404 | Entity set not found | Verify entity set name and retry |
| 409 | Conflict (duplicate key) | Skip this record, log the duplicate |
| 429 | Too many requests (throttled) | Wait 5 seconds, then retry |
| 500/502/503 | Server error | Wait 5 seconds, retry once, then report failure |

### Error Response Format

Dataverse OData errors follow this structure:

```json
{
  "error": {
    "code": "0x80040237",
    "message": "A record with matching key values already exists."
  }
}
```

Parse `error.message` for user-friendly reporting.

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
