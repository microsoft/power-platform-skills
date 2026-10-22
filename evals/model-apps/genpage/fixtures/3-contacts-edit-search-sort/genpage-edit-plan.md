# Genpage Edit Plan

## File Being Edited
- **Absolute path:** D:/work/contacts-search-sort/22222222-3333-4444-5555-666666666666/page.tsx
- **App ID:** 11111111-2222-3333-4444-555555555555
- **Page ID:** 22222222-3333-4444-5555-666666666666

## Working Directory
D:/work/contacts-search-sort

## Plugin Root
D:/repo/plugins/model-apps

## Original Page Context
- **Original prompt (from prompt.txt):** Build a contacts directory page that lists my contacts in a grid with full name, company, job title, email and business phone. Clicking a contact's name should open the contact record.
- **Original data sources (from config.json):** contact
- **Current purpose:** Read-only directory of contacts in a resizable DataGrid (full name, company name, job title, email, business phone); the name opens the contact form. It has no search box and its columns cannot be sorted.

## Entities Used
contact

## Requested Changes
1. Add a search bar: a Fluent UI V9 `SearchBox` (aria-label "Search contacts", placeholder "Search name, company or email") in the header, opposite the title, beside the record count. It filters the already-loaded rows client-side, case-insensitively, on full name, company name (the `_parentcustomerid_value` FormattedValue label) and email. No new query is issued and the window cache is not touched.
2. Add sorting: set `sortable` on the DataGrid with a controlled `sortState` / `onSortChange`, so column header clicks sort and toggle direction. Give every column a `compare`; the Company name column compares the FormattedValue label case-insensitively with blank companies last. Default sort is Company name ascending.
3. Update the count caption to "Showing N of M contacts" while a search term is active, and show "No contacts match “<term>”." when the search filters out every row (the existing "No contacts found." stays for an empty table).
4. Keep the derived filtered list (`useMemo`) and the new `useState` hooks above the loading early return (Rule 19).

## Preservation Constraints
- The query is unchanged: `queryTable('contact')` selecting contactid, fullname, `_parentcustomerid_value`, jobtitle, emailaddress1, telephone1, ordered by fullname asc, pageSize 250, read via `.rows`.
- The window cache and in-flight de-dupe keys (`__ppContactsDirectory_contactCache` / `__ppContactsDirectory_contactInflight`), the `[dataReady]` dependency and the single batched `setData` stay exactly as they are.
- Company name is still read from the `_parentcustomerid_value@OData.Community.Display.V1.FormattedValue` annotation; `parentcustomeridname` is never selected.
- Selecting a contact's full name still opens the contact record with `Xrm.Navigation.navigateTo` (pageType entityrecord).
- All five columns, their headers, `resizableColumns` and `columnSizingOptions` are unchanged; loading spinner and error MessageBar are unchanged.
- `export default GeneratedComponent` and the `const { dataApi, pageInput } = props;` signature are unchanged.
- Connector bindings: none, unchanged — omit `--connectors`. Custom API bindings: none, unchanged — omit `--actions`. Data source stays `contact`.

## Design Notes
- New styles go in `makeStyles` with tokens (a `headerActions` row and a `search` slot); the search box goes full width under 480px via a media query nested in its slot.
- The SearchBox carries its own search glyph; no new icon imports are needed.
- Sorting is driven by the DataGrid header cells (keyboard accessible); the default Company name sort is visible in the header's sort indicator.

## Relevant Samples
| Purpose | Sample |
|---------|--------|
| SearchBox filtering a cached Dataverse DataGrid | 9-list-with-caching.tsx |
| Sortable DataGrid columns with `compare` | 1-account-grid.tsx |
