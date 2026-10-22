# Genpage Plan

## User Requirements
Build a page for my new cnt_widget entity that does not exist yet.

## Working Directory
D:\work\widget-page

## Plugin Root
D:\repo\plugins\model-apps

## Environment
- URL: https://contoso.crm.dynamics.com
- App: Contoso Operations (11111111-1111-4111-8111-111111111111)
- Languages: English (1033) only
- Solution: ContosoPages
- Publisher Prefix: cnt

## Pages
| Page | File | Purpose | Entities |
|------|------|---------|----------|
| Widgets | widgets.tsx | Widget list | cnt_widget |

## Entity Creation Required
### widget
- Display Name: Widget
- Display Plural: Widgets
- Primary Name Suffix: name

- Columns:
| Suffix | Type | Required | Notes |
|--------|------|----------|-------|
| name | String | true | Widget name |

- Choice Columns:
| Column Suffix | Options |
|---------------|---------|

- Relationships:
| Type | Related Table | Lookup Suffix | Cascade |
|------|---------------|---------------|---------|

## Existing Entities
None.

## Connector Bindings
No connector bindings.

## Custom API Bindings
No custom API bindings.

## Design Preferences
Responsive widget list with accessible labels.

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Widgets | 9-list-with-caching.tsx | List layout |

## Per-Page Specifications
### Widgets
- **File:** widgets.tsx
- **Purpose:** Widget list
- **Entities:** cnt_widget
- **Needs caching:** true
- **Key Features:** Name list
- **Components:** Text, Card
- **Layout:** Responsive cards
- **Data Binding:** queryTable after provisioning
- **Interactions:** Local search
