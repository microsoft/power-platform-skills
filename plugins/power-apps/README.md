# Power Apps Plugin

Copilot plugin for building Power Apps code apps with React and Vite. Works with both Claude Code and GitHub Copilot.

> **Preview:** This plugin is currently in preview and may change before general availability.

## Prerequisites

- [Node.js v22+](https://nodejs.org/)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started) or [GitHub Copilot](https://github.com/features/copilot)

## Install

The plugin marketplace is hosted in the `plugin` folder of the [microsoft/PowerAppsCodeApps](https://github.com/microsoft/PowerAppsCodeApps) repository.

Open Claude Code or GitHub Copilot in any folder and run the following commands:

1. Add the marketplace:
   ```
   /plugin marketplace add microsoft/power-platform-skills
   ```

2. Install the plugin:
   ```
   "/plugin install power-apps@power-platform-skills"
   ```

## Available Commands

| Command             | Description                                                  |
| ------------------- | ------------------------------------------------------------ |
| `/create-power-app` | Scaffold, build, and deploy a new Power Apps code app        |
| `/add-dataverse`    | Add Dataverse tables with generated TypeScript services      |
| `/add-sharepoint`   | Add SharePoint Online connector                              |
| `/add-excel`        | Add Excel Online (Business) connector                        |
| `/add-onedrive`     | Add OneDrive for Business connector                          |
| `/add-teams`        | Add Teams messaging connector                                |
| `/add-office365`    | Add Office 365 Outlook connector (calendar, email, contacts) |
| `/add-azuredevops`  | Add Azure DevOps connector                                   |
| `/add-connector`    | Add any other Power Platform connector                       |
| `/add-datasource`   | Ask your copilot to recommend the right data source          |

Start with `/create-power-app` — it walks you through everything.

## Uninstall

```
/plugin uninstall power-apps
```

## Documentation

- [Code Apps Overview](https://learn.microsoft.com/en-us/power-apps/developer/code-apps/overview)
- [Power Apps CLI Reference](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/code)
- [Claude Code Plugins](https://docs.anthropic.com/en/docs/claude-code/plugins)
