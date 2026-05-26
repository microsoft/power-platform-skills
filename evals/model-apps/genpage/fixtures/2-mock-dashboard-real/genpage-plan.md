# Genpage Plan

## User Requirements
Build a dark-themed sales dashboard page with a monthly revenue bar chart (Jan–Dec 2025), a top-5 customers table, and a KPI summary bar showing Total Revenue (YTD), Active Customers, Avg Deal Size, and Win Rate. All data is mock. Use teal/cyan accent colors on a dark background. The table should use Fluent UI DataGrid with region badges and status chips. The layout should be responsive, collapsing to a single column on narrow viewports and expanding to the full layout at 768px or wider.

## Working Directory
D:/temp/sales-dashboard

## Plugin Root
D:/Projects/power-platform-skills/plugins/model-apps

## Environment
- URL: https://tmsbapenv5ee52.crmtest.dynamics.com/
- App: genux infra demo (cdf28a9d-bf3d-f111-bec7-000d3a36bc0a)
- Languages: English (1033) only
- Solution: Default
- Publisher Prefix: new

## Pages
| Page | File | Purpose | Entities |
|------|------|---------|----------|
| Sales Dashboard | sales-dashboard.tsx | Dark-themed dashboard with monthly revenue bar chart, top-5 customers table, and KPI summary bar | mock data |

## Entity Creation Required
No entity creation required — all entities already exist.

## Existing Entities
None

## Design Preferences
- Styling: Dark background (#0d1117 page background, #161b22 card/tile surfaces), near-white text (#e6edf3), accent teal/cyan (#00bcd4) for chart bars, highlights, and interactive elements. Subtle border (#30363d) around card surfaces.
- Features: KPI summary bar (4 metric tiles in a horizontal row, each with an icon, large numeric value, label, and trend arrow); monthly revenue bar chart rendered with inline SVG bars for 12 months (Jan–Dec 2025); top-5 customers Fluent UI DataGrid with sortable columns, formatted currency, region badge chips, and Active/Inactive status chips; responsive layout that stacks to single column below 768px.
- Accessibility: WCAG AA contrast ratios on all text against dark backgrounds; keyboard-navigable DataGrid; aria-labels on SVG chart elements; focus-visible ring on interactive elements.

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Sales Dashboard | 8-dashboard-with-charts.tsx | Demonstrates dashboard layout with KPI tiles and chart rendering patterns on a dark theme |

## Per-Page Specifications

### Sales Dashboard
- **File:** sales-dashboard.tsx
- **Purpose:** Dark-themed sales dashboard displaying KPI summary bar, monthly revenue bar chart, and top-5 customers table using mock data.
- **Entities:** mock data
- **Needs caching:** false
- **Key Features:**
  - KPI bar: 4 tiles in a horizontal row — Total Revenue YTD ($3.82M), Active Customers (248), Avg Deal Size ($87.5K), Win Rate (64%). Each tile shows an icon, formatted value, label, and a colored trend arrow (up/down) with a small percentage delta.
  - Revenue bar chart: inline SVG bar chart for 12 months (Jan–Dec 2025). Bars are teal (#00bcd4), with dark gridlines, white axis labels, and a hover tooltip showing the exact month and value. Monthly values (USD): Jan $180K, Feb $210K, Mar $290K, Apr $340K, May $410K, Jun $380K, Jul $450K, Aug $510K, Sep $490K, Oct $570K, Nov $600K, Dec $620K.
  - Top-5 customers table: Fluent UI DataGrid with columns: Customer Name, Total Revenue (formatted currency), Deal Count, Region (badge chip), Status (Active/Inactive chip). Rows are keyboard-navigable. Customers: Contoso Ltd ($820K, 14 deals, North America, Active), Fabrikam Inc ($740K, 11 deals, Europe, Active), Northwind Traders ($610K, 9 deals, Asia Pacific, Active), Adventure Works ($480K, 7 deals, North America, Inactive), Tailspin Toys ($370K, 6 deals, Europe, Active).
  - Responsive: at viewport width < 768px, KPI tiles wrap to 2-column grid and chart/table stack vertically; at >= 768px the full side-by-side or stacked layout is shown.
- **Components:** Fluent UI V9 — `Text`, `Card`, `Badge`, `DataGrid`, `DataGridHeader`, `DataGridHeaderCell`, `DataGridBody`, `DataGridRow`, `DataGridCell`, `TableColumnDefinition`, `createTableColumn`, `makeStyles`, `tokens`. Inline SVG for the bar chart (no external chart library).
- **Layout:** Page uses a flex column container. Top section: 4 KPI tiles in a CSS grid (repeat(4, 1fr) collapsing to repeat(2, 1fr) below 768px). Middle section: the bar chart card spanning full width. Bottom section: the top-5 customers DataGrid card spanning full width. All cards use the #161b22 surface color with #30363d border and 12px border-radius.
- **Data Binding:** All data is defined as inline TypeScript const arrays at the top of the component file — no Dataverse queries. A `kpiData` array of 4 objects, a `revenueData` array of 12 month objects, and a `customerData` array of 5 customer objects.
- **Interactions:** SVG bar chart bars highlight on hover (opacity change) and show a floating tooltip (position: absolute, dark background, white text) with month name and formatted dollar value. DataGrid rows are selectable/focusable via keyboard. Trend arrows in KPI tiles are purely visual (no click behavior). No routing or navigation needed.
