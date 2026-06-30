# Dataverse Reference

Critical patterns for working with Dataverse in Power Apps code apps. **Read this before writing any Dataverse code.**

## Choice/Picklist Fields - CRITICAL

Choice fields (`PicklistType`) store **integer values**, not string labels. The schema defines both:
- `enum`: String labels for display (e.g., "Active", "Inactive")
- `x-ms-enum-values`: Numeric values used by API (e.g., 0, 1)

See [Types of columns - Choice](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/types-of-fields)

The generated models include enum mappings you can import:
```typescript
// Generated in models - maps numeric value to string label
import { TableNameFieldName } from '../generated/models/TableNameModel';
// e.g., { 0: 'Active', 1: 'Inactive', 2: 'Pending' }
const label = TableNameFieldName[numericValue];
```

```typescript
// CORRECT - Define enum constants with numeric values from schema
const Status = {
  Active: 0,
  Inactive: 1,
  Pending: 2
} as const;

// CORRECT - Filter using numeric values
const activeRecords = records.filter(r => r.statuscode === Status.Active);

// CORRECT - Create with numeric choice value
const newRecord: any = {
  'prefix_name': 'My Record',
  'prefix_category': 100000000,  // Numeric value, NOT "Category Name"
  'statuscode': Status.Active
};

// CORRECT - Convert numeric to label for display
const getStatusLabel = (status?: number): string => {
  switch (status) {
    case Status.Active: return 'Active';
    case Status.Inactive: return 'Inactive';
    case Status.Pending: return 'Pending';
    default: return 'Unknown';
  }
};

// WRONG - String comparison fails (TypeScript error: number vs string)
records.filter(r => r.statuscode === 'Active');

// WRONG - API rejects string values
{ 'prefix_category': 'Electronics' }  // Error: Cannot convert 'Electronics' to Edm.Int32
```

**MultiSelect Choice** (`MultiSelectPicklistType`): stores multiple integer values. Not supported in workflows, business rules, charts, rollups, or calculated columns.

## Virtual/Formatted Fields - CRITICAL

Fields ending in `name` that look like lookup or choice display labels are often `VirtualType` -- computed, read-only fields that **cannot be selected in OData queries**. They cause errors like:
> "Could not find a property named 'prefix_fieldname' on type 'Microsoft.Dynamics.CRM.prefix_tablename'"

```typescript
// WRONG - invented/virtual display fields cannot be queried
select: ['prefix_status', '<invented status display field>']

// CORRECT - Only select actual fields, convert to labels in code
select: ['prefix_status']
// Then use getStatusLabel(record.prefix_status) for display
```

Check the generated model's `x-ms-dataverse-type`: if it's `VirtualType`, don't include in `select`.

## Formatted Values (Server-Side Formatting) - IMPORTANT

Instead of formatting dates, choice labels, and currency client-side, request **formatted values** from the server using the `Prefer` header:

```
Prefer: odata.include-annotations="OData.Community.Display.V1.FormattedValue"
```

Or request all annotations (includes lookup metadata too):
```
Prefer: odata.include-annotations="*"
```

See [Formatted values](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query/select-columns#formatted-values)

The response includes both raw and formatted values side-by-side:

```json
{
  "revenue": 20000.0000,
  "revenue@OData.Community.Display.V1.FormattedValue": "$20,000.00",
  "customertypecode": 1,
  "customertypecode@OData.Community.Display.V1.FormattedValue": "Competitor",
  "modifiedon": "2023-04-07T21:59:01Z",
  "modifiedon@OData.Community.Display.V1.FormattedValue": "4/7/2023 2:59 PM",
  "_primarycontactid_value": "70bf4d48-34cb-ed11-b596-0022481d68cd",
  "_primarycontactid_value@OData.Community.Display.V1.FormattedValue": "Susanna Stubberod (sample)"
}
```

**What gets formatted:**

| Column Type | Raw Value | Formatted Value |
|-------------|-----------|-----------------|
| Choice/Picklist | `1` | `"Competitor"` (localized label) |
| Yes/No | `true` | `"Yes"` (localized) |
| Status/Status Reason | `0` | `"Active"` (localized) |
| Date/Time | `2023-04-07T21:59:01Z` | `"4/7/2023 2:59 PM"` (user's timezone) |
| Currency | `20000.0000` | `"$20,000.00"` (with currency symbol) |
| Lookup | `<guid>` | `"Display Name"` (primary name value) |

**Lookup metadata annotations** (useful for polymorphic lookups like Owner, Customer):
- `_fieldname_value@Microsoft.Dynamics.CRM.lookuplogicalname` -- which table the record belongs to (e.g., `"systemuser"` or `"team"`)
- `_fieldname_value@Microsoft.Dynamics.CRM.associatednavigationproperty` -- navigation property name for `$expand`

**When to use formatted values vs client-side formatting:**
- Use **formatted values** when displaying data as-is (dates, labels, currency) -- respects user locale and timezone
- Use **client-side formatting** when you need custom display logic (e.g., relative dates, custom label mapping, conditional formatting)

## Lookup Fields - CRITICAL

Lookup columns represent many-to-one (N:1) relationships. The Web API exposes **three properties** per lookup:

| Property | Type | Usage |
|----------|------|-------|
| `fieldname` | Single-valued navigation property | For setting values via `fieldname@odata.bind` when this is the exact generated navigation property name |
| `_fieldname_value` | `Edm.Guid` lookup property (read-only, computed) | **Use this to read/filter by the related record's ID** |
| `_fieldname_value@OData.Community.Display.V1.FormattedValue` | Annotation string | Display name returned when formatted values are requested |

See [Lookup properties](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/web-api-properties?view=dataverse-latest#lookup-properties)

```typescript
// CORRECT - select the _value field and read its formatted-value annotation for display
const result = await CrInspectionreportService.getAll({
  select: ['cr_title', 'cr_date', '_cr_inspectorid_value'],
  // ⚠️ Do NOT add an invented lookup display-name field to select — it causes HTTP 400.
  // The SDK already requests Prefer: odata.include-annotations=*, so the formatted-value
  // annotation arrives paired with every selected `_<lookup>_value` field.
})

// Read the display name via the @/utils helper — never inline the raw annotation key.
import { lookupName } from '@/utils';
const inspector = lookupName(record, 'cr_inspectorid') ?? '—';  // → "Jane Smith"

// GUID — use for navigation or second queries
record._cr_inspectorid_value  // → "7da69e03-..."

// WRONG — Navigation property is an object, not a GUID
await SystemuserService.get(record.cr_inspectorid) // ❌ object, not string

// WRONG — invented display property. Do not read a separate *name shadow field.
// Always use the lookupName(record, '<lookupLogicalName>') helper.

// WRONG — virtual *name field in $select causes HTTP 400
const bad = await CrInspectionreportService.getAll({
  select: ['cr_title', '<invented lookup display field>'], // ❌ 400: property does not exist
})

// WRONG — inlining the raw annotation key is brittle and error-prone
const bad2 = record['_cr_inspectorid_value@OData.Community.Display.V1.FormattedValue']; // use lookupName() instead
```

### `$expand` is NOT supported

`IGetAllOptions` (the interface accepted by all generated `getAll` / `get` methods) has no `expand` field. Do not attempt to pass `$expand` — it will be silently ignored.

If you need **additional columns** from the related record beyond its primary name, call a second `Service.get()`:

```typescript
// Only in detail screens (one record shown) — never inside a list map()
const inspector = await SystemuserService.get(record._cr_inspectorid_value, {
  select: ['fullname', 'internalemailaddress', 'jobtitle'],
})
```

Common lookup fields: `_primarycontactid_value`, `_customerid_value`, `_ownerid_value`, `_parentaccountid_value`, `_transactioncurrencyid_value`

**Special lookup types:**
- **Customer**: references Account OR Contact
- **Owner**: references User OR Team (every user-owned table has one)

## Creating Lookup Columns (Metadata API) - CRITICAL

**This section is about *creating* a new lookup column at scaffolding time** (Step 5 of `/add-dataverse`). For *setting* a lookup value on a record at runtime, see "Setting Lookups (Creating/Updating Records)" below.

A lookup column is created by POSTing to `/RelationshipDefinitions` (NOT `/Attributes`) — the relationship is the source of truth, and Dataverse auto-creates the foreign-key column from it.

**Do not invent the body shape.** Use this exact skeleton; replace only `<bracketed>` placeholders:

```json
{
  "@odata.type": "Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
  "SchemaName": "<prefix>_<parent>_<child>",
  "ReferencedEntity": "<parent_table>",
  "ReferencedAttribute": "<parent_table_primary_key>",
  "ReferencingEntity": "<child_table>",
  "Lookup": {
    "SchemaName": "<prefix>_<parent>id",
    "DisplayName": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "Label": "<Parent display>", "LanguageCode": 1033 }] },
    "RequiredLevel": { "Value": "None" }
  },
  "AssociatedMenuConfiguration": { "Behavior": "UseCollectionName", "Group": "Details", "Order": 10000 },
  "CascadeConfiguration": { "Assign": "NoCascade", "Delete": "RemoveLink", "Merge": "NoCascade", "Reparent": "NoCascade", "Share": "NoCascade", "Unshare": "NoCascade" }
}
```

### Fields that must NOT appear in the body

| Field | Why it breaks | Error you'll see |
|---|---|---|
| `ReferencingAttribute` | Dataverse creates the FK column itself from `Lookup.SchemaName` — at POST time the column doesn't exist yet. | `404: Could not find an attribute with specified name <prefix>_<parent>id` |
| `Lookup.LogicalName` | Read-only metadata, server-assigned. | `400 Bad Request: An undeclared property 'LogicalName' was found.` |
| `Lookup.AttributeOf` | Read-only, server-computed. | `400 Bad Request` |
| Top-level `LogicalName` / `MetadataId` | Read-only on POST. | `400 Bad Request` |

### Pre-flight ordering

The lookup POST will 404 unless **both** endpoint tables already exist. Ensure:

1. The parent (`ReferencedEntity`) is in a lower or equal tier and has returned 2xx from its own POST.
2. The child (`ReferencingEntity`) is fully created (its EntityDefinition POST returned 2xx).
3. You waited for both 2xx responses — Dataverse serializes metadata writes; firing the relationship POST while a parent POST is still in flight returns `MetadataLockHeldException`.

### Naming conventions

- `SchemaName` (the relationship): `<prefix>_<parent>_<child>` — singular, lowercase.
- `Lookup.SchemaName` (the auto-created FK column): `<prefix>_<parent>id` — singular `id` suffix, no underscore before `id`.
- The runtime read property will be `_<prefix>_<parent>id_value` (script auto-prepends `_` and appends `_value`).

### Cascade behaviors

`CascadeConfiguration` defaults shown above are conservative (`RemoveLink` on delete = orphan the child). For required parent-child relationships where deleting the parent should delete children, set `"Delete": "Cascade"`. Other valid values: `NoCascade`, `Cascade`, `Active`, `UserOwned`, `RemoveLink`, `Restrict`. See [Cascade behaviors](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/configure-cascading-behavior) for what each does.

## Setting Lookups (Creating/Updating Records)

Lookup properties (`_fieldname_value`) are **read-only**. To set a relationship, use the **single-valued navigation property** with `@odata.bind`:

```typescript
// CORRECT - Use @odata.bind for lookup fields
const newRecord: any = {
  'prefix_name': 'My Record',
  'prefix_ParentAccount@odata.bind': `/accounts(${accountGuid})`,
  'prefix_status': 100000000
};

// WRONG - _value properties are read-only, cannot be set
{ '_prefix_parentaccountid_value': accountGuid }  // May fail on create
```

The `@odata.bind` value must be an entity set path with the GUID: `/<entitysetname>(<guid>)`

## Alternate Keys (Metadata API) - CRITICAL

Use alternate keys for unique business identifiers such as QR Code Value, SKU, asset tag, external ID, or employee number. Create them only after the table and target columns exist.

**Use the table `Keys` navigation collection. Do not use `CreateEntityKey`.** The reliable route is:

```bash
node "${PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> POST \
  "EntityDefinitions(LogicalName='<table>')/Keys" \
  --body '<entity-key-json>' \
  --solution '<solution-uniquename>'
```

Body shape:

```json
{
  "@odata.type": "Microsoft.Dynamics.CRM.EntityKeyMetadata",
  "SchemaName": "cr123_item_code_key",
  "DisplayName": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "Label": "Item Code Key", "LanguageCode": 1033 }] },
  "KeyAttributes": ["cr123_code"]
}
```

Pre-flight and re-run check:

```bash
node "${PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> GET \
  "EntityDefinitions(LogicalName='<table>')?\$select=LogicalName&\$expand=Keys(\$select=SchemaName,KeyAttributes,EntityKeyIndexStatus)"
```

- If a key with the same `SchemaName` or same `KeyAttributes` is `Active` or `Pending`, skip creation.
- If it is `Failed`, stop and surface the Dataverse key status.
- POST success is commonly `204 No Content`; re-query `Keys` to capture `EntityKeyIndexStatus`.
- `Pending` means the index is still activating. Continue scaffolding, but do not rely on duplicate enforcement until the status is `Active`.

Dataverse alternate keys cannot use every column type. Avoid file/image, memo/long text, multi-select choice, calculated/rollup, and polymorphic owner/customer columns.

## File and Image Columns

Dataverse supports two special column types for binary content:

| Type  | Dataverse Column Type | Max Size              | Notes                                               |
|-------|-----------------------|-----------------------|-----------------------------------------------------|
| File  | `FileType`            | 131 MB (configurable) | Any file type                                       |
| Image | `ImageType`           | 30 MB                 | Converted to JPEG; supports full-size and thumbnail |

The generated model exports type-safe union types for the file and image columns on the table. Use these types for all `columnName` arguments — never pass an arbitrary string:

```typescript
// Example from a table with two file columns and two image columns:
type AccountsFileColumnName  = 'cr3d5_filecol' | 'cr3d5_filecol2';
type AccountsImageColumnName = 'cr3d5_imagecol' | 'entityimage';
type AccountsUploadColumnName = AccountsFileColumnName | AccountsImageColumnName;
```

The generated service exposes four methods for file/image operations.

### `upload(id, columnName, file, fileDisplayName?)`

Uploads a file or image to a record column. Accepts a standard browser `File` object directly.

- `columnName` — must be `UploadColumnName` (works for both file and image columns)
- `fileDisplayName` — optional friendly name shown in Dataverse; defaults to `file.name`
- Returns a result object with `success`, `data`, and `error` fields; for uploads, `data` is empty

```tsx
const [uploading, setUploading] = useState(false);

const handleUpload = async () => {
  setUploading(true);
  const result = await AccountsService.upload(recordId, columnName, selectedFile, displayName);
  setUploading(false);
  if (result.error) {
    showToast('Upload failed: ' + result.error.message, 'error');
  } else {
    showToast('File uploaded successfully', 'success');
    onUploadSuccess?.();  // refresh parent list
  }
};

<button onClick={handleUpload} disabled={uploading}>
  {uploading ? 'Uploading...' : 'Upload'}
</button>
```

### `downloadFile(id, columnName)`

Downloads a file column. The file bytes are returned in `result.data`.

- `columnName` — must be `FileColumnName` (file columns only, not image)
- Returns `IOperationResult<Uint8Array>` — use `result.data` for the raw bytes and `result.fileName` for the original filename

### `downloadImage(id, columnName, fullSize?)`

Downloads an image column and returns the raw bytes. Pass `fullSize: true` for the original resolution; defaults to thumbnail.

- `columnName` — must be `ImageColumnName` (image columns only, not file)
- `fullSize` — optional boolean, default `false` (thumbnail)
- Returns `IOperationResult<Uint8Array>`

### `deleteFileOrImage(id, columnName)`

Deletes the file or image stored in a column. Works for both file and image columns.

- `columnName` — must be `UploadColumnName`
- Returns `IOperationResult<void>`

```tsx
const result = await AccountsService.deleteFileOrImage(recordId, columnName);
if (!result.error) {
  onUploadSuccess?.();  // refresh parent list
}
```

### Common Patterns

- **Disable during operation**: Set a loading flag and disable upload/delete buttons while the call is in flight to prevent double-submits.
- **Toast feedback**: Show success/error after upload and delete. Auto-dismiss after ~5 seconds.
- **Refresh after mutation**: Call a refresh callback after upload or delete so the UI reflects the latest state.

## TypeScript useState with Choice Values - CRITICAL

When using `useState` with enum constants, TypeScript infers literal types. Explicitly type as `number`:

```typescript
// WRONG - TypeScript infers status as literal type 0
const [formData, setFormData] = useState({
  status: Status.Active,  // type inferred as literal 0
});
setFormData({ ...formData, status: Number(value) }); // Error: number not assignable to 0

// CORRECT - Explicitly type choice fields as number
const [formData, setFormData] = useState<{
  name: string;
  status: number;
}>({
  name: '',
  status: Status.Active,  // now typed as number
});
```

## Common Dataverse API Errors

| Error | Cause |
|-------|-------|
| "Cannot convert literal 'X' to Edm.Int32" | Choice field expects numeric value, not string. Use integer values, not labels. |
| "Could not find property 'X' on type" | Field doesn't exist or is VirtualType. Don't select `*name` virtual fields. |
| "Invalid property 'X' was found" | Property doesn't exist on entity. Verify field exists in Dataverse. |
| TypeScript "no overlap" error | Comparing number field to string. Choice fields are numbers. |
| TypeScript "not assignable to type 0" | useState inferred literal type from constant. Explicitly type state with `number`. |

## Interpreting `dataverse-request.js` responses

All Dataverse Web API calls during scaffolding go through [`scripts/dataverse-request.js`](../../../scripts/dataverse-request.js), which wraps fetch + auth + retry. It returns JSON: `{ "status": <httpCode>, "data": <responseBody> }`. Token refresh on 401 and back-off on 429 / 5xx are automatic — never write manual retry logic on top.

### HTTP status → action

| Status | Meaning | What the agent should do |
|--------|---------|--------------------------|
| **200 / 201 / 204** | Success | Proceed. `204` = no body returned (typical for PATCH/DELETE). |
| **400** | Bad request — malformed JSON, invalid field/value, wrong type | Read `data.error.message`, fix the request body, retry. Often a Choice value sent as string, missing `@odata.bind`, or a virtual field in `$select`. |
| **401** | Unauthorized | Should not surface — script auto-refreshes the token. If you see it after retry, run `scripts/verify-dataverse-access.js <envUrl>` and ask the user to re-auth with `az login --tenant <env-tenant>`. |
| **403** | Forbidden — insufficient privileges | Report to user verbatim: which table + which operation. They need a security-role change in the Power Platform admin center. Do NOT retry. |
| **404** | Not found — entity set, table, column, or record GUID does not exist | Verify the URL path. Common cause: using `cr123_project` (logical name) instead of `cr123_projects` (entity set name). Re-publish customizations if a freshly created table 404s. |
| **409** | Conflict — record / metadata already exists | For metadata POSTs (create table/column/relationship) the script already maps the matching `0x...` codes to "treat as success." For data POSTs (create record with duplicate-detection key) report to user — do not blindly retry. |
| **412** | Pre-condition failed — `If-Match` ETag mismatch (optimistic concurrency) | Re-fetch the record, merge the user's edit, retry once. |
| **429** | Throttled | Should not surface — script back-offs and retries. If still 429 after retries, surface to user; they're likely hitting tenant capacity limits. |
| **500 / 502 / 503** | Server error | Script retries once. If still failing, surface verbatim — Dataverse incident or malformed request that crashes the server. Do NOT loop. |

### Error-code map (`data.error.code`)

Dataverse returns hex error codes alongside messages. The most common ones the agent will encounter during table/column/relationship creation:

| Code | Meaning | Action |
|------|---------|--------|
| `0x80048408` | Privilege check failed | Tell user which privilege is missing on which table. Surface and stop — do not retry. |
| `0x80060888` | Entity (table) already exists | Already handled by script → treated as 409 success. Skip the create. |
| `0x80044153` | Attribute (column) already exists | Skip the create. If schema differs, the user must delete + recreate manually (Dataverse does not allow column-type changes via API). |
| `0x8004431A` | Relationship already exists | Skip the create. |
| `0x80040237` | Duplicate-key collision on a record with a duplicate-detection rule | Report the conflicting key value to the user; do not silently skip data. |
| `0x80040217` | Record not found (often a referenced lookup target) | Verify the GUID in the `@odata.bind` value exists. |
| `0x8004F510` | "Resource not found for the segment" | Wrong entity set name in URL. Use the *plural* logical collection name (`cr123_projects`, not `cr123_project`). |

For any error code not in this table, the message in `data.error.message` is usually self-explanatory — read it before guessing. If you need authoritative docs for an unfamiliar code or a new behavior, query the `microsoft-learn` MCP server (see [`shared/shared-instructions.md`](../../../shared/shared-instructions.md#microsoft-learn-mcp-authoritative-microsoft-docs)).

## Column Type Quick Reference

| Need | Type | API Type | Notes |
|------|------|----------|-------|
| Short text | Text | `StringType` | Max 4,000 chars |
| Long text | Multiline Text | `MemoType` | Max 1,048,576 chars |
| Email | Email | `StringType` | Email format validation |
| URL | URL | `StringType` | URL format validation |
| Whole number | Whole Number | `IntegerType` | No decimals |
| Exact decimal | Decimal Number | `DecimalType` | Use for financial data |
| Approximate decimal | Float | `DoubleType` | Use for scientific data |
| Money | Currency | `MoneyType` | Auto-creates exchange rate + base currency columns |
| Yes/No | Two Options | `BooleanType` | Boolean |
| Date + time | Date and Time | `DateTimeType` | Full datetime |
| Date only | Date Only | `DateTimeType` | Date without time component |
| Single select | Choice | `PicklistType` | Stored as integer |
| Multi select | Choices | `MultiSelectPicklistType` | Limited support in workflows/rules |
| Related record | Lookup | `LookupType` | N:1 relationship |
| File attachment | File | `FileType` | Max 131 MB configurable |
| Image | Image | `ImageType` | Max 30 MB, converted to jpg |
