# Power Platform Skills

Official Power Platform development skills by Microsoft. The repository started as a Claude Code/GitHub Copilot plugin marketplace and is now being adapted so the same workflows can be used as Codex skills.

## Overview

This repository contains Power Platform workflows for Power Pages, Power Apps code apps, model-driven generative pages, and canvas apps. The source tree still groups content by plugin, but the primary unit for Codex is each `skills/*/SKILL.md` folder.

## Installation

### Codex

Codex discovers skills from folders that contain a `SKILL.md`. This repo keeps those folders under each plugin:

- `plugins/power-pages/skills/*`
- `plugins/code-apps/skills/*`
- `plugins/model-apps/skills/*`
- `plugins/canvas-apps/skills/*`

To use selected skills with Codex, symlink or copy the skill folders you want into `$CODEX_HOME/skills` (or `~/.codex/skills` when `CODEX_HOME` is unset).

Example:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -s /path/to/power-platform-skills/plugins/power-pages/skills/create-site \
  "${CODEX_HOME:-$HOME/.codex}/skills/power-pages-create-site"
```

The plugin-level `AGENTS.md` files describe how to interpret older Claude-specific terms that still appear inside some workflow documents.

### Claude Code / GitHub Copilot

The original plugin packaging is still present in `.claude-plugin/` for repositories that still consume this format.

#### Quick Install (Recommended)

Run the installer to set up all plugins with auto-update enabled:

**Windows (PowerShell)**:

```powershell
iwr https://raw.githubusercontent.com/microsoft/power-platform-skills/main/scripts/install.js -OutFile install.js; node install.js; del install.js
```

**Mac OS/Linux/Windows (cmd)**:

```bash
curl -fsSL https://raw.githubusercontent.com/microsoft/power-platform-skills/main/scripts/install.js | node
```

The installer automatically:

- Installs `pac` CLI if not already installed
- Detects available tools (Claude Code, GitHub Copilot CLI)
- Registers the plugin marketplace and installs all listed plugins
- Enables auto-update so plugins stay current

### Manual Installation

If you prefer to install manually, run these commands inside a Claude Code or GitHub Copilot CLI session:

1. Add the marketplace

    ```bash
    /plugin marketplace add microsoft/power-platform-skills
    ```

2. Install the desired plugin

    ```bash
    /plugin install power-pages@power-platform-skills
    /plugin install model-apps@power-platform-skills
    /plugin install code-apps@power-platform-skills
    /plugin install canvas-apps@power-platform-skills
    ```

## Available Plugins

### [Power Pages](plugins/power-pages/README.md) (`plugins/power-pages`)

Create and deploy Power Pages sites using modern development approaches.

**Currently supported**: Code Sites (SPAs) with React, Angular, Vue, or Astro

### [Model Apps](plugins/model-apps/README.md) (`plugins/model-apps`)

Build and deploy Power Apps generative pages for model-driven apps.

**Stack**: React + TypeScript + Fluent, deployed via PAC CLI

### [Code Apps](plugins/code-apps/AGENTS.md) (`plugins/code-apps`)

Build and deploy Power Apps code apps connected to Power Platform via connectors.

**Stack**: React + Vite + TypeScript, deployed via PAC CLI

### [Canvas Apps](plugins/canvas-apps/AGENTS.md) (`plugins/canvas-apps`)

Author Power Apps Canvas Apps using the Canvas Authoring MCP server.

**Stack**: PA YAML (`.pa.yaml`) authored via `CanvasAuthoringMcpServer`, requires .NET 10 SDK

## Local Development

To develop and test locally, follow these steps:

1. Clone this repository
1. For Codex, link the skill folder you want into `$CODEX_HOME/skills`
1. For Claude Code, launch with plugin path:

    ```bash
    claude --plugin-dir /path/to/power-platform-skills/plugins/power-pages
    claude --plugin-dir /path/to/power-platform-skills/plugins/model-apps
    claude --plugin-dir /path/to/power-platform-skills/plugins/code-apps
    claude --plugin-dir /path/to/power-platform-skills/plugins/canvas-apps
    ```

## Running Without Interruption

The workflows in this repo may invoke multiple tools during a session, which can result in frequent approval prompts. The options below apply to the original Claude Code and GitHub Copilot plugin packaging.

> **Warning**: Auto-approval options give the agent the same access you have on your machine. Only use these in trusted or sandboxed environments.

### Claude Code

#### Option 1 — Permission mode (recommended)

Set the `acceptEdits` mode to auto-approve file edits while still prompting for shell commands:

```jsonc
// .claude/settings.json (project-level) or ~/.claude/settings.json (user-level)
{
  "defaultMode": "acceptEdits",
  "permissions": {
    "allow": [
      "Bash(npm run *)",
      "Bash(git *)",
      "Bash(pac *)"
      // add other commands your workflow needs
    ]
  }
}
```

#### Option 2 — Allow all tools

Press <kbd>Shift</kbd>+<kbd>Tab</kbd> during a session to cycle to **auto-accept** mode, or launch with:

```bash
claude --dangerously-skip-permissions
```

See the [Claude Code permissions docs](https://code.claude.com/docs/en/permissions) for the full reference.

### GitHub Copilot CLI

#### Option 1 — Allow specific tools (recommended)

Pre-approve only the tools your workflow needs:

```bash
copilot --allow-tool 'write' --allow-tool 'shell(npm run build)' --allow-tool 'shell(pac *)'
```

#### Option 2 — Allow all tools in Copilot

```bash
copilot --allow-all-tools
```

To allow everything except dangerous commands:

```bash
copilot --allow-all-tools --deny-tool 'shell(rm)' --deny-tool 'shell(git push)'
```

See the [Copilot CLI docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli) for the full reference.

## Repository Structure

```text
power-platform-skills/
├── .claude-plugin/
│   └── marketplace.json      # Legacy marketplace manifest for Claude Code / Copilot
├── .claude/
│   └── settings.json         # Auto-allowed tools (pac, node, dotnet, etc.)
├── plugins/
│   ├── power-pages/          # Power Pages plugin
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json  # Legacy plugin packaging metadata
│   │   ├── commands/
│   │   ├── shared/
│   │   └── skills/          # Codex-compatible skill folders live here
│   ├── model-apps/           # Model Apps plugin
│   |   ├── .claude-plugin/
│   │   └── plugin.json
│   |   ├── commands/
│   |   ├── skills/
│   |   ├── shared/           # Shared references + samples
│   |   └── github/           # GitHub Copilot instructions
│   ├── code-apps/            # Code Apps plugin
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── agents/
│   │   ├── skills/
│   │   └── shared/           # Shared instructions + references
│   └── canvas-apps/          # Canvas Apps plugin
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── references/       # Technical + design guides
│       └── skills/
├── AGENTS.md                 # Development guidelines
└── README.md
```

## Documentation

- [Power Pages Code Sites](https://learn.microsoft.com/en-us/power-pages/configure/create-code-sites)
- [Power Pages REST API](https://learn.microsoft.com/en-us/rest/api/power-platform/powerpages/websites)
- [Generative Pages with External Tools](https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/generative-page-external-tools)
- [Power Apps Code Apps](https://learn.microsoft.com/power-apps/developer/code-apps/)
- [PAC CLI Reference](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guide.

## License

The code in this repo is licensed under the [MIT](LICENSE) license.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
