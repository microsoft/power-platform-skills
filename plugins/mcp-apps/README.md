# MCP Apps Tool and Widget Generator

Generate JavaScript server runtimes for codeful MCP tools and self-contained HTML widgets
that visualize their results.

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

## Skills

### Generate a codeful MCP tool

Run `/generate-codeful-mcp-tool` with the tool's purpose, inputs, expected result, and any
Dataverse data it needs:

```text
/generate-codeful-mcp-tool Create a tool named account-summary.
It accepts nameContains (string) and limit (integer, maximum 100), queries matching
accounts, and returns their names, revenue, and status.
```

For Dataverse-backed tools, the skill uses PAC CLI to discover exact table logical names
and generates a temporary `RuntimeTypes.ts` for verified columns, lookup shapes, and choice
values. The type file is removed after generation. The final output is one
`<tool-name>.tool.js` file with:

```javascript
export async function runTool({ toolInput, dataApi }) {
  // Complete server implementation.
}
```

The runtime is self-contained: no packages, imports, network access, filesystem access,
environment variables, or persistent state.

### Generate an MCP App widget

Run `/generate-mcp-app-ui`, describe the visual, and provide the tool's test output:

```text
/generate-mcp-app-ui Show account revenue as a bar chart.

Here is the tool's test output:
{
  "content": "Found 2 accounts.",
  "structuredContent": {
    "accounts": [
      { "name": "Contoso", "revenue": 1500000 },
      { "name": "Fabrikam", "revenue": 2300000 }
    ]
  },
  "meta": { "preferredView": "bar-chart" }
}
```

The UI skill accepts:

- a plain object representing `structuredContent`;
- an authoring envelope with `content`, `structuredContent`, and `meta`; or
- a runtime MCP result with `content`, `structuredContent`, and `_meta`.

`content` and `structuredContent` are visible to the model. Authored `meta` becomes runtime
`_meta`, which is available to the widget but excluded from model context.

### Generate both

Ask `/generate-codeful-mcp-tool` for a widget in the same request. After validating the
server file, it invokes the UI skill with a representative normalized result. The outputs
remain separate: one `.tool.js` server runtime and one `.html` widget.

## Codeful tool result contract

For a simple structured result, return a plain object. The host promotes it to
`structuredContent`:

```javascript
return { records, totalCount: records.length };
```

Use an envelope when the result channels need different visibility:

```javascript
return {
  content: `Found ${records.length} records.`,
  structuredContent: { records },
  meta: { preferredView: "table" },
};
```

The envelope keys are reserved. If business data itself contains `content`,
`structuredContent`, or `meta`, wrap the payload explicitly in `structuredContent`.

## What it produces

- A single self-contained `.tool.js` for codeful server logic.
- Optionally, a single self-contained `.html` widget using
  `@modelcontextprotocol/ext-apps` and Fluent UI Web Components.

See [`samples/account-summary.tool.js`](samples/account-summary.tool.js) for a complete
server example, [`samples/flight-status-widget.html`](samples/flight-status-widget.html)
for a read-only widget, and
[`samples/weather-refresh-widget.html`](samples/weather-refresh-widget.html) for an
interactive widget.

## Skill structure

```text
skills/generate-codeful-mcp-tool/SKILL.md       - Server runtime generator
skills/generate-mcp-app-ui/SKILL.md              - Widget generator
references/codeful-tool-host-data-api.d.ts       - Injected server API contract
references/mcp-apps-reference.md                 - MCP Apps result and lifecycle patterns
references/design-guidelines.md                  - Visual design defaults
samples/account-summary.tool.js                  - Codeful tool example
samples/flight-status-widget.html                - Read-only widget example
samples/weather-refresh-widget.html              - Interactive widget example
```

## Evals

- [`evals/mcp-apps/generate-codeful-mcp-tool/`](../../evals/mcp-apps/generate-codeful-mcp-tool/)
  covers server generation, Dataverse access, result channels, errors, and UI handoff.
- [`evals/mcp-apps/generate-mcp-app-ui/`](../../evals/mcp-apps/generate-mcp-app-ui/)
  covers widget types, result envelopes, private metadata, and type-mismatch stress cases.

Each suite includes `evals.json` and an `eval-runbook.md`.

## License

See the [LICENSE](../../LICENSE) file for license information.
