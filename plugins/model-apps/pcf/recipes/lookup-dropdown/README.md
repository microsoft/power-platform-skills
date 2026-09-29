# Lookup dropdown PCF recipe

Lookup dropdown replaces a model-driven app lookup field with an accessible `<select>` that lists
configured target rows and writes the chosen lookup value back through the bound lookup column.

## Template and hosts

- Template: `field-standard`
- Designed for: model-driven apps — not certified in this release
- Power Pages: not supported because `Lookup.Simple` properties are available only for model-driven apps.

## Maker configuration

Bind `lookupValue` to a single-table lookup column. Add the component in the modern form designer
from the Components pane, or in the classic designer from the field's Controls tab.

The control discovers the lookup target table, primary id column and primary name column from PCF
lookup metadata and `context.utils.getEntityMetadata`. Set `selectableFilter` to an OData `$filter`
fragment for rows the dropdown should show, for example the target table's active-row predicate. If
you leave it blank, the dropdown lists rows without an active-row filter. The recipe intentionally
does not hard-code `statecode eq 0` because the active predicate must come from maker configuration
or documented metadata.

## Behavior and limits

- Loads target rows with `context.webAPI.retrieveMultipleRecords` using explicit `$select`, the
  optional configured `selectableFilter`, page size, and `nextLink` paging.
- Keeps an already-selected inactive record visible so users can see and clear the existing value.
- Returns `LookupValue[]` from `getOutputs()` when selected, or `undefined` to clear the lookup.
- Does not notify the host when the selected value is unchanged.
- Shows disabled, unreadable, non-editable, loading and permission-failure states.
- Works on unsaved forms because it never reads a current record id.
- Online model-driven app use only; offline behavior is not claimed in this release.
- Certification is empty until live model-driven app lanes record evidence.

## Learn documentation confirmed

- [`property` manifest element](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/manifest-schema-reference/property):
  documents `Lookup.Simple` as a property `of-type` for model-driven apps.
- [`LookupValue`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/lookupvalue):
  documents the lookup output shape: `id`, `name` and `entityType`.
- [`StandardControl.getOutputs`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/control/getoutputs):
  documents that bound properties return values from `getOutputs()` by manifest property name.
- [`retrieveMultipleRecords`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/webapi/retrievemultiplerecords):
  documents `context.webAPI.retrieveMultipleRecords(entityLogicalName, options, maxPageSize)`,
  `$select`, `$top` and `nextLink` paging.
- [`getEntityMetadata`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/utility/getentitymetadata):
  documents `context.utils.getEntityMetadata(entityName, attributes)` for model-driven apps.
- [`EntityMetadata`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/entitymetadata):
  documents lower-camel metadata properties including `primaryIdAttribute`, `primaryNameAttribute`
  and `metadata`.
