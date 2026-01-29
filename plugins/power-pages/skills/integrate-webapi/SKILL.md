---
name: integrating-webapi
description: Integrates Web API into frontend code, replacing mock data with Dataverse API calls. Use when connecting frontend to Web API, replacing static data, or creating API services.
user-invocable: true
allowed-tools: ["Read", "Write", "Grep", "Glob", "Bash", "AskUserQuestion"]
model: opus
---

**📋 [Shared Instructions](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Read before starting.

# Integrate Web API

**References:** [frontend-integration](./references/frontend-integration-reference.md)

Connects frontend code to Power Pages Web API, replacing all mock/static data.

## Prerequisites

- Web API permissions configured with `/setup-webapi`
- Site settings created for tables
- Table permissions and web roles configured

## Workflow

1. **Check Context** → Read memory bank, get table mapping and publisher prefix
2. **Create Web API Service** → `src/services/webApi.ts` with CSRF handling
3. **Create Type Definitions** → TypeScript interfaces for entities
4. **Create Entity Services** → Typed wrappers per table
5. **Find Mock Data** → Search for all static/mock data
6. **Replace Mock Data** → Update components to use API
7. **Delete Mock Files** → Remove unused data files
8. **Build and Upload** → Deploy and verify

---

## Step 1: Check Context

Read `memory-bank.md` for:
- Table name mapping (actual logical names and entity sets)
- Publisher prefix (for column names)
- Fields configured in site settings

---

## Step 2: Create Web API Service

Create `src/services/webApi.ts` with:
- CSRF token fetching from `/_layout/tokenhtml`
- Token caching and refresh on 403
- Generic CRUD operations (getAll, getById, create, update, delete)

See [frontend-integration-reference.md](./references/frontend-integration-reference.md#power-pages-web-api-service-typescript).

---

## Step 3: Create Type Definitions

Create `src/types/entities.ts` with interfaces for each table:

```typescript
export interface Product {
  ${prefix}_productid: string;
  ${prefix}_name: string;
  // ... fields from site settings
}
```

---

## Step 4: Create Entity Services

Create typed wrappers that include `$select` with allowed fields:

```typescript
export const productsApi = {
  getAll: () => webApi.getAll<Product>('${prefix}_products', {
    select: ['${prefix}_productid', '${prefix}_name', ...],
  }),
};
```

---

## Step 5: Find Mock Data

**CRITICAL**: Find ALL mock data before replacing.

```powershell
# Mock folders
Get-ChildItem -Path ./src -Directory -Recurse | Where-Object { $_.Name -match "^(mock|data|fixtures)$" }

# Data files
Get-ChildItem -Path ./src -Recurse -Include "*.data.ts","*mock*.ts"

# Inline arrays
Select-String -Path "src\**\*.ts","src\**\*.tsx" -Pattern "const\s+\w+\s*=\s*\[" | Where-Object { $_.Line -match "\{" }
```

---

## Step 6: Replace Mock Data

For each component using static data:

**Before:**
```tsx
const products = [{ id: 1, name: 'Widget' }];
```

**After:**
```tsx
const [products, setProducts] = useState<Product[]>([]);
useEffect(() => {
  productsApi.getActive().then(setProducts);
}, []);
```

See [frontend-integration-reference.md](./references/frontend-integration-reference.md#mock-data-replacement-guide).

---

## Step 7: Delete Mock Files

After replacing all usages:
1. Delete mock data files
2. Remove empty mock folders
3. Update barrel exports

---

## Step 8: Build and Upload

```powershell
npm run build
pac pages upload-code-site --rootPath "<PROJECT_ROOT>"
```

**Test in browser console:**
```javascript
fetch('/_api/${prefix}_products').then(r => r.json()).then(console.log)
```

Update memory-bank.md with integration status.
