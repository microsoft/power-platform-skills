# Power Automate plugin

Build, edit, run, and debug **Power Automate cloud flows** from Claude Code or
GitHub Copilot CLI, powered by the **FlowAgent** MCP server.

This folder is the marketplace-packaged plugin: skills, MCP wiring, and a
self-contained MCP engine bundled at `server/mcp.mjs`.

## Install

From a Claude Code or GitHub Copilot CLI session:

```bash
/plugin marketplace add microsoft/power-platform-skills
/plugin install power-automate@power-platform-skills
```

> [!NOTE]
> **Runs offline — no npm install or remote host required.** The plugin ships a
> self-contained MCP engine at `server/mcp.mjs`, and `.mcp.json` loads it through
> a small Node bootstrap that resolves the plugin's installation directory. Auth
> still uses your local `az login` — see **MCP server** below.

## Capabilities

- **Flows**: list, get, create, **edit** (surgical action-level edits), **copy**
  (within/across environments), update, publish/disable, delete
- **Runs**: history, details, actions, **loop iteration drill-down**, **cancel**,
  **cancel all**, **resubmit**, **diagnose**
- **Connections**: lifecycle (CRUD, fix), auto-discovery, dynamic value
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

## MCP server

`.mcp.json` registers the FlowAgent MCP server under the name `flowagent` and
loads it from the bundled engine at `server/mcp.mjs` via a small Node bootstrap
that resolves the plugin's installation directory and reports an actionable
error if the bundle is missing. That file is a single self-contained ESM bundle
(stdio transport, all 50+ tools, deps inlined). It needs only Node.js 18+ — no
`npx`, no published npm package, no remote host.

Auth uses Azure CLI (`az login`) plus MSAL for connectivity endpoints — see
`CLAUDE.md` and `references/connection-patterns.md` in this folder.
