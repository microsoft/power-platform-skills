# CLAUDE.md — power-automate plugin

This is the marketplace plugin wrapper for **FlowAgent** (Power Automate cloud
flow tooling). The **authoritative reference is the [FlowAgent repo CLAUDE.md](https://github.com/matow_microsoft/flow-agent/blob/main/CLAUDE.md)** —
flow-definition rules, the two-provider auth model (Azure CLI + MSAL), the full
CLI/MCP surface, the error reference, and known issues. Read it before building
or editing flows.

This file only covers plugin-local specifics; see `AGENTS.md` (this folder) for
the tool-routing rule.

## What's here

- `skills/` — verb-first user-invocable skills (`create-flow`, `build-flow`,
  `debug-flow`, `diagnose-flow`, `manage-flows`, `browse-flows`,
  `manage-desktop-flows`, `route-environments`, `setup`)
- `references/` — shared docs referenced by skills via `../../references/…`
- `.mcp.json` — launches the FlowAgent MCP server (`flowagent`)

## Engine vs plugin

The MCP **engine** (TypeScript monorepo: `packages/core`, `packages/cli`)
lives at the repo root and is built with `npm install &&
npm run build`. This `plugins/power-automate/` folder is the **plugin** — it is
designed to be lifted into the `microsoft/power-platform-skills` marketplace as
`plugins/power-automate/`. In this source repo, `.mcp.json` launches the bundled `server/mcp.mjs` via a
small Node bootstrap that resolves `PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT`.
