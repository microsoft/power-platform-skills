# Entity Creation Log

## Environment
- URL: https://contoso.crm.dynamics.com
- Solution: ContosoProjects
- Publisher Prefix: cr

## Created Tables

### Project
- Schema Name: cr_Project
- Resolved Full Name: cr_project
- Metadata ID: n/a (SDK does not surface metadata ids)

### Milestone
- Schema Name: cr_Milestone
- Resolved Full Name: cr_milestone
- Metadata ID: n/a (SDK does not surface metadata ids)

## Created Columns

| Table | Display Name | Schema Name | Resolved Full Name | Metadata ID |
|-------|--------------|-------------|--------------------|-------------|
| cr_project | Project Manager | cr_Manager | cr_manager | n/a |
| cr_project | Start Date | cr_StartDate | cr_startdate | n/a |
| cr_project | Target Date | cr_TargetDate | cr_targetdate | n/a |
| cr_project | Budget | cr_Budget | cr_budget | n/a |
| cr_project | Status | cr_Status | cr_status | n/a |
| cr_milestone | Due Date | cr_DueDate | cr_duedate | n/a |
| cr_milestone | Percent Complete | cr_PercentComplete | cr_percentcomplete | n/a |
| cr_milestone | Status | cr_Status | cr_status | n/a |

## Created Relationships

| Type | From | To | Lookup Schema Name | Resolved Full Name |
|------|------|-----|--------------------|-------------------|
| 1:N  | cr_project | cr_milestone | cr_Project | cr_project |

- Relationship Schema Name: cr_project_cr_milestone
- Order: cr_project → cr_milestone → relationship (handled by provision-entities.js)

## Commands

```powershell
node "${PLUGIN_ROOT}/scripts/check-auth.js" --env "$ENV_URL" --require-pac  # ok: true, identitiesMatch: true
node "${PLUGIN_ROOT}/scripts/provision-entities.js" --env "$ENV_URL" --input @D:/work/project-tracker/provision-input.json --apply
node "${PLUGIN_ROOT}/scripts/provision-entities.js" --env "$ENV_URL" --input @D:/work/project-tracker/provision-input.json --apply --sample-data
```

## Sample Data

The user confirmed sample data ("Yes, add sample data"), which the prompt had asked for. Rows were
seeded by the `--sample-data` run above; each milestone binds its parent project with
`"$parent": { "entity": "cr_Project", "match": { "cr_name": "<project name>" } }`, so the SDK created
the projects first and wired every `cr_project` lookup to the matching row.

| Table | Records |
|-------|---------|
| cr_project | 4 |
| cr_milestone | 12 |

### Created Record IDs (cr_project)

- 44444444-0000-4000-8000-000000000001 — Contoso Website Redesign (Active; Avery Chen; 2026-07-06 → 2026-12-18; 185,000)
- 44444444-0000-4000-8000-000000000002 — Warehouse Scanner Rollout (On Hold; Priya Natarajan; 2026-08-03 → 2027-02-26; 92,000)
- 44444444-0000-4000-8000-000000000003 — Customer Portal Migration (Planning; Diego Ramirez; 2026-10-19 → 2027-04-30; 240,000)
- 44444444-0000-4000-8000-000000000004 — Q3 Sales Enablement Program (Completed; Hannah Okafor; 2026-06-01 → 2026-09-30; 38,500)

### Created Record IDs (cr_milestone)

- 55555555-0000-4000-8000-000000000001 — Discovery and stakeholder interviews → Contoso Website Redesign (Completed, 100%, due 2026-07-31)
- 55555555-0000-4000-8000-000000000002 — Design system and wireframes approved → Contoso Website Redesign (Completed, 100%, due 2026-09-25)
- 55555555-0000-4000-8000-000000000003 — Content migration complete → Contoso Website Redesign (In Progress, 45%, due 2026-11-13)
- 55555555-0000-4000-8000-000000000004 — Launch and DNS cutover → Contoso Website Redesign (Not Started, 0%, due 2026-12-18)
- 55555555-0000-4000-8000-000000000005 — Pilot at Redmond distribution center → Warehouse Scanner Rollout (Completed, 100%, due 2026-09-11)
- 55555555-0000-4000-8000-000000000006 — Handheld device procurement → Warehouse Scanner Rollout (Blocked, 70%, due 2026-10-02)
- 55555555-0000-4000-8000-000000000007 — Regional rollout wave 1 → Warehouse Scanner Rollout (In Progress, 10%, due 2026-12-04)
- 55555555-0000-4000-8000-000000000008 — Requirements sign-off → Customer Portal Migration (In Progress, 20%, due 2026-11-06)
- 55555555-0000-4000-8000-000000000009 — Identity provider integration → Customer Portal Migration (Not Started, 0%, due 2027-01-22)
- 55555555-0000-4000-8000-000000000010 — Curriculum finalized → Q3 Sales Enablement Program (Completed, 100%, due 2026-06-26)
- 55555555-0000-4000-8000-000000000011 — Regional workshops delivered → Q3 Sales Enablement Program (Completed, 100%, due 2026-09-18)
- 55555555-0000-4000-8000-000000000012 — Certification results published → Q3 Sales Enablement Program (Completed, 100%, due 2026-09-30)
