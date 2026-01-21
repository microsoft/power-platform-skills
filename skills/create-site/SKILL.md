---
description: Create a Power Pages code site (SPA) using modern frontend frameworks like React, Angular, Vue, or Astro. Guides through design, build, upload, and activation.
user-invocable: true
allowed-tools: Bash(pac:*), Bash(az:*)
model: opus
---

# Create Power Pages Code Site

This skill guides makers through creating a complete Power Pages code site (Single Page Application) from scratch, deploying it to Power Pages, and activating it for public access.

## Memory Bank

This skill uses a **memory bank** (`memory-bank.md`) to persist context across sessions. See `${CLAUDE_PLUGIN_ROOT}/shared/memory-bank.md` for full documentation.

### Before Starting

**IMPORTANT**: Check if a memory bank exists before proceeding:

1. If the user has specified a project path, check for `<PROJECT_PATH>/memory-bank.md`
2. If found, read it to understand:
   - What steps have already been completed
   - What user preferences were chosen (framework, style, features)
   - What the current status is
3. **Skip completed steps** and resume from where the user left off
4. Inform the user: "I found your previous session. You completed [X]. Let's continue from [Y]."

### After Each Step

Update the memory bank after completing each major step. This ensures progress is saved even if the session ends unexpectedly.

## Workflow Overview

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 1: Gather Requirements                                                │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Frontend framework selection (React, Angular, Vue, Astro)                │
│  • Site features and functionality                                          │
│  • Design preferences and style                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 2: Create the Site                                                    │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Use frontend-design skill to build production-grade UI                   │
│  • Generate complete SPA with chosen framework                              │
│  • Build the project for production                                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 3: Check Prerequisites                                                │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Verify PAC CLI is installed (install if missing)                         │
│  • Verify Azure CLI is installed (install if missing)                       │
│  • Ensure authentication is configured                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 4: Upload to Power Pages (Inactive)                                   │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Use PAC CLI: pac pages upload-code-site                                  │
│  • Site uploaded in INACTIVE mode                                           │
│  • Get websiteRecordId for activation                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 5: Preview Locally                                                    │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Run the app locally to verify it works                                   │
│  • Test all features before activation                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 6: Activate Website Manually                                          │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Go to Power Pages home page → Inactive sites                             │
│  • Click Reactivate on your site                                            │
│  • Configure name and web address → Done                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## STEP 1: Gather Requirements

**IMPORTANT**: Before creating anything, you MUST ask the maker the following questions using the AskUserQuestion tool.

### Question 1: What do you want to build?

If the user has not already specified what they want to build, ask them to describe their site:

- What is the purpose of the site? (e.g., company portal, customer self-service, employee directory, event registration)
- What key functionality do they need?
- Who is the target audience?

This helps inform framework selection and feature recommendations.

### Question 2: Frontend Framework

Based on what they want to build, ask the maker which frontend framework they want to use:

| Option | Description |
|--------|-------------|
| **React (Recommended)** | Most popular choice with excellent ecosystem. Best for complex interactive UIs. |
| **Angular** | Full-featured framework by Google. Great for enterprise applications with built-in state management. |
| **Vue** | Progressive framework, easy to learn. Good balance of simplicity and power. |
| **Astro** | Modern static site generator with partial hydration. Best for content-focused sites with minimal JS. |

### Question 3: Site Features

Ask what features the maker wants in their site. Common options:

- Landing page / Hero section
- Navigation menu
- Contact form
- About page
- Services/Products showcase
- Image gallery
- Blog/News section
- User authentication (Microsoft Entra ID)
- Data display from Dataverse (Web API)

### Question 4: Design Preferences

Ask about design preferences:

- **Style**: Modern/Minimalist, Corporate/Professional, Creative/Bold, Elegant/Luxury
- **Color scheme**: Let them specify or suggest based on their brand
- **Special requirements**: Accessibility, mobile-first, specific branding guidelines

---

## STEP 2: Create the Site

After gathering requirements, use the **frontend-design skill** to create the site.

### Instructions for Site Creation

1. **Invoke the frontend-design skill** with the gathered requirements
2. The skill will create a production-grade, distinctive UI
3. Ensure the project structure follows Power Pages code site requirements

### Required Project Structure

```text
/site-project
├── src/                      # Source code
├── public/                   # Static assets
├── build/ or dist/           # Compiled output (after build)
├── package.json              # Dependencies
├── powerpages.config.json    # Power Pages configuration (create this)
└── README.md
```

### Create powerpages.config.json

After the site is created, add this configuration file:

```json
{
  "siteName": "<SITE_NAME>",
  "defaultLandingPage": "index.html",
  "compiledPath": "./build"
}
```

For Vue/Astro projects, change `compiledPath` to `"./dist"`.

### Build the Project

Run the appropriate build command:

```bash
# React (Create React App or Vite)
npm run build

# Angular
ng build --configuration production

# Vue
npm run build

# Astro
npm run build
```

### Initialize Memory Bank

After the site is created, create `memory-bank.md` in the project root:

```markdown
# Power Pages Project Memory Bank

> Last Updated: [CURRENT_TIMESTAMP]

## Project Overview

| Property | Value |
|----------|-------|
| Project Name | [SITE_NAME from powerpages.config.json] |
| Project Path | [FULL_PROJECT_PATH] |
| Framework | [CHOSEN_FRAMEWORK] |
| Created Date | [CURRENT_DATE] |
| Status | Site Created |

## User Preferences

### Design Preferences
- Style: [USER'S STYLE CHOICE]
- Color Scheme: [USER'S COLOR CHOICE]
- Special Requirements: [ANY SPECIAL REQUIREMENTS]

### Site Features
[LIST ALL FEATURES USER REQUESTED]

## Completed Steps

### /create-site
- [x] Requirements gathered
- [x] Framework selected: [FRAMEWORK]
- [x] Site created with features: [FEATURE_LIST]
- [x] powerpages.config.json created
- [x] Project built successfully
- [ ] Prerequisites verified (PAC CLI, Azure CLI)
- [ ] Uploaded to Power Pages
- [ ] Site activated

## Current Status

**Last Action**: Site created and built successfully

**Next Step**: Verify prerequisites (PAC CLI, Azure CLI) then upload to Power Pages

## Notes

- [CURRENT_DATE]: Project initialized with [FRAMEWORK] framework
```

**IMPORTANT**: Update this file after each subsequent step is completed.

---

## STEP 3: Check Prerequisites

**IMPORTANT**: Before uploading, verify that all required CLI tools are installed on the user's machine.

### Check PAC CLI

Run the following command to check if PAC CLI is installed:

```powershell
pac help
```

**If the command fails or PAC CLI is not found**, install it using .NET tool:

```powershell
dotnet tool install --global Microsoft.PowerApps.CLI.Tool
```

If installation fails, guide the user based on the error.

After installation, verify it works:

```powershell
pac help
```

### Check Azure CLI

Run the following command to check if Azure CLI is installed:

```powershell
az --version
```

**If the command fails or Azure CLI is not found**, install it using winget:

```powershell
winget install -e --id Microsoft.AzureCLI
```

After installation, the user may need to restart their terminal. Then verify it works:

```powershell
az --version
```

### Verify Authentication

Once both CLIs are installed, ensure the user is authenticated:

```powershell
# Check PAC CLI authentication
pac auth list

# If not authenticated, prompt user to authenticate
pac auth create

# Check Azure CLI authentication
az account show

# If not authenticated, prompt user to login
az login
```

### Verify Environment Connection

```powershell
pac org who
```

---

## STEP 4: Upload to Power Pages (Inactive)

### Upload Command

```powershell
pac pages upload-code-site `
  --rootPath "<PROJECT_ROOT_PATH>" `
```

**Example:**

```powershell
pac pages upload-code-site `
  --rootPath "C:\repos\my-power-pages-site" `
```

### Get Website Record ID

After upload, list sites to get the websiteRecordId:

```powershell
pac pages list --verbose
```

Note the **Website ID** (GUID) - this is needed for activation.

---

## STEP 5: Preview Locally

Before activating the site, run it locally to verify everything works correctly.

### Run the Development Server

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

### Verify the Site

1. Open the local URL (usually `http://localhost:5173` or `http://localhost:3000`)
2. Test all pages and navigation
3. Verify forms and interactive elements work
4. Check responsive design on different screen sizes

Once you're satisfied with the local preview, proceed to activate the site.

---

## STEP 6: Activate Website Manually

After uploading, your site appears as **Inactive** in Power Pages. Follow these steps to activate it manually.

### Steps to Activate

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
   - **Web address**: Choose a subdomain (e.g., `my-site` → `my-site.powerappsportals.com`)
   - Click **Done**

5. **Wait for provisioning**
   - The site will take a few minutes to provision
   - Once complete, it will appear in **Active sites**

### Verify Activation

```powershell
pac pages list --verbose
```

Your site should now show as **Active** with a URL.

**Reference**: [Reactivate a website - Microsoft Learn](https://learn.microsoft.com/en-us/power-pages/admin/reactivate-website)

### Update Memory Bank

After activation, update `memory-bank.md`:

1. Mark all `/create-site` steps as complete `[x]`
2. Add the Website ID and Site URL
3. Update status to "Site Activated"
4. Set next step to "Setup Dataverse Tables"

```markdown
### /create-site
- [x] Requirements gathered
- [x] Framework selected: [FRAMEWORK]
- [x] Site created with features: [FEATURE_LIST]
- [x] powerpages.config.json created
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

---

## Next Steps

After the site is active, suggest the maker proceed with:

### Setup Dataverse Tables

> **Recommended Next Step**: Set up Dataverse tables to store and manage your site's data.
>
> This will allow your site to:
>
> - Store contact form submissions, user feedback, and other data
> - Display dynamic content from Dataverse (products, team members, testimonials)
> - Create, update, and delete records via Web API
>
> Run `/setup-dataverse` or type "Set up Dataverse tables for my site" to continue.

### Additional Enhancements

- **Authentication**: Set up Microsoft Entra ID for user sign-in
- **Custom styling**: Further refine the design
- **Performance optimization**: Enable caching and CDN

---

## Troubleshooting

### Upload Fails with JavaScript Error

Enable JavaScript file uploads:

1. Go to Power Platform admin center
2. Navigate to Environments → [Your Environment] → Settings
3. Go to Product → Privacy + Security
4. In "Blocked Attachments", remove `js` from the list
5. Save changes

### Site Shows as Inactive After Upload

This is expected. The upload creates an INACTIVE record. Follow STEP 6 to manually activate it via the Power Pages home page.

### Site Not Appearing in Inactive Sites

- Verify the upload completed successfully
- Check you're in the correct environment
- Run `pac pages list --verbose` to confirm the site exists

### Reactivation Fails

Ensure your user has appropriate permissions:

- System Administrator or System Customizer role in the environment
- Power Pages administrator access

---

## Reference Documentation

- [Create Code Sites in Power Pages](https://learn.microsoft.com/en-us/power-pages/configure/create-code-sites)
- [Reactivate a Website](https://learn.microsoft.com/en-us/power-pages/admin/reactivate-website)
- [PAC CLI Reference](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/pages)
