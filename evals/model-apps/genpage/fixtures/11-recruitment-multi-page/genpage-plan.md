# Genpage Plan

## User Requirements

Build me three pages for a recruitment app: a candidate list page, an
interview schedule page, and a hiring metrics dashboard. Use the contact
and appointment entities.

## Working Directory

recruitment-pages/

## Plugin Root

D:\Projects\power-platform-skills\plugins\model-apps

## Environment

- Active Profile: aurora365-user1@auroratstgeo.onmicrosoft.com
- URL: https://aurorabapenv4ab3f.crm10.dynamics.com/
- App: Recruitment Hub (44444444-3333-4444-5555-666666666666)
- Languages: English (1033) only
- Solution: Default
- Publisher Prefix: new

## Pages

| Page | File | Purpose | Entities |
|------|------|---------|----------|
| Candidates | candidate-list.tsx | DataGrid of contacts with row action to schedule interview | contact |
| Schedule | interview-schedule.tsx | List of appointments filtered by candidate; link to metrics | contact, appointment |
| Metrics | hiring-metrics.tsx | KPI bar with total candidates, scheduled interviews, hired | contact, appointment |

## Entity Creation Required

No entity creation required — all entities already exist.

## Existing Entities

contact, appointment

## Connector Bindings

No connector bindings.

## Design Preferences

- Cross-page navigation uses Xrm.Navigation.navigateTo with `pageId: "PAGEREF_<filename>"` placeholders that the orchestrator resolves in Phase 6.5
- Each page uses makeStyles + tokens; no inline styles for static values
- Icons in unsized form

## Relevant Samples

| Page | Sample | Reason |
|------|--------|--------|
| Candidates | 9-list-with-caching.tsx | Dataverse list + window cache |
| Schedule | 10-detail-with-pageinput.tsx | pageInput-driven detail page |
| Metrics | 8-dashboard-with-charts.tsx | KPI dashboard layout |
## Per-Page Specifications

### Candidates


- **File:** candidate-list.tsx
- **Purpose:** DataGrid of contacts with row action to schedule interview
- **Entities:** contact
- **Needs caching:** true
- **Key Features:** Contact DataGrid with row action that navigates to the interview schedule page using PAGEREF.
- **Components:** DataGrid, Button, Badge, Text, Spinner, and Fluent UI V9 table helpers.
- **Layout:** Toolbar plus full-width grid with responsive column sizing.
- **Data Binding:** queryTable("contact") on mount with window de-dupe and cache.
- **Interactions:** Row click navigates to PAGEREF_interview-schedule with contactId page input.
- File: candidate-list.tsx
- Entity: contact
- Action: row click navigates to "PAGEREF_interview-schedule" with `data: { contactId }`
- DataGrid uses createTableColumn + columnSizingOptions + resizableColumns

### Schedule


- **File:** interview-schedule.tsx
- **Purpose:** List of appointments filtered by candidate; link to metrics
- **Entities:** contact, appointment
- **Needs caching:** true
- **Key Features:** Appointment schedule filtered by selected candidate and linked to metrics.
- **Components:** DataGrid, Text, Button, Badge, Spinner, DatePicker where useful.
- **Layout:** List/grid layout grouped by candidate or schedule date with responsive stacking.
- **Data Binding:** queryTable("appointment") on mount, filtered by pageInput contactId when present; use window de-dupe and cache.
- **Interactions:** Filter appointments by candidate page input and navigate to PAGEREF_hiring-metrics.
- File: interview-schedule.tsx
- Entities: contact, appointment
- pageInput: receives `{ contactId }` from candidate-list
- Filter appointments by `_regardingobjectid_value` when contactId is present
- Link to "PAGEREF_hiring-metrics"

### Metrics


- **File:** hiring-metrics.tsx
- **Purpose:** KPI bar with total candidates, scheduled interviews, hired
- **Entities:** contact, appointment
- **Needs caching:** true
- **Key Features:** Recruitment KPI cards for candidates, scheduled interviews, and hired estimate.
- **Components:** Card, Text, Badge, Spinner, and simple chart/list elements from Fluent UI V9.
- **Layout:** Responsive KPI dashboard grid with cards and summary sections.
- **Data Binding:** queryTable("contact") and queryTable("appointment") on mount; use in-flight de-dupe and window caches per page/query.
- **Interactions:** Read-only dashboard with optional navigation back to Candidates or Schedule.
- File: hiring-metrics.tsx
- Entities: contact, appointment
- KPIs: total candidates (contact count), scheduled interviews (appointment statecode=0), hired (estimate)
