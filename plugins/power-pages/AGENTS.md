# Power Pages Plugin - Development Guidelines

This file provides instructions for Claude Code when working on the Power Pages plugin specifically.

## Overview

The Power Pages plugin helps users create and deploy Power Pages sites using modern frontend frameworks. It provides skills for:

- Creating code sites (SPAs) with React, Angular, Vue, or Astro
- Setting up Dataverse tables and schema
- Configuring Web API access and permissions
- Implementing authentication and authorization

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

### Core Skills

| Skill | Description |
|-------|-------------|
| `/create-site` | Create a Power Pages code site with modern frameworks |
| `/setup-dataverse` | Set up Dataverse tables and schema |
| `/setup-webapi` | Configure Web API permissions and site settings |
| `/integrate-webapi` | Connect frontend code to Web API (replace mock data) |
| `/setup-auth` | Implement authentication and authorization |

### Optional Enhancement Skills

| Skill | Description | After |
|-------|-------------|-------|
| `/add-seo` | Add SEO assets (meta tags, robots.txt, sitemap) | `/create-site` |
| `/add-tests` | Add unit tests (Vitest) and E2E tests (Playwright) | `/create-site` |
| `/add-sample-data` | Insert sample data with foreign key relationships | `/setup-dataverse` |

### Workflow Sequence

```
/create-site → /add-seo (optional) → /add-tests (optional)
     ↓
/setup-dataverse → /add-sample-data (optional)
     ↓
/setup-webapi → /integrate-webapi
     ↓
/setup-auth
```

### Skill Structure

Each skill follows this structure:

```
skills/<skill-name>/
├── SKILL.md                    # Main skill workflow
└── references/                 # Detailed reference files
    ├── <topic>-reference.md
    └── troubleshooting.md
```

### Skill Header Pattern

All skills reference the shared instructions at the top:

```markdown
---
name: doing-something          # Required, gerund form (verb-ing)
description: Does X for Y     # Third person, specific, <160 chars
user-invocable: true
allowed-tools: ["Read", "Write", "Grep", "Glob", "Bash", "TodoWrite", "AskUserQuestion", "Skill", "Task"]
model: opus
---

**📋 Shared Instructions: [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)**

# Skill Title
```

### Writing Clean Skills (Anti-Bloat Guidelines)

Follow these rules to keep skills concise and effective:

**DO:**
- Keep SKILL.md under 500 lines total
- Use `name` field with gerund form (e.g., `creating-power-pages-site`)
- Write descriptions in third person ("Creates X" not "This skill guides you through creating X")
- Use numbered lists for workflows instead of ASCII diagrams
- Trust Claude's intelligence - omit explanations of well-known concepts
- Use progressive disclosure: SKILL.md for workflow, reference files for details
- Link to reference files inline: `See [reference.md](./reference.md)`

**DON'T:**
- Start with "This skill/document guides/covers/describes..." (AI slop)
- Include ASCII workflow diagrams (waste 50+ lines)
- Duplicate content between "Quick Summary" and "Actions" sections
- Explain obvious concepts Claude already knows
- Add verbose tables for simple lists (use inline format instead)
- Repeat the same information in multiple places

**Example - BAD (bloated):**
```markdown
This document describes how to configure site settings for Power Pages.

## Overview
Site settings control the behavior of your Power Pages site...
[50 lines of explanation]
```

**Example - GOOD (concise):**
```markdown
## Site Settings
Create YAML files in `.powerpages-site/site-settings/`. See [site-settings-reference.md](./references/site-settings-reference.md) for format details.
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
