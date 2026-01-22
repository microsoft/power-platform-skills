# Frontend Integration Reference

This document provides code patterns for integrating Power Pages Web API into frontend applications.

## Web API Endpoint Format

The Power Pages Web API follows OData conventions:

```text
Base URL: https://<site-url>/_api/<entity-set-name>

Examples:
GET  /_api/cr_products                           # List all products
GET  /_api/cr_products(<guid>)                   # Get single product
GET  /_api/cr_products?$select=cr_name,cr_price  # Select specific fields
GET  /_api/cr_products?$filter=cr_isactive eq true  # Filter records
GET  /_api/cr_products?$orderby=cr_name          # Order results
GET  /_api/cr_products?$top=10                   # Limit results
POST /_api/cr_products                           # Create new product
PATCH /_api/cr_products(<guid>)                  # Update product
DELETE /_api/cr_products(<guid>)                 # Delete product
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

async function fetchWithAuth(url: string, options: RequestInit = {}) {
  const method = options.method?.toUpperCase() || 'GET';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...options.headers as Record<string, string>,
  };

  // Add anti-forgery token for non-GET requests (POST, PATCH, DELETE)
  if (method !== 'GET') {
    const token = await fetchAntiForgeryToken();
    if (token) {
      headers['__RequestVerificationToken'] = token;
    }
  }

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: 'include', // Important for authenticated requests
  });

  if (!response.ok) {
    // If we get a 403, the token may have expired - clear the cache
    if (response.status === 403) {
      clearTokenCache();
    }
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message || `API Error: ${response.status}`);
  }

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
    });
  },
};
```

## Entity-Specific Services

Create typed wrappers for each entity.

**IMPORTANT**: Always include `$select` with the fields configured in site settings. Power Pages Web API returns an error if you request fields not listed in the `Webapi/<table>/fields` site setting. Omitting `$select` attempts to fetch all fields, which fails.

```typescript
// Entity-specific services
// IMPORTANT: The 'select' array must match the fields in your Webapi/<table>/fields site setting

export const productsApi = {
  getAll: (options?: QueryOptions) =>
    webApi.getAll<Product>('cr_products', {
      select: ['cr_productid', 'cr_name', 'cr_description', 'cr_price', 'cr_category', 'cr_imageurl', 'cr_isactive'],
      ...options,
    }),
  getById: (id: string) =>
    webApi.getById<Product>('cr_products', id, {
      select: ['cr_productid', 'cr_name', 'cr_description', 'cr_price', 'cr_category', 'cr_imageurl', 'cr_isactive'],
    }),
  getActive: () =>
    webApi.getAll<Product>('cr_products', {
      select: ['cr_productid', 'cr_name', 'cr_description', 'cr_price', 'cr_category', 'cr_imageurl', 'cr_isactive'],
      filter: 'cr_isactive eq true',
      orderBy: 'cr_name',
    }),
};

export const teamMembersApi = {
  getAll: () =>
    webApi.getAll<TeamMember>('cr_teammembers', {
      select: ['cr_teammemberid', 'cr_name', 'cr_title', 'cr_email', 'cr_bio', 'cr_photourl', 'cr_linkedin', 'cr_displayorder'],
      orderBy: 'cr_displayorder',
    }),
};

export const testimonialsApi = {
  getActive: () =>
    webApi.getAll<Testimonial>('cr_testimonials', {
      select: ['cr_testimonialid', 'cr_name', 'cr_quote', 'cr_company', 'cr_role', 'cr_rating', 'cr_photourl', 'cr_isactive'],
      filter: 'cr_isactive eq true',
    }),
};

export const faqsApi = {
  getActive: () =>
    webApi.getAll<FAQ>('cr_faqs', {
      select: ['cr_faqid', 'cr_question', 'cr_answer', 'cr_category', 'cr_displayorder', 'cr_isactive'],
      filter: 'cr_isactive eq true',
      orderBy: 'cr_displayorder',
    }),
};

export const contactApi = {
  submit: (data: ContactSubmission) =>
    webApi.create<ContactSubmission>('cr_contactsubmissions', {
      ...data,
      cr_submissiondate: new Date().toISOString(),
      cr_status: 1, // New
    }),
};
```

## Type Definitions

```typescript
export interface Product {
  cr_productid: string;
  cr_name: string;
  cr_description: string;
  cr_price: number;
  cr_category: string;
  cr_imageurl: string;
  cr_isactive: boolean;
}

export interface TeamMember {
  cr_teammemberid: string;
  cr_name: string;
  cr_title: string;
  cr_email: string;
  cr_bio: string;
  cr_photourl: string;
  cr_linkedin: string;
  cr_displayorder: number;
}

export interface Testimonial {
  cr_testimonialid: string;
  cr_name: string;
  cr_quote: string;
  cr_company: string;
  cr_role: string;
  cr_rating: number;
  cr_photourl: string;
  cr_isactive: boolean;
}

export interface FAQ {
  cr_faqid: string;
  cr_question: string;
  cr_answer: string;
  cr_category: string;
  cr_displayorder: number;
  cr_isactive: boolean;
}

export interface ContactSubmission {
  cr_name: string;
  cr_email: string;
  cr_message: string;
  cr_submissiondate?: string;
  cr_status?: number;
}
```

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

// Usage example:
// const { data: products, loading, error } = useWebApi<Product>('cr_products', { filter: 'cr_isactive eq true' });
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
        <ProductCard key={product.cr_productid} product={product} />
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
  const [formData, setFormData] = useState<ContactSubmission>({
    cr_name: '',
    cr_email: '',
    cr_message: '',
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
      setFormData({ cr_name: '', cr_email: '', cr_message: '' });
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
          value={formData.cr_name}
          onChange={e => setFormData({ ...formData, cr_name: e.target.value })}
          required
        />
      </div>

      <div className="form-group">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={formData.cr_email}
          onChange={e => setFormData({ ...formData, cr_email: e.target.value })}
          required
        />
      </div>

      <div className="form-group">
        <label htmlFor="message">Message</label>
        <textarea
          id="message"
          value={formData.cr_message}
          onChange={e => setFormData({ ...formData, cr_message: e.target.value })}
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
  return products.map(p => <ProductCard key={p.cr_productid} product={p} />);
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

| Operation | Query String | Example |
|-----------|-------------|---------|
| Select fields | `$select=field1,field2` | `$select=cr_name,cr_price` |
| Filter | `$filter=condition` | `$filter=cr_isactive eq true` |
| Order by | `$orderby=field [asc\|desc]` | `$orderby=cr_name desc` |
| Top N | `$top=N` | `$top=10` |
| Skip | `$skip=N` | `$skip=20` |
| Expand | `$expand=relationship` | `$expand=cr_category` |

### Filter Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `eq` | Equal | `cr_isactive eq true` |
| `ne` | Not equal | `cr_status ne 0` |
| `gt` | Greater than | `cr_price gt 100` |
| `ge` | Greater or equal | `cr_price ge 100` |
| `lt` | Less than | `cr_price lt 50` |
| `le` | Less or equal | `cr_price le 50` |
| `and` | Logical AND | `cr_isactive eq true and cr_price gt 0` |
| `or` | Logical OR | `cr_category eq 'A' or cr_category eq 'B'` |
| `contains` | Contains string | `contains(cr_name,'search')` |
| `startswith` | Starts with | `startswith(cr_name,'Pro')` |
| `endswith` | Ends with | `endswith(cr_email,'@example.com')` |
