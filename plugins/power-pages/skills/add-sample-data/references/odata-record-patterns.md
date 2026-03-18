# OData API Patterns for Record Creation

Reference document for the `add-sample-data` skill. Contains patterns for inserting records, setting lookup bindings, handling different column types, and querying record counts via the Dataverse OData Web API (v9.2).

> **Authentication, error handling, and retry patterns** are in the shared reference: `${CLAUDE_PLUGIN_ROOT}/references/odata-common.md`. Read that file first for headers, token refresh, HTTP status codes, and retry logic.

---

## Get Entity Set Name

Entity set names are required for all record operations. They differ from logical names (e.g., `cr123_project` → `cr123_projects`).

**Endpoint:** `GET {envUrl}/api/data/v9.2/EntityDefinitions(LogicalName='<table>')?$select=EntitySetName`

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> GET "EntityDefinitions(LogicalName='cr123_project')?\$select=EntitySetName"
```

The response JSON `data.EntitySetName` contains the entity set name (e.g., `"cr123_projects"`).

---

## Insert a Record

**Endpoint:** `POST {envUrl}/api/data/v9.2/<EntitySetName>`

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> POST "cr123_projects" --body '{"cr123_name":"Website Redesign","cr123_description":"Modernize the corporate website with a fresh design","cr123_startdate":"2025-06-15T10:30:00Z","cr123_budget":15000.00,"cr123_isactive":true,"cr123_status":100000000}'
```

### Capturing the Created Record ID

The record ID is returned in the `OData-EntityId` response header. Use `--include-headers` to capture it:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> POST "cr123_projects" --body '{"cr123_name":"Website Redesign"}' --include-headers
```

The response JSON includes a `headers` object with the `OData-EntityId` value. Parse the GUID from it to use in subsequent lookups.

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

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> GET "EntityDefinitions(LogicalName='cr123_project')/Attributes(LogicalName='cr123_status')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?\$expand=OptionSet"
```

The response `data.OptionSet.Options` array contains objects with `Value` (e.g., `100000000`) and `Label.LocalizedLabels[0].Label` (e.g., `"Active"`).

Use these actual `Value` integers in your sample data — never guess option values.

---

## Lookup Binding Examples

### Single Lookup

A task referencing a project:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> POST "cr123_tasks" --body '{"cr123_name":"Design mockups","cr123_duedate":"2025-07-01T00:00:00Z","cr123_ProjectId@odata.bind":"/cr123_projects(<projectGuid>)"}' --include-headers
```

### Multiple Lookups

A record referencing multiple parent tables:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> POST "<EntitySetName>" --body '{"cr123_name":"Project Update Meeting","cr123_ProjectId@odata.bind":"/cr123_projects(<projectGuid>)","cr123_ContactId@odata.bind":"/contacts(<contactGuid>)"}' --include-headers
```

---

## Querying Record Count

Verify how many records exist in a table after insertion:

**Endpoint:** `GET {envUrl}/api/data/v9.2/<EntitySetName>?$count=true&$top=0`

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> GET "cr123_projects?\$count=true&\$top=0"
```

The response `data["@odata.count"]` contains the total record count.

The `$top=0` ensures no actual records are returned — only the count.

---

## Batch Operations (Optional)

For inserting many records efficiently, use OData batch requests to send multiple operations in a single HTTP call.

**Endpoint:** `POST {envUrl}/api/data/v9.2/$batch`

**Headers:**

Authentication is handled automatically by `dataverse-request.js`. To send a batch request, use POST to the `$batch` endpoint. The script handles auth headers and token refresh internally:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> POST "\$batch" --body '<batch body>'
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

See `${CLAUDE_PLUGIN_ROOT}/references/odata-common.md` for HTTP status codes, error response format, Dataverse error codes, and retry patterns.
