# Power Automate plugin

Build, edit, run, and debug **Power Automate cloud flows** from GitHub Copilot CLI or
Claude Code, powered by the **FlowAgent** MCP server.

This folder is the marketplace-packaged plugin: skills, MCP wiring, and a
self-contained MCP engine bundled at `server/mcp.mjs`.

## Install

From a GitHub Copilot CLI or Claude Code session:

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
`references/connection-patterns.md` in this folder.

## Telemetry logs

Power Automate hook telemetry writes per-session logs under
`~/.power-platform-skills/telemetry/power-automate/sessions/` by default; the
base directory follows `POWER_PLATFORM_SKILLS_CONFIG_DIR` when set. Old
session logs are pruned after 14 days.

The FlowAgent CLI/MCP engine writes a separate local mirror to
`~/.flowagent/telemetry.jsonl` by default. Set `FLOWAGENT_TELEMETRY_LOG` to
change its path. The core log is not automatically pruned. See
[`skills/telemetry/SKILL.md`](skills/telemetry/SKILL.md) for telemetry controls and
[`references/telemetry.md`](references/telemetry.md) for collection and routing
details. Both guides ship inside the plugin.

## Local flow backups

Before every update or delete, the engine saves the flow's current definition
so `list_backups` / `restore_backup` can roll it back. These local snapshots
provide a recovery option alongside Power Automate's recovery features.

- **Location**: `%LOCALAPPDATA%\flowagent\backups` on Windows, otherwise
  `$XDG_CACHE_HOME/flowagent/backups` (default `~/.cache/flowagent/backups`).
  Setting `FLOWAGENT_HOME` moves them to `$FLOWAGENT_HOME/.flowagent/backups`.
  Backups from older versions in a
  project's `.flowagent/backups` folder are still listed and restorable
  (marked `legacy`) but never written to.
- **Size**: files are gzipped, and a snapshot identical to the flow's latest
  backup is not written again.
- **Retention**: per flow, the last 10 snapshots plus up to 5 pinned ones (the
  first snapshot each session, i.e. the state before the agent started
  editing). Files older than 30 days are pruned whenever a backup is written,
  across all flows, but each flow's newest backup is always kept. The whole
  store is capped at 100 MB, oldest unpinned first.
  Override with `FLOWAGENT_BACKUP_RETENTION`, `FLOWAGENT_BACKUP_PINNED_RETENTION`,
  `FLOWAGENT_BACKUP_MAX_AGE_DAYS` and `FLOWAGENT_BACKUP_MAX_TOTAL_MB`.
- **Delete and restore are fail-closed**: if the backup of the current state
  can't be taken, the operation is refused. Pass `skipBackup` to delete anyway.
- **Restore** compares the saved flow's trigger/action structure with the
  backup and reports any mismatch.
  If the flow no longer exists it is recreated with a new ID; a recreated
  solution flow sits outside its solution, and an admin can still restore the
  original (within 21 days of deletion) to keep its ID and solution membership.
