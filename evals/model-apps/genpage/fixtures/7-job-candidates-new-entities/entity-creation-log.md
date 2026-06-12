# Entity Creation Log

## Environment
- URL: https://aurorabapenv4ab3f.crm10.dynamics.com/
- Solution: Default
- Publisher Prefix: cr

## Created Tables

### Job Requisition
- Schema Name: cr_JobRequisition
- Resolved Full Name: cr_jobrequisition
- Metadata ID: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee

### Candidate
- Schema Name: cr_Candidate
- Resolved Full Name: cr_candidate
- Metadata ID: 11111111-2222-3333-4444-555555555555

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
node create-table.js https://... cr_JobRequisition "Job Requisition" "Job Requisitions" --primary-name "Title" --primary-name-logical cr_title --solution Default
node add-column.js https://... cr_jobrequisition cr_Department "Department" string --max-length 100 --required-level ApplicationRequired --solution Default
node add-column.js https://... cr_jobrequisition cr_Openings "Openings" integer --min 0 --max 1000 --required-level ApplicationRequired --solution Default
node create-table.js https://... cr_Candidate "Candidate" "Candidates" --primary-name "Name" --primary-name-logical cr_name --solution Default
node add-column.js https://... cr_candidate cr_Status "Status" picklist --options "[{\"value\":100000000,\"label\":\"Applied\"},...]" --required-level ApplicationRequired --solution Default
node add-column.js https://... cr_candidate cr_InterviewScore "Interview Score" integer --min 0 --max 100 --solution Default
node add-column.js https://... cr_candidate cr_Recruiter "Recruiter" string --max-length 100 --solution Default
node create-relationship.js https://... 1n --from cr_jobrequisition --to cr_candidate --lookup cr_JobRequisition "Job Requisition" --solution Default
node create-record.js https://... cr_jobrequisition '[...2 records...]' --solution Default
node create-record.js https://... cr_candidate '[...8 records...]' --solution Default
```
