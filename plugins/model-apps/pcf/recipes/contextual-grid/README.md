# Contextual grid PCF recipe

`contextual-grid` is a standard field control for model-driven forms. It renders rows returned by a maker-supplied FetchXML template after replacing a `{recordId}` token with the current record id.

## Template

- Template: `field-standard`
- Control type: standard
- Intended field type: model-driven form field control with input properties

## Host support

| Host | Designed for | Certified |
| --- | --- | --- |
| Model-driven apps | Yes | Not certified in this release |
| Power Pages | No | Not certified in this release |

`recipe.json` intentionally keeps `certified` empty. Certification dates should be added only after live host evidence is recorded.

## Configuration

The recipe patches these manifest properties:

| Property | Type | Usage | Required | Notes |
| --- | --- | --- | --- | --- |
| `entityId` | `SingleLine.Text` | `input` | Yes | Bind to the current table primary key column, such as `accountid`. Missing values are treated as unsaved records. |
| `entityName` | `SingleLine.Text` | `input` | Yes | Set to the current table logical name, such as `account`. This is displayed with the unsaved-record message and keeps the documented context inputs together. |
| `fetchXmlTemplate` | `Multiple` | `input` | Yes | FetchXML containing a `{recordId}` token. The token is GUID-validated, XML-escaped, and URL-encoded before Web API retrieval. |
| `pageSize` | `Whole.None` | `input` | No | Defaults to `25`; the control clamps maker input to `1..100`. |

A maker can bind it in either designer path:

1. Modern form designer: select a column, open the **Components** pane, add the control, then configure `entityId`, `entityName`, `fetchXmlTemplate`, and `pageSize`.
2. Classic form designer: open the column's **Controls** tab, add the control, then configure the same properties.

## Behavior

- Replaces exactly the `{recordId}` token in FetchXML after validating the id as a GUID.
- Calls `context.webAPI.retrieveMultipleRecords` with `?fetchXml=` and a page size.
- Displays a table for returned row values, an empty state when no rows return, and an error state when Web API access fails.
- Renders an unsaved-record disabled state when the current record id is missing.
- Provides a **Load more** button when `nextLink` is returned.
- Respects `security.readable` for configuration values and `context.mode.isControlDisabled` for the displayed grid. `security.editable` is not used because this recipe is a read-only view and does not write outputs.
- Keeps state per control instance; no module-global mutable state or hard-coded element ids.

## Limits

- Model-driven apps only in this release. Power Pages support is planned separately because contextual grids require another field binding in addition to the record id input, and this release does not assume a Liquid-provided record context.
- The FetchXML must include `{recordId}` and should select only the columns the maker wants to display.
- The FetchXML template is maker-trusted configuration. Entity and attribute names are sent to Dataverse as configured; invalid names surface as Web API failures and are shown through the control error state.
- The table columns are inferred from the returned row keys after omitting OData annotation keys. When a `<column>@OData.Community.Display.V1.FormattedValue` annotation is present, it is displayed instead of the raw value. Lookup result keys such as `_parentcustomerid_value` are labeled as `parentcustomerid`; formatted lookup names are shown when present, and raw lookup GUIDs are not displayed. Aliased link-entity values such as `contact.fullname` are displayed as returned, but GUID-shaped aliased values without formatted annotations are hidden rather than shown as raw ids.
- Offline behavior is not claimed; this recipe is designed for online Web API access.

## Microsoft Learn references confirmed

- Current record context: the [Power Apps component framework FAQ](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/faq#how-can-i-access-the-record-id-or-table-name) says PCF context does not provide the record id/table name directly and documents adding `entityId` and `entityName` input properties, binding `entityId` to the table primary key column, and setting `entityName` to the logical name.
- Web API availability: [`WebAPI`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/webapi) documents `context.webAPI` for model-driven apps and portals.
- FetchXML retrieval and paging: [`retrieveMultipleRecords`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/webapi/retrievemultiplerecords) documents `retrieveMultipleRecords(entityLogicalName, options, maxPageSize)`, states that `options` can be a FetchXML query using the `fetchXml` parameter, and documents `nextLink` for additional pages. The PCF page describes returned entities as key/value records and does not explicitly promise formatted-value annotations; the control uses `@OData.Community.Display.V1.FormattedValue` when the host returns it and keeps raw fallbacks for non-lookup values.
- Standard control lifecycle: [`init`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/control/init), [`updateView`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/control/updateview), and [`destroy`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/control/destroy).
- Lookup result shape: the model-driven [`Xrm.WebApi.retrieveMultipleRecords`](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/clientapi/reference/xrm-webapi/retrievemultiplerecords#retrieve-or-filter-by-lookup-properties) page documents lookup values coming back as computed `_<name>_value` properties for online scenarios. The FetchXML [select columns](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/fetchxml/select-columns#column-aliases) and [join tables](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/fetchxml/join-tables#basic-example) pages document alias-qualified result names such as `contact.fullname` and show Web API alias responses with formatted-value and lookup-logical-name annotations when annotations are requested.
- Manifest properties, resources, and features: [`property`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/manifest-schema-reference/property), [`resources`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/manifest-schema-reference/resources), and [`uses-feature`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/manifest-schema-reference/uses-feature).