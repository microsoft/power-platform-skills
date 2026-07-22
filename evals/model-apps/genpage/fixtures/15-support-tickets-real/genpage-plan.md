# Genpage Plan

## User Requirements
Build a page tracking support tickets. I need a new cr_ticket entity with a priority choice column (Low, Medium, High, Critical), a status choice column (Open, In Progress, Resolved, Closed), and a due date column.

## Working Directory
D:/temp/support-tickets

## Plugin Root
D:/Projects/power-platform-skills/plugins/model-apps

## Environment
- URL: https://aurorabapenv610b3.crmtest.dynamics.com
- App: Genpage Publish Test (3fc905b9-7854-f111-a821-70a8a59ce7bc)
- Languages: English (1033) only
- Solution: Crdec34
- Publisher Prefix: cr

## Pages
| Page | File | Purpose | Entities |
|------|------|---------|----------|
| Support Tickets | support-tickets.tsx | Filterable list of support tickets with priority badges, status indicators, and due dates — clickable to open records | cr_ticket |

## Entity Creation Required

### ticket
[The full logical name is constructed by the entity-builder as `cr_ticket`. Display name: "Ticket".]

- Display Name: Ticket
- Display Plural: Tickets
- Primary Name Suffix: name
- Columns:
  | Suffix | Type | Required | Notes |
  |--------|------|----------|-------|
  | duedate | datetime | no | Due date for the support ticket |
- Choice Columns:
  | Column Suffix | Options |
  |---------------|---------|
  | priority | Low (100000000), Medium (100000001), High (100000002), Critical (100000003) |
  | status | Open (100000000), In Progress (100000001), Resolved (100000002), Closed (100000003) |
- Relationships:
  (none)

## Existing Entities
None

## Design Preferences
- Styling: Color-coded priority badges (Critical = red, High = orange, Medium = yellow, Low = green); status shown as pill/tag labels; due dates with overdue urgency cue (red text when past due)
- Features: Filter by status and priority; sort by due date; clickable rows to open record detail; search by ticket name
- Accessibility: WCAG AA compliant; keyboard-navigable list; sufficient color contrast on priority badges

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Support Tickets | 9-list-with-caching.tsx | Demonstrates a filterable list with Dataverse data and caching pattern — directly applicable to a support ticket list page |

## Per-Page Specifications

### Support Tickets
- **File:** support-tickets.tsx
- **Purpose:** Filterable, sortable list of support tickets with priority and status indicators
- **Entities:** cr_ticket
- **Needs caching:** true
- **Key Features:** Display all ticket records in a list/table; filter by status (Open, In Progress, Resolved, Closed) and priority (Low, Medium, High, Critical); sort by due date ascending/descending; search by ticket name; color-coded priority badges; due date shown in red when past today; click row to open ticket record in the model-driven app
- **Components:** Fluent UI V9 — DataGrid or DetailsList for the table; Badge or Tag for priority and status pills; SearchBox for name search; Dropdown for filter controls; Toolbar for filter/sort bar
- **Layout:** Full-width responsive table layout; filter bar above the table; on narrow screens stack filters vertically; sticky header row
- **Data Binding:** queryTable("cr_ticket") selecting cr_name, cr_priority, cr_status, cr_duedate; sort and filter applied as OData query parameters; cache results via the caching pattern from data-caching.md
- **Interactions:** Clicking a row calls openRecord("cr_ticket", recordId) to navigate to the record; filter dropdowns re-query on change; sort column headers toggle asc/desc; search box debounced at 300ms
