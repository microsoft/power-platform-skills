---
description: Configure Web API access for your Power Pages site. Creates site settings to enable table access via /_api endpoint, sets up entity permissions, and updates frontend code to use Power Pages Web API.
user-invocable: true
allowed-tools: Bash(pac:*), Bash(az:*), Bash(dotnet:*)
model: sonnet
---

# Setup Web API

This skill guides makers through configuring Web API access for their Power Pages site. It creates site settings to enable data access via the `/_api` endpoint and updates the frontend code to fetch data dynamically.

## Reference Documentation

This skill uses modular reference files for detailed instructions:

| File | Purpose |
|------|---------|
| [site-settings-reference.md](./site-settings-reference.md) | YAML format, naming conventions, PowerShell scripts |
| [table-permissions-reference.md](./table-permissions-reference.md) | Dataverse API for entity permissions, scopes, web roles |
| [frontend-integration-reference.md](./frontend-integration-reference.md) | Web API service code, React hooks, component patterns |
| [troubleshooting.md](./troubleshooting.md) | Common issues and solutions |

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
│  📖 See: site-settings-reference.md                                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 3: Create Table Permissions                                           │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Create entity permission records for Web API access                      │
│  • Configure scope (Global/Parent/Self) based on requirements               │
│  • Set appropriate CRUD permissions                                         │
│  📖 See: table-permissions-reference.md                                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 4: Update Frontend Code                                               │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Create API service/utility for /_api calls                               │
│  • Update components to fetch data dynamically                              │
│  • Replace ALL mock/static data with Web API calls                          │
│  • Verify no hardcoded data remains for configured tables                   │
│  📖 See: frontend-integration-reference.md                                  │
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

**📖 Detailed reference: [site-settings-reference.md](./site-settings-reference.md)**

### Quick Summary

For each table that needs Web API access, create two site setting files:

1. **Enable setting**: `Webapi-<table>-enabled.sitesetting.yml`
2. **Fields setting**: `Webapi-<table>-fields.sitesetting.yml`

### Key Points

- Files go in `.powerpages-site/site-settings/` folder
- Each file needs a unique UUID
- **SECURITY**: Always specify explicit field names (never use `*`)
- Optionally enable `Webapi/error/innererror` for debugging

### Actions

1. Create the site-settings folder if it doesn't exist
2. Use the PowerShell `New-WebApiSiteSettings` function from the reference
3. Create settings for each table from the memory bank
4. Create error setting for development

---

## STEP 3: Create Table Permissions

**📖 Detailed reference: [table-permissions-reference.md](./table-permissions-reference.md)**

### Quick Summary

Table permissions control which users can access data. Create via Dataverse API.

### Key Points

- Use **Global scope** for public data (products, FAQs)
- Use **Self scope** for user-specific data
- Link permissions to appropriate web roles:
  - **Anonymous Users** for public access
  - **Authenticated Users** for logged-in users

### Common Patterns

| Data Type | Scope | Permissions |
|-----------|-------|-------------|
| Public content | Global | Read only |
| Form submissions | Global | Create only |
| User profiles | Self | Read, Write |

### Actions

1. Get environment URL and token
2. Get Website ID from memory bank or `pac pages list`
3. Create permissions using `New-TablePermission` function
4. Associate permissions with web roles

---

## STEP 4: Update Frontend Code

**📖 Detailed reference: [frontend-integration-reference.md](./frontend-integration-reference.md)**

### Quick Summary

Update the frontend to use Power Pages Web API instead of mock data.

### Key Points

- Create `dataverseApi.ts` service with CRUD operations
- Implement CSRF token handling for write operations
- Create typed wrappers for each entity
- Replace **ALL** static/mock data with API calls

### CSRF Token Requirement

POST, PATCH, DELETE requests require `__RequestVerificationToken` header. The reference includes a complete token handling implementation.

### Actions

1. Create `src/services/dataverseApi.ts` (copy from reference)
2. Create type definitions for your entities
3. Create entity-specific API wrappers
4. Optionally create `useDataverse` React hook
5. Update each component to use Web API
6. Search and remove all mock data

### Mock Data Checklist

Search these locations for mock data to replace:

- [ ] `src/data/` or `src/mock/` folders
- [ ] Constants files with hardcoded arrays
- [ ] Component files with inline data
- [ ] JSON files used as data sources

---

## STEP 5: Build and Upload

### Build the Project

```powershell
cd <PROJECT_ROOT>
npm install  # if needed
npm run build
```

### Upload to Power Pages

```powershell
pac pages upload-code-site --rootPath "<PROJECT_ROOT>"
```

### Verify the Upload

```powershell
pac pages list --verbose
```

### Test Web API Access

1. Open browser developer tools (F12)
2. Navigate to your site
3. Test a Web API call in the console:

```javascript
fetch('/_api/cr_products')
  .then(r => r.json())
  .then(data => console.log('Products:', data.value))
  .catch(err => console.error('Error:', err));
```

### Troubleshooting

**📖 If you encounter issues, see: [troubleshooting.md](./troubleshooting.md)**

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
| [ADD MORE AS CREATED] |

### Table Permissions

| Table | Scope | Permissions | Web Role |
|-------|-------|-------------|----------|
| cr_product | Global | Read | Anonymous Users |
| [ADD MORE AS CREATED] |

### Modified Files

| File | Changes |
|------|---------|
| src/services/dataverseApi.ts | Created Web API service |
| [ADD MORE AS MODIFIED] |

### Removed/Replaced Mock Data

| Location | Description | Replaced With |
|----------|-------------|---------------|
| src/data/products.ts | Static product array | productsApi.getActive() |
| [ADD MORE AS REPLACED] |

## Current Status

**Last Action**: Web API configured and site uploaded

**Next Step**: Test all Web API endpoints and verify data displays correctly
```
