# MCP Apps Technical Reference

## MCP Apps API

The widget uses the `App` class from `@modelcontextprotocol/ext-apps` to communicate with the chat host.

### Importing App

`App` is a **named export**, not a default export. You must use curly braces:

```javascript
// CORRECT — named import with curly braces
import { App } from 'https://cdn.jsdelivr.net/npm/@modelcontextprotocol/ext-apps/+esm';

// WRONG — default import, App will be undefined and "App is not a constructor" at runtime
import App from 'https://cdn.jsdelivr.net/npm/@modelcontextprotocol/ext-apps/+esm';
```

### Receiving tool data

Set `app.ontoolresult` BEFORE calling `app.connect()`. When the host delivers the tool result, the callback fires with a `result` object. The data you need is **always** at `result.structuredContent`:

```javascript
app.ontoolresult = (result) => {
  const data = result.structuredContent; // <-- YOUR DATA IS HERE
  // NOT result.data (wrong), NOT result itself (wrong), NOT result.content (wrong)
};
```

### Theme

Set `app.onhostcontextchanged` BEFORE calling `app.connect()`. The callback receives context updates:
- `ctx.theme` is `'light'` or `'dark'`
- After `app.connect()`, call `app.getHostContext()` for the initial theme.

### Calling tools interactively

For user-initiated actions (buttons, interactive controls):
```javascript
const result = await app.callServerTool({ name: 'tool_name', arguments: { key: 'value' } });
// Check result.isError for failures
// result.structuredContent contains the response data
```

### Lifecycle

All event handlers (`ontoolresult`, `onhostcontextchanged`, `onteardown`) MUST be registered BEFORE calling `app.connect()`.

```javascript
const app = new App({ name: "widget", version: "1.0.0" });
app.ontoolresult = (result) => {
  const data = result.structuredContent; // always .structuredContent
  renderData(data);
};
app.onhostcontextchanged = (ctx) => { /* handle theme changes */ };
app.onteardown = () => ({});
await app.connect();
```

## Fluent UI Web Components v3

Load via: `<script src="https://unpkg.com/@fluentui/web-components@beta/dist/web-components.min.js"></script>`

Available components (use these instead of plain HTML equivalents):
- `<fluent-card>` - container with elevation
- `<fluent-button appearance="primary|outline|subtle">` - buttons
- `<fluent-text-input>` - single-line input
- `<fluent-textarea>` - multi-line input
- `<fluent-dropdown>` with `<fluent-listbox>` and `<fluent-option>` - dropdowns
- `<fluent-checkbox>` - checkbox
- `<fluent-spinner>` - loading indicator
- `<fluent-divider>` - separator
- `<fluent-badge appearance="filled|outline">` - status badges
- `<fluent-switch>` - toggle switch
- `<fluent-tooltip>` - tooltip

## Loading CDN libraries

You can load external CDN libraries (for maps, charts, data visualization, etc.) via script tags when they add clear value.

### UMD global collision

When loading multiple UMD libraries via `<script>` tags, they can overwrite each other's globals. For example, Fluent UI Web Components can overwrite globals that other UMD libraries register (such as single-letter variables like `L` or `_`).

**Best practice:** Load UMD libraries sequentially. After each one loads, save a reference to its global before loading the next:

```html
<script>
  (function() {
    var s = document.createElement('script');
    s.src = 'https://cdn.example.com/my-map-lib.js'; // your UMD library
    s.onload = function() {
      // Save the library's global before Fluent overwrites it
      window.MyMapLib = window.L;
      // Now safe to load Fluent
      var f = document.createElement('script');
      f.src = 'https://unpkg.com/@fluentui/web-components@beta/dist/web-components.min.js';
      document.head.appendChild(f);
    };
    document.head.appendChild(s);
  })();
</script>
```

Then use the saved reference (NOT the original global) for all API calls: `MyMapLib.map()`, `MyMapLib.marker()`, etc.

Guard initialization since scripts load asynchronously:
```javascript
function initWhenReady(data) {
  if (window.MyMapLib && typeof window.MyMapLib.map === 'function') {
    initMap(data);
  } else {
    setTimeout(() => initWhenReady(data), 100);
  }
}
```

This pattern applies to any UMD library. If you load multiple libraries that use globals, save each reference immediately after loading.

## Security

Always escape user-provided text before inserting into HTML:
```javascript
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
```
Prefer `textContent` over `innerHTML` wherever possible.

## Accessibility

- Add `aria-label` to icon-only buttons and non-text interactive elements
- Ensure focus is visible on interactive elements (Fluent handles this by default)
- Use semantic structure: headings for sections, lists for groups
- Ensure readable contrast in both light and dark themes
- Respect `prefers-reduced-motion`: wrap animations in `@media (prefers-reduced-motion: no-preference) { }`

## Data type safety

MCP tool responses are JSON, but field values at runtime frequently differ from sample/test data: numbers arrive as strings, null fields arrive as empty strings, booleans arrive as `"true"`/`"false"` strings. Never assume runtime types match the sample.

When reading fields from tool data, use these defaults:

**Numeric fields** (coordinates, prices, counts, percentages):

    const lat = parseFloat(item.latitude);
    if (!isFinite(lat)) { /* treat as missing */ }

`parseFloat` returns `NaN` for `null`, `undefined`, `""`, and non-numeric strings. `isFinite` rejects `NaN` and `Infinity`. This is safer than `Number()` which converts `""` and `null` to `0`.

**Optional fields** (descriptions, notes, any field that might be absent):

    const desc = (item.description == null || String(item.description).trim() === '')
      ? null
      : String(item.description).trim();

This treats `null`, `undefined`, and empty/whitespace strings as missing. Do not rely on `!= null` alone, as empty strings pass that check.

**Boolean fields** (active, enabled, completed):

    const isActive = item.active === true || String(item.active).toLowerCase() === 'true';

Do not use truthiness (`if (item.active)`) because the string `"false"` is truthy.
