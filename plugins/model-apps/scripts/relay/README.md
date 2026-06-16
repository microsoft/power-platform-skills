# model-maker relay

A local MCP server that lets an AI agent **co-author model-driven forms** by
driving the live form designer's own commands — the agent gets the same
validation and WYSIWYG rendering a human does.

It owns a Playwright-controlled **Edge** browser and drives the open designer
tab via `page.evaluate` round-trips (CSP-safe — the designer's CSP blocks an
in-page `ws://127.0.0.1` socket, so there is no socket). The injected
[`bridge.js`](./bridge.js) acquires the live `FormDesignerService` (via the
first-party `window.__formDesignerApi` export if present, else a duck-typed
React-fiber walk) and exposes the command surface on `window.__mmBridge`:
discovery (`status` / `inspect` / `listControls` / `describeControl` /
`getControl`), control ops (`addField` / `setControl` / `addComponent` /
`addSubgrid`), structural edits (`addSection` / `addTab` / `addColumn` /
`removeElement` / `moveControl`), property/script edits (`setFieldProps` /
`setFormProps` / `addEventHandler`), `undo`/`redo`, and (opt-in) `save`/`publish`.
Most are DIRECT designer commands (any build); custom-control set/place +
subgrid/section/tab need the façade.

## Tools

| Tool | Purpose |
| --- | --- |
| `designer_open` | Open a form-editor URL and wait until the designer is ready. URL shape: `/e/<env>/s/<solution>/entity/<entity>/form/edit/<formId>` |
| `designer_status` | Bridge readiness + how the handle was acquired (`export` vs `fiber`) |
| `form_inspect` | The open form's sections (with ids) + table fields not yet placed |
| `form_addField` | Add a table field to a section via the designer's own add-field command (live). Owns the duplicate-field guard. |
| `form_listControls` | Custom controls (PCF / AI Builder, e.g. Business card reader) the env offers for a field, with `bindingKind`. Omit the field for the unbound/default list. Read-only. |
| `form_describeControl` | A control's binding kind + parameter schema (name, usage, required, defaults, enum) from its manifest. Read-only. |
| `form_setControl` | Set a custom control on a FIELD via the designer's command. Field-bound controls; `params` applied. Needs the façade build (`enableModelMakerBridge`). |
| `form_addComponent` | Place an UNBOUND/dataset control (PowerBI, subgrid) as a new component in a section; `params` applied. Needs the façade build. |
| `form_addSubgrid` | Add a related-records SUBGRID to a section (e.g. related Contacts). Needs the façade build. |
| `form_setFieldProps` | Set label / visible / readonly / showLabel / locked / availableForPhone on a placed control. DIRECT — any build. |
| `form_removeControl` | Remove a field/control from the form. DIRECT — any build. |
| `form_moveControl` | Move a control to another section / before-after an element. DIRECT — any build. |
| `form_addSection` | Add a 1-4 column section (anchored at a section/tab id). Needs the façade build. |
| `form_addTab` | Add a 1-3 column tab (anchors after the last tab). Needs the façade build. |
| `form_addColumn` | Set a section's column count (1-4) — the add/remove-column op. DIRECT — any build. |
| `form_addEventHandler` | Add a form onLoad/onSave or field onChange handler (form script). The library must already be on the form. DIRECT — any build. |
| `form_setFormProps` | Set form name / description / maxWidth / showImage / showNavigation. DIRECT — any build. |
| `form_removeElement` | Remove ANY element (tab/section/cell) by id. DIRECT — any build. |
| `form_undo` / `form_redo` | Undo/redo the last designer change. DIRECT — any build. |
| `form_save` / `form_publish` | **PERSIST** — disabled unless the relay is started with `MM_ALLOW_SAVE=1` / `MM_ALLOW_PUBLISH=1`. |
| `form_getControl` | Read a field cell's control + props (`classId`, custom controls, label, visible, readonly, …) — the read-back/verify for set ops. Read-only. |

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

**3. Read-only control discovery probe (`probe-controls.js`).** Calls only the
read-only `listControls` / `describeControl` bridge methods — **mutates
nothing**. Lists the custom controls (PCF / AI Builder, e.g. *Business card
reader*) the env offers for a field (with `bindingKind`), and optionally
describes each control's parameter schema. Phase 2.1 (custom controls):

```bash
MM_FORM_URL='https://make.test.powerapps.com/e/.../form/edit/<formId>?...' \
MM_EDGE_PROFILE="$TEMP/mm-edge-profile" \
MM_PROBE_FIELD=name,description,none \
MM_DESCRIBE=all \
npm run probe
```

`MM_DESCRIBE` = comma-separated control ids (or `all` to describe every control
from the first field's list).

**4. Custom-control setter E2E (`set-control.js`).** discover → describe → **set**
a custom control on a field. Needs the first-party façade build
(`enableModelMakerBridge`) → `designer_status` `source: "export"`; against a normal
build `setControl` returns `needs-facade` (discovery still works). Point
`MM_FORM_URL` at the local dev build (`make.local.powerapps.com`):

```bash
MM_FORM_URL='https://make.local.powerapps.com/e/<env>/s/<sol>/entity/account/form/edit/<formId>?cds-form-designer.enableModelMakerBridge=true' \
MM_EDGE_PROFILE="$TEMP/mm-edge-profile" \
MM_FIELD=name \
MM_CONTROL=Intelligence.BusinessCardReaderControl.BusinessCardReader \
MM_PARAMS='{"FilterPaneVisible":"true"}' \
npm run set-control      # sets the control (no save), reads it back, screenshots
```

**5. Unbound-component E2E (`add-component.js`).** Place an unbound/dataset
control (PowerBI, subgrid) as a new component in a section, with params — the
case `form_setControl` can't cover. Also needs the façade build:

```bash
MM_FORM_URL='https://make.local.powerapps.com/e/.../form/edit/<formId>?...' \
MM_EDGE_PROFILE="$TEMP/mm-edge-profile" \
MM_CONTROL=MscrmControls.PowerBIPCFControl \
MM_PARAMS='{"PowerBIReport":"<reportUniqueName>","FilterPaneVisible":"true"}' \
npm run add-component    # places into the first section (or MM_SECTION); no save
```

**6. Structural/property edits E2E (`edit.js`).** Exercises `setFieldProps` (+
`getControl` read-back), `addSubgrid`, `removeControl` (+ read-back), and
`moveControl` in one session. setProps/remove/move are DIRECT (any build);
addSubgrid needs the façade build:

```bash
MM_FORM_URL='https://make.local.powerapps.com/e/.../form/edit/<formId>?...' \
MM_EDGE_PROFILE="$TEMP/mm-edge-profile" \
npm run edit             # MM_FIELD / MM_REMOVE_FIELD / MM_SUBGRID_ENTITY / MM_SUBGRID_REL; no save
```

## Notes

- **stdout is the MCP channel** — all relay logging goes to stderr.
- Designer ops are **serialized** (one in flight) with per-op timeouts; the
  designer DOM is shared mutable state.
- First-party graduation: a flag-gated `window.__formDesignerApi` export in
  `cds-form-designer` removes the fiber walk. See the design spec / POC plan in
  the `powerplatform-modelpages-ade` repo under `docs/ModelMaker/`.
