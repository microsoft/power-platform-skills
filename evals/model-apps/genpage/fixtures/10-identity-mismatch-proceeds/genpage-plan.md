# Genpage Plan

## User Requirements
Build a page for my new cr_widget entity that doesn't exist yet.

## Working Directory
D:/work/widgets

## Plugin Root
D:/repo/plugins/model-apps

## Environment
- URL: https://contoso.crm.dynamics.com
- App: Contoso Operations Hub (11111111-2222-3333-4444-555555555555)
- Languages: English (1033) only
- Solution: ContosoOperations
- Publisher Prefix: cr

## Pages
| Page | File | Purpose | Entities |
|------|------|---------|----------|
| Widgets | widgets.tsx | List every widget with its SKU and the quantity on hand | cr_widget |

## Entity Creation Required

### widget
[The full logical name is constructed by the entity-builder as `cr_widget`. Display name: "Widget".]

- Display Name: Widget
- Display Plural: Widgets
- Primary Name Suffix: name
- Columns:

  | Suffix | Type | Required | Notes |
  |--------|------|----------|-------|
  | sku | string | yes | Stock-keeping unit (max 40) |
  | quantity | int | no | Quantity on hand, 0-100000 |
- Choice Columns:

  | Column Suffix | Options |
  |---------------|---------|
- Relationships:

  | Type | Related Table | Lookup Suffix | Cascade |
  |------|---------------|---------------|---------|
  | none | none | none | none |

## Existing Entities
None

## Connector Bindings
No connector bindings.

## Custom API Bindings
No custom API bindings.

## Design Preferences
- Styling: Fluent UI V9 tokens; quantity shown as a whole number, with an em dash when none is recorded
- Features: a sortable widget grid (name, SKU, quantity); a widget count; open the widget record
- Accessibility: WCAG AA; keyboard-reachable grid and links; the title icon is decorative (aria-hidden)

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Widgets | 9-list-with-caching.tsx | Dataverse list with window cache + in-flight de-dupe, DataGrid with createTableColumn and column sizing |

## Per-Page Specifications

### Widgets
- **File:** widgets.tsx
- **Purpose:** List every widget with its SKU and the quantity on hand
- **Entities:** cr_widget
- **Needs caching:** true
- **Key Features:** Widget grid with Name (opens the record), SKU and Quantity columns; every column sorts; widget count in the header
- **Components:** Fluent UI V9 — DataGrid (createTableColumn, sortable, resizableColumns + columnSizingOptions), Link, Spinner, MessageBar, Text, Caption1; icon BoxRegular (unsized, verified)
- **Layout:** Flex-column root; header with title and count; the grid fills the remaining height and scrolls on its own
- **Data Binding:** queryTable("cr_widget") selecting cr_widgetid, cr_name, cr_sku, cr_quantity; results read via .rows; single batched setData; window cache + in-flight de-dupe keyed by page (`__ppWidgets_…`), readiness-gated effect deps
- **Interactions:** Column headers sort; the widget name opens the record with Xrm.Navigation.navigateTo (pageType "entityrecord")
