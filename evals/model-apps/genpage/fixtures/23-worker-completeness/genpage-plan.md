# Genpage Plan

## User Requirements
Build a complete mock summary page.

## Working Directory
D:\work\worker-recovery

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
| Worker Recovery | page.tsx | Complete summary | mock data |

## Entity Creation Required
No entity creation required — all entities already exist.

## Existing Entities
None.

## Connector Bindings
No connector bindings.

## Custom API Bindings
No custom API bindings.

## Design Preferences
Responsive summary.

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Worker Recovery | 7-responsive-cards.tsx | Responsive summary |

## Per-Page Specifications
### Worker Recovery
- **File:** page.tsx
- **Purpose:** Complete summary
- **Entities:** mock data
- **Needs caching:** false
- **Key Features:** Summary values
- **Components:** Text
- **Layout:** Responsive card
- **Data Binding:** Inline mock rows
- **Interactions:** None
