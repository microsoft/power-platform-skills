# Genpage Plan

## User Requirements

Create a dashboard page with mock data showing sales metrics — monthly revenue
chart, top 5 customers table, and a KPI summary bar. Use a modern dark theme
look.

## Working Directory

sales-metrics-dashboard/

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
| Sales Metrics | dashboard.tsx | Mock dashboard with KPI bar, D3 revenue chart, top customers grid | (mock data) |

## Entity Creation Required

No entity creation required — all entities already exist.

## Existing Entities

(none — mock data page)

## Connector Bindings

No connector bindings.

## Design Preferences

- Modern dark theme look (use Fluent UI V9 dark tokens)
- KPI cards at top
- D3 line chart for monthly revenue
- DataGrid for top 5 customers
- Responsive flex layout (no 100vh / 100vw)

## Relevant Samples

| Page | Sample | Reason |
|------|--------|--------|
| Sales Metrics | 8-dashboard-with-charts.tsx | KPI + D3 pattern |
## Per-Page Specifications

### Sales Metrics


- **File:** dashboard.tsx
- **Purpose:** Mock dashboard with KPI bar, D3 revenue chart, top customers grid
- **Entities:** (mock data)
- **Needs caching:** false
- **Key Features:** KPI summary cards, D3 monthly revenue trend chart, and top customers grid backed by inline mock arrays.
- **Components:** Card, Text, DataGrid/Table, Button, Tooltip, and D3.js for the line chart.
- **Layout:** Dark responsive dashboard with KPI row, chart section, and customer table; no 100vh/100vw.
- **Data Binding:** Inline mock arrays for monthly revenue, top customers, and KPI summary; no host fetch.
- **Interactions:** Chart hover tooltip and keyboard-reachable dashboard controls over local state only.
- File: dashboard.tsx
- Data: mock arrays for monthly revenue, top customers, KPI summary
- Components:
  - KPI summary bar (3-4 cards with icon + metric + label)
  - D3 line chart for revenue trend
  - DataGrid for top customers
- Chart library: D3.js only (no Chart.js / Recharts)
- Icons: unsized form (ArrowTrendingRegular, PeopleRegular, ShoppingBagRegular)
- Styling: makeStyles with tokens; no inline styles for static values
