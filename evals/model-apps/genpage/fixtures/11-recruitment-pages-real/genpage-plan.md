# Genpage Plan

## User Requirements
Build me three pages for a recruitment app: a candidate list page, an interview schedule page, and a hiring metrics dashboard. Use the contact and appointment entities.

## Working Directory
D:/temp/recruitment-app

## Plugin Root
D:/Projects/power-platform-skills/plugins/model-apps

## Environment
- URL: https://aurorabapenv610b3.crmtest.dynamics.com
- App: create new: Recruitment App
- Languages: English (1033) only
- Solution: Crdec34
- Publisher Prefix: crb2b

## Pages
| Page | File | Purpose | Entities |
|------|------|---------|----------|
| Candidate List | candidate-list.tsx | Searchable, filterable list of candidates (Contact records) showing name, email, phone, job title, and status | contact |
| Interview Schedule | interview-schedule.tsx | Grid view of scheduled interviews (Appointment records) showing subject, start/end time, location, and linked candidate | appointment, contact |
| Hiring Metrics Dashboard | hiring-metrics-dashboard.tsx | Read-only dashboard summarizing recruitment KPIs: total candidates, interviews scheduled, pipeline stage breakdown, and recent activity | contact, appointment |

## Entity Creation Required
No entity creation required — all entities already exist.

## Existing Entities
contact, appointment

## Design Preferences
- Styling: Clean, professional recruitment theme using Fluent UI V9 components; neutral palette (white backgrounds, subtle grays, blue accents); card-based layouts where appropriate
- Features: Candidate List — text search by name, filter by job title/status, clickable rows to open Contact record; Interview Schedule — sortable columns (date, candidate, subject), date-range filter, rows grouped by day; Hiring Metrics Dashboard — summary stat cards (total candidates, total interviews), bar chart for pipeline stage breakdown, recent appointments list
- Accessibility: WCAG AA defaults — focusable interactive elements, aria-labels on icon-only controls, sufficient color contrast

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Candidate List | 9-list-with-caching.tsx | List page backed by Dataverse with search, caching, and row click navigation |
| Interview Schedule | 1-account-grid.tsx | Grid layout with sortable columns and Dataverse data binding |
| Hiring Metrics Dashboard | 8-dashboard-with-charts.tsx | Dashboard layout with stat cards and chart components |

## Per-Page Specifications

### Candidate List
- **File:** candidate-list.tsx
- **Purpose:** Searchable, filterable list of Contact records representing job candidates
- **Entities:** contact
- **Needs caching:** true
- **Key Features:** Text search filtering by fullname; dropdown filter for jobtitle; status badge showing contact status; clickable rows that navigate to the Contact record; empty state when no results; loading skeleton during fetch
- **Components:** SearchBox, Dropdown, DataGrid, TableRow, TableCell, Badge, Spinner, Text, Button (Fluent UI V9)
- **Layout:** Full-width single-column; search and filter controls in a toolbar above the grid; responsive — on narrow screens the filter Dropdown stacks below SearchBox
- **Data Binding:** queryTable on contact entity; retrieve fields: contactid, fullname, emailaddress1, telephone1, jobtitle, statuscode; order by fullname ascending; client-side filter for search and jobtitle
- **Interactions:** Row click opens the Contact record (navigateToRecord); SearchBox onChange filters displayed rows; Dropdown onChange filters by jobtitle; pagination with Next/Previous if record count > 50

### Interview Schedule
- **File:** interview-schedule.tsx
- **Purpose:** Grid view of Appointment records representing scheduled interviews, grouped by day
- **Entities:** appointment, contact
- **Needs caching:** true
- **Key Features:** Appointments displayed in a sortable grid; columns: Subject, Candidate (regardingobjectid linked to contact), Scheduled Start, Scheduled End, Location, Status; date-range filter (start date / end date pickers); rows grouped by calendar day; clickable rows to open the Appointment record; empty state when no appointments in range
- **Components:** DataGrid, TableRow, TableCell, DatePicker, Dropdown (status filter), Divider, Text, Badge, Spinner (Fluent UI V9)
- **Layout:** Full-width; filter bar (date range pickers + status dropdown) above the grid; day-group headers as styled dividers; responsive stacking on narrow screens
- **Data Binding:** queryTable on appointment entity; retrieve fields: activityid, subject, scheduledstart, scheduledend, location, statuscode, regardingobjectid; filter by scheduledstart between user-selected date range; order by scheduledstart ascending; optionally expand regardingobjectid to get contact fullname
- **Interactions:** Column header click to sort; DatePicker onChange to filter by date range; status Dropdown onChange to filter; row click navigates to Appointment record (navigateToRecord)

### Hiring Metrics Dashboard
- **File:** hiring-metrics-dashboard.tsx
- **Purpose:** Read-only dashboard showing recruitment KPIs derived from Contact and Appointment records
- **Entities:** contact, appointment
- **Needs caching:** false
- **Key Features:** Four summary stat cards: Total Active Candidates (contact count with statuscode=active), Interviews This Month (appointment count with scheduledstart in current month), Interviews This Week, Open Positions (placeholder from contact jobtitle distinct count); a bar chart showing candidate count grouped by jobtitle (top 5); a recent activity list showing the 5 most recently created appointments with subject, candidate, and scheduled start
- **Components:** Card, CardHeader, Text, ProgressBar or BarChart (via @fluentui/react-charts or inline SVG fallback), List, Spinner, Divider, Badge (Fluent UI V9)
- **Layout:** Responsive CSS grid: 2-column on desktop (stat cards in top row, chart left, recent list right), single-column on mobile; section headings for "At a Glance", "Pipeline by Role", "Recent Interviews"
- **Data Binding:** Two separate queryTable calls — one for contact (retrieve: contactid, jobtitle, statuscode, createdon; filter statuscode=active) and one for appointment (retrieve: activityid, subject, scheduledstart, regardingobjectid, createdon; order by createdon descending, top 10); metrics computed client-side from results
- **Interactions:** Refresh button to re-fetch data; stat card click optionally deep-links to the respective list page (candidate-list.tsx or interview-schedule.tsx); no edit actions — dashboard is read-only
