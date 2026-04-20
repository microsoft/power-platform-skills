# Web API Service Patterns

This reference contains the code-generation patterns for entity types (Step 4), service layer (Step 5), and framework hooks (Step 6). All examples use the `Product` table as reference — replace table names, columns, entity set, and prefix with the actual target table.

---

## Entity Types (Step 4)

### OData Entity Interface

Define an interface matching the raw Dataverse column schema:

```typescript
// Raw OData entity — matches Dataverse column logical names exactly
export interface ProductEntity {
  cr4fc_productid: string;
  cr4fc_name?: string;
  cr4fc_description?: string;
  cr4fc_price?: number;
  cr4fc_status?: number;
  cr4fc_imageurl?: string;
  // Lookup raw values use _<navigation>_value pattern
  _cr4fc_category_value?: string;
  // Expanded navigation properties
  cr4fc_Category?: { cr4fc_categoryid: string; cr4fc_name?: string };
  createdon?: string;
  modifiedon?: string;
  // Index signature for OData formatted value annotations
  [key: string]: unknown;
}
```

**Naming rules:**
- Interface: PascalCase table name + `Entity` suffix
- Properties: exact Dataverse logical names (all lowercase with publisher prefix)
- Lookup raw values: `_<navigation_property>_value`
- Expanded lookups: PascalCase navigation property with nested object type
- Always include `[key: string]: unknown` for formatted value annotation access

### Domain Type

Define a clean application type that the UI consumes:

```typescript
// Clean domain type for UI consumption
export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  status: 'active' | 'inactive' | 'archived';
  imageUrl: string;
  category: string;
  categoryId?: string;
  createdAt: string;
  updatedAt: string;
}
```

### Option Set Constants

If the table has choice/optionset columns, define typed constants:

```typescript
export const PRODUCT_STATUS = {
  active: 100000000,
  inactive: 100000001,
  archived: 100000002,
} as const;

export type ProductStatusKey = keyof typeof PRODUCT_STATUS;

const STATUS_LABELS = Object.fromEntries(
  Object.entries(PRODUCT_STATUS).map(([key, val]) => [val, key])
) as Record<number, ProductStatusKey>;
```

### Input Types

Define create/update input types that represent what the caller provides:

```typescript
export interface CreateProductInput {
  name: string;
  description?: string;
  price: number;
  status?: ProductStatusKey;
  imageUrl?: string;
  categoryId?: string;
}

export interface UpdateProductInput {
  name?: string;
  description?: string;
  price?: number;
  status?: ProductStatusKey;
  imageUrl?: string;
  categoryId?: string;
}
```

### Entity-to-Domain Mapper

Create a mapping function that converts the raw OData entity to the clean domain type:

```typescript
import { getFormattedValue } from '../shared/powerPagesApi';

export const mapProductEntity = (entity: ProductEntity): Product => ({
  id: entity.cr4fc_productid,
  name: entity.cr4fc_name ?? '',
  description: entity.cr4fc_description ?? '',
  price: entity.cr4fc_price ?? 0,
  status: STATUS_LABELS[entity.cr4fc_status ?? 0] ?? 'active',
  imageUrl: entity.cr4fc_imageurl ?? '',
  category: getFormattedValue(entity, '_cr4fc_category_value') ?? 'Uncategorized',
  categoryId: entity._cr4fc_category_value,
  createdAt: entity.createdon ?? new Date().toISOString(),
  updatedAt: entity.modifiedon ?? entity.createdon ?? new Date().toISOString(),
});
```

Use `getFormattedValue()` for lookup display names and option set labels — these come from the `Prefer: odata.include-annotations` header.

### Lookup Property Rules

Lookups in Dataverse expose **two distinct properties**. Understanding the difference is critical:

**On retrieval (GET):**
- **GUID property** — Automatically named `_{logicalname}_value`. Contains the raw lookup ID. Use for filtering, logic, and foreign-key references. Include in `$select`.
- **Navigation property** — Named after the relationship (e.g., `cr4fc_Category`). Use with `$expand` to fetch related record details. **Case-sensitive** — must match the schema name exactly (typically PascalCase).

```typescript
// $select includes the GUID property for the raw ID
'$select': '_{prefix}_categoryid_value,{prefix}_name'
// $expand uses the Navigation Property to get related data
'$expand': '{prefix}_Category($select={prefix}_categoryid,{prefix}_name)'
// $filter uses the GUID property
'$filter': `_{prefix}_categoryid_value eq ${categoryId}`
```

**On create/update (POST/PATCH):**
- You **cannot** set a lookup by sending a GUID to the `_value` property. You **must** use `@odata.bind` on the **Navigation Property**.
- Syntax: `"NavigationProperty@odata.bind": "/entity_set_name(GUID)"`

```typescript
// CORRECT — uses Navigation Property name (case-sensitive)
body['cr4fc_Category@odata.bind'] = `/cr4fc_categories(${categoryId})`;

// WRONG — using the GUID property name causes "Undeclared Property" error
body['_cr4fc_categoryid_value'] = categoryId; // ❌ Does NOT work
```

**Common error:** If you get an "Undeclared Property" error on POST/PATCH, you are likely using the logical name (all lowercase) instead of the **Navigation Property name** (case-sensitive, matches the schema name).

**To clear a lookup**, set the `@odata.bind` annotation to `null`:

```typescript
body['cr4fc_Category@odata.bind'] = null; // unbinds the relationship
```

---

## Service Layer (Step 5)

Create a service module with CRUD operations for the target table. Place it following project conventions. Default: `src/shared/services/<tableName>Service.ts`.

### Pagination Strategy

**Every list/query operation MUST be paginated.** Never fetch unbounded data. Two pagination approaches exist — choose based on the use case:

**Cursor-based pagination (`Prefer: odata.maxpagesize=N` + `@odata.nextLink`)** — Use for UI list views with paging controls. The `list` function below uses this approach. Always include `$count=true` to get the total record count efficiently without fetching all rows. **Note:** Power Pages does **not** support the `$skip` query option (returns error `9004010B: QueryParamNotSupported`). Use `@odata.nextLink` cursors (which contain `$skiptoken`) from each response to fetch the next page.

**Client-side pagination (`fetchAllPages`)** — Use only when you genuinely need every record (e.g., populating a local dropdown, building a lookup map, exporting data). Uses the `fetchAllPages` helper from the core API client which follows `@odata.nextLink` with a safety iteration limit.

**Always use `Prefer: odata.maxpagesize=N` for pagination.** This request header controls the page size and ensures `@odata.nextLink` is returned for subsequent pages. Do NOT use `$top` for page-by-page navigation — `$top` caps the total result set and prevents `@odata.nextLink` from being returned. If you include both `$top` and `Prefer: odata.maxpagesize`, `$top` is ignored. Use `$top` only as a safety cap when you genuinely want to limit total results (e.g., `$top=5` for "top 5 recent items" on a dashboard widget, or `$top=0` for count-only queries).

### Select Columns

Always specify exact columns in `$select`. Never use `*`. Only include columns the site actually needs:

```typescript
const PRODUCT_SELECT = [
  'cr4fc_productid',
  'cr4fc_name',
  'cr4fc_description',
  'cr4fc_price',
  'cr4fc_status',
  'cr4fc_imageurl',
  '_cr4fc_category_value', // Lookup GUID — use for filtering/logic
  'createdon',
  'modifiedon',
].join(',');

// Expand uses the Navigation Property (case-sensitive) to fetch related record
const PRODUCT_EXPAND = 'cr4fc_Category($select=cr4fc_categoryid,cr4fc_name)';
```

### List (with pagination and filtering)

```typescript
import {
  powerPagesFetch,
  buildODataUrl,
  escapeODataString,
  type ODataCollectionResponse,
  type PaginatedResult,
} from '../shared/powerPagesApi';

export interface ListParams {
  pageSize?: number;
  nextLink?: string;  // @odata.nextLink cursor from a previous response
  filter?: string;
  orderBy?: string;
  search?: string;
}

export const listProducts = async (params?: ListParams): Promise<PaginatedResult<Product>> => {
  const pageSize = params?.pageSize ?? 10;

  // If we have a nextLink from a previous response, use it directly.
  // Power Pages does NOT support $skip — pagination uses @odata.nextLink cursors.
  // Use Prefer: odata.maxpagesize to control page size (NOT $top).
  // $top caps the total result set and prevents @odata.nextLink from being returned.
  const url = params?.nextLink ?? buildODataUrl('cr4fc_products', {
    '$select': PRODUCT_SELECT,
    '$expand': PRODUCT_EXPAND,
    '$orderby': params?.orderBy ?? 'createdon desc',
    '$count': 'true',
    '$filter': params?.filter,
  });

  const response = await powerPagesFetch<ODataCollectionResponse<ProductEntity>>(url, {
    headers: {
      'Prefer': `odata.include-annotations="OData.Community.Display.V1.FormattedValue",odata.maxpagesize=${pageSize}`,
    },
  });

  return {
    items: (response?.value ?? []).map(mapProductEntity),
    totalCount: response?.['@odata.count'] ?? response?.value?.length ?? 0,
    nextLink: response?.['@odata.nextLink'],
  };
};
```

### Get by ID

```typescript
export const getProductById = async (id: string): Promise<Product | null> => {
  const url = buildODataUrl(`cr4fc_products(${id})`, {
    '$select': PRODUCT_SELECT,
    '$expand': PRODUCT_EXPAND,
  });

  try {
    const entity = await powerPagesFetch<ProductEntity>(url);
    return entity ? mapProductEntity(entity) : null;
  } catch {
    return null;
  }
};
```

### Create (POST)

Send `Prefer: return=representation` to request the created entity in the response body. However, the API may return just a success status (e.g., 204) without a body — in that case, extract the created record ID from the `Location` response header and fetch the record:

```typescript
import {
  powerPagesFetchResponse,
  parseResponseBody,
  extractRecordId,
} from '../shared/powerPagesApi';

export const createProduct = async (payload: CreateProductInput): Promise<Product> => {
  const body: Record<string, unknown> = {
    cr4fc_name: payload.name,
    cr4fc_description: payload.description ?? '',
    cr4fc_price: payload.price,
    cr4fc_status: PRODUCT_STATUS[payload.status ?? 'active'],
    cr4fc_imageurl: payload.imageUrl ?? '',
  };

  // Bind lookups using @odata.bind
  if (payload.categoryId) {
    body['cr4fc_Category@odata.bind'] = `/cr4fc_categories(${payload.categoryId})`;
  }

  // Use powerPagesFetchResponse to access headers — the API may return the
  // created entity in the body or just a success status with a Location header
  const response = await powerPagesFetchResponse('/_api/cr4fc_products', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });

  // Try to parse the entity from the response body
  const entity = await parseResponseBody<ProductEntity>(response);
  if (entity) return mapProductEntity(entity);

  // No body — extract the ID from the Location header and fetch the record
  const createdId = extractRecordId(response);
  if (createdId) {
    const created = await getProductById(createdId);
    if (created) return created;
  }

  throw new Error('Failed to retrieve created record — no response body or Location header');
};
```

### Update (PATCH)

Use `If-Match: *` header. Only include fields that are being updated. Refetch after PATCH since it returns no body:

```typescript
export const updateProduct = async (id: string, payload: UpdateProductInput): Promise<Product> => {
  const body: Record<string, unknown> = {};

  if (payload.name !== undefined) body.cr4fc_name = payload.name;
  if (payload.description !== undefined) body.cr4fc_description = payload.description;
  if (payload.price !== undefined) body.cr4fc_price = payload.price;
  if (payload.status !== undefined) body.cr4fc_status = PRODUCT_STATUS[payload.status];
  if (payload.imageUrl !== undefined) body.cr4fc_imageurl = payload.imageUrl;

  // Handle lookup bind/unbind
  if (payload.categoryId !== undefined) {
    if (payload.categoryId) {
      body['cr4fc_Category@odata.bind'] = `/cr4fc_categories(${payload.categoryId})`;
    } else {
      body['cr4fc_Category@odata.bind'] = null; // unbind
    }
  }

  await powerPagesFetch(`/_api/cr4fc_products(${id})`, {
    method: 'PATCH',
    headers: { 'If-Match': '*' },
    body: JSON.stringify(body),
  });

  const updated = await getProductById(id);
  if (!updated) throw new Error('Failed to fetch updated record');
  return updated;
};
```

### Delete (DELETE)

```typescript
export const deleteProduct = async (id: string): Promise<void> => {
  await powerPagesFetch(`/_api/cr4fc_products(${id})`, {
    method: 'DELETE',
  });
};
```

### Many-to-Many Relationship Sync

If the table has M:N relationships via a junction table (e.g., blog posts ↔ tags), implement a sync function that diffs current vs desired associations:

```typescript
export const syncProductTags = async (productId: string, tagIds: string[]): Promise<void> => {
  // 1. Fetch existing junction records
  const existing = await powerPagesFetch<ODataCollectionResponse<{
    cr4fc_product_tagid: string;
    _cr4fc_tag_value: string;
  }>>(
    buildODataUrl('cr4fc_product_tags', {
      '$select': 'cr4fc_product_tagid,_cr4fc_tag_value',
      '$filter': `_cr4fc_product_value eq ${productId}`,
    })
  );
  const existingTagIds = new Set(existing?.value.map(l => l._cr4fc_tag_value) ?? []);
  const targetTagIds = new Set(tagIds);

  // 2. Add new associations
  for (const tagId of targetTagIds) {
    if (!existingTagIds.has(tagId)) {
      await powerPagesFetch('/_api/cr4fc_product_tags', {
        method: 'POST',
        body: JSON.stringify({
          'cr4fc_product@odata.bind': `/cr4fc_products(${productId})`,
          'cr4fc_tag@odata.bind': `/cr4fc_tags(${tagId})`,
        }),
      });
    }
  }

  // 3. Remove obsolete associations
  for (const link of existing?.value ?? []) {
    if (!targetTagIds.has(link._cr4fc_tag_value)) {
      await powerPagesFetch(`/_api/cr4fc_product_tags(${link.cr4fc_product_tagid})`, {
        method: 'DELETE',
      });
    }
  }
};
```

Only create this function if the target table actually has M:N relationships.

### Count Helper

Use `$count=true` with a minimal `$select` for efficient record counting:

```typescript
export const getProductCount = async (filter?: string): Promise<number> => {
  const url = buildODataUrl('cr4fc_products', {
    '$select': 'cr4fc_productid',
    '$filter': filter,
    '$count': 'true',
    '$top': '0', // Don't fetch records, just the count
  });

  const response = await powerPagesFetch<ODataCollectionResponse<ProductEntity>>(url);
  return response?.['@odata.count'] ?? 0;
};
```

### Aggregation Queries (`$apply`)

If the site needs aggregate data (totals, averages, grouped counts), use the OData `$apply` query option. Power Pages Web API supports `$apply` with `groupby`, `aggregate`, and `filter` transformations.

**Count by group:**

```typescript
export const getProductCountByStatus = async (): Promise<Array<{ status: number; statusLabel: string; count: number }>> => {
  const url = buildODataUrl('cr4fc_products', {
    '$apply': 'groupby((cr4fc_status),aggregate($count as count))',
  });

  const response = await powerPagesFetch<ODataCollectionResponse<Record<string, unknown>>>(url);
  return (response?.value ?? []).map(row => ({
    status: row['cr4fc_status'] as number,
    statusLabel: getFormattedValue(row, 'cr4fc_status') ?? String(row['cr4fc_status']),
    count: row['count'] as number,
  }));
};
```

**Sum/average:**

```typescript
export const getProductPriceStats = async (): Promise<{ total: number; avg: number }> => {
  const url = buildODataUrl('cr4fc_products', {
    '$apply': 'aggregate(cr4fc_price with sum as total,cr4fc_price with average as avg)',
  });

  const response = await powerPagesFetch<ODataCollectionResponse<Record<string, unknown>>>(url);
  const row = response?.value?.[0];
  return { total: (row?.['total'] as number) ?? 0, avg: (row?.['avg'] as number) ?? 0 };
};
```

Only create aggregation helpers if the site's UI actually needs them (dashboards, summary cards, charts).

### File & Image Column Operations

If the target table has **File** or **Image** columns, add download, upload, and delete methods to the service. These use the `fetchFileColumnUrl` and `uploadFileColumn` helpers from the core API client.

**Download** — returns an object URL for the blob, or `null` if no file exists (404):

```typescript
import { fetchFileColumnUrl, uploadFileColumn } from '../shared/powerPagesApi';

export const downloadProductPhoto = async (id: string): Promise<string | null> => {
  return fetchFileColumnUrl('cr4fc_products', id, 'cr4fc_photo');
};
```

**Upload** — sends raw binary via PATCH. Body is `ArrayBuffer`, not JSON:

```typescript
export const uploadProductPhoto = async (
  id: string,
  file: Blob,
  fileName?: string
): Promise<void> => {
  await uploadFileColumn('cr4fc_products', id, 'cr4fc_photo', file, fileName);
};
```

**Delete** — removes the file from the column without deleting the record:

```typescript
export const deleteProductPhoto = async (id: string): Promise<void> => {
  await powerPagesFetch(`/_api/cr4fc_products(${id})/cr4fc_photo`, {
    method: 'DELETE',
    headers: { 'If-Match': '*' },
  });
};
```

Only create these methods if the target table actually has File or Image columns (check the data model manifest for column types `File` or `Image`).

**Common pitfalls with file columns:**

| Mistake | Symptom | Fix |
|---------|---------|-----|
| Using `/$value` on upload URL | `405 Method Not Allowed` | Upload to `/_api/table(id)/column` (no `/$value`) |
| Sending JSON body for upload | `400 Bad Request` | Send `ArrayBuffer` via `file.arrayBuffer()` |
| Missing `If-Match: *` on upload | `412 Precondition Failed` | Add `If-Match: *` header |
| Using `$select` on `/$value` URL | `400 Bad Request` | OData query options are not supported on `/$value` |
| Missing `x-ms-file-name` header | File saved without name/extension | Include `x-ms-file-name` header with filename |
| Using `Accept: application/json` for download | Empty or error response | Use `Accept: */*` for blob downloads |
| Using file MIME type as upload `Content-Type` (e.g. `image/png`) | `400 "Stream was not readable"` — OData routes to JSON deserializer instead of binary handler | Always use `Content-Type: application/octet-stream` for uploads |
| Missing `Content-Type: application/octet-stream` on download | `404` — OData pipeline can't route to binary file handler | Add `Content-Type: application/octet-stream` to download headers |
| Explicit column list in `Webapi/<table>/fields` with file columns | `403 "Attribute * not enabled for Web Api"` on `/$value` download — the endpoint internally does `SELECT *` | Set field allowlist to `*` when the table has File or Image columns |

---

## Related Entities ($expand)

Use `$expand` to join related tables in a single API call instead of making separate requests. Power Pages Web API supports expanding both single-valued (lookup/many-to-one) and collection-valued (one-to-many) navigation properties.

### Rules and Limitations

| Rule | Detail |
|------|--------|
| Max expand count | Up to **15** `$expand` options per query |
| Single-valued expand | Supports `$select` and nested `$expand` (multi-level lookup traversal) |
| Collection-valued expand | Supports `$select`, `$filter`, `$orderby`, `$top` |
| Nested `$expand` paging impact | When **any** nested `$expand` exists in the query, `Prefer: odata.maxpagesize` applies to **all** expanded collections (not just the root entity set). `$orderby` and `$top` are **NOT** supported on collection-valued expansions in this case. |
| N:N relationships | **Cannot** be nested-expanded. Use FetchXml for nested N:N joins. |
| `$skip` | **Not supported** — use `@odata.nextLink` cursors |
| Cached responses | Expanded collection-valued properties may return cached data. Use `If-None-Match: null` header to bypass browser caching. |

### Expand Types

**Single-valued (lookup / many-to-one):**
```typescript
// Expand a lookup to get related record details
'$expand': 'cr4fc_Category($select=cr4fc_categoryid,cr4fc_name)'
```

**Collection-valued (one-to-many):**
```typescript
// Expand a one-to-many relationship with filter and ordering
'$expand': 'cr4fc_order_lines($select=cr4fc_quantity,cr4fc_unitprice;$filter=cr4fc_quantity gt 0;$orderby=cr4fc_unitprice desc;$top=10)'
```

**Multiple expands (mix of single + collection):**
```typescript
'$expand': 'cr4fc_Category($select=cr4fc_categoryid,cr4fc_name),cr4fc_order_lines($select=cr4fc_quantity;$top=5)'
```

### Nested Expand of Single-Valued Navigation Properties

Chain single-valued (lookup) navigation properties to traverse multiple levels in one request. Use semicolons to separate options within each level's parentheses:

```typescript
// Traverse: Order → Contact (lookup) → Account (lookup) → CreatedBy (lookup)
const EXPAND_WITH_NESTED = buildExpandClause([{
  property: 'cr4fc_CustomerContact',
  select: ['fullname', 'emailaddress1'],
  expand: [{
    property: 'parentcustomerid_account',
    select: ['name', 'telephone1'],
    expand: [{
      property: 'createdby',
      select: ['fullname'],
    }],
  }],
}]);

// Produces: "cr4fc_CustomerContact($select=fullname,emailaddress1;$expand=parentcustomerid_account($select=name,telephone1;$expand=createdby($select=fullname)))"
```

The response returns nested objects:

```json
{
  "cr4fc_orderid": "...",
  "cr4fc_ordernumber": "ORD-001",
  "cr4fc_CustomerContact": {
    "fullname": "Jane Smith",
    "emailaddress1": "jane@example.com",
    "contactid": "...",
    "parentcustomerid_account": {
      "name": "Contoso Ltd",
      "telephone1": "555-0100",
      "accountid": "...",
      "createdby": {
        "fullname": "System Administrator",
        "systemuserid": "..."
      }
    }
  }
}
```

### Collection-Valued Navigation Property Expand

Expand one-to-many relationships to retrieve child records inline. Always include `$top` or `$filter` to limit the response size — without limits, up to 5,000 related records can be returned per collection.

```typescript
import { buildExpandClause, type ExpandOption } from '../shared/powerPagesApi';

// Expand order lines (one-to-many) with filter and limit
const ORDER_EXPAND: ExpandOption[] = [
  {
    property: 'cr4fc_Category',
    select: ['cr4fc_categoryid', 'cr4fc_name'],
  },
  {
    property: 'cr4fc_order_lines',
    select: ['cr4fc_orderlineid', 'cr4fc_productname', 'cr4fc_quantity', 'cr4fc_unitprice'],
    filter: 'statecode eq 0',
    orderBy: 'cr4fc_quantity desc',
    top: 50,
  },
];

const ORDER_EXPAND_CLAUSE = buildExpandClause(ORDER_EXPAND);
```

### Entity Types for Related Entities

When a table has expanded relationships, define nested interfaces in the OData entity type:

```typescript
// Related entity interfaces
export interface OrderLineEntity {
  cr4fc_orderlineid: string;
  cr4fc_productname?: string;
  cr4fc_quantity?: number;
  cr4fc_unitprice?: number;
  [key: string]: unknown;
}

export interface CategoryEntity {
  cr4fc_categoryid: string;
  cr4fc_name?: string;
  [key: string]: unknown;
}

// Parent entity with expanded navigation properties
export interface OrderEntity {
  cr4fc_orderid: string;
  cr4fc_ordernumber?: string;
  cr4fc_totalamount?: number;
  _cr4fc_category_value?: string;
  // Single-valued navigation property (lookup — returns object or null)
  cr4fc_Category?: CategoryEntity | null;
  // Collection-valued navigation property (one-to-many — returns array)
  cr4fc_order_lines?: OrderLineEntity[];
  createdon?: string;
  modifiedon?: string;
  [key: string]: unknown;
}
```

**Key difference:** Single-valued expansions return an **object or null**. Collection-valued expansions return an **array** (empty if no related records).

### Domain Types for Related Entities

```typescript
export interface OrderLine {
  id: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface Order {
  id: string;
  orderNumber: string;
  totalAmount: number;
  categoryId?: string;
  categoryName: string;
  // Expanded related records mapped to domain types
  orderLines: OrderLine[];
  createdAt: string;
  updatedAt: string;
}
```

### Mapper for Expanded Entities

```typescript
const mapOrderLineEntity = (entity: OrderLineEntity): OrderLine => ({
  id: entity.cr4fc_orderlineid,
  productName: entity.cr4fc_productname ?? '',
  quantity: entity.cr4fc_quantity ?? 0,
  unitPrice: entity.cr4fc_unitprice ?? 0,
  lineTotal: (entity.cr4fc_quantity ?? 0) * (entity.cr4fc_unitprice ?? 0),
});

export const mapOrderEntity = (entity: OrderEntity): Order => ({
  id: entity.cr4fc_orderid,
  orderNumber: entity.cr4fc_ordernumber ?? '',
  totalAmount: entity.cr4fc_totalamount ?? 0,
  categoryId: entity._cr4fc_category_value,
  categoryName: entity.cr4fc_Category?.cr4fc_name ?? getFormattedValue(entity, '_cr4fc_category_value') ?? 'Uncategorized',
  orderLines: (entity.cr4fc_order_lines ?? []).map(mapOrderLineEntity),
  createdAt: entity.createdon ?? new Date().toISOString(),
  updatedAt: entity.modifiedon ?? entity.createdon ?? new Date().toISOString(),
});
```

### Paging Expanded Collections

When the query contains **any** nested `$expand`, the `Prefer: odata.maxpagesize` header applies to expanded collections too. Each expanded collection returns its own `@odata.nextLink` for fetching additional related records.

Use `parseExpandedCollection` from the core API client to extract both the items and nextLink:

```typescript
import { parseExpandedCollection, powerPagesFetch } from '../shared/powerPagesApi';

// After fetching an order with expanded order lines:
const entity = await powerPagesFetch<OrderEntity>(url);
if (entity) {
  const { items: orderLines, nextLink } = parseExpandedCollection<OrderLineEntity>(
    entity as Record<string, unknown>,
    'cr4fc_order_lines'
  );

  // Map the first page of order lines
  const mapped = orderLines.map(mapOrderLineEntity);

  // Fetch additional pages if needed
  if (nextLink) {
    const additionalLines = await fetchAllPages<OrderLineEntity>(nextLink);
    mapped.push(...additionalLines.map(mapOrderLineEntity));
  }
}
```

**Without** nested `$expand`, up to 5,000 related records are returned inline (no paging on the expanded collection). The `@odata.nextLink` on the collection is a URL to the filtered collection itself, not a paged cursor.

### Get Related Records Separately

For large collections or when you need full paging control, fetch related records as a separate query instead of `$expand`:

```typescript
// Instead of expanding, query the related entity set directly with a filter
export const listOrderLines = async (orderId: string, params?: ListParams): Promise<PaginatedResult<OrderLine>> => {
  const pageSize = params?.pageSize ?? 20;

  // Use Prefer: odata.maxpagesize to control page size (NOT $top).
  const url = params?.nextLink ?? buildODataUrl('cr4fc_orderlines', {
    '$select': 'cr4fc_orderlineid,cr4fc_productname,cr4fc_quantity,cr4fc_unitprice',
    '$filter': `_cr4fc_order_value eq ${orderId}`,
    '$orderby': params?.orderBy ?? 'cr4fc_quantity desc',
    '$count': 'true',
  });

  const response = await powerPagesFetch<ODataCollectionResponse<OrderLineEntity>>(url, {
    headers: {
      'Prefer': `odata.include-annotations="OData.Community.Display.V1.FormattedValue",odata.maxpagesize=${pageSize}`,
    },
  });

  return {
    items: (response?.value ?? []).map(mapOrderLineEntity),
    totalCount: response?.['@odata.count'] ?? response?.value?.length ?? 0,
    nextLink: response?.['@odata.nextLink'],
  };
};
```

Use this approach when:
- The related collection can be large (hundreds+ records)
- You need `$orderby`, `$top`, or full pagination control alongside nested `$expand`
- The relationship is N:N (many-to-many), which cannot be nested-expanded

### Site Settings for Related Entity Columns

When expanding related entities, the `Webapi/<table>/fields` site setting on the **parent** table must include the lookup column's logical name (e.g., `cr4fc_categoryid`). The **related** table must also have its own `Webapi/<related_table>/enabled` and `Webapi/<related_table>/fields` settings configured with the columns being selected in the `$expand`.

### Table Permissions for Related Entities

When using `$expand` to fetch related entities, the related table **must have its own table permission** with at least `read: true` for the same web role. Power Pages enforces table permissions on every entity accessed in the query — including expanded navigation properties. Without a read permission on the related table, the `$expand` silently returns empty results or the entire query fails with a permission error.

**Rules:**
- **Single-valued expand (lookup):** The target table of the lookup needs `read: true` table permission for the requesting web role
- **Collection-valued expand (one-to-many):** The child table needs `read: true` table permission for the requesting web role. Use **Parent scope** (`756150003`) with the one-to-many relationship name to restrict access to only the related child records of the parent
- **Nested expand:** Every table in the expansion chain needs `read: true` table permissions

**Example:** If `cr4fc_order` expands `cr4fc_Category` (lookup) and `cr4fc_order_lines` (one-to-many):
- `cr4fc_order` — needs its own table permission (e.g., Contact scope, CRUD as needed)
- `cr4fc_category` — needs `read: true` table permission (e.g., Global scope for reference data)
- `cr4fc_orderline` — needs `read: true` table permission with **Parent scope** referencing the order permission via the `cr4fc_order_orderline` relationship

**Important:** This is in addition to the site settings requirements above. Both `Webapi/<table>/enabled` + `Webapi/<table>/fields` AND table permissions must be configured for each expanded related table.

---

## Framework Hooks (Step 6)

Create framework-specific hooks, composables, or services based on the detected framework (from Step 1.1). These provide the reactive data-fetching layer that components will consume.

### React — Custom Hook

Create in `src/shared/hooks/` or `src/hooks/` (match existing convention):

```typescript
import { useState, useEffect, useCallback } from 'react';

export function useProducts(params?: ListParams) {
  const [data, setData] = useState<PaginatedResult<Product>>({
    items: [],
    totalCount: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (overrides?: Partial<ListParams>) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await listProducts({ ...params, ...overrides });
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setIsLoading(false);
    }
  }, [params?.pageSize, params?.filter, params?.orderBy]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const fetchNextPage = useCallback(() => {
    if (data.nextLink) fetchData({ nextLink: data.nextLink });
  }, [data.nextLink, fetchData]);

  return { ...data, isLoading, error, refetch: fetchData, fetchNextPage };
}
```

### React — DataverseImage Component

If the table has File or Image columns, create a reusable component for rendering Dataverse images. Handles loading states, fallbacks, and cleanup of object URLs:

```tsx
import { useState, useEffect } from 'react';
import { fetchFileColumnUrl } from '../shared/powerPagesApi';

interface DataverseImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  table: string;        // Entity set name (e.g., 'cr4fc_products')
  recordId: string;     // GUID of the record
  column: string;       // File/image column logical name
  fallbackSrc?: string; // Fallback image URL if no file exists
  hasFile?: boolean;    // Whether the record has a file (skip fetch if false)
}

function DataverseImage({
  table,
  recordId,
  column,
  fallbackSrc = '',
  hasFile = true,
  ...imgProps
}: DataverseImageProps) {
  const [src, setSrc] = useState(fallbackSrc);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!hasFile) {
      if (fallbackSrc) setSrc(fallbackSrc);
      return;
    }

    let active = true;
    const loadImage = async () => {
      setIsLoading(true);
      try {
        const url = await fetchFileColumnUrl(table, recordId, column);
        if (active && url) setSrc(url);
      } catch (error) {
        console.warn('[DataverseImage] Failed to load image:', error);
      } finally {
        if (active) setIsLoading(false);
      }
    };

    loadImage();
    return () => { active = false; };
  }, [table, recordId, column, hasFile, fallbackSrc]);

  return <img src={src} {...imgProps} />;
}
```

Usage:
```tsx
<DataverseImage
  table="cr4fc_products"
  recordId={product.id}
  column="cr4fc_photo"
  fallbackSrc="/images/placeholder.png"
  hasFile={!!product.hasPhoto}
  alt={product.name}
  className="product-image"
/>
```

Only create this component if the table has image columns that need rendering in the UI.

### Vue — Composable

Create in `src/composables/`:

```typescript
import { ref, watch, type Ref } from 'vue';

export function useProducts(params?: Ref<ListParams | undefined>) {
  const items = ref<Product[]>([]);
  const totalCount = ref(0);
  const nextLink = ref<string | undefined>();
  const isLoading = ref(true);
  const error = ref<string | null>(null);

  const fetchData = async (overrides?: Partial<ListParams>) => {
    isLoading.value = true;
    error.value = null;
    try {
      const result = await listProducts({ ...params?.value, ...overrides });
      items.value = result.items;
      totalCount.value = result.totalCount;
      nextLink.value = result.nextLink;
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch data';
    } finally {
      isLoading.value = false;
    }
  };

  const fetchNextPage = () => {
    if (nextLink.value) fetchData({ nextLink: nextLink.value });
  };

  watch(params ?? ref(undefined), () => fetchData(), { immediate: true });

  return { items, totalCount, nextLink, isLoading, error, refetch: fetchData, fetchNextPage };
}
```

### Angular — Injectable Service

Create in `src/app/services/`:

```typescript
import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ProductApiService {
  list(params?: ListParams) { return listProducts(params); }
  getById(id: string) { return getProductById(id); }
  create(payload: CreateProductInput) { return createProduct(payload); }
  update(id: string, payload: UpdateProductInput) { return updateProduct(id, payload); }
  delete(id: string) { return deleteProduct(id); }
}
```

### Astro — Direct Import

For Astro, Web API calls only work client-side. Import the service in `<script>` tags or framework island components:

```astro
<script>
  import { listProducts } from '../shared/services/productService';
  // Client-side data fetching
</script>
```
