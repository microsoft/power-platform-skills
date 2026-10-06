# /pcf Power Pages flow

Use this flow when a standard field PCF control must run in Power Pages. This release supports Power Pages only for standard field controls: the form-field journey and the standalone Liquid journey (`{% codecomponent %}`), both guided. Dataset controls on Pages (form sub-grid and list) are not supported in this release. Read `../../references/pcf-hosts.md` for the rendered prerequisite table; do not re-type site/package versions here. The matrix may list a dataset site prerequisite; that row is not a supported Pages journey in this release. Microsoft Learn sources: https://learn.microsoft.com/en-us/power-pages/configure/component-framework, https://learn.microsoft.com/en-us/power-pages/configure/tutorial-pcf-code, https://learn.microsoft.com/en-us/power-pages/configure/liquid/component-framework-liquid and https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview.

## Common gates

Set `pages.journeys` in `pcf-intent.json` to `["form-field"]`, `["liquid"]`, or both. Omitted journeys default to `form-field`. Render the intent with `write-pcf-plan.js --intent @pcf-intent.json` and resolve blocking findings before proceeding; list/sub-grid/dataset journeys fail schema validation, and a dataset control targeting `pages` is blocked even with an allowed journey.

1. Confirm the control is a standard field control, not virtual and not a dataset control.
2. Check unsupported property types and single-field Pages limits in `pcf-hosts.md`.
3. Run `lint-pcf.js --project <dir> --hosts pages` and `pcf-gates.js --project <dir> --hosts pages`.
4. Deploy/register with consent through `deploy-flow.md`.
5. Configure Pages manually; this release does not write Power Pages configuration tables.

## Journey 1 — form field

Prerequisites are in the matrix table in `pcf-hosts.md` under `formField`.

Steps:

1. Bind the PCF to the model-driven form field for web client.
2. In Pages design studio or Portal Management, enable the custom component for the Basic/Advanced Form field metadata.
3. If the control uses Web API, configure site settings, table permissions and web roles.
4. Open the Pages form as a permitted user and test save → reload.

## Not supported in this release — dataset controls on Pages

Form sub-grid and list journeys are not supported in this release. Dataset templates use paging and `openDatasetItem`, which Microsoft Learn documents for model-driven and canvas apps only: https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/paging and https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/dataset/opendatasetitem. Do not configure a Pages sub-grid or list, and do not verify paging or selection there. Use a model-driven app for dataset controls.

## Journey 2 — standalone Liquid

Prerequisites are in the matrix table under `liquid`.

Steps:

1. Register a standard field control.
2. Add `{% codecomponent name:<registered control name> <property>:'<value>' %}` to the page source, using the registered Dataverse control name (or control ID) and explicit property values as documented on [Microsoft Learn](https://learn.microsoft.com/en-us/power-pages/configure/liquid/component-framework-liquid). Repeat the property/value pair for each required property; do not infer the registered name from the authoring namespace.
3. Save the page source, select **Sync** in design studio, then select **Preview**.
4. Confirm the control renders, then verify browser console/network and user-visible behavior.

## Web API, permissions and security

For any Web API use, configure `Webapi/<logical-name>/enabled` and `Webapi/<logical-name>/fields` with explicit columns; Learn documents that wildcard `*` is deprecated. If using `UseFieldsFromView`, the view name is exactly **Power Pages Web API Columns** and propagation can take several minutes. Raw AJAX needs CSRF; PCF `context.webAPI` should use the host API. Configure table permissions and web roles for the exact create/read/update/delete operations.

## Acceptance checklist

- `built`: production build completed.
- `gated`: `pcf-gates.js --project <dir> --hosts pages` passed.
- `registered`: verifier or inventory sees the control.
- `bound(published)`: model-driven metadata published where applicable.
- `runtime-verified`: the guided form-field or Liquid journey was opened and observed under permitted and denied roles.
- Otherwise report `runtime-not-checked` and do not claim Pages certification.
