# CLAUDE.md — power-automate plugin

This is the marketplace plugin wrapper for **FlowAgent** (Power Automate cloud
flow tooling). Flow-definition rules, the two-provider auth model (Azure CLI +
MSAL), the error reference, and known issues are documented in `references/` —
see `definition-reference.md`, `connection-patterns.md`, and
`error-troubleshooting.md`. Read those before building or editing flows.

This file only covers plugin-local specifics; see `AGENTS.md` (this folder) for
the tool-routing rule.

## What's here

- `skills/` — verb-first user-invocable skills (`create-flow`, `build-flow`,
  `debug-flow`, `diagnose-flow`, `manage-flows`, `browse-flows`,
  `manage-desktop-flows`, `route-environments`, `setup`)
- `references/` — shared docs referenced by skills via `../../references/…`
- `.mcp.json` — launches the FlowAgent MCP server (registered as `flowagent`)

## Engine vs plugin

This folder is the **plugin**: skills, references, MCP wiring, and a
self-contained MCP engine bundled at `server/mcp.mjs`. `.mcp.json` loads that
bundle through a small Node bootstrap that resolves the plugin's installation
directory and reports an actionable error if the bundle is missing.
