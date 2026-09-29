# PCF host capabilities

This document summarizes the host rules the `/pcf` skill applies before build, deploy and Pages enablement. It is derived from `pcf/compatibility-matrix.json`, Microsoft Learn and observed probe results from this release.

## Host matrix

<!-- Maintainers: regenerate this block with renderHostsTable(loadMatrix()) from scripts/lib/pcf-matrix.js. -->
<!-- pcf-matrix:begin -->
| Host | Control types | Platform libraries | Key rules |
| --- | --- | --- | --- |
| Model-driven apps | standard, virtual | supported | Virtual controls declare React 16.14.0 and Fluent 9.46.2. |
| Power Pages | standard | not supported | formField: site 9.3.3.x, starter package 9.2.2103.x<br>dataset: site 9.4.9.xx, base package 9.3.2209.x<br>liquid: site 9.3.10.x<br>pcfWebApi: site 9.3.10.x, starter package 9.2.2103.x<br>useFieldsFromView: site 9.8.8.x; required features must not be true; unsupported property types include File, Lookup.Customer, Lookup.Owner, Lookup.PartyList, Lookup.Regarding, Status, Status Reason, Whole.Duration, Whole.Language, Whole.TimeZone. |
<!-- pcf-matrix:end -->

## Model-driven apps

- Model-driven apps support standard and virtual controls. PCF renders on forms, views and dashboards per the [PCF overview](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/overview).
- Virtual controls use platform libraries. Learn documents React and Fluent declaration ranges and says the application may load a higher compatible platform-library version at runtime: [React controls & platform libraries](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/react-controls-platform-libraries).
- Field and dataset lifecycle APIs are available in model-driven apps. The skill still verifies each used API because harness support is weaker than deployed runtime support.
- Runtime `context.client.getFormFactor()` values are `0 Unknown`, `1 Desktop`, `2 Tablet`, `3 Phone`: [getFormFactor](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/client/getformfactor). This is separate from FormXML binding factors observed in this release (`phone=0`, `tablet=1`, `web=2`).

## Power Pages

Power Pages support is narrower than model-driven apps.

- Power Pages supports model-driven app controls on configured forms/lists and Liquid pages: [Use code components in Power Pages](https://learn.microsoft.com/en-us/power-pages/configure/component-framework) and [Liquid codecomponent tag](https://learn.microsoft.com/en-us/power-pages/configure/liquid/component-framework-liquid).
- Power Pages does not support virtual controls/platform libraries. Learn's React controls FAQ states React controls and platform libraries are currently only supported for canvas and model-driven apps, and Power Pages React controls do not update based on other fields: [FAQ](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/react-controls-platform-libraries#faq).
- Required `uses-feature` declarations are not allowed for Pages. Optional features must be guarded at the method level and verified on the target site.
- Multi-field form PCF bindings are not supported in Power Pages. A single field binding can be enabled on a Pages form field.
- Power Pages Web API is available through PCF under Pages security, with explicit site settings and table permissions: [portal Web API](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview).

## Platform libraries

<!-- Maintainers: regenerate this block with renderPlatformLibrariesTable(loadMatrix()) from scripts/lib/pcf-matrix.js. -->
<!-- pcf-platform-libraries:begin -->
| Library | Recommended baseline | Documented declarations | Tooling accepted | Baseline exclusions |
| --- | --- | --- | --- | --- |
| React | 16.14.0 | 16.14.0 | 16.8.0-16.14.0<br>18.0.0-18.3.1 | — |
| Fluent | 9.46.2 | 8.29.0<br>8.121.1<br>9.4.0-9.46.2 | 8.0.0-8.29.0<br>8.29.1-8.121.1<br>9.0.0-9.68.0 | 9.68.0 (observed-rejection) |
<!-- pcf-platform-libraries:end -->

Do not hard-code versions in docs or scripts outside the matrix and lockfiles. The matrix owns current baselines, documented declarations, tooling-accepted ranges and observed exclusions.

## Unsupported property types for Pages

The rendered host matrix above lists the manifest property types that are unsupported for Power Pages field bindings.

`File` is listed because an annotation upload is not a PCF File binding. Use a model-driven-only upload recipe or a Pages design with table permissions and portal Web API support.

## Feature availability and guards

- `context.webAPI` is documented for model-driven apps and portals: [WebAPI](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/webapi).
- Device capture and Utility APIs are not supported in Power Pages according to the Pages PCF article: [unsupported code components](https://learn.microsoft.com/en-us/power-pages/configure/component-framework#unsupported-code-components-in-power-pages).
- Dataset paging APIs are documented for model-driven and canvas apps: [Paging](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/paging). Power Pages dataset behavior must be verified in the target site.
- `trackContainerResize` is available for model-driven apps, canvas apps and portals, but test-harness width/height values differ from deployed hosts: [trackContainerResize](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/mode/trackcontainerresize).

## Binding facts from this release

Observed in a test environment on 2026-09-29:

- A designer-shaped FormXML binding with a custom-control cell class id, `uniqueid`, matching `controlDescription forControl`, fallback `<customControl id>`, and all three form factors survived draft and published reads.
- A binding that declared only `formFactor="2"` was rejected with `Custom control declaration for form factor(s) 0,1 is missing for control with uniqueid {…}`. The verifier treats `PCF_BIND_FACTOR_UNDECLARED` as an error.
- `RetrieveDependentComponents(ObjectId, ComponentType=66)` listed the bound form, so where-used for registered solution dependencies is supported. The inventory still warns that this is not proof of Liquid or text references.
- Deleting a bound control was blocked until unbind and publish.

## Grid customizers

The Power Apps grid customizer is a documented Microsoft extension pattern, not a generic host-DOM escape. Learn says each grid can have one customizer control and renderers/editors should be pure, fast, accessible and non-mutating: [Customize the editable grid](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/customize-editable-grid-control).
