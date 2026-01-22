# Power Platform Claude Plugins

Official Claude Code extensions for Power Platform development by Microsoft.

## Overview

This repository is a **plugin marketplace** containing Claude Code plugins for Power Platform services. Each plugin provides skills, agents, and commands to help developers build on the Power Platform.

## Repository Structure

```
power-platform-claude-plugin/
├── .claude-plugin/
│   └── marketplace.json      # Marketplace manifest (lists all plugins)
├── plugins/
│   └── power-pages/          # Individual plugin directory
│       ├── .claude-plugin/
│       │   └── plugin.json   # Plugin manifest
│       ├── .mcp.json         # MCP server configuration
│       ├── agents/           # Agent persona files
│       ├── commands/         # Command entry points
│       ├── shared/           # Shared resources
│       └── skills/           # Skill workflows
├── AGENTS.md                 # Development guidelines
└── README.md
```

## Available Plugins

### Power Pages (`plugins/power-pages`)

Create and deploy Power Pages sites using modern development approaches.

**Currently supported**: Code Sites (SPAs) with React, Angular, Vue, or Astro

## Installation

### Add from GitHub Marketplace

To use a plugin from this marketplace:

1. Add the marketplace to your Claude Code instance

    ```bash
    /plugin marketplace add microsoft/power-platform-claude-plugin
    ```

2. Install the desired plugin

    ```bash
    /plugin install power-pages@power-platform-claude-plugin
    ```

### Add from local path

1. Clone this repository
1. Add the marketplace to your Claude Code instance

    ```bash
    /plugin marketplace add /path/to/power-platform-claude-plugin
    ```

1. Install the desired plugin (installs to user scope by default)

    ```bash
    /plugin install power-pages@power-platform-claude-plugin
    ```

## Local Development

To develop and test plugins locally, follow these steps:

1. Clone this repository
1. Launch Claude Code with plugin path:

    ```bash
    claude --plugin-dir /path/to/power-platform-claude-plugin/plugins/power-pages
    ```

## Documentation

- [Power Pages Code Sites](https://learn.microsoft.com/en-us/power-pages/configure/create-code-sites)
- [Power Pages REST API](https://learn.microsoft.com/en-us/rest/api/power-platform/powerpages/websites)
- [PAC CLI Reference](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/pages)
- [Claude Code Plugins](https://code.claude.com/docs/en/plugins-reference)

## Contributing

This project welcomes contributions and suggestions.  Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit [Contributor License Agreements](https://cla.opensource.microsoft.com).

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
