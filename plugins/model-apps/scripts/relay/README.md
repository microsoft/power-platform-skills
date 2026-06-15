# model-maker relay

A local MCP server that lets an AI agent **co-author model-driven forms** by
driving the live form designer's own commands — the agent gets the same
validation and WYSIWYG rendering a human does.

It owns a Playwright-controlled **Edge** browser and drives the open designer
tab via `page.evaluate` round-trips (CSP-safe — the designer's CSP blocks an
in-page `ws://127.0.0.1` socket, so there is no socket). The injected
[`bridge.js`](./bridge.js) acquires the live `FormDesignerService` (via the
first-party `window.__formDesignerApi` export if present, else a duck-typed
React-fiber walk) and exposes `status` / `inspect` / `addField` on
`window.__mmBridge`.

## Tools

| Tool | Purpose |
| --- | --- |
| `designer_open` | Open a form-editor URL and wait until the designer is ready. URL shape: `/e/<env>/s/<solution>/entity/<entity>/form/edit/<formId>` |
| `designer_status` | Bridge readiness + how the handle was acquired (`export` vs `fiber`) |
| `form_inspect` | The open form's sections (with ids) + table fields not yet placed |
| `form_addField` | Add a table field to a section via the designer's own add-field command (live). Owns the duplicate-field guard. |

## Setup (live run)

```bash
cd plugins/model-apps/scripts/relay
npm install          # @modelcontextprotocol/sdk, playwright-core, zod (no browser download — uses system Edge)
```

Registered in the plugin's `.mcp.json` as `designer-relay`. The MCP server
starts cheaply; **Edge launches lazily on the first `designer_open`**.

### Env (all optional)

| Var | Default | Meaning |
| --- | --- | --- |
| `MM_EDGE_PROFILE` | `<tmp>/mm-edge-profile` | Persistent Edge profile dir so AAD auth survives runs. Sign in once. |
| `MM_START_URL` | `about:blank` | URL the browser opens to on first launch |
| `MM_HEADLESS` | unset (headed) | `1` to run Edge headless (the designer needs a real browser) |

## Typical flow

1. Resolve the form-editor URL (env/solution/entity/formId) — e.g. via the
   plugin's `scripts/dataverse-request.js` against `systemforms`, plus the URL
   shape above.
2. `designer_open(url)` → `designer_status` (`ok:true`).
3. `form_inspect` → pick a section id + an unplaced field.
4. `form_addField(fieldLogicalName, targetSectionId)` → it renders live.
5. Review in the tab; iterate. (Save/publish/solution stay with PAC / `dv-solution`.)

## Tests

Two layers:

**1. Unit (deterministic, no install).** Pure logic — handle acquisition, inspect,
the duplicate guard, the evaluate round-trip, serialization, timeouts:

```bash
node --test plugins/model-apps/scripts/tests/relay-*.test.js
```

**2. Live smoke (`smoke.js`).** Drives the *real* designer through the same
`driver.js`/`bridge.js` the MCP relay uses, but with no MCP/agent in the loop —
a one-command live integration check. Needs `npm install` + a signed-in Edge
profile:

```bash
MM_FORM_URL='https://make.test.powerapps.com/e/.../form/edit/<formId>?...' \
MM_EDGE_PROFILE="$TEMP/mm-edge-profile" \
MM_ADD_FIELD=accountcategorycode \
npm run smoke      # opens the form, inspects, adds the field (no save), screenshots
```

The MCP relay (`designer_open`/`form_inspect`/`form_addField`) is the shipping
product path; `smoke.js` is the regression/acceptance harness for the same code.

## Notes

- **stdout is the MCP channel** — all relay logging goes to stderr.
- Designer ops are **serialized** (one in flight) with per-op timeouts; the
  designer DOM is shared mutable state.
- First-party graduation: a flag-gated `window.__formDesignerApi` export in
  `cds-form-designer` removes the fiber walk. See the design spec / POC plan in
  the `powerplatform-modelpages-ade` repo under `docs/ModelMaker/`.
