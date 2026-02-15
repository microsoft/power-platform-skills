# Frontend Integration Reference

## Web API Endpoint Format

The Power Pages Web API follows OData conventions.

**IMPORTANT - Table Names**: Use the **actual table logical names** from the `$tableMap` built in `/setup-dataverse`:
- For **reused/extended tables**: Use the existing logical name from Dataverse (e.g., `contoso_items`, `existing_productcategory`)
- For **new tables**: Use `{prefix}_tablename` pattern (e.g., `cr_product`)

The entity set name (used in URLs) is typically the pluralized form of the logical name.

**NOTE**: Replace `{prefix}` with your publisher prefix from `Initialize-DataverseApi` (e.g., `cr`, `contoso`, `new`).

```text
Base URL: https://<site-url>/_api/<entity-set-name>

Examples:
GET  /_api/{prefix}_products                           # List all products
GET  /_api/{prefix}_products(<guid>)                   # Get single product
GET  /_api/{prefix}_products?$select={prefix}_name,{prefix}_price  # Select specific fields
GET  /_api/{prefix}_products?$filter={prefix}_isactive eq true  # Filter records
GET  /_api/{prefix}_products?$orderby={prefix}_name          # Order results
GET  /_api/{prefix}_products?$top=10                   # Limit results
POST /_api/{prefix}_products                           # Create new product
PATCH /_api/{prefix}_products(<guid>)                  # Update product
DELETE /_api/{prefix}_products(<guid>)                 # Delete product
```

## CSRF Token Requirement

**IMPORTANT**: Power Pages requires a CSRF (Cross-Site Request Forgery) anti-forgery token for all non-GET requests (POST, PATCH, DELETE).

- The token must be fetched from `/_layout/tokenhtml`
- Include the token in the `__RequestVerificationToken` header
- GET requests do not require this token
- The token may expire, so handle 403 errors by refreshing the token

## Power Pages Web API Service (TypeScript)

Create a reusable API service for Web API calls.

**File: `src/services/webApi.ts`**

```typescript
// Power Pages Web API Service
const API_BASE = '/_api';

interface QueryOptions {
  select?: string[];
  filter?: string;
  orderBy?: string;
  top?: number;
  expand?: string;
}

// Cache for the anti-forgery token
let cachedToken: string | null = null;

/**
 * Fetches the CSRF anti-forgery token required for non-GET requests.
 * Power Pages requires this token in the __RequestVerificationToken header
 * for POST, PATCH, and DELETE operations.
 */
async function fetchAntiForgeryToken(): Promise<string> {
  // Return cached token if available
  if (cachedToken) {
    return cachedToken;
  }

  try {
    const tokenEndpoint = '/_layout/tokenhtml';
    const response = await fetch(tokenEndpoint, {});

    if (response.status !== 200) {
      throw new Error(`Failed to fetch token: ${response.status}`);
    }

    const tokenResponse = await response.text();
    const valueString = 'value="';
    const terminalString = '" />';
    const valueIndex = tokenResponse.indexOf(valueString);

    if (valueIndex === -1) {
      throw new Error('Token not found in response');
    }

    const requestVerificationToken = tokenResponse.substring(
      valueIndex + valueString.length,
      tokenResponse.indexOf(terminalString, valueIndex)
    );

    cachedToken = requestVerificationToken || '';
    return cachedToken;
  } catch (error) {
    console.warn('[Web API] Failed to fetch anti-forgery token:', error);
    return '';
  }
}

/**
 * Clears the cached token. Call this if you receive a 403 error
 * which may indicate the token has expired.
 */
function clearTokenCache(): void {
  cachedToken = null;
}

type ResponseType = 'json' | 'blob' | 'none';

interface FetchAuthOptions extends RequestInit {
  /** Response parsing strategy. Defaults to 'json'. Use 'blob' for file downloads, 'none' for DELETE/upload. */
  responseType?: ResponseType;
  /** If true, return null on 404 instead of throwing. Useful for file column existence checks. */
  allowNotFound?: boolean;
}

async function fetchWithAuth<T = any>(url: string, options: FetchAuthOptions = {}): Promise<T> {
  const { responseType = 'json', allowNotFound = false, ...fetchOptions } = options;
  const method = fetchOptions.method?.toUpperCase() || 'GET';

  // Set default headers based on responseType
  const headers: Record<string, string> = responseType === 'blob'
    ? { 'Accept': '*/*' }
    : { 'Content-Type': 'application/json', 'Accept': 'application/json' };

  // Merge caller-provided headers (allows overriding defaults)
  Object.assign(headers, fetchOptions.headers as Record<string, string>);

  // Add anti-forgery token for non-GET requests (POST, PATCH, DELETE)
  if (method !== 'GET') {
    const token = await fetchAntiForgeryToken();
    if (token) {
      headers['__RequestVerificationToken'] = token;
    }
  }

  const response = await fetch(url, {
    ...fetchOptions,
    headers,
    credentials: 'include', // Important for authenticated requests
  });

  // Handle 404 gracefully when allowNotFound is set (e.g., file column checks)
  if (allowNotFound && response.status === 404) {
    return null as T;
  }

  if (!response.ok) {
    // If we get a 403, the token may have expired - clear the cache
    if (response.status === 403) {
      clearTokenCache();
    }
    if (responseType === 'json') {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(error.message || `API Error: ${response.status}`);
    }
    throw new Error(`API Error: ${response.status}`);
  }

  // Parse response based on responseType
  if (responseType === 'blob') return response.blob() as Promise<T>;
  if (responseType === 'none' || response.status === 204) return null as T;
  return response.json();
}

function buildQueryString(options: QueryOptions): string {
  const params = new URLSearchParams();

  if (options.select?.length) {
    params.append('$select', options.select.join(','));
  }
  if (options.filter) {
    params.append('$filter', options.filter);
  }
  if (options.orderBy) {
    params.append('$orderby', options.orderBy);
  }
  if (options.top) {
    params.append('$top', options.top.toString());
  }
  if (options.expand) {
    params.append('$expand', options.expand);
  }

  const queryString = params.toString();
  return queryString ? `?${queryString}` : '';
}

// Generic CRUD operations
export const webApi = {
  // GET all records
  async getAll<T>(entitySet: string, options: QueryOptions = {}): Promise<T[]> {
    const queryString = buildQueryString(options);
    const response = await fetchWithAuth(`${API_BASE}/${entitySet}${queryString}`);
    return response.value;
  },

  // GET single record by ID
  async getById<T>(entitySet: string, id: string, options: Pick<QueryOptions, 'select' | 'expand'> = {}): Promise<T> {
    const queryString = buildQueryString(options);
    return fetchWithAuth(`${API_BASE}/${entitySet}(${id})${queryString}`);
  },

  // POST create new record
  async create<T>(entitySet: string, data: Partial<T>): Promise<T> {
    return fetchWithAuth(`${API_BASE}/${entitySet}`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // PATCH update existing record
  async update<T>(entitySet: string, id: string, data: Partial<T>): Promise<void> {
    await fetchWithAuth(`${API_BASE}/${entitySet}(${id})`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  // DELETE record
  async delete(entitySet: string, id: string): Promise<void> {
    await fetchWithAuth(`${API_BASE}/${entitySet}(${id})`, {
      method: 'DELETE',
      responseType: 'none',
    });
  },

  // DOWNLOAD file/image from a file column
  // Returns an object URL for the blob, or null if no file exists (404)
  async downloadFile(entitySet: string, id: string, column: string): Promise<string | null> {
    const blob = await fetchWithAuth<Blob | null>(
      `${API_BASE}/${entitySet}(${id})/${column}/$value`,
      { responseType: 'blob', allowNotFound: true }
    );
    return blob ? URL.createObjectURL(blob) : null;
  },

  // UPLOAD file/image to a file column
  // IMPORTANT: Targets the column URL directly (no /$value suffix). Body is raw binary.
  async uploadFile(
    entitySet: string, id: string, column: string, file: Blob, fileName?: string
  ): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': file.type || 'application/octet-stream',
      'If-Match': '*',
    };
    if (fileName) {
      headers['x-ms-file-name'] = fileName;
    }
    await fetchWithAuth(`${API_BASE}/${entitySet}(${id})/${column}`, {
      method: 'PATCH',
      headers,
      body: await file.arrayBuffer(),
      responseType: 'none',
    });
  },
};
```

## Entity-Specific Services

Create typed wrappers for each entity.

**IMPORTANT**: Always include `$select` with the fields configured in site settings. Power Pages Web API returns an error if you request fields not listed in the `Webapi/<table>/fields` site setting. Omitting `$select` attempts to fetch all fields, which fails.

**NOTE**: Replace `{prefix}` with your publisher prefix (e.g., `cr`, `contoso`, `new`). The prefix is determined by your Dataverse environment's default publisher.

```typescript
// Entity-specific services
// IMPORTANT: The 'select' array must match the fields in your Webapi/<table>/fields site setting
// NOTE: Replace {prefix} with your actual publisher prefix (e.g., 'cr', 'contoso', 'new')

export const productsApi = {
  getAll: (options?: QueryOptions) =>
    webApi.getAll<Product>('{prefix}_products', {
      select: ['{prefix}_productid', '{prefix}_name', '{prefix}_description', '{prefix}_price', '_{prefix}_categoryid_value', '{prefix}_imageurl', '{prefix}_isactive'],
      expand: '{prefix}_Category($select={prefix}_name)',
      ...options,
    }),
  getById: (id: string) =>
    webApi.getById<Product>('{prefix}_products', id, {
      select: ['{prefix}_productid', '{prefix}_name', '{prefix}_description', '{prefix}_price', '_{prefix}_categoryid_value', '{prefix}_imageurl', '{prefix}_isactive'],
      expand: '{prefix}_Category($select={prefix}_name)',
    }),
  getActive: () =>
    webApi.getAll<Product>('{prefix}_products', {
      select: ['{prefix}_productid', '{prefix}_name', '{prefix}_description', '{prefix}_price', '_{prefix}_categoryid_value', '{prefix}_imageurl', '{prefix}_isactive'],
      expand: '{prefix}_Category($select={prefix}_name)',
      filter: '{prefix}_isactive eq true',
      orderBy: '{prefix}_name',
    }),
};

export const teamMembersApi = {
  getAll: () =>
    webApi.getAll<TeamMember>('{prefix}_teammembers', {
      select: ['{prefix}_teammemberid', '{prefix}_name', '{prefix}_title', '{prefix}_email', '{prefix}_bio', '{prefix}_photourl', '{prefix}_linkedin', '{prefix}_displayorder'],
      orderBy: '{prefix}_displayorder',
    }),
};

export const testimonialsApi = {
  getActive: () =>
    webApi.getAll<Testimonial>('{prefix}_testimonials', {
      select: ['{prefix}_testimonialid', '{prefix}_name', '{prefix}_quote', '{prefix}_company', '{prefix}_role', '{prefix}_rating', '{prefix}_photourl', '{prefix}_isactive'],
      filter: '{prefix}_isactive eq true',
    }),
};

export const faqsApi = {
  getActive: () =>
    webApi.getAll<FAQ>('{prefix}_faqs', {
      select: ['{prefix}_faqid', '{prefix}_question', '{prefix}_answer', '{prefix}_Category', '{prefix}_displayorder', '{prefix}_isactive'],
      filter: '{prefix}_isactive eq true',
      orderBy: '{prefix}_displayorder',
    }),
};

export const contactApi = {
  submit: (data: ContactSubmission) =>
    webApi.create<ContactSubmission>('{prefix}_contactsubmissions', {
      ...data,
      {prefix}_submissiondate: new Date().toISOString(),
      {prefix}_status: 1, // New
    }),
};
```

## Type Definitions

**NOTE**: Replace `{prefix}` with your publisher prefix (e.g., `cr`, `contoso`, `new`).

```typescript
// NOTE: Replace {prefix} with your actual publisher prefix

export interface Product {
  {prefix}_productid: string;
  {prefix}_name: string;
  {prefix}_description: string;
  {prefix}_price: number;
  {prefix}_imageurl: string;
  {prefix}_isactive: boolean;
  // Raw Lookup ID (for filtering/logic)
  _{prefix}_categoryid_value?: string; 
  // Expanded Lookup Object (matches the Navigation Property name)
  {prefix}_Category?: {
    {prefix}_categoryid: string;
    {prefix}_name: string;
  };
}

export interface TeamMember {
  {prefix}_teammemberid: string;
  {prefix}_name: string;
  {prefix}_title: string;
  {prefix}_email: string;
  {prefix}_bio: string;
  {prefix}_photourl: string;
  {prefix}_linkedin: string;
  {prefix}_displayorder: number;
}

export interface Testimonial {
  {prefix}_testimonialid: string;
  {prefix}_name: string;
  {prefix}_quote: string;
  {prefix}_company: string;
  {prefix}_role: string;
  {prefix}_rating: number;
  {prefix}_photourl: string;
  {prefix}_isactive: boolean;
}

export interface FAQ {
  {prefix}_faqid: string;
  {prefix}_question: string;
  {prefix}_answer: string;
  // Raw Lookup ID (for filtering/logic)
  _{prefix}_categoryid_value?: string; 
  // Expanded Lookup Object (matches the Navigation Property name)
  {prefix}_Category?: {
    {prefix}_categoryid: string;
    {prefix}_name: string;
  };
  {prefix}_displayorder: number;
  {prefix}_isactive: boolean;
}

export interface ContactSubmission {
  {prefix}_name: string;
  {prefix}_email: string;
  {prefix}_message: string;
  {prefix}_submissiondate?: string;
  {prefix}_status?: number;
}
```

## Handling Lookup Properties

Lookups in Dataverse are unique because they expose two distinct properties. Understanding the difference is critical for frontend integration.

### 1. Retrieval (GET)

* The GUID Property: Automatically named `_{logicalname}_value`. Use this for IDs or logic.
* The Navigation Property: Named `{logicalname}`. Use this with `$expand` to get related record details.

### 2. Updating & Creating (POST/PATCH)

You **cannot** update a lookup by sending a GUID to the `_value` property. You must use the `@odata.bind` annotation on the **Navigation Property**.

**Syntax**: `"navigation_property_name@odata.bind": "/entity_set_plural_name(GUID)"`

> **Note**: If you get an "Undeclared Property" error, you are likely using the logical name (lowercase) instead of the **Navigation Property Name** (case-sensitive, usually matches the schema name).


## File & Image Column Operations

Dataverse supports **File** and **Image** column types that store binary data directly on records. The `fetchWithAuth` wrapper handles these via the `responseType` and `allowNotFound` options, and the `webApi` object exposes `downloadFile` / `uploadFile` methods for convenience.

### Download File / Image

To retrieve a file or image, request the `/$value` endpoint. The `fetchWithAuth` wrapper uses `responseType: 'blob'` to return binary data, and `allowNotFound: true` to return `null` on 404 (no file) instead of throwing.

```typescript
// Using the webApi helper (recommended):
const imageUrl = await webApi.downloadFile('{prefix}_products', recordId, '{prefix}_photo');
// Returns an object URL string for the blob, or null if no file exists

// Equivalent direct call via fetchWithAuth:
const blob = await fetchWithAuth<Blob | null>(
  `/_api/{prefix}_products(${recordId})/{prefix}_photo/$value`,
  { responseType: 'blob', allowNotFound: true }
);
const url = blob ? URL.createObjectURL(blob) : null;
```

### Upload File / Image

To upload, send a `PATCH` to the column endpoint directly (**not** `/$value`). The body must be raw binary (ArrayBuffer), with `Content-Type` set to the file's MIME type and `responseType: 'none'` since the response has no body.

**IMPORTANT**: Upload URL is `/_api/table(id)/column` — **no** `/$value` suffix.

```typescript
// Using the webApi helper (recommended):
await webApi.uploadFile('{prefix}_products', recordId, '{prefix}_photo', file, 'hero.jpg');

// Equivalent direct call via fetchWithAuth:
await fetchWithAuth(`/_api/{prefix}_products(${recordId})/{prefix}_photo`, {
  method: 'PATCH',
  headers: {
    'Content-Type': file.type || 'application/octet-stream',
    'If-Match': '*',
    'x-ms-file-name': 'hero.jpg',
  },
  body: await file.arrayBuffer(),
  responseType: 'none',
});
```

### DataverseImage Component

A reusable React component for rendering images stored in Dataverse file/image columns. Handles loading states, fallbacks, and cleanup of object URLs.

```tsx
import { useState, useEffect } from 'react';
import { webApi } from '../services/webApi';

interface DataverseImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  table: string;        // Entity set name (e.g., '{prefix}_products')
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
        const url = await webApi.downloadFile(table, recordId, column);
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

**Usage:**
```tsx
// NOTE: Replace {prefix} with your actual publisher prefix
<DataverseImage
  table="{prefix}_products"
  recordId={product.{prefix}_productid}
  column="{prefix}_photo"
  fallbackSrc="/images/placeholder.png"
  hasFile={!!product.{prefix}_photo}
  alt={product.{prefix}_name}
  className="product-image"
/>
```

### Key Differences: File Columns vs Standard Columns

| Aspect | Standard Columns | File/Image Columns |
|--------|------------------|--------------------|
| **responseType** | `'json'` (default) | `'blob'` (download) / `'none'` (upload) |
| **Content-Type** | `application/json` (default) | `application/octet-stream` (or file MIME type) |
| **Accept Header** | `application/json` (default) | `*/*` (auto-set for `'blob'`) |
| **Request Body** | JSON string | ArrayBuffer (binary) |
| **Download URL** | `/_api/table(id)?$select=col` | `/_api/table(id)/column/$value` |
| **Upload URL** | `/_api/table(id)` with JSON body | `/_api/table(id)/column` with binary body |
| **Upload Method** | `POST` (create) / `PATCH` (update) | `PATCH` only |
| **Extra Headers** | — | `x-ms-file-name`, `If-Match: *` |

## React Hook for Data Fetching

**File: `src/hooks/useWebApi.ts`**

```typescript
import { useState, useEffect, useCallback } from 'react';
import { webApi, QueryOptions } from '../services/webApi';

interface UseDataverseResult<T> {
  data: T[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useWebApi<T>(
  entitySet: string,
  options: QueryOptions = {},
  deps: any[] = []
): UseDataverseResult<T> {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await webApi.getAll<T>(entitySet, options);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, [entitySet, JSON.stringify(options)]);

  useEffect(() => {
    fetchData();
  }, [fetchData, ...deps]);

  return { data, loading, error, refetch: fetchData };
}

// Usage example (replace {prefix} with your publisher prefix):
// const { data: products, loading, error } = useWebApi<Product>('{prefix}_products', { filter: '{prefix}_isactive eq true' });
```

## Component Examples

### Data Display Component

**Before (static data):**

```tsx
const products = [
  { id: 1, name: 'Product 1', price: 99.99 },
  { id: 2, name: 'Product 2', price: 149.99 },
];

function ProductList() {
  return (
    <div>
      {products.map(product => (
        <ProductCard key={product.id} product={product} />
      ))}
    </div>
  );
}
```

**After (Web API):**

```tsx
import { useState, useEffect } from 'react';
import { productsApi, Product } from '../services/webApi';

function ProductList() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadProducts() {
      try {
        const data = await productsApi.getActive();
        setProducts(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load products');
      } finally {
        setLoading(false);
      }
    }
    loadProducts();
  }, []);

  if (loading) return <div className="loading">Loading products...</div>;
  if (error) return <div className="error">{error}</div>;

  return (
    <div className="products-grid">
      {products.map(product => (
        <ProductCard key={product.{prefix}_productid} product={product} />
      ))}
    </div>
  );
}
```

### Form Submission Component

```tsx
import { useState } from 'react';
import { contactApi, ContactSubmission } from '../services/webApi';

function ContactForm() {
  // NOTE: Replace {prefix} with your actual publisher prefix
  const [formData, setFormData] = useState<ContactSubmission>({
    {prefix}_name: '',
    {prefix}_email: '',
    {prefix}_message: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await contactApi.submit(formData);
      setSubmitted(true);
      setFormData({ {prefix}_name: '', {prefix}_email: '', {prefix}_message: '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit form');
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="success-message">
        <h3>Thank you!</h3>
        <p>Your message has been sent. We'll get back to you soon.</p>
        <button onClick={() => setSubmitted(false)}>Send another message</button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="contact-form">
      {error && <div className="error-message">{error}</div>}

      <div className="form-group">
        <label htmlFor="name">Name</label>
        <input
          id="name"
          type="text"
          value={formData.{prefix}_name}
          onChange={e => setFormData({ ...formData, {prefix}_name: e.target.value })}
          required
        />
      </div>

      <div className="form-group">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={formData.{prefix}_email}
          onChange={e => setFormData({ ...formData, {prefix}_email: e.target.value })}
          required
        />
      </div>

      <div className="form-group">
        <label htmlFor="message">Message</label>
        <textarea
          id="message"
          value={formData.{prefix}_message}
          onChange={e => setFormData({ ...formData, {prefix}_message: e.target.value })}
          required
          rows={5}
        />
      </div>

      <button type="submit" disabled={submitting}>
        {submitting ? 'Sending...' : 'Send Message'}
      </button>
    </form>
  );
}
```

## Mock Data Replacement Guide

**CRITICAL**: The Web API setup is NOT complete until ALL mock/static data has been replaced with Web API calls. This section provides systematic instructions to find and replace every instance.

### Step 1: Search for Mock Data Files

Search for dedicated mock data files and folders:

```bash
# Find common mock data folders
find . -type d -name "mock*" -o -name "data" -o -name "fixtures" -o -name "fake*" -o -name "dummy*" 2>/dev/null

# Find data files
find . -type f \( -name "*.data.ts" -o -name "*.data.js" -o -name "*mock*.ts" -o -name "*mock*.js" -o -name "*.json" \) -path "*/src/*" 2>/dev/null
```

**PowerShell equivalent:**
```powershell
# Find mock data folders
Get-ChildItem -Path . -Directory -Recurse | Where-Object { $_.Name -match "mock|data|fixtures|fake|dummy" }

# Find data files in src
Get-ChildItem -Path ./src -Recurse -Include "*.data.ts","*.data.js","*mock*.ts","*mock*.js","*.json"
```

### Step 2: Search for Inline Mock Data Patterns

Search for common patterns that indicate hardcoded data:

```bash
# Arrays of objects (common mock data pattern)
grep -rn "^\s*\[\s*{" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" src/

# Const arrays with data
grep -rn "const.*=\s*\[" --include="*.ts" --include="*.tsx" src/

# Export const arrays
grep -rn "export const.*\[\|export default \[" --include="*.ts" --include="*.tsx" src/
```

**PowerShell equivalent:**
```powershell
# Search for array declarations that look like mock data
Select-String -Path "src\**\*.ts","src\**\*.tsx" -Pattern "const\s+\w+\s*=\s*\[" | Where-Object { $_.Line -notmatch "useState|useEffect" }

# Search for exported arrays
Select-String -Path "src\**\*.ts","src\**\*.tsx" -Pattern "export (const|default)\s+.*\["
```

### Step 3: Identify Data by Entity Type

For each table configured for Web API, search for related mock data:

| Table | Search Patterns |
|-------|-----------------|
| Products | `product`, `products`, `item`, `items`, `catalog` |
| Team Members | `team`, `member`, `staff`, `employee`, `people` |
| Testimonials | `testimonial`, `review`, `feedback`, `quote` |
| FAQs | `faq`, `question`, `answer`, `help` |
| Contact | `contact`, `submission`, `inquiry`, `message` |

**Example search:**
```powershell
# Find all references to products data
Select-String -Path "src\**\*.ts","src\**\*.tsx" -Pattern "products?\s*[:=]?\s*\[" -CaseSensitive:$false
```

### Step 4: Replace Each Instance

For each mock data instance found:

**Before (mock data):**
```typescript
// src/data/products.ts
export const products = [
  { id: 1, name: 'Widget', price: 29.99 },
  { id: 2, name: 'Gadget', price: 49.99 },
];

// src/components/ProductList.tsx
import { products } from '../data/products';

function ProductList() {
  return products.map(p => <ProductCard key={p.id} product={p} />);
}
```

**After (Web API):**
```typescript
// src/components/ProductList.tsx
import { useState, useEffect } from 'react';
import { productsApi, Product } from '../services/webApi';

function ProductList() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // productsApi.getActive() already includes $select with allowed fields
    productsApi.getActive().then(setProducts).finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;
  return products.map(p => <ProductCard key={p.{prefix}_productid} product={p} />);
}
```

### Step 5: Delete or Archive Mock Data Files

After replacing all usages:

1. **Delete mock data files** that are no longer imported anywhere
2. **Remove mock data folders** if empty
3. **Update any barrel exports** (index.ts files) that re-exported mock data

```powershell
# Verify no imports remain for a mock file before deleting
Select-String -Path "src\**\*.ts","src\**\*.tsx" -Pattern "from ['\"].*products\.data"

# If no results, safe to delete
Remove-Item -Path "src\data\products.data.ts"
```

### Step 6: Verify Complete Replacement

**IMPORTANT**: Run these verification checks before marking the skill complete:

```powershell
# 1. Check for any remaining mock/data folders
Get-ChildItem -Path ./src -Directory -Recurse | Where-Object { $_.Name -match "^(mock|data|fixtures|fake|dummy)$" }

# 2. Check for suspicious const array declarations (review each match)
Select-String -Path "src\**\*.ts","src\**\*.tsx" -Pattern "const\s+\w+\s*:\s*\w+\[\]\s*=\s*\[" | Where-Object { $_.Line -match "\{" }

# 3. Check for JSON imports that might be mock data
Select-String -Path "src\**\*.ts","src\**\*.tsx" -Pattern "from ['\"].*\.json['\"]"

# 4. Verify all components use the webApi service
Select-String -Path "src\**\*.ts","src\**\*.tsx" -Pattern "webApi|productsApi|teamMembersApi|testimonialsApi|faqsApi|contactApi"
```

### Common Locations for Mock Data

| Location | Description | Action |
|----------|-------------|--------|
| `src/data/` | Dedicated data folder | Replace all, then delete folder |
| `src/mock/` | Mock data folder | Replace all, then delete folder |
| `src/constants/` | May contain data arrays | Review and replace data arrays |
| `src/fixtures/` | Test fixtures with data | Replace with API calls or test mocks |
| `*.json` in src | JSON data files | Replace imports with API calls |
| Component files | Inline const arrays | Move to useEffect with API calls |
| Context providers | Initial state with data | Initialize empty, fetch in useEffect |

### Mock Data Replacement Tracking

Track replacements in the memory bank:

```markdown
### Removed/Replaced Mock Data

| Location | Description | Replaced With | Verified |
|----------|-------------|---------------|----------|
| src/data/products.ts | Static product array | productsApi.getActive() | ✅ |
| src/data/team.ts | Team member list | teamMembersApi.getAll() | ✅ |
| src/components/FAQ.tsx | Inline FAQ array | faqsApi.getActive() | ✅ |
| src/data/ folder | Mock data folder | DELETED | ✅ |
```

## OData Query Reference

**NOTE**: Replace `{prefix}` with your publisher prefix (e.g., `cr`, `contoso`, `new`).

| Operation | Query String | Example |
|-----------|-------------|---------|
| Select fields | `$select=field1,field2` | `$select={prefix}_name,{prefix}_price` |
| Filter | `$filter=condition` | `$filter={prefix}_isactive eq true` |
| Order by | `$orderby=field [asc\|desc]` | `$orderby={prefix}_name desc` |
| Top N | `$top=N` | `$top=10` |
| Skip | `$skip=N` | `$skip=20` |
| Expand | `$expand=relationship` | `$expand={prefix}_Category` |

### OData Query Reference for Lookups

| Goal | Syntax | Example |
| --- | --- | --- |
| Get Lookup GUID | `_{logicalname}_value` | `$select=_{prefix}_customer_value` |
| Get Display Name | Use FormattedValue Header | `OData.Community.Display.V1.FormattedValue` |
| Expand Related | `$expand={nav_property}` | `$expand={prefix}_Author($select={prefix}_name)` |
| Filter by ID | `_{logicalname}_value eq GUID` | `$filter=_{prefix}_owner_value eq <guid>` |
| Update Lookup | `{nav_property}@odata.bind` | `"{prefix}_Customer@odata.bind": "/accounts(<guid>)"` |
| Clear Lookup | `DELETE` on the prop URL | `DELETE /_api/table(id)/nav_prop/$ref` |

### OData Query Reference for File & Image Columns

File and image columns use different URL patterns than standard OData queries. They do **not** support `$select`, `$filter`, or other OData query options — each operation targets the column endpoint directly.

| Goal | Method | URL Pattern | Notes |
| --- | --- | --- | --- |
| Download file/image | `GET` | `/_api/{prefix}_products(<guid>)/{prefix}_photo/$value` | Returns binary blob. `Accept: */*` |
| Upload file/image | `PATCH` | `/_api/{prefix}_products(<guid>)/{prefix}_photo` | Body is `ArrayBuffer`. No `/$value` suffix |
| Delete file/image | `DELETE` | `/_api/{prefix}_products(<guid>)/{prefix}_photo` | Removes the file, keeps the record |
| Check if file exists | `GET` | `/_api/{prefix}_products(<guid>)?$select={prefix}_photo` | Returns metadata (file name, size), not binary |

**Required headers by operation:**

| Operation | Content-Type | Accept | Extra Headers |
| --- | --- | --- | --- |
| Download | — | `*/*` | — |
| Upload | File MIME type (e.g., `image/png`) | `application/json` | `If-Match: *`, `x-ms-file-name: <name>` |
| Delete | — | `application/json` | `If-Match: *` |

**Common pitfalls:**

| Mistake | Symptom | Fix |
| --- | --- | --- |
| Using `/$value` on upload | `405 Method Not Allowed` | Upload to `/_api/table(id)/column` (no `/$value`) |
| Sending JSON body for upload | `400 Bad Request` | Send `ArrayBuffer` via `file.arrayBuffer()` |
| Missing `If-Match: *` on upload | `412 Precondition Failed` | Add `If-Match: *` header |
| Using `$select` on `/$value` URL | `400 Bad Request` | Query options are not supported on `/$value` |
| Missing `x-ms-file-name` | File saved without name/extension | Include `x-ms-file-name` header with filename |

### Filter Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `eq` | Equal | `{prefix}_isactive eq true` |
| `ne` | Not equal | `{prefix}_status ne 0` |
| `gt` | Greater than | `{prefix}_price gt 100` |
| `ge` | Greater or equal | `{prefix}_price ge 100` |
| `lt` | Less than | `{prefix}_price lt 50` |
| `le` | Less or equal | `{prefix}_price le 50` |
| `and` | Logical AND | `{prefix}_isactive eq true and {prefix}_price gt 0` |
| `or` | Logical OR | `{prefix}_Category eq 'A' or {prefix}_Category eq 'B'` |
| `contains` | Contains string | `contains({prefix}_name,'search')` |
| `startswith` | Starts with | `startswith({prefix}_name,'Pro')` |
| `endswith` | Ends with | `endswith({prefix}_email,'@example.com')` |
