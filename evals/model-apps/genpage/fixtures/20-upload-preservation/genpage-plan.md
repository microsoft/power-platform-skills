# Genpage Plan

## User Requirements
Build the "Revenue" summary.
Keep %PATH%, &, | and all approved text.

## Working Directory
D:\work\upload-preservation

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
| Revenue $100 $(Get-Date) | revenue.tsx | Summary with exact approved text | mock data |

## Entity Creation Required
No entity creation required — all entities already exist.

## Existing Entities
None for this create. The independent edit case preserves its existing account binding.

## Connector Bindings
No connector bindings.

## Custom API Bindings
No custom API bindings.

## Design Preferences
Responsive mock summary.

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Revenue $100 $(Get-Date) | 7-responsive-cards.tsx | Responsive summary |

## Per-Page Specifications
### Revenue $100 $(Get-Date)
- **File:** revenue.tsx
- **Purpose:** Summary with exact approved text
- **Entities:** mock data
- **Needs caching:** false
- **Key Features:** Summary values and local sorting
- **Components:** Button, Text
- **Layout:** Responsive card
- **Data Binding:** Inline mock rows
- **Interactions:** Sort local rows
