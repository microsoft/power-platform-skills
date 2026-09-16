# Eval Runbook for generate-mcp-app-ui

How to evaluate the `generate-mcp-app-ui` skill. Three layers, run in order.

## Related files

- **Skill definition:** `plugins/mcp-apps/skills/generate-mcp-app-ui/SKILL.md`
- **Reference docs:** `plugins/mcp-apps/references/mcp-apps-reference.md`, `plugins/mcp-apps/references/design-guidelines.md`
- **Sample widgets:** `plugins/mcp-apps/samples/flight-status-widget.html`, `plugins/mcp-apps/samples/weather-refresh-widget.html`
- **Self-contained template:** `plugins/mcp-apps/samples/self-contained-widget.template.html`
- **Runtime composer:** `plugins/mcp-apps/scripts/inline-self-contained-runtime.js`

## Eval data

All eval definitions live in `evals.json` alongside this file. The file contains:

- `common_assertions`: 13 assertions every generated widget must pass
- `mode_assertions`: additional checks for `self-contained` and `cdn` output
- `evals`: 58 test cases, each with a `prompt`, inline `data`, per-widget `assertions`, and a `tier` field

The `data` field is the tool's test output. Most cases contain a plain object, which is
treated as `result.structuredContent`. Result-channel cases contain a full authoring
envelope (`content`, `structuredContent`, `meta`) or runtime result (`content`,
`structuredContent`, `_meta`). During rendering tests, authoring `meta` is renamed to
runtime `_meta`.

`delivery_mode` is explicit on cases that exercise mode selection. For cases without the
field, answer the skill's question with **No CDNs / self-contained**, which is the
default.

### Tiers

Each eval has a `tier` to support selective running:

| Tier     | Count | Purpose                                                                                                  |
| -------- | ----- | -------------------------------------------------------------------------------------------------------- |
| `smoke`  | 9     | Diverse representatives plus explicit self-contained and CDN delivery cases. Run on every PR. |
| `full`   | 47    | All remaining core widget types and result-channel cases. Run nightly or pre-release.                    |
| `stress` | 2     | Type-mismatch edge cases (string booleans, empty-string coordinates). Run with full suite.               |

Eval id 51 is tagged `smoke` (not `stress`) so quick runs still exercise type coercion. Its assertions are stress-style (string-to-number parsing), but it runs with the smoke set rather than requiring the full suite.

## Quick start: running one eval

Here is a complete example using eval id 2 (weather widget).

1. Open Claude Code (or any Claude-powered tool with the skill installed).
2. Send a message like:

   > /generate-mcp-app-ui Create a weather widget showing current conditions and 5-day forecast.
   >
   > Here is the tool's test output:
   >
   > ```json
   > {
   >   "city": "Seattle",
   >   "temperature": 58,
   >   "humidity": 72,
   >   "conditions": "Partly Cloudy",
   >   "forecast": [
   >     { "day": "Mon", "high": 62, "low": 48, "conditions": "Sunny" },
   >     { "day": "Tue", "high": 59, "low": 47, "conditions": "Cloudy" },
   >     { "day": "Wed", "high": 55, "low": 44, "conditions": "Rain" },
   >     { "day": "Thu", "high": 57, "low": 45, "conditions": "Partly Cloudy" },
   >     { "day": "Fri", "high": 61, "low": 49, "conditions": "Sunny" }
   >   ]
   > }
   > ```

3. When asked about public CDNs, choose **No CDNs / self-contained** for this example.
4. Save the generated HTML file.
5. **Layer 1 check:** Open the HTML in a text editor and verify: starts with `<!DOCTYPE html>`, has one `<script type="module">`, uses `globalThis.McpAppsRuntime`, contains no public runtime/resource URL, uses `result.structuredContent`, etc. Then check the per-widget assertions: "Shows current temperature prominently", "Shows 5-day forecast strip", "Uses weather icons/emoji for conditions."
6. **Layer 2 check:** Open the HTML in a browser (it needs a JSON-RPC host to send it the tool data, see Step 3 below).
7. **Layer 3 check:** Score the visual result against the rubric.

## How to run evals

### Step 1: Generate widgets

Invoke the `generate-mcp-app-ui` skill via Claude Code by running `/generate-mcp-app-ui` followed by the eval's `prompt`. Paste the eval's `data` JSON into the conversation as the tool's test output.

For each eval in `evals.json`:

- Use the `prompt` as the user message
- Paste the `data` object as the tool's test output JSON
- If `delivery_mode` is present, select that answer when the skill asks about public
  CDNs. Otherwise select **No CDNs / self-contained**.

Save each generated HTML file for testing.

To run only a subset, filter by `tier` (e.g., smoke-only for quick validation).

### Step 2: Layer 1 - Static assertions

Check each generated HTML file against the `common_assertions` (13 checks), the selected
entry in `mode_assertions`, and the eval's per-widget `assertions`.

**Common assertions verify:**

1. Complete HTML file starting with `<!DOCTYPE html>`
2. Exactly one `<script type="module">` block
3. Correct runtime access for the mode: named `App` import for CDN mode or
   `globalThis.McpAppsRuntime` for self-contained mode
4. `app.ontoolresult` set before `app.connect()`
5. `app.onhostcontextchanged` set before `app.connect()`
6. `app.onteardown` set before `app.connect()`
7. Preserves `result.content`, `result.structuredContent`, and `result._meta` without reading `result.meta`
8. Defines and uses `escapeHtml` for user data in innerHTML
9. No `window.openai`
10. No `max-width` on the main container (responsive `@media (max-width:...)` is fine)
11. Uses `var(--color` Fluent design tokens
12. Includes an accessible loading state (`<fluent-spinner>` for CDN mode or a native
    inline spinner for self-contained mode)
13. Includes an error state

**Self-contained mode assertions verify:**

1. The runtime is embedded and the source marker is gone
2. There are no remote script/module/style/font/image/media/iframe/worker/map-tile or
   literal fetch dependencies
3. Visualizations and controls use native HTML/CSS/SVG/Canvas, not `<fluent-*>` elements

**CDN mode assertions verify:**

1. `App` uses the named public-CDN import
2. Fluent Web Components and Fluent tokens load from public CDNs
3. Any additional external library adds clear visual value

These can be checked with text search / regex against the HTML source. No browser needed.

**Pass criteria:** Every widget passes all common assertions, its selected mode
assertions, and its own specific assertions.

### Step 3: Layer 2 - Rendering tests

Load each widget in a browser to verify it actually runs.

**What to check:**

- Widget loads without JavaScript errors in the console
- Content renders (not stuck on "Loading..." or showing the error state)
- Layout is not broken (no overlapping elements, no blank page)

Serve the host and widget over HTTP (for example, `npx serve .` or
`python -m http.server`) so iframe messaging behaves consistently. CDN mode also
requires network access. Self-contained mode must render with public network access
blocked; use browser request interception or an offline environment to prove it makes no
runtime asset requests.

This can be done manually or automated with Playwright / Puppeteer. The widget needs a host page that simulates the MCP Apps JSON-RPC protocol. For plain eval
data, send it as `structuredContent`. For an envelope, send `content`,
`structuredContent`, and `_meta` as separate `toolResult` parameters, renaming authoring
`meta` to `_meta`.

To build a minimal test host: create an HTML page that loads the widget in an iframe and posts JSON-RPC messages via `postMessage`. The key message to send after the widget connects:

```json
{
  "jsonrpc": "2.0",
  "method": "toolResult",
  "params": {
    "structuredContent": { "...eval data object here..." }
  }
}
```

The widget also expects an initial `hostContext` message for theming:

```json
{
  "jsonrpc": "2.0",
  "method": "hostContext",
  "params": {
    "theme": "light",
    "fontFamily": "Segoe UI, sans-serif",
    "containerWidth": 600
  }
}
```

See the [MCP Apps protocol spec](https://modelcontextprotocol.io/specification/2025-03-26/extensions/apps) for the full message format.

For eval 57, trigger **Refresh** and verify `callServerTool` returns through the same
`content`, `structuredContent`, and `_meta` normalization path. For eval 58, verify the
CDN resources load and the chart renders.

**Pass criteria:** All widgets render with visible content and zero JS errors.
Self-contained widgets make zero public runtime/resource requests.

### Step 4: Layer 3 - UX scoring

Review each widget visually (screenshot or live) against this rubric:

| Category | 2 (Full)                                            | 1 (Partial)                      | 0 (Fail)                               |
| -------- | --------------------------------------------------- | -------------------------------- | -------------------------------------- |
| Protocol | Correct MCP setup, structuredContent, escapeHtml    | Minor issue                      | Wrong data access or missing connect() |
| Code     | Clean code, parseFloat for numerics, error handling | Minor issues                     | JS errors, broken logic                |
| Visual   | Polished layout, good spacing, Fluent tokens        | Decent but cramped or misaligned | Broken layout                          |
| Renders  | All data fields populated correctly                 | Some fields missing              | Blank or wrong data                    |
| Design   | Right visual for the data, compact, no clutter      | Reasonable but not optimal       | Wrong visual type                      |

Max score: 10 per widget (5 categories x 2 points).

**Pass criteria:** Average score >= 8.5/10 across all widgets, no individual widget below 7/10.

## When to run evals

- After any change to the skill definition (SKILL.md)
- After changes to reference docs (mcp-apps-reference.md, design-guidelines.md)
- Before submitting a PR that modifies the skill
- Smoke tier is sufficient for small changes; run full + stress for significant updates
