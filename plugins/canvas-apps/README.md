# Canvas Apps Plugin

Build Power Apps Canvas Apps with your coding agent as coauthor. This plugin connects AI coding assistants to the Power Apps authoring service over stdio, enabling them to validate .pa.yaml files, browse available controls and their properties, discover APIs/connectors and data sources, and sync app state from live coauthoring sessions. 

> **Preview:** This plugin is currently in [preview](https://www.microsoft.com/en-us/business-applications/legal/supp-powerplatform-preview/). These features are available before official release for customers to provide feedback.

## Prerequisites

- [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0)

## Installation

### From the marketplace

```bash
/plugin marketplace add microsoft/power-platform-skills
/plugin install canvas-apps@power-platform-skills
```

### From a local clone

```bash
claude --plugin-dir /path/to/power-platform-skills/plugins/canvas-apps
```

## Skills

### `/configure-canvas-mcp`

Register the Canvas Authoring MCP server with Claude Code or GitHub Copilot.

**Usage:** Invoke directly with `/configure-canvas-mcp`, or use any of the keywords below to trigger the skill automatically:

- `Configure MCP for Canvas Apps`
- `Set up the Canvas Authoring MCP server`
- `Connect Canvas Apps MCP`

### `/generate-canvas-app`

Generate a complete Canvas App from a natural language description.

**Usage:** Invoke directly with `/generate-canvas-app`, or use any of the keywords below to trigger the skill automatically:

- `Create a Canvas App for managing inventory`
- `I need a Canvas App for tracking employee time off`

### `/edit-canvas-app`

Edit an existing Canvas App from a natural language description of changes.

**Usage:** Invoke directly with `/edit-canvas-app`, or use any of the keywords below to trigger the skill automatically:

- `Modify the form in my existing Canvas App to include validation`
- `Edit my Canvas App to add a new screen for reports`

## MCP Tools

The `canvas-authoring` MCP server exposes the following tools:

| Tool | Description |
|------|-------------|
| `compile_canvas` | Validates canvas app YAML files in a directory using the Power Apps authoring service |
| `describe_api` | Gets detailed information about a specific API (connector) including its operations and parameters |
| `describe_control` | Gets detailed information about a specific Power Apps control including properties, variants, and metadata |
| `get_data_source_schema` | Gets the schema (columns and their Power Fx types) for a specific data source in the current authoring session |
| `list_apis` | Lists all available APIs (connectors) in the current authoring session |
| `list_controls` | Lists all available Power Apps controls in the current authoring session |
| `list_data_sources` | Lists all available data sources in the current authoring session |
| `sync_canvas` | Syncs the current coauthoring session state from the server to a local directory, writing all YAML files |

## Security

Your credentials are always handled securely through the official Azure Identity SDK - we never store or manage tokens directly.

MCP is a new and developing standard. As with all new technology standards, you should review the security of any systems that integrate with MCP servers, such as MCP hosts, clients, agents, AI applications, and models and confirm that they comply with system requirements, standards, and expectations. You should follow Microsoft security guidance for MCP servers, including enabling Entra ID authentication, secure token management, and network isolation. Refer to Microsoft Security Documentation for details.


## License
See the [LICENSE](../../LICENSE) file for license information.