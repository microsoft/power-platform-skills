# PCF recipes

The catalog is rendered from recipe metadata. Recipes are starting points, not certification claims. Microsoft Learn PCF fundamentals are at https://learn.microsoft.com/en-us/power-apps/developer/component-framework/overview.

<!-- Maintainers: regenerate this block with renderRecipesTable() from scripts/lib/pcf-scaffold.js. -->
<!-- pcf-recipes:begin -->
| Recipe | Template | Designed for (hosts) | Certified | Status |
| --- | --- | --- | --- | --- |
| Attachment uploader (`attachment-uploader`) | `field-standard` | model | model: not certified in this release | available |
| Contextual grid (`contextual-grid`) | `field-standard` | model | model: not certified in this release | available |
| Grid customizer (`grid-customizer`) | `field-virtual` | model | model: not certified in this release | available |
| Hierarchy Tree (`hierarchy-tree`) | `dataset-standard` | model | model: not certified in this release | available |
| Lookup dropdown (`lookup-dropdown`) | `field-standard` | model | model: not certified in this release | available |
| Star rating (`star-rating`) | `field-standard` | model, pages | model: not certified in this release; pages: not certified in this release | available |
<!-- pcf-recipes:end -->
## Attachment uploader

- README: [pcf/recipes/attachment-uploader/README.md](../pcf/recipes/attachment-uploader/README.md)
- What: uploads one small file as a Dataverse note on the current saved model-driven record.
- Template: `field-standard`.
- Hosts: model-driven apps; Power Pages not certified in this release.
- Key properties: `value`, `entityId`, `entityName`, `parentEntitySetName`, `parentNavigationProperty`, optional `maxFileSizeKb`, `acceptedMimeTypes`.
- Limits: small files only, online Web API, no chunked upload, no Pages certification.

## Contextual grid

- README: [pcf/recipes/contextual-grid/README.md](../pcf/recipes/contextual-grid/README.md)
- What: renders related rows from maker-supplied FetchXML filtered by the current record id.
- Template: `field-standard`.
- Hosts: model-driven apps; Power Pages not certified in this release.
- Key properties: `entityId`, `entityName`, `fetchXmlTemplate`, optional `pageSize`.
- Limits: requires saved record id, online Web API, one loaded page plus load-more behavior.

## Grid customizer

- README: [pcf/recipes/grid-customizer/README.md](../pcf/recipes/grid-customizer/README.md)
- What: supplies custom renderer/editor overrides to the Power Apps grid customizer extension point.
- Template: `field-virtual`.
- Hosts: model-driven apps; Power Pages not certified in this release.
- Key property: `EventName`.
- Limits: one customizer per grid, model-driven only, pure renderers/editors.

## Hierarchy Tree

- README: [pcf/recipes/hierarchy-tree/README.md](../pcf/recipes/hierarchy-tree/README.md)
- What: renders a dataset as an accessible tree using a self-referencing parent lookup.
- Template: `dataset-standard`.
- Hosts: model-driven apps; Power Pages not certified in this release.
- Key property sets: `primaryName`, optional `parentRecord` on `sampleDataSet`.
- Limits: current loaded dataset page only, parent-not-loaded indicators, cycle handling, explicit load limit.

## Lookup dropdown

- README: [pcf/recipes/lookup-dropdown/README.md](../pcf/recipes/lookup-dropdown/README.md)
- What: replaces a lookup field with an accessible dropdown of configured target rows.
- Template: `field-standard`.
- Hosts: model-driven apps; Power Pages not certified in this release.
- Key properties: `lookupValue`, `targetTable`, optional `selectableFilter`.
- Limits: single-table lookup, online model-driven apps, no offline claim.

## Star rating

- README: [pcf/recipes/star-rating/README.md](../pcf/recipes/star-rating/README.md)
- What: compact accessible whole-number star rating field control.
- Template: `field-standard`.
- Hosts: model-driven apps and Power Pages; not certified in this release for either host.
- Key properties: `value`, optional `max`.
- Limits: whole numbers only, no network/file/navigation APIs.
