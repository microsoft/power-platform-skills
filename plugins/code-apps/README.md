# Code Apps Plugin

Build Power Apps code apps with React and Vite.
The package includes an [Agent Plugins 1.0.0](https://agent-plugins.org/specification) manifest and retains the GitHub Copilot and Claude Code manifests.

> **Preview:** This plugin is currently in preview and may change before general availability.

## Prerequisites

- [Node.js v22+](https://nodejs.org/)
- An agent client that supports plugins, such as GitHub Copilot CLI, Claude Code, Codex, or Cursor

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

### Codex

Use the repository's Codex catalog:

```text
codex plugin marketplace add microsoft/power-platform-skills
codex plugin add code-apps-preview@power-platform-skills
```

This catalog lists Code Apps only. The existing Copilot and Claude marketplace entries remain unchanged.

### Cursor and Other Agent Plugins Clients

Load `plugins/code-apps` with the client's documented local plugin option.
For Cursor CLI versions that support it:

```text
cursor-agent --plugin-dir <checkout>/plugins/code-apps
```

Client versions can differ in plugin installation and update support.
The portable manifest alone does not establish client runtime support.

## Package Components

| Component | Location | Purpose |
| --- | --- | --- |
| Portable manifest | [plugin.json](./plugin.json) | Agent Plugins 1.0.0 package metadata |
| Legacy manifests | [.plugin/plugin.json](./.plugin/plugin.json), [.claude-plugin/plugin.json](./.claude-plugin/plugin.json) | Existing installations and updates |
| Shared skills | [skills](./skills) | The same 15 workflows for all clients |
| Legacy architect | [agents/code-app-architect.md](./agents/code-app-architect.md) | Architecture guidance in legacy clients |
| Native Copilot architect | [com.github.copilot/agents/code-app-architect.agent.md](./com.github.copilot/agents/code-app-architect.agent.md) | Copilot-specific agent discovery |

Skills retain their existing tool declarations, model preferences, and invocation settings.
Client-specific metadata support varies. These settings do not establish strict Agent Skills conformance.
Resource links resolve relative to each document, so they do not require client-specific variable expansion.
The architect agent is client-specific, not a portable Agent Plugins component.
The package does not include hooks or MCP servers.

## Available Skills

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
| `/add-mcscopilot`   | Add a Microsoft Copilot Studio agent connector             |
| `/add-workiq`       | Add Microsoft 365 search and chat through Work IQ          |
| `/list-connections` | Find Power Platform connection IDs                         |
| `/deploy`           | Build and deploy an existing code app                      |
| `/report-issue`     | Prepare a public bug report for user approval               |

Start with `/create-code-app` — it walks you through everything.

Skill invocation syntax depends on the client.
If the client has no skill tool, read the matching `skills/<name>/SKILL.md` and follow its workflow.
All approval and confirmation requirements still apply.

## Update Existing Installations

The plugin identity remains `code-apps-preview`.
Existing Copilot and Claude installations do not require removal or reinstallation:

```text
/plugin marketplace update power-platform-skills
/plugin update code-apps-preview@power-platform-skills
```

For Codex, refresh the Git-backed marketplace:

```text
codex plugin marketplace upgrade power-platform-skills
```

Start a new client session after updating.
Use the documented update action for other clients.

## Uninstall

```
/plugin uninstall code-apps-preview
```

## Documentation

- [Code Apps Overview](https://learn.microsoft.com/en-us/power-apps/developer/code-apps/overview)
- [Power Apps CLI Reference](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/code)
- [GitHub Copilot CLI Plugins](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-finding-installing)
- [Claude Code Plugins](https://docs.anthropic.com/en/docs/claude-code/plugins)
