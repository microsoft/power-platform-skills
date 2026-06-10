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
- Environment URL: https://aurorabapenv4ab3f.crm10.dynamics.com/
- App: Recruitment Hub (44444444-3333-4444-5555-666666666666)
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

## Design Preferences

- Cross-page navigation uses Xrm.Navigation.navigateTo with `pageId: "PAGEREF_<filename>"` placeholders that the orchestrator resolves in Phase 6.5
- Each page uses makeStyles + tokens; no inline styles for static values
- Icons in unsized form

## Relevant Samples

- plugins/model-apps/samples/9-list-with-caching.tsx (Dataverse list + window cache)
- plugins/model-apps/samples/10-detail-with-pageinput.tsx (pageInput-driven detail page)
- plugins/model-apps/samples/8-dashboard-with-charts.tsx (KPI dashboard layout)

## Per-Page Specifications

### Candidates

- File: candidate-list.tsx
- Entity: contact
- Action: row click navigates to "PAGEREF_interview-schedule" with `data: { contactId }`
- DataGrid uses createTableColumn + columnSizingOptions + resizableColumns

### Schedule

- File: interview-schedule.tsx
- Entities: contact, appointment
- pageInput: receives `{ contactId }` from candidate-list
- Filter appointments by `_regardingobjectid_value` when contactId is present
- Link to "PAGEREF_hiring-metrics"

### Metrics

- File: hiring-metrics.tsx
- Entities: contact, appointment
- KPIs: total candidates (contact count), scheduled interviews (appointment statecode=0), hired (estimate)
