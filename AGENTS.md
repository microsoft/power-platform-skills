# AGENTS.md

This file provides guidance to AI Agents when working with code in this repository.

## What This Repo Is

A **plugin marketplace** for Power Platform development by Microsoft. The marketplace manifest (`.claude-plugin/marketplace.json`) references individual plugins in `plugins/`. Currently the only plugin is **power-pages**.

## Local Development

Test a plugin locally by launching Claude Code with the plugin path:

```bash
claude --plugin-dir /path/to/plugins/power-pages
```

No root-level build, lint, or test commands exist. Each framework template under `plugins/power-pages/skills/create-site/assets/{react,vue,angular,astro}/` has its own `package.json` with `dev`, `build`, and `preview` scripts (Vite for React/Vue, Angular CLI for Angular, Astro CLI for Astro).

## Architecture

```
.claude-plugin/marketplace.json    ← Marketplace manifest listing all plugins
plugins/
  power-pages/
    .claude-plugin/plugin.json     ← Plugin metadata (name, version, keywords)
    .mcp.json                      ← MCP server config (Playwright for browser automation)
    agents/
      data-model-architect.md      ← Agent: proposes Dataverse data models (read-only)
    hooks/
      scripts/validate-site.js     ← Node script validating generated sites
      scripts/validate-datamodel.js ← Node script validating Dataverse data model creation
      scripts/validate-seo.js    ← Node script validating SEO assets (robots.txt, sitemap.xml, meta tags)
    skills/
      create-site/
        SKILL.md                   ← Skill definition with frontmatter (model, allowed-tools, hooks)
        assets/{react,vue,angular,astro}/  ← Framework templates with __PLACEHOLDER__ tokens
      deploy-site/
        SKILL.md                   ← Deployment skill definition
      setup-datamodel/
        SKILL.md                   ← Dataverse data model creation skill definition
        references/odata-api-patterns.md  ← OData API body templates for table/column/relationship creation
      add-sample-data/
        SKILL.md                   ← Sample data insertion skill definition
        references/odata-record-patterns.md  ← OData API patterns for record creation and lookups
      add-seo/
        SKILL.md                   ← SEO essentials skill definition (robots.txt, sitemap.xml, meta tags)
```

### Plugin Components

**Agents** (auto-triggered by the main conversation when relevant):

- `data-model-architect`: Read-only agent that analyzes site requirements, discovers existing Dataverse tables via OData API, and proposes a data model (new/modified/reused tables + Mermaid ER diagram). Uses `pac env who` + Azure CLI auth to query Dataverse. Renders the ER diagram visually in the browser via Playwright (writes a temp HTML file with Mermaid.js CDN, navigates to it, takes a screenshot) before entering plan mode. Does NOT create, modify, or delete any tables — purely advisory. The main conversation uses its output to create tables.

**Skills** (user-invocable via `/power-pages:create-site`, `/power-pages:deploy-site`, `/power-pages:setup-datamodel`, `/power-pages:add-sample-data`, and `/power-pages:add-seo`):

- Defined in `SKILL.md` files with YAML frontmatter (name, description, allowed-tools, model, hooks)
- `create-site`: 7-step workflow — gather requirements, plan, scaffold from template, customize with live Playwright preview, review, deploy
- `deploy-site`: 5-step workflow — verify PAC CLI, authenticate, confirm environment, upload via `pac pages upload-code-site`, handle blocked JS attachments
- `setup-datamodel`: 7-step workflow — verify prerequisites, invoke data-model-architect agent, review proposal, pre-creation checks, create tables & columns via OData API, create relationships, publish & verify. Writes `.datamodel-manifest.json` for hook validation.
- `add-sample-data`: 6-step workflow — verify prerequisites, discover tables (from `.datamodel-manifest.json` or OData API), select tables & configure record count, generate & review sample data plan, insert records via OData API with relationship handling, verify & summarize.
- `add-seo`: 7-step workflow — verify site exists, gather SEO config (production URL, exclusions, meta description), plan & approve, create robots.txt, generate sitemap.xml from discovered routes, add meta tags (title, description, viewport, Open Graph, Twitter Card, favicon) to index.html, verify via Playwright & commit.

**Hooks** (defined in each skill's SKILL.md frontmatter):

- Stop hooks run when a skill session ends. Each skill defines its own hooks so validation only runs in the correct context:
  - `create-site`: command hook runs `validate-site.js` + prompt hook checks site completeness
  - `setup-datamodel`: command hook runs `validate-datamodel.js` + prompt hook checks data model completeness
  - `add-sample-data`: prompt hook checks sample data insertion completeness
  - `add-seo`: command hook runs `validate-seo.js` + prompt hook checks SEO asset completeness
- Hooks are defined in SKILL.md frontmatter (not a global hooks.json) so they only fire for the relevant skill session

**MCP Integration**: Playwright MCP server for browser automation and live site previews during development.

### Template System

Framework templates use `__PLACEHOLDER__` tokens (e.g., `__SITE_NAME__`, `__PRIMARY_COLOR__`, `__BG_COLOR__`) that get replaced during site scaffolding. The `gitignore` file is stored without the dot prefix to avoid git interference in the plugin repo — it gets renamed to `.gitignore` during scaffolding.

### Validation Script (`validate-site.js`)

Checks generated sites for: required files (`package.json`, `.gitignore`, `powerpages.config.json`), config schema fields (`$schema`, `compiledPath`, `siteName`, `defaultLandingPage`), build/dev scripts in package.json, unreplaced `__PLACEHOLDER__` tokens, git initialization, and `src/` directory existence.

### Validation Script (`validate-datamodel.js`)

Checks created Dataverse data models by reading `.datamodel-manifest.json` (written by the `setup-datamodel` skill during table creation). Queries the Dataverse OData API to verify each table and column in the manifest actually exists in the environment. Gracefully exits 0 on auth errors (doesn't block if token expired) or when no manifest is found (not a data model session).

### Validation Script (`validate-seo.js`)

Checks SEO assets added to Power Pages sites: verifies `robots.txt` exists in `public/` with proper `User-agent` and `Sitemap` directives, `sitemap.xml` exists with `<urlset>` and `<loc>` entries (no unreplaced placeholders), and `index.html` has `meta description` and `viewport` tags. Only runs validation when at least one SEO file (robots.txt or sitemap.xml) is detected — gracefully exits 0 otherwise to avoid blocking non-SEO sessions.

### Key Constraint

Only static SPA frameworks are supported (React, Vue, Angular, Astro). Server-rendered frameworks (Next.js, Nuxt, Remix, SvelteKit) are **not** supported.

## Maintaining This File

When you make significant changes to the repository (new plugins, skills, hooks, templates, or architectural shifts), update this file to keep it accurate for future agents.

## External Documentation

- [Power Pages Code Sites](https://learn.microsoft.com/en-us/power-pages/configure/create-code-sites)
- [PAC CLI Reference](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/pages)
