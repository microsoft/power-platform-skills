# Genpage Plan

## User Requirements
Create a dashboard page with account metrics. I don't have any model-driven apps yet.

## Working Directory
D:/work/account-metrics-dashboard

## Plugin Root
D:/repo/plugins/model-apps

## Environment
- URL: https://contoso.crm.dynamics.com
- App: create new: Account Metrics
- Languages: English (1033) only
- Solution: ContosoCore
- Publisher Prefix: cnt

## Pages
| Page | File | Purpose | Entities |
|------|------|---------|----------|
| Account Metrics Dashboard | account-metrics.tsx | Dashboard of active-account KPIs, industry and monthly-growth charts, and top accounts by revenue | account |

## Entity Creation Required
No entity creation required — all entities already exist.

## Existing Entities
account

## Connector Bindings
No connector bindings.

## Custom API Bindings
No custom API bindings.

## Design Preferences
- Styling: default Fluent light theme, KPI cards on top, charts in two columns that stack on narrow widths
- Features: account metrics dashboard — active account count, total annual revenue, average employees, accounts created in the last 90 days; accounts by industry; new accounts per month; top 10 accounts by annual revenue with click-to-open; manual refresh
- Accessibility: WCAG AA defaults; charts expose role="img" with aria-labels and SVG tooltips; grid rows are keyboard reachable

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Account Metrics Dashboard | 8-dashboard-with-charts.tsx | KPI cards plus D3 charts with the animation guard |
| Account Metrics Dashboard | 9-list-with-caching.tsx | Dataverse read with window cache, in-flight de-dupe and a sized DataGrid |

## Per-Page Specifications

### Account Metrics Dashboard
- **File:** account-metrics.tsx
- **Purpose:** Dashboard of active-account KPIs, industry and monthly-growth charts, and top accounts by revenue
- **Entities:** account
- **Needs caching:** true
- **Key Features:** Four KPI cards (active accounts, total annual revenue, average employees, new in last 90 days); D3 horizontal bar chart of active accounts by industry; D3 column chart of accounts created per month over the last 12 months; top 10 accounts by annual revenue in a sortable DataGrid; refresh button
- **Components:** Card, CardHeader, Text, Button, Spinner, MessageBar, DataGrid with createTableColumn; BuildingRegular, MoneyRegular, PeopleTeamRegular, CalendarRegular, ArrowClockwiseRegular icons; D3.js for charts
- **Layout:** Flex column root; responsive KPI grid; two-column chart grid stacking below 900px; full-width grid card; no 100vh/100vw
- **Data Binding:** One dataApi.queryTable('account') on mount — select accountid, name, industrycode, revenue, numberofemployees, address1_city, createdon; filter statecode eq 0; order by revenue desc; page size 500 with loadMoreRows up to 5,000 rows; window cache + in-flight de-dupe keyed to this page; industry label from the industrycode FormattedValue annotation
- **Interactions:** Selecting an account name opens the account record via Xrm.Navigation.navigateTo; column sorting and resizing; Refresh clears the cache and in-flight promise and refetches
