# AGENTS.md — Canvas Apps Plugin

This file provides guidance to AI agents when working with the **canvas-apps** plugin as Codex skills.

## What This Plugin Is

A plugin for authoring Power Apps Canvas Apps. The Canvas Authoring MCP server (`CanvasAuthoringMcpServer`) exposes tools that agents use to generate, validate, and compile Canvas App YAML files (`.pa.yaml`) in conjunction with a running coauthoring studio session.

For Codex, run these workflows in a single agent by default. Do not depend on specialist sub-agents unless the user explicitly asks for delegated work.

## Local Development

For Codex, symlink or copy the relevant `skills/*` folder into `$CODEX_HOME/skills`. For the legacy packaging, you can still test the plugin locally with:

```bash
claude --plugin-dir /path/to/plugins/canvas-apps
```

## Architecture

```
.claude-plugin/plugin.json     ← Legacy plugin metadata
AGENTS.md                      ← Plugin guidance for AI agents (this file)
CLAUDE.md                      ← Symlink → AGENTS.md
references/
  TechnicalGuide.md            ← YAML syntax, control selection, layout strategies, Power Fx patterns
  DesignGuide.md               ← Aesthetic guidelines, anti-patterns, design process
agents/
  canvas-app-planner.md        ← Legacy persona reference for planning
  canvas-screen-builder.md     ← Legacy persona reference for screen building
  canvas-edit-planner.md       ← Legacy persona reference for edit planning
  canvas-screen-editor.md      ← Legacy persona reference for screen editing
skills/
  configure-canvas-mcp/
    SKILL.md                   ← Registers the Canvas Authoring MCP server
  generate-canvas-app/
    SKILL.md                   ← Generates a complete Canvas App in a single Codex workflow
  edit-canvas-app/
    SKILL.md                   ← Edits pa.yaml source files for an existing Canvas App
  add-data-source/
    SKILL.md                   ← Guides user to add a data source or connector in Studio, then verifies
```

## Skills

| Skill | Description |
|-------|-------------|
| `configure-canvas-mcp` | Register the Canvas Authoring MCP server |
| `generate-canvas-app` | Generate a complete Canvas App from a natural language description |
| `edit-canvas-app` | Edit an existing Canvas App from a natural language description of changes |
| `add-data-source` | Guide the user to add a data source, connection, or API connector in Studio, then verify it is available |

## Codex Translation Layer

Some legacy files still mention Claude-specific orchestration. Translate them this way in Codex:

- `Task` or specialist agents means do the work in the main Codex agent
- `AskUserQuestion` means ask the user directly in a short plain-text message
- `TaskCreate` / `TaskUpdate` / `TaskList` mean maintain progress with `update_plan`
- `${CLAUDE_PLUGIN_ROOT}` means the `plugins/canvas-apps` directory

## MCP Tools

The `canvas-authoring` MCP server exposes the following tools:

| Tool | Description |
|------|-------------|
| `compile_canvas` | Validates canvas app YAML files in a directory using the Power Apps authoring service |
| `describe_api` | Gets detailed information about a specific API (connector) including its operations and parameters |
| `describe_control` | Gets detailed information about a specific Power Apps control including properties, variants, and metadata |
| `get_data_source_schema` | Gets the schema (columns and their Power Fx types) for a specific data source in the current authoring session |
| `list_apis` | Lists all available APIs (connectors) in the current authoring session |
| `list_controls` | Lists all available Power Apps controls in the current authoring session |
| `list_data_sources` | Lists all available data sources in the current authoring session |
| `sync_canvas` | Syncs the current coauthoring session state from the server to a local directory, writing all YAML files |

## Prerequisites

Before the MCP server will start, you need:

**.NET 10 SDK** — [Download from Microsoft](https://dotnet.microsoft.com/download/dotnet/10.0)
