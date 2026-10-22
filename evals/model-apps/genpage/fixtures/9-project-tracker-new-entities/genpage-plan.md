# Genpage Plan

## User Requirements
Build a project tracker page. I need new cr_project and cr_milestone entities with sample data to test the page.

## Working Directory
D:/work/project-tracker

## Plugin Root
D:/repo/plugins/model-apps

## Environment
- URL: https://contoso.crm.dynamics.com
- App: Contoso Operations Hub (11111111-2222-3333-4444-555555555555)
- Languages: English (1033) only
- Solution: ContosoProjects
- Publisher Prefix: cr

## Pages
| Page | File | Purpose | Entities |
|------|------|---------|----------|
| Project Tracker | project-tracker.tsx | Track projects and their milestones: portfolio summary, selectable project list, and a milestone grid for the selected project | cr_project, cr_milestone |

## Entity Creation Required

### project
[The full logical name is constructed by the entity-builder as `cr_project`. Display name: "Project".]

- Display Name: Project
- Display Plural: Projects
- Primary Name Suffix: name
- Columns:

  | Suffix | Type | Required | Notes |
  |--------|------|----------|-------|
  | manager | string | yes | Project manager display name (max 100) |
  | startdate | datetime | yes | Date only — planned start |
  | targetdate | datetime | yes | Date only — planned finish |
  | budget | money | no | Approved budget |
- Choice Columns:

  | Column Suffix | Options |
  |---------------|---------|
  | status | Planning (100000000), Active (100000001), On Hold (100000002), Completed (100000003) |
- Relationships:

  | Type | Related Table | Lookup Suffix | Cascade |
  |------|---------------|---------------|---------|
  | none | none | none | none |

### milestone
[The full logical name is constructed by the entity-builder as `cr_milestone`. Display name: "Milestone".]

- Display Name: Milestone
- Display Plural: Milestones
- Primary Name Suffix: name
- Columns:

  | Suffix | Type | Required | Notes |
  |--------|------|----------|-------|
  | duedate | datetime | yes | Date only — milestone due date |
  | percentcomplete | int | no | 0-100 |
- Choice Columns:

  | Column Suffix | Options |
  |---------------|---------|
  | status | Not Started (100000000), In Progress (100000001), Completed (100000002), Blocked (100000003) |
- Relationships:

  | Type | Related Table | Lookup Suffix | Cascade |
  |------|---------------|---------------|---------|
  | 1:N lookup | project | project | RemoveLink |

## Existing Entities
None

## Connector Bindings
No connector bindings.

## Custom API Bindings
No custom API bindings.

## Design Preferences
- Styling: Fluent UI V9 tokens; status shown as colored badges (project: Planning / Active / On Hold / Completed; milestone: Not Started / In Progress / Completed / Blocked); overdue milestones flagged with a warning icon and danger-colored date
- Features: portfolio summary tiles (active projects, open milestones, due in the next 30 days, overdue); project search by name or manager; project cards with milestone progress; milestone grid filtered to All / Open / Overdue; refresh button; open project and milestone records
- Accessibility: WCAG AA; keyboard-reachable project cards and grid actions; every icon-only button has an aria-label
- Sample data: realistic projects and milestones (not lorem ipsum); every milestone belongs to a project through the cr_milestone → cr_project lookup

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Project Tracker | 9-list-with-caching.tsx | Dataverse list with window cache + in-flight de-dupe, DataGrid with createTableColumn and column sizing |

## Per-Page Specifications

### Project Tracker
- **File:** project-tracker.tsx
- **Purpose:** Track projects and their milestones: portfolio summary, selectable project list, and a milestone grid for the selected project
- **Entities:** cr_project, cr_milestone
- **Needs caching:** true
- **Key Features:** Summary tiles (active projects, open milestones, due in the next 30 days, overdue); project list searchable by name or manager, each card showing status badge, manager, target date and milestone progress; selecting a project shows its details (dates, budget, progress) and its milestones in a sortable grid with All / Open / Overdue tabs; overdue = due before today and not Completed; refresh clears the cache and reloads
- **Components:** Fluent UI V9 — Card, Badge, ProgressBar, SearchBox, TabList/Tab, DataGrid (createTableColumn, sortable, resizableColumns + columnSizingOptions), Button, Spinner, MessageBar, Text; icons BriefcaseRegular, PersonRegular, CalendarLtrRegular, FlagRegular, WarningRegular, OpenRegular, ArrowClockwiseRegular (unsized, verified)
- **Layout:** Flex-column root; header with title and refresh action opposite; responsive summary tile grid (4 → 2 → 1 columns); two-pane body (project list left, selected project + milestones right) that stacks below 900px; only the list and grid panes scroll
- **Data Binding:** One Promise.all of queryTable("cr_project") selecting cr_projectid, cr_name, cr_manager, cr_startdate, cr_targetdate, cr_budget, cr_status and queryTable("cr_milestone") selecting cr_milestoneid, cr_name, cr_duedate, cr_percentcomplete, cr_status, _cr_project_value; results read via .rows; milestones grouped by the _cr_project_value GUID and the project label read from its @OData.Community.Display.V1.FormattedValue annotation; single batched setData; window cache + in-flight de-dupe keyed by page (`__ppProjectTracker_…`), readiness-gated effect deps
- **Interactions:** Click a project card to select it (first project selected by default); search filters cards; tabs filter milestones; grid columns sort; "Open project" / "Open milestone" use Xrm.Navigation.navigateTo with pageType "entityrecord"; refresh evicts cache + in-flight promise and refetches
