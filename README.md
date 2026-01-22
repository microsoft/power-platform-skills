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

| Skill | Description |
|-------|-------------|
| `/create-site` | Create, upload, and activate a Power Pages code site |
| `/setup-dataverse` | Configure Dataverse tables and relationships |
| `/setup-webapi` | Set up Web API integration for data access |

**Prerequisites:**
- PAC CLI (v1.44+) installed and authenticated
- Azure CLI installed for API authentication
- Node.js (v18+) for building frontend projects
- Power Pages environment with admin privileges

## Installation

To use a plugin from this marketplace, reference it in your Claude Code configuration:

```json
{
  "plugins": ["./plugins/power-pages"]
}
```

## Workflow Example (Power Pages)

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  1. Design  │ ──▶ │  2. Build   │ ──▶ │  3. Upload  │ ──▶ │ 4. Activate │
│   & Create  │     │   Project   │     │  (Inactive) │     │  (Go Live)  │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
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

