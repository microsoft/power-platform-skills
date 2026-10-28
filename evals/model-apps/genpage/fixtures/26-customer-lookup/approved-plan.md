## Genpage Plan

### Assumptions
#### A1 — Account opportunities
- Decision: An account's opportunities are those whose Customer (customerid) is that account — the direct customer relationship. Opportunities whose parent account is the account, and opportunities of the account's contacts, are not included.
- Alternatives considered: Parent account (parentaccountid); Customer plus contacts (direct account customers and the contact customers linked to the account).
- Evidence: metadata: opportunity.customerid targets account and contact, and opportunity.parentaccountid targets account (lookup-metadata.json).
- Resolution: user-confirmed
- Question: opportunities-account-scope
- Answer: Direct customer

#### A2 — List order, size and caching
- Decision: Read the opportunities sorted by name ascending, 50 rows, and de-duplicate and cache that initial read; a failed read is not cached.
- Alternatives considered: Newest first; more rows; uncached loading.
- Evidence: default: the request states no order or size, and the page loads on mount, so Critical Rule 15 applies.
- Resolution: planner-default

#### A3 — Customer search scope
- Decision: The customer search keeps the loaded opportunities whose customer name contains the search text, ignoring case. It searches the rows on the page, not the server, and its label says so.
- Alternatives considered: A server search of account names and contact full names through the customerid_account and customerid_contact paths.
- Evidence: default: the request asks for a substring search of customer names without naming its scope.
- Resolution: planner-default

#### A4 — Customer choices
- Decision: Change customer offers the distinct resolved customers of the loaded opportunities, accounts and contacts, each shown with its table so that equal names stay apart. An unresolved customer is not offered.
- Alternatives considered: A search of every account and contact.
- Evidence: default: the request asks to change the customer without naming where the choices come from.
- Resolution: planner-default

### Pages (1 total)
| Page | File | Purpose | Entities |
|------|------|---------|----------|
| Customer Opportunities | customer-lookup.tsx | Browse opportunities with their account or contact customer; open, filter by and change the customer | opportunity |

### Data Semantics
#### customer-lookup.tsx
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

### Lookup Metadata
#### customer-lookup.tsx
| Table | Column | Read property | Targets | Used by | Metadata state |
|-------|--------|---------------|---------|---------|----------------|
| opportunity | customerid | _customerid_value | account, contact | R1, R2, F1, F2, F3; customer navigation; customer picker | observed |

| Table | Column | Target | Navigation property | Referenced key |
|-------|--------|--------|---------------------|----------------|
| opportunity | customerid | account | customerid_account | accountid |
| opportunity | customerid | contact | customerid_contact | contactid |

- Evidence: lookup-metadata.json; successful source/target metadata discovery.
- Read target strategy: normalize the logical-name annotation and qualified prefix; a bare id without target evidence stays unresolved and is shown by its label only — no fallback read.

### Data Strategy
- Entities needed: opportunity
- Entities that exist: opportunity
- Entities to create: none
- Connector bindings: none
- Custom API bindings: none
- Built-in Dataverse operations: none
- Sample data: not needed (existing table)

### App
- Using: Sales Hub (11111111-2222-3333-4444-555555555555)

### Solution
- Default / new

### Localization
- English only — no localization needed

### Design
- Default Fluent UI V9 look; the opportunity list with each customer, a search of the loaded rows, open and change the customer, and one account's opportunities; each failure shown in its own error bar
