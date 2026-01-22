# Site Creation Reference

This document describes how to create the site using the frontend-design skill and configure it for Power Pages.

## Using the Frontend-Design Skill

After gathering requirements, use the **frontend-design skill** to create the site.

### Instructions

1. **Invoke the frontend-design skill** with the gathered requirements
2. The skill will create a production-grade, distinctive UI
3. Ensure the project structure follows Power Pages code site requirements

### Critical Constraints

When invoking the frontend-design skill, explicitly specify:

- Use **Vite** as the build tool for React/Vue projects
- Use **Create React App** only if Vite is not preferred
- **DO NOT use Next.js, Nuxt.js, Remix, or any SSR framework**
- **DO NOT use Liquid templates** - they are not supported in code sites
- The output must be **purely static files** (HTML, CSS, JS) that can be served from a CDN

## Required Project Structure

```text
/site-project
├── src/                      # Source code
├── public/                   # Static assets
├── build/ or dist/           # Compiled output (after build)
├── package.json              # Dependencies
├── powerpages.config.json    # Power Pages configuration (create this)
└── README.md
```

## powerpages.config.json

Create this configuration file in the project root:

```json
{
  "siteName": "<SITE_NAME>",
  "defaultLandingPage": "index.html",
  "compiledPath": "./build"
}
```

### Framework-Specific compiledPath

| Framework | compiledPath |
|-----------|--------------|
| React (Vite) | `"./dist"` |
| React (CRA) | `"./build"` |
| Vue | `"./dist"` |
| Angular | `"./dist/<project-name>"` |
| Astro | `"./dist"` |

## Build Commands

Run the appropriate build command for your framework:

```powershell
# React (Create React App or Vite)
npm run build

# Angular
ng build --configuration production

# Vue
npm run build

# Astro
npm run build
```

## Memory Bank Initialization

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
- [x] SEO assets added (meta tags, favicon, robots.txt, sitemap.xml)
- [x] Unit tests written and passing
- [x] E2E tests written and passing (Playwright)
- [x] Project built successfully
- [ ] Prerequisites verified (PAC CLI, Azure CLI)
- [ ] Uploaded to Power Pages
- [ ] Site activated

## Current Status

**Last Action**: Site created, all tests passing, and built successfully

**Next Step**: Verify prerequisites (PAC CLI, Azure CLI) then upload to Power Pages

## Notes

- [CURRENT_DATE]: Project initialized with [FRAMEWORK] framework
```

**Update this file after each subsequent step is completed.**
