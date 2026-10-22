# Genpage Plan

## User Requirements
Build two pages for tracking Account records — one for listing all accounts and one for editing a single account.

## Working Directory
D:/work/account-tracking

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
| Accounts | account-list.tsx | List of all Account records with search, sortable columns and an Edit action per row | account |
| Edit Account | account-edit.tsx | Edit form for a single Account record opened from the Accounts list | account |

## Entity Creation Required
No entity creation required — all entities already exist.

## Existing Entities
account

## Connector Bindings
No connector bindings.

## Custom API Bindings
No custom API bindings.

## Design Preferences
- Styling: Fluent UI V9 defaults with theme tokens; list page fills the host container with a scrolling grid area; edit page uses a card form, two columns on wide screens and one column on narrow screens.
- Features: list shows all accounts (paged with loadMoreRows, capped at 5,000 rows), client-side search and sortable columns; each row has an Edit action that opens the Edit Account page for that row; the edit page saves only changed fields, can discard changes and navigates back to the list.
- Accessibility: labelled search box and form fields, required marker and validation message on Account name, keyboard-navigable DataGrid, Edit buttons carry the account name in their aria-label.

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Accounts | 9-list-with-caching.tsx | Dataverse list with SearchBox, sibling-page PAGEREF navigation, window cache and in-flight de-dupe |
| Edit Account | 10-detail-with-pageinput.tsx | Page reached by navigateTo that reads its input and caches per record |
| Edit Account | 3-account-crud-dataverse.tsx | Account updateRow with verified column names |

## Per-Page Specifications

### Accounts
- **File:** account-list.tsx
- **Purpose:** List of all Account records with search, sortable columns and an Edit action per row
- **Entities:** account
- **Needs caching:** true
- **Key Features:** All accounts loaded page by page (queryTable pageSize 250, then loadMoreRows until hasMoreRows is false or 5,000 rows); SearchBox filters by name, account number, city, email and main phone; sortable columns (default account name ascending); Refresh button; footer "Showing X of Y accounts".
- **Components:** SearchBox, Button, DataGrid (DataGridHeader, DataGridHeaderCell, DataGridBody, DataGridRow, DataGridCell), TableCellLayout, createTableColumn, MessageBar, Spinner, Text; icons SearchRegular, EditRegular, ArrowClockwiseRegular.
- **Layout:** Flex-column root filling the host container; header with title opposite the search box and Refresh; grid area flexes and scrolls; columnSizingOptions for every column plus resizableColumns.
- **Data Binding:** dataApi.queryTable("account") selecting accountid, name, accountnumber, address1_city, telephone1, emailaddress1; orderBy name asc; read result.rows; window keys `__ppAccountList_accountCache` and `__ppAccountList_accountInflight`; single batched setData; readiness-only dependencies plus a reload key.
- **Interactions:** Edit button on each row calls Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_account-edit", data: { accountId } }); Refresh evicts both window keys and refetches; column headers sort.

### Edit Account
- **File:** account-edit.tsx
- **Purpose:** Edit form for a single Account record opened from the Accounts list
- **Entities:** account
- **Needs caching:** true
- **Key Features:** Reads the account id from pageInput.data.accountId (GUID string; braces tolerated); retrieves the record and shows an edit form for name (required), account number, main phone, email (format-checked), website, street, city, state/province, ZIP/postal code, country/region and description; Save sends only changed fields (emptied fields clear the column); Discard changes restores the loaded values; unsaved-changes warning; success and error MessageBars; empty state with a Back button when no account id was passed.
- **Components:** Card, Field, Input, Textarea, Button, Divider, MessageBar, Spinner, Text; icons ArrowLeftRegular, SaveRegular, ArrowUndoRegular.
- **Layout:** Scrolling flex-column root; header with Back button, title and last-modified date; card with Account details, Address and Description sections; field grid collapses to one column under 720px.
- **Data Binding:** dataApi.retrieveRow("account", { id, select: accountid, name, accountnumber, telephone1, emailaddress1, websiteurl, address1_line1, address1_city, address1_stateorprovince, address1_postalcode, address1_country, description, modifiedon }); modifiedon shown from its FormattedValue annotation; per-record Map cache and in-flight Map on window (`__ppAccountEdit_accountCache`, `__ppAccountEdit_accountInflight`); dataApi.updateRow("account", id, changedFields) in try/catch; after a successful save update the record cache and delete `__ppAccountList_accountCache` and `__ppAccountList_accountInflight` so the list refetches; one state object, one setData per outcome.
- **Interactions:** Back buttons call Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_account-list" }); Save submits the form; Discard changes resets the form.
