# Genpage Plan

## User Requirements
Build a page showing Account records.

- Data source: Dataverse entity account (already exists)
- Specific requirements: simple account list

## Working Directory
D:/work/account-records

## Plugin Root
D:/repo/plugins/model-apps

## Environment
- URL: https://contoso.crm.dynamics.com
- App: Sales Hub (11111111-2222-3333-4444-555555555555)
- Languages: English (1033) only
- Solution: Default
- Publisher Prefix: new

## Pages
| Page | File | Purpose | Entities |
|------|------|---------|----------|
| Account List | account-list.tsx | Simple sortable list of Account records with click-to-open | account |

## Entity Creation Required
No entity creation required — all entities already exist.

## Existing Entities
account

## Connector Bindings
No connector bindings.

## Custom API Bindings
No custom API bindings.

## Design Preferences
- Styling: Default Fluent UI V9 look; makeStyles with tokens, no custom theme
- Features: Simple list — sortable column headers, record count, account name opens the Account form
- Accessibility: WCAG AA defaults; grid has an accessible label and the name link announces its target

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Account List | 9-list-with-caching.tsx | Dataverse list page with DataGrid, window cache and in-flight de-dupe |
| Account List | 1-account-grid.tsx | Account DataGrid with sortable columns |

## Per-Page Specifications

### Account List
- **File:** account-list.tsx
- **Purpose:** Simple sortable list of Account records with click-to-open
- **Entities:** account
- **Needs caching:** true
- **Key Features:** Accounts title with record count; sortable grid of account name, account number, main phone, city and primary contact; empty and error states.
- **Components:** DataGrid (createTableColumn, sortable, resizableColumns, columnSizingOptions), TableCellLayout, Link, Text, Caption1, Spinner, MessageBar; BuildingRegular icon.
- **Layout:** Flex column filling the page; header row with title opposite the count; only the grid area scrolls; no viewport units.
- **Data Binding:** dataApi.queryTable('account') on mount selecting accountid, name, accountnumber, telephone1, address1_city, _primarycontactid_value, ordered by name asc, read via result.rows; primary contact label from the _primarycontactid_value FormattedValue annotation; window cache + in-flight de-dupe keyed for this page, single batched setData.
- **Interactions:** Column header click sorts; selecting an account name opens the Account record with Xrm.Navigation.navigateTo (pageType entityrecord).
