# AGENTS.md — Power Apps Plugin

This file provides guidance to AI agents when working with the **code-apps** plugin as Codex skills.

## What This Plugin Is

A plugin for building and deploying Power Apps code apps using React + Vite + TypeScript, connected to Power Platform via connectors (Dataverse, SharePoint, Teams, Azure DevOps, OneDrive, Excel, Office 365, and more). Apps are deployed via PAC CLI (`pac code push`).

## Local Development

For Codex, symlink or copy the relevant `skills/*` folder into `$CODEX_HOME/skills`. For the legacy packaging, you can still test the plugin locally with:

```bash
claude --plugin-dir /path/to/plugins/power-apps
```

## Architecture

```
.claude-plugin/plugin.json        <- Legacy plugin metadata
AGENTS.md                         <- Plugin guidance for AI agents (this file)
agents/
  code-app-architect.md           <- Agent persona for architecture decisions
shared/
  shared-instructions.md          <- Cross-cutting concerns (Windows CLI, safety, planning, memory bank)
  connector-reference.md          <- Connector patterns and generated service usage
  development-standards.md        <- Versioning, theme, build workflow, TypeScript strict mode
  memory-bank.md                  <- Memory bank format and usage
  planning-policy.md              <- Plan mode policy
  preferred-environment.md        <- Environment selection priority
  version-check.md                <- Version check instructions
skills/
  create-code-app/
    SKILL.md                      <- Scaffold, init, build, and deploy a new code app
    references/
      prerequisites-reference.md  <- Node, pac, git requirements
      troubleshooting.md          <- Common issues and fixes
  deploy/
    SKILL.md                      <- Build and deploy an existing code app
  list-connections/
    SKILL.md                      <- List Power Platform connections to get connection IDs
  add-datasource/
    SKILL.md                      <- Router: asks what you need and picks the right add-* skill
  add-connector/
    SKILL.md                      <- Generic fallback for any connector not covered by a specific skill
  add-dataverse/
    SKILL.md                      <- Add Dataverse tables with generated models and services
    references/                   <- Dataverse-specific reference docs
  add-sharepoint/
    SKILL.md                      <- Add SharePoint Online connector
    references/                   <- SharePoint-specific reference docs
  add-azuredevops/
    SKILL.md                      <- Add Azure DevOps connector
  add-teams/
    SKILL.md                      <- Add Microsoft Teams connector
  add-excel/
    SKILL.md                      <- Add Excel Online (Business) connector
  add-onedrive/
    SKILL.md                      <- Add OneDrive for Business connector
  add-office365/
    SKILL.md                      <- Add Office 365 Outlook connector
  add-mcscopilot/
    SKILL.md                      <- Add Copilot Studio agent connector
```

## Skills

| Skill | Description |
|-------|-------------|
| `create-code-app` | Scaffold, configure, and deploy a new Power Apps code app |
| `deploy` | Build and deploy an existing code app |
| `list-connections` | List Power Platform connections to find connection IDs |
| `add-datasource` | Add a data source and route to the appropriate add-* workflow |
| `add-dataverse` | Add Dataverse tables with generated TypeScript models and services |
| `add-sharepoint` | Add SharePoint Online connector |
| `add-azuredevops` | Add Azure DevOps connector |
| `add-teams` | Add Microsoft Teams connector |
| `add-excel` | Add Excel Online (Business) connector |
| `add-onedrive` | Add OneDrive for Business connector |
| `add-office365` | Add Office 365 Outlook connector |
| `add-mcscopilot` | Add Copilot Studio agent connector |
| `add-connector` | Add any other Power Platform connector |

## Codex Translation Layer

Some skill bodies still use Claude-era terms. Interpret them this way in Codex:

- `${CLAUDE_PLUGIN_ROOT}` means the `plugins/code-apps` directory
- `AskUserQuestion` means ask a short plain-text question directly
- `TaskCreate` / `TaskUpdate` / `TaskList` mean maintain progress with `update_plan`
- `EnterPlanMode` / `ExitPlanMode` mean enter or leave a normal Codex planning step
- `/add-*` means open the sibling skill folder and follow that workflow

## Key Concepts

### Connector-First Principle

Power Apps code apps run in a sandbox — direct HTTP calls (`fetch`, `axios`, Graph API, etc.) do not work at runtime. **All external data access must go through Power Platform connectors.**

### Generated Services

`pac code add-data-source` generates typed TypeScript services in `src/generated/`:
- `src/generated/models/{Name}Model.ts` — TypeScript interfaces
- `src/generated/services/{Name}Service.ts` — CRUD methods

Always use generated services for data access.

### Windows CLI

`pac` is a Windows executable not on the bash PATH. Always invoke via PowerShell:

```bash
pwsh -NoProfile -Command "pac code push"
```

### Scaffolding

Always use `npx degit` to create new projects — never `git clone` or manual file creation:

```bash
npx degit microsoft/PowerAppsCodeApps/templates/vite {folder} --force
```

## Testing Changes

After modifying this plugin:

1. For legacy packaging, run `claude --debug` to see plugin loading details
2. Test the `create-code-app` workflow from Codex or the legacy `/create-code-app` entrypoint
3. Verify connector-first guardrails are enforced
4. Test Windows CLI compatibility (`pac` via `pwsh`)
