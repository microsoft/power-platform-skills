# PCF Plugin

Build, test, diagnose, upgrade, deploy, bind, verify and inventory Power Apps component framework (PCF) code components for model-driven apps, with guided setup for Power Pages standard field controls and canvas apps.

> **Preview**: Behaviour, file formats and commands may change between releases, and no recipe is runtime-certified yet. See [`docs/pcf-capabilities.md`](docs/pcf-capabilities.md) for what is proven today and [#656](https://github.com/microsoft/power-platform-skills/issues/656) for pending work.

This release supports Power Pages only for standard field controls: the form-field journey and the standalone Liquid journey (`{% codecomponent %}`), both guided. Dataset controls on Pages (form sub-grid and list) are not supported in this release.

Canvas apps are guided: an admin must turn on **Power Apps component framework for canvas apps** in each environment in the Power Platform admin center. The skill uses the model-driven gate profile and reviews canvas API limits by hand; reading the setting and automated canvas runtime evidence are not implemented. See [canvas setup](references/pcf-canvas.md).

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

The plugin invokes multiple tools during a session. To reduce approval prompts:

### GitHub Copilot CLI

**Option 1 — Allow specific tools (recommended)**

```bash
copilot --allow-tool 'write' --allow-tool 'shell(node *)' --allow-tool 'shell(npm *)' --allow-tool 'shell(pac *)' --allow-tool 'shell(az *)' --allow-tool 'shell(powershell *)'
```

**Option 2 — Allow all tools**

```bash
copilot --allow-all-tools
```

### Claude Code

**Option 1 — Permission mode (recommended)**

```jsonc
// .claude/settings.json
{
  "defaultMode": "acceptEdits",
  "permissions": {
    "allow": [
      "Bash(node *)",
      "Bash(npm *)",
      "Bash(pac *)",
      "Bash(az *)",
      "Bash(powershell *)"
    ]
  }
}
```

**Option 2 — Auto-accept all**

```bash
claude --dangerously-skip-permissions
```

## Hooks and guardrails

The plugin registers lifecycle hooks (in `hooks/hooks.json`) that run automatically while it's loaded. They are **fail-open**: any internal error exits 0, so a hook can never fail or abort a skill run. Because the plugin installs **globally**, the write-safety guard is scoped so it does not interfere with unrelated projects: it only **flags** (never blocks) writes outside the cwd during an active PCF authoring session (a `pcf-intent.json` or `pcf-plan.md` at/under cwd).

| Hook | When | What it does |
|---|---|---|
| Write-safety | before Write/Edit/MultiEdit | **Flags (non-blocking)** writes outside the cwd only during a PCF authoring session. Never blocks; silent in unrelated projects. |

**Escape hatches** (environment variables — set to `1` or `true`):

| Variable | Effect |
|---|---|
| `PCF_DISABLE_HOOKS` | Disables **all** pcf hooks. |
| `PCF_SKIP_WRITE_GUARD` | Disables **only** the write-safety guard. |

```powershell
# Windows (PowerShell)
$env:PCF_DISABLE_HOOKS = "1"
```

```bash
# macOS / Linux (bash)
export PCF_DISABLE_HOOKS=1
```

## Relation to model-apps

PCF code components ship in this separate plugin because the same component can be used by model-driven apps, canvas apps and Power Pages; this release builds and verifies them for model-driven apps, and guides Power Pages standard field controls and canvas apps. The model-apps plugin still owns whole-app and generative-page authoring: `/model-apps:app-builder` builds whole apps, and `/model-apps:genpage` builds pages. The plugins connect only at the skill level. With both installed, an agent working in `/model-apps:app-builder` can hand a control off to `/pcf:pcf` by passing it a `pcf-intent.json`; App Builder does not do this on its own. Neither plugin runs the other's scripts, because each installs on its own.
