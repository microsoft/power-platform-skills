# Code Apps Plugin

Plugin for building Power Apps code apps with React and Vite. Works with Claude Code, GitHub Copilot, and OpenCode.

> **Preview:** This plugin is currently in preview and may change before general availability.

## Prerequisites

- [Node.js v22+](https://nodejs.org/)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started), [GitHub Copilot](https://github.com/features/copilot), or [OpenCode](https://opencode.ai)

## Install

For Claude Code and GitHub Copilot, install from the `microsoft/power-platform-skills` marketplace.

Open Claude Code or GitHub Copilot in any folder and run the following commands:

1. Add the marketplace:
   ```
   /plugin marketplace add microsoft/power-platform-skills
   ```

2. Install the plugin:
    ```
    /plugin install code-apps-preview@power-platform-skills
    ```

### OpenCode

Run the repository installer:

```bash
node scripts/install.js
```

The installer generates namespaced OpenCode skills under `~/.config/opencode/skills`. Start with `/code-apps-create-code-app`.

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

In OpenCode, the same commands are installed with a `code-apps-` prefix, for example `/code-apps-create-code-app` and `/code-apps-add-dataverse`.

## Uninstall

```
/plugin uninstall code-apps-preview
```

## Documentation

- [Code Apps Overview](https://learn.microsoft.com/en-us/power-apps/developer/code-apps/overview)
- [Power Apps CLI Reference](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/code)
- [Claude Code Plugins](https://docs.anthropic.com/en/docs/claude-code/plugins)
