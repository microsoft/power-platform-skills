# Power Automate plugin

Build, edit, run, and debug **Power Automate cloud flows** from Claude Code or
GitHub Copilot CLI, powered by the **FlowAgent** MCP server.

This plugin is the marketplace-packaged surface of
[microsoft/power-platform-skills](https://github.com/microsoft/power-platform-skills). The
MCP engine lives in the FlowAgent monorepo (`packages/`); this folder is the
plugin (skills, agents, MCP wiring).

## Install

From a Claude Code or GitHub Copilot CLI session:

```bash
/plugin marketplace add microsoft/power-platform-skills
/plugin install power-automate@power-platform-skills
```

## Capabilities

- **Flows**: list, get, create, **edit** (surgical action-level edits), **copy**
  (within/across environments), update, publish/disable, delete
- **Runs**: history, details, actions, **loop iteration drill-down**, **cancel**,
  **cancel all**, **resubmit**, **diagnose**
- **Connections**: lifecycle (CRUD, share, fix), auto-discovery, dynamic value
  resolution
- **Authoring**: templates/scaffolding, batch deploy, preflight + validation,
  **expression help**
- **Desktop flows**, environment routing

## Skills

| Skill | Purpose |
|-------|---------|
| `setup` | First-time prerequisite setup |
| `browse-flows` | Browse environments and flows interactively |
| `create-flow` | Guided flow creation |
| `build-flow` | Autonomously generate a complete flow from a description |
| `debug-flow` | Interactive debug of a failed run |
| `diagnose-flow` | Autonomous deep diagnosis of a failed run |
| `manage-flows` | Lifecycle ops: publish, test, batch, inventory |
| `manage-desktop-flows` | List/run desktop (RPA) flows |
| `route-environments` | Environment resolution/routing |
| `report-issue` | File a bug against this repo |

## MCP server

`.mcp.json` launches the FlowAgent MCP server via
`npx -y @microsoft/power-automate-mcp@latest flowagent-mcp`.

> **Until `@microsoft/power-automate-mcp` is published to npm**, point your client at the local
> build instead: `node <repo>/packages/cli/dist/bin/mcp-stdio.js` (run
> `npm install && npm run build` in the repo root first).

Auth uses Azure CLI (`az login`) plus MSAL for connectivity endpoints — see the
repo root `CLAUDE.md`.
