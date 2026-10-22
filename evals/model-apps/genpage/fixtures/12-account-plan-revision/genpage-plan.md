# Genpage Plan

## User Requirements
Build a page showing Account records with a filter toolbar and sortable columns.

Revision requested at plan approval: add a search box in addition to the filter toolbar.

## Working Directory
D:/work/account-filter-list

## Plugin Root
D:/repo/plugins/model-apps

## Environment
- URL: https://contoso.crm.dynamics.com
- App: Contoso Sales (11111111-1111-4111-8111-111111111111)
- Languages: English (1033) only
- Solution: Default
- Publisher Prefix: new

## Pages
| Page | File | Purpose | Entities |
|------|------|---------|----------|
| Accounts | account-list.tsx | Account grid with a search box, a filter toolbar and sortable columns | account |

## Entity Creation Required
No entity creation required — all entities already exist.

## Existing Entities
account

## Connector Bindings
No connector bindings.

## Custom API Bindings
No custom API bindings.

## Design Preferences
- Styling: Fluent UI V9 defaults with theme tokens; title and search box share the header row, the filter toolbar sits directly below it, and only the grid area scrolls.
- Features: free-text search box (account name, account number, city, country/region, email, main phone) applied together with a filter toolbar (status, industry, country/region, clear filters, refresh); every grid column sortable, default sort by account name ascending.
- Accessibility: labelled search box and filter dropdowns, toolbar exposed with an aria-label, keyboard-navigable DataGrid, WCAG AA contrast via tokens.

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Accounts | 9-list-with-caching.tsx | Dataverse list with SearchBox, window cache and in-flight de-dupe |
| Accounts | 1-account-grid.tsx | Account DataGrid with sortable columns via createTableColumn compare |

## Per-Page Specifications

### Accounts
- **File:** account-list.tsx
- **Purpose:** Account grid with a search box, a filter toolbar and sortable columns
- **Entities:** account
- **Needs caching:** true
- **Key Features:** SearchBox in the header filters rows by name, account number, city, country/region, email and main phone; a Toolbar below the header holds Status (All / Active / Inactive), Industry and Country/Region dropdowns plus Clear filters and Refresh buttons; search and toolbar filters combine (AND); every column is sortable; a footer shows "Showing X of Y accounts" and notes when more than 500 rows exist.
- **Components:** SearchBox, Toolbar, ToolbarButton, ToolbarDivider, Dropdown, Option, Badge, DataGrid (DataGridHeader, DataGridHeaderCell, DataGridBody, DataGridRow, DataGridCell), TableCellLayout, createTableColumn, MessageBar, Spinner, Text; icons SearchRegular, FilterRegular, FilterDismissRegular, ArrowClockwiseRegular.
- **Layout:** Flex-column root filling the host container (position relative, contain layout); header row wraps on narrow widths; toolbar wraps its controls; grid area flexes and scrolls; no viewport units.
- **Data Binding:** dataApi.queryTable("account") on mount selecting accountid, name, accountnumber, industrycode, address1_city, address1_country, telephone1, emailaddress1, statecode; orderBy name asc, pageSize 500; read result.rows; industry and status labels from @OData.Community.Display.V1.FormattedValue; window cache plus in-flight de-dupe keyed by page name; single batched setData; readiness-only dependencies.
- **Interactions:** Typing in the search box and choosing toolbar filters narrow the grid client-side; Clear filters resets the toolbar (search text is kept); Refresh evicts the cache and in-flight entry and refetches; clicking a column header sorts by that column; filter dropdown listboxes use the page mountNode.
