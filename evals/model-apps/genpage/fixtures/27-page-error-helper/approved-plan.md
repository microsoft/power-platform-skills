## Genpage Plan

### Assumptions
#### A1 — Order list scope
- Decision: List every sales order the user can read, with no added status, owner or date restriction, sorted by name ascending, 50 rows per page.
- Alternatives considered: Open orders only; the user's own orders; newest first.
- Evidence: default: the request asks for the sales orders without a restriction.
- Resolution: planner-default

#### A2 — Initial-load caching
- Decision: De-duplicate and cache the initial list read.
- Alternatives considered: Uncached loading.
- Evidence: default: this page loads on mount, so Critical Rule 15 applies.
- Resolution: planner-default

### Pages (1 total)
| Page | File | Purpose | Entities |
|------|------|---------|----------|
| Order Approvals | order-approvals.tsx | List sales orders, show the selected one and approve it | salesorder |

### Data Semantics
#### order-approvals.tsx
None.

### Lookup Metadata
#### order-approvals.tsx
None.

### Data Strategy
- Entities needed: salesorder
- Entities that exist: salesorder
- Entities to create: none
- Connector bindings: none
- Custom API bindings: cnt_ApproveOrder (Action, bound to salesorder)
- Built-in Dataverse operations: none
- Sample data: not needed (existing table)

### App
- Using: Sales Hub (11111111-2222-3333-4444-555555555555)

### Solution
- Default / new

### Localization
- English only — no localization needed

### Design
- Default Fluent UI V9 look; an order grid, the selected order and its Approve button; each failure shown in its own error bar
