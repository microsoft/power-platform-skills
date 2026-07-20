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
.plugin/plugin.json            ← Open Plugins metadata (name, version, keywords)
.mcp.json                      ← MCP server config (canvas-authoring, auto-registered)
AGENTS.md                      ← Plugin guidance for AI agents (this file)
CLAUDE.md                      ← Symlink → AGENTS.md
references/
  TechnicalGuide.md            ← YAML syntax, control selection, layout strategies, Power Fx patterns
  DesignGuide.md               ← Aesthetic guidelines, anti-patterns, design process
  QAChecks.md                  ← Runtime anti-pattern checks for self-QA
  PlanTemplates.md             ← CREATE and EDIT plan document structures for canvas-app-planner
agents/
  canvas-app-planner.md        ← Discovers resources and writes plan document; invoked by canvas-app
  canvas-screen-builder.md     ← Builds or modifies one screen; invoked by canvas-app (parallel)
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
| `/canvas-app` | Create or edit a Canvas App — auto-detects whether to generate from scratch or edit existing |
| `/configure-canvas-mcp` | Configure the Canvas Authoring MCP server for the current coauthoring session |
| `/add-data-source` | Guide the user to add a data source, connection, or API connector in Studio, then verify it is available |

## Agents

Agents are invoked by skills via the `Task` tool — they are not user-invocable.

| Agent | Invoked By | Description |
|-------|-----------|-------------|
| `canvas-app-planner` | `canvas-app` | Receives the approved plan from the skill. Discovers available controls, APIs, and data sources; gathers control property definitions (`describe_control`); writes `App.pa.yaml` (CREATE mode) and `canvas-app-plan.md` for downstream screen builders. |
| `canvas-screen-builder` | `canvas-app` | For Create actions: writes YAML for one new screen based on the plan. For Modify actions: applies targeted edits to one existing screen. Runs in parallel with other builders; validation is performed later by `canvas-app` using `compile_canvas`. |

## MCP Tools

The `canvas-authoring` MCP server exposes the following tools:

| Tool | Description |
|------|-------------|
| `connect` | Connects to a coauthoring session for a specific canvas app (environment ID, app ID, cluster category; optional auth flow, login hint, tenant ID, and forced account selection). Must be called before any other tool; calling again switches environment/app |
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
