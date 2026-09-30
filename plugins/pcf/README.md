# PCF Plugin

Build, test, diagnose, upgrade, deploy, bind, verify and inventory Power Apps component framework (PCF) code components for model-driven apps and Power Pages.

## Installation

```bash
/plugin marketplace add microsoft/power-platform-skills
/plugin install pcf@power-platform-skills
```

```bash
copilot --plugin-dir /path/to/power-platform-skills/plugins/pcf
# or
claude --plugin-dir /path/to/power-platform-skills/plugins/pcf
```

## Prerequisites

| Prerequisite | Required for | Install |
|---|---|---|
| [Node.js](https://nodejs.org/) 20+ and npm | All PCF work | `winget install OpenJS.NodeJS.LTS` |
| [PAC CLI](https://learn.microsoft.com/en-us/power-platform/developer/cli/introduction) | Deploy/package flows | `dotnet tool install -g Microsoft.PowerApps.CLI.Tool` |
| [.NET SDK](https://dotnet.microsoft.com/download) | PAC solution packaging and package smoke tests | `winget install Microsoft.DotNet.SDK.8` |
| [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) (`az`) | Dataverse verify and inventory reads | `winget install Microsoft.AzureCLI` |

`/pcf` can scaffold, lint, test, build, doctor and upgrade locally with Node.js alone. Deploy needs PAC CLI and the .NET SDK; verify and inventory need Azure CLI for Dataverse Web API reads.

## Skill

Invoke as `/pcf:pcf` when the namespaced form matters, or `/pcf` when unambiguous.

1. **Plan** — captures `pcf-intent.json`, renders `pcf-plan.md`, and asks for approval before writes.
2. **Scaffold** — creates field/dataset and standard/virtual projects from Microsoft-maintained templates, with optional recipes.
3. **Implement and repair** — applies PCF best practices, host policy, source checks and upgrade guidance.
4. **Gate** — runs manifest, host, source, lint, unit-test and production-build checks.
5. **Deploy** — uses `pac pcf push` with an explicit environment and recorded consent.
6. **Bind and verify** — guides Maker binding, then checks registration and draft/published metadata.
7. **Inventory** — lists registered controls and registered where-used dependencies.

Example prompts:

- `Create a PCF star rating control for a model-driven form`
- `Diagnose why this PCF project will not build`
- `Upgrade this PCF control to the pcf compatibility matrix`
- `Deploy this PCF control and verify the binding`
- `Inventory where this PCF control is used`

## Running Without Interruption

The skill pauses before environment writes, destructive local changes, deployment, and binding instructions that require maker action. Unattended runs may scaffold, lint, test, build, doctor, upgrade in dry-run mode, verify already-deployed metadata, and inventory read-only Dataverse evidence when credentials are available.

## Relation to model-apps

PCF code components ship in this separate plugin because the same component can be used by model-driven apps, canvas apps and Power Pages. The model-apps plugin still owns whole-app and generative-page authoring: `/model-apps:app-builder` builds whole apps, and `/model-apps:genpage` builds pages.
