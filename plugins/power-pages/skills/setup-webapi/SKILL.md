---
description: Configure Web API access, table permissions, entity permissions, and web roles for Power Pages. Use this skill when you need to set up table permissions, create entity permissions, configure web roles, enable API access, set CRUD permissions (read/write/create/delete), create site settings for Web API, or update frontend code to fetch data from Dataverse tables.
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
| [web-roles-reference.md](./web-roles-reference.md) | Web role selection, creation, and user assignment |
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
│  STEP 3: Create Web Roles                                                   │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Determine required web roles based on site features                      │
│  • Verify default roles exist (Anonymous, Authenticated, Administrators)    │
│  • Create custom roles if needed (Customers, Partners, etc.)                │
│  📖 See: web-roles-reference.md                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 4: Create Table Permissions                                           │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Create entity permission records for Web API access                      │
│  • Configure scope (Global/Parent/Self) based on requirements               │
│  • Set appropriate CRUD permissions                                         │
│  • Associate permissions with web roles from Step 3                         │
│  📖 See: table-permissions-reference.md                                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 5: Update Frontend Code                                               │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Create API service/utility for /_api calls                               │
│  • Update components to fetch data dynamically                              │
│  • Replace ALL mock/static data with Web API calls                          │
│  • Verify no hardcoded data remains for configured tables                   │
│  📖 See: frontend-integration-reference.md                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 6: Build and Upload                                                   │
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

## STEP 3: Create Web Roles

**📖 Detailed reference: [web-roles-reference.md](./web-roles-reference.md)**

### Quick Summary

Web roles define user groups with specific access levels. They must be created **before** table permissions because permissions are linked to roles.

### Key Points

- **Anonymous Users**: Unauthenticated visitors (public content, read-only)
- **Authenticated Users**: Signed-in users (member features, form submissions)
- **Administrators**: Full site management access
- **Custom roles**: Create for specific user groups (Customers, Partners, Employees)

### Determine Required Roles

Use this decision matrix:

| Site Feature | Required Role |
|--------------|---------------|
| Public landing page, product catalog | Anonymous Users |
| Contact form submission | Anonymous Users (create-only) |
| User dashboard, profile | Authenticated Users |
| Order history, support tickets | Custom role (e.g., Customers) |
| Partner portal | Custom role (e.g., Partners) |
| Admin panel | Administrators |

### Actions

1. Get environment URL and token (same as Step 2)
2. Get Website ID from memory bank or `pac pages list`
3. Verify default roles exist using `Get-WebRoles` function
4. Create custom roles if needed using `New-WebRole` function
5. Record role IDs for use in Step 4 (table permissions)

### Example: Create Custom Roles

```powershell
# For a customer portal
$customerRoleId = New-WebRole -Name "Customers" -WebsiteId $websiteId -Description "Registered customers"

# For a partner portal
$partnerRoleId = New-WebRole -Name "Partners" -WebsiteId $websiteId -Description "Business partners"
```

---

## STEP 4: Create Table Permissions

**📖 Detailed reference: [table-permissions-reference.md](./table-permissions-reference.md)**

### Quick Summary

Table permissions control which users can access data. Create via Dataverse API and link to web roles from Step 3.

### Key Points

- Use **Global scope** for public data (products, FAQs)
- Use **Self scope** for user-specific data
- Link permissions to appropriate web roles created in Step 3:
  - **Anonymous Users** for public access
  - **Authenticated Users** for logged-in users
  - **Custom roles** for specific user groups

### Common Patterns

| Data Type | Scope | Permissions | Web Role |
|-----------|-------|-------------|----------|
| Public content | Global | Read only | Anonymous Users |
| Form submissions | Global | Create only | Anonymous Users |
| User profiles | Self | Read, Write | Authenticated Users |
| Orders | Contact | Read, Write | Customers (custom) |

### Actions

1. Get environment URL and token
2. Get Website ID from memory bank or `pac pages list`
3. Get web role IDs from Step 3 or using `Get-WebRoleId` function
4. Create permissions using `New-TablePermission` function
5. Associate permissions with web roles

---

## STEP 5: Update Frontend Code

**📖 Detailed reference: [frontend-integration-reference.md](./frontend-integration-reference.md)**

### Quick Summary

Update the frontend to use Power Pages Web API instead of mock data.

**CRITICAL**: This step is NOT complete until ALL mock/static data has been replaced with Web API calls. Do not proceed to Step 6 until verification is complete.

### Key Points

- Create `webApi.ts` service with CRUD operations
- Implement CSRF token handling for write operations
- Create typed wrappers for each entity
- Replace **ALL** static/mock data with API calls
- **VERIFY** no hardcoded data remains

### CSRF Token Requirement

POST, PATCH, DELETE requests require `__RequestVerificationToken` header. The reference includes a complete token handling implementation.

### Actions

1. Create `src/services/webApi.ts` (copy from reference)
2. Create type definitions for your entities
3. Create entity-specific API wrappers
4. Optionally create `useWebApi` React hook
5. **Systematically search for ALL mock data** (see below)
6. Update each component to use Web API
7. **Delete mock data files/folders** after replacement
8. **Run verification checks** before proceeding

### Mock Data Search (REQUIRED)

You MUST search for and replace ALL mock data. Use these searches:

```powershell
# 1. Find mock data folders
Get-ChildItem -Path ./src -Directory -Recurse | Where-Object { $_.Name -match "^(mock|data|fixtures|fake|dummy)$" }

# 2. Find data files
Get-ChildItem -Path ./src -Recurse -Include "*.data.ts","*.data.js","*mock*.ts","*mock*.js"

# 3. Find inline array declarations (review each match)
Select-String -Path "src\**\*.ts","src\**\*.tsx" -Pattern "const\s+\w+\s*=\s*\[" | Where-Object { $_.Line -match "\{" }

# 4. Find JSON imports
Select-String -Path "src\**\*.ts","src\**\*.tsx" -Pattern "from ['\"].*\.json['\"]"
```

### Mock Data Verification (REQUIRED)

Before proceeding to Step 6, verify:

- [ ] No `src/data/` or `src/mock/` folders exist (or are empty)
- [ ] No `*.data.ts` or `*mock*.ts` files remain with active exports
- [ ] No components have inline hardcoded arrays for configured tables
- [ ] No JSON files are imported as data sources for configured tables
- [ ] All components displaying data use the `webApi` service
- [ ] All form components use the `webApi` service for submissions

**If any mock data remains, replace it before continuing.**

### Entity-Specific Checklist

For each table configured for Web API, verify:

| Table | Mock Data Replaced | Component Updated | Verified Working |
|-------|-------------------|-------------------|------------------|
| Products | [ ] | [ ] | [ ] |
| Team Members | [ ] | [ ] | [ ] |
| Testimonials | [ ] | [ ] | [ ] |
| FAQs | [ ] | [ ] | [ ] |
| Contact Form | [ ] | [ ] | [ ] |

---

## STEP 6: Build and Upload

### Build the Project

```powershell
cd <PROJECT_ROOT>
npm install  # if needed
npm run build
```

### Confirm Connected Account

**IMPORTANT**: Before uploading, you MUST confirm which account the user is connected with.

1. Run the following command to show the connected account:

```powershell
pac auth list
```

2. Display the connected account information to the user, including:
   - The active profile (marked with `*`)
   - The environment URL
   - The user email/account

3. Use the `AskUserQuestion` tool to confirm:

| Question | Options |
|----------|---------|
| **You are about to upload the site to the account shown above. Do you want to proceed?** | **Yes, upload to this account** - Proceed with the upload; **No, let me switch accounts** - User will run `pac auth create` to connect to a different account |

4. **Only proceed with upload after the user confirms.** If the user selects "No", guide them to authenticate to the correct account:

```powershell
# Create new authentication profile
pac auth create
```

Then run `pac auth list` again to verify and ask for confirmation again.

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

## STEP 7: Cleanup Helper Files

**📖 See: [cleanup-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/cleanup-reference.md)**

Remove any temporary helper files created during this skill's execution. Verify the setup is working before cleanup.

---

## Update Memory Bank

After completing this skill, update `memory-bank.md`:

```markdown
### /setup-webapi
- [x] Site settings folder created
- [x] Web API enabled for tables: [LIST]
- [x] Web roles verified/created
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

### Web Roles

| Role Name | Role ID | Type |
|-----------|---------|------|
| Anonymous Users | [GUID] | Default |
| Authenticated Users | [GUID] | Default |
| Customers | [GUID] | Custom |
| [ADD MORE AS CREATED] |

### Table Permissions

| Table | Scope | Permissions | Web Role |
|-------|-------|-------------|----------|
| cr_product | Global | Read | Anonymous Users |
| [ADD MORE AS CREATED] |

### Modified Files

| File | Changes |
|------|---------|
| src/services/webApi.ts | Created Power Pages Web API service |
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
