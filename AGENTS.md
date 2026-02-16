# AGENTS.md

This file provides guidance to AI Agents when working with code in this repository.

## What This Repo Is

A **plugin marketplace** for Power Platform development by Microsoft. The marketplace manifest (`.claude-plugin/marketplace.json`) references individual plugins in `plugins/`. Each plugin has its own `AGENTS.md` with plugin-specific guidance.

## Repository Structure

```
.claude-plugin/marketplace.json    ← Marketplace manifest listing all plugins
plugins/
  power-pages/                     ← Power Pages plugin (see plugins/power-pages/AGENTS.md)
```

## Local Development

Test a plugin locally by launching your AI agent with the plugin path:

```bash
claude --plugin-dir /path/to/plugins/<plugin-name>
```

No root-level build, lint, or test commands exist. Build/test tooling lives inside each plugin.

## Plugin Conventions

Each plugin follows this structure:

- `.claude-plugin/plugin.json` — Plugin metadata (name, version, keywords)
- `.mcp.json` — MCP server configuration (optional)
- `agents/` — Agent definitions (`.md` files with YAML frontmatter)
- `skills/` — Skill definitions, each in its own subdirectory with a `SKILL.md`
- `scripts/` — Shared utility scripts referenced by skills and agents
- `references/` — Shared reference documents used by multiple skills

Skills are defined in `SKILL.md` files with YAML frontmatter (name, description, allowed-tools, model, hooks). Each skill may include validation scripts in a `scripts/` subdirectory, run as Stop hooks when the skill session ends.

## Maintaining This File

When you add new plugins or change the repository-level structure, update this file. For plugin-specific changes, update the plugin's own `AGENTS.md` (e.g., `plugins/power-pages/AGENTS.md`).

## External Documentation

- <a href="https://learn.microsoft.com/en-us/power-pages/configure/create-code-sites">Power Pages Code Sites</a>
- <a href="https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/pages">PAC CLI Reference</a>
- <a href="https://learn.microsoft.com/en-us/rest/api/power-platform/powerpages/websites/create-website">Create Website API</a>
