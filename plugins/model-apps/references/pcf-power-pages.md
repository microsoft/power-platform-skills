# PCF on Power Pages

This reference supports the `/pcf` Pages mode. It covers what the skill can verify, what the maker must configure in Power Pages, and where Microsoft Learn is explicit or silent.

Primary Learn sources: [Use code components in Power Pages](https://learn.microsoft.com/en-us/power-pages/configure/component-framework), [dataset code components tutorial](https://learn.microsoft.com/en-us/power-pages/configure/tutorial-pcf-code), [Liquid codecomponent tag](https://learn.microsoft.com/en-us/power-pages/configure/liquid/component-framework-liquid), [portal Web API overview](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview), and [Web API PCF sample](https://learn.microsoft.com/en-us/power-pages/configure/implement-webapi-component).

## Support boundary

- Pages support is for standard controls. Virtual controls and platform libraries are not supported on Power Pages; use model-driven apps for virtual controls: [React controls FAQ](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/react-controls-platform-libraries#faq).
- A Pages form field PCF is one field. Multi-field form PCFs are not supported on Power Pages per Learn.
- Unsupported Pages APIs include `Utility` and listed `Device.*` methods. Optional feature declarations must be guarded and verified: [unsupported code components](https://learn.microsoft.com/en-us/power-pages/configure/component-framework#unsupported-code-components-in-power-pages).
- Pages configuration is not automated by this release. The skill guides configuration and records evidence levels; it does not write Power Pages configuration tables.

## Journeys

| Journey | What `/pcf` can verify | Maker/Pages configuration | Evidence target |
| --- | --- | --- | --- |
| Form field | Registered control, model-driven field binding with Web client, Pages-compatible manifest/property type | Enable custom component in design studio field settings, or Basic Form Metadata `Type: Attribute` with `Control Style: Code Component` | Renders, save → reload round-trips |
| Form sub-grid | Registered dataset control and model-driven sub-grid binding | Basic Form Metadata `Type: Subgrid`, correct Subgrid Name, `Control Style: Code component` | Renders, paging and selection work |
| List | Registered dataset control plus the needed view/table control configuration | Portal Management list with `Use a configured code component = Yes`; Learn documents this toggle in the dataset tutorial | PCF grid renders instead of default grid |
| Standalone Liquid | Registered standard control and property values | `{% codecomponent name:<control> prop:'json string' %}` in page source, then save/sync/preview | Control renders on page |

Minimum site/package versions are owned by the matrix-rendered table in `pcf-hosts.md`. Do not duplicate them here.

## Web API configuration

Power Pages Web API uses the `/_api` route and requires table-level configuration, table permissions and web roles: [portal Web API](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview).

### Logical name vs EntitySetName

- Site settings use the table logical name, for example `Webapi/account/enabled`.
- Raw Web API URLs use the EntitySetName, for example `/_api/accounts`. Learn calls out this distinction and shows how to copy the set name from Maker.
- PCF `context.webAPI` abstracts the host path, but raw AJAX in a Liquid page or helper script must use EntitySetName.

### Required site settings

For each table used by the PCF:

| Setting | Use |
| --- | --- |
| `Webapi/<logical-name>/enabled` | Must be `True` to expose the table. |
| `Webapi/<logical-name>/fields` | Comma-separated explicit column logical names. Learn says wildcard `*` is deprecated and requests fail until explicit columns or a view source are configured. |
| `Webapi/<logical-name>/UseFieldsFromView` | Optional. When `True`, Pages exposes eligible columns from a system view named exactly **Power Pages Web API Columns**. |

`UseFieldsFromView` requires the site version captured in the matrix. Learn says changes to the system view can take up to five minutes to become available to the Web API.

### Permissions

- Configure table permissions for read/create/update/delete as needed and associate them with web roles.
- For annotation upload, Pages needs permission to create annotations, append to the parent, append the parent to the annotation, the required columns exposed, scoped web roles, and timeline visibility rules such as the `*WEB*` note prefix / `NotesFilter` convention where the site uses it.
- Column permissions can further restrict columns exposed through the Web API.

### CSRF

All raw portal Web API AJAX calls must include a CSRF token. PCF `context.webAPI` calls run through the host API and should not invent a separate token path unless the code also makes raw `/_api` requests.

## Notes and files

A model-driven annotation uploader is not a Pages File-binding control. Pages upload designs should use the portal Web API constraints above. The portal Web API overview states actions and functions are not supported through the portals Web API, so do not design a Pages upload around Dataverse chunked upload actions.

## Common failure patterns

| Symptom | Likely area to inspect |
| --- | --- |
| Field renders in model-driven app but not Pages | Virtual/platform library manifest, unsupported field type, field not enabled as a custom component, site version. |
| List falls back to default grid | `Use a configured code component`, view/table control configuration, cache propagation. |
| Web API 403/401 | Table permissions, web roles, contact identity, column permissions. |
| Web API 400 for a column | `fields` does not list the column, `UseFieldsFromView` view has not propagated, wrong logical name. |
| Raw AJAX 404 | EntitySetName vs logical name mismatch. |

## Evidence language

Use the same evidence vocabulary as `pcf-testing.md`. Do not claim `runtime-verified` for Pages until the target site was opened and the control behavior was observed. If no Pages site is available in the release lane, Pages recipe claims stay `not certified in this release` even when designed for Pages.
