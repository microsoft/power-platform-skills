---
description: Create a Power Pages code site, website, portal, or SPA using modern frontend frameworks like React, Angular, Vue, or Astro. Use this skill when you need to create a new Power Pages site, build a website, set up a portal, scaffold a project, design pages, upload site to Power Pages, or activate a site for public access.
user-invocable: true
allowed-tools: Bash(pac:*), Bash(az:*)
model: opus
---

# Create Power Pages Code Site

This skill guides makers through creating a complete Power Pages code site (Single Page Application) from scratch, deploying it to Power Pages, and activating it for public access.

## Reference Documentation

This skill uses modular reference files for detailed instructions:

| File | Purpose |
|------|---------|
| [requirements-reference.md](./requirements-reference.md) | Framework options, features, design preferences |
| [site-creation-reference.md](./site-creation-reference.md) | Project structure, powerpages.config.json, memory bank |
| [seo-reference.md](./seo-reference.md) | Meta tags, robots.txt, sitemap.xml, favicons |
| [testing-reference.md](./testing-reference.md) | Unit tests (Vitest) and E2E tests (Playwright) |
| [upload-activation-reference.md](./upload-activation-reference.md) | Prerequisites, PAC CLI upload, API activation |
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
│  • Add SEO assets (meta tags, robots.txt, sitemap.xml, favicon)             │
│  • Write unit tests for components and utilities                            │
│  • Write end-to-end tests with Playwright                                   │
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
│  STEP 6: Activate Website                                                   │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Ask user for subdomain preference                                        │
│  • Call Power Platform CreateWebsite API via az rest                        │
│  • Monitor operation status until complete                                  │
│  • Fallback: Manual activation via Power Pages portal                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## STEP 1: Gather Requirements

**📖 Detailed reference: [requirements-reference.md](./requirements-reference.md)**

**IMPORTANT**: Before creating anything, ask the maker the following questions using the AskUserQuestion tool.

### Questions to Ask

1. **What do you want to build?** - Site purpose, key functionality, target audience
2. **Frontend framework** - React (recommended), Angular, Vue, or Astro
3. **Site features** - Landing page, navigation, forms, authentication, data display
4. **Design preferences** - Style, color scheme, special requirements

### Key Points

- Only use frameworks that build to static HTML/CSS/JS files
- **NOT supported**: Next.js, Nuxt.js, Remix, SvelteKit, Liquid templates
- Power Pages code sites are static SPAs served from Azure CDN

---

## STEP 2: Create the Site

**📖 Detailed references:**
- [site-creation-reference.md](./site-creation-reference.md) - Project structure, config
- [seo-reference.md](./seo-reference.md) - Meta tags, robots.txt, sitemap.xml
- [testing-reference.md](./testing-reference.md) - Unit and E2E tests

### Quick Summary

1. **Invoke the frontend-design skill** with gathered requirements
2. **Create powerpages.config.json** in project root
3. **Add SEO assets** - meta tags, robots.txt, sitemap.xml, favicons
4. **Write unit tests** - components, utilities, hooks
5. **Write E2E tests** - Playwright for critical user journeys
6. **Build the project** - `npm run build`
7. **Initialize memory bank** - Create `memory-bank.md`

### Actions

1. Use frontend-design skill with explicit constraints (Vite, no SSR)
2. Create `powerpages.config.json` with correct `compiledPath`
3. Add meta tags to index.html (see seo-reference.md)
4. Create robots.txt and sitemap.xml in public folder
5. Set up Vitest and write unit tests
6. Set up Playwright and write E2E tests
7. Run all tests - **all must pass before proceeding**
8. Build the project
9. Create memory-bank.md

---

## STEP 3: Check Prerequisites

**📖 Detailed reference: [upload-activation-reference.md](./upload-activation-reference.md)**

### Quick Summary

Verify CLI tools are installed and authenticated before uploading.

### Actions

1. Check PAC CLI: `pac help`
   - If missing: `dotnet tool install --global Microsoft.PowerApps.CLI.Tool`

2. Check Azure CLI: `az --version`
   - If missing: `winget install -e --id Microsoft.AzureCLI`

3. Verify authentication:
   - `pac auth list` (create with `pac auth create` if needed)
   - `az account show` (login with `az login` if needed)

4. Verify environment: `pac org who`

---

## STEP 4: Upload to Power Pages (Inactive)

**📖 Detailed reference: [upload-activation-reference.md](./upload-activation-reference.md)**

### Quick Summary

Upload the built site to Power Pages as an inactive site.

### Actions

1. **Confirm account**: Run `pac auth list` and ask user to confirm
2. **Upload**: `pac pages upload-code-site --rootPath "<PROJECT_ROOT>"`
3. **Get Website ID**: `pac pages list --verbose`

---

## STEP 5: Preview Locally

**📖 Detailed reference: [upload-activation-reference.md](./upload-activation-reference.md)**

### Quick Summary

Run the site locally to verify everything works before activation.

### Actions

1. Run dev server: `npm run dev` (or framework-specific command)
2. Test all pages and navigation
3. Verify forms and interactive elements
4. Check responsive design

---

## STEP 6: Activate Website

**📖 Detailed reference: [upload-activation-reference.md](./upload-activation-reference.md)**

### Quick Summary

Activate the uploaded site using Power Platform API or manual activation.

### Actions

1. **Ask for subdomain** using AskUserQuestion tool
2. **Get IDs**: `pac org who` for environment and organization IDs
3. **Activate via API**: Use `az rest` to call CreateWebsite API
4. **Monitor status**: Poll operation URL until complete
5. **Verify**: `pac pages list --verbose` to confirm active status
6. **Fallback**: Manual activation via make.powerpages.microsoft.com if API fails

### Update Memory Bank

After activation, update memory-bank.md with:
- Website ID
- Site URL
- All completed steps marked `[x]`
- Next step: `/setup-dataverse`

### Cleanup Helper Files

**📖 See: [cleanup-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/cleanup-reference.md)**

Remove any temporary helper files created during this skill's execution.

---

## Next Steps

After the site is active, suggest the maker proceed with:

### Setup Dataverse Tables

> **Recommended Next Step**: Set up Dataverse tables to store and manage your site's data.
>
> This will allow your site to:
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

**📖 Detailed reference: [troubleshooting.md](./troubleshooting.md)**

Common issues covered:
- Upload fails with JavaScript error
- Site shows as inactive after upload
- Next.js or SSR framework used
- Liquid templates not working
- Unit tests failing
- E2E tests failing
- Authentication issues
- Build issues
