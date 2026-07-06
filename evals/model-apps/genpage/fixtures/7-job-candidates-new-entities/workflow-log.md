# Workflow Log — Eval 7: Job candidates with new entities

## Phase 0 — Working directory setup
- Working directory created: `job-candidates/`
- Plugin root: `D:\Projects\power-platform-skills\plugins\model-apps`

## Phase 1 — Planner (genpage-planner agent invoked via Task)

### Prereq checks
- `node --version` → v20.11.0
- `pac help` → PAC CLI Version 2.7.3 (>= 2.7.0 verified)

### Auth check
- `pac auth list` → active profile aurora365-user1@auroratstgeo.onmicrosoft.com
- Active environment: https://aurorabapenv4ab3f.crm10.dynamics.com/ (reported to user)

### Entity discovery
- `pac model list-tables --search 'cr_candidate'` — exact logical-name match: NOT FOUND
- `pac model list-tables --search 'cr_jobrequisition'` — exact logical-name match: NOT FOUND

### Discovery questions (AskUserQuestion)
- Question 1 (new or edit): user answered "Create new page(s)"
- Question 2 (data source): user answered "Dataverse entities: cr_candidate, cr_jobrequisition (new entities to create)"
- Question 3 (specific requirements): "Candidate list with status, interview scores, assigned recruiter"
- Question 4 (sample data): user answered "Yes, add sample data"
- Question 5 (app selection): user selected existing app "Recruitment Hub"

### Solution selection
- Build needs metadata work (new entities) → solution selection question asked
- AskUserQuestion solution selection question presented
- `node dataverse-request.js https://aurorabapenv4ab3f.crm10.dynamics.com /solutions` to enumerate existing solutions
- dominant prefix detection: env shows mixed prefixes — no dominant prefix flagged
- User selected: "Use Default Solution"
- Recorded in plan: `Solution: Default`, `Publisher Prefix: cr`

### Plan presented
- EnterPlanMode called; user approved plan

### Plan written
- genpage-plan.md written; conforms to references/plan-schema.md
- ## Entity Creation Required has 2 entities with suffix-only names (jobrequisition, candidate)

## Phase 2a — Pre-flight auth check
- node ${CLAUDE_PLUGIN_ROOT}/scripts/check-auth.js → returned `{ ok: true, ... }`
- Identity match between pac and az verified

## Phase 2b — Entity Builder (genpage-entity-builder agent invoked via Task)
- Reads Solution=Default, Publisher Prefix=cr from plan ## Environment
- Wrote job-candidates/provision-input.json with:
  - Tables: cr_jobrequisition (columns: cr_title/primary, cr_department/string, cr_openings/integer), cr_candidate (columns: cr_name/primary, cr_status/picklist, cr_interviewscore/integer, cr_recruiter/string)
  - Relationship: 1:N from cr_jobrequisition to cr_candidate (lookup: cr_jobrequisition)
  - Sample data: 2 cr_jobrequisition records, 8 cr_candidate records (parent binding via $parent/match)
  - Solution: Default (embedded in JSON)
- node ${CLAUDE_PLUGIN_ROOT}/scripts/provision-entities.js --env https://aurorabapenv4ab3f.crm10.dynamics.com --input @job-candidates/provision-input.json --apply --sample-data
- SDK handles table ordering and metadata propagation
- Transaction log written to job-candidates/entity-creation-log.md

## Phase 3 — App creation
- SKIPPED (existing app "Recruitment Hub" selected)

## Phase 4 — Schema generation
- pac model genpage generate-types --data-sources 'cr_candidate,cr_jobrequisition' --output-file job-candidates/RuntimeTypes.ts

## Phase 5b — Single-page fast path
- Plan has 1 page → fast path taken (inlined build, no Task subagent dispatched)
- Data mode: dataverse
- Read sample: plugins/model-apps/samples/9-list-with-caching.tsx (Dataverse list + window cache)
- Read ${CLAUDE_PLUGIN_ROOT}/references/verified-icons.txt
- Wrote page.tsx
- Post-write icon verification: grep `from "@fluentui/react-icons"` in page.tsx; verified `PeopleRegular`, `BriefcaseRegular` against verified-icons.txt — all present

## Phase 6 — Deployment
- pac model genpage upload --app-id 33333333-2222-3333-4444-555555555555 --code-file job-candidates/page.tsx --data-sources 'cr_candidate,cr_jobrequisition' --prompt "Build a page showing all job candidates with their application status, interview scores, and assigned recruiter. I need new tables for this — cr_candidate and cr_jobrequisition entities don't exist yet in my environment." --model claude-sonnet --name "Candidates" --agent-message "Candidate list with status, scores, and recruiter assignments" --add-to-sitemap
- Upload succeeded

## Phase 8 — Summary
- 1 page deployed: page.tsx → "Candidates" in Recruitment Hub
- 2 entities created: cr_jobrequisition, cr_candidate
- 1 lookup: cr_candidate → cr_jobrequisition
- Sample data inserted (2 requisitions, 8 candidates)
