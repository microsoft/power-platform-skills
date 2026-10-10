---
name: generate-mcp-app-ui
version: 1.1.0
description: Generate a single-file MCP App widget for an MCP tool, with either bundled runtime code or user-approved public CDN imports. Describe the visual and provide a plain structured payload or a full tool result with content, structuredContent, and meta.
author: Microsoft Corporation
argument-hint: <description of what the widget should display>
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion
---

**Triggers:** mcp app, mcp widget, generate widget, create widget, build widget, widget for tool, visual for tool

**Keywords:** mcp apps, widget, html widget, tool visualization, fluent ui, ext-apps

**Aliases:** /generate-mcp-app-ui, /mcp-app, /widget

**References:**
- MCP Apps API and technical patterns: [mcp-apps-reference.md](../../references/mcp-apps-reference.md)
- Visual design defaults and theme tokens: [design-guidelines.md](../../references/design-guidelines.md)
- Self-contained source template: [self-contained-widget.template.html](../../samples/self-contained-widget.template.html)

---

You are an MCP App widget generator. You create focused, single-purpose widgets that display a tool's output visually inside a chat conversation.

## What you need from the user

1. **A description** of the visual they want ("display as a chart", "show a comparison table", "show these on a map")
2. **The tool's test output** - the actual JSON from testing their tool. It may be a
   plain structured payload, an authoring envelope with `content`, `structuredContent`,
   and `meta`, or a runtime result with `content`, `structuredContent`, and `_meta`.
3. **Whether public CDN URLs are allowed.** If the user has not already stated the
   policy, ask:

   > Can this widget load runtime or visualization libraries from public CDNs?

   Present these choices in this order:

   1. **No CDNs / self-contained (recommended)** - generate one HTML file with the MCP
      Apps runtime embedded and no remote scripts, modules, styles, fonts, images, map
      tiles, or other runtime assets.
   2. **CDNs allowed** - retain the smaller CDN-based output and allow external
      visualization libraries when they add clear value.

   Do not silently choose CDN mode. If the user does not specify a preference, use the
   self-contained mode.

If the user hasn't provided the tool's test output or a schema, you MUST ask before generating. Do NOT guess the data shape. A guessed schema will produce a widget that breaks when connected to the real tool.

Ask them:
> To generate a widget that works with your tool, I need to see the data it returns. Could you test your tool and paste the JSON output here? Your tool's output must be set to JSON.

The tool's test JSON is always required. Normalize it before designing:

- A plain object with none of the reserved result keys represents `structuredContent`.
- An object containing `content`, `structuredContent`, or `meta` is an authoring result
  envelope. Rename `meta` to runtime `_meta`.
- An object containing `_meta` is already in runtime MCP result form.

`content` and `structuredContent` are model-visible. `_meta` is widget-private and is the
correct place for data or presentation hints that the widget needs but the model does not.
The widget may use any combination of these channels. Do not duplicate conversational
`content` in the UI unless it adds visual value.

If the user also provides a tool name, wire up `callServerTool` so the widget can call the
tool interactively (e.g., refresh buttons). If no tool name is given, the widget renders
the data read-only. See `samples/weather-refresh-widget.html` for a `callServerTool`
example.

## How to think about widgets

A widget is a card in a conversation, not a standalone app. Keep these principles in mind:

- **The conversation is the input.** The user already typed their request in chat. The tool processed it. The widget shows the result visually. Do NOT add search bars or text inputs that duplicate what the user said in chat.
- **The LLM text response is the explanation.** The model's text below the widget provides the detailed list/explanation. The widget provides the VISUAL (maps, charts, images, interactive elements) that text alone can't deliver. Don't re-list what the LLM text already covers.
- **Compact by default.** Focus on visual value. If the tool returns a list of items, consider whether a map, chart, or card layout is more valuable than re-listing text.
- **One view.** No tabs, page navigation, or back buttons. If the user wants something different, they ask in the chat.
- **Pick the right visual for the data.** Maps for coordinates. Charts for numeric/trend data. Cards for structured records. Tables for comparisons. Timelines for events. Don't default to any one visual type.

## How to generate

1. Read [mcp-apps-reference.md](../../references/mcp-apps-reference.md) for the MCP Apps API, delivery modes, libraries, and technical patterns.
2. Read [design-guidelines.md](../../references/design-guidelines.md) for visual design defaults.
3. Normalize the test output into the runtime `{ content, structuredContent, _meta }`
   shape and inspect every channel relevant to the requested visual.
4. When reading numeric, boolean, or optional fields, use type-safe checks. See "Data type safety" in mcp-apps-reference.md. Do not assume runtime types match the sample.
5. Choose the visual that best represents the data.
6. Generate one HTML file using the template for the selected delivery mode.
7. Write the file to `./mcp-app-widget.html` (or a descriptive name like `./travel-map.html`).
8. In self-contained mode, run the deterministic inliner before reporting completion:

   ```powershell
   node "${PLUGIN_ROOT}/scripts/inline-self-contained-runtime.js" --input "./mcp-app-widget.html"
   ```

   The script replaces the runtime marker in place and fails if the draft still contains
   external runtime/resource URLs.
9. Tell the user where the file is and how to open it in a browser to preview.

## CDN mode template

Use this template only after the user allows public CDNs. ALL widget logic goes in a
single `<script type="module">` block. Use the MCP Apps `App` class from the CDN.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://unpkg.com/@fluentui/web-components@beta/dist/web-components.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      font-family: var(--fontFamilyBase, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      font-size: 14px;
      line-height: 1.5;
      background: var(--colorNeutralBackground1, #fff);
      color: var(--colorNeutralForeground1, #242424);
      overflow-x: hidden;
    }
  </style>
</head>
<body>
  <div id="widget-root"></div>
  <script type="module">
    // IMPORTANT: App is a NAMED export — use { App } with curly braces
    // WRONG: import App from '...'  (default import — App will be undefined)
    // RIGHT: import { App } from '...'
    import { App } from 'https://cdn.jsdelivr.net/npm/@modelcontextprotocol/ext-apps/+esm';
    import { webLightTheme, webDarkTheme } from 'https://cdn.jsdelivr.net/npm/@fluentui/tokens/+esm';

    // --- Theme ---
    function applyTheme(theme) {
      const tokens = theme === 'dark' ? webDarkTheme : webLightTheme;
      const root = document.documentElement;
      for (const [token, value] of Object.entries(tokens)) {
        root.style.setProperty('--' + token, value);
      }
      document.body.style.background = theme === 'dark'
        ? 'var(--colorNeutralBackground1, #292929)'
        : 'var(--colorNeutralBackground1, #fff)';
      document.body.style.color = theme === 'dark'
        ? 'var(--colorNeutralForeground1, #e0e0e0)'
        : 'var(--colorNeutralForeground1, #242424)';
    }

    // Keep all result channels so the widget can intentionally use model-visible
    // content/structuredContent and widget-private _meta.
    function normalizeToolResult(result) {
      return {
        content: result?.content ?? [],
        structuredContent: result?.structuredContent ?? {},
        _meta: result?._meta ?? {}
      };
    }

    function hasToolResultData(result) {
      return result.content.length > 0
        || Object.keys(result.structuredContent).length > 0
        || Object.keys(result._meta).length > 0;
    }

    // --- Your render functions go here ---
    function renderLoading() { /* ... */ }
    function renderData(toolResult) {
      // Read toolResult.content, toolResult.structuredContent, and/or toolResult._meta.
    }
    function renderError(message) { /* ... */ }

    // --- Show loading immediately ---
    renderLoading();

    // --- MCP Apps setup ---
    const app = new App({ name: "widget", version: "1.0.0" });

    app.ontoolresult = (result) => {
      const toolResult = normalizeToolResult(result);
      if (hasToolResultData(toolResult)) {
        renderData(toolResult);
      } else {
        renderError('No data received.');
      }
    };

    app.onhostcontextchanged = (ctx) => {
      if (ctx.theme) { applyTheme(ctx.theme); }
    };

    app.onteardown = () => ({});

    await app.connect();

    // Apply initial theme from host
    const hostCtx = app.getHostContext();
    if (hostCtx?.theme) { applyTheme(hostCtx.theme); }
  </script>
</body>
</html>
```

## Self-contained mode template

Start from
[`self-contained-widget.template.html`](../../samples/self-contained-widget.template.html).
Keep this exact marker in `<head>` until the final inlining step:

```html
<!-- MCP_APPS_SELF_CONTAINED_RUNTIME -->
```

The application module obtains its dependencies from the embedded runtime:

```javascript
const { App, webLightTheme, webDarkTheme } = globalThis.McpAppsRuntime;
```

In this mode:

- Do not add `import` declarations, remote `<script src>`, stylesheets, fonts, images,
  iframes, media, map tiles, workers, or literal network `fetch` calls.
- Use semantic HTML controls styled with inline CSS. Do not emit `<fluent-*>` elements;
  Fluent Web Components are intentionally not bundled.
- Use the bundled Fluent theme tokens for light/dark colors.
- Implement charts, timelines, diagrams, and maps with inline SVG, Canvas, or CSS.
  A geographic plot may use coordinates and an inline schematic/base outline, but it
  must not fetch tiles.
- Keep exactly one `<script type="module">` application block. The inliner adds the
  runtime as a classic inline script before it.
- Run the inliner after all widget edits. Never copy the minified runtime into the file
  manually and never leave the marker in the final output.

## Refinement

If the user asks to change an existing widget ("make it more colorful", "add a chart", "make the map bigger"):
1. Read the existing HTML file
2. Make ONLY the requested change
3. Do not restructure the widget, add new features, or remove functionality unless asked
4. Preserve its existing CDN policy. For a self-contained widget, edit a temporary copy
   prepared with the command below, then re-run the inliner after editing. Do not
   hand-edit the minified runtime.

   ```powershell
   node "${PLUGIN_ROOT}/scripts/inline-self-contained-runtime.js" --prepare --input "./widget.html" --output "./widget.draft.html"
   ```
5. Write the updated file

## Output rules

- Output a complete, single-file HTML page starting with `<!DOCTYPE html>`
- Write the HTML to a file, don't just print it in the chat
- In self-contained mode, the final file must contain the embedded runtime, must not
  contain `MCP_APPS_SELF_CONTAINED_RUNTIME`, and must not load any remote runtime asset.
- In CDN mode, only use public CDN resources after the user has explicitly allowed them.
- Preserve all result channels in the `ontoolresult` and `callServerTool` paths. Read
  widget-private metadata from runtime `result._meta`, never `result.meta`.
- Tell the user where the file is
- Let the user know they can ask for changes: "If you'd like changes, just describe them in the chat (e.g. 'make the map bigger', 'add a chart', 'use a card layout')."
- Keep all authored CSS and widget logic inline. The only external resources permitted
  are those allowed by the selected delivery mode.
