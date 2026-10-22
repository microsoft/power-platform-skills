# Genpage Plan

## User Requirements
Build three mock operations pages and package every deployed page with the app and existing document connection reference.

## Working Directory
D:\work\solution-package

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
| Documents | list.tsx | Mock document list with an existing binding | mock data |
| Schedule | schedule.tsx | Mock schedule | mock data |
| Metrics | metrics.tsx | Mock metrics | mock data |

## Entity Creation Required
No entity creation required — all entities already exist.

## Existing Entities
None.

## Connector Bindings
| Logical Name | Connector Id | Dataset | Tables (GUIDs) | Table Display Names | Operations | Fields | Parameters | Response |
|--------------|--------------|---------|----------------|---------------------|------------|--------|------------|----------|
| cnt_docs | /providers/Microsoft.PowerApps/apis/shared_sharepointonline | https://contoso.sharepoint.com/sites/team | 77777777-7777-4777-8777-777777777777 | Documents | | Title (string) | | |

## Custom API Bindings
No custom API bindings.

## Solution Packaging
- Package into solution: true
- Solution: ContosoPages

## Design Preferences
Responsive mock cards. This fixture isolates packaging, not connector execution.

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Documents | 7-responsive-cards.tsx | Mock cards |
| Schedule | 7-responsive-cards.tsx | Mock cards |
| Metrics | 7-responsive-cards.tsx | Mock cards |

## Per-Page Specifications
### Documents
- **File:** list.tsx
- **Purpose:** Mock document list with an existing binding
- **Entities:** mock data
- **Needs caching:** false
- **Key Features:** Document titles
- **Components:** Text
- **Layout:** Responsive cards
- **Data Binding:** Inline rows; existing cnt_docs binding carried into config
- **Interactions:** None

### Schedule
- **File:** schedule.tsx
- **Purpose:** Mock schedule
- **Entities:** mock data
- **Needs caching:** false
- **Key Features:** Schedule labels
- **Components:** Text
- **Layout:** Responsive cards
- **Data Binding:** Inline mock rows
- **Interactions:** None

### Metrics
- **File:** metrics.tsx
- **Purpose:** Mock metrics
- **Entities:** mock data
- **Needs caching:** false
- **Key Features:** Summary labels
- **Components:** Text
- **Layout:** Responsive cards
- **Data Binding:** Inline mock rows
- **Interactions:** None
