---
name: setup-solution
description: >-
  Creates a Dataverse publisher and solution, then adds Power Pages site components to
  the solution for ALM and deployment management. Use when asked to: "create solution",
  "set up solution", "add to solution", "package site into solution", "create publisher",
  "solutionize my site", or "set up ALM for my site".
user-invocable: true
argument-hint: "Optional: solution unique name (e.g., 'ContosoSite')"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_search, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_fetch
model: opus
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# setup-solution

Creates a Dataverse publisher and solution, then adds Power Pages site components. Writes `.solution-manifest.json` for use by `export-solution`, `import-solution`, and `setup-pipeline` skills.

## Prerequisites

- PAC CLI installed and authenticated (`pac env who` returns an environment URL)
- Azure CLI installed and logged in (`az account show` succeeds)
- `powerpages.config.json` exists in the project root (site must be deployed at least once so `.powerpages-site/` exists with component records)

## Phases

### Phase 0 — ALM plan gate

> **`plan-alm` is the front door.** When the user expresses an ALM intent (*promote / ship / deploy / set up CI-CD / move to staging / push to prod*), the orchestrator (`/power-pages:plan-alm`) should run first. This Phase 0 enforces that and is meant to fail closed when there's no plan, not to be a one-time check the user can dismiss forever.

**Skip rule.** If this skill was invoked *as part of an active `plan-alm` orchestration*, skip Phase 0 entirely and proceed to Phase 1. The gate helper exposes this via its `inExecution` block — pass through silently to Phase 1 when:

```
inExecution.status === "active"
```

The helper computes this from `docs/.alm-plan-data.json` — `PLAN_STATUS === "In Execution"` AND `LAST_INVOCATION_AT` within the last 60 minutes. `check-alm-plan.js` refreshes `LAST_INVOCATION_AT` automatically on every invocation that finds the plan in execution, so each in-chain skill keeps the chain alive for the next one — even multi-hour deploys (deploy-pipeline alone can take 60 min per stage) survive the window without the chain incorrectly de-classifying. Stalled chains (no heartbeat for > 60 min) reclassify as `stale-heartbeat` and Phase 0 gates fire normally so an abandoned plan doesn't silently bypass user confirmation.

When `inExecution.status` is anything other than `"active"` (`"not-running"`, `"stale-heartbeat"`, `"no-plan"`), run the Phase 0 gate flow below. Branch on the remaining helper fields:

**Step 1 — Run the gate helper.**

```bash
node "${PLUGIN_ROOT}/scripts/lib/check-alm-plan.js" --projectRoot "."
```

The helper returns JSON with `{ exists, deferred, stale, staleness: { reason, detail }, generatedAt, planStatus, ... }`. Sync mode (when `.solution-manifest.json` already exists) may additionally pass `--envUrl`, `--token`, `--solutionId` once Phase 1 has acquired them, but for the initial gate the existence-only check is sufficient.

**Step 2 — Branch on the result.**

| Result | Behavior |
|---|---|
| `deferred: true` | The user has explicitly deferred ALM for this project (`.alm-deferred` marker present). Pass through silently to Phase 1 — do not nag. |
| `exists: false` | The user hasn't run `plan-alm` yet. See Step 3. |
| `exists: true, stale: false` | Plan is current. Pass through silently to Phase 1. |
| `exists: true, stale: true` (reason: `solution-modified`) | The solution changed after the plan was generated. See Step 4. |

**Step 3 — No plan.** Tell the user:

> "No ALM plan exists for this project. `/power-pages:plan-alm` builds one — it detects the project state, asks about your promotion strategy (PP Pipelines vs Manual export/import), and orchestrates the right skills (including this one) in the right order. Want me to run plan-alm now?"

<!-- gate: setup-solution:0.no-plan | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · setup-solution:0.no-plan):** Fail-closed entry gate when `check-alm-plan.js` returns `exists:false`. Helper-script-backed.

`AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Run `/power-pages:plan-alm` first? | ALM plan gate | Yes — run /power-pages:plan-alm now (Recommended), Continue without a plan (advanced — I know what I'm doing), Cancel |

- **Yes (Recommended)** → invoke `/power-pages:plan-alm`. It builds the plan and returns — `plan-alm` is a planner and does not deploy. This skill then re-runs the Phase 0 check (now `exists:true`) and proceeds to Phase 1.
- **Continue without a plan** → set `BYPASSED_PLAN_GATE = true` and proceed to Phase 1.
- **Cancel** → exit cleanly.

**Step 4 — Stale plan.** Tell the user:

> "ALM plan exists from `{generatedAt}` but the source solution has been modified since (at `{solution.modifiedon}`). Components may have changed. Re-running `plan-alm` will refresh the analysis and the rendered HTML."

<!-- gate: setup-solution:0.stale-plan | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · setup-solution:0.stale-plan):** Fail-closed entry gate when `check-alm-plan.js` returns `stale:true`. Helper-script-backed.

`AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Refresh the plan first? | ALM plan freshness | Refresh — re-run /power-pages:plan-alm (Recommended), Continue with the existing plan, Cancel |

- **Refresh (Recommended)** → invoke `/power-pages:plan-alm`. After completion, re-run the Phase 0 helper once to confirm freshness; if still stale, surface the detail and proceed to Phase 1 anyway (don't infinite-loop).
- **Continue** → set `STALE_PLAN_ACK = true` and proceed to Phase 1.
- **Cancel** → exit cleanly.

**Why this gate exists.** Direct invocation of `setup-solution` builds (or syncs) a solution without consulting the orchestrator's plan. If a plan already exists and recommends a multi-solution split, running this skill standalone may consolidate components into the wrong base solution. If no plan exists yet, `plan-alm` would have surfaced split recommendations, the asset-size advisory, and missing-component gaps before any solution was created — running `setup-solution` first burns through those decisions silently. The gate ensures `setup-solution` runs in the right context, while still leaving an explicit bypass for users who genuinely know they want a one-off solution.

### Phase 1 — Verify Prerequisites

**Create all tasks upfront at the start of this phase.**

Tasks to create:
1. "Verify prerequisites"
2. "Gather solution configuration"
3. "Check existing publishers and solutions"
4. "Create publisher and solution"
5. "Add site components to solution"
6. "Verify and write manifest"
7. "Present summary"

Steps:
1. Run `pac env who` — extract `environmentUrl`, `organizationId` (shown to user for confirmation)
2. Run `verify-alm-prerequisites.js` to confirm PAC CLI auth, acquire a token, and verify API access:
   ```bash
   node "${PLUGIN_ROOT}/scripts/lib/verify-alm-prerequisites.js" --envUrl "{environmentUrl}"
   ```
   Capture output as JSON; extract `.envUrl` (store as `envUrl`) and `.token` (store as `token`). If the script exits non-zero, stop and explain what is missing (reference `${PLUGIN_ROOT}/references/dataverse-prerequisites.md`).
3. Locate `powerpages.config.json` — read `siteName` and `websiteRecordId`
4. Confirm `.powerpages-site/` folder exists (required to find component records)
5. **Check for ALM plan context** — look for `docs/alm/alm-plan-context.json`:
   <!-- gate: setup-solution:1.preloaded | category=plan | cancel-leaves=nothing -->
   > 🚦 **Gate (plan · setup-solution:1.preloaded):** Use pre-loaded plan classifications, or re-discover. No write happens before this choice.

   - If found, ask via `AskUserQuestion`:
     > "An ALM plan was previously generated for this site. It includes a pre-classified list of site settings (keepAsIs, promoteToEnvVar, authNoValue, excluded). Would you like to use those choices, or re-discover and re-classify everything now?"
   - Options: **"Use pre-loaded choices from plan"** / **"Re-discover and re-classify"**
   - If user chooses pre-loaded: read `docs/alm/alm-plan-context.json`, store the `siteSettings` object as `preloadedSettings`. When Step 5.3 is reached, **skip the query and classification logic** — use `preloadedSettings` directly.
   - If user chooses re-discover: proceed normally (Steps 5.3–5.4 query Dataverse and reclassify).
6. **Detect sync mode** — check whether `.solution-manifest.json` exists in the project root.
   - **If present**: read it and verify the `solutionId` still exists in the target environment via `GET {envUrl}/api/data/v9.2/solutions({solutionId})?$select=solutionid,uniquename,version,ismanaged`.
     - If the solution is still present and unmanaged in this environment: set `syncMode = true` and store `existingSolution` = the manifest contents.
     <!-- gate: setup-solution:1.stale-manifest | category=consent | cancel-leaves=nothing -->
     > 🚦 **Gate (consent · setup-solution:1.stale-manifest):** Manifest references a solution missing from the current env. Start fresh (back up the manifest and create a new solution) or abort.

     - If the solution was not found, is managed, or is in a different environment: treat as a **stale manifest**, inform the user, and ask via `AskUserQuestion`:
       > "The existing `.solution-manifest.json` points to solution `{uniqueName}` v{version} which I could not find in the current environment. Would you like to: 1) Start fresh (back up the manifest and create a new solution), 2) Abort so you can investigate?"
       Proceed only after an explicit choice.
   - **If absent**: set `syncMode = false` — this is a fresh setup.
7. **Report the chosen mode** to the user:
   - `syncMode = true`: "Found existing solution `{uniqueName}` v{version}. Running in **sync mode** — I'll discover the current site inventory, diff against what's already in the solution, and only add missing components."
   - `syncMode = false`: "No existing solution manifest found. Running a **fresh setup** — I'll create a publisher and solution, then add all site components."

8. **Check for split plan (multi-solution mode)** — look for `docs/alm/alm-split-plan.json` (written by `plan-alm` Phase 1 Step 10):
   - If found and `proposedSolutions.length > 1`, set `MULTI_SOLUTION_MODE = true` and store the array as `PROPOSED_SOLUTIONS`.
   - In multi-solution mode:
     - Phase 2 asks for publisher details **once** (shared across all solutions) and presents the proposed solution names/versions for **confirmation** (user can override each before proceeding).
     - Phase 4 creates the publisher first (single serial step — every solution binds to it), then creates the solutions in `PROPOSED_SOLUTIONS` **in parallel**. The `order` field is data for downstream pipeline-stage ordering — it does NOT constrain creation order, since each solution is independent (distinct `uniqueName`, shared `publisherId`, no inter-solution dependency).
     - Phase 5 partitions `AddSolutionComponent` calls per solution based on `proposedSolutions[i].componentTypes` and `tableLogicalNames` (for Strategy 3).
     - Phase 6 writes manifest v2 (see below).
   - If not found or `proposedSolutions.length === 1`, proceed in single-solution mode (existing flow).

### Phase 1.5 — Ground in current ALM documentation

> Reference: `${PLUGIN_ROOT}/references/alm-docs-grounding.md`

Cap this step at ~30 seconds. If MCP search / fetch errors out, log a one-line note and continue — this skill must remain runnable offline.

1. Run `microsoft_docs_search` with the query: `Power Pages solution publisher creation Dataverse component types ALM`.
2. Fetch `https://learn.microsoft.com/en-us/power-platform/alm/solution-concepts-alm` (and at most one sister page if the search surfaces a relevant new tutorial — e.g. multi-solution layering, managed-properties guidance) in parallel via `microsoft_docs_fetch`.
3. Extract a one-paragraph summary of what Microsoft Learn currently says about solution components, publisher prefix immutability, managed vs unmanaged choice, and component-type integers. Compare against `${PLUGIN_ROOT}/references/solution-api-patterns.md` and flag any divergence (new component types, changed action signatures, deprecated patterns).
4. Use the summary to inform Phase 2+ decisions. Do not silently change skill behavior — surface any divergence to the user as a soft warning before Phase 4 (Create Publisher and Solution).

### Phase 2 — Gather Solution Configuration

> **Skip this entire phase when `syncMode = true`.** Use `existingSolution.publisher` and `existingSolution.solution` from the manifest instead. Jump to Phase 5.

<!-- gate: setup-solution:2.publisher-prefix | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · setup-solution:2.publisher-prefix):** Publisher prefix is PERMANENT and prefixed to every component logical name. Must be confirmed explicitly. Cancel exits before any publisher/solution write.

Ask user (via `AskUserQuestion`) for:

1. **Publisher unique name** (e.g., `contoso`) — lowercase letters/numbers only, no spaces. **Explain this is permanent and cannot be changed.**
2. **Publisher friendly name** (e.g., `Contoso`) — display name
3. **Publisher prefix** (e.g., `con`) — 2–8 lowercase letters, prefixed to all components. **Explain this is permanent and cannot be changed.**
4. **Solution unique name** (e.g., `ContosoSite`) — letters/numbers/underscores, no spaces
5. **Solution friendly name** (e.g., `Contoso Site`) — display name
6. **Solution version** (default: `1.0.0.0`) — must be `major.minor.build.revision` format

Present a confirmation summary of all values and wait for user approval before proceeding.

> **Key Decision Point**: Publisher prefix and publisher unique name are **irreversible** — pause and explicitly confirm with the user before proceeding.

### Phase 3 — Check Existing State

> **Skip this entire phase when `syncMode = true`.** The manifest guarantees the solution exists and we already validated it in Phase 1 Step 6.

Before creating anything, check if publisher and solution already exist:

1. Query publisher: `GET {envUrl}/api/data/v9.2/publishers?$filter=uniquename eq '{publisherUniqueName}'&$select=publisherid,uniquename,customizationprefix`
   (No dedicated script for publishers — query the OData endpoint directly.)
2. Check solution existence using `verify-solution-exists.js`:
   ```bash
   node "${PLUGIN_ROOT}/scripts/lib/verify-solution-exists.js" \
     --envUrl "{envUrl}" \
     --uniqueName "{solutionUniqueName}" \
     --token "{token}"
   ```
   Capture output as JSON; check `.found` (boolean). If `found`, also read `.solutionId`, `.version`, and `.isManaged` for display.

Report findings to user:
- If publisher exists: "Found existing publisher `{name}` (prefix: `{prefix}`). Will reuse it."
- If solution exists: "Found existing solution `{name}` version `{version}`. Will reuse it and add components."
- If neither exists: "Will create new publisher and solution."

Wait for user confirmation before proceeding.

### Phase 4 — Create Publisher and Solution

> **Skip this entire phase when `syncMode = true`.** The publisher and solution already exist.
>
> **Version bump in sync mode**: before any add operations in Phase 5, bump the existing solution's patch segment so the post-sync manifest and any subsequent export cleanly supersede the prior version. Use the shared helper — it is the single source of truth for the bump rule (pad-with-zero for missing segments, integer-numeric `1.0.0.9 → 1.0.0.10`, reject `1.0.0.a`, reject more-than-4 segments). The same helper is called from `export-solution` Phase 4 Step 4.0 — both skills must produce identical bumps for the same input version.
>
> ```bash
> node "${PLUGIN_ROOT}/scripts/lib/bump-solution-version.js" \
>   --envUrl "{envUrl}" \
>   --token "{token}" \
>   --solutionId "{solutionId}" \
>   --projectRoot "."
> ```
>
> Capture output as JSON; the helper returns `{ previous, next, bumped: true, manifestUpdated, manifestUpdateReason }`. Passing `--projectRoot "."` lets the helper update `.solution-manifest.json`'s `solution.version` (single-solution) or matching `solutions[].version` (multi-solution) field automatically — without it, the manifest drifts behind every bump. Update `existingSolution.solution.version` locally to `.next` so the final manifest write reflects the bump. Do this **before** Step 5.6's component adds, so the manifest stays consistent if the skill is interrupted midway. **Do not inline the PATCH** — diverging the rule between this skill and `export-solution` is exactly the bug class the helper exists to prevent.

Refer to `${PLUGIN_ROOT}/references/solution-api-patterns.md` for exact request body templates.

1. **Create publisher** (if not existing):
   - `POST {envUrl}/api/data/v9.2/publishers` with publisher body
   - Extract `publisherId` from `OData-EntityId` response header
   - On failure: report error, stop (do not proceed to solution creation)
   - This step **must complete before any solution creation** — every solution body binds `publisherid@odata.bind`. Single serial step, no parallelization.

2. **Create solution(s)**:

   **Single-solution mode** (`MULTI_SOLUTION_MODE = false`) — call `create-solution.js`. Omit `--token` so the helper refreshes via `getAuthToken(envUrl)` at call time (passing a possibly-stale cached token would surface as a 401 the helper doesn't retry):
   ```bash
   node "${PLUGIN_ROOT}/scripts/lib/create-solution.js" \
     --envUrl "{envUrl}" \
     --uniqueName "{solutionUniqueName}" \
     --friendlyName "{solutionFriendlyName}" \
     --version "{version}" \
     --publisherId "{publisherId}" \
     --description "Power Pages solution for {siteName}"
   ```
   Capture output as JSON; extract `.solutionId` (store as `solutionId`). On failure (non-zero exit or `created: false`): report error, stop.

   **Multi-solution mode** (`MULTI_SOLUTION_MODE = true`) — call `create-solutions-batch.js`, which fans out all `PROPOSED_SOLUTIONS` in parallel via `Promise.allSettled` (typical 5-6 solution splits complete in ~2s vs ~10s serial). The helper skips `isFutureBuffer: true` entries automatically (the reserved buffer is created later when the user actually adds new components) and handles 409 races idempotently via `verify-solution-exists.js`. Write the specs to a tmp JSON file, then invoke:
   ```bash
   node -e "require('fs').writeFileSync('./docs/alm/.solutions-batch.json', JSON.stringify({{PROPOSED_SOLUTIONS_AS_SPECS}}))"
   node "${PLUGIN_ROOT}/scripts/lib/create-solutions-batch.js" \
     --envUrl "{envUrl}" \
     --token "{token}" \
     --publisherId "{publisherId}" \
     --solutionsFile ./docs/alm/.solutions-batch.json
   ```
   Where `{{PROPOSED_SOLUTIONS_AS_SPECS}}` is `PROPOSED_SOLUTIONS` mapped to `{ uniqueName, friendlyName: displayName, version: "1.0.0.0", description, isFutureBuffer }` per entry (carry the `isFutureBuffer` flag through so the helper can skip it). Capture the output as JSON; build `SOLUTIONS_BY_NAME = { uniqueName → { solutionId, created } }` from `result.results` (entries with `skipped: true` are not added — `Future` buffer solutions don't exist in Dataverse yet). If `result.failed > 0`, surface the per-entry `error` strings and stop — successfully-created solutions remain in Dataverse and the user can re-run setup-solution in sync mode to recover. Delete the tmp file after the call (`./docs/alm/.solutions-batch.json`).

   Token must be fresh before the batch — `create-solutions-batch.js` refreshes once at start via `getAuthToken(envUrl)` if no `--token` is passed, so prefer omitting `--token` over passing a stale one.

3. Report: "Publisher `{name}` is ready. Created `{N}` solution(s): `{name1}`, `{name2}`, …" (single-solution mode: report just the one).

### Phase 5 — Add Site Components

Refer to `${PLUGIN_ROOT}/references/solution-api-patterns.md` for `AddSolutionComponent` body templates and `powerpagecomponents` discovery patterns.

> **Sync-mode behavior**: When `syncMode = true`, run the discovery helper with `--solutionId` populated and use the returned `missing.*` arrays as the candidate set. Everything else in this phase (dynamic component-type lookup in 5.1, categorization in 5.3, OAuth secret conversion in 5.4, env var adoption in 5.4b, **orphan ppc adoption in 5.4c**, manifest summary in 5.5, bulk add in 5.6) runs the same way, just with a pre-filtered "only things that aren't already in the solution" list. The goal of sync mode is: a user who added a server logic, bot, flow, env var, or page *after* `setup-solution` last ran can re-invoke the skill and get those components adopted without any fresh-setup prompts.
>
> **Fresh-mode behavior** (`syncMode = false`): run the full discovery as documented below — every ppc, every site language, every custom table, every publisher-prefix env var becomes a candidate for inclusion.

#### Step 5.1 — Discover Component Types Dynamically

**Do not hardcode component type numbers.** Component type codes are environment-specific metadata and vary across tenants. Always resolve them at runtime using `discover-component-types.js`.

Run `discover-component-types.js` with the website record ID plus one sample powerpagecomponent ID and one site language ID (obtained from the preliminary discovery queries in Step 5.2 below — run those first if not yet available):
```bash
node "${PLUGIN_ROOT}/scripts/lib/discover-component-types.js" \
  --envUrl "{envUrl}" \
  --token "{token}" \
  --websiteRecordId "{websiteRecordId}" \
  --powerpageComponentId "{anyPowerpageComponentId}" \
  --siteLanguageId "{siteLanguageId}"
```
Capture output as JSON; extract `.websiteComponentType`, `.subComponentType`, and `.siteLanguageComponentType`. **Use the JSON values returned by the helper exactly as-is — do not substitute "typical" values from documentation.** Observed reference values across tenants include `10426`/`10427`/`10428` and `10429`/`10428`/`10430`, but the actual values vary per environment and must come from this script's runtime query. The three sibling unified entities each have their own componenttype — site language is NOT included by `AddRequiredComponents: true` on the website and must be added explicitly. See `references/solution-api-patterns.md` for the full 3-entity model.

If the script reports the website record is not yet in any solution, stop and inform the user that the site must be deployed (via `/power-pages:deploy-site`) before it can be solutionized. If `subComponentType` is absent (no sub-components indexed yet), proceed anyway — you will discover all component IDs in Step 5.2.

#### Step 5.2 — Discover All Components

Run six discovery queries in parallel:

**A. Component type labels** (for display names):
```
GET {envUrl}/api/data/v9.2/GlobalOptionSetDefinitions(Name='powerpagecomponenttype')
```
Build a `typeLabel` map: `{ [Value]: Label.UserLocalizedLabel.Label }`. Fall back to the static table in `${PLUGIN_ROOT}/references/solution-api-patterns.md` Section 3b if this fails.

**B. All Power Pages sub-components for this site**:
```
GET {envUrl}/api/data/v9.2/powerpagecomponents
  ?$filter=_powerpagesiteid_value eq '{websiteRecordId}'
  &$select=powerpagecomponentid,name,powerpagecomponenttype
  &$orderby=powerpagecomponenttype
```
Follow `@odata.nextLink` pagination. Group by `powerpagecomponenttype` using `typeLabel` for display names.

**C. Site language records**:
```
GET {envUrl}/api/data/v9.2/powerpagesitelanguages?$filter=_powerpagesiteid_value eq '{websiteRecordId}'&$select=powerpagesitelanguageid,languagecode,displayname
```
Store all language IDs.

**D. Dataverse tables** — discover the tables the **site actually references**, NOT every table sharing the publisher prefix.

> **Why not publisher prefix:** prefix-matching over-counts catastrophically with a shared/default publisher (`new_`, env default) — a 6-table site can match 22 unrelated tables — and it also *misses* the site's real tables when they come from a different prefix (e.g. a `bp_*` template under an `edm` publisher). The authoritative signal (SME-confirmed) is the site's **table permissions**: "If a table is used in the site there will be permissions for it."

Run the shared discovery helper, which scopes custom tables to the site's table permissions (+ datamodel manifest) intersected with the env's custom-unmanaged tables:
```bash
node "${PLUGIN_ROOT}/scripts/lib/discover-site-components.js" \
  --envUrl "{envUrl}" --token "{token}" --siteId "{websiteRecordId}" \
  --projectRoot "." \
  {if .datamodel-manifest.json elsewhere: --datamodelManifest "<path>"}
```
Use the returned `customTables[]` (each `{ id, logicalName, schemaName, displayName }` — `id` is the MetadataId for the `AddSolutionComponent` call). This is already the correct, site-scoped list — do **not** re-filter by prefix.

> **Important note on tables**: Dataverse solutions carry **schema only** — entity definitions, columns, relationships, forms, and views. Table **data/records** do NOT travel with the solution. If the target environment needs seed/reference data, that requires a separate data migration step.

**E. Cloud Flow link components (powerpagecomponenttype 33) — runtime field introspection:**

Query the `powerpagecomponent` records that link this site to Cloud Flows:
```
GET {envUrl}/api/data/v9.2/powerpagecomponents
  ?$filter=_powerpagesiteid_value eq '{websiteRecordId}' and powerpagecomponenttype eq 33
  &$select=powerpagecomponentid,name
```

If results are returned, fetch the first record **without** a `$select` to discover the workflow lookup field:
```
GET {envUrl}/api/data/v9.2/powerpagecomponents({firstComponentId})
```
Scan the response JSON for `_*_value` keys with non-null GUIDs that do not equal `websiteRecordId`. The remaining key is the workflow lookup field (e.g., `_adx_workflow_value`). Re-query all type-33 components with that field in `$select` to collect all backing `workflowId` GUIDs. Then resolve each workflow name and status:
```
GET {envUrl}/api/data/v9.2/workflows({workflowId})?$select=name,workflowid,statecode
```
Also discover the workflow's component type (for `AddSolutionComponent`):
```
GET {envUrl}/api/data/v9.2/solutioncomponents?$filter=objectid eq '{workflowId}'&$select=componenttype&$top=1
```
Store as `workflowComponentType`. If the query returns empty (flow not yet in any solution), note it — the backing flow record still exists and can be added.

If type-33 query returns no records, store `cloudFlows = []` and skip.

**F. Bot Consumer link components (powerpagecomponenttype 27) — runtime field introspection:**

Same pattern as Query E. Query type-27 `powerpagecomponent` records, discover the bot lookup field via introspection on the first record, collect bot GUIDs, resolve bot names via:
```
GET {envUrl}/api/data/v9.2/bots({botId})?$select=name,botid,statecode
```
And discover bot component type via `solutioncomponents`. Store as `botComponents`. If no type-27 records exist, store `botComponents = []` and skip.

**G. Connection references used by cloud flows in this solution:**

Cloud flows reference connectors via `connectionreference` records. These records are separate Dataverse entities; if they aren't in the solution, the solution will export cleanly but **fail to import** in the target environment with a `MissingDependency` / connection-reference validation error. We must enumerate them here and add them in Step 5.6.

Skip this query if Query E returned `cloudFlows = []`.

1. Query connection references owned by this site's publisher:
   ```
   GET {envUrl}/api/data/v9.2/connectionreferences
     ?$filter=startswith(connectionreferencelogicalname,'{publisherPrefix}_')
     &$select=connectionreferenceid,connectionreferencelogicalname,connectionreferencedisplayname,connectorid
   ```

2. For each cloud flow (from Query E), parse its `clientdata` JSON (`workflows({workflowId})?$select=clientdata`) to find which `connectionReferenceLogicalName`s it uses. Filter the Query G.1 result to just those references — these are the ones that **must** be in the solution.

3. **Resolve the connection-reference componenttype at runtime** — the value is environment-specific (observed values include `10137` and `10160` across tenants; do NOT hardcode):
   ```bash
   node "${PLUGIN_ROOT}/scripts/lib/discover-component-types.js" \
     --envUrl "{envUrl}" --token "{token}" \
     --websiteRecordId "{websiteRecordId}" \
     --objectIds "{firstConnectionReferenceId}"
   ```
   Read `.resolved[0].componentType` and store as `connectionReferenceComponentType`. If the connection ref is not yet in any solution (`resolved[0].componentType === null`), it has never been added — fall back to passing one ID per call until one resolves, or query a known sibling connection ref. Without a runtime-resolved value, do **not** guess.

   Store the filtered list as `connectionReferences[]`.

If Query G returns no references (the cloud flows don't use connectors, or the publisher prefix doesn't match — rare), store `connectionReferences = []` and skip. Surface a soft warning if cloud flows exist but no matching connection refs were found — the user should verify whether their flows are using connectors that need binding in target envs.

#### Step 5.3 — Categorize Site Settings

**If `preloadedSettings` is available** (user chose "Use pre-loaded choices from plan" in Phase 1 Step 5), skip the classification below — use `preloadedSettings.keepAsIs`, `preloadedSettings.promoteToEnvVar`, `preloadedSettings.authNoValue`, and `preloadedSettings.credentialNeedsDecision` directly. (Plans generated before 2026-05-08 use the older `excluded` bucket — treat its contents as `credentialNeedsDecision` for backward compatibility.)

**Otherwise**, run the shared classifier — `${PLUGIN_ROOT}/scripts/lib/classify-site-settings.js` — which is the **single source of truth** for the credential regex + tier mapping shared with `plan-alm` Phase 1 Step 7. Either invoke the CLI (pipe JSON to stdin) or `require()` it inline. The output is the same four-bucket shape `plan-alm` produces:

```js
{
  keepAsIs: [{name}],                      // Tier 3 — added to the solution unchanged
  authNoValue: [{name}],                   // Tier 2b — Authentication/AzureAD with empty value; added as-is, user sets per-env
  promoteToEnvVar: [{name, value}],        // Tier 2a — Authentication/AzureAD with value; reviewed at Step 5.4.A
  credentialNeedsDecision: [{name, value}] // Tier 1 — credential-style names; bulk-with-override prompt at Step 5.4.C
}
```

Tier definitions (mirroring the regex in `classify-site-settings.js`):

| Tier | Bucket | Matcher | Handling |
|---|---|---|---|
| 1 — Credential-style | `credentialNeedsDecision` | `CREDENTIAL_REGEX` (`ConsumerKey\|ConsumerSecret\|ClientId\|ClientSecret\|AppSecret\|AppKey\|ApiKey\|Password`, case-insensitive) | Bulk-with-override prompt at Step 5.4.C — auto-classify (Secret/String defaults), all-Secret, all-String, skip-all, or pick-per-credential |
| 2a — Auth config with value | `promoteToEnvVar` | `AUTH_PREFIX_REGEX` (`Authentication/` or `AzureAD/`) AND NOT credential AND has a value | Multi-select prompt at Step 5.4.A — which to back with env vars |
| 2b — Auth config, no value | `authNoValue` | Same prefix, no value | Added to solution as-is with a note (user sets value per env) |
| 3 — All other settings | `keepAsIs` | Anything else | Included in solution unchanged |

**Do NOT inline the regex here** — if it's wrong in this skill but right in `plan-alm`, classifications drift between plan time and execution time. The regex lives in `classify-site-settings.js` exclusively; both skills require it.

**Note on `authNoValue` settings**: These are auth configuration settings where no value has been set in the dev environment. They will be added to the solution as-is. After deploying to each target environment, the correct value should be configured there. Present these in a warning note box during the manifest review (Step 5.5).

#### Step 5.4 — Handle Auth Settings: Promote to Env Var?

Before presenting the final manifest, handle the three non-keepAsIs categories:

**A. `promoteToEnvVar` settings (auth config with values):**

<!-- gate: setup-solution:5.4a.promote | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · setup-solution:5.4a.promote):** Multi-select over auth settings — which to promote to env vars. Leave others as plain site settings.

Ask via `AskUserQuestion` with `multiSelect: true`, listing each `promoteToEnvVar` setting by name + current value:

> "These authentication configuration settings have values set in your dev environment. If any of them should have **different values per environment** (e.g., feature flags, login modes, AzureAD tenant settings), promote them to environment variables — they'll be tracked in the solution and injected per stage at deploy time. Leave others as plain site settings."

- One option per setting (e.g. `Authentication/Registration/LocalLoginEnabled = true`)
- Plus options: **"Promote all of them to env vars"** and **"Keep all as plain site settings"**

For each setting the user selects to promote:
1. Generate the canonical schema name with `${PLUGIN_ROOT}/scripts/lib/generate-env-var-schema-name.js` so it matches what `configure-env-variables` and `deploy-pipeline` will expect later:
   ```bash
   node "${PLUGIN_ROOT}/scripts/lib/generate-env-var-schema-name.js" \
     --publisherPrefix "{prefix}" \
     --settingName "{settingName}"
   ```
   Output: `{ schemaName, sanitized }`. The helper is the **single source of truth** for the canonical rule (`{prefix}_{sanitized(settingName)}.toLowerCase()`) — do not inline it. setup-solution and configure-env-variables MUST emit identical schema names for the same logical setting; inlining the rule risks divergent outputs.

2. Create an `environmentvariabledefinition` using the resolved schema name:
   ```bash
   node "${PLUGIN_ROOT}/scripts/lib/create-env-var-definition.js" \
     --envUrl "{envUrl}" \
     --token "{token}" \
     --schemaName "{schemaName from step 1}" \
     --displayName "{friendlyName}" \
     --type 100000000
   ```
   Use type `100000000` (String) for auth config settings (not Secret — these are feature flags, not credentials). Capture output as JSON; extract `.definitionId` and `.schemaName`.
2. Record the `definitionId` for inclusion in the components list (Step 5.6, `ComponentType: 380`).
3. **Link the site setting to the env var** using `link-site-setting-to-env-var.js`:
   ```bash
   node "${PLUGIN_ROOT}/scripts/lib/link-site-setting-to-env-var.js" \
     --envUrl "{envUrl}" \
     --token "{token}" \
     --siteSettingId "{settingId}" \
     --definitionId "{definitionId}" \
     --schemaName "{schemaName}"
   ```
   Check `.ok` and `.verified` are both `true`.

Settings the user chose NOT to promote move from `promoteToEnvVar` into `keepAsIs` — they will be included in the solution as plain site settings.

**B. `authNoValue` settings (auth config, no dev value):**

No user decision required. These are automatically included in the solution as-is. At Step 5.5, display them in a warning box:
> "The following auth settings have no value set in your dev environment. They will be added to the solution as-is. After deploying to each target environment, verify or set the correct value there."

**C. `credentialNeedsDecision` settings (credential-style — bulk-with-override prompt):**

These are credential-style site settings (ConsumerKey / ClientSecret / etc.) that need a decision before going into the solution. Shipping raw values inside the solution zip is a real exposure, so the safe path is to add the site-setting record to the solution and route the value through an environment variable per stage. **Asking per credential is too much when N is large** (a typical site has 20+ auth-related credentials across multiple OAuth providers), so this step uses a **bulk-with-override** prompt: one question covers all N credentials, with a per-credential escape hatch for granular control.

**Step 5.4.C.1 — Auto-classify by name pattern.**

Call `autoClassifyCredential(name)` from `${PLUGIN_ROOT}/scripts/lib/classify-site-settings.js` for each setting. The helper applies these regexes in order (the **single source of truth** — do not duplicate them here):

| Default | Matcher in helper | When it fires |
|---|---|---|
| **Secret env var** (`type: 100000005`) | `CREDENTIAL_SECRET_REGEX` (`Secret\|Password\|ApiKey\|AppKey`) | Names with these substrings — `*ClientSecret`, `*AppSecret`, `*Password`, `*ApiKey`, `*AppKey` |
| **String env var** (`type: 100000000`) | `CREDENTIAL_STRING_REGEX` (`Id\|ConsumerKey`) AND not Secret | Names like `*ClientId`, `*ConsumerKey`, `*TenantId`, `*AppId` |
| **Secret env var** (fallback) | (helper's defensive default when neither matches) | Anything else — defensive: credential names are sensitive by default |

The helper returns `{ default: 'secret' | 'string', reason }` for each setting. Group the results into `AUTO_CLASSIFY = { secrets: [...], strings: [...] }` and show the user a one-line summary: *"Auto-classified {N} credential-style settings: {S} as Secret env vars (Key Vault per stage), {T} as String env vars (plain text per stage)."*

**Step 5.4.C.2 — Bulk prompt.**

<!-- gate: setup-solution:5.4c.credentials | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · setup-solution:5.4c.credentials):** Bulk credential handling decision — Secret env var (Key Vault per stage), String env var (plain per stage), or skip. Per-credential choice. Determines whether secret values ship in the solution zip.

Ask **one** `AskUserQuestion` covering all N credentials:

> "{N} credential-style site settings detected (`{firstFew.join(', ')}{N>3?', ...':''}`). How should I handle them?
>
> Shipping their values inside the solution zip is a real exposure, so the recommended approaches add the site-setting record to the solution and route the value through an environment variable per stage. The actual secret value never ships in the zip — it's set per-environment in `deploymentsettingsjson`."

Options:
1. **Auto-classify by name** *(recommended)* — Apply the auto-classification from Step 5.4.C.1: {S} as Secret env vars, {T} as String env vars. One confirmation, all {N} handled. (Default option.)
2. **All as Secret env vars** — Treat every credential as a Key-Vault-backed Secret env var. Conservative; works for any credential but adds Key Vault dependency for stage values that don't actually need it.
3. **All as String env vars** — Treat every credential as a plain-text per-stage env var. Use only when none of the credentials are true secrets (e.g. an internal-only test setup).
4. **Skip all** — Don't add any to the solution. The user manages all credential values out-of-band per environment. Equivalent to the pre-IronItOut "excluded" behavior.
5. **Pick per credential** — Run a per-credential prompt for granular control (Secret / String / Skip per setting). Reach for this when you have a mix of true secrets and non-sensitive IDs that don't fit the auto-classification cleanly.

Branching logic:

- **Option 1 (Auto-classify)**: For each setting in `AUTO_CLASSIFY.secrets`, run the env-var-creation steps below with `--type 100000005`. For each in `AUTO_CLASSIFY.strings`, run with `--type 100000000`. No additional prompts.
- **Option 2 (All Secret)**: Treat all N as Secret. Same loop with `--type 100000005`.
- **Option 3 (All String)**: Treat all N as String. Same loop with `--type 100000000`.
- **Option 4 (Skip all)**: Move all N into a `userOptedOutOfSolution` bucket. Surface in Step 5.5: *"The following credential-style settings were skipped at user request and are NOT in the solution. Configure them manually in each target environment after deployment: `{names}`."*
- **Option 5 (Pick per credential)**: For each setting, run a 3-option `AskUserQuestion` (Secret env var / String env var / Skip). The auto-classification informs the per-prompt default but the user can override.

**Step 5.4.C.3 — Env var creation (shared by Options 1, 2, 3, and 5's non-Skip selections).**

For each setting routed to env-var-backed handling:

1. Generate the canonical schema name with `${PLUGIN_ROOT}/scripts/lib/generate-env-var-schema-name.js` (same helper Step 5.4.A uses — single source of truth so configure-env-variables and deploy-pipeline can reference the same schema names later):
   ```bash
   node "${PLUGIN_ROOT}/scripts/lib/generate-env-var-schema-name.js" \
     --publisherPrefix "{prefix}" \
     --settingName "{settingName}"
   ```

2. Create an `environmentvariabledefinition` using the resolved schema name:
   ```bash
   node "${PLUGIN_ROOT}/scripts/lib/create-env-var-definition.js" \
     --envUrl "{envUrl}" \
     --token "{token}" \
     --schemaName "{schemaName from step 1}" \
     --displayName "{friendlyName}" \
     --type "{100000005 for Secret, 100000000 for String}"
   ```
   For Secret env vars, do NOT pass `--defaultValue` — the dev value goes into Key Vault per stage, not into the definition. For String env vars, capture the dev value as the default.
3. Record the `definitionId` for inclusion in the components list (Step 5.6, `ComponentType: 380`).
4. Link the site setting to the env var via `link-site-setting-to-env-var.js` (same call as Step 5.4.A above).
5. The site setting itself is added to the solution alongside the env var definition — both are tracked components.

If any single env-var creation fails (token expired mid-loop, schema-name collision, etc.), surface the failure with the setting name + reason and ask the user whether to retry, skip just that setting, or abort the whole bulk operation. Do not silently drop credentials.

**Backward compatibility**: when reading a `preloadedSettings` plan generated before 2026-05-08, treat any entries in `preloadedSettings.excluded` as `credentialNeedsDecision` and run the bulk-with-override prompt above.

#### Step 5.4b — Adopt Orphaned Env Var Definitions

Separately from the OAuth-secret conversion above, other skills (notably `setup-auth`, `add-server-logic`, and `configure-env-variables`) may have previously created environment variable definitions that were never added to a user solution — they land in the `Default` solution and silently drift. This step discovers and adopts them.

Run the shared discovery helper to get the complete site inventory in one call:

```bash
node "${PLUGIN_ROOT}/scripts/lib/discover-site-components.js" \
  --envUrl "{envUrl}" --token "{token}" \
  --siteId "{websiteRecordId}" \
  --publisherPrefix "{publisherPrefix}" \
  --solutionId "{solutionId}"
```

Parse stdout as JSON and read `missing.envVars` — env var definitions whose `schemaname` starts with the publisher prefix but are not already `solutioncomponents` of this solution.

For each entry, also query which solution it currently belongs to (so the user can tell `Default`-only orphans apart from env vars that another user solution intentionally owns):

```
GET {envUrl}/api/data/v9.2/solutioncomponents
  ?$filter=objectid eq {definitionId}&$select=_solutionid_value
```

Then fetch the solution's `uniquename` for each hit. Build per-env-var tags:
- `DEFAULT-ONLY` — only the `Default` solution owns it (classic orphan from another skill).
- `IN OTHER SOLUTION: <uniquename>` — owned by a user solution; the user may intentionally want it scoped there.

If at least one env var has the `DEFAULT-ONLY` tag, prompt via `AskUserQuestion` with `multiSelect: true`:

<!-- gate: setup-solution:5.4b.orphan-envvars | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · setup-solution:5.4b.orphan-envvars):** Adopt env var definitions that match the publisher prefix but aren't yet in this solution. `DEFAULT-ONLY` orphans are pre-selected as Recommended; env vars already owned by another user solution are listed but not pre-selected (user opts in only if they intend to move ownership).

> "We found env var definitions with your publisher prefix (`{prefix}_`) that aren't in **{solutionUniqueName}** yet. Select the ones you want to include. Definitions only — values stay per-environment and won't travel.
>
> 1. `{schemaName}` ({displayName}) — type {type}, currently in: **{tag}**
> 2. ...
>
> Plus: **Include all DEFAULT-ONLY orphans (Recommended)** / **Skip for now**"

Collect selected entries into `adoptedEnvVars: [{ definitionId, schemaName, displayName, type }]`.

If none are selected or the list is empty, `adoptedEnvVars` stays empty — the skill continues silently.

> **Why this step exists**: before this check, env vars created by other skills were silently excluded from the site's solution and didn't travel to staging/prod. Surfacing them here is the cross-skill safety net required by the ALM-aware-by-default principle in `AGENTS.md`.

#### Step 5.4c — Adopt Orphaned Power Pages Components

Symmetric to 5.4b but for `powerpagecomponent` rows. Catches components on the site that were created by other skills or by `pac pages upload-code-site` without being wrapped into a user solution. Canonical examples surfaced in 2026-04-22 live validation:

- **`invoice-checker` server logic** (type 35) — added via `/power-pages:add-server-logic` in an earlier session, never registered into the user solution.
- **`index.html`** (type 3) — the current SPA entry page refreshed by `pac pages upload-code-site`; on every rebuild a new `index.html` record is created but nothing auto-adds it to the user solution.

Use the shared discovery helper to collect the orphan list (it already excludes Vite/Rollup bundle chunks — `Home-XYZ.js`, `index-XYZ.css`, etc. — so the prompt doesn't drown the user in hash-named noise):

```bash
node "${PLUGIN_ROOT}/scripts/lib/discover-site-components.js" \
  --envUrl "{envUrl}" --token "{token}" \
  --siteId "{websiteRecordId}" \
  --publisherPrefix "{publisherPrefix}" \
  --solutionId "{solutionId}"
```

From the JSON output, take `missing.powerpagecomponents` and partition:

- **Real content orphans** — entries whose `name` does NOT match the bundle-chunk regex (`[-.][A-Za-z0-9_-]{7,14}\.(js|mjs|cjs|css)(\.map)?$`). These are the ones to adopt.
- **Bundle-chunk orphans** — keep a count for the summary, but do NOT prompt for adoption. They're stale build artifacts, not real content. Report them in the Phase 7 summary with a suggestion to clean up via a separate housekeeping pass.

For each real-content orphan, also deduplicate by `name`: if there are multiple `index.html` rows and one is already in the solution (newer `modifiedon`), the older orphan is a stale duplicate — **exclude it from the adoption prompt** and log it as a stale duplicate instead. Rule: keep only the most-recent orphan per `(powerpagecomponenttype, name)` pair.

**Also take `missing.siteLanguages`** — these are `powerpagesitelanguage` records (componenttype 10428) that exist on the site but aren't in the user solution. They are NOT optional: an imported site without its language records silently fails to render post-auth because `powerpagesite.content.defaultlanguage` references an ID that doesn't exist in the target env. Include every entry verbatim in the orphan-adoption prompt — there is no bundle-chunk noise to filter for languages — and pre-select them as recommended.

If the real-content orphan list (or `missing.siteLanguages`) is non-empty, prompt via `AskUserQuestion` with `multiSelect: true`:

<!-- gate: setup-solution:5.4c.orphan-ppcs | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · setup-solution:5.4c.orphan-ppcs):** Adopt orphan `powerpagecomponent` rows (incl. `powerpagesitelanguage` records) that exist on the site but aren't in this solution. Site languages are pre-selected as Recommended because omitting them silently breaks post-auth rendering. Other ppc orphans (e.g. `invoice-checker` server logic) are pre-selected if they appear to be real content; stale build-artifact bundle chunks are filtered out upstream.

> "Found **{N}** site components not yet in **{solutionUniqueName}**:
>
> 1. `{name}` (type {type} {typeLabel}) — currently in: **{currentSolution}**
> 2. ...
>
> Plus: **Include all orphans (Recommended)** / **Skip for now**"

Collect selections into `adoptedPpcs: [{ id, name, type, typeLabel }]`.

When the user selects, call `AddSolutionComponent` per entry with `AddRequiredComponents: false` and the right `ComponentType` (use the values resolved by `discover-component-types.js` in Step 5.1 — do not hardcode):
- `subComponentType` for `missing.powerpagecomponents` entries
- `siteLanguageComponentType` for `missing.siteLanguages` entries

Do **not** set `DoNotIncludeSubcomponents: true` — the Dataverse API rejects that flag for non-Entity root components (HTTP 400 `0x80040216`) and it's not needed for these unified-entity rows.

If both `missing.powerpagecomponents` (after filtering) and `missing.siteLanguages` are empty, the step runs silently.

> **Why this step exists**: before this check, a recurring failure pattern was that `setup-solution` finished with the user convinced everything was wrapped up, while `invoice-checker` / `index.html` / similar site-linked records quietly stayed in the `Active` solution and didn't travel to staging/prod. Today's live validation found 1 real orphan (`invoice-checker`) on SupplierInvoicePortal — adopted via AddSolutionComponent, solution bumped from v1.0.0.1 → v1.0.0.2.

#### Step 5.5 — Present Full Manifest and Get User Confirmation

**This is the key decision point.** Build a full manifest of everything that will be added and present it to the user before writing anything.

If custom tables were discovered (the site-referenced set from step D), ask via `AskUserQuestion` with `multiSelect: true` **before** showing the final manifest:
- First option: **"Include all N referenced tables (Recommended)"** — pre-selected default. N is the count of tables the site actually references (not an env-wide prefix list).
- Then one option per table: `{logicalName} ({DisplayName})`
- Last option: **"Exclude all tables"**

> The default list is already scoped to the site's real tables (step D). If the user knows of an additional table the site needs that has no permission yet, they can add it manually — but the default must never be a publisher-prefix dump.

Present as a structured summary:

```
Here is everything that will be added to solution "{solutionName}":

WEBSITE & LANGUAGE
  ✓ Website record: {siteName}
  ✓ Site language(s): English (en-US)

SITE COMPONENTS ({total} components across {K} types)
  ✓ Publishing States (2)
  ✓ Web Pages (10)
  ✓ Web Files (90)         — compiled JS/CSS/HTML assets
  ✓ Page Templates (5)
  ✓ Web Templates (13)
  ✓ Content Snippets (11)
  ✓ Web Roles (2)
  ✓ Website Access (6)
  ✓ Table Permissions (13) — required for Web API authorization in target env
  ✓ Site Markers (5)
  ✓ Webpage Rules (2)

SITE SETTINGS (64 included)
  ✓ Web API settings (14):   Webapi/crd50_invoice/enabled, ...
  ✓ Feature flags (32):      CodeSite/Enabled, Search/Enabled, ...
  ✓ Auth config (18):        Authentication/Registration/LocalLoginEnabled, ...
  ~ OAuth as env vars (3):   ids_auth_openauth_microsoft_clientsecret, ... [ENV VAR]
  ✗ OAuth excluded (5):      Authentication/OpenAuth/Facebook/AppSecret, ... [EXCLUDED]

CLOUD FLOWS ({N} linked via powerpagecomponent type 33)
  ✓ Invoice Approval Flow   (workflowId: {guid}, Active)
  ~ Draft Flow              (workflowId: {guid}, Inactive — excluded by default)

BOT CONSUMERS ({N} linked via powerpagecomponent type 27)
  ✓ Support Bot             (botId: {guid}, Active)

DATAVERSE TABLES (schema only — no data)
  ✓ crd50_invoice (Invoice)
  ...

ENV VAR DEFINITIONS (componenttype 380)
  ✓ ids_auth_openauth_microsoft_clientsecret (Secret)     [converted from OAuth secret]
  ✓ crd50_auth_openauth_microsoft_clientsecret (Secret)   [ADOPTED — was in Default only]
  ...

Total to add: ~{N} components
```

For clarity, use these tags after each env var entry in the manifest:
- `[converted from OAuth secret]` — created in Step 5.4 from a site setting
- `[ADOPTED — was in Default only]` — existed before this run; being pulled into the solution in Step 5.4b
- `[ADOPTED ppc — was in Active only]` — powerpagecomponent adopted in Step 5.4c (e.g. `invoice-checker` server logic, real site pages not yet registered)
- `[ADOPTED — also in {otherSolutionName}]` — existed in another user solution; being additionally added here (user explicitly opted in)

If `cloudFlows` is non-empty, use `AskUserQuestion` with `multiSelect: true`:
- Option: "Include all N active cloud flows (Recommended)"
- One option per flow: `{name} ({workflowId})`
- Option: "Exclude all cloud flows"

Default: include active flows, exclude inactive ones. **If a flow is already in a different solution**, warn the user: *"This flow is in solution X — adding it here will move it."*

If `botComponents` is non-empty, use `AskUserQuestion` with `multiSelect: true` (same pattern).

If both are empty, skip and display `(None discovered)`.

After presenting the manifest summary, add a free-text escape hatch:
> "If you know of cloud flows or bots that should be in this solution but are not shown above, paste their GUIDs here (comma-separated). Leave blank to continue."

<!-- gate: setup-solution:5.5.manifest-confirm | category=plan | cancel-leaves=partial-manifest -->
> 🚦 **Gate (plan · setup-solution:5.5.manifest-confirm):** Final manifest confirmation before any `AddSolutionComponent` write. Covers tables, flows, bots, env vars, orphan adoption. Cancel here keeps the in-memory manifest but no Dataverse writes happen.

Ask via `AskUserQuestion`:
> "Does this look right? You can proceed, or tell me which categories or tables to exclude."

Options: "Proceed with this selection" / "I want to change something"

Wait for explicit confirmation before Step 5.6.

#### Step 5.6 — Add All Confirmed Components

Build a JSON array of all components to add, then call `scripts/lib/add-components-to-solution.js` to perform the bulk operation with token refresh and idempotency handling built in.

The components array should be built in this order:

1. **Website record** — `{ componentId: websiteRecordId, componentType: websiteComponentType, addRequired: true, description: "Website: {siteName}" }`
2. **Site language records** — one entry per language with `siteLanguageComponentType` (NOT auto-included by `AddRequiredComponents`)
3. **All confirmed powerpagecomponent groups** — one entry per component using `subComponentType`
   - Table Permissions (type 18) are standard powerpagecomponents — include by default
   - Exclude OAuth secret site settings that were not converted to env vars
4. **Env var definitions** — one entry per definition with `{ componentType: 380 }`. Include:
   - Every env var created in Step 5.4 (OAuth-secret conversion)
   - Every entry in `adoptedEnvVars` from Step 5.4b (orphans the user chose to include)
5. **Dataverse tables** — `{ componentType: 1, componentId: MetadataId }`
6. **Confirmed cloud flows** (from Step 5.5) — `{ componentId: workflowId, componentType: workflowComponentType }` (uses runtime-discovered type)
7. **Confirmed bot components** — `{ componentId: botId, componentType: botComponentType }` (uses runtime-discovered type)
8. **Connection references used by the confirmed cloud flows** (from Step 5.2 Query G) — one entry per reference: `{ componentId: connectionReferenceId, componentType: connectionReferenceComponentType, addRequired: false }`. Skip if `connectionReferences = []`. Use the **runtime-resolved** `connectionReferenceComponentType` — do **not** hardcode (observed values across tenants include `10137` and `10160`; the value is env-specific). Without these entries, the solution exports cleanly but the target import fails with a `MissingDependency` error — `deploy-pipeline` Phase 6.6.1 will surface it as a "missing connection reference" validation failure.
9. **Adopted orphan ppcs** (from Step 5.4c) — `{ componentId: ppc.id, componentType: subComponentType, addRequired: false }`. Use the `subComponentType` value resolved by `discover-component-types.js` in Step 5.1 — do **not** hardcode. Do **not** set `DoNotIncludeSubcomponents: true` — Dataverse rejects that flag on non-Entity components (HTTP 400 `0x80040216`).

**Single-solution mode** (`MULTI_SOLUTION_MODE = false`): write the array to a temp file (e.g., `C:/Users/{user}/AppData/Local/Temp/components-to-add.json`), then run:
```bash
node "${PLUGIN_ROOT}/scripts/lib/add-components-to-solution.js" \
  --envUrl "{envUrl}" \
  --componentsFile "C:/Users/{user}/AppData/Local/Temp/components-to-add.json" \
  --solutionUniqueName "{solutionUniqueName}"
```

**Multi-solution mode** (`MULTI_SOLUTION_MODE = true`): partition the unified component list across `PROPOSED_SOLUTIONS` based on each solution's `componentTypes` (and `tableLogicalNames` for Strategy 3), then run `add-components-to-solution.js` once per solution. The per-solution loop SHOULD run serially across solutions (each helper call already batches + refreshes tokens internally; running solutions in parallel multiplies the token-refresh load with no real wall-clock win since the bottleneck is per-component Dataverse calls inside each batch). For each entry in `PROPOSED_SOLUTIONS` (skip `isFutureBuffer: true`):
1. Filter the unified component array down to components whose Dataverse type-name maps into this solution's `componentTypes` array. The mapping from numeric `componentType` → name is the same one `discover-component-types.js` and `discover-site-components.js` use (`PPC_TYPE_LABELS`). Tables route to the solution whose `tableLogicalNames` includes the table's logical name (Strategy 3) or to whichever solution claims `'Table'` (Strategies 1 and 2).
2. Write the per-solution sub-array to a temp file (e.g., `C:/Users/{user}/AppData/Local/Temp/components-{uniqueName}.json`), then invoke the helper with all three required flags:
   ```bash
   node "${PLUGIN_ROOT}/scripts/lib/add-components-to-solution.js" \
     --envUrl "{envUrl}" \
     --componentsFile "C:/Users/{user}/AppData/Local/Temp/components-{uniqueName}.json" \
     --solutionUniqueName "{proposedSolutions[i].uniqueName}"
   ```
   Capture the JSON summary keyed by `uniqueName`, delete the temp file. **All three flags are required** — omitting `--envUrl` or `--componentsFile` (only passing `--solutionUniqueName`) causes the helper to exit 1 with `--envUrl is required` / `--componentsFile is required`. Both must be passed per iteration, even though `--envUrl` is the same across all iterations of the loop.
3. If a component's type doesn't match any solution's `componentTypes`, surface a per-component warning and STOP — the partitioning lost a component. This usually means the split plan dropped a type (regression in `compute-split-plan.js`); the user needs to re-plan rather than silently leaking components into `Default`.

Use `SOLUTIONS_BY_NAME` from Phase 4 to resolve each `uniqueName → solutionId` if the helper's resolution by name isn't sufficient.

The script handles token refresh every 20 calls, treats "already in solution" as success, and outputs a JSON summary `{ total, success, skipped, failed, failures }`. Delete the temp file(s) after completion.

### Phase 6 — Verify and Write Manifest

1. Verify components: `GET {envUrl}/api/data/v9.2/solutioncomponents?$filter=_solutionid_value eq '{solutionId}'&$select=objectid,componenttype`
2. Count components by type, confirm the website record (using `websiteComponentType`) is present

2b. **Capture the post-setup env var snapshot for the rendered ALM plan.** Ensure `docs/alm/` exists, then run the discovery helper and write its output to a sidecar marker file (`docs/alm/last-env-vars.json`). The plan-refresh helper (Phase 7's self-refresh) ingests this sidecar into `planData.envVars` so the rendered plan's Env Variables tab shows the definitions setup-solution just created/adopted (without it the tab stays empty even after Phase 5.4 / 5.4.C / 5.4b created definitions):

   ```bash
   node -e "require('fs').mkdirSync('docs/alm',{recursive:true})"
   node "${PLUGIN_ROOT}/scripts/lib/discover-env-var-definitions.js" \
     --envUrl "{envUrl}" \
     --publisherPrefix "{publisherPrefix}" \
     --websiteRecordId "{websiteRecordId}" \
     --token "{token}" > docs/alm/last-env-vars.json.tmp \
     && mv docs/alm/last-env-vars.json.tmp docs/alm/last-env-vars.json
   ```

   The tmp-file write pattern preserves a prior good `docs/alm/last-env-vars.json` on a transient discovery failure (parallel to the `docs/alm/alm-size-estimate.json` pattern in plan-alm Phase 1). If the helper exits non-zero, log the stderr and continue — the existing sidecar (or absence of one) is acceptable; the refresh just won't update env vars this run.

   The sidecar's shape mirrors what `discover-env-var-definitions.js` already returns: `{ envVars: [{ schemaName, type, defaultValue, siteSetting }], count }`. Don't transform — the renderer reads these fields directly.

3. Write `.solution-manifest.json` to project root (alongside `powerpages.config.json`):
   - See manifest format in `${PLUGIN_ROOT}/references/solution-api-patterns.md` Section 7
   - If cloud flows were confirmed, include a `cloudFlows` array: `[{ "workflowId": "...", "name": "...", "status": "active|inactive" }]`
   - If bot components were confirmed, include a `botComponents` array: `[{ "botId": "...", "name": "..." }]`
   - Omit these arrays entirely if no flows/bots were discovered or confirmed (absence = not tracked; `[]` = tracked but none selected)

   **In `MULTI_SOLUTION_MODE`, write manifest v2** with a `solutions[]` array:
   ```json
   {
     "schemaVersion": 2,
     "publisher": { "publisherId": "...", "uniqueName": "...", "friendlyName": "...", "customizationPrefix": "..." },
     "solutions": [
       {
         "uniqueName": "IdeaSphere_Core",
         "solutionId": "...",
         "version": "1.0.0.0",
         "order": 1,
         "componentTypes": ["Table", "Site Setting", ...],
         "components": [ { "componentId": "...", "componentType": 1, "description": "..." } ]
       },
       {
         "uniqueName": "IdeaSphere_WebAssets",
         "solutionId": "...",
         "version": "1.0.0.0",
         "order": 2,
         "componentTypes": ["Web File"],
         "components": [ ... ]
       }
     ],
     "splitStrategy": "strategy-1-layer",
     "assetAdvisory": [ /* pass-through from plan context */ ]
   }
   ```

   **v1 single-solution manifest stays backward compatible.** Readers (`export-solution`, `import-solution`, `setup-pipeline`, `deploy-pipeline`) check `schemaVersion`:
   - `schemaVersion` absent or `1` → treat as single-solution (existing behavior).
   - `schemaVersion: 2` → iterate `solutions[]` in `order`.

4. Commit: `git add .solution-manifest.json && git commit -m "Add solution manifest for ALM"`

### Phase 7 — Present Summary

Display a summary table:

| Item | Value |
|---|---|
| Publisher | `{friendlyName}` (`{uniqueName}`, prefix: `{prefix}`) |
| Solution | `{friendlyName}` (`{uniqueName}`, v`{version}`) |
| Solution ID | `{solutionId}` |
| Components added | N |
| Env var definitions added | N (if any OAuth secrets converted) |
| Manifest written | `.solution-manifest.json` |

**If any auth settings were promoted to env vars**, confirm that each site setting was automatically linked. Show a brief confirmation:

```
Auth settings promoted to environment variables:
  ✓ Authentication/Registration/LocalLoginEnabled → ids_authentication_registration_localloginenabled
  ✓ Authentication/Registration/AzureADLoginEnabled → ids_authentication_registration_azureadloginenabled
```

Note: Per-environment values must still be set via `configure-env-variables` or the Power Pages Management UI.

**If any `authNoValue` settings were included**, show a reminder:
```
Auth settings included without a dev value (configure in each target env after deploy):
  ⚠ Authentication/OpenAuth/Facebook/AppId
  ⚠ Authentication/Registration/LoginButtonAuthenticationType
```

<!-- gate: setup-solution:7.next-step | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · setup-solution:7.next-step):** Routing choice for downstream deployment skill — PP Pipelines, manual export/import, or defer. All Dataverse writes for this skill are already complete; this gate selects what runs next.

**Ask what the user wants to do next** via `AskUserQuestion`:

> "How would you like to deploy this solution to other environments?"

Options:
1. **"Use Power Platform Pipelines (Recommended)"** — sets up a pipeline in the PP Pipelines host environment; supports staged deployments, approval gates, and env var overrides per stage.
2. **"Export and import manually"** — exports the solution as a zip and imports it directly to a target environment. Simpler for one-off deployments.
3. **"I'll decide later"** — shows next step suggestions and exits.

If the user selects **option 1**, immediately invoke `/power-pages:setup-pipeline`.
If the user selects **option 2**, immediately invoke `/power-pages:export-solution`.
If the user selects **option 3**, show:
- Run `/power-pages:setup-pipeline` for automated staged deployments
- Run `/power-pages:export-solution` to export a zip for manual import
- Run `/power-pages:configure-env-variables` if environment-specific values need to be set per stage

### Tip: Adding Components Later

> **When the live site grows beyond what's in this solution** — server logic from `add-server-logic`, cloud flows from `add-cloud-flow`, env vars from `setup-auth` or `configure-env-variables`, new tables from `setup-datamodel`, or new web roles — **re-run `/power-pages:setup-solution`**. The skill auto-detects sync mode when `.solution-manifest.json` exists in the project root, runs the discovery pass, diffs the live site against the solution, bumps the version, and adds only the missing components. No need for a separate "add to solution" workflow.

### Record Skill Usage

> Reference: `${PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "SetupSolution"`.

### Refresh the ALM plan (if one exists)

```bash
node "${PLUGIN_ROOT}/scripts/lib/refresh-alm-plan-data.js" \
  --projectRoot "." \
  --phase setup-solution \
  --render
```

The helper resets `planData.plannedEnvVarCount` to 0 (the planned env vars have either been created or skipped at the user's request) and re-renders `docs/alm-plan.html` so the Overview stat card and Env Variables tab reflect post-setup state. When `docs/.alm-plan-data.json` is absent (standalone invocation, not part of an ALM plan), the helper returns `ok:false` as a soft no-op — safe to run unconditionally.

**Point the user at the next step (user-driven sequencing).** The helper's stdout JSON includes `nextStep: { name, skill: string | null } | null`. `skill` is `null` when the next pending step has no user-invocable command (e.g. an internal "Finalize" step) — so branch on it:

- **`nextStep.skill` is non-null** → "Plan updated. Next in your plan: **{nextStep.name}** → run `{nextStep.skill}` when you're ready."
- **`nextStep.skill` is `null`** → name the step only, with no command: "Plan updated. Next in your plan: **{nextStep.name}**." Never print `run null`.

When `nextStep` itself is `null` (every planned step is done) or the helper returned `ok:false` (no plan on disk), say nothing about a next step. **Never auto-invoke the next skill** — `plan-alm` is a planner and the user drives execution one skill at a time.

## Key Decision Points (Wait for User)

1. **Phase 2**: Publisher prefix confirmation — permanent, cannot be changed
2. **Phase 3**: Reuse vs create confirmation — before any writes
3. **Phase 1, Step 5**: ALM plan context — use pre-loaded site settings classification from plan-alm, or re-discover and reclassify
4. **Phase 5, Step 5.4**: Auth settings with values — multi-select which to promote to env vars vs keep as plain site settings; **per-credential prompt** for credential-style settings (Secret env var / String env var / skip)
5. **Phase 5, Step 5.5**: Full manifest review — user sees everything (website, site language, all component categories, tables, env var definitions, authNoValue warnings) and confirms or adjusts before any components are written
5. **Phase 7**: Next step — PP Pipelines (recommended) vs export/import manually vs decide later

## Error Handling

- If publisher creation fails with "duplicate" error: re-query and use existing publisher
- If solution creation fails with "duplicate" error: re-query and use existing solution
- If `AddSolutionComponent` returns "already in solution": treat as success (idempotent)
- Never attempt rollback on failure — report what succeeded and what failed

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| Verify prerequisites | Verifying prerequisites | Confirm PAC CLI auth, acquire Azure CLI token, verify API access, locate powerpages.config.json |
| Gather solution configuration | Gathering solution configuration | Collect publisher name, prefix, solution name, version from user — confirm irreversible choices |
| Check existing publishers and solutions | Checking existing state | Query Dataverse for existing publisher and solution to avoid duplicate creation |
| Create publisher and solution | Creating publisher and solution | POST publisher and solution to Dataverse OData API, capture IDs |
| Add site components to solution | Adding site components | Discover website/language/powerpagecomponents/tables/cloud flows (type 33)/bot consumers (type 27) via runtime field introspection; split site settings by category; present full manifest including CLOUD FLOWS and BOT CONSUMERS sections with active/inactive status; get user confirmation; call add-components-to-solution.js for website, site language(s), all confirmed components, tables (ComponentType=1), confirmed cloud flows, and confirmed bot components |
| Verify and write manifest | Verifying solution and writing manifest | Confirm components in solution, write .solution-manifest.json, commit |
| Present summary | Presenting summary | Show solution details, component count, and next steps |
