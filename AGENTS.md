# Power Pages Claude Plugin - Development Guidelines

This file provides instructions for Claude Code when working on this plugin.

## Official Documentation

**Always refer to official Claude Code documentation when modifying plugin structure:**

- **Skills**: https://code.claude.com/docs/en/skills
- **Plugins Reference**: https://code.claude.com/docs/en/plugins-reference

## Project Structure

```
power-pages-claude-plugin/
├── .claude-plugin/
│   └── plugin.json         # Plugin manifest (only file in this folder)
├── agents/                  # Agent persona files
├── commands/                # Command entry points
├── skills/                  # Skill workflows (SKILL.md in subdirectories)
├── shared/                  # Shared resources and documentation
└── AGENTS.md               # Architecture documentation
```

**Important**: Components must be at plugin root, not inside `.claude-plugin/`. Only `plugin.json` belongs in `.claude-plugin/`.

## When Modifying Skills

Skills use YAML frontmatter. Reference the official docs for all available fields:

```yaml
---
name: skill-name                    # Optional: defaults to directory name
description: What this skill does   # Recommended: Claude uses for auto-loading
user-invocable: true                # Optional: default true
disable-model-invocation: false     # Optional: default false
allowed-tools: Read, Bash(pac:*)    # Optional: tool restrictions
argument-hint: [project-path]       # Optional: autocomplete hint
context: fork                       # Optional: run in subagent
agent: Explore                      # Optional: subagent type
model: opus                         # Optional: model override
---
```

## When Modifying Agents

Agents support optional frontmatter:

```yaml
---
description: What this agent specializes in
capabilities: ["task1", "task2"]
---
```

## When Modifying plugin.json

Refer to https://code.claude.com/docs/en/plugins-reference for all available fields.

Required: `name`
Recommended: `version`, `description`, `author`, `license`, `keywords`

## Environment Variables

Use these in skills, hooks, and scripts:

- `${CLAUDE_PLUGIN_ROOT}` - Absolute path to plugin directory
- `${CLAUDE_SESSION_ID}` - Current session ID
- `$ARGUMENTS` - Arguments passed to skill

## Memory Bank System

This plugin uses a memory bank (`memory-bank.md`) to persist state across sessions.

- See `shared/memory-bank.md` for documentation
- Skills should read memory bank at start
- Skills should update memory bank after major steps

## Tool Restrictions

Skills in this plugin use restricted tools for security:

- `Bash(pac:*)` - PAC CLI commands only
- `Bash(az:*)` - Azure CLI commands only
- `Bash(dotnet:*)` - .NET CLI commands only

## Testing Changes

After modifying plugin files:

1. Run `claude --debug` to see plugin loading details
2. Test skill invocation with `/skill-name`
3. Verify tool restrictions work as expected

## Architecture Documentation

See `AGENTS.md` for comprehensive architecture documentation including:

- Component relationships
- Workflow diagrams
- Extension guide
- Full frontmatter reference
