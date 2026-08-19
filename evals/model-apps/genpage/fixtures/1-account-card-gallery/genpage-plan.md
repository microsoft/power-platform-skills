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

- Active Profile: contoso-user001@contosotest1.onmicrosoft.com
- URL: https://contosobapenv0002.crm10.dynamics.com/
- App: Sales Hub (12345678-1234-1234-1234-123456789abc)
- Languages: English (1033) only
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

## Connector Bindings

No connector bindings.

## Design Preferences

- Card grid layout, responsive auto-fill columns
- Each card shows name, website, email, phone
- Card click navigates to the Account record via Xrm.Navigation.navigateTo
- Scrollable container, not 100vh / 100vw

## Relevant Samples

| Page | Sample | Reason |
|------|--------|--------|
| Accounts Gallery | 7-responsive-cards.tsx | card layout reference |
| Accounts Gallery | 9-list-with-caching.tsx | Dataverse list pattern + window cache |
## Per-Page Specifications

### Accounts Gallery


- **File:** page.tsx
- **Purpose:** Card-based gallery of Account records, click-to-open detail
- **Entities:** account
- **Needs caching:** true
- **Key Features:** Scrollable responsive account cards showing name, website, email, and phone with record navigation.
- **Components:** Card, Text, Button, Badge, Spinner from Fluent UI V9; BuildingRegular, MailRegular, PhoneRegular, GlobeRegular icons.
- **Layout:** Responsive card grid with scrollable page container and no viewport-sized CSS.
- **Data Binding:** queryTable("account") on mount selecting name, websiteurl, emailaddress1, telephone1; use window in-flight de-dupe and cache.
- **Interactions:** Clicking a card opens the Account record via Xrm.Navigation.navigateTo.
- File: page.tsx
- Entity: account
- Data fetching: dataApi.queryTable on mount, window cache (`__genpage_accounts_v1`), no useCallback wrap
- Columns shown: name, websiteurl, emailaddress1, telephone1
- Navigation: Xrm.Navigation.navigateTo({ pageType: 'entityrecord', entityName: 'account', entityId })
- Icons: BuildingRegular, MailRegular, PhoneRegular, GlobeRegular (unsized form)
- Styling: makeStyles with tokens; no inline styles for static values
