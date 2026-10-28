# Entity Creation Log

## Environment
- URL: https://contoso.crm.dynamics.com
- Solution: ContosoRecruiting
- Publisher Prefix: cr

## Created Tables

### Job Requisition
- Schema Name: cr_JobRequisition
- Resolved Full Name: cr_jobrequisition
- Metadata ID: n/a (SDK does not surface metadata ids)

### Candidate
- Schema Name: cr_Candidate
- Resolved Full Name: cr_candidate
- Metadata ID: n/a (SDK does not surface metadata ids)

## Created Columns

| Table | Display Name | Schema Name | Resolved Full Name | Metadata ID |
|-------|--------------|-------------|--------------------|-------------|
| cr_jobrequisition | Department | cr_Department | cr_department | n/a |
| cr_jobrequisition | Openings | cr_Openings | cr_openings | n/a |
| cr_candidate | Interview Score | cr_InterviewScore | cr_interviewscore | n/a |
| cr_candidate | Recruiter | cr_Recruiter | cr_recruiter | n/a |
| cr_candidate | Application Status | cr_ApplicationStatus | cr_applicationstatus | n/a |

## Created Relationships

| Type | From | To | Lookup Schema Name | Resolved Full Name |
|------|------|-----|--------------------|-------------------|
| 1:N  | cr_jobrequisition | cr_candidate | cr_JobRequisition | cr_jobrequisition |

- Relationship Schema Name: cr_jobrequisition_cr_candidate
- Order: cr_jobrequisition → cr_candidate → relationship (handled by provision-entities.js)

## Commands

```powershell
node "${PLUGIN_ROOT}/scripts/check-auth.js" --env "$ENV_URL" --require-pac  # ok: true, identitiesMatch: true
node "${PLUGIN_ROOT}/scripts/provision-entities.js" --env "$ENV_URL" --input @D:/work/job-candidates/provision-input.json --apply
node "${PLUGIN_ROOT}/scripts/provision-entities.js" --env "$ENV_URL" --input @D:/work/job-candidates/provision-input.json --apply --sample-data
```

## Sample Data

The user confirmed sample data ("Yes, add sample data"). Rows were seeded by the `--sample-data` run
above; each candidate binds the requisition it applied for with
`"$parent": { "entity": "cr_JobRequisition", "match": { "cr_name": "<job title>" } }`, so the SDK
created the requisitions first and wired every `cr_jobrequisition` lookup to the matching row.

| Table | Records |
|-------|---------|
| cr_jobrequisition | 3 |
| cr_candidate | 8 |

### Created Record IDs (cr_jobrequisition)

- 44444444-0000-4000-8000-000000000101 — Senior Backend Engineer (Engineering; 2 openings)
- 44444444-0000-4000-8000-000000000102 — Product Designer (Design; 1 opening)
- 44444444-0000-4000-8000-000000000103 — Customer Success Manager (Customer Success; 3 openings)

### Created Record IDs (cr_candidate)

- 55555555-0000-4000-8000-000000000101 — Maya Thompson → Senior Backend Engineer (Offer; score 88; recruiter Jordan Lee)
- 55555555-0000-4000-8000-000000000102 — Ethan Brooks → Senior Backend Engineer (Interviewing; score 74; recruiter Jordan Lee)
- 55555555-0000-4000-8000-000000000103 — Sofia Alvarez → Senior Backend Engineer (Screening; not interviewed yet; recruiter Jordan Lee)
- 55555555-0000-4000-8000-000000000104 — Liam O'Connor → Product Designer (Hired; score 91; recruiter Priya Natarajan)
- 55555555-0000-4000-8000-000000000105 — Aiko Tanaka → Product Designer (Rejected; score 62; recruiter Priya Natarajan)
- 55555555-0000-4000-8000-000000000106 — Noah Williams → Customer Success Manager (Applied; not interviewed yet; recruiter Hannah Okafor)
- 55555555-0000-4000-8000-000000000107 — Grace Kim → Customer Success Manager (Interviewing; score 79; recruiter Hannah Okafor)
- 55555555-0000-4000-8000-000000000108 — Omar Haddad → Customer Success Manager (Screening; not interviewed yet; recruiter Hannah Okafor)
