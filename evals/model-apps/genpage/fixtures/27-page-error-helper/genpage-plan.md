# Genpage Plan

## User Requirements
Build an Order Approvals page for our existing sales orders: list the sales orders, show the one I select, and let me approve it with the existing Approve Order action.

- Data source: Dataverse entity salesorder (already exists)
- Specific requirements: approve the selected order with the Approve Order action

## Assumptions

### A1 — Order list scope
- Decision: List every sales order the user can read, with no added status, owner or date restriction, sorted by name ascending, 50 rows per page.
- Alternatives considered: Open orders only; the user's own orders; newest first.
- Evidence: default: the request asks for the sales orders without a restriction.
- Resolution: planner-default

### A2 — Initial-load caching
- Decision: De-duplicate and cache the initial list read.
- Alternatives considered: Uncached loading.
- Evidence: default: this page loads on mount, so Critical Rule 15 applies.
- Resolution: planner-default

## Working Directory
D:/work/order-approvals

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
| Order Approvals | order-approvals.tsx | List sales orders, show the selected one and approve it | salesorder |

## Entity Creation Required
No entity creation required — all entities already exist.

## Existing Entities
salesorder

## Connector Bindings
No connector bindings.

## Custom API Bindings
| Name | Kind | Bound Entity | Display Name | Parameters (name: kind) |
|------|------|--------------|--------------|-------------------------|
| cnt_ApproveOrder | Action | salesorder | Approve Order | Comment: String |

## Design Preferences
- Styling: Default Fluent UI V9 look; makeStyles with tokens, no custom theme
- Features: Sortable order grid, a panel for the selected order with an approval note and an Approve button; each failure is shown where it happened, in its own error bar
- Accessibility: WCAG AA defaults; the grid has an accessible label

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Order Approvals | 9-list-with-caching.tsx | Dataverse list with window cache, in-flight de-dupe and a reported load failure |
| Order Approvals | 13-custom-api-invocation.tsx | Bound Custom API Action with the documented result guards and latch |

## Per-Page Specifications

### Order Approvals
- **File:** order-approvals.tsx
- **Purpose:** List sales orders, show the selected one and approve it
- **Entities:** salesorder
- **Needs caching:** true
- **Key Features:** Order grid; the selected order's name and status; approval note; Approve button; separate error bars for the list, the selected order and the approval.
- **Components:** DataGrid (createTableColumn, resizableColumns, columnSizingOptions), Button, Field, Textarea, MessageBar, Spinner, Text; CheckmarkRegular icon.
- **Layout:** Title, then the order grid, then the selected-order panel; no viewport units.
- **Data Binding:** dataApi.queryTable('salesorder') on mount selecting salesorderid, name, totalamount, statuscode, ordered by name asc, 50 rows (A1), read via result.rows, with the window cache and in-flight de-dupe (A2); dataApi.retrieveRow('salesorder') for the order the user selects; executeAction cnt_ApproveOrder bound to the selected salesorder with Comment from the note; NewStatus read from res.outputs.
- **Interactions:** Selecting an order name loads it; Approve calls the Action once (a double-submit latch); an indeterminate result is reported and never retried; only a network result offers Try again; a failed list or order read offers Try again; a failed or rejected approval is a write with no retry.

#### Data semantics
None.

#### Lookup metadata
None.
