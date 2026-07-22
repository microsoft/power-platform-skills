# AGENTS.md — power-automate plugin

Guidance for AI agents (Copilot CLI, Claude Code, Cursor) operating inside this
plugin. The authoritative reference is the [FlowAgent repo CLAUDE.md](https://github.com/matow_microsoft/flow-agent/blob/main/CLAUDE.md);
this file is the plugin-local routing rule.

## Tool routing (read first)

**If `flowagent-*` MCP tools are present in your tool surface, USE THEM** for any
flow/env/connection/run operation — list/get/create/update/**edit**/**copy**/
publish/run flows, environments, connections, connectors, run history + run
management (**cancel**, **cancel_all**, **resubmit**, **diagnose**, loop
repetitions), dynamic resolvers, templates, and `get_expression_help`.

The MCP server (`.mcp.json` → `flowagent`) is the supported integration path:
it handles auth (Azure CLI + MSAL), session-scoped current env/flow, structured
errors, and stays in-process. Shelling out re-pays auth cost and breaks session
state.

Shell (`node dist/cli.js …`) is reserved for users who have the [FlowAgent engine repo](https://github.com/matow_microsoft/flow-agent) cloned and built, only for CLI-only commands the MCP does not wrap (connection lifecycle, sharing, solutions/admin), and not for plugin users when MCP tools are available.

If the `flowagent-*` tools are missing, the MCP isn't wired — point the user at
this plugin's `.mcp.json` / the install steps in `README.md`.

## Layout

- `skills/<skill>/SKILL.md` — user-invocable skills (verb-first names)
- `references/*.md` — shared reference docs (CLI commands, definition rules,
  connection patterns, error troubleshooting)
- `.claude-plugin/plugin.json` + `.plugin/plugin.json` — Claude / Copilot
  manifests
- `.mcp.json` — MCP server wiring

The flow-definition rules, auth model, error reference, and known issues live in
the [FlowAgent repo CLAUDE.md](https://github.com/matow_microsoft/flow-agent/blob/main/CLAUDE.md) and apply whether you call via MCP or shell.
