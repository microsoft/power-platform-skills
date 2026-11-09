# Genpage Plan

## User Requirements
Build a page showing Account records as a gallery of cards. Include name, website, email, phone number. Make the gallery scrollable and each card clickable to open the Account record.

- Data source: Dataverse entity account (already exists)
- Specific requirements: responsive card layout, each card clickable to open the Account record

## Working Directory
D:/work/account-gallery

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
| Accounts Gallery | account-gallery.tsx | Scrollable gallery of Account cards; each card opens its Account record | account |

## Entity Creation Required
No entity creation required — all entities already exist.

## Existing Entities
account

## Connector Bindings
No connector bindings.

## Custom API Bindings
No custom API bindings.

## Design Preferences
- Styling: Default Fluent UI V9 look; makeStyles with tokens, no custom theme
- Features: Responsive card gallery — name, website, email and main phone on each card; the gallery scrolls; a card opens the Account form
- Accessibility: WCAG AA defaults; each card is keyboard reachable and announces the account it opens

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Accounts Gallery | 7-responsive-cards.tsx | Responsive card layout over Dataverse records |
| Accounts Gallery | 9-list-with-caching.tsx | Window cache and in-flight de-dupe for an on-mount read |

## Per-Page Specifications

### Accounts Gallery
- **File:** account-gallery.tsx
- **Purpose:** Scrollable gallery of Account cards; each card opens its Account record
- **Entities:** account
- **Needs caching:** true
- **Key Features:** Accounts title with record count; one card per account showing name, website, email and main phone; empty and error states.
- **Components:** Card, CardHeader, Text, Caption1, Spinner, MessageBar; BuildingRegular, GlobeRegular, MailRegular and CallRegular icons.
- **Layout:** Flex column filling the page; header row with title opposite the count; the gallery is a responsive grid (auto-fill, 260px minimum) and is the only part that scrolls; no viewport units.
- **Data Binding:** dataApi.queryTable('account') on mount selecting accountid, name, websiteurl, emailaddress1, telephone1, ordered by name asc, read via result.rows; window cache + in-flight de-dupe keyed for this page, single batched setData.
- **Interactions:** Selecting a card (click, Enter or Space) opens the Account record with Xrm.Navigation.navigateTo (pageType entityrecord).
