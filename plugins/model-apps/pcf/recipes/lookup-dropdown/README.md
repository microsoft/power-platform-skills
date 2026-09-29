# Lookup dropdown PCF recipe

Lookup dropdown replaces a model-driven app lookup field with an accessible `<select>` that lists
active target rows and writes the chosen lookup value back through the bound lookup column.

## Template and hosts

- Template: `field-standard`
- Designed for: model-driven apps — not certified in this release
- Power Pages: not supported because `Lookup.Simple` properties are available only for model-driven apps.

## Maker configuration

Bind `lookupValue` to a single-table lookup column. Add the component in the modern form designer
from the Components pane, or in the classic designer from the field's Controls tab.

The control discovers the lookup target table, primary id column, primary name column and active
state predicate from PCF lookup metadata and `context.utils.getEntityMetadata`. It does not require
hard-coded table or column names.

## Behavior and limits

- Loads target rows with `context.webAPI.retrieveMultipleRecords` using explicit `$select`, page
  size, and `nextLink` paging.
- Keeps an already-selected inactive record visible so users can see and clear the existing value.
- Returns `LookupValue[]` from `getOutputs()` when selected, or `undefined` to clear the lookup.
- Does not notify the host when the selected value is unchanged.
- Shows disabled, unreadable, non-editable, unsaved, loading and permission-failure states.
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
