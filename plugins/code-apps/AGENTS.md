# AGENTS.md — Code Apps Plugin

This file provides guidance to AI agents that work on the **code-apps-preview** plugin in `plugins/code-apps`.

## What This Plugin Is

A plugin for building and deploying Power Apps code apps using React + Vite + TypeScript, connected to Power Platform via connectors (Dataverse, SharePoint, Teams, Azure DevOps, OneDrive, Excel, Office 365, and more). Apps are deployed via the Power Apps NPX CLI (`pa app push`).

## Local Development

Test this plugin locally:

```bash
claude --plugin-dir /path/to/plugins/code-apps
```

## Architecture

```
.plugin/plugin.json               <- Open Plugins metadata (name, version, keywords)
.claude-plugin/plugin.json        <- Legacy mirror for existing installations
plugin.json                       <- Agent Plugins 1.0.0 manifest
AGENTS.md                         <- Plugin guidance for AI agents (this file)
agents/
  code-app-architect.md           <- Agent persona for architecture decisions
com.github.copilot/agents/
  code-app-architect.agent.md     <- Native Copilot copy with adjusted relative links
com.github.copilot/hooks/
  hooks.json                     <- Native Copilot hooks for the portable package
hooks.json                        <- Native Copilot CLI preToolUse hook
hooks/
  hooks.json                      <- Claude Code PreToolUse hook
  set-cli-origin.js               <- Narrow leading-invocation attribution (Node only)
  README.md                       <- Hook contracts and limitations
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
      prerequisites-reference.md  <- Node, npm-installed Power Apps CLI, git requirements
      troubleshooting.md          <- Common issues and fixes
  deploy/
    SKILL.md                      <- Build and deploy an existing code app
  list-connections/
    SKILL.md                      <- List connections (connection IDs; optional on CLI 1.3.0+)
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
| `/create-code-app` | Scaffold, configure, and deploy a new Power Apps code app |
| `/deploy` | Build and deploy an existing code app |
| `/list-connections` | List Power Platform connections and their IDs (required before adding a connector only on CLIs older than 1.3.0) |
| `/add-datasource` | Add a data source (routes to the appropriate add-* skill) |
| `/add-dataverse` | Add Dataverse tables with generated TypeScript models and services |
| `/add-sharepoint` | Add SharePoint Online connector |
| `/add-azuredevops` | Add Azure DevOps connector |
| `/add-teams` | Add Microsoft Teams connector |
| `/add-excel` | Add Excel Online (Business) connector |
| `/add-onedrive` | Add OneDrive for Business connector |
| `/add-office365` | Add Office 365 Outlook connector |
| `/add-mcscopilot` | Add Copilot Studio agent connector |
| `/add-connector` | Add any other Power Platform connector |

## Key Concepts

### Connector-First Principle

Power Apps code apps run in a sandbox — direct HTTP calls (`fetch`, `axios`, Graph API, etc.) do not work at runtime. **All external data access must go through Power Platform connectors.**

### Connections

Every non-Dataverse data source is bound to a connection. With Power Apps CLI 1.3.0+ (which `/create-code-app` installs), `pa app add data-source` finds the connector's connection or creates one, so connector skills omit `-c`. Older CLIs need `-c <connection-id>`. [shared/connector-reference.md](./shared/connector-reference.md) defines both flows and when to ask the user first.

### Generated Services

`pa app add data-source` generates typed TypeScript services in `src/generated/`:
- `src/generated/models/{Name}Model.ts` — TypeScript interfaces
- `src/generated/services/{Name}Service.ts` — CRUD methods

Always use generated services for data access.

### CLI

The Power Apps CLI (`@microsoft/power-apps-cli`) is installed into each project as a dev dependency; the Vite template doesn't include it, so `/create-code-app` adds it. It has shipped two binaries — grouped **`pa`** (preferred) and flat **`power-apps`** (fallback). **Resolve which one the project has via [shared/cli-binary.md](./shared/cli-binary.md) first**, then invoke it with `npx --no-install <pa|power-apps>` from the project directory — runs natively in bash on all platforms, no PowerShell wrapper needed. Commands below use the canonical grouped `pa` form:

Shell hooks automatically supply `PA_CLI_ORIGIN=plugin/<host-agent>` for recognized
CLI invocations without replacing explicit user values. Do not manually export
attribution in skills. Keep both host hook configurations in sync; native Copilot
events preserve shell identity, whereas its Claude-compatible `Bash` alias does
not distinguish Bash from PowerShell. See [hooks/README.md](./hooks/README.md).
Keep detection conservative and tokenizer-free: match supported single-line
leading invocations and simple output captures, not arbitrary shell programs.
Leave PowerShell `using` preambles unchanged. Handled hook/launcher failures must
report stderr diagnostics but complete successfully without rewriting the call.

```bash
pa app push                   # Deploy app
pa app add data-source --connector ... # Add connector
pa connection list       # List connections
```

### Scaffolding

Always use `npx degit` to create new projects — never `git clone` or manual file creation:

```bash
npx degit microsoft/PowerAppsCodeApps/templates/vite {folder} --force
cd {folder}
npm install
npm install --save-dev "@microsoft/power-apps-cli@^1.3.0"   # the template doesn't include the CLI
```

## Testing Changes

Run these checks from the repository root:

```bash
node scripts/validate-code-apps.js
node scripts/validate-legacy-compatibility.js
node --test scripts/tests/validate-legacy-compatibility.test.js
node --test plugins/code-apps/scripts/tests/*.test.js
```

The Code Apps workflow runs these checks on Windows and Ubuntu.
Package checks do not prove that a client can install, update, or execute skills.
Check those actions separately before claiming runtime support.
The path-filtered `code-apps-script-tests` workflow exercises Bash and PowerShell
on Windows and Linux with local CLI stubs. These tests never transmit telemetry.

## Portable Package Rules

- Preserve the plugin name `code-apps-preview` and both legacy manifests.
- Keep root `plugin.json` metadata equal to the legacy metadata, except for its required `$schema`.
- Keep all 15 skills in one shared set. Preserve their existing tool declarations, model preferences, and invocation settings.
- Use document-relative links in skills, agents, and shared instructions. Do not depend on `${PLUGIN_ROOT}` expansion in Markdown.
- Keep the native Copilot architect equal to the legacy architect, except for relative resource paths.
- The repository's `.agents/plugins/marketplace.json` exposes Code Apps only. Do not add unadapted sibling plugins.
- Preserve user approvals when replacing client-specific tools with equivalent capabilities.
- Keep `com.github.copilot/hooks/hooks.json` equal to the legacy root `hooks.json`.
- Preserve the existing Code Apps attribution hooks. Do not copy Managed Apps attribution variables or agent detection into them.
