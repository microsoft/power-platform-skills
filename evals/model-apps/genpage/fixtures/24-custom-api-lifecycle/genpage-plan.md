# Genpage Plan

## User Requirements
Build order tools using the existing bound Approve Order Action and global Summary Function.

## Working Directory
D:\work\custom-api-lifecycle

## Plugin Root
D:\repo\plugins\model-apps

## Environment
- URL: https://contoso.crm.dynamics.com
- App: Contoso Operations (11111111-1111-4111-8111-111111111111)
- Languages: English (1033) only
- Solution: Default
- Publisher Prefix: cnt

## Pages
| Page | File | Purpose | Entities |
|------|------|---------|----------|
| Order Tools | page.tsx | Existing order server operations | salesorder |

## Entity Creation Required
No entity creation required — all entities already exist.

## Existing Entities
salesorder

## Connector Bindings
No connector bindings.

## Custom API Bindings
| Name | Kind | Bound Entity | Display Name | Parameters (name: kind) |
|------|------|--------------|--------------|-------------------------|
| cnt_ApproveOrder | Action | salesorder | Approve Order | Comment: String, Amount: Decimal |
| cnt_GetOrderSummary | Function | (Global) | Summary | OrderId: Guid |

## Design Preferences
Accessible buttons with presence checks, submit protection and sanitized error states.
Declared server outputs: Approve Order returns NewStatus; Summary returns Total.

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Order Tools | 7-responsive-cards.tsx | Responsive action panel |

## Per-Page Specifications
### Order Tools
- **File:** page.tsx
- **Purpose:** Existing order server operations
- **Entities:** salesorder
- **Needs caching:** false
- **Key Features:** Approve Action and Summary Function
- **Components:** Button, Text
- **Layout:** Responsive panel
- **Data Binding:** Discovered names/kinds; recordId comes from pageInput; outputs are NewStatus and Total
- **Interactions:** Guard double-submit; no automatic retry after indeterminate Action; later preserve, then explicitly remove all API controls/bindings
