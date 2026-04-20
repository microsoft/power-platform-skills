# Eval Runbook for generate-mcp-app-ui

How to evaluate the `generate-mcp-app-ui` skill. Three layers, run in order.

## Related files

- **Skill definition:** `plugins/mcp-apps/skills/generate-mcp-app-ui/SKILL.md`
- **Reference docs:** `plugins/mcp-apps/references/mcp-apps-reference.md`, `plugins/mcp-apps/references/design-guidelines.md`
- **Sample widgets:** `plugins/mcp-apps/samples/flight-status-widget.html`, `plugins/mcp-apps/samples/weather-refresh-widget.html`

## Eval data

All eval definitions live in `evals.json` alongside this file. The file contains:

- `common_assertions`: 13 assertions every generated widget must pass
- `evals`: 53 test cases, each with a `prompt`, inline `data`, per-widget `assertions`, and a `tier` field

The `data` field on each eval is the JSON object that an MCP tool would return at runtime. During widget generation, you paste it into the conversation as "the tool's test output." During rendering tests, it becomes the value of `result.structuredContent` in the JSON-RPC `toolResult` message that the host sends to the widget's iframe.

### Tiers

Each eval has a `tier` to support selective running:

| Tier     | Count | Purpose                                                                                                  |
| -------- | ----- | -------------------------------------------------------------------------------------------------------- |
| `smoke`  | 7     | Diverse representatives (map, chart, table, cards, complex layout, structured, stress). Run on every PR. |
| `full`   | 44    | All remaining core widget types. Run nightly or pre-release.                                             |
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

3. Save the generated HTML file.
4. **Layer 1 check:** Open the HTML in a text editor and verify: starts with `<!DOCTYPE html>`, has one `<script type="module">`, uses `result.structuredContent`, etc. Then check the per-widget assertions: "Shows current temperature prominently", "Shows 5-day forecast strip", "Uses weather icons/emoji for conditions."
5. **Layer 2 check:** Open the HTML in a browser (it needs a JSON-RPC host to send it the tool data, see Step 3 below).
6. **Layer 3 check:** Score the visual result against the rubric.

## How to run evals

### Step 1: Generate widgets

Invoke the `generate-mcp-app-ui` skill via Claude Code by running `/generate-mcp-app-ui` followed by the eval's `prompt`. Paste the eval's `data` JSON into the conversation as the tool's test output.

For each eval in `evals.json`:

- Use the `prompt` as the user message
- Paste the `data` object as the tool's test output JSON

Save each generated HTML file for testing.

To run only a subset, filter by `tier` (e.g., smoke-only for quick validation).

### Step 2: Layer 1 - Static assertions

Check each generated HTML file against the `common_assertions` (13 checks) plus the eval's per-widget `assertions`.

**Common assertions verify:**

1. Complete HTML file starting with `<!DOCTYPE html>`
2. Exactly one `<script type="module">` block
3. Named import: `import { App } from ...`
4. `app.ontoolresult` set before `app.connect()`
5. `app.onhostcontextchanged` set before `app.connect()`
6. `app.onteardown` set before `app.connect()`
7. Uses `result.structuredContent` to access data
8. Defines and uses `escapeHtml` for user data in innerHTML
9. No `window.openai`
10. No `max-width` on the main container (responsive `@media (max-width:...)` is fine)
11. Uses `var(--color` Fluent design tokens
12. Includes `<fluent-spinner>` loading state
13. Includes an error state

These can be checked with text search / regex against the HTML source. No browser needed.

**Pass criteria:** Every widget passes all common assertions plus its own specific assertions.

### Step 3: Layer 2 - Rendering tests

Load each widget in a browser to verify it actually runs.

**What to check:**

- Widget loads without JavaScript errors in the console
- Content renders (not stuck on "Loading..." or showing the error state)
- Layout is not broken (no overlapping elements, no blank page)

**Important:** Widgets import ES modules from CDN, so they must be served over HTTP (e.g., `npx serve .` or `python -m http.server`). Opening via `file://` will fail due to CORS restrictions on module imports.

This can be done manually or automated with Playwright / Puppeteer. The widget needs a host page that simulates the MCP Apps JSON-RPC protocol, sending the eval's `data` as the `structuredContent` in a `toolResult` message.

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

**Pass criteria:** All widgets render with visible content, zero JS errors.

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
