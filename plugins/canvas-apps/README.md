# Canvas Apps Plugin

Build or update Power Apps Canvas Apps with an AI coding agent. The plugin connects your coding agent to an app that is open in Power Apps Studio, allowing the agent to work on the app's screens, controls, formulas, connectors, and data sources.

## Before you start

You need:

- A coding agent that supports MCP and agent plugins
- The [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0)
- An organizational account with permission to edit the Canvas App and access its Power Apps environment
- An existing Canvas App with coauthoring enabled

MCP, or Model Context Protocol, is the standard the plugin uses to connect your coding agent to Power Apps.

> **The app must already exist.** It can be new and completely blank, but you must create it in Power Apps, save it in the intended environment, and enable coauthoring before connecting. The plugin cannot create the initial app record or enable coauthoring. After connecting, it can build or edit the app's screens and content.

Confirm that .NET 10 or later is installed:

```bash
dotnet --list-sdks
```

The output must include a version beginning with `10.` or a later major version. If the command is not found or no supported version appears, install the SDK and restart your coding agent.

## Quick start

1. [Install the plugin](#installation).
2. Create or open a Canvas App in Power Apps Studio.
3. In Power Apps Studio, go to **Settings > Updates > Coauthoring** and enable coauthoring.
4. Keep the Power Apps Studio browser tab open.
5. Run the `configure-canvas-mcp` skill and provide the complete Studio URL when asked.
6. Verify the connection by asking your agent: `List the available Canvas App controls.`
7. Begin building your Canvas App with your agent! Just ask for what you want, and watch it take care of the rest.

## Installation

### Install from a plugin marketplace

Use your coding agent's plugin marketplace:

```text
/plugin marketplace add microsoft/power-platform-skills
/plugin install canvas-apps@power-platform-skills
```

If your host does not support these commands, use its plugin marketplace interface. Search for the `microsoft/power-platform-skills` marketplace, then install `canvas-apps`.

### Install in VS Code

1. Open the **Extensions** view:
   - Windows or Linux: `Ctrl+Shift+X`
   - macOS: `Cmd+Shift+X`
2. Enter `@agentPlugins canvas apps` in the search field.
3. Select **Canvas Apps**, published by Microsoft, from VS Code's built-in plugin marketplace.
4. Review the plugin details, then select **Install**.
5. Open Chat in Agent mode and confirm that the `canvas-app` and `configure-canvas-mcp` skills are available.

If installing fails:

1. Open the **Command Palette** (`Ctrl+Shift+P` on Windows or Linux; `Cmd+Shift+P` on macOS).
2. Run **Preferences: Open User Settings (JSON)**.
3. Add `"chat.plugins.enabled": true` inside the file's outer `{ }` braces, preserving existing settings and separating properties with commas.
4. Save the file and search Extensions again.

For more information, see [Install a plugin from a marketplace](https://code.visualstudio.com/docs/agent-customization/agent-plugins#_install-a-plugin-from-a-marketplace).

> **Local installation is not recommended.** It is host-specific and may not receive automatic plugin updates. Use a marketplace unless you are developing or contributing to the plugin.

## Connect to a Canvas App

1. Open the existing app in Power Apps Studio.
2. Confirm that coauthoring is enabled under **Settings > Updates > Coauthoring**.
3. Keep the Power Apps Studio browser tab open for the entire session.
4. Start the `configure-canvas-mcp` skill from your host's skills or commands interface. If your host supports natural-language skill selection, ask:

   ```text
   Connect the Canvas Apps MCP server to my app.
   ```

5. When asked for the Studio URL, copy the complete URL from your browser's address bar and paste it into the chat.
6. Complete any sign-in prompt.
7. Verify the connection by asking:

   ```text
   List the available Canvas App controls.
   ```

## Evaluate a Canvas App

Use `/eval-canvas-app` with a Power Apps URL and the Q prompt ID that generated the app.
Run this skill on a Microsoft Dev Box or another Windows-based environment with Edge and PowerShell 7 (`pwsh`); the bundled runner uses Win32 process APIs.
The skill opens a stable Studio preview, runs the governed AppGen scenarios from a local
`power-platform-evals` checkout, retains the Product report and canonical evidence, and
publishes metrics when OneDS configuration is available.

The bundled runner uses the checkout identified by `POWER_PLATFORM_EVALS_REPO` or an
explicitly provided path. The evaluator also requires `FOUNDRY_EVAL_ENDPOINT` and an Azure
CLI sign-in that can use that Foundry resource.

The connection depends on the open Power Apps Studio coauthoring session. If you close the browser tab or the Studio session expires, reopen the app and run `configure-canvas-mcp` again.

## Work on your app

### `canvas-app`

Use this skill to build a connected blank app or update an app that already contains screens and content.

Run `/canvas-app`, or describe what you want:

- `Create a Canvas App for managing inventory`
- `I need a Canvas App for tracking employee time off`
- `Modify the form in my existing Canvas App to include validation`
- `Edit my Canvas App to add a new screen for reports`

> **Say "Canvas App" in your request.** This helps your coding agent distinguish this skill from other app-generation skills that may be installed.

### `configure-canvas-mcp`

Use this skill to connect the Canvas Authoring MCP server to the app currently open in Power Apps Studio.

Run `/configure-canvas-mcp`, or ask:

- `Configure MCP for Canvas Apps`
- `Set up the Canvas Authoring MCP server`
- `Connect Canvas Apps MCP`

## Technical reference

You do not need to call MCP tools directly - this section is here for reference only. In VS Code, open Chat in Agent mode and select **Configure Tools** to review the tools provided by `canvas-authoring`.

| Tool | What it does |
|------|--------------|
| `connect` | Connects to a specific Canvas App and Power Apps environment |
| `compile_canvas` | Validates and applies the app's local YAML files through the Power Apps authoring service |
| `sync_canvas` | Downloads the current app state, overwriting matching local YAML files |
| `list_controls` | Lists controls available for Canvas Apps |
| `describe_control` | Shows the properties and variants of a control |
| `list_apis` | Lists connectors available in the current app session |
| `describe_api` | Shows the operations and parameters provided by a connector |
| `list_data_sources` | Lists data sources connected to the current app |
| `get_data_source_schema` | Shows the columns and data types for a connected data source |
| `list_accounts` | Lists signed-in accounts in the local authentication cache |
| `remove_account` | Signs an account out of the local authentication cache |

## Security

Your credentials are handled through the official Azure Identity SDK; the plugin does not store or manage tokens directly.

- Install the plugin only from a trusted marketplace, and keep the plugin, coding agent, and .NET SDK current.
- Connect with an account that has only the permissions needed to edit the intended app.
- Check the Power Apps environment, app URL, proposed action, and tool parameters before approving an operation.
- Validate generated changes in a development or nonproduction app before applying them to a production app.
- Never paste passwords, access tokens, connection strings, or other secrets into prompts, issue reports, or logs.
- Be aware of your organization's connector and data loss prevention policies. These policies may restrict the connectors and data sources available to your app.
- Review unexpected actions proposed by your coding agent, especially when working with external data. Approve only actions and access requests that match your intended task.

For more information, see:

- [Defend against indirect prompt injection attacks](https://learn.microsoft.com/en-us/security/zero-trust/sfi/defend-indirect-prompt-injection)
- [Manage Power Platform data policies](https://learn.microsoft.com/en-us/power-platform/admin/prevent-data-loss)

## Troubleshooting

### Installation

| Problem | What to do |
|---------|------------|
| **The plugin does not appear or will not install** | Confirm that your coding agent supports MCP and agent plugins. In VS Code, search Extensions for `@agentPlugins canvas apps`, then restart or reload VS Code after installation. If the plugin is still unavailable, ask your administrator whether organizational policies block agent plugins, third-party MCP servers, or local MCP processes. |
| **VS Code reports that the plugin source was not found after cloning** | Close VS Code. Delete `%USERPROFILE%\.vscode\agent-plugins\github.com\microsoft\power-platform-skills`, reopen VS Code, and search Extensions for `@agentPlugins canvas apps`. Install **Canvas Apps**, published by Microsoft, again. |
| **`dotnet` or `dnx` is not found** | Install the [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0), not only the runtime. Restart your terminal and coding agent, then run `dotnet --list-sdks` and confirm that version 10 or later appears. |
| **The MCP server cannot download its package** | If the error mentions `https://api.nuget.org/v3/index.json`, run `dotnet nuget list source`. Confirm that an enabled source contains `Microsoft.PowerApps.CanvasAuthoring.McpServer`. If none does, ask your administrator which approved NuGet source to use. Update the Canvas Apps plugin before retrying; current versions use your configured NuGet sources. |

### Connection

| Problem | What to do |
|---------|------------|
| **The `canvas-authoring` tools do not appear** | Confirm that the plugin is installed and enabled, then restart or reload your coding agent. In VS Code Chat, select **Configure Tools** and find `canvas-authoring`. If **Update Tools** fails, review the server error and the package-download guidance above. |
| **Connection fails after you provide the Studio URL** | Copy the URL from the app's edit session in Power Apps Studio, not from the app player or the Power Apps home page. Confirm that the app is saved, coauthoring is enabled, and the Studio tab remains open and signed in. |
| **Sign-in fails or uses the wrong account** | Retry the connection and choose the correct organizational account. If your host offers connection options, select browser sign-in or provide the account email as a login hint. |
| **Access is denied or coauthoring is unavailable** | Confirm that your account can edit the app. Ask your Power Platform administrator whether coauthoring is enabled for the app and environment, and whether organizational policies block third-party MCP servers. |
| **The connection stops working** | The Power Apps Studio session may have expired. Reopen the app, keep its Studio tab open, and run `configure-canvas-mcp` again. |

### App authoring

| Problem | What to do |
|---------|------------|
| **Controls, connectors, or data sources are missing** | Confirm that the MCP server is connected to the intended app and environment. Add required connectors and data sources through the **Data** panel in Power Apps Studio, then ask your agent to list them again. Organizational data policies may restrict what is available. |
| **Changes are not visible in Power Apps Studio** | Confirm that the original Studio tab is open and signed in, and check whether the agent reported a validation or compilation error. If the Studio session expired, reopen the app and reconnect before retrying. |

## Support

- For plugin installation, connection, or tool issues, report an issue at [aka.ms/power-skills-canvas-issues](https://aka.ms/power-skills-canvas-issues). Include your operating system, coding-agent name and version, .NET SDK version, and exact error message. Do not include credentials or access tokens.
- For Power Apps platform, environment, permissions, or coauthoring issues, use your organization's normal Microsoft Support channel.

## License

See the [LICENSE](../../LICENSE) file for license information.
