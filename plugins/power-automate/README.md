# Power Automate plugin

Build, edit, run, and debug **Power Automate cloud flows** from Claude Code or
GitHub Copilot CLI, powered by the **FlowAgent** MCP server.

This plugin is the marketplace-packaged surface of
[matow_microsoft/flow-agent](https://github.com/matow_microsoft/flow-agent). The
MCP server (the engine) lives in that repo's `packages/` monorepo; this folder
is the plugin (skills, MCP wiring).

## Install

From a Claude Code or GitHub Copilot CLI session:

```bash
/plugin marketplace add microsoft/power-platform-skills
/plugin install power-automate@power-platform-skills
```

> [!NOTE]
> **Self-contained — no npm install or remote host required.** The plugin ships a
> self-contained MCP engine at `server/mcp.mjs`, and `.mcp.json` launches it with
> a small Node bootstrap that resolves `PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` and
> dynamically imports `server/mcp.mjs`. (`@microsoft/power-automate-mcp` is not
> yet on npm; the plugin does not need it.) Auth still uses your local
> `az login` — see **MCP server** below.

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

## MCP server

`.mcp.json` launches the FlowAgent MCP server from the bundled engine with a
small Node bootstrap that resolves `PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` and
dynamically imports `server/mcp.mjs`. That file is a single self-contained ESM
bundle (stdio transport, all 50+ tools, deps inlined), regenerated from
`packages/cli/src/bin/mcp-stdio.ts` by `npm run build` (`scripts/bundle-plugin-mcp.mjs`).
It needs only Node.js 18+ — no `npx`, no published npm package, no remote host.

> For local development against the monorepo you can point your client at the repo
> root shim instead: `node <repo>/dist/mcp.js` (run `npm install && npm run build`
> first). A publishable `@microsoft/power-automate-mcp` npm package may follow, but
> the plugin does not depend on it.

Auth uses Azure CLI (`az login`) plus MSAL for connectivity endpoints — see the
[FlowAgent repo CLAUDE.md](https://github.com/matow_microsoft/flow-agent/blob/main/CLAUDE.md).

## Sovereign clouds (GCC High, DoD)

The plugin auto-detects your Azure cloud from `az cloud show`. For GCC High:

```bash
az cloud set --name AzureUSGovernment
az login
```

The plugin will detect the government cloud and use GCC High endpoints. To
explicitly select a profile (required for DoD, optional for GCC High):

```bash
export PA_CLOUD=gcchigh   # or: gcc, dod
```

If endpoint URLs are incorrect for your environment, override individually:

| Variable | Purpose |
|----------|---------|
| `PA_CLOUD` | Cloud profile: `commercial`, `gcc`, `gcchigh`, `dod` |
| `PA_FLOW_RESOURCE` | Token audience for Flow API |
| `PA_BASE_URL` | Flow RP base URL |
| `PA_PPAPI_SUFFIX` | PPAPI domain suffix |
| `PA_AUTHORITY_HOST` | Entra authority host |
| `PA_CONNECTIVITY_RESOURCE` | Connectivity API audience |

> **Note**: Sovereign cloud endpoints are community-verified. If you encounter
> auth failures, please report the correct endpoint in
> [issue #248](https://github.com/microsoft/power-platform-skills/issues/248).
