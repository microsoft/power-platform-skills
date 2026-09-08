# MCP Apps Tool and Widget Generator

Generate JavaScript server runtimes and JSON Schema registration metadata for codeful MCP
tools, plus single-file HTML widgets that visualize their results. Widgets can embed
their runtime for restrictive hosts or use public CDNs when explicitly allowed.

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
values. The type file is removed after generation. The final output is a matched pair:

- `<tool-name>.tool.js` contains the self-contained runtime.
- `<tool-name>.tool.json` contains the tool registration metadata.

The JavaScript file exports:

```javascript
export async function runTool({ toolInput, dataApi }) {
  // Complete server implementation.
}
```

The runtime is self-contained: no packages, imports, network access, filesystem access,
environment variables, or persistent state.

The JSON sidecar keeps registration concerns out of executable code:

```json
{
  "name": "account-summary",
  "description": "Search accounts by name and return revenue and status summaries.",
  "inputSchema": {
    "type": "object",
    "properties": {}
  },
  "outputSchema": {
    "type": "object",
    "properties": {}
  }
}
```

`inputSchema` describes the complete `toolInput` object and its validation constraints.
`outputSchema` describes only the model-visible `structuredContent` business payload. It
does not include conversational `content`, authored `meta`, or runtime `_meta`.

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

The skill asks whether public CDN URLs are allowed. **No CDNs / self-contained** is the
recommended default for MCP Inspector and other hosts with restrictive content security
policies. In that mode, the generated HTML embeds the MCP Apps runtime and Fluent theme
tokens, uses native HTML/CSS/SVG/Canvas for visuals, and has no runtime library downloads.
If CDNs are allowed, the skill retains the smaller CDN-based output.

The UI skill accepts:

- a plain object representing `structuredContent`;
- an authoring envelope with `content`, `structuredContent`, and `meta`; or
- a runtime MCP result with `content`, `structuredContent`, and `_meta`.

`content` and `structuredContent` are visible to the model. Authored `meta` becomes runtime
`_meta`, which is available to the widget but excluded from model context.

### Generate both

Ask `/generate-codeful-mcp-tool` for a widget in the same request. After validating the
paired tool files, it invokes the UI skill with a representative normalized result. The
outputs remain separate: one `.tool.js` server runtime, one `.tool.json` metadata
sidecar, and one `.html` widget.

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

- A self-contained `.tool.js` for codeful server logic and a matching `.tool.json`
  registration sidecar.
- Optionally, a single `.html` widget using `@modelcontextprotocol/ext-apps`, either
  embedded with no CDN dependencies or loaded from public CDNs with Fluent UI Web
  Components.

See [`samples/account-summary.tool.js`](samples/account-summary.tool.js) and
[`samples/account-summary.tool.json`](samples/account-summary.tool.json) for a complete
paired tool example, [`samples/flight-status-widget.html`](samples/flight-status-widget.html)
for a read-only widget, and
[`samples/weather-refresh-widget.html`](samples/weather-refresh-widget.html) for an
interactive CDN widget. The marker-based
[`samples/self-contained-widget.template.html`](samples/self-contained-widget.template.html)
shows the source shape used before the bundled runtime is inlined.

## Skill structure

```text
skills/generate-codeful-mcp-tool/SKILL.md       - Server runtime generator
skills/generate-mcp-app-ui/SKILL.md              - Widget generator
references/codeful-tool-host-data-api.d.ts       - Injected server API contract
references/mcp-apps-reference.md                 - MCP Apps result and lifecycle patterns
references/design-guidelines.md                  - Visual design defaults
assets/self-contained/mcp-app-runtime.min.js      - Vendored no-CDN browser runtime
scripts/inline-self-contained-runtime.js          - Deterministic single-file composer
scripts/_vendor-build/                            - Pinned runtime rebuild tooling
samples/account-summary.tool.js                  - Codeful tool example
samples/account-summary.tool.json                - Tool registration metadata example
samples/flight-status-widget.html                - Read-only widget example
samples/weather-refresh-widget.html              - Interactive widget example
samples/self-contained-widget.template.html       - No-CDN source template
```

## Evals

- [`evals/mcp-apps/generate-codeful-mcp-tool/`](../../evals/mcp-apps/generate-codeful-mcp-tool/)
  covers server generation, Dataverse access, result channels, errors, and UI handoff.
- [`evals/mcp-apps/generate-mcp-app-ui/`](../../evals/mcp-apps/generate-mcp-app-ui/)
  covers widget types, result envelopes, private metadata, and type-mismatch stress cases.

Each suite includes `evals.json` and an `eval-runbook.md`.

## Maintaining the self-contained runtime

The no-CDN runtime is committed at
`assets/self-contained/mcp-app-runtime.min.js`. It is generated code; do not edit it by
hand. Its pinned build inputs live under `scripts/_vendor-build/`.

After intentionally changing a dependency version:

```bash
cd plugins/mcp-apps/scripts/_vendor-build
npm ci
npm run build
npm run check
```

Review `PROVENANCE.json` and `THIRD-PARTY-NOTICES.md` with every runtime update. Normal
widget generation does not install packages: it uses the committed bundle through
`scripts/inline-self-contained-runtime.js`. That script also supports `--prepare` to
replace the embedded runtime region with the editable source marker before refining an
existing widget.

## License

See the [LICENSE](../../LICENSE) file for license information.
