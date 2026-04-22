---
title: Create and edit Canvas Apps with AI code generation tools
description: Learn how to use AI code generation tools like Github Copilot and Claude Code to create and edit canvas apps in Power Apps.
author: shivanichander
ms.author: shivanichander
ms.reviewer: tapanmsft
ms.date: 04/03/2026
ms.topic: how-to
ms.service: powerapps
ms.subservice: canvas-maker
search.audienceType:
- maker
- developer
ms.collection:
- bap-ai-copilot
applies_to:
- PowerApps
---

# Create and edit canvas apps with AI code generation tools (preview)

[!INCLUDE [cc-beta-prerelease-disclaimer](../../includes/cc-beta-prerelease-disclaimer.md)]

This article describes how to use AI code generation tools, such as GitHub Copilot CLI and Claude Code, to create and edit canvas apps in Power Apps. This approach allows you to integrate advanced code generation capabilities directly into your development workflow, allowing you to create new canvas apps or iterate on existing ones using natural language instructions.

> [!IMPORTANT]
>
> - This is a preview feature.
> - [!INCLUDE [cc-preview-features-definition](../../includes/cc-preview-features-definition.md)]

Using AI code generation tools with canvas apps provides an alternative development approach that complements the UI-based experience in Power Apps (make.powerapps.com). 

## What you can do with code generation tools

- *Create new canvas apps* using plain-language requirements
- *Update existing canvas apps* by requesting changes or enhancements through your AI tool
- *Validate your app yaml* in real time using the Canvas Authoring MCP server
- *Work locally* with your preferred IDE and development tools, syncing with live coauthoring sessions

### How it works

1. You describe what you want to build in natural language, for example, "Create a canvas app for tracking expense reports with an approval workflow."
2. The AI code generation tool uses installed canvas app skills to discover available controls, connectors, and data sources, and asks clarifying questions about your requirements.
3. The tool generates production-ready `.pa.yaml` files defining your app screens, controls, and Power Fx formulas.
4. The tool validates the generated code using the Canvas Authoring MCP server and fixes any errors.
5. Your canvas app is synced with Power Apps Designer through the coauthoring session.

## Prerequisites

Before you start, ensure you have the required software and permissions described here.

### Software requirements

| Component | Minimum version | More information |
|-----------|-----------------|------------------|
| .NET SDK | 10.0 or later | [Download .NET SDK](https://dotnet.microsoft.com/download/dotnet/10.0) |
| GitHub Copilot CLI, Claude Code, or other code generation tool | Latest | [GitHub Copilot CLI](https://github.com/features/copilot/cli/) or [Claude Code](https://claude.ai/code) |

### Additional requirements

- A Power Platform environment with a canvas app.
- Power Apps Designer open with **coauthoring enabled** for your canvas app. **Keep this browser tab open for the entire session** — the MCP server communicates with Power Apps through the coauthoring session tied to that tab. Closing the tab ends the coauthoring session, which prevents `compile_canvas` and `sync_canvas` from working and means you can't see or save generated changes.
   - To enable coauthoring, open your app in Power Apps Designer, go to **Settings** > **Updates** and turn on **Coauthoring**.

### Install the canvas apps plugin

To install the canvas apps MCP plugin:

1. Add the Power Platform Skills marketplace plugin: `/plugin marketplace add microsoft/power-platform-skills`
2. Install the Canvas Apps plugin: `/plugin install canvas-apps@power-platform-skills`

Once installed, you need to configure the Canvas Authoring MCP server before you can create or edit apps. You can do this by either:

- Running the `/configure-canvas-mcp` command to set up the MCP server connection.
- Describing what you want to build - the tool detects that the MCP server needs to be configured and guides you through setup.

### Configure the Canvas Authoring MCP server

The canvas apps plugin uses an MCP (Model Context Protocol) server to communicate with Power Apps. Before creating or editing apps, you need to configure this server connection:

1. Open your canvas app in Power Apps Designer and ensure **coauthoring** is enabled.
2. Copy the Power Apps Designer URL from your browser.
3. Run `/configure-canvas-mcp` in your AI tool, or ask the tool to configure the MCP server.
4. Provide the Designer URL when prompted. The tool extracts your environment ID, app ID, and cluster information automatically.

The MCP server provides your AI tool with the ability to list and describe available controls, discover APIs and data sources, validate app YAML, and sync app state from live coauthoring sessions.

### Using other AI code generation tools

For other AI code generation tools, ensure your tool has access to the canvas app resources from the [Power Platform skills](https://github.com/microsoft/power-platform-skills/tree/main/plugins/canvas-apps) GitHub repository. The canvas-apps plugin folder includes control documentation, design guidance, technical reference, and workflow instructions necessary to create code adhering to canvas app requirements. Consult the repository [readme](https://github.com/microsoft/power-platform-skills/blob/main/plugins/canvas-apps/README.md) for information on accessing and using these resources with your preferred tool.

## Skills overview

The Canvas Apps plugin provides these skills for working with canvas apps.

| Skill | Command | Description |
|-------|-------------|---------|
| Generate canvas app | `/generate-canvas-app` | Create a new canvas app from a natural language description |
| Edit canvas app | `/edit-canvas-app` | Edit an existing canvas app from a natural language description |
| Configure Canvas MCP | `/configure-canvas-mcp` | Register the Canvas Authoring MCP server with your AI tool |

These skills enable you to describe what you want to build and have the AI tool generate complete `.pa.yaml` files for your canvas app, validate them against the Canvas Authoring server, and sync changes with your live Power Apps Designer session.

## Create a new canvas app

Follow this workflow when building a new app from scratch.

1. Start a conversation with your AI tool. Describe what you want to create, including the layout and what data you want to include (which Dataverse tables, or connectors to use). Be as specific as you want - the more vague you are with the request, the more details the agent tries to fill in itself. You can also attach or provide an image or other materials to help guide the visuals, theming, and layout. For example:
   - "Create a canvas app for tracking inventory with a searchable list and detail view"
   - "Build a canvas app for employee onboarding with a multi-step form"
   - "Make a canvas app dashboard showing sales metrics with charts and KPIs"
   - "Create a canvas app for field inspections with photo capture"

2. Answer clarifying questions. The AI tool discovers available controls and data sources using the MCP server and asks questions to understand your requirements. Be specific about business needs and data requirements and mention any specific UI components or layout preferences.

3. Review code and validate. The AI tool generates `.pa.yaml` files for each screen and validates them using the Canvas Authoring MCP server. The tool fixes any validation errors automatically. Your changes sync with the live coauthoring session in Power Apps Designer.

4. Test and iterate. Open your canvas app in Power Apps Designer to preview and test. If you need to make changes, return to your AI tool and describe the updates using natural language.

> [!NOTE]
> The AI tool validates each screen by calling the Canvas Authoring MCP server compile tool after generating the YAML. This catches errors early and ensures your app code is valid before syncing.

## Edit an existing canvas app

Use this workflow to update an app that already exists in your coauthoring session.

1. Sync the existing app. In your AI code generation tool, ask to edit your canvas app. The tool syncs the current app state from the coauthoring session, pulling all existing screens and controls into local `.pa.yaml` files. For example, "I want to edit my expense tracking canvas app."

2. Describe your updates. Tell the AI tool what changes you want to make. For example:
   - "Add a filter to show only pending expenses"
   - "Change the home screen layout to use a card-based grid"
   - "Add a new screen for viewing expense history with charts"
   - "Update the form to include a dropdown for expense categories"

3. Review, validate, test, and iterate. The AI tool generates updated `.pa.yaml` files based on your requested changes and validates them with the Canvas Authoring server. Follow the same review and test process described in the "Create a new canvas app" section. Continue iterating with natural language instructions until the app meets your requirements.

## Troubleshooting

### App does not reflect changes

If your changes are not appearing in Power Apps Designer:

1. Verify the Canvas Authoring MCP server is connected by asking the tool to list available controls.
2. Ensure coauthoring is enabled in your Power Apps Designer session (**Settings** > **Updates** > **Coauthoring**).
3. Check that the MCP server is configured with the correct environment ID and app ID by running `/configure-canvas-mcp` again.

### MCP server connection issues

If the Canvas Authoring MCP server is not responding:

1. Verify that .NET 10 SDK is installed by running `dotnet --version` in your terminal.
2. Ensure your Power Apps Studio browser tab is still open with coauthoring enabled. The coauthoring session ends when you close the tab, which disconnects the MCP server's ability to compile and sync changes. If you closed the tab, reopen the app in Power Apps Designer, enable coauthoring, and re-run `/configure-canvas-mcp` with the new Designer URL.
3. Re-run `/configure-canvas-mcp` with a fresh Designer URL.

### Reverting to a working version

If recent changes broke your app or made issues worse, you can ask the AI tool to roll back to a previous working version:

"The recent changes broke the app. Please revert to the last working version."

The AI tool then:

1. Syncs the current state from the coauthoring session
2. Identifies the changes that were made
3. Restores the previous working code
4. Validates and resyncs the stable version

## Best practices

- Start simple. Begin with a basic version of your app and iterate to add complexity.
- Test frequently. Preview your app in Power Apps Designer after each significant change.
- Be specific. Provide detailed requirements to get better initial results.
- Use existing patterns. Reference similar apps or UI patterns when describing your requirements.
- Validate generated code. Always review the generated `.pa.yaml` files to ensure they meet your organization standards and compliance requirements.
- Bold design choices. Do not settle for generic layouts - describe the visual style and aesthetic direction you want.

> [!IMPORTANT]
> While AI code generation tools make a best-effort attempt to generate complete, production-ready code with accessibility and security best practices, you are ultimately responsible for validating the code. Ensure the generated code meets your organization standards, policies, and compliance requirements.

## Related content

- [Create a canvas app from scratch](/power-apps/maker/canvas-apps/create-blank-app)
- [Power Apps canvas app overview](/power-apps/maker/canvas-apps/getting-started)