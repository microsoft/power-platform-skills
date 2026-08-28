# Genpage Plan

## User Requirements

Build a page showing all job candidates with their application status,
interview scores, and assigned recruiter. New tables cr_candidate and
cr_jobrequisition are required. Include sample data.

## Working Directory

job-candidates/

## Plugin Root

D:\Projects\power-platform-skills\plugins\model-apps

## Environment

- Active Profile: contoso-user001@contosotest1.onmicrosoft.com
- URL: https://contosobapenv0002.crm10.dynamics.com/
- App: Recruitment Hub (33333333-2222-3333-4444-555555555555)
- Languages: English (1033) only
- Solution: Default
- Publisher Prefix: cr

## Pages

| Page | File | Purpose | Entities |
|------|------|---------|----------|
| Candidates | page.tsx | List of candidates with status, interview score, recruiter, requisition link | cr_candidate, cr_jobrequisition |

## Entity Creation Required

### jobrequisition

- Display Name: Job Requisition
- Display Plural: Job Requisitions
- Primary Name Suffix: title
- Columns:

  | Suffix | Type | Required | Notes |
  |--------|------|----------|-------|
  | department | string | yes | Department owning the requisition |
  | openings | int | yes | Number of openings (>=0) |
- Choice Columns:

  | Column Suffix | Options |
  |---------------|---------|
  | none | none |
- Relationships:

  | Type | Related Table | Lookup Suffix | Cascade |
  |------|---------------|---------------|---------|
  | none | none | none | none |

### candidate

- Display Name: Candidate
- Display Plural: Candidates
- Primary Name Suffix: name
- Columns:

  | Suffix | Type | Required | Notes |
  |--------|------|----------|-------|
  | interviewscore | int | yes | Interview score 0-100 |
  | recruiter | string | yes | Assigned recruiter display name |
- Choice Columns:

  | Column Suffix | Options |
  |---------------|---------|
  | status | applied (100000000), interviewing (100000001), offered (100000002), hired (100000003) |
- Relationships:

  | Type | Related Table | Lookup Suffix | Cascade |
  |------|---------------|---------------|---------|
  | 1:N | jobrequisition | jobrequisition | Restrict |

## Existing Entities

None.

## Connector Bindings

No connector bindings.

## Design Preferences

- DataGrid layout, sortable, resizable columns
- Status shown as Badge
- Lookup field shows FormattedValue (Job Requisition title)
- Realistic sample data (not lorem ipsum)

## Relevant Samples

| Page | Sample | Reason |
|------|--------|--------|
| Candidates | 9-list-with-caching.tsx | Dataverse list + window cache |
## Per-Page Specifications

### Candidates


- **File:** page.tsx
- **Purpose:** List of candidates with status, interview score, recruiter, requisition link
- **Entities:** cr_candidate, cr_jobrequisition
- **Needs caching:** true
- **Key Features:** Candidate grid with status badges, interview score, recruiter, requisition lookup text, and sample data.
- **Components:** DataGrid, Badge, Text, Spinner, MessageBar, and PeopleRegular/BriefcaseRegular icons.
- **Layout:** Full-width sortable/resizable grid with responsive overflow handling.
- **Data Binding:** queryTable("cr_candidate") on mount selecting candidate columns and lookup formatted values; use window de-dupe and cache.
- **Interactions:** Sort and resize columns; no edit actions required in the generated page.
- File: page.tsx
- Entities: cr_candidate (primary), cr_jobrequisition (lookup target)
- Fetch on mount with window cache `__genpage_candidates_v1`
- Columns: cr_name, cr_status (FormattedValue), cr_interviewscore, cr_recruiter, _cr_jobrequisition_value (FormattedValue)
- DataGrid uses createTableColumn from @fluentui/react-components + columnSizingOptions + resizableColumns
- Icons: PeopleRegular, BriefcaseRegular (unsized)
- Sample data: 2 requisitions, 8 candidates with realistic names and varied statuses
