---
description: Configure Web API access for your Power Pages site. Creates site settings to enable table access via /_api endpoint, sets up entity permissions, and updates frontend code to use Power Pages Web API.
user-invocable: true
allowed-tools: Bash(pac:*), Bash(az:*), Bash(dotnet:*)
model: sonnet
---

# Setup Web API

This skill guides makers through configuring Web API access for their Power Pages site. It creates site settings to enable data access via the `/_api` endpoint and updates the frontend code to fetch data dynamically.

## Memory Bank

This skill uses a **memory bank** (`memory-bank.md`) to persist context across sessions.

**Follow the instructions in `${CLAUDE_PLUGIN_ROOT}/shared/memory-bank.md`** for:
- Checking and reading the memory bank before starting
- Skipping completed steps and resuming progress
- Updating the memory bank after each major step

## Workflow Overview

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 1: Resume or Start Fresh                                              │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Check memory bank for project context                                    │
│  • Identify tables created in /setup-dataverse                              │
│  • Verify site is uploaded to Power Pages                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 2: Create Site Settings Files                                         │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Create .powerpages-site/site-settings folder structure                   │
│  • Generate UUID for each site setting                                      │
│  • Enable Web API for each table (Webapi/{table}/enabled)                   │
│  • Configure allowed fields (Webapi/{table}/fields)                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 3: Create Table Permissions                                           │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Create entity permission records for Web API access                      │
│  • Configure scope (Global/Parent/Self) based on requirements               │
│  • Set appropriate CRUD permissions                                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 4: Update Frontend Code                                               │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Create API service/utility for /_api calls                               │
│  • Update components to fetch data dynamically                              │
│  • Replace ALL mock/static data with Web API calls                          │
│  • Verify no hardcoded data remains for configured tables                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 5: Build and Upload                                                   │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Build the project                                                        │
│  • Upload to Power Pages                                                    │
│  • Verify Web API is working                                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## STEP 1: Resume or Start Fresh

### Check Memory Bank First

**Before asking questions**, check if a memory bank exists:

1. If continuing from `/setup-dataverse` in the same session, use the known project path
2. Otherwise, ask the user for the project path
3. Read `<PROJECT_PATH>/memory-bank.md` if it exists
4. Extract:
   - Project name and framework
   - Tables created in `/setup-dataverse`
   - Website ID and environment URL
   - Any previously configured Web API settings

If the memory bank shows `/setup-webapi` steps already completed:

- Inform the user what was done
- Ask if they want to add more tables, modify settings, or skip to next steps

### Check Context

**If continuing from setup-dataverse:**

Show this message:

> **Ready for Web API Configuration!**
>
> Your Dataverse tables have been created. Now let's enable Web API access so your site can fetch and modify data via the `/_api` endpoint.
>
> Tables to configure: [LIST FROM MEMORY BANK]
>
> Would you like to proceed?

Use the `AskUserQuestion` tool with these options:

| Option | Description |
|--------|-------------|
| **Yes, proceed** | Configure Web API for all tables |
| **Select tables** | Choose which tables to enable for Web API |
| **Show me the command** | Display `/setup-webapi` to run later |

**If starting fresh (no prior context):**

Ask the user for:

1. Project path (where the Power Pages site is located)
2. Tables to enable for Web API (if not in memory bank)

---

## STEP 2: Create Site Settings Files

Site settings in Power Pages are stored in the `.powerpages-site/site-settings` folder. Each setting is a separate YAML file with a unique ID.

### Folder Structure

```text
<PROJECT_ROOT>/
├── .powerpages-site/
│   ├── site-settings/
│   │   ├── Webapi-cr_product-enabled.sitesetting.yml
│   │   ├── Webapi-cr_product-fields.sitesetting.yml
│   │   ├── Webapi-cr_teammember-enabled.sitesetting.yml
│   │   └── ...
│   └── ...
```

### Site Setting File Format

Each site setting file follows this YAML format:

```yaml
id: <UUID>
name: <SETTING_NAME>
value: <SETTING_VALUE>
```

**File naming convention**: `<SETTING_NAME_WITH_DASHES>.sitesetting.yml`
- Replace `/` with `-` in the setting name
- Example: Setting `Webapi/cr_product/enabled` → File `Webapi-cr_product-enabled.sitesetting.yml`

### Required Site Settings for Each Table

For each table that needs Web API access, create these settings:

#### 1. Enable Web API for Table

```yaml
# File: <PROJECT_ROOT>/.powerpages-site/site-settings/Webapi-<TABLE_LOGICAL_NAME>-enabled.sitesetting.yml
id: <GENERATE_UUID>
name: Webapi/<TABLE_LOGICAL_NAME>/enabled
value: true  # Boolean, not string
```

**Example** for `cr_product` table:

```yaml
# File: Webapi-cr_product-enabled.sitesetting.yml
id: a1b2c3d4-e5f6-7890-abcd-ef1234567890
name: Webapi/cr_product/enabled
value: true
```

#### 2. Configure Allowed Fields

**SECURITY REQUIREMENT**: Always specify explicit field names. Never use `*` as it exposes all fields including sensitive system columns. Only include fields that are needed by the frontend.

```yaml
# File: <PROJECT_ROOT>/.powerpages-site/site-settings/Webapi-<TABLE_LOGICAL_NAME>-fields.sitesetting.yml
id: <GENERATE_UUID>
name: Webapi/<TABLE_LOGICAL_NAME>/fields
value: cr_name,cr_description,cr_price,cr_imageurl,cr_isactive
```

Specify comma-separated field logical names that your frontend actually needs.

#### 3. Enable Error Details (Development Only)

For debugging purposes, enable detailed error messages:

```yaml
# File: Webapi-error-innererror.sitesetting.yml
id: <GENERATE_UUID>
name: Webapi/error/innererror
value: true  # Boolean, not string
```

**IMPORTANT**: Disable this in production by setting value to `false` or removing the setting.

### Helper Script to Create Site Settings

Use this PowerShell script to create all site settings for a table:

```powershell
function New-WebApiSiteSettings {
    param(
        [Parameter(Mandatory=$true)]
        [string]$ProjectRoot,
        [Parameter(Mandatory=$true)]
        [string]$TableLogicalName,
        [Parameter(Mandatory=$true)]
        [string]$Fields  # REQUIRED: Explicit field list (never use *)
    )

    # Security check: Never allow wildcard
    if ($Fields -eq "*") {
        throw "Security Error: Wildcard (*) is not allowed for fields. Specify explicit field names."
    }

    $siteSettingsPath = Join-Path $ProjectRoot ".powerpages-site\site-settings"

    # Create directory if it doesn't exist
    if (-not (Test-Path $siteSettingsPath)) {
        New-Item -ItemType Directory -Path $siteSettingsPath -Force | Out-Null
    }

    # Generate UUIDs
    $enabledUuid = [guid]::NewGuid().ToString()
    $fieldsUuid = [guid]::NewGuid().ToString()

    # Create enabled setting (value is boolean true, not string "true")
    $enabledContent = @"
id: $enabledUuid
name: Webapi/$TableLogicalName/enabled
value: true
"@
    $enabledFileName = "Webapi-$TableLogicalName-enabled.sitesetting.yml"
    $enabledPath = Join-Path $siteSettingsPath $enabledFileName
    Set-Content -Path $enabledPath -Value $enabledContent -Encoding UTF8
    Write-Host "Created: $enabledPath"

    # Create fields setting
    $fieldsContent = @"
id: $fieldsUuid
name: Webapi/$TableLogicalName/fields
value: $Fields
"@
    $fieldsFileName = "Webapi-$TableLogicalName-fields.sitesetting.yml"
    $fieldsPath = Join-Path $siteSettingsPath $fieldsFileName
    Set-Content -Path $fieldsPath -Value $fieldsContent -Encoding UTF8
    Write-Host "Created: $fieldsPath"

    return @{
        TableName = $TableLogicalName
        EnabledFile = $enabledFileName
        FieldsFile = $fieldsFileName
    }
}

# Example usage for multiple tables:
$projectRoot = "<PROJECT_ROOT>"  # Replace with actual path

# Configure each table with EXPLICIT field lists (never use *)
New-WebApiSiteSettings -ProjectRoot $projectRoot -TableLogicalName "cr_product" `
    -Fields "cr_name,cr_description,cr_price,cr_category,cr_imageurl,cr_isactive"

New-WebApiSiteSettings -ProjectRoot $projectRoot -TableLogicalName "cr_teammember" `
    -Fields "cr_name,cr_title,cr_email,cr_bio,cr_photourl,cr_linkedin,cr_displayorder"

New-WebApiSiteSettings -ProjectRoot $projectRoot -TableLogicalName "cr_testimonial" `
    -Fields "cr_name,cr_quote,cr_company,cr_role,cr_rating,cr_photourl,cr_isactive"

New-WebApiSiteSettings -ProjectRoot $projectRoot -TableLogicalName "cr_faq" `
    -Fields "cr_question,cr_answer,cr_category,cr_displayorder,cr_isactive"

New-WebApiSiteSettings -ProjectRoot $projectRoot -TableLogicalName "cr_contactsubmission" `
    -Fields "cr_name,cr_email,cr_message,cr_submissiondate,cr_status"
```

### Add Error Setting (One-Time)

```powershell
function New-WebApiErrorSetting {
    param(
        [string]$ProjectRoot,
        [bool]$Enabled = $true
    )

    $siteSettingsPath = Join-Path $ProjectRoot ".powerpages-site\site-settings"
    $errorUuid = [guid]::NewGuid().ToString()

    # Value is boolean true/false, not string
    $errorContent = @"
id: $errorUuid
name: Webapi/error/innererror
value: $($Enabled.ToString().ToLower())
"@
    $errorFileName = "Webapi-error-innererror.sitesetting.yml"
    $errorPath = Join-Path $siteSettingsPath $errorFileName
    Set-Content -Path $errorPath -Value $errorContent -Encoding UTF8
    Write-Host "Created error setting: $errorPath"
}

# Enable detailed errors for development
New-WebApiErrorSetting -ProjectRoot $projectRoot -Enabled $true
```

---

## STEP 3: Create Table Permissions

Table permissions (entity permissions) control which users can access data through the Web API. These must be created in Dataverse.

### Understanding Table Permissions

| Scope | Description | Use Case |
|-------|-------------|----------|
| **Global** | All records accessible | Public data (products, FAQs, testimonials) |
| **Contact** | Records linked to current contact | User-specific data |
| **Account** | Records linked to user's account | Organization data |
| **Parent** | Records linked via parent relationship | Hierarchical data |
| **Self** | Only records owned by current user | Private user data |

### Create Table Permissions via Dataverse API

```powershell
# Get environment URL and access token
$envUrl = (pac org who --json | ConvertFrom-Json).OrgUrl
$token = (az account get-access-token --resource $envUrl --query accessToken -o tsv)

$headers = @{
    "Authorization" = "Bearer $token"
    "Content-Type" = "application/json"
    "OData-MaxVersion" = "4.0"
    "OData-Version" = "4.0"
}

$baseUrl = "$envUrl/api/data/v9.2"

# First, get the Website ID
$websiteId = "<WEBSITE_ID_FROM_MEMORY_BANK>"  # Get from pac pages list

function New-TablePermission {
    param(
        [string]$Name,
        [string]$TableLogicalName,
        [string]$WebsiteId,
        [int]$Scope = 756150000,  # Global
        [bool]$Read = $true,
        [bool]$Create = $false,
        [bool]$Write = $false,
        [bool]$Delete = $false,
        [bool]$Append = $false,
        [bool]$AppendTo = $false
    )

    # Scope values:
    # 756150000 = Global
    # 756150001 = Contact
    # 756150002 = Account
    # 756150003 = Parent
    # 756150004 = Self

    $permission = @{
        "adx_entityname" = $TableLogicalName
        "adx_entitylogicalname" = $TableLogicalName
        "adx_scope" = $Scope
        "adx_read" = $Read
        "adx_create" = $Create
        "adx_write" = $Write
        "adx_delete" = $Delete
        "adx_append" = $Append
        "adx_appendto" = $AppendTo
        "adx_websiteid@odata.bind" = "/adx_websites($WebsiteId)"
    }

    $body = $permission | ConvertTo-Json -Depth 5

    try {
        $result = Invoke-RestMethod -Uri "$baseUrl/adx_entitypermissions" -Method Post -Headers $headers -Body $body
        Write-Host "Created table permission for: $TableLogicalName"
        return $result
    }
    catch {
        Write-Host "Error creating permission for $TableLogicalName : $_"
        return $null
    }
}

# Create permissions for each table (Read-only Global scope for public data)
New-TablePermission -Name "Product Read" -TableLogicalName "cr_product" -WebsiteId $websiteId -Read $true
New-TablePermission -Name "Team Member Read" -TableLogicalName "cr_teammember" -WebsiteId $websiteId -Read $true
New-TablePermission -Name "Testimonial Read" -TableLogicalName "cr_testimonial" -WebsiteId $websiteId -Read $true
New-TablePermission -Name "FAQ Read" -TableLogicalName "cr_faq" -WebsiteId $websiteId -Read $true

# For contact form submissions - users can create but not read others
New-TablePermission -Name "Contact Submission Create" -TableLogicalName "cr_contactsubmission" -WebsiteId $websiteId -Read $false -Create $true
```

### Assign Permissions to Web Roles

Table permissions must be linked to web roles. For anonymous access (unauthenticated users), link to the "Anonymous Users" web role:

```powershell
# Get the Anonymous Users web role ID
$anonymousRole = Invoke-RestMethod -Uri "$baseUrl/adx_webroles?`$filter=adx_name eq 'Anonymous Users' and _adx_websiteid_value eq $websiteId&`$select=adx_webroleid" -Headers $headers

if ($anonymousRole.value.Count -gt 0) {
    $roleId = $anonymousRole.value[0].adx_webroleid

    # Associate table permission with web role
    # First get the permission ID
    $permissions = Invoke-RestMethod -Uri "$baseUrl/adx_entitypermissions?`$filter=adx_entitylogicalname eq 'cr_product'&`$select=adx_entitypermissionid" -Headers $headers

    if ($permissions.value.Count -gt 0) {
        $permissionId = $permissions.value[0].adx_entitypermissionid

        # Create the association
        $association = @{
            "@odata.id" = "$baseUrl/adx_webroles($roleId)"
        }

        Invoke-RestMethod -Uri "$baseUrl/adx_entitypermissions($permissionId)/adx_webrole_entitypermission/`$ref" -Method Post -Headers $headers -Body ($association | ConvertTo-Json)
        Write-Host "Associated permission with Anonymous Users role"
    }
}
```

---

## STEP 4: Update Frontend Code

Now update the frontend code to use the Power Pages Web API (`/_api` endpoint) to fetch data dynamically.

**IMPORTANT: Replace ALL Mock Data**

When integrating Web APIs, you must ensure that **all mock/static data is replaced** with Web API calls:

1. **Search the codebase** for any hardcoded arrays, objects, or static data files that represent the data now stored in Dataverse tables
2. **Identify all components** that display data from the configured tables (products, team members, testimonials, FAQs, etc.)
3. **Replace each instance** with the appropriate Web API call using the data fetching patterns below
4. **Remove or comment out** the old mock data to prevent confusion
5. **Verify no static data remains** - the site should fetch all dynamic content from Dataverse

Common places to check for mock data:
- `src/data/` or `src/mock/` folders
- Constants files with hardcoded arrays
- Component files with inline data definitions
- JSON files used as data sources

### Web API Endpoint Format

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

### CSRF Token Requirement

**IMPORTANT**: Power Pages requires a CSRF (Cross-Site Request Forgery) anti-forgery token for all non-GET requests (POST, PATCH, DELETE).

- The token must be fetched from `/_layout/tokenhtml`
- Include the token in the `__RequestVerificationToken` header
- GET requests do not require this token
- The token may expire, so handle 403 errors by refreshing the token

### Create API Service (React Example)

Create a reusable API service for Web API calls:

**File: `src/services/dataverseApi.ts`**

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
export const dataverseApi = {
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

// Entity-specific services
export const productsApi = {
  getAll: (options?: QueryOptions) =>
    dataverseApi.getAll<Product>('cr_products', options),
  getById: (id: string) =>
    dataverseApi.getById<Product>('cr_products', id),
  getActive: () =>
    dataverseApi.getAll<Product>('cr_products', { filter: 'cr_isactive eq true', orderBy: 'cr_name' }),
};

export const teamMembersApi = {
  getAll: () =>
    dataverseApi.getAll<TeamMember>('cr_teammembers', { orderBy: 'cr_displayorder' }),
};

export const testimonialsApi = {
  getActive: () =>
    dataverseApi.getAll<Testimonial>('cr_testimonials', { filter: 'cr_isactive eq true' }),
};

export const faqsApi = {
  getActive: () =>
    dataverseApi.getAll<FAQ>('cr_faqs', { filter: 'cr_isactive eq true', orderBy: 'cr_displayorder' }),
};

export const contactApi = {
  submit: (data: ContactSubmission) =>
    dataverseApi.create<ContactSubmission>('cr_contactsubmissions', {
      ...data,
      cr_submissiondate: new Date().toISOString(),
      cr_status: 1, // New
    }),
};

// Type definitions
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

### Update Components to Use Web API

**Example: Products Component**

Before (static data):
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

After (Web API):
```tsx
import { useState, useEffect } from 'react';
import { productsApi, Product } from '../services/dataverseApi';

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

**Example: Contact Form**

```tsx
import { useState } from 'react';
import { contactApi, ContactSubmission } from '../services/dataverseApi';

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

### Custom React Hook for Data Fetching

Create a reusable hook for common data fetching patterns:

**File: `src/hooks/useDataverse.ts`**

```typescript
import { useState, useEffect, useCallback } from 'react';
import { dataverseApi, QueryOptions } from '../services/dataverseApi';

interface UseDataverseResult<T> {
  data: T[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useDataverse<T>(
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
      const result = await dataverseApi.getAll<T>(entitySet, options);
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
// const { data: products, loading, error } = useDataverse<Product>('cr_products', { filter: 'cr_isactive eq true' });
```

---

## STEP 5: Build and Upload

After creating site settings and updating the code, build and upload the site to Power Pages.

### Build the Project

```powershell
# Navigate to project root
cd <PROJECT_ROOT>

# Install dependencies if needed
npm install

# Build the project
npm run build
```

### Upload to Power Pages

```powershell
# Upload the site with the new site settings
pac pages upload-code-site --rootPath "<PROJECT_ROOT>"
```

### Verify the Upload

```powershell
# List sites to verify
pac pages list --verbose
```

### Test Web API Access

After uploading, test the Web API endpoints:

1. **Open browser developer tools** (F12)
2. **Navigate to your site**
3. **In the console, test a Web API call**:

```javascript
// Test anonymous GET request
fetch('/_api/cr_products')
  .then(r => r.json())
  .then(data => console.log('Products:', data.value))
  .catch(err => console.error('Error:', err));

// Test with filter
fetch('/_api/cr_products?$filter=cr_isactive eq true&$select=cr_name,cr_price')
  .then(r => r.json())
  .then(data => console.log('Active Products:', data.value))
  .catch(err => console.error('Error:', err));
```

### Common Issues and Solutions

| Issue | Solution |
|-------|----------|
| `403 Forbidden` | Table permission not configured, not linked to web role, or missing/expired CSRF token |
| `404 Not Found` | Web API not enabled for table (check site setting) |
| `400 Bad Request` | Invalid OData query syntax or field not in allowed fields |
| `500 Server Error` | Enable `Webapi/error/innererror` to see details |
| `CSRF Token Error` | Ensure `__RequestVerificationToken` header is included for POST/PATCH/DELETE requests |

### Debug Web API Issues

1. **Enable detailed errors**:
   ```yaml
   # File: Webapi-error-innererror.sitesetting.yml
   id: <uuid>
   name: Webapi/error/innererror
   value: true  # Boolean, not string
   ```

2. **Check site settings were applied**:
   - Go to Power Pages Studio
   - Navigate to Setup > Site Settings
   - Verify Web API settings are present

3. **Verify table permissions**:
   - Go to Power Pages Studio
   - Navigate to Security > Table Permissions
   - Verify permissions exist and are linked to appropriate web roles

---

## Update Memory Bank

After completing this skill, update `memory-bank.md`:

```markdown
### /setup-webapi
- [x] Site settings folder created
- [x] Web API enabled for tables: [LIST]
- [x] Table permissions created
- [x] Frontend code updated with Web API service
- [x] All mock/static data replaced with Web API calls
- [x] Project built successfully
- [x] Uploaded to Power Pages
- [x] Web API verified working

## Created Resources

### Site Settings

| Setting | Value | File |
|---------|-------|------|
| Webapi/cr_product/enabled | true | Webapi-cr_product-enabled.sitesetting.yml |
| Webapi/cr_product/fields | cr_name,cr_description,cr_price,... | Webapi-cr_product-fields.sitesetting.yml |
| Webapi/cr_teammember/enabled | true | Webapi-cr_teammember-enabled.sitesetting.yml |
| Webapi/cr_teammember/fields | cr_name,cr_title,cr_bio,... | Webapi-cr_teammember-fields.sitesetting.yml |
| [ADD MORE AS CREATED] |

### Table Permissions

| Table | Scope | Permissions | Web Role |
|-------|-------|-------------|----------|
| cr_product | Global | Read | Anonymous Users |
| cr_teammember | Global | Read | Anonymous Users |
| cr_contactsubmission | Global | Create | Anonymous Users |
| [ADD MORE AS CREATED] |

### Modified Files

| File | Changes |
|------|---------|
| src/services/dataverseApi.ts | Created Web API service |
| src/components/ProductList.tsx | Updated to use Web API |
| [ADD MORE AS MODIFIED] |

### Removed/Replaced Mock Data

| Location | Description | Replaced With |
|----------|-------------|---------------|
| src/data/products.ts | Static product array | productsApi.getActive() |
| src/data/team.json | Team member JSON | teamMembersApi.getAll() |
| [ADD MORE AS REPLACED] |

## Current Status

**Last Action**: Web API configured and site uploaded

**Next Step**: Test all Web API endpoints and verify data displays correctly

## Notes

- [DATE]: Configured Web API for [N] tables
- [DATE]: Created table permissions with Global scope for anonymous read access
```

---

## Troubleshooting

### Site Settings Not Being Applied

1. Ensure YAML files are valid (no syntax errors)
2. Verify file extension is `.yml` (not `.yaml`)
3. Check that `id` is a valid UUID
4. Re-upload the site after adding settings

### Web API Returns 403 Forbidden

1. Verify table permission exists for the entity
2. Check permission is linked to correct web role (Anonymous Users for public access)
3. Ensure user is in the appropriate web role (for authenticated access)
4. Verify permission has the correct scope (Global for public data)
5. **For POST/PATCH/DELETE**: Ensure the `__RequestVerificationToken` header is included with a valid CSRF token

### CSRF Token Issues

If you're getting 403 errors on write operations (POST, PATCH, DELETE):

1. **Fetch the token** from `/_layout/tokenhtml` endpoint
2. **Parse the token** from the HTML response (look for `value="..."`)
3. **Include in header**: Add `__RequestVerificationToken: <token>` to your request headers
4. **Token expiration**: If requests start failing, clear your cached token and fetch a new one
5. **Test manually**:
   ```javascript
   // In browser console, test token fetch
   fetch('/_layout/tokenhtml')
     .then(r => r.text())
     .then(html => {
       const match = html.match(/value="([^"]+)"/);
       console.log('Token:', match ? match[1] : 'Not found');
     });
   ```

### Web API Returns 404 Not Found

1. Verify `Webapi/<table>/enabled` site setting exists and is set to "true"
2. Check the entity set name is correct (pluralized logical name)
3. Ensure the table exists in Dataverse

### CORS Errors in Browser

Power Pages Web API should not have CORS issues when called from the same origin. If you see CORS errors:

1. Ensure you're using relative URLs (`/_api/...`) not absolute URLs
2. Check that you're not mixing HTTP and HTTPS
3. Verify the site URL matches the origin of your requests

### Data Not Displaying

1. Check browser console for JavaScript errors
2. Verify API response in Network tab
3. Test API directly in browser: `https://<site-url>/_api/<entity-set>`
4. Check that field names in code match Dataverse column logical names

---

## Reference Documentation

- [Power Pages Web API Overview](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview)
- [Web API Operations](https://learn.microsoft.com/en-us/power-pages/configure/write-update-delete-operations)
- [Site Settings Reference](https://learn.microsoft.com/en-us/power-pages/configure/configure-site-settings)
- [Table Permissions](https://learn.microsoft.com/en-us/power-pages/security/table-permissions)
- [OData Query Options](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query-data-web-api)
