# Genpage Plan

## User Requirements
Create a dashboard page with mock data showing sales metrics — monthly revenue chart, top 5 customers table, and a KPI summary bar. Use a modern dark theme look.

## Working Directory
D:/temp/sales-dashboard

## Plugin Root
D:/Projects/power-platform-skills/plugins/model-apps

## Environment
- URL: https://aurorabapenv610b3.crmtest.dynamics.com/
- App: DSTest-A-WithDataSources (35913103-4e59-f111-a821-000d3a37616d)
- Languages: English (1033) only
- Solution: Default
- Publisher Prefix: new

## Pages
| Page | File | Purpose | Entities |
|------|------|---------|----------|
| Sales Dashboard | sales-dashboard.tsx | Dark-themed sales overview with KPI bar, monthly revenue chart, and top-5 customers table | mock data |

## Entity Creation Required
No entity creation required — all entities already exist.

## Existing Entities
None

## Design Preferences
- Styling: Modern dark theme. Base on Fluent UI v9 `webDarkTheme` with a deep neutral background (near-black `#0E1116`/`#14171C`), elevated card surfaces (`#1B1F25`), subtle 1px borders using `colorNeutralStroke2`, and a vibrant accent palette — primary accent teal/cyan (`#2EE6D6`), secondary accent magenta (`#FF4FA3`), and supporting amber (`#FFB547`) for warnings. High-contrast typography using `colorNeutralForeground1` for headings and `colorNeutralForeground3` for secondary labels. Card corners radius `tokens.borderRadiusLarge`, soft shadow `tokens.shadow16` for elevation.
- Features: Single-page dashboard, no routing. KPI summary bar at the top (4 metric tiles with delta indicators), a full-width monthly revenue chart in the middle (12-month line/area chart with grid lines and tooltips), and a top-5 customers table at the bottom (rank, customer name, revenue YTD, deals closed, growth %). Optional time-range pill toggle (Last 6M / Last 12M / YTD) that filters the chart and KPIs. Hover states on all interactive elements, sparkline-style mini-chart on each KPI tile.
- Accessibility: All KPI tiles, chart, and table rows must meet WCAG AA contrast in dark mode (accent colors above were chosen for ≥4.5:1 on `#14171C`). Chart series exposed via `aria-label` and a visually-hidden data table for screen readers. Keyboard-navigable time-range toggle (Tab + Arrow keys). Focus rings visible against dark background using `tokens.colorStrokeFocus2`.

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Sales Dashboard | 8-dashboard-with-charts.tsx | Direct structural match — KPI tiles, chart composition, and tabular section on a single dashboard surface |

## Per-Page Specifications

### Sales Dashboard
- **File:** sales-dashboard.tsx
- **Purpose:** Mock-data sales overview combining KPI tiles, a 12-month revenue chart, and a top-5 customers table on a dark-themed single page.
- **Entities:** mock data
- **Needs caching:** false
- **Key Features:**
  - KPI summary bar with 4 tiles: Total Revenue (MTD), New Deals Closed, Average Deal Size, Win Rate. Each tile shows the headline value, a delta vs. prior period (with up/down arrow and color cue), and a faint sparkline of the last 8 weeks.
  - Monthly Revenue chart: 12-month line/area chart with smooth curve, gradient fill from accent teal to transparent, gridlines, and rich hover tooltip (month label + revenue + MoM change).
  - Top 5 Customers table: columns Rank, Customer, Revenue YTD ($), Deals Closed, Growth %. Growth % rendered as a Badge (green for positive, red for negative). Subtle row hover.
  - Time-range pill toggle (segmented control: 6M / 12M / YTD) that re-derives KPI deltas and chart slice from the same mock dataset (no fetch).
  - Page header: "Sales Dashboard" title + caption "Last updated [today]" + a refresh icon button (decorative — re-randomizes mock data in state for demo flair).
- **Components:** Fluent UI v9 — `FluentProvider` with `webDarkTheme`, `Card`, `CardHeader`, `Text`, `Title1`/`Title2`/`Subtitle1`/`Caption1`, `Badge`, `Button`, `ToggleButton` (or `TabList`), `Table` / `TableHeader` / `TableRow` / `TableCell`, `Skeleton` for initial loading shimmer, `Tooltip`, `Divider`. Custom inline SVG for the revenue chart and KPI sparklines (no third-party chart lib — keep bundle lean and theme-aware).
- **Layout:** Responsive CSS grid. Outer page is a vertical flex with 24px gap, max-width 1440px, centered, 32px horizontal padding (16px on mobile). KPI bar is `grid-template-columns: repeat(auto-fit, minmax(220px, 1fr))` — 4-up on desktop, 2-up on tablet, stacked on mobile. Revenue chart card spans full width with aspect ratio ~16:6. Top customers table card spans full width below.
- **Data Binding:** Pure mock — a `useMemo`-wrapped `mockSalesData` object containing: `kpis: { totalRevenueMtd, newDealsClosed, avgDealSize, winRate, deltas, sparklines }`, `monthlyRevenue: { month: string; revenue: number }[]` (12 entries), and `topCustomers: { rank, name, revenueYtd, dealsClosed, growthPct }[]` (5 entries). No `queryTable` / `retrieveRow` calls — page operates entirely offline.
- **Interactions:**
  - Time-range toggle: `useState` for `'6M' | '12M' | 'YTD'`; clicking re-slices `monthlyRevenue` and recomputes derived KPI deltas via a pure helper.
  - Refresh button: re-runs a `generateMockSales(seed)` helper with a new seed and updates state — gives a satisfying re-randomize for demos.
  - Chart hover: shows a vertical guideline and floating tooltip with month/value (SVG `<g>` event handlers).
  - Table row hover: applies an elevated background using `tokens.colorNeutralBackground1Hover`.
  - All interactive controls are keyboard-reachable; focus order follows visual order (header actions → toggle → chart → table).
