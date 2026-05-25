---
name: configure-canvas-mcp
version: 2.0.0
description: Configure the Canvas Authoring MCP server for the current coauthoring session. USE WHEN "configure MCP", "set up MCP server", "MCP not working", "connect Canvas Apps MCP", "canvas-authoring not available", "MCP not configured", "set up canvas apps". DO NOT USE WHEN prerequisites are missing — direct the user to install .NET 10 SDK first.
author: Microsoft Corporation
user-invocable: true
allowed-tools: Bash, AskUserQuestion, mcp__canvas-authoring__connect
---

# Configure the Canvas Authoring MCP Server

This skill configures the Canvas Authoring MCP server for the user's current Power Apps coauthoring session. The MCP server is auto-registered by the plugin — this skill connects it to a specific app session.

## Instructions

### 0. Check prerequisites

Verify that .NET 10 SDK or higher is installed:

```bash
dotnet --list-sdks
```

If a version 10.x.y or higher is not listed, tell the user:

> ⚠️ .NET 10 SDK is required to run the Canvas Authoring MCP server. It looks like you don't have it installed. Please install it first to use this skill. https://dotnet.microsoft.com/download/dotnet/10.0

Then wait for the user to install it before continuing. If they say it's installed, run the command again to confirm. If it's still not found, repeat the message until they have it installed.

### 1. Ask for the studio URL

Ask the user:

> What is the URL of your canvas app studio session?
>
> Copy the URL from the browser address bar while your app is open in Power Apps Designer (it should look like `https://make.powerapps.com/e/Default-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx/canvas/?action=edit&app-id=...`).
>
> Make sure coauthoring is enabled in the app (Settings → Updates → Coauthoring).
>
> **Keep this browser tab open for the entire session.** The MCP server communicates with Power Apps through the coauthoring session tied to that tab. Closing the tab ends the coauthoring session, which prevents `compile_canvas` and `sync_canvas` from working and means you can't see or save generated changes.

### 2. Extract parameters from the URL

Parse the following from the studio URL:

- **ENV_ID**: the path segment between `/e/` and the next `/` (e.g. `Default-91bee3d9-0c15-4f17-8624-c92bb8b36ead`).
- **APP_ID**: URL-decode the `app-id` query parameter value, then take the last segment after the final `/` (e.g. `6fc3e3d1-292b-4281-8826-577f78512e56`)
- **MAKER_HOSTNAME**: the hostname of the URL (e.g. `make.powerapps.com`)
- **CLUSTER_CATEGORY**: determined from MAKER_HOSTNAME (see table below)

**Determine CLUSTER_CATEGORY from MAKER_HOSTNAME:**

| MAKER_HOSTNAME               | CLUSTER_CATEGORY |
| ---------------------------- | ---------------- |
| `make.powerapps.com`         | `prod`           |
| `make.preview.powerapps.com` | `prod`           |
| `make.gov.powerapps.us`      | `gov`            |
| `make.high.powerapps.us`     | `high`           |
| `make.apps.appsplatform.us`  | `dod`            |
| `make.powerapps.cn`          | `china`          |
| Any other hostname           | `test`           |

**Example:**

Example URL: `https://make.powerapps.com/e/Default-91bee3d9-0c15-4f17-8624-c92bb8b36ead/canvas/?action=edit&app-id=%2Fproviders%2FMicrosoft.PowerApps%2Fapps%2F6fc3e3d1-292b-4281-8826-577f78512e56`

- ENV_ID → `Default-91bee3d9-0c15-4f17-8624-c92bb8b36ead`
- APP_ID → `6fc3e3d1-292b-4281-8826-577f78512e56`
- MAKER_HOSTNAME → `make.powerapps.com`
- CLUSTER_CATEGORY → `prod`

### 3. Configure the MCP server

Call the `connect` MCP tool to connect the server to the user's coauthoring session:

```
mcp__canvas-authoring__connect(
  environment_id: ENV_ID,
  app_id: APP_ID,
  cluster_category: CLUSTER_CATEGORY
)
```

If the call fails, report the error to the user and suggest checking that:
1. The studio URL is correct and the browser tab is still open
2. Coauthoring is enabled in the app settings
3. .NET 10 SDK is correctly installed

### 4. Confirm

Tell the user:

> ✅ Canvas Authoring MCP server configured for your coauthoring session.
>
> You can now use Canvas App skills like `/canvas-app` to create or edit your app.
>
> To verify the setup, try: "List available Canvas App controls" — this should invoke `list_controls`.
