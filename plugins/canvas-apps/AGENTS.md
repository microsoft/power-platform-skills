# AGENTS.md — Canvas Apps Plugin

This file provides guidance to AI Agents when working with the **canvas-apps** plugin.

## What This Plugin Is

A plugin for authoring Power Apps Canvas Apps. The Canvas Authoring MCP server (`CanvasAuthoringMcpServer`) exposes tools that agents use to generate, validate, and compile Canvas App YAML files (`.pa.yaml`) in conjunction with a running coauthoring studio session. The Power Apps Studio browser tab must remain open for the duration of the session — closing it ends the coauthoring session, which breaks `compile_canvas` and `sync_canvas` operations.

Skills orchestrate specialist agents via the `Task` tool. Agents are not invoked directly by users.

## Local Development

Test this plugin locally:

```bash
claude --plugin-dir /path/to/plugins/canvas-apps
```

## Architecture

```
.claude-plugin/plugin.json     ← Plugin metadata (name, version, keywords)
AGENTS.md                      ← Plugin guidance for AI agents (this file)
CLAUDE.md                      ← Symlink → AGENTS.md
references/
  TechnicalGuide.md            ← YAML syntax, control selection, layout strategies, Power Fx patterns
  DesignGuide.md               ← Aesthetic guidelines, anti-patterns, design process
agents/
  canvas-app-planner.md        ← Plans app design; invoked by generate-canvas-app (sequential)
  canvas-screen-builder.md     ← Builds one screen; invoked by generate-canvas-app (parallel)
  canvas-edit-planner.md       ← Plans complex edits; invoked by edit-canvas-app (sequential)
  canvas-screen-editor.md      ← Applies edits to one screen; invoked by edit-canvas-app (parallel)
skills/
  configure-canvas-mcp/
    SKILL.md                   ← Registers the Canvas Authoring MCP server with Claude Code
  generate-canvas-app/
    SKILL.md                   ← Orchestrates canvas-app-planner + canvas-screen-builder agents
  edit-canvas-app/
    SKILL.md                   ← Edits pa.yaml source files for an existing Canvas App
  add-data-source/
    SKILL.md                   ← Guides user to add a data source or connector in Studio, then verifies
```

## Skills

| Skill | Description |
|-------|-------------|
| `/configure-canvas-mcp` | Register the Canvas Authoring MCP server with Claude Code |
| `/generate-canvas-app` | Generate a complete Canvas App from a natural language description |
| `/edit-canvas-app` | Edit an existing Canvas App from a natural language description of changes |
| `/add-data-source` | Guide the user to add a data source, connection, or API connector in Studio, then verify it is available |

## Agents

Agents are invoked by skills via the `Task` tool — they are not user-invocable.

| Agent | Invoked By | Description |
|-------|-----------|-------------|
| `canvas-app-planner` | `generate-canvas-app` | Discovers resources, designs the app, presents plan for approval, writes plan document |
| `canvas-screen-builder` | `generate-canvas-app` | Writes YAML for one screen based on the plan; runs in parallel with other builders; app validation/compilation is performed later by `generate-canvas-app` using `compile_canvas` |
| `canvas-edit-planner` | `edit-canvas-app` | Reads existing .pa.yaml files, plans complex edits, presents edit plan for approval, writes canvas-edit-plan.md |
| `canvas-screen-editor` | `edit-canvas-app` | Applies targeted edits to one screen's .pa.yaml; runs in parallel with other editors |

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
