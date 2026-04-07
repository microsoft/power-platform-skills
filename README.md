# Power Platform Skills

Official agent skills/plugins for Power Platform development by Microsoft.

## Overview

This repository is a **plugin marketplace** containing Claude Code/GitHub Copilot plugins for Power Platform services. Each plugin provides skills, agents, and commands to help developers build on the Power Platform.

## Installation

### Quick Install (Recommended)

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

To develop and test plugins locally, follow these steps:

1. Clone this repository
1. Launch Claude Code with plugin path:

    ```bash
    claude --plugin-dir /path/to/power-platform-skills/plugins/power-pages
    claude --plugin-dir /path/to/power-platform-skills/plugins/model-apps
    claude --plugin-dir /path/to/power-platform-skills/plugins/code-apps
    claude --plugin-dir /path/to/power-platform-skills/plugins/canvas-apps
    ```

## Running Without Interruption

Plugins in this repo may invoke multiple tools (file edits, shell commands, MCP servers) during a session, which can result in frequent approval prompts. Use the options below to reduce or eliminate these interruptions.

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
│   └── marketplace.json      # Marketplace manifest (lists all plugins)
├── .claude/
│   └── settings.json         # Auto-allowed tools (pac, node, dotnet, etc.)
├── plugins/
│   ├── power-pages/          # Power Pages plugin
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── commands/
│   │   ├── shared/
│   │   └── skills/
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
