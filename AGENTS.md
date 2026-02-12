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
    hooks/
      hooks.json                   ← Stop hooks: validation script + prompt-based completeness check
      scripts/validate-site.js     ← Node script validating generated sites
    skills/
      create-site/
        SKILL.md                   ← Skill definition with frontmatter (model, allowed-tools, hooks)
        assets/{react,vue,angular,astro}/  ← Framework templates with __PLACEHOLDER__ tokens
      deploy-site/
        SKILL.md                   ← Deployment skill definition
```

### Plugin Components

**Skills** (user-invocable via `/power-pages:create-site` and `/power-pages:deploy-site`):

- Defined in `SKILL.md` files with YAML frontmatter (name, description, allowed-tools, model, hooks)
- `create-site`: 7-step workflow — gather requirements, plan, scaffold from template, customize with live Playwright preview, review, deploy
- `deploy-site`: 5-step workflow — verify PAC CLI, authenticate, confirm environment, upload via `pac pages upload-code-site`, handle blocked JS attachments

**Hooks** (`hooks/hooks.json`):

- Stop hooks run when a session ends: a command hook runs `validate-site.js` and a prompt hook checks task completeness
- These are duplicated in `create-site/SKILL.md` frontmatter as a workaround for [claude-code#17688](https://github.com/anthropics/claude-code/issues/17688)

**MCP Integration**: Playwright MCP server for browser automation and live site previews during development.

### Template System

Framework templates use `__PLACEHOLDER__` tokens (e.g., `__SITE_NAME__`, `__PRIMARY_COLOR__`, `__BG_COLOR__`) that get replaced during site scaffolding. The `gitignore` file is stored without the dot prefix to avoid git interference in the plugin repo — it gets renamed to `.gitignore` during scaffolding.

### Validation Script (`validate-site.js`)

Checks generated sites for: required files (`package.json`, `.gitignore`, `powerpages.config.json`), config schema fields (`$schema`, `compiledPath`, `siteName`, `defaultLandingPage`), build/dev scripts in package.json, unreplaced `__PLACEHOLDER__` tokens, git initialization, and `src/` directory existence.

### Key Constraint

Only static SPA frameworks are supported (React, Vue, Angular, Astro). Server-rendered frameworks (Next.js, Nuxt, Remix, SvelteKit) are **not** supported.

## External Documentation

- [Power Pages Code Sites](https://learn.microsoft.com/en-us/power-pages/configure/create-code-sites)
- [PAC CLI Reference](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/pages)
