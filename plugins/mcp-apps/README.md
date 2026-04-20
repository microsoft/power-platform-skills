# MCP Apps Widget Generator

Generate interactive MCP App widgets for MCP tools using Claude Code or Visual Studio Code.

## Installation

### From the marketplace

```bash
/plugin marketplace add microsoft/power-platform-skills
/plugin install mcp-apps@power-platform-skills
```

### From a local clone

```bash
claude --plugin-dir /path/to/power-platform-skills/plugins/mcp-apps
```

## What it does

Describe the visual you want, paste your tool's JSON output, and get a self-contained HTML widget that uses the [MCP Apps protocol](https://modelcontextprotocol.io/extensions/apps/overview). The widget works in any MCP Apps host (Claude, ChatGPT, VS Code, Microsoft 365 Copilot).

## Usage

1. Test your custom tool and copy the JSON output (make sure your tool's output is set to JSON)
2. Run `/generate-mcp-app-ui` and describe the visual you want, pasting your tool's test output

### Example

```
/generate-mcp-app-ui Show travel attractions on an interactive map

Here's my tool's test output:
{"attractions":[{"name":"Space Needle","latitude":47.6205,"longitude":-122.3493,"description":"Observation tower"},{"name":"Pike Place Market","latitude":47.6097,"longitude":-122.3425,"description":"Historic public market"}]}
```

### Refining

After generating, describe changes in the chat:
- "Make it more colorful"
- "Add a chart"
- "Switch to a card layout"

## What it produces

A single HTML file that:
- Uses the MCP Apps protocol (`@modelcontextprotocol/ext-apps`)
- Includes Fluent UI components for a polished look
- Supports light and dark themes automatically
- Loads everything from CDN (no build step, no dependencies)

## Skill structure

```
skills/generate-mcp-app-ui/SKILL.md    - Main skill
references/mcp-apps-reference.md    - MCP Apps API, Fluent UI components, CDN patterns
references/design-guidelines.md     - Visual design defaults, theme tokens
samples/flight-status-widget.html   - Example widget (read-only)
samples/weather-refresh-widget.html - Example widget with callServerTool (interactive)
```

## Evals

53 eval test cases covering different widget types (maps, charts, dashboards, tables, cards, etc.) plus type-mismatch stress tests. See [`evals/mcp-apps/generate-mcp-app-ui/`](../../evals/mcp-apps/generate-mcp-app-ui/) for the eval definitions and [eval-runbook.md](../../evals/mcp-apps/generate-mcp-app-ui/eval-runbook.md) for how to run them.

## License

See the [LICENSE](../../LICENSE) file for license information.
