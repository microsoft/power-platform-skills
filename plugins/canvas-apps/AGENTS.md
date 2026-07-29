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
.claude-plugin/plugin.json     ← Claude Code metadata (mirrors .plugin/plugin.json)
.plugin/plugin.json            ← Open Plugins metadata (name, version, keywords)
.mcp.json                      ← MCP server config (canvas-authoring, auto-registered)
AGENTS.md                      ← Plugin guidance for AI agents (this file)
CLAUDE.md                      ← Symlink → AGENTS.md
hooks.json                     ← Copilot-format hooks: userPromptTransformed
hooks/
  hooks.json                   ← Claude-format hooks: UserPromptSubmit
  inject-sync-reminder.cs      ← File-based .NET app that emits the sync reminder for both hosts
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

## Hooks

Both hosts inject a reminder to call `sync_canvas` before acting, so the agent never edits stale
local `.pa.yaml` files. The reminder is conditional in wording — the agent skips the sync when no
coauthoring session is active or the request is unrelated to a canvas app.

Registration uses both plugin [hook formats](https://code.visualstudio.com/docs/agent-customization/agent-plugins)
— Claude-format (`hooks/hooks.json`) and Copilot-format (`hooks.json` at the plugin root) — which
the hosts read independently:

| Host | Registered in | Event |
|------|---------------|-------|
| Claude Code | `hooks/hooks.json` (Claude format) | `UserPromptSubmit` |
| Copilot CLI | `hooks.json` in the plugin root (Copilot format) | `userPromptTransformed` |

Each host reads only its own file and ignores the other's. Both run
`hooks/inject-sync-reminder.cs` via `dotnet run --file`, which branches on its stdin payload to
emit the output shape each host expects.

Keep the two files separate. Claude Code rejects unrecognized hook event names, so putting
`userPromptTransformed` in `hooks/hooks.json` makes Claude fail to load the plugin, disabling its
`canvas-authoring` MCP server. Neither manifest should declare a `"hooks"` field: Claude Code
auto-discovers `hooks/hooks.json`, and pointing at it explicitly is treated as a duplicate hook
source, which also disables MCP.

## Prerequisites

Before the MCP server will start, you need:

**.NET 10 SDK** — [Download from Microsoft](https://dotnet.microsoft.com/download/dotnet/10.0)
