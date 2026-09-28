# Code Apps Plugin

Copilot plugin for building Power Apps code apps with React and Vite. Works with both GitHub Copilot and Claude Code.

> **Preview:** This plugin is currently in preview and may change before general availability.

## Prerequisites

- [Node.js v22+](https://nodejs.org/)
- [GitHub Copilot](https://github.com/features/copilot) or [Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started)

## Install

The plugin marketplace is hosted in the `plugin` folder of the [microsoft/PowerAppsCodeApps](https://github.com/microsoft/PowerAppsCodeApps) repository.

Open GitHub Copilot or Claude Code in any folder and run the following commands:

1. Add the marketplace:
   ```
   /plugin marketplace add microsoft/power-platform-skills
   ```

2. Install the plugin:
   ```
   "/plugin install code-apps@power-platform-skills"
   ```

## Available Commands

| Command             | Description                                                  |
| ------------------- | ------------------------------------------------------------ |
| `/create-code-app` | Scaffold, build, and deploy a new Power Apps code app        |
| `/add-dataverse`    | Add Dataverse tables with generated TypeScript services      |
| `/add-sharepoint`   | Add SharePoint Online connector                              |
| `/add-excel`        | Add Excel Online (Business) connector                        |
| `/add-onedrive`     | Add OneDrive for Business connector                          |
| `/add-teams`        | Add Teams messaging connector                                |
| `/add-office365`    | Add Office 365 Outlook connector (calendar, email, contacts) |
| `/add-azuredevops`  | Add Azure DevOps connector                                   |
| `/add-connector`    | Add any other Power Platform connector                       |
| `/add-datasource`   | Ask your copilot to recommend the right data source          |

Start with `/create-code-app` — it walks you through everything.

## Uninstall

```
/plugin uninstall code-apps
```

## Documentation

- [Code Apps Overview](https://learn.microsoft.com/en-us/power-apps/developer/code-apps/overview)
- [Power Apps CLI Reference](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/code)
- [GitHub Copilot CLI Plugins](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-finding-installing)
- [Claude Code Plugins](https://docs.anthropic.com/en/docs/claude-code/plugins)
