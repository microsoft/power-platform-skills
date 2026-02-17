# Power Platform Skills - Development Guidelines

This file provides generic instructions for Claude Code when working on this plugin marketplace. For plugin-specific guidelines, see the `AGENTS.md` file in each plugin's folder.

## Official Documentation

**Always refer to official Claude Code documentation when modifying plugin structure:**

- **Skills**: https://code.claude.com/docs/en/skills
- **Plugins Reference**: https://code.claude.com/docs/en/plugins-reference

## Repository Structure

This repository is a **plugin marketplace** containing multiple plugins:

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

**Important**:
- The root `.claude-plugin/marketplace.json` defines the marketplace and lists available plugins
- Each plugin in `plugins/` has its own `.claude-plugin/plugin.json` manifest
- Each plugin has its own `AGENTS.md` with plugin-specific guidelines
- Plugin components (agents, commands, skills, shared) must be at the plugin root, not inside `.claude-plugin/`

## When Modifying Skills

Skills use YAML frontmatter. Reference the official docs for all available fields:

```yaml
---
name: skill-name                    # Optional: defaults to directory name
description: What this skill does   # Recommended: Claude uses for auto-loading
user-invocable: true                # Optional: default true
disable-model-invocation: false     # Optional: default false
allowed-tools: ["Read", "Write", "Grep", "Glob", "Bash", "TodoWrite", "AskUserQuestion", "Skill", "Task"]    # Optional: tool restrictions
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

## DRY Principle (Don't Repeat Yourself)

**Always follow the DRY principle when creating or modifying plugin content.**

### Guidelines

1. **Use shared reference files** for common instructions, documentation, or code that multiple skills need
2. **Create files in `shared/` folder** for content used across multiple skills
3. **Reference shared files** using `${CLAUDE_PLUGIN_ROOT}/shared/<filename>` instead of duplicating content
4. **Never copy-paste** the same instructions into multiple skill files

### When to Create a Shared File

Create a new file in `shared/` **BEFORE** adding content to skill files when:

- The same instructions apply to 2+ skills
- The content is a cross-cutting concern (applies during multiple workflows)
- The logic, script, or documentation would otherwise be duplicated
- The content describes a reusable pattern

**Decision process:**
1. Identify where the content is needed
2. If needed in multiple places → create shared file first
3. Then add references to the shared file in each skill

### Shared Resources Location

Common resources should be placed in:
- `plugins/<plugin-name>/shared/` - Plugin-specific shared files
- Reference using `${CLAUDE_PLUGIN_ROOT}/shared/<filename>`

## Meta Shared Instructions Pattern

Each plugin should have a **meta shared instructions file** (`shared/shared-instructions.md`) that aggregates all cross-cutting concerns:

```
plugins/<plugin-name>/shared/
├── shared-instructions.md    # Meta file - referenced by ALL skills
├── planning-policy.md        # Sub-instruction (example)
├── memory-bank.md            # Sub-instruction (example)
└── ...other shared files
```

**How it works:**
1. Each SKILL.md references ONLY `shared-instructions.md` at the top
2. `shared-instructions.md` references all cross-cutting sub-instructions
3. When adding new shared concerns, update only `shared-instructions.md`
4. No changes needed to individual SKILL.md files

**Example SKILL.md header:**
```markdown
---
description: What this skill does
---

**📋 Shared Instructions: [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Cross-cutting concerns.

# Skill Title
```

**Adding new shared instructions:**
1. Create the new file in `shared/` (e.g., `new-policy.md`)
2. Add a section to `shared-instructions.md` referencing it
3. Done - all skills automatically pick up the new instruction

## Testing Changes

After modifying plugin files:

1. Run `claude --debug` to see plugin loading details
2. Test skill invocation with `/skill-name`
3. Verify tool restrictions work as expected

## Adding a New Plugin

To add a new plugin to this marketplace:

1. Create a new directory under `plugins/` (e.g., `plugins/power-apps`)
2. Add `.claude-plugin/plugin.json` with required manifest fields
3. Add `AGENTS.md` with plugin-specific development guidelines
4. Add components: `agents/`, `commands/`, `skills/`, `shared/`
5. Create `shared/shared-instructions.md` for cross-cutting concerns
6. Update `marketplace.json` at root to include the new plugin
7. Update `README.md` to document the new plugin
