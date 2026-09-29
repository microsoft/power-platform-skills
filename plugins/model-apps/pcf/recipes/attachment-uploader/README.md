# Attachment uploader PCF recipe

`attachment-uploader` is a standard field-control recipe that lets a model-driven app user choose one small file and upload it as a Dataverse note (`annotation`) on the current saved record.

## Template

- Template: `field-standard`
- Control type: standard
- Intended field type: `SingleLine.Text` host column plus configuration inputs

## Host support

| Host | Designed for | Certified |
| --- | --- | --- |
| Model-driven apps | Yes | Not certified in this release |
| Power Pages | No | Not certified in this release |

`recipe.json` intentionally keeps `certified` empty for both hosts. Certification dates should be added only after live host evidence is recorded.

## Configuration

The recipe patches these manifest properties:

| Property | Type | Usage | Required | Notes |
| --- | --- | --- | --- | --- |
| `value` | `SingleLine.Text` | `bound` | Yes | A text column used to host the field control. The control does not store file content in this column. |
| `entityId` | `SingleLine.Text` | `input` | Yes | Bind to the table primary key column. A missing or invalid id means the parent row is unsaved, so upload is disabled. |
| `entityName` | `SingleLine.Text` | `input` | Yes | Static table logical name for maker clarity and diagnostics. |
| `parentEntitySetName` | `SingleLine.Text` | `input` | Yes | The parent table Web API entity set name, for example `accounts`. Configure this; the control never guesses it. |
| `parentNavigationProperty` | `SingleLine.Text` | `input` | Yes | The annotation-to-parent navigation property, for example `objectid_account`. Configure this; the control never guesses it. |
| `maxFileSizeKb` | `Whole.None` | `input` | No | Defaults to `1024`; the control clamps maker input to `1..5120`. |
| `acceptedMimeTypes` | `SingleLine.Text` | `input` | No | Optional comma-separated MIME allowlist such as `text/plain,application/pdf`. |

A maker can bind it in either designer path:

1. Modern form designer: select the text host column, open the **Components** pane, add the control, bind `entityId` to the primary key column, and set the static configuration inputs.
2. Classic form designer: open the host column's **Controls** tab, add the control, then configure the same properties.

## Behavior

- Refuses uploads until the current record has a valid `entityId`, so unsaved records never create orphan notes.
- Uses `context.webAPI.createRecord("annotation", data)` with `filename`, `mimetype`, base64 `documentbody`, `isdocument`, `subject`, and `${parentNavigationProperty}@odata.bind` pointing at `/${parentEntitySetName}(<entityId>)`.
- Routes file picking and note creation through small adapters so tests can stub browser and Web API behavior.
- Declares the `WebAPI` feature in the manifest.
- Shows indeterminate status text only (`Uploading attachment...`), with no invented percentages.
- Prevents duplicate submit while a pick/read/create operation is in progress.
- Respects `context.mode.isControlDisabled`, `security.readable`, and `security.editable`.
- Keeps state per control instance; no module-global mutable state or hard-coded element ids.

## Limits

- Small-file recipe only. It base64-encodes the selected file into `annotation.documentbody`; it does not use chunked file upload actions.
- One file per click. Multiple-file selection, drag/drop, deletion, download, timeline refresh, and virus scanning flows are outside this recipe.
- Online model-driven apps only in this release. Offline behavior is not claimed.
- The maker must configure the parent entity set name and annotation navigation property from the actual table metadata.
- The host column stores no file content. Use the timeline or Dataverse note APIs to view uploaded notes.

## Power Pages path not supported in this release

Power Pages support is planned, not shipped. A Pages implementation would need all of the following before this recipe can be advertised there:

- Portal Web API enabled for `annotation` and the parent table, with only the required columns exposed.
- Table permissions that allow note Create and Append plus parent Append To, assigned through scoped web roles.
- Correct logical names and entity set names for each table.
- CSRF handling for raw AJAX calls.
- Timeline visibility rules such as the `*WEB*` note prefix and `NotesFilter` configuration where applicable.
- No chunked action dependency; the portal Web API supports table CRUD patterns, not Dataverse file chunk actions.

## Microsoft Learn references confirmed

- PCF WebAPI: [`context.webAPI`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/webapi) provides methods to create and manage records and is available for model-driven apps and portals.
- PCF `createRecord`: [`context.webAPI.createRecord(entityLogicalName, data)`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/webapi/createrecord) creates a table record; the page documents the `entityLogicalName` and JSON `data` parameters.
- Feature declaration: [`uses-feature`](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/manifest-schema-reference/uses-feature) documents declaring `WebAPI` through `<uses-feature name="WebAPI" required="true" />`.
- Dataverse note table: [`annotation`](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/annotation) documents the Note table logical name, `annotations` entity set, Create message, and writable `DocumentBody`, `FileName`, `MimeType`, `IsDocument`, `Subject`, and `ObjectId` columns.
- Dataverse Web API create: [Create a table row using the Web API](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-entity-web-api) documents `@odata.bind` for associating a new row with an existing row at create time and states that the entity set name must be known.
- Power Pages Web API setup: [Use the portal Web API](https://learn.microsoft.com/en-us/power-pages/configure/webapi-how-to) documents per-table site settings, exposed fields, table permissions, web roles, and CSRF token handling for portal Web API requests.
