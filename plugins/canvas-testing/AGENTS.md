# AGENTS.md — Canvas Testing Plugin

This file provides guidance to AI Agents when working with the **canvas-testing** plugin.

## What This Plugin Is

A plugin for authoring Power Apps Canvas Apps. The Canvas Authoring MCP server (`CanvasAuthoringMcpServer`) exposes tools that agents use to generate, validate, and compile Canvas App YAML files (`.pa.yaml`) in conjunction with a running coauthoring studio session. The Power Apps Studio browser tab must remain open for the duration of the session — closing it ends the coauthoring session, which breaks `compile_canvas` and `sync_canvas` operations.

Skills perform all work directly — this plugin does not use sub-agents.

## Local Development

Test this plugin locally:

```bash
claude --plugin-dir /path/to/plugins/canvas-testing
```

## Architecture

```
.claude-plugin/plugin.json     ← Plugin metadata (name, version, keywords)
.mcp.json                      ← MCP server config (canvas-authoring, auto-registered)
AGENTS.md                      ← Plugin guidance for AI agents (this file)
CLAUDE.md                      ← Symlink → AGENTS.md
references/
  TechnicalGuide.md            ← YAML syntax, control selection, layout strategies, Power Fx patterns
  DesignGuide.md               ← Aesthetic guidelines, anti-patterns, design process
  QAChecks.md                  ← Runtime anti-pattern checks for self-QA
  PlanTemplates.md             ← CREATE and EDIT plan document structures
skills/
  canvas-app/
    SKILL.md                   ← Unified skill: create or edit a Canvas App (auto-detects mode)
  configure-canvas-mcp/
    SKILL.md                   ← Registers the Canvas Authoring MCP server with Claude Code
  add-data-source/
    SKILL.md                   ← Guides user to add a data source or connector in Studio, then verifies
  generate-canvas-app/
    SKILL.md                   ← [DEPRECATED] Redirects to canvas-app
```

## Skills

| Skill | Description |
|-------|-------------|
| `/canvas-app` | Create or edit a Canvas App — auto-detects whether to generate from scratch or edit existing. Discovers MCP resources, gathers control definitions, builds screens sequentially, and validates with compile_canvas. |
| `/configure-canvas-mcp` | Register the Canvas Authoring MCP server with Claude Code |
| `/add-data-source` | Guide the user to add a data source, connection, or API connector in Studio, then verify it is available |

## MCP Tools

The `canvas-authoring` MCP server exposes the following tools:

| Tool | Description |
|------|-------------|
| `configure` | Configures the MCP server for a specific coauthoring session (environment ID, app ID, cluster category) |
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
