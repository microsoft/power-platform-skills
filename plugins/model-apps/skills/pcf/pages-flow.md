# /pcf Power Pages flow

Use this flow when a PCF control must run in Power Pages. Read `../../references/pcf-hosts.md` for the rendered prerequisite table; do not re-type site/package versions here. Microsoft Learn sources: https://learn.microsoft.com/en-us/power-pages/configure/component-framework, https://learn.microsoft.com/en-us/power-pages/configure/tutorial-pcf-code, https://learn.microsoft.com/en-us/power-pages/configure/liquid/component-framework-liquid and https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview.

## Common gates

1. Confirm the control is standard, not virtual.
2. Check unsupported property types and single-field Pages limits in `pcf-hosts.md`.
3. Run `lint-pcf.js` and `pcf-gates.js` with `--hosts pages`.
4. Deploy/register with consent through `deploy-flow.md`.
5. Configure Pages manually; this release does not write Power Pages configuration tables.

## Journey 1 — form field

Prerequisites are in the matrix table in `pcf-hosts.md` under `formField`.

Steps:

1. Bind the PCF to the model-driven form field for web client.
2. In Pages design studio or Portal Management, enable the custom component for the Basic/Advanced Form field metadata.
3. If the control uses Web API, configure site settings, table permissions and web roles.
4. Open the Pages form as a permitted user and test save → reload.

## Journey 2 — form sub-grid

Prerequisites are in the matrix table under `dataset`.

Steps:

1. Register and bind the dataset/sub-grid control in model-driven metadata.
2. Add Basic Form Metadata of type Subgrid with the exact subgrid name and code component style.
3. Verify loading, empty, error and paging behavior on the site.

## Journey 3 — list

Prerequisites are in the matrix table under `dataset` and `useFieldsFromView` where the design uses view-derived columns.

Steps:

1. Configure the table/view to use the dataset PCF.
2. In Portal Management, set the list to **Use a configured code component = Yes**.
3. Confirm the list renders the PCF rather than the default grid.

## Journey 4 — standalone Liquid

Prerequisites are in the matrix table under `liquid`.

Steps:

1. Register a standard control.
2. Add a Liquid `{% codecomponent %}` tag with explicit property values.
3. Save, sync and preview the page.
4. Verify browser console/network and user-visible behavior.

## Web API, permissions and security

For any Web API use, configure `Webapi/<logical-name>/enabled` and `Webapi/<logical-name>/fields` with explicit columns; Learn documents that wildcard `*` is deprecated. If using `UseFieldsFromView`, the view name is exactly **Power Pages Web API Columns** and propagation can take several minutes. Raw AJAX needs CSRF; PCF `context.webAPI` should use the host API. Configure table permissions and web roles for the exact create/read/update/delete operations.

## Acceptance checklist

- `built`: production build completed.
- `gated`: `pcf-gates.js --hosts pages` passed.
- `registered`: verifier or inventory sees the control.
- `bound(published)`: model-driven metadata published where applicable.
- `runtime-verified`: the Pages journey above was opened and observed under permitted and denied roles.
- Otherwise report `runtime-not-checked` and do not claim Pages certification.
