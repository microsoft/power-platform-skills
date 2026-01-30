---
name: creating-power-pages-site
description: Creates Power Pages code sites (SPAs) using React, Angular, Vue, or Astro. Use when creating sites, portals, building websites, scaffolding projects, uploading to Power Pages, or activating sites.
user-invocable: true
allowed-tools: ["Read", "Write", "Grep", "Glob", "Bash", "TodoWrite", "AskUserQuestion", "Skill", "Task"]
model: opus
---

**📋 [Shared Instructions](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Read before starting.

# Create Power Pages Code Site

**References:** [requirements](./references/requirements-reference.md) | [site-creation](./references/site-creation-reference.md) | [upload-activation](./references/upload-activation-reference.md) | [troubleshooting](./references/troubleshooting.md)

## Workflow

1. **Gather Requirements** → Ask framework, features, design preferences
2. **Create Site** → Use frontend-design skill, configure for Power Pages
3. **Preview & Approve** → User reviews site locally before upload
4. **Check Prerequisites** → Verify PAC CLI and Azure CLI
5. **Upload (Inactive)** → `pac pages upload-code-site`
6. **Activate** → Call CreateWebsite API or manual activation

---

## Step 1: Gather Requirements

Use `AskUserQuestion` to ask:
1. Site purpose and target audience
2. Framework: React (recommended), Angular, Vue, or Astro
3. Features: landing page, forms, auth, data display
4. Design preferences

**Constraint**: Only static SPA frameworks. NOT supported: Next.js, Nuxt.js, Remix, SvelteKit, Liquid.

---

## Step 2: Create the Site

1. Invoke `frontend-design` skill with Vite + no SSR constraints
2. Create `powerpages.config.json` with correct `compiledPath`
3. `npm run build`
4. Create `memory-bank.md`

---

## Step 3: Preview & Approve

1. Run `npm run dev` to start local server
2. **Ask user to preview** using `AskUserQuestion`: "Please review the site at http://localhost:xxxx. Ready to proceed with upload?"
3. User must confirm before continuing to upload

---

## Step 4: Check Prerequisites

```powershell
# PAC CLI (install if missing: dotnet tool install --global Microsoft.PowerApps.CLI.Tool)
pac help

# Azure CLI (install if missing: winget install -e --id Microsoft.AzureCLI)
az --version

# Auth
pac auth list   # create with: pac auth create
az account show # login with: az login
pac org who
```

---

## Step 5: Upload to Power Pages

1. Run `pac auth list` to show available environments
2. **Ask user which environment** to upload to using `AskUserQuestion` (show org names from auth list)
3. If needed, switch auth: `pac auth select --index <n>` or `pac auth create`
4. **Build before upload**: `npm run build`
5. `pac pages upload-code-site --rootPath "<PROJECT_ROOT>"` (creates `.powerpages-site` folder)
6. **Create AI site settings** in `.powerpages-site/site-settings/` (see [authoring-tool-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/authoring-tool-reference.md)):
   - `Site/AI/AuthoringTool` - ClaudeCodeCLI or ClaudeCodeVSCode
   - `Site/AI/CreateSite` - true (skill tracking)
7. **Build and upload again**: `npm run build && pac pages upload-code-site --rootPath "<PROJECT_ROOT>"`
8. `pac pages list --verbose` to get Website ID

---

## Step 6: Activate Website

1. Ask user for subdomain via `AskUserQuestion`
2. Get IDs: `pac org who`
3. Call CreateWebsite API via `az rest` (see [upload-activation-reference.md](./references/upload-activation-reference.md))
4. Poll operation status until complete
5. Verify: `pac pages list --verbose`
6. Fallback: Manual activation at make.powerpages.microsoft.com

Update memory-bank.md with Website ID, URL, completed steps.

Cleanup helper files per [cleanup-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/cleanup-reference.md).

---

## Optional Enhancements

After site creation, suggest these optional skills:
- `/add-seo` - Add SEO assets (meta tags, robots.txt, sitemap.xml, favicon)
- `/add-tests` - Add unit tests (Vitest) and E2E tests (Playwright)

---

## Next Steps

Suggest `/setup-dataverse` to create tables for dynamic content (forms, products, team members).
