# Genpage Plan

## User Requirements

Build a dashboard showing the current weather for Seattle with temperature, conditions, and humidity.

## Working Directory

seattle-weather-dashboard/

## Plugin Root

D:\Projects\power-platform-skills\plugins\model-apps

## Environment

- Active Profile: maker@contoso.onmicrosoft.com
- Environment URL: https://contoso-dev.crm10.dynamics.com/
- App: Operations Hub (aa112233-1122-1122-1122-aabbccdd1234)
- Solution: Default
- Publisher Prefix: new

## Pages

| Page | File | Purpose | Entities |
|------|------|---------|----------|
| Seattle Weather | weather-dashboard.tsx | Weather dashboard showing temperature, conditions, and humidity with 5-day forecast | (mock data) |

## Entity Creation Required

No entity creation required — all entities already exist.

## Existing Entities

(none — mock data page)

## Connector Bindings

No connector bindings.

## Design Preferences

- Inline mock weather data (connectors feature flag OFF — connector not available at this time)
- KPI-style metric cards for temperature, conditions, humidity
- 5-day forecast card row below current conditions
- Responsive flex layout (no 100vh / 100vw)
- Icons: TemperatureRegular, WeatherSunnyRegular, WaterRegular (unsized, from verified-icons.txt)

## Relevant Samples

| Page | Sample | Reason |
|------|--------|--------|
| Seattle Weather | 8-dashboard-with-charts.tsx | KPI card + metric display pattern |

## Per-Page Specifications

### Seattle Weather

- **File:** weather-dashboard.tsx
- **Data:** inline mock arrays — `weeklyForecast` (5 records) + `currentConditions` object
- **Components:**
  - Three metric cards: temperature (with feels-like), sky conditions, humidity
  - 5-day forecast card row (selectable for detail)
  - Mock data banner noting connector support is coming
- **Icons:** TemperatureRegular, WeatherSunnyRegular, WaterRegular (all unsized, from verified-icons.txt)
- **Styling:** makeStyles with tokens; no inline styles for static values; no 100vh/100vw
