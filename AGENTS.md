# Power Platform Skills - Development Guidelines

This file provides guidance to AI Agents when working with code in this repository.

## What This Repo Is

A **plugin marketplace** for Power Platform development by Microsoft. The marketplace manifest (`.claude-plugin/marketplace.json`) references individual plugins in `plugins/`. Each plugin has its own `AGENTS.md` with plugin-specific guidance.

## Repository Structure

```
power-platform-skills/
├── .claude-plugin/
│   └── marketplace.json      # Marketplace manifest (lists all available plugins)
├── plugins/                  # Directory containing individual plugins
│   └── <plugin-name>/        # Individual plugin (e.g., power-pages)
│       ├── .claude-plugin/
│       │   └── plugin.json   # Plugin manifest
│       ├── AGENTS.md         # Plugin-specific development guidelines
│       ├── agents/           # Agent persona files
│       ├── commands/         # Command entry points
│       ├── shared/           # Shared resources and documentation
│       └── skills/           # Skill workflows (SKILL.md in subdirectories)
├── shared/                   # Cross-plugin shared resources
│   └── skills/               # Shared skill definitions
│       └── <skill-name>/     # SKILL.template.md + workflow .md files
├── AGENTS.md                 # Generic development guidelines (this file)
└── README.md                 # Repository overview
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

Skills are defined in `SKILL.md` files with YAML frontmatter (name, description, allowed-tools, model, hooks). The `allowed-tools` field must use a **comma-separated list** (e.g., `allowed-tools: Read, Write, Edit, Bash, Glob, Grep`) — not JSON array syntax (`["Read", "Write"]`) or YAML list syntax. Each skill may include validation scripts in a `scripts/` subdirectory, run as Stop hooks when the skill session ends.

## Cross-Plugin Shared Skills

Skills that apply to all plugins live in `shared/skills/<skill-name>/`. The workflow logic is written once in a shared `.md` file, and each plugin has a thin `skills/<skill-name>/SKILL.md` that contains only the YAML frontmatter and a reference to the shared workflow file.

**Pattern:**
- `shared/skills/<skill-name>/<workflow>.md` — Full workflow (phases, instructions, field definitions)
- `shared/skills/<skill-name>/SKILL.template.md` — Template SKILL.md (frontmatter + reference to workflow); supports `{{PLUGIN_NAME}}` placeholder
- `plugins/<plugin>/skills/<skill-name>/SKILL.md` — Per-plugin wrapper generated from the template above

This keeps the skill discoverable in each plugin while avoiding content duplication. When updating a shared skill, edit the workflow file and/or `SKILL.template.md` in `shared/`, then update the per-plugin wrappers (frontmatter + reference pointing to the shared workflow, with `{{PLUGIN_NAME}}` substituted) and commit them alongside the shared change.

## Code Conventions

**DRY (Don't Repeat Yourself):** Never duplicate logic across files. Each plugin has shared utilities (e.g., `scripts/lib/`) and shared reference docs (e.g., `references/`). Always check for and reuse existing helpers before writing new code. When adding shared logic, put it in the plugin's shared modules — not in individual skill directories.

## Maintaining This File

When you add new plugins or change the repository-level structure, update this file. For plugin-specific changes, update the plugin's own `AGENTS.md` (e.g., `plugins/power-pages/AGENTS.md`).

## External Documentation

- <a href="https://learn.microsoft.com/en-us/power-pages/configure/create-code-sites">Power Pages Code Sites</a>
- <a href="https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/pages">PAC CLI Reference</a>
- <a href="https://learn.microsoft.com/en-us/rest/api/power-platform/powerpages/websites/create-website">Create Website API</a>
