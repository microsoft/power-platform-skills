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
  YamlSyntax.md                ← .pa.yaml structure, syntax rules, and parse-error triage
  ControlGuide.md              ← Control selection, property contracts, enums, and versions
  LayoutGuide.md               ← Responsive sizing, scrolling, galleries, and contrast
  GridLayoutGuide.md           ← Conditional GridLayout formulas and invariants
  PowerFxGuide.md              ← State, events, named formulas, and mock data
  DesignGuide.md               ← Aesthetic guidelines, anti-patterns, design process
  QAChecks.md                  ← Named runtime anti-pattern checks for per-screen self-QA
  CreateWorkflow.md            ← CREATE stages 1–4, revision/resume, and approval
  CreateBuilderCore.md         ← CREATE implementation rules and topic-module ownership
  CreateSelectionControls.md   ← CREATE selection, filtering, defaults, and reset
  CreateGalleryLayout.md       ← CREATE galleries, record surfaces, and dataset bounds
  CreateNavigationState.md     ← CREATE cross-screen context and shared state
  CreateMutations.md           ← CREATE mutations and persisted-data initialization
  CreateConformance.md         ← CREATE inspection, repair, and evidence procedures
  CreateImplementation.md      ← CREATE stage 5 shared wiring, screen waves, and compilation
  CreateValidation.md          ← CREATE final validation gates
  EditWorkflow.md              ← EDIT routing and direct/partitioned/planned execution
  EditConformance.md           ← EDIT implementation checks
  PlannedEditHandoff.md        ← Planned EDIT acceptance and screen-wave handoff
  ValidationWorkflow.md        ← EDIT compile, repair, acceptance, and final validation gates
agents/
  canvas-create-functionality.md ← CREATE stage 1: owns create-functionality.md
  canvas-create-screens.md       ← CREATE stage 2: owns create-screens.md
  canvas-create-layout.md        ← CREATE stage 3: owns create-design.md and per-screen compositions
  canvas-create-discovery.md      ← CREATE stage 4: owns create-discovery.md and feasibility findings
  canvas-create-builder.md        ← CREATE stage 5 worker: owns exactly one assigned screen YAML file
  canvas-app-planner.md           ← Planned EDIT: owns the dispatch index, shared contract, and screen briefs
  canvas-screen-builder.md       ← EDIT worker: modifies one assigned screen
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
| `canvas-create-functionality` | `canvas-app` | CREATE stage 1; defines requirements and actions in `create-functionality.md` without choosing screens or implementation. |
| `canvas-create-screens` | `canvas-app` | CREATE stage 2; organizes approved functionality into screens and states in `create-screens.md`. |
| `canvas-create-layout` | `canvas-app` | CREATE stage 3; owns shared visual design and each screen's composition artifact. |
| `canvas-create-discovery` | `canvas-app` | CREATE stage 4; checks control/data/API/image and composition feasibility in `create-discovery.md`. |
| `canvas-create-builder` | `canvas-app` | CREATE stage 5 worker; implements exactly one assigned screen from the approved composition and bindings. The skill coordinator owns shared bindings, app/editor files, and compilation; builders run in waves of at most three. |
| `canvas-app-planner` | `canvas-app` | Planned EDIT only; discovers missing resource contracts and writes the dispatch index, shared contract, and affected-screen briefs for an approved edit. |
| `canvas-screen-builder` | `canvas-app` | EDIT worker; modifies one assigned screen from its approved brief and shared contract. |

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
