# CLAUDE.md — power-automate plugin

This is the marketplace plugin wrapper for **FlowAgent** (Power Automate cloud
flow tooling). The **authoritative reference is the repo root `CLAUDE.md`** —
flow-definition rules, the two-provider auth model (Azure CLI + MSAL), the full
CLI/MCP surface, the error reference, and known issues. Read it before building
or editing flows.

This file only covers plugin-local specifics; see `AGENTS.md` (this folder) for
the tool-routing rule.

## What's here

- `skills/` — verb-first user-invocable skills (`create-flow`, `build-flow`,
  `debug-flow`, `diagnose-flow`, `manage-flows`, `browse-flows`,
  `manage-desktop-flows`, `route-environments`, `setup`, `report-issue`)
- `references/` — shared docs referenced by skills via `../../references/…`
- `.mcp.json` — launches the FlowAgent MCP server (`flowagent-mcp`)

## Engine vs plugin

The MCP **engine** (TypeScript monorepo: `packages/core`, `packages/cli`,
`packages/live`) lives at the repo root and is built with `npm install &&
npm run build`. This `plugins/power-automate/` folder is the **plugin** — it is
designed to be lifted into the `microsoft/power-platform-skills` marketplace as
`plugins/power-automate/`. When merged there, switch `.mcp.json` to the
published `npx -y @microsoft/power-automate-mcp@latest flowagent-mcp` form (already the default).
