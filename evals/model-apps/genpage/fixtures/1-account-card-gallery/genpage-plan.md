# Genpage Plan

## User Requirements

Build a page showing Account records as a gallery of cards. Include name,
website, email, phone number. Make the gallery scrollable and each card
clickable to open the Account record.

## Working Directory

account-card-gallery/

## Plugin Root

D:\Projects\power-platform-skills\plugins\model-apps

## Environment

- Active Profile: aurora365-user1@auroratstgeo.onmicrosoft.com
- Environment URL: https://aurorabapenv4ab3f.crm10.dynamics.com/
- App: Sales Hub (12345678-1234-1234-1234-123456789abc)
- Solution: Default
- Publisher Prefix: new

## Pages

| Page | File | Purpose | Entities |
|------|------|---------|----------|
| Accounts Gallery | page.tsx | Card-based gallery of Account records, click-to-open detail | account |

## Entity Creation Required

No entity creation required — all entities already exist.

## Existing Entities

account

## Design Preferences

- Card grid layout, responsive auto-fill columns
- Each card shows name, website, email, phone
- Card click navigates to the Account record via Xrm.Navigation.navigateTo
- Scrollable container, not 100vh / 100vw

## Relevant Samples

- plugins/model-apps/samples/7-responsive-cards.tsx (card layout reference)
- plugins/model-apps/samples/9-list-with-caching.tsx (Dataverse list pattern + window cache)

## Per-Page Specifications

### Accounts Gallery

- File: page.tsx
- Entity: account
- Data fetching: dataApi.queryTable on mount, window cache (`__genpage_accounts_v1`), no useCallback wrap
- Columns shown: name, websiteurl, emailaddress1, telephone1
- Navigation: Xrm.Navigation.navigateTo({ pageType: 'entityrecord', entityName: 'account', entityId })
- Icons: BuildingRegular, MailRegular, PhoneRegular, GlobeRegular (unsized form)
- Styling: makeStyles with tokens; no inline styles for static values
