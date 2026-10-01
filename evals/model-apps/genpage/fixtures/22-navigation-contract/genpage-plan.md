# Genpage Plan

## User Requirements
Build three mock pages: Overview, Pet and Pet Gallery, with cross-page navigation.

## Working Directory
D:\work\navigation-contract

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
| Overview | overview.tsx | Links to both sibling pages | mock data |
| Pet | pet.tsx | Links to Pet Gallery | mock data |
| Pet Gallery | pet-gallery.tsx | No outbound navigation | mock data |

## Entity Creation Required
No entity creation required — all entities already exist.

## Existing Entities
None.

## Connector Bindings
No connector bindings.

## Custom API Bindings
No custom API bindings.

## Design Preferences
Accessible responsive mock cards.

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Overview | 7-responsive-cards.tsx | Responsive cards |
| Pet | 7-responsive-cards.tsx | Responsive cards |
| Pet Gallery | 7-responsive-cards.tsx | Responsive cards |

## Per-Page Specifications
### Overview
- **File:** overview.tsx
- **Purpose:** Links to both sibling pages
- **Entities:** mock data
- **Needs caching:** false
- **Key Features:** Pet and Gallery buttons
- **Components:** Button, Text
- **Layout:** Responsive cards
- **Data Binding:** Inline mock rows
- **Interactions:** PAGEREF_pet and PAGEREF_pet-gallery navigation

### Pet
- **File:** pet.tsx
- **Purpose:** Links to Pet Gallery
- **Entities:** mock data
- **Needs caching:** false
- **Key Features:** Gallery button
- **Components:** Button, Text
- **Layout:** Responsive card
- **Data Binding:** Inline mock rows
- **Interactions:** PAGEREF_pet-gallery navigation

### Pet Gallery
- **File:** pet-gallery.tsx
- **Purpose:** No outbound navigation
- **Entities:** mock data
- **Needs caching:** false
- **Key Features:** Pet names
- **Components:** Text
- **Layout:** Responsive cards
- **Data Binding:** Inline mock rows
- **Interactions:** None
