# Genpage Plan

## User Requirements
Create a simple analytics dashboard with mock data. I just want some charts showing website traffic trends and visitor demographics. Keep it clean and minimal.

## Working Directory
D:/work/website-traffic-analytics

## Plugin Root
D:/repo/plugins/model-apps

## Environment
- URL: https://contoso.crm.dynamics.com
- App: Contoso Marketing Hub (11111111-2222-4333-8444-555555555555)
- Languages: English (1033) only
- Solution: Default
- Publisher Prefix: new

## Pages
| Page | File | Purpose | Entities |
|------|------|---------|----------|
| Website Analytics | traffic-dashboard.tsx | Minimal dashboard of weekly traffic trends and visitor demographics | mock data |

## Entity Creation Required
No entity creation required — all entities already exist.

## Existing Entities
None

## Connector Bindings
No connector bindings.

## Custom API Bindings
No custom API bindings.

## Design Preferences
- Styling: clean and minimal — default Fluent light theme, neutral cards, generous whitespace, no decorative icons or gradients
- Features: four KPI figures with week-over-week change, one traffic trend chart, two demographic charts; no filters or drill-downs
- Accessibility: WCAG AA defaults; every chart has role="img" with an aria-label and native SVG tooltips on data points

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Website Analytics | 8-dashboard-with-charts.tsx | KPI cards plus D3 charts with the animation guard |

## Per-Page Specifications

### Website Analytics
- **File:** traffic-dashboard.tsx
- **Purpose:** Minimal dashboard of weekly traffic trends and visitor demographics
- **Entities:** mock data
- **Needs caching:** false
- **Key Features:** KPI row (visitors, page views, average session, bounce rate with week-over-week deltas); D3 line chart of weekly visitors and page views over the last 12 weeks; D3 bar charts of visitors by age group and by top country
- **Components:** Card, CardHeader, Text from Fluent UI V9; D3.js for all charts; no icons
- **Layout:** Flex column root; responsive KPI grid; chart grid with the trend chart full width and the two demographic charts side by side, stacking below 768px; no 100vh/100vw
- **Data Binding:** Inline mock arrays (12 weekly traffic points, 6 age groups, 6 countries) and static session stats; no host fetch
- **Interactions:** Native SVG tooltips on chart points and bars; one-time chart animation guarded by a window flag
