# Genpage Plan

## User Requirements
Build a Customer Opportunities page for our existing opportunities. Show every opportunity that has a customer, whether an account or a contact, and let me search customer names by substring. From each opportunity I want to open the customer's record, change the opportunity's customer, and see the opportunities for this account.

- Data source: Dataverse entity opportunity (already exists)
- Specific requirements: open the customer's record, change the customer, and show the opportunities for this account

## Assumptions

### A1 — Account opportunities
- Decision: An account's opportunities are those whose Customer (customerid) is that account — the direct customer relationship. Opportunities whose parent account is the account, and opportunities of the account's contacts, are not included.
- Alternatives considered: Parent account (parentaccountid); Customer plus contacts (direct account customers and the contact customers linked to the account).
- Evidence: metadata: opportunity.customerid targets account and contact, and opportunity.parentaccountid targets account (lookup-metadata.json).
- Resolution: user-confirmed
- Question: opportunities-account-scope
- Answer: Direct customer

### A2 — List order, size and caching
- Decision: Read the opportunities sorted by name ascending, 50 rows, and de-duplicate and cache that initial read; a failed read is not cached.
- Alternatives considered: Newest first; more rows; uncached loading.
- Evidence: default: the request states no order or size, and the page loads on mount, so Critical Rule 15 applies.
- Resolution: planner-default

### A3 — Customer search scope
- Decision: The customer search keeps the loaded opportunities whose customer name contains the search text, ignoring case. It searches the rows on the page, not the server, and its label says so.
- Alternatives considered: A server search of account names and contact full names through the customerid_account and customerid_contact paths.
- Evidence: default: the request asks for a substring search of customer names without naming its scope.
- Resolution: planner-default

### A4 — Customer choices
- Decision: Change customer offers the distinct resolved customers of the loaded opportunities, accounts and contacts, each shown with its table so that equal names stay apart. An unresolved customer is not offered.
- Alternatives considered: A search of every account and contact.
- Evidence: default: the request asks to change the customer without naming where the choices come from.
- Resolution: planner-default

## Working Directory
D:/work/customer-opportunities

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
| Customer Opportunities | customer-lookup.tsx | Browse opportunities with their account or contact customer; open, filter by and change the customer | opportunity |

## Entity Creation Required
No entity creation required — all entities already exist.

## Existing Entities
opportunity

## Connector Bindings
No connector bindings.

## Custom API Bindings
No custom API bindings.

## Design Preferences
- Styling: Default Fluent UI V9 look; makeStyles with tokens, no custom theme
- Features: An opportunity list with each customer, a search of the loaded rows by customer name, open and change the customer, and one account's opportunities; each failure is shown where it happened, in its own error bar
- Accessibility: WCAG AA defaults; the search box and both panels have accessible labels

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Customer Opportunities | 9-list-with-caching.tsx | Dataverse list with window cache, in-flight de-dupe and a reported load failure |
| Customer Opportunities | 3-account-crud-dataverse.tsx | A reported write with no retry beside a cached list |

## Per-Page Specifications

### Customer Opportunities
- **File:** customer-lookup.tsx
- **Purpose:** Browse opportunities with their account or contact customer; open, filter by and change the customer
- **Entities:** opportunity
- **Needs caching:** true
- **Key Features:** The opportunity list with each customer's name (F3); a search of the loaded rows by customer name (F2); Open customer for a resolved customer (R2); the opportunities of an account customer (R1, F1); Change customer with a picker that keeps each choice's table (R2, A4); separate error bars for the list, the navigation, the account view and the change.
- **Components:** SearchBox, Button, Dropdown, Option, Field, MessageBar, Spinner, Text; OpenRegular icon.
- **Layout:** Title, the list and navigation error bars, the search box, the opportunity list, then the account-opportunities panel and the change-customer panel; no viewport units.
- **Data Binding:** dataApi.queryTable('opportunity') on mount selecting opportunityid, name, _customerid_value with the filter _customerid_value ne null (F3), ordered by name asc, 50 rows, read via result.rows with the window cache and in-flight de-dupe (A2); every customer normalized with normalizeLookupReference(row, '_customerid_value', ['account', 'contact']); the account view's dataApi.queryTable('opportunity') filtered by customerid_account/accountid eq the account's bare id (R1, F1); dataApi.updateRow('opportunity') writes _customerid_value as /account(<id>) or /contact(<id>) for the chosen table (R2).
- **Interactions:** Typing in the search box filters the loaded rows (F2); Open customer opens the record in its own table with Xrm.Navigation.navigateTo; "Show this account's opportunities" appears only for an account customer; Change customer picks one of the loaded customers and saves once (a double-save latch), then reloads the list; a failed list read offers Try again; a failed account read or navigation is a read error; a failed change is a write with no retry.

#### Data semantics

##### R1
- Kind: relationship
- Definition: Account opportunities: opportunity.customerid → account, the direct customer. Offered only for an opportunity whose customer normalizes to an account; parentaccountid is not used and contact customers do not roll up. A contact, unset or unresolved customer offers no account view.
- Source: A1

##### R2
- Kind: relationship
- Definition: Customer reference: opportunity.customerid with its complete targets account and contact. Each row's customer is normalized to its actual table and bare id before it is opened or offered as a choice; a change writes the chosen table's qualified reference; an unresolved customer is shown by its label only.
- Source: User Requirements
- Requirement quote: open the customer's record, change the opportunity's customer

##### F1
- Kind: filter
- Definition: Account opportunities query: opportunity rows with customerid_account/accountid eq the account's bare id, read when the maker asks for one account's opportunities. A refused or failed read is shown as a read error; the predicate is never weakened and nothing is post-filtered.
- Source: A1

##### F2
- Kind: filter
- Definition: Customer search: keep the loaded opportunities whose customer label (the formatted value of _customerid_value) contains the search text, ignoring case; client-side, over the loaded rows only.
- Source: A3
- Requirement quote: search customer names by substring

##### F3
- Kind: filter
- Definition: All customers: opportunity rows with _customerid_value ne null — a customer of either target, account or contact; no target, owner, state or date restriction.
- Source: User Requirements
- Requirement quote: Show every opportunity that has a customer, whether an account or a contact

#### Lookup metadata

| Table | Column | Read property | Targets | Used by | Metadata state |
|-------|--------|---------------|---------|---------|----------------|
| opportunity | customerid | _customerid_value | account, contact | R1, R2, F1, F2, F3; customer navigation; customer picker | observed |

| Table | Column | Target | Navigation property | Referenced key |
|-------|--------|--------|---------------------|----------------|
| opportunity | customerid | account | customerid_account | accountid |
| opportunity | customerid | contact | customerid_contact | contactid |

- Evidence: lookup-metadata.json; successful source/target metadata discovery.
- Read target strategy: normalize the logical-name annotation and qualified prefix; a bare id without target evidence stays unresolved and is shown by its label only — no fallback read.
