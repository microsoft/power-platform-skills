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

- Active Profile: aurora365-user1@auroratstgeo.onmicrosoft.com
- Environment URL: https://aurorabapenv4ab3f.crm10.dynamics.com/
- App: Sales Hub (12345678-1234-1234-1234-123456789abc)
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

## Design Preferences

- Modern dark theme look (use Fluent UI V9 dark tokens)
- KPI cards at top
- D3 line chart for monthly revenue
- DataGrid for top 5 customers
- Responsive flex layout (no 100vh / 100vw)

## Relevant Samples

- plugins/model-apps/samples/8-dashboard-with-charts.tsx (KPI + D3 pattern)

## Per-Page Specifications

### Sales Metrics

- File: dashboard.tsx
- Data: mock arrays for monthly revenue, top customers, KPI summary
- Components:
  - KPI summary bar (3-4 cards with icon + metric + label)
  - D3 line chart for revenue trend
  - DataGrid for top customers
- Chart library: D3.js only (no Chart.js / Recharts)
- Icons: unsized form (ArrowTrendingRegular, PeopleRegular, ShoppingBagRegular)
- Styling: makeStyles with tokens; no inline styles for static values
