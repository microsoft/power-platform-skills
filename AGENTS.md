# Power Platform Skills - Development Guidelines

This file provides guidance to AI Agents when working with code in this repository.

## What This Repo Is

A repository of Power Platform development workflows grouped by plugin. The legacy Claude marketplace metadata still exists, but Codex should treat each `plugins/*/skills/<skill>/` directory as an individual skill package. Each plugin has its own `AGENTS.md` with plugin-specific guidance.

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
├── AGENTS.md                 # Generic development guidelines (this file)
└── README.md                 # Repository overview
```

## Local Development

For Codex, symlink or copy the skill folder you want into `$CODEX_HOME/skills` (or `~/.codex/skills`). For the legacy packaging, you can still launch Claude Code with a plugin path:

```bash
claude --plugin-dir /path/to/plugins/<plugin-name>
```

No root-level build, lint, or test commands exist. Build/test tooling lives inside each plugin.

## Plugin Conventions

Each plugin follows this structure:

- `.claude-plugin/plugin.json` — Legacy plugin metadata (name, version, keywords)
- `.mcp.json` — MCP server configuration (optional)
- `agents/` — Agent definitions (`.md` files with YAML frontmatter)
- `skills/` — Skill definitions, each in its own subdirectory with a `SKILL.md`
- `scripts/` — Shared utility scripts referenced by skills and agents
- `references/` — Shared reference documents used by multiple skills

For Codex, `SKILL.md` frontmatter should stay minimal and focus on `name` and `description`. Some skills still contain Claude-era terminology in the body; when adapting or extending them, prefer Codex-native wording and keep the frontmatter lean.

When a legacy workflow mentions Claude-specific concepts, translate them as follows:

- `${CLAUDE_PLUGIN_ROOT}`: the plugin root directory that contains the current skill
- `AskUserQuestion`: ask the user directly in a short plain-text message
- `TaskCreate` / `TaskUpdate` / `TaskList`: maintain progress with `update_plan`
- `EnterPlanMode` / `ExitPlanMode`: present a concise plan in normal Codex conversation flow
- `Task` tool or specialist agents: do the work in the main Codex agent unless the user explicitly asks for delegation
- `/skill-name`: open the corresponding sibling skill folder and follow that workflow directly

## Code Conventions

**DRY (Don't Repeat Yourself):** Never duplicate logic across files. Each plugin has shared utilities (e.g., `scripts/lib/`) and shared reference docs (e.g., `references/`). Always check for and reuse existing helpers before writing new code. When adding shared logic, put it in the plugin's shared modules — not in individual skill directories.

## Maintaining This File

When you add new plugins or change the repository-level structure, update this file. For plugin-specific changes, update the plugin's own `AGENTS.md` (e.g., `plugins/power-pages/AGENTS.md`).

## External Documentation

- <a href="https://learn.microsoft.com/en-us/power-pages/configure/create-code-sites">Power Pages Code Sites</a>
- <a href="https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/pages">PAC CLI Reference</a>
- <a href="https://learn.microsoft.com/en-us/rest/api/power-platform/powerpages/websites/create-website">Create Website API</a>
