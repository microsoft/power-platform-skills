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

- Active Profile: aurora365-user1@auroratstgeo.onmicrosoft.com
- Environment URL: https://aurorabapenv4ab3f.crm10.dynamics.com/
- App: Recruitment Hub (33333333-2222-3333-4444-555555555555)
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

## Design Preferences

- DataGrid layout, sortable, resizable columns
- Status shown as Badge
- Lookup field shows FormattedValue (Job Requisition title)
- Realistic sample data (not lorem ipsum)

## Relevant Samples

- plugins/model-apps/samples/9-list-with-caching.tsx (Dataverse list + window cache)

## Per-Page Specifications

### Candidates

- File: page.tsx
- Entities: cr_candidate (primary), cr_jobrequisition (lookup target)
- Fetch on mount with window cache `__genpage_candidates_v1`
- Columns: cr_name, cr_status (FormattedValue), cr_interviewscore, cr_recruiter, _cr_jobrequisition_value (FormattedValue)
- DataGrid uses createTableColumn from @fluentui/react-components + columnSizingOptions + resizableColumns
- Icons: PeopleRegular, BriefcaseRegular (unsized)
- Sample data: 2 requisitions, 8 candidates with realistic names and varied statuses
