# AGENTS.md — power-automate plugin

Guidance for AI agents (Copilot CLI, Claude Code, Cursor) operating inside this
plugin. The authoritative reference is this plugin's `CLAUDE.md` and the
`references/` docs; this file is the plugin-local routing rule.

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

Shell (`node dist/cli.js …`) is reserved for users running the engine from a
local build, only for CLI-only commands the MCP does not wrap (connection
lifecycle, sharing, solutions/admin), and not for plugin users when MCP tools
are available.

If the `flowagent-*` tools are missing, the MCP isn't wired — point the user at
this plugin's `.mcp.json` / the install steps in `README.md`.

## Layout

- `skills/<skill>/SKILL.md` — user-invocable skills (verb-first names)
- `references/*.md` — shared reference docs (CLI commands, definition rules,
  connection patterns, error troubleshooting)
- `.claude-plugin/plugin.json` + `.plugin/plugin.json` — Claude / Copilot
  manifests
- `.mcp.json` — MCP server wiring (FlowAgent + Microsoft Learn)

The flow-definition rules, auth model, error reference, and known issues live in
this plugin's `CLAUDE.md` and `references/` docs, and apply whether you call via
MCP or shell.

## Documentation lookup (hybrid pattern)

This plugin uses a **two-tier knowledge architecture**:

### Tier 1: Local references (fast, offline, plugin-specific)
The `references/*.md` files are curated, plugin-specific docs covering:
- Flow definition rules (`$authentication`, `$connections`, `OpenApiConnection`)
- Connection reference patterns (`Embedded` vs `Invoker`, logical names)
- Error-to-fix mapping (the exact API errors FlowAgent users hit)
- CLI command reference

**Always check `references/*.md` first** — they contain hard-won knowledge that
Learn docs don't cover or bury across many articles.

### Tier 2: Microsoft Learn MCP (live, comprehensive, up-to-date)
The `.mcp.json` wires `microsoft-learn` (`https://learn.microsoft.com/api/mcp`)
which provides:
- `microsoft_docs_search` — search Learn docs by topic
- `microsoft_docs_fetch` — fetch a complete article by URL
- `microsoft_code_sample_search` — find code examples

**Use Learn MCP when:**
- The user asks about a connector or action you don't recognize
- An expression function isn't in the local expression reference
- You need the latest API changes or preview features
- The user asks "how do I..." for a scenario not in references/
- You need to verify whether a pattern is officially supported
- Error troubleshooting needs more context than the local table provides

**Scoping tip:** Prefix queries with "Power Automate" or "cloud flow" for
relevance. For connector docs, use the connector name directly.
