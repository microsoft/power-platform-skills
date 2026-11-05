# Workflow Log — Eval 26: Customer opportunities with normalized lookups (create flow)

Synthetic trace constructed from the current `/genpage` SKILL.md, not a captured agent run.
Every command below has an ordered result in `tool-results.json`; the semantic question and
the plan approval are also recorded, in order, in `semantic-interactions.json`. Commands run
from the working directory, so file arguments are relative to it.

## Phase 0 — Working directory
- `$ARGUMENTS`: "Build a Customer Opportunities page for our existing opportunities."
- Working directory created: `mkdir -p 'customer-opportunities'` (kebab-case from "Customer Opportunities")
- Resolved working directory: D:/work/customer-opportunities
- Plugin root: D:/repo/plugins/model-apps

## Phase 0.5 — Local-dev manifest
- Command: `node 'D:/repo/plugins/model-apps/scripts/generate-page-manifest.js' 'D:/work/customer-opportunities' 'customer-opportunities'`
- Result: exit 0; package.json and genpage.d.ts written; no `--features` (no charts or date/time pickers needed)

## Phase 1 — Plan

### Interaction mode
- Command: `node 'D:/repo/plugins/model-apps/scripts/resolve-interaction-mode.js'`
- Result: `{"ok":true,"interactive":true,"reason":"default (attended)"}` — attended run, every gate asked in this loop

### Prereq checks (run separately, not chained)
- `node --version` → v20.20.2
- `pac help` → Microsoft PowerPlatform CLI Version: 2.11.0 (> 2.10.0 verified)

### Auth
- `pac auth list` → one profile, currently active: maker@contoso.onmicrosoft.com
- Active environment reported to the user: https://contoso.crm.dynamics.com/

### Create or edit
- AskUserQuestion: Do you want to create new page(s) or edit an existing page? → Create new page(s)

### Requirements
- AskUserQuestion: Where should the page get its data? → Dataverse entity: opportunity
- AskUserQuestion: Any specific requirements for the page? → Open the customer's record, change the customer, and show the opportunities for this account

### Discovery (genpage-planner dispatched via Task as a headless worker)
- Dispatched `Task genpage-planner` with the requirements, working directory, plugin root, create/edit decision = create, `No connector bindings.` (connectors.json: none — omit --connectors) and `No custom API bindings.`
- Planner ran `node 'D:/repo/plugins/model-apps/scripts/list-languages.js' --env 'https://contoso.crm.dynamics.com'` → English (1033) only, no RTL language
- Planner ran `node 'D:/repo/plugins/model-apps/scripts/list-tables.js' --env 'https://contoso.crm.dynamics.com' --search 'opportunity' --exact` → 1 table: `opportunity` (exact logical-name match, nothing in `missing`); no entity creation
- Planner ran `node 'D:/repo/plugins/model-apps/scripts/get-lookup-metadata.js' --env 'https://contoso.crm.dynamics.com' --tables 'opportunity'` → exit 0; saved verbatim as D:/work/customer-opportunities/lookup-metadata.json: `customerid` targets account and contact, with the concrete paths customerid_account/accountid and customerid_contact/contactid; `parentaccountid` targets account; `parentcontactid` targets contact; `ownerid` targets systemuser and team through a shared path only
- Planner ran `node 'D:/repo/plugins/model-apps/scripts/apps.js' list --env 'https://contoso.crm.dynamics.com'` → 2 apps: Sales Hub (11111111-2222-3333-4444-555555555555), Customer Service Hub (44444444-5555-6666-7777-888888888888)
- Data semantics (planner Step 4, "Resolve Data Semantics"): "the opportunities for this account" can mean the parent account, the direct customer, or the customer plus its contacts — three metadata-backed candidates, so the planner asked instead of assuming, with no default; it reserved A1 for the answer and wrote no settled assumption
- Planner returned `{ "action": "needs_input" }` with two questions: `opportunities-account-scope` (Parent account; Direct customer; Customer plus contacts — no default) and `app`

### Questions (asked here; the planner cannot prompt)
- AskUserQuestion: Which opportunities should this account show? → Direct customer
- AskUserQuestion: Which app should the page be added to? (options from `apps.js list`: Sales Hub — 11111111-2222-3333-4444-555555555555; Customer Service Hub — 44444444-5555-6666-7777-888888888888; Create a new app) → Sales Hub (existing app)
- Re-invoked `Task genpage-planner` with both answers by question id (`opportunities-account-scope` → Direct customer; `app` → Sales Hub), D:/work/customer-opportunities/lookup-metadata.json and everything it returned before; it settled A1 as user-confirmed (Question opportunities-account-scope, Answer Direct customer) and recorded three planner defaults (A2 — order, size and caching; A3 — search scope; A4 — customer choices)

### Solution selection
- Code-only build (no new entities, existing app) → solution selection question SKIPPED
- Defaults written to the plan: `Solution: Default`, `Publisher Prefix: new`

### Plan approval
- The planner returned the proposed plan (1 page: Customer Opportunities on opportunity), its `### Assumptions` first
- EnterPlanMode called — presented the proposed plan: Assumptions A1–A4 first, then the page list, the Data Semantics (R1, R2, F1, F2, F3) and the Lookup Metadata (opportunity.customerid, observed, targets account and contact)
- ExitPlanMode → user approved the plan without changes
- Command: `node 'D:/repo/plugins/model-apps/scripts/genpage-plan-provenance.js' prepare --plan 'D:/work/customer-opportunities/genpage-plan.md'`
- Result: `"ok":true`, nothing to quarantine (first run in this folder)
- Saved the approved plan body verbatim to D:/work/customer-opportunities/.approved-genpage-plan.md (kept here as approved-plan.md)
- Re-invoked `Task genpage-planner` with the approval outcome, the approved plan body, both answers and all prior discovery; it wrote genpage-plan.md (conforms to references/plan-schema.md, with the same Assumptions and per-page records, and User Requirements exactly the original request)
- Command: `node 'D:/repo/plugins/model-apps/scripts/genpage-plan-provenance.js' verify --plan 'D:/work/customer-opportunities/genpage-plan.md' --approved '@D:/work/customer-opportunities/.approved-genpage-plan.md' --require-assumptions`
- Result: `"ok":true`, kind create, targets [customer-lookup.tsx], writtenHash 96ba32971bfd7409cf3580b00d1018755f47f85466b19643f3fe8dcf3382cd35, semanticsHash 7c0546b925ec9a8d70a0aa883197403116b8214a708a795ba33e6a84fabb1c97

## Phase 2 — Entities
- SKIPPED: `## Entity Creation Required` is the no-entity sentinel (opportunity exists)
- check-auth.js and genpage-entity-builder were not invoked (no metadata work)
- Phase 2c SKIPPED: the plan's one lookup (opportunity.customerid) is already `observed` — no planned lookup to reconcile

## Phase 3 — App
- SKIPPED app creation: existing app Sales Hub (11111111-2222-3333-4444-555555555555) selected

## Phase 4 — RuntimeTypes
- `node 'D:/repo/plugins/model-apps/scripts/genpage.js' types --env 'https://contoso.crm.dynamics.com' --data-sources 'opportunity' --output-file 'D:/work/customer-opportunities/RuntimeTypes.ts'`
- Read RuntimeTypes.ts: verified opportunityid and name, and `_customerid_value` typed `/account(…)` | `/contact(…)` — the same two targets as the plan's lookup record

## Phase 4.5 — Connector bindings
- SKIPPED: plan says `No connector bindings.` → Connectors: none; no connectors.json, no `--connectors`

## Phase 4.6 — Custom API bindings
- The plan's `## Custom API Bindings` body is exactly `No custom API bindings.` → no Custom API rows

## Phase 4.6b — Built-in Dataverse operations
- SKIPPED: the plan has no `## Dataverse Operations` section

## Phase 4.6c — The actions file
- The desired array is empty: no actions.json, and the create passes no `--actions`

## Phase 4.7 — Page telemetry
- Command: `node 'D:/repo/plugins/model-apps/scripts/lib/feature-flags.js' custom-telemetry`
- Result: `disabled` → Telemetry: disabled; the page contains no telemetry calls

## Phase 5a — Plan validation
- One page row with a matching `### Customer Opportunities` subsection
- Command: `node 'D:/repo/plugins/model-apps/scripts/check-page-files.js' --plan 'D:/work/customer-opportunities/genpage-plan.md'`
- Result: `"ok":true` — customer-lookup.tsx is a safe, unique page file
- Every relationship and filter of the page traces to User Requirements or an assumption: R1 and F1 → A1; R2 and F3 → quoted requirements; F2 → A3 (with its quote)
- The plan records a lookup, so every lookup must be observed and match the saved metadata read before the page is generated:
- Command: `node 'D:/repo/plugins/model-apps/scripts/genpage-plan-provenance.js' verify --plan 'D:/work/customer-opportunities/genpage-plan.md' --approved '@D:/work/customer-opportunities/.approved-genpage-plan.md' --require-assumptions --require-observed-lookups --lookup-metadata 'D:/work/customer-opportunities/lookup-metadata.json'`
- Result: `"ok":true`, semanticsHash 7c0546b925ec9a8d70a0aa883197403116b8214a708a795ba33e6a84fabb1c97 (unchanged since approval)

## Phase 5b — Single-page fast path
- Plan has 1 page → inlined the page-builder workflow (no Task dispatch for the page)
- Data mode: dataverse; Connectors: none; Telemetry: disabled
- Read D:/repo/plugins/model-apps/references/rules.md, including Critical Rules 22 and 23, "Missing Error Handling" and "Lookup references"
- Read samples 9-list-with-caching.tsx and 3-account-crud-dataverse.tsx (from `## Relevant Samples`)
- Needs caching: true → read references/data-caching.md
- Languages: English only → localization.md not needed
- Read genpage-plan.md (its Data semantics and Lookup metadata), lookup-metadata.json and RuntimeTypes.ts
- Command: `node 'D:/repo/plugins/model-apps/scripts/genpage-worker-output.js' --stamp --file 'D:/work/customer-opportunities/customer-lookup.tsx'`
- Result: `"ok":true`, stamp recorded, no earlier file at the target
- Wrote customer-lookup.tsx with the file tool: the page error block and the lookup normalizer of rules.md copied unchanged, PageBody inside PageErrorBoundary; the list read (`_customerid_value ne null`) through the window cache and in-flight de-dupe, its rejection reported from the consumer's catch with a retry; every customer normalized with the complete targets account and contact before it is shown as openable, filtered by or offered; the account view only for an account customer, through customerid_account/accountid with the bare id, awaited with a stale-request guard and reported as a read; Open customer with the reference's own table, a rejection reported as a read; Change customer from a picker keyed by table and id, written as the chosen table's qualified value, a failure reported as a write with no retry
- Icon verification: Grep for `from "@fluentui/react-icons"` → one named import, OpenRegular; Grep of references/verified-icons.txt for `^OpenRegular$` → present
- Grep `['"]?borderWidth['"]?\s*:` → no matches
- Command: `node 'D:/repo/plugins/model-apps/scripts/genpage-worker-output.js' --file 'D:/work/customer-opportunities/customer-lookup.tsx'`
- Result: `"ok":true`, problems [] — complete page accepted

## Phase 6 — Deploy
- Checked prompt.txt, agent-message.txt and page-name.txt in the working directory: none existed, none is a link
- Wrote prompt.txt (the full `## User Requirements` body), agent-message.txt and page-name.txt ("Customer Opportunities") with the file tool
- Command: `node 'D:/repo/plugins/model-apps/scripts/genpage-upload.js' --env 'https://contoso.crm.dynamics.com' --app-id '11111111-2222-3333-4444-555555555555' --code-file 'customer-lookup.tsx' --name-file 'page-name.txt' --data-sources 'opportunity' --prompt-file 'prompt.txt' --model 'claude-sonnet-4-6' --agent-message-file 'agent-message.txt' --add-to-sitemap`
- Prompt scope: full page description from the plan's `## User Requirements` (create)
- Result: page-id = cccccccc-dddd-eeee-ffff-000000000026, status = success (`updated: false`, added to the Sales Hub sitemap)

## Phase 6.5 — Navigation fix-up
- SKIPPED: single page, no PAGEREF_ placeholders

## Phase 7 — Verify in browser
- AskUserQuestion: Would you like to verify the page(s) in the browser using Playwright? → Skip verification

## Phase 8 — Summary

| Page | File | Entities | Status |
|------|------|----------|--------|
| Customer Opportunities | customer-lookup.tsx | opportunity | Deployed |

- App: Sales Hub (11111111-2222-3333-4444-555555555555)
- Page ID: cccccccc-dddd-eeee-ffff-000000000026
- Entities created: none
- Lookups: opportunity.customerid (account, contact), observed
- Browser verification: skipped
