# Genpage Plan

## User Requirements
Build a page showing all job candidates with their application status, interview scores, and assigned recruiter. I need new tables for this — cr_candidate and cr_jobrequisition entities don't exist yet in my environment.

## Working Directory
D:/work/job-candidates

## Plugin Root
D:/repo/plugins/model-apps

## Environment
- URL: https://contoso.crm.dynamics.com
- App: Contoso Talent Hub (11111111-2222-3333-4444-555555555555)
- Languages: English (1033) only
- Solution: ContosoRecruiting
- Publisher Prefix: cr

## Pages
| Page | File | Purpose | Entities |
|------|------|---------|----------|
| Job Candidates | job-candidates.tsx | List every job candidate with their application status, interview score, assigned recruiter and the requisition they applied for | cr_candidate, cr_jobrequisition |

## Entity Creation Required

### jobrequisition
[The full logical name is constructed by the entity-builder as `cr_jobrequisition`. Display name: "Job Requisition".]

- Display Name: Job Requisition
- Display Plural: Job Requisitions
- Primary Name Suffix: name
- Columns:

  | Suffix | Type | Required | Notes |
  |--------|------|----------|-------|
  | department | string | yes | Hiring department (max 100) |
  | openings | int | no | Open positions, 1-50 |
- Choice Columns:

  | Column Suffix | Options |
  |---------------|---------|
- Relationships:

  | Type | Related Table | Lookup Suffix | Cascade |
  |------|---------------|---------------|---------|
  | none | none | none | none |

### candidate
[The full logical name is constructed by the entity-builder as `cr_candidate`. Display name: "Candidate".]

- Display Name: Candidate
- Display Plural: Candidates
- Primary Name Suffix: name
- Columns:

  | Suffix | Type | Required | Notes |
  |--------|------|----------|-------|
  | interviewscore | int | no | Interview panel score, 0-100 |
  | recruiter | string | yes | Assigned recruiter display name (max 100) |
- Choice Columns:

  | Column Suffix | Options |
  |---------------|---------|
  | applicationstatus | Applied (100000000), Screening (100000001), Interviewing (100000002), Offer (100000003), Hired (100000004), Rejected (100000005) |
- Relationships:

  | Type | Related Table | Lookup Suffix | Cascade |
  |------|---------------|---------------|---------|
  | 1:N lookup | jobrequisition | jobrequisition | RemoveLink |

## Existing Entities
None

## Connector Bindings
No connector bindings.

## Custom API Bindings
No custom API bindings.

## Design Preferences
- Styling: Fluent UI V9 tokens; application status shown as a colored badge (Applied / Screening / Interviewing / Offer / Hired / Rejected); interview score shown as a number out of 100, with an em dash when the candidate has not been interviewed
- Features: a sortable candidate grid (candidate, requisition, application status, interview score, recruiter); a candidate count; open the candidate record
- Accessibility: WCAG AA; keyboard-reachable grid and links; the title icon is decorative (aria-hidden)
- Sample data: realistic requisitions and candidates (not lorem ipsum); every candidate applies to a requisition through the cr_candidate → cr_jobrequisition lookup

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Job Candidates | 9-list-with-caching.tsx | Dataverse list with window cache + in-flight de-dupe, DataGrid with createTableColumn and column sizing |

## Per-Page Specifications

### Job Candidates
- **File:** job-candidates.tsx
- **Purpose:** List every job candidate with their application status, interview score, assigned recruiter and the requisition they applied for
- **Entities:** cr_candidate, cr_jobrequisition
- **Needs caching:** true
- **Key Features:** Candidate grid with Candidate (opens the record), Requisition, Application status badge, Interview score and Recruiter columns; every column sorts; candidate count in the header
- **Components:** Fluent UI V9 — DataGrid (createTableColumn, sortable, resizableColumns + columnSizingOptions), Badge, Link, Spinner, MessageBar, Text, Caption1; icon PeopleTeamRegular (unsized, verified)
- **Layout:** Flex-column root; header with title and count; the grid fills the remaining height and scrolls on its own
- **Data Binding:** queryTable("cr_candidate") selecting cr_candidateid, cr_name, cr_applicationstatus, cr_interviewscore, cr_recruiter, _cr_jobrequisition_value; results read via .rows; the requisition title read from the _cr_jobrequisition_value FormattedValue annotation and the status label from the cr_applicationstatus FormattedValue annotation; single batched setData; window cache + in-flight de-dupe keyed by page (`__ppJobCandidates_…`), readiness-gated effect deps
- **Interactions:** Column headers sort; the candidate name opens the record with Xrm.Navigation.navigateTo (pageType "entityrecord")
