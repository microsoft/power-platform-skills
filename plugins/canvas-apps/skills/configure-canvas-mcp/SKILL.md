---
name: configure-canvas-mcp
version: 1.0.0
description: Configure the Canvas Authoring MCP server for Claude Code, VS Code Copilot, or GitHub Copilot CLI. USE WHEN "configure MCP", "set up MCP server", "MCP not working", "connect Canvas Apps MCP", "canvas-authoring not available", "MCP not configured", "set up canvas apps". DO NOT USE WHEN prerequisites are missing — direct the user to install .NET 10 SDK first.
author: Microsoft Corporation
user-invocable: true
allowed-tools: Bash, AskUserQuestion, Read, Edit, Write
---

# Configure the Canvas Authoring MCP Server

This skill registers the Canvas Authoring MCP server with Claude Code, VS Code Copilot, or GitHub Copilot CLI using the user's Power Platform environment ID.

## Instructions

### 0. Check prerequisites

Verify that .NET 10 SDK or higher is installed

```bash
dotnet --list-sdks
```

If a version 10.x.y or higher is not listed, tell the user:

> ⚠️ .NET 10 SDK is required to run the Canvas Authoring MCP server. It looks like you don't have it installed. Please install it first to use this skill. https://dotnet.microsoft.com/download/dotnet/10.0

Then wait for the user to install it before continuing. If they say it's installed, run the command again to confirm. If it's still not found, repeat the message until they have it installed.

### 1. Determine which tool to configure

Determine whether the user needs to configure MCP for VS Code Copilot, GitHub Copilot CLI, or Claude Code:
- If explicitly mentioned in prompt, use that.
- Otherwise, determine which tool the user is running from the context.
- Only if choosing based on the context is impossible, ask the user:

> Which tool would you like to configure the Canvas Authoring (canvas-authoring) MCP server for?
> 1. **VS Code Copilot**
> 2. **GitHub Copilot CLI**
> 3. **Claude**

Based on the result, set the `TOOL_TYPE` variable to `vscode-copilot`, `copilot`, or `claude`. Store this for use in all subsequent steps.

### 2. Determine the MCP scope

Choose the configuration scope based on the tool. Use the scope explicitly mentioned by the user, or ask the user to choose.

**If TOOL_TYPE is `vscode-copilot`:**

There is only one configuration path: `.vscode/mcp.json` (relative to the current working directory).

Set `CONFIG_PATH` = `.vscode/mcp.json`. No scope selection is needed.

Store this path for use in steps 4 and 5.

**If TOOL_TYPE is `copilot`:**

The options are:
1. **Globally** (default, available in all projects)
2. **Project-only** (available only in this project)

Based on the scope, set the `CONFIG_PATH` variable:
- **Global**: `~/.copilot/mcp-config.json` (use the user's home directory)
- **Project**: `.mcp/copilot/mcp.json` (relative to the current working directory)

Store this path for use in steps 4 and 5.

**If TOOL_TYPE is `claude`:**

The options are:
1. **User** (available in all projects for this user)
2. **Project** (default, available only in this project)
3. **Local** (scoped to current project directory)

Based on the scope, set the `CLAUDE_SCOPE` variable:
- **User**: `CLAUDE_SCOPE` = `user`
- **Project**: `CLAUDE_SCOPE` = `project`
- **Local**: `CLAUDE_SCOPE` = `local`

Store this value for use in step 5.

### 3. Ask for the studio URL

Ask the user:

> What is the URL of your canvas app studio session?
>
> Copy the URL from the browser address bar while your app is open in Power Apps Designer (it should look like `https://make.powerapps.com/e/Default-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx/canvas/?action=edit&app-id=...`).
>
> Make sure coauthoring is enabled in the app (Settings → Updates → Coauthoring).
>
> **Keep this browser tab open for the entire session.** The MCP server communicates with Power Apps through the coauthoring session tied to that tab. Closing the tab ends the coauthoring session, which prevents `compile_canvas` and `sync_canvas` from working and means you can't see or save generated changes.

Then extract from the URL:
- **ENV_ID**: the path segment between `/e/` and the next `/` (e.g. `Default-91bee3d9-0c15-4f17-8624-c92bb8b36ead`).
- **APP_ID**: URL-decode the `app-id` query parameter value, then take the last segment after the final `/` (e.g. `6fc3e3d1-292b-4281-8826-577f78512e56`)
- **MAKER_HOSTNAME**: the hostname of the URL (e.g. `make.powerapps.com`)
- **CLUSTER_CATEGORY**: determined from MAKER_HOSTNAME (see table below)

**Determine CLUSTER_CATEGORY from MAKER_HOSTNAME:**

| MAKER_HOSTNAME               | CLUSTER_CATEGORY |
| ---------------------------- | ---------------- |
| `make.powerapps.com`         | `prod`           |
| `make.preview.powerapps.com` | `prod`           |
| Any other hostname           | `test`           |

**Example:**

Example URL: `https://make.powerapps.com/e/Default-91bee3d9-0c15-4f17-8624-c92bb8b36ead/canvas/?action=edit&app-id=%2Fproviders%2FMicrosoft.PowerApps%2Fapps%2F6fc3e3d1-292b-4281-8826-577f78512e56`

- ENV_ID → `Default-91bee3d9-0c15-4f17-8624-c92bb8b36ead`
- APP_ID → `6fc3e3d1-292b-4281-8826-577f78512e56`
- MAKER_HOSTNAME → `make.powerapps.com`
- CLUSTER_CATEGORY → `prod`

Store these as `ENV_ID`, `APP_ID`, and `CLUSTER_CATEGORY` for use in step 4.

### 4. Register the MCP server

**If TOOL_TYPE is `claude`:**
Run the following command to register the server with Claude Code:

```bash
claude mcp add --scope {CLAUDE_SCOPE} canvas-authoring \
  -e CANVAS_ENVIRONMENT_ID={ENV_ID} \
  -e CANVAS_APP_ID={APP_ID} \
  -e CANVAS_CLUSTER_CATEGORY={CLUSTER_CATEGORY} \
  -- dnx Microsoft.PowerApps.CanvasAuthoring.McpServer --yes --prerelease --source https://api.nuget.org/v3/index.json
```

If the command fails because `canvas-authoring` is already registered, remove it first, then re-add:

```bash
claude mcp remove canvas-authoring
claude mcp add --scope {CLAUDE_SCOPE} canvas-authoring \
  -e CANVAS_ENVIRONMENT_ID={ENV_ID} \
  -e CANVAS_APP_ID={APP_ID} \
  -e CANVAS_CLUSTER_CATEGORY={CLUSTER_CATEGORY} \
  -- dnx Microsoft.PowerApps.CanvasAuthoring.McpServer --yes --prerelease --source https://api.nuget.org/v3/index.json
```

**If TOOL_TYPE is `vscode-copilot` or `copilot`:**
1. Ensure the parent directory exists:
   - If `CONFIG_PATH` is `.vscode/mcp.json`, run: `mkdir -p .vscode`
   - If `CONFIG_PATH` is `.mcp/copilot/mcp.json`, run: `mkdir -p .mcp/copilot`
   - If `CONFIG_PATH` is the global `~/.copilot/mcp-config.json`, no directory creation is needed.

2. Read the existing configuration file at `CONFIG_PATH`, or create a new empty config if it doesn't exist:
   ```json
   {}
   ```

3. Determine which top-level key to use:
   - If the config already has `"servers"`, or if the TOOL_TYPE is `vscode-copilot`, use that
   - Otherwise, use `"mcpServers"`

4. Add or update the server entry:
   ```json
   {
     "mcpServers": {
       "canvas-authoring": {
         "type": "stdio",
         "command": "dnx",
         "args": [
           "Microsoft.PowerApps.CanvasAuthoring.McpServer",
           "--yes",
           "--prerelease",
           "--source",
           "https://api.nuget.org/v3/index.json"
         ],
         "env": {
           "CANVAS_ENVIRONMENT_ID": "{ENV_ID}",
           "CANVAS_APP_ID": "{APP_ID}",
           "CANVAS_CLUSTER_CATEGORY": "{CLUSTER_CATEGORY}"
         }
       }
     }
   }
   ```

5. Write the updated configuration back to `CONFIG_PATH` with proper JSON formatting (2-space indentation).

**Important notes:**
- Do NOT overwrite other entries in the configuration file
- Preserve the existing structure and formatting

### 5. Confirm and provide next steps

If TOOL_TYPE is `claude`:

Tell the user:

> ✅ Canvas Authoring MCP server configured (`canvas-authoring`, scope: `{CLAUDE_SCOPE}`).
>
> **Restart Claude Code to activate it.** Remember to use `claude --continue` to resume this session without losing context.
>
> After restarting, verify the setup:
> - `canvas-authoring` should appear in the MCP server list
> - Ask Claude: "List available Canvas App controls" — should invoke `list_controls`

If TOOL_TYPE is `vscode-copilot`:

Tell the user:

> ✅ Canvas Authoring MCP server configured (`canvas-authoring`, configPath: `{CONFIG_PATH}`).
>
> After saving, verify the setup:
> - `canvas-authoring` should appear in the MCP server list
> - Ask Copilot: "List available Canvas App controls" — should invoke `list_controls`

If TOOL_TYPE is `copilot`:

Tell the user:

> ✅ Canvas Authoring MCP server configured (`canvas-authoring`, configPath: `{CONFIG_PATH}`).
>
> **Restart GitHub Copilot CLI to activate it.**
>
> After restarting, verify the setup:
> - `canvas-authoring` should appear in the MCP server list
> - Ask Copilot: "List available Canvas App controls" — should invoke `list_controls`