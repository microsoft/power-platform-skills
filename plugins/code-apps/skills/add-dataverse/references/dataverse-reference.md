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

Fields ending in `name` (e.g., `prefix_statusname`, `prefix_categoryname`) are often `VirtualType` -- computed, read-only fields that **cannot be selected in OData queries**. They cause errors like:
> "Could not find a property named 'prefix_fieldname' on type 'Microsoft.Dynamics.CRM.prefix_tablename'"

```typescript
// WRONG - Virtual fields cannot be queried
select: ['prefix_status', 'prefix_statusname']  // statusname will fail

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
| `fieldname` | Object (navigation property) | For setting values via `@odata.bind` |
| `_fieldname_value` | `Edm.Guid` (read-only, computed) | **Use this to read the related record's ID** |
| `fieldnamename` | String (formatted value) | Display name only (read-only) |

See [Lookup properties](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/web-api-properties?view=dataverse-latest#lookup-properties)

```typescript
// CORRECT - Read the related record's GUID via _value property
const result = await AccountsService.getAll({
  select: ['name', '_primarycontactid_value', 'primarycontactidname']
});
for (const account of result.data || []) {
  if (account._primarycontactid_value) {
    const contact = await ContactsService.get(account._primarycontactid_value);
  }
}

// WRONG - Navigation property is an object, not a GUID
await ContactsService.get(account.primarycontactid); // object, not string

// Display name only (no extra query needed)
<p>Contact: {account.primarycontactidname}</p>
```

Common lookup fields: `_primarycontactid_value`, `_customerid_value`, `_ownerid_value`, `_parentaccountid_value`, `_transactioncurrencyid_value`

**Special lookup types:**
- **Customer**: references Account OR Contact
- **Owner**: references User OR Team (every user-owned table has one)

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
