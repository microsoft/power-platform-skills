# Hierarchy Tree PCF recipe

Hierarchy Tree renders a dataset as an accessible tree using a self-referencing lookup column. It is intended as a supported starting point for makers replacing legacy hierarchy-style visualizations in model-driven apps.

## Template

- `dataset-standard`
- Standard PCF dataset control

## Host support

| Host | Status |
| --- | --- |
| Model-driven apps | Designed for this release; not certified in this release |
| Power Pages | Not supported in this release |

This recipe is model-driven only because it opens records through the documented `openDatasetItem` dataset method. Microsoft Learn documents that method for model-driven and canvas apps, not Power Pages.

## Configuration

The recipe patches the template manifest with two dataset property sets:

| Property set | Type | Required | Purpose |
| --- | --- | --- | --- |
| `primaryName` | `SingleLine.Text` | Yes | Text shown for each tree item. Bind this to the table's primary name or another display column. |
| `parentRecord` | `Lookup.Simple` | No | Self-referencing parent lookup used to build the tree. |

Makers can bind the control in either designer:

1. Modern form designer: select the table view or subgrid, open **Components**, add the code component, and map `primaryName` plus `parentRecord`.
2. Classic designer: select the dataset control surface, open the **Controls** tab, add the code component, and map the same property sets.

## Paging and hierarchy limits

PCF datasets expose the records on the current loaded page through `sortedRecordIds` and `records`. This recipe deliberately builds the tree from only that loaded page and never calls `refresh()` from `updateView`.

- A child whose parent is not in the loaded page is shown under a **Parent not loaded** group instead of being promoted to a false root.
- Missing or inaccessible parent records are handled the same way, with a partial-tree notice.
- Cycles in loaded parent links are detected; cycle edges are broken and a warning is shown.
- The control renders up to 500 loaded records per page and shows a partial-tree notice when the loaded page exceeds that limit.
- Dataset paging buttons call only one paging request at a time because Learn states dataset paging methods do not support parallel execution.

## Accessibility and localization

The tree uses `role="tree"`, `role="treeitem"`, `aria-expanded`, and `aria-level`. Arrow Left collapses a node, Arrow Right expands it, and Enter opens the record. User-visible strings are in the recipe's `.resx` resource file.

## Learn references confirmed

- Dataset `records`, `sortedRecordIds`, `loading`, `error`, and `paging`: <https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/dataset>
- Dataset paging serialization and `hasNextPage` / `hasPreviousPage`: <https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/paging>
- Opening a dataset row with `openDatasetItem`: <https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/dataset/opendatasetitem>
- Dataset `property-set` and `Lookup.Simple`: <https://learn.microsoft.com/en-us/power-apps/developer/component-framework/manifest-schema-reference/property-set>
- Null-first `updateView` behavior: <https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/control/updateview>
