# Power Pages Plugin - Development Guidelines

This file provides instructions for Claude Code when working on the Power Pages plugin specifically.

## Overview

The Power Pages plugin helps users create and deploy Power Pages sites using modern frontend frameworks. It provides skills for:

- Creating code sites (SPAs) with React, Angular, Vue, or Astro
- Setting up Dataverse tables and schema
- Configuring Web API access and permissions
- Implementing authentication and authorization

## Tool Restrictions

Skills in this plugin use restricted tools for security:

| Tool Pattern | Purpose |
|--------------|---------|
| `Bash(pac:*)` | PAC CLI commands (Power Platform CLI) |
| `Bash(az:*)` | Azure CLI commands |
| `Bash(dotnet:*)` | .NET CLI commands |

These restrictions ensure skills can only execute Power Platform-related commands.

## Memory Bank System

This plugin uses a memory bank (`memory-bank.md`) to persist state across sessions.

**Location**: `<PROJECT_ROOT>/memory-bank.md` (in the user's project, not the plugin)

**Instructions**: See `shared/memory-bank.md` for detailed memory bank usage.

**Key Points**:
- Skills read memory bank at start to resume progress
- Skills update memory bank after major steps
- Tracks completed steps, user preferences, and created resources

## Shared Resources

This plugin's shared resources are in `shared/`:

| File | Purpose |
|------|---------|
| `shared-instructions.md` | Meta file aggregating all cross-cutting concerns |
| `planning-policy.md` | Planning requirements before major changes |
| `memory-bank.md` | Memory bank usage instructions |
| `cleanup-reference.md` | Cleanup instructions for helper files |
| `authoring-tool-reference.md` | Authoring tool site setting configuration |

### Adding New Shared Instructions

1. Create the new file in `shared/` (e.g., `new-policy.md`)
2. Add a section to `shared/shared-instructions.md` referencing it
3. Done - all skills automatically pick up the new instruction

## Skills

| Skill | Description |
|-------|-------------|
| `/create-site` | Create a Power Pages code site with modern frameworks |
| `/setup-dataverse` | Set up Dataverse tables and schema |
| `/setup-webapi` | Configure Web API access and permissions |
| `/setup-auth` | Implement authentication and authorization |

### Skill Structure

Each skill follows this structure:

```
skills/<skill-name>/
├── SKILL.md                    # Main skill workflow
├── <topic>-reference.md        # Detailed reference files
└── troubleshooting.md          # Common issues and solutions
```

### Skill Header Pattern

All skills reference the shared instructions at the top:

```markdown
---
description: What this skill does
user-invocable: true
allowed-tools: Bash(pac:*), Bash(az:*)
model: sonnet
---

**📋 Shared Instructions: [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Planning policy, memory bank, cleanup, and other cross-cutting concerns.

# Skill Title
```

## Agents

| Agent | Purpose |
|-------|---------|
| `code-site-architect` | Specialized for Power Pages code site architecture decisions |

## Power Pages Concepts

### Code Sites vs Traditional Sites

- **Code Sites**: Static SPAs (React, Angular, Vue, Astro) deployed to Azure CDN
- **Traditional Sites**: Liquid template-based sites with server-side rendering

This plugin focuses on **Code Sites** only.

### Supported Frameworks

| Framework | Build Tool | Notes |
|-----------|------------|-------|
| React | Vite | Recommended |
| Angular | Angular CLI | |
| Vue | Vite | |
| Astro | Astro | Static output only |

**NOT Supported**: Next.js, Nuxt.js, Remix, SvelteKit (require server-side rendering)

### Key APIs

| API | Endpoint | Purpose |
|-----|----------|---------|
| Web API | `/_api/<table>` | CRUD operations on Dataverse tables |
| Auth Token | `/_layout/tokenhtml` | CSRF token for write operations |
| Portal Object | `window.Microsoft.Dynamic365.Portal` | User info, roles, settings |

## Testing Changes

After modifying this plugin:

1. Run `claude --debug` to see plugin loading details
2. Test skill invocation with `/create-site`, `/setup-dataverse`, etc.
3. Verify tool restrictions work (should only allow pac, az, dotnet commands)
4. Test memory bank read/write in a sample project
