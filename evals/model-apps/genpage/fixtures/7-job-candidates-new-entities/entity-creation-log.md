# Entity Creation Log

## Environment
- URL: https://aurorabapenv4ab3f.crm10.dynamics.com/
- Solution: Default
- Publisher Prefix: cr

## Created Tables

### Job Requisition
- Schema Name: cr_JobRequisition
- Resolved Full Name: cr_jobrequisition
- Metadata ID: n/a

### Candidate
- Schema Name: cr_Candidate
- Resolved Full Name: cr_candidate
- Metadata ID: n/a

## Created Columns

| Table | Display Name | Schema Name | Resolved Full Name | Metadata ID |
|-------|--------------|-------------|--------------------|-------------|
| cr_jobrequisition | Department | cr_Department | cr_department | ... |
| cr_jobrequisition | Openings | cr_Openings | cr_openings | ... |
| cr_candidate | Status | cr_Status | cr_status | ... |
| cr_candidate | Interview Score | cr_InterviewScore | cr_interviewscore | ... |
| cr_candidate | Recruiter | cr_Recruiter | cr_recruiter | ... |

## Created Relationships

| Type | From | To | Lookup Schema Name | Resolved Full Name |
|------|------|-----|--------------------|--------------------|
| 1:N  | cr_jobrequisition | cr_candidate | cr_JobRequisition | cr_jobrequisition |

## Commands

```powershell
node check-auth.js  # ok: true
node provision-entities.js --env https://aurorabapenv4ab3f.crm10.dynamics.com --input @job-candidates/provision-input.json --apply --sample-data
```
