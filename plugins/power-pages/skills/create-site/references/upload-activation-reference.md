# Upload and Activation Reference

## Prerequisites

### Check PAC CLI

```powershell
pac help
```

**If not found**, install using .NET tool:

```powershell
dotnet tool install --global Microsoft.PowerApps.CLI.Tool
```

Verify after installation:

```powershell
pac help
```

### Check Azure CLI

```powershell
az --version
```

**If not found**, install using winget:

```powershell
winget install -e --id Microsoft.AzureCLI
```

Restart terminal after installation, then verify:

```powershell
az --version
```

### Verify Authentication

```powershell
# Check PAC CLI authentication
pac auth list

# If not authenticated
pac auth create

# Check Azure CLI authentication
az account show

# If not authenticated
az login
```

### Verify Environment Connection

```powershell
pac org who
```

---

## Upload to Power Pages

### Create Authoring Tool Site Setting

**Before uploading**, create a site setting to track which Claude Code tool created the site.

**📖 See: [authoring-tool-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/authoring-tool-reference.md)**

Follow the instructions in the shared reference to create the `Site/AuthoringTool` setting with value `ClaudeCodeCLI` or `ClaudeCodeVSCode` based on the environment.

### Confirm Connected Account

**Before uploading**, confirm the connected account:

```powershell
pac auth list
```

Display the account information:
- Active profile (marked with `*`)
- Environment URL
- User email/account

Ask user to confirm before proceeding. If they need to switch accounts:

```powershell
pac auth create
```

### Upload Command

```powershell
pac pages upload-code-site --rootPath "<PROJECT_ROOT_PATH>"
```

**Example:**

```powershell
pac pages upload-code-site --rootPath "C:\repos\my-power-pages-site"
```

### Get Website Record ID

After upload, list sites to get the websiteRecordId:

```powershell
pac pages list --verbose
```

Note the **Website ID** (GUID) - this is needed for activation.

---

## Preview Locally

Before activating, run the site locally to verify everything works:

```powershell
# React (Vite)
npm run dev

# React (Create React App)
npm start

# Angular
ng serve

# Vue
npm run dev

# Astro
npm run dev
```

Verify:
1. Open the local URL (usually `http://localhost:5173` or `http://localhost:3000`)
2. Test all pages and navigation
3. Verify forms and interactive elements work
4. Check responsive design on different screen sizes

---

## Activate Website

After uploading, your site appears as **Inactive** in Power Pages. Activate it using the Power Platform API.

### Ask for Subdomain

Before activating, ask the user for their preferred subdomain:
- The URL prefix for their site (e.g., `my-site` → `my-site.powerappsportals.com`)
- Subdomain must be unique, lowercase, and contain only letters, numbers, and hyphens

### Get Required IDs

```powershell
pac org who
```

Note:
- **Environment ID** - The GUID of the environment
- **Organization ID** - The Dataverse organization ID

### Activate via API

```powershell
# Set variables (replace with actual values)
$environmentId = "<ENVIRONMENT_ID>"
$organizationId = "<ORGANIZATION_ID>"
$websiteRecordId = "<WEBSITE_RECORD_ID_FROM_UPLOAD>"
$siteName = "<SITE_NAME>"
$subdomain = "<USER_CHOSEN_SUBDOMAIN>"

# Create request body
$body = @{
    dataverseOrganizationId = $organizationId
    name = $siteName
    selectedBaseLanguage = 1033
    subdomain = $subdomain
    templateName = "DefaultPortalTemplate"
    websiteRecordId = $websiteRecordId
} | ConvertTo-Json -Compress

# Call CreateWebsite API
az rest `
    --method POST `
    --url "https://api.powerplatform.com/powerpages/environments/$environmentId/websites?api-version=2022-03-01-preview" `
    --resource "https://api.powerplatform.com" `
    --body $body `
    --headers "Content-Type=application/json" `
    --verbose
```

The `--resource` flag automatically handles authentication using your Azure CLI credentials.

### Monitor Activation Status

The API returns a `202 Accepted` response with an `Operation-Location` header. Poll this URL to check activation status:

```powershell
# Check operation status (URL from Operation-Location header)
$operationUrl = "<OPERATION_LOCATION_URL>"

az rest `
    --method GET `
    --url $operationUrl `
    --resource "https://api.powerplatform.com"
```

Wait until the operation status shows as completed (typically 2-5 minutes).

### Verify Activation

```powershell
pac pages list --verbose
```

Your site should now show as **Active** with a URL.

**API Reference**: [CreateWebsite API - Microsoft Learn](https://learn.microsoft.com/en-us/rest/api/power-platform/powerpages/websites/create-website)

---

## Fallback: Manual Activation

If the API activation fails (e.g., permissions issues, network errors), activate manually:

1. **Go to Power Pages home page**
   - Navigate to [make.powerpages.microsoft.com](https://make.powerpages.microsoft.com)
   - Select your environment

2. **Find your inactive site**
   - Click on **Inactive sites** in the left navigation
   - Your uploaded site will appear in the list

3. **Reactivate the site**
   - Click the **Reactivate** button next to your site

4. **Configure site details**
   - **Website name**: Enter or confirm the display name
   - **Web address**: Enter the subdomain chosen earlier
   - Click **Done**

5. **Wait for provisioning**
   - The site will take a few minutes to provision
   - Once complete, it will appear in **Active sites**

**Reference**: [Reactivate a website - Microsoft Learn](https://learn.microsoft.com/en-us/power-pages/admin/reactivate-website)

---

## Update Memory Bank

After activation, update `memory-bank.md`:

```markdown
### /create-site
- [x] Requirements gathered
- [x] Framework selected: [FRAMEWORK]
- [x] Site created with features: [FEATURE_LIST]
- [x] powerpages.config.json created
- [x] SEO assets added (meta tags, favicon, robots.txt, sitemap.xml)
- [x] Unit tests written and passing
- [x] E2E tests written and passing (Playwright)
- [x] Project built successfully
- [x] Prerequisites verified (PAC CLI, Azure CLI)
- [x] Uploaded to Power Pages (Inactive)
- [x] Site activated
- Website ID: [GUID_FROM_PAC_PAGES_LIST]
- Site URL: [URL_FROM_ACTIVATION]

## Current Status

**Last Action**: Site activated successfully

**Next Step**: Run `/setup-dataverse` to create Dataverse tables for your site
```
