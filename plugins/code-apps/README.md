# Code Apps Plugin

Copilot plugin for building Power Apps code apps with React and Vite. Works with both GitHub Copilot and Claude Code.

> **Preview:** This plugin is currently in preview and may change before general availability.

## Prerequisites

- [Node.js v22+](https://nodejs.org/)
- [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli) or [Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started)

## Install

The plugin is published in the [microsoft/power-platform-skills](https://github.com/microsoft/power-platform-skills) marketplace.

Open GitHub Copilot CLI or Claude Code in any folder and run the following commands:

1. Add the marketplace:
   ```
   /plugin marketplace add microsoft/power-platform-skills
   ```

2. Install the plugin:
   ```
   /plugin install code-apps-preview@power-platform-skills
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

## Connections

Connectors other than Dataverse use a connection: the saved sign-in a connector uses to call its service. New projects get Power Apps CLI 1.3.0 or later installed automatically, so the plugin can reuse your existing connection or create one for you:

- **One connection for the connector:** the plugin uses it.
- **Several connections:** the plugin asks which one to use.
- **No connection, and the connector signs in only with your Microsoft account (single sign-on):** the CLI creates one with your account while adding the connector. The plugin tells you before it starts the add.
- **No connection otherwise:** the plugin asks for your OK before it creates one, either with single sign-on (`--use-sso`) or by running `pa connection create`. If the connector needs a browser sign-in, it may ask you to run `pa connection create` in your own terminal.

Projects on an older CLI keep working: the plugin looks up the connection ID first.

## Uninstall

```
/plugin uninstall code-apps-preview
```

## Documentation

- [Code Apps Overview](https://learn.microsoft.com/en-us/power-apps/developer/code-apps/overview)
- [Power Apps CLI Reference](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/code)
- [GitHub Copilot CLI Plugins](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-finding-installing)
- [Claude Code Plugins](https://docs.anthropic.com/en/docs/claude-code/plugins)
