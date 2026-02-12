# Power Platform Skills

Official agent skills/plugins for Power Platform development by Microsoft.

## Overview

This repository is a **plugin marketplace** containing Claude Code/GitHub Copilot plugins for Power Platform services. Each plugin provides skills, agents, and commands to help developers build on the Power Platform.

## Repository Structure

```
power-platform-skills/
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

1. Add the marketplace to your agent

    ```bash
    /plugin marketplace add microsoft/power-platform-skillss
    ```

2. Install the desired plugin

    ```bash
    /plugin install power-pages@power-platform-skillss
    ```

### Add from local path

1. Clone this repository
1. Add the marketplace to your agent

    ```bash
    /plugin marketplace add /path/to/power-platform-skillss
    ```

1. Install the desired plugin (installs to user scope by default)

    ```bash
    /plugin install power-pages@power-platform-skillss
    ```

## Local Development

To develop and test plugins locally, follow these steps:

1. Clone this repository
1. Launch Claude Code with plugin path:

    ```bash
    claude --plugin-dir /path/to/power-platform-skills/plugins/power-pages
    ```

1. Launch Copilot with plugin path:

    ```bash
    copilot --plugin-dir /path/to/power-platform-skills/plugins/power-pages
    ```

## Documentation

- [Power Pages Code Sites](https://learn.microsoft.com/en-us/power-pages/configure/create-code-sites)
- [Power Pages REST API](https://learn.microsoft.com/en-us/rest/api/power-platform/powerpages/websites)
- [PAC CLI Reference](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/pages)

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
