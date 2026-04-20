---
name: plan-alm
description: >-
  Creates an ALM (Application Lifecycle Management) plan for deploying a Power Pages
  site across environments. Gathers your promotion strategy, target environments, and
  approval requirements upfront, generates a visual HTML plan document for review, then
  — after your approval — executes the plan by calling setup-solution, setup-pipeline,
  export-solution, and deploy-pipeline (or import-solution) in sequence.
  Use when asked to: "plan my alm", "set up alm", "create deployment plan",
  "plan my deployments", "help me deploy to multiple environments",
  "set up promotion strategy", "create cicd plan", "plan site promotion",
  "help me go to production", "set up pipeline for my site".
user-invocable: true
argument-hint: "Optional: 'pipelines' or 'manual' to skip strategy selection"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
hooks:
  Stop:
    - hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/plan-alm/scripts/validate-plan-alm.js"'
          timeout: 30
        - type: prompt
          prompt: |
            Check whether the plan-alm skill completed successfully. Return { "ok": true } if ALL of the following are true, otherwise { "ok": false, "reason": "..." }:
            1. ALM strategy inputs were gathered from the user (promotion method, environments)
            2. docs/alm-plan.html was written to the project root docs/ folder
            3. The plan was presented to the user and either approved or deferred
            4. If approved: all selected skills were invoked in sequence
            5. docs/alm-plan.html reflects final status (Completed or Deferred)
          timeout: 30
---

# plan-alm

An 8-phase orchestrator that gathers ALM strategy from the user, generates an HTML deployment plan, gets approval, then executes the plan by calling existing skills in sequence.

## Overview

This skill detects the current project state (existing solution, pipeline), asks targeted questions about the desired promotion strategy (Power Platform Pipelines or Manual export/import), generates a visual `docs/alm-plan.html`, gets user approval, and then invokes `setup-solution`, `setup-pipeline` (or `export-solution`), and `deploy-pipeline` (or `import-solution`) in the correct order.

**Do NOT create tasks at the start** — strategy is unknown until Phase 2 completes. Create all tasks in Phase 3 once the strategy is determined.

---

## Phase 1 — Detect Project State

**Do NOT create tasks yet.** Use natural language progress reporting only during this phase.

Steps:

1. Read `powerpages.config.json` from the project root (use `Glob` to find it). Extract:
   - `siteName` — the site's display name
   - `websiteRecordId` — the Power Pages website GUID
   - `environmentUrl` — dev environment URL

   If not found, stop with: "powerpages.config.json not found. Run `/power-pages:create-site` first."

2. Check for `.solution-manifest.json` in the project root:
   - Store `SOLUTION_DONE = true` if found, `false` otherwise
   - If found, read `solution.uniqueName` and store as `SOLUTION_UNIQUE_NAME`

3. Check for `.last-pipeline.json` in the project root:
   - Store `PIPELINE_DONE = true` if found, `false` otherwise
   - If found, read `pipelineName` and `stages[]` for later use

4. Run silently:
   ```bash
   pac env who
   ```
   Capture the `Environment URL` and display name. Store as `DEV_ENV_URL` and `DEV_ENV_NAME`.

5. Run silently:
   ```bash
   pac env list --output json 2>/dev/null
   ```
   Store output as `ENV_LIST` for pre-filling environment URLs in Phase 2.

6. Acquire dev environment token (silently):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/verify-alm-prerequisites.js" --envUrl "{DEV_ENV_URL}"
   ```
   Store `.token` as `DEV_TOKEN` and `.userId` as `userId`. If this fails (auth error), set `DEV_TOKEN = null` and continue — contents discovery will be skipped gracefully.

7. Discover and classify site settings (if `DEV_TOKEN` is available and `websiteRecordId` is known):

   Use Node.js `https` module to query:
   ```
   GET {DEV_ENV_URL}/api/data/v9.2/mspp_sitesettings?$filter=_mspp_websiteid_value eq '{websiteRecordId}'&$select=mspp_name,mspp_value&$top=500
   Authorization: Bearer {DEV_TOKEN}
   ```

   Classify each returned setting using this three-tier logic:

   **Tier 1 — Excluded (true credentials, never add to solution):**
   Name matches `/ConsumerKey|ConsumerSecret|ClientId|ClientSecret|AppSecret|AppKey|ApiKey|Password/i`
   These are OAuth/identity credential fields — adding them to a solution would expose secrets.

   **Tier 2 — Auth config (per-environment auth settings):**
   Name matches `Authentication/` or `AzureAD/` (but NOT in Tier 1).
   These are authentication feature flags and configuration that may differ per environment.
   - If `mspp_value` is non-empty → **`promoteToEnvVar`**: recommend promoting to an environment variable during `setup-solution` so staging/production can use different values
   - If `mspp_value` is null or empty → **`authNoValue`**: include in solution as-is (no secret to protect), but show a note that this is an auth setting with no dev value and the user should verify the correct value is set in each target environment after deployment

   **Tier 3 — Regular settings (all others):**
   Everything else — Search, Bootstrap, WebApi field lists, feature flags, site tracking, etc.
   → **`keepAsIs`**: include in solution as-is regardless of whether a value is set. These settings do not need per-environment variation and no special treatment is required.

   Store as:
   ```js
   SITE_SETTINGS_DATA = {
     keepAsIs: [{name}],                    // regular settings (Tier 3)
     authNoValue: [{name}],                 // auth config with no dev value (Tier 2, no value)
     promoteToEnvVar: [{name, value}],      // auth config with dev value (Tier 2, has value)
     excluded: [{name}]                     // true credentials (Tier 1)
   }
   ```
   If the query fails, set `SITE_SETTINGS_DATA = null` and continue.

8. Build `SOLUTION_CONTENTS_DATA`:
   ```js
   {
     tables: solutionManifest?.components?.tables || [],     // from .solution-manifest.json if SOLUTION_DONE
     botComponents: solutionManifest?.botComponents || [],   // from manifest if available
     siteSettings: SITE_SETTINGS_DATA                        // from step 7, or null
   }
   ```
   If `SOLUTION_DONE = false` and manifest is absent, `tables` and `botComponents` will be empty arrays — the plan will show a note that they will be discovered during setup-solution.

9. Report to user:
   ```
   Found: **{siteName}** on `{devEnvUrl}`.
   Solution: {✓ already set up ({solutionUniqueName}) / ✗ not yet}.
   Pipeline: {✓ already set up ({pipelineName}) / ✗ not yet}.
   Site settings: {N total — K regular (keep as-is), P auth settings to review for env var, A auth settings (no dev value), E credential secrets excluded / unable to query}.
   ```

10. **Estimate solution size and evaluate the split decision tree.** Run the estimate helper to classify the site across size, component count, schema heaviness, web file aggregate, and env var count. Use the tmp-file write pattern — if the estimator fails, a prior good `.alm-size-estimate.json` is preserved instead of being overwritten with an empty/partial file:
    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/estimate-solution-size.js" \
      --envUrl "{DEV_ENV_URL}" --websiteRecordId "{websiteRecordId}" \
      --publisherPrefix "{publisherPrefix}" --siteName "{siteName}" \
      --datamodelManifest "./.datamodel-manifest.json" > ./.alm-size-estimate.json.tmp \
      && mv ./.alm-size-estimate.json.tmp ./.alm-size-estimate.json
    ```
    Then run the decision tree (same tmp-file pattern):
    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/compute-split-plan.js" \
      --estimate ./.alm-size-estimate.json \
      --projectRoot "." \
      --siteName "{siteName}" \
      --publisherPrefix "{publisherPrefix}" > ./.alm-split-plan.json.tmp \
      && mv ./.alm-split-plan.json.tmp ./.alm-split-plan.json
    ```
    If either command exits non-zero, stop and report the stderr message to the user. Do not proceed to Q1b in Phase 2 without a valid split plan.
    Store the output as `SPLIT_PLAN`. Fields to read: `splitStrategy`, `proposedSolutions[]`, `appliedStrategies[]`, `assetAdvisory`, `sizeAnalysis`, `recommendations[]`.

    If `SPLIT_PLAN.proposedSolutions.length > 1`, set `RECOMMEND_SPLIT = true`. Otherwise `false`.

    Report to the user:
    ```
    Estimated size: {totalSizeMB} MB — components: {count} — tier: {overall tier}.
    Decision tree result: {splitStrategy} → {N} solutions recommended.
    Asset advisory: {K} files flagged for Azure Blob externalization.
    ```

---

## Phase 2 — Gather ALM Strategy

Ask questions in sequence. **Solution is always Q1** — it is the prerequisite for all other steps. Branch after Q2 based on promotion strategy selection.

### Q1 — Solution Setup (always asked first)

**If `SOLUTION_DONE = true`** (manifest found in Phase 1):

Ask via `AskUserQuestion`:
> "A Dataverse solution is already configured for this site: **{SOLUTION_UNIQUE_NAME}**. Use this existing solution?"

Options:
1. **Yes, use the existing solution** — `setup-solution` will be skipped in the plan
2. **No, create a new solution** — set `SOLUTION_DONE = false`; `setup-solution` will run

**If `SOLUTION_DONE = false`** (no manifest found):

Tell the user (not via `AskUserQuestion` — informational only):
> "No Dataverse solution is set up for this site yet. **`setup-solution` will be the first step in your plan.** The publisher prefix you choose during setup is irreversible — choose carefully."

Ask via `AskUserQuestion`:
> "Ready to include solution setup in the plan?"

Options:
1. **Yes, include solution setup** — continue
2. **I already have a solution (enter name)** — accept free-text solution unique name, set `SOLUTION_DONE = true`, `SOLUTION_UNIQUE_NAME = user input`

---

### Q1b — Split Recommendation (only if `RECOMMEND_SPLIT = true`)

The decision tree from Phase 1 Step 10 recommended splitting into multiple solutions. Ask via `AskUserQuestion`:

> "Based on the site size and component analysis, the recommended approach is **{splitStrategy}** — {N} solutions instead of one. Do you want to follow this recommendation?"

Options:
1. **Use the recommended split** — proceed with `proposedSolutions[]` from the decision tree. `setup-solution` will create all N solutions.
2. **Keep as a single solution anyway** — override to single. Record override reason; `setup-solution` creates one solution with all components.
3. **Accept Asset Advisory first** (only offered if `assetAdvisory.candidates.length > 0`) — user commits to externalizing the flagged assets. Recompute size excluding those files, re-run the decision tree, present the new recommendation.
4. **Show me migration guidance** (only offered if an existing `.solution-manifest.json` is found and does not match the recommendation) — produce `docs/alm-migration-plan.md` and exit. Do not execute.

**If option 1:** continue with `proposedSolutions`.
**If option 2:** override `SPLIT_PLAN.proposedSolutions` to the single-solution structure for rendering; record `overrideReason` in the plan.
**If option 3:** subtract advisory candidate sizes from the estimate, re-run `compute-split-plan.js`, re-present.
**If option 4:** write `docs/alm-migration-plan.md` (see the spec doc `solution-splitting-logic.md` §7), commit it, mark plan as Deferred, exit.

---

### Q2 — Strategy Selection (always asked)

Ask via `AskUserQuestion`:

> "How do you want to promote your solution between environments?"

Options:
1. **Power Platform Pipelines** — Microsoft's native CI/CD, managed deployments, approval gates
2. **Manual export/import** — export a zip from dev and import directly to each target environment
3. **I already have a pipeline set up** — run a deployment now
4. **Help me decide** — show a quick comparison

**If option 4 selected:** Explain:
> "Power Platform Pipelines is recommended for teams and multiple environments — it provides automated promotion, approval gates, and deployment history in one place. Manual export/import is simpler for one-off migrations or when you only need to deploy once. For ongoing CI/CD, choose Power Platform Pipelines."

Then re-ask Q2 with only options 1–3.

**If option 3 selected:** Read `.last-pipeline.json`, confirm pipeline name and stages, then skip to Phase 3 (generate plan) with `strategy = pp-pipelines`, `PIPELINE_DONE = true`.

---

### PP Pipelines Path — Q3 through Q7

**Q3:** Ask via `AskUserQuestion`:
> "How many deployment stages do you want in this pipeline?"

Options:
1. **Staging only** — Dev → Staging (I'll add Production later)
2. **Staging + Production** — Dev → Staging → Production (full promotion chain)
3. **Production directly** — Dev → Production only (bypass staging)
4. **Custom** — I'll describe my own stage layout

If option 4: accept free-text description (via "Other") and build a stage list from the response.

Store stages as `PP_STAGES` (array of `{ label, envUrl }`). Dev is always the source.

**Q4 (auto-detect + confirm — host environment):**

Run silently using `discover-pipelines-host.js`:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/discover-pipelines-host.js" \
  --envUrl "{DEV_ENV_URL}" --token "{DEV_TOKEN}" --userId "{userId}"
```

- **If auto-detected:** Ask via `AskUserQuestion`:
  > "Use detected Pipelines host environment `{HOST_ENV_URL}`?"
  Options: 1. Yes, use this / 2. Use a different host environment (enter via Other)

- **If not detected:** Ask via `AskUserQuestion` — pre-fill options from `ENV_LIST` (up to 3 known environment URLs from `pac env list`) plus "Other" for a custom URL. Pre-fill first option from `.last-pipeline.json` if present.

Store as `HOST_ENV_URL`.

**Q5:** Ask via `AskUserQuestion`:
> "Should deployments require approval before each stage?"

Options:
1. Required before each stage (Recommended for production)
2. Staging auto-approve, production requires approval
3. No approval gates — deploy automatically

Store as `PP_APPROVAL_MODE`.

**Note:** PP Pipelines always exports as a **managed** solution to target environments. Set `EXPORT_TYPE = "managed"` automatically — no question needed.

**Q6 (auto-detect, no question):** Check `.solution-manifest.json` for `envVarDefinitions` or components with `componenttype 380`. If found, set `HAS_ENV_VARS = true` — note in plan that `deploy-pipeline` will prompt for per-stage env var values. If manifest not present (SOLUTION_DONE=false), set `HAS_ENV_VARS = false` — variables will be discovered during setup-solution.

**Q7:** Ask via `AskUserQuestion`:
> "Is this project's code tracked in Git source control?"
> *(Informational only — this determines whether the plan includes a source control recommendation. No automation is applied.)*

Options:
1. Yes — we use Git (changes tracked before each deployment)
2. No — not using source control (plan will recommend enabling it before production)
3. Not yet set up (plan will include source control guidance)

Store as `GIT_STATUS`.

---

### Manual Path — Q3 through Q8

**Q3:** Ask via `AskUserQuestion`:
> "How many target environments do you need to deploy to?"

Options:
1. One target (e.g. Production)
2. Two targets (e.g. Staging then Production)
3. Dev only — not deploying yet

Store as `MANUAL_TARGET_COUNT`.

If option 3: set `MANUAL_TARGET_COUNT = 0`. Proceed to Q5.

**Q4 (one per stage):** For each target environment needed, ask via `AskUserQuestion`:

> "What is the URL for target environment {N}?"

Pre-fill from `ENV_LIST`: show up to 3 known environment URLs from `pac env list` as options, plus "Enter a different URL" as the last option.

Store target URLs as `MANUAL_TARGETS` (array).

**Q5:** Ask via `AskUserQuestion`:
> "How should the solution be exported?"

Options:
1. Managed — for staging/production (cannot edit in target)
2. Unmanaged — for dev-to-dev (editable in target)

Store as `EXPORT_TYPE`.

**Q6:** Ask via `AskUserQuestion`:
> "Do you want a checkpoint pause between export and import for review?"

Options:
1. Yes — pause after export so I can review the zip before importing
2. No — proceed automatically

Store as `MANUAL_CHECKPOINT` (`true` or `false`).

**Q6 (auto-detect, no question):** Same as PP Pipelines Q6 — check for env var definitions.

**Q7:** Same as PP Pipelines Q7 — Git source control status.

---

## Phase 3 — Generate HTML Plan

**Now create all tasks** — strategy is known.

### Task creation

**For PP Pipelines path**, create these tasks (in order):

| # | Subject | activeForm | Description |
|---|---------|-----------|-------------|
| 1 | Generate ALM plan | Generating ALM plan | Build planData, render docs/alm-plan.html |
| 2 | Approve ALM plan | Awaiting plan approval | Present inline summary, get user confirmation |
| 3 | Setup solution | Setting up solution | Invoke setup-solution skill (conditional) |
| 4 | Setup pipeline | Setting up pipeline | Invoke setup-pipeline skill (conditional) |
| 5..N | Deploy to {stageName} | Deploying to {stageName} | Invoke deploy-pipeline skill for this stage — one task per target stage |
| 5..N+1 | Activate site in {stageName} | Activating site in {stageName} | Check activation status + invoke activate-site if not yet provisioned — one task per target stage |
| N+2 | Finalize | Finalizing | Update HTML status, commit, run skill tracking |

Create one **Deploy to {stageName}** + **Activate site in {stageName}** task pair for each target stage in `PP_STAGES` (e.g. Staging, Production).

**For Manual path**, create:

| # | Subject | activeForm | Description |
|---|---------|-----------|-------------|
| 1 | Generate ALM plan | Generating ALM plan | Build planData, render docs/alm-plan.html |
| 2 | Approve ALM plan | Awaiting plan approval | Present inline summary, get user confirmation |
| 3 | Setup solution | Setting up solution | Invoke setup-solution skill (conditional) |
| 4 | Export solution | Exporting solution | Invoke export-solution skill |
| 5..N | Import to {targetLabel} | Importing solution | Switch PAC CLI context, invoke import-solution (one task per target) |
| N+1 | Activate site in {targetLabel} | Activating site | Check activation status, invoke activate-site if not yet provisioned (one task per target, optional) |
| N+2 | Finalize | Finalizing | Update HTML status, commit, run skill tracking |

If `SOLUTION_DONE = true`, add `(will skip — already set up)` to the setup-solution task description.
If `PIPELINE_DONE = true` (PP path), add `(will skip — already set up)` to the setup-pipeline task description.

**Activation steps (PP path):** Create a separate **"Activate site in {stageName}"** task for every target stage. After each `deploy-pipeline` invocation succeeds, the activation task for that stage runs immediately — do not wait until all stages are deployed. The planData `steps` array must include one `"Deploy to {stageName}"` + one `"Activate site in {stageName}"` pair per target stage. Activation happens after every stage deployment — not just Production.

**Activation steps (Manual path):** For the Manual path, create one "Activate site in {targetLabel}" task per target environment. These run after the corresponding import completes.

Mark task 1 ("Generate ALM plan") as `in_progress`.

### Build planData

Build a `planData` object with all gathered strategy inputs:

```json
{
  "SITE_NAME": "{siteName}",
  "GENERATED_AT": "{ISO timestamp}",
  "STRATEGY": "pp-pipelines | manual",
  "EXPORT_TYPE": "managed | unmanaged",   // PP Pipelines path: always "managed"
  "APPROVAL_MODE": "{approvalMode description}",
  "GIT_STATUS": "yes | no | not-yet",
  "HAS_ENV_VARS": true | false,
  "SOLUTION_DONE": true | false,
  "PIPELINE_DONE": true | false,
  "PLAN_STATUS": "Draft",
  "APPROVED_BY": "",
  "APPROVAL_DATE": "",
  "stages": [
    { "label": "Dev", "envUrl": "{devEnvUrl}", "type": "source" },
    { "label": "Staging", "envUrl": "{stagingUrl}", "type": "target" },
    { "label": "Production", "envUrl": "{prodUrl}", "type": "target" }
  ],
  "steps": [
    { "name": "Setup solution", "status": "pending", "skip": false },
    { "name": "Setup pipeline", "status": "pending", "skip": false },
    { "name": "Deploy via pipeline to Staging", "status": "pending", "skip": false },
    { "name": "Activate site in Staging", "status": "pending", "skip": false },
    { "name": "Deploy via pipeline to Production", "status": "pending", "skip": false },
    { "name": "Activate site in Production", "status": "pending", "skip": false }
  ],
  "risks": [
    { "type": "info", "message": "..." }
  ],
  "solutionContents": {
    "tables": ["{table1}", "{table2}"],
    "botComponents": [{ "name": "..." }],
    "siteSettings": {
      "keepAsIs": [{ "name": "..." }],
      "promoteToEnvVar": [{ "name": "...", "value": "..." }],
      "excluded": [{ "name": "..." }]
    }
  },

  // --- v2 fields from the split decision tree (Phase 1 Step 10) ---
  "sizeAnalysis": { /* tier-classified signals from SPLIT_PLAN.sizeAnalysis */ },
  "assetAdvisory": { /* candidates + recommendation from SPLIT_PLAN.assetAdvisory */ },
  "splitStrategy": "single | strategy-1-layer | strategy-2-change-frequency | strategy-3-schema-segmentation | strategy-4-config-isolation",
  "appliedStrategies": ["strategy-1-layer"],
  "proposedSolutions": [ /* from SPLIT_PLAN.proposedSolutions */ ],
  "recommendations": [ /* from SPLIT_PLAN.recommendations */ ],
  "envVars": [ /* optional: env var metadata with per-environment values */ ],
  "breakdown": { /* bytes-per-category from the estimate */ },
  "estimationMethod": "metadata-based",
  "estimationAccuracyPct": 15
}
```

`solutionContents` is populated from `SOLUTION_CONTENTS_DATA` built in Phase 1. If discovery was unavailable, pass `null` — the renderer will show a fallback note.

**v2 fields** (`sizeAnalysis`, `assetAdvisory`, `splitStrategy`, `proposedSolutions`, `recommendations`, `envVars`, `breakdown`) come straight from `SPLIT_PLAN` computed in Phase 1 Step 10, mutated by Q1b user choices. Pass them through unchanged to the renderer.

Populate `risks` based on gathered data:
- If `HAS_ENV_VARS = true`: `{ type: "warning", message: "This solution has environment variables — you will be prompted for per-stage values during deployment." }`
- If `GIT_STATUS = "no"`: `{ type: "info", message: "Consider enabling source control to track changes before deploying to production." }`
- If `EXPORT_TYPE = "unmanaged"` and strategy includes a production target: `{ type: "warning", message: "Unmanaged solutions can be edited in the target environment — consider using Managed for production." }`
- If `SOLUTION_DONE = false`: `{ type: "info", message: "A Dataverse solution will be created first — publisher prefix is irreversible once chosen." }`

Write `planData` to `docs/.alm-plan-data.json` (create `docs/` if it doesn't exist).

### Render the HTML plan

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/plan-alm/scripts/render-alm-plan.js" \
  --output "<projectRoot>/docs/alm-plan.html" \
  --data "<projectRoot>/docs/.alm-plan-data.json"
```

Delete `docs/.alm-plan-data.json` after success.

Write `.alm-plan-context.json` to the project root (persists so `setup-solution` can read it):
```json
{
  "generatedAt": "{ISO timestamp}",
  "siteName": "{siteName}",
  "siteSettings": {
    "keepAsIs": [{name}],
    "authNoValue": [{name}],
    "promoteToEnvVar": [{name, value}],
    "excluded": [{name}]
  }
}
```
This file is intentionally NOT deleted — `setup-solution` and other skills read it to skip re-discovery.

Mark task 1 as `completed`.

---

## Phase 4 — Present Plan and Get Approval

Mark task 2 ("Approve ALM plan") as `in_progress`.

Present a concise inline Markdown summary:

```
## ALM Plan: {siteName}

**Strategy:** {PP Pipelines / Manual export/import}
**Stages:** {Dev} → {Staging} → {Production (if applicable)}
**Approval gates:** {description from PP_APPROVAL_MODE, or "N/A — manual path"}
**Solution export:** {Managed / Unmanaged}

**Steps that will run:**
- [ ] Setup solution {(SKIP — already set up) if SOLUTION_DONE}
- [ ] Setup pipeline {(SKIP — already set up) if PIPELINE_DONE} {(PP path only)}
- [ ] Export solution {(manual path only)}
- [ ] Import to {targetLabel} × {N} {(manual path only)}
- [ ] Deploy via pipeline {(PP path only)}

Full plan written to: docs/alm-plan.html
```

Ask via `AskUserQuestion`:
> "Does this ALM plan look correct?"

Options:
1. **Approve and execute the plan**
2. **Save plan but execute manually later**
3. **I want to change something** — go back to questions

- **If option 3:** Re-run Phase 2 (ask which section to change, then re-gather those answers). Regenerate the plan (repeat Phase 3). Re-present for approval.
- **If option 2:** Update HTML plan footer `plan-status` span to "Approved — Deferred" via `Edit` tool. Commit `docs/alm-plan.html` with message `"Add ALM plan for {siteName} (deferred)"`. Show next steps for manual execution. Mark task 2 as `completed`. Exit the skill.
- **If option 1:** Update the HTML plan `<span class="plan-status">` to "In Execution" via `Edit` tool. Record the approval timestamp in the HTML (`<span id="approval-date">`) by replacing the empty value. Mark task 2 as `completed`.

---

## Phase 5 — Execute: setup-solution (conditional)

**If `SOLUTION_DONE = true`:**
Mark the "Setup solution" task as `completed` with description "Skipped — solution already configured". Update the HTML checklist step for "Setup solution" to `status-skipped` via `Edit` tool. Skip to Phase 6.

**If `SOLUTION_DONE = false`:**
Mark the "Setup solution" task as `in_progress`. Update the HTML checklist step to `status-in-progress` via `Edit` tool.

Invoke the skill:
```
/power-pages:setup-solution
```

After completion: mark the task as `completed`. Update the HTML checklist step to `status-completed` via `Edit` tool.

---

## Phase 6 — Execute: setup-pipeline OR export-solution

### PP Pipelines path

**If `PIPELINE_DONE = true`:**
Mark the "Setup pipeline" task as `completed` with description "Skipped — pipeline already configured". Update HTML checklist step to `status-skipped`. Skip to Phase 7.

**If `PIPELINE_DONE = false`:**
Mark the "Setup pipeline" task as `in_progress`. Update HTML checklist step to `status-in-progress`.

Invoke the skill:
```
/power-pages:setup-pipeline
```

After completion: mark task as `completed`. Update HTML checklist step to `status-completed`.

### Manual path

Mark the "Export solution" task as `in_progress`. Update HTML checklist step to `status-in-progress`.

Invoke the skill:
```
/power-pages:export-solution
```

After completion: mark task as `completed`. Update HTML checklist step to `status-completed`.

**If `MANUAL_CHECKPOINT = true`:** Ask via `AskUserQuestion`:
> "Export complete. Review the solution zip at `{zipPath}` before importing. Ready to proceed with import?"

Options:
1. Yes, proceed with import
2. Stop here — I'll import manually later

If option 2: update HTML plan footer to "Approved — Deferred (paused after export)". Commit `docs/alm-plan.html`. Exit.

---

## Phase 7 — Execute: Deploy

### PP Pipelines path

**For each target stage in `PP_STAGES` (e.g. Staging, then Production), run this loop:**

**Step A — Deploy:**
Mark the "Deploy to {stageName}" task as `in_progress`. Update HTML checklist step to `status-in-progress`.

Invoke the skill:
```
/power-pages:deploy-pipeline
```

After completion: mark deploy task as `completed`. Update HTML checklist step to `status-completed`.

**Step B — Activate (immediately after deploy for this stage):**
Mark the "Activate site in {stageName}" task as `in_progress`. Update HTML checklist step to `status-in-progress`.

Read `.last-deploy.json` to check whether activation already happened inside `deploy-pipeline`:
```bash
node -e "const d=require('./.last-deploy.json'); process.stdout.write(JSON.stringify({activationStatus: d.activationStatus, siteUrl: d.siteUrl}))"
```

- `activationStatus === "Activated"`: site is live. Mark task `completed`. Update checklist step to `status-completed`. Show site URL.
- `activationStatus === "Pending"` or `null`: activation was deferred or didn't run. Switch PAC CLI to the target environment and ask via `AskUserQuestion`:

  > "**{siteName}** was deployed to **{stageName}** successfully. The site is not yet activated (not publicly accessible). Activate it now?"

  Options:
  1. **Yes, activate now** — invoke `/power-pages:activate-site`. After it completes, mark task `completed`, update checklist step to `status-completed`.
  2. **No, skip for now** — mark task `skipped`, update checklist step to `status-skipped`.

After handling activation, switch PAC CLI back to the dev environment:
```bash
pac env select --environment "{devEnvUrl}"
```

**Then repeat Step A + B for the next stage** (if any).

### Manual path (one import per target environment)

For each entry in `MANUAL_TARGETS`:

1. Mark the "Import to {targetLabel}" task as `in_progress`. Update the corresponding HTML checklist step to `status-in-progress`.

2. Switch the PAC CLI context to the target environment:
   ```bash
   pac env select --environment "{targetEnvUrl}"
   ```

3. Invoke the skill:
   ```
   /power-pages:import-solution
   ```

4. After completion: mark the task as `completed`. Update the HTML checklist step to `status-completed`.

5. **Activate site in {targetLabel}** (optional) — mark the "Activate site in {targetLabel}" task as `in_progress`. Update HTML checklist step to `status-in-progress`.

   PAC CLI is already pointing to the target environment from step 2. Run the activation check:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/check-activation-status.js" --projectRoot "."
   ```

   - **`activated: true`**: Site is already live. Mark task as `completed`. Update checklist step to `status-completed`.
   - **`activated: false`**: Invoke `/power-pages:activate-site`. After completion, mark task as `completed`. Update checklist step to `status-completed`.
   - **`error`**: Mark task as `skipped`. Note error in summary.

After all imports: switch PAC CLI back to the dev environment:
```bash
pac env select --environment "{devEnvUrl}"
```

---

## Phase 8 — Finalize

Mark the "Finalize" task as `in_progress`.

### 8.1 Update HTML plan status

Update the HTML plan footer via `Edit` tool:
- Replace `<span class="plan-status">In Execution</span>` with `<span class="plan-status">Completed ✓</span>`
- Replace the completion timestamp placeholder with the current ISO timestamp

### 8.2 Run skill tracking

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/update-skill-tracking.js" \
  --projectRoot "." \
  --skillName "PlanAlm" \
  --authoringTool "ClaudeCode"
```

### 8.3 Commit

```bash
git add docs/alm-plan.html && git commit -m "Add ALM plan for {siteName}"
```

### 8.4 Present final summary

Display a summary:

```
## ALM Complete: {siteName}

**Strategy used:** {PP Pipelines / Manual export/import}
**Skills invoked:** {comma-separated list of skills that ran}

**Artifacts created:**
- docs/alm-plan.html — ALM plan document
- .solution-manifest.json — Solution configuration {(if newly created)}
- .last-pipeline.json — Pipeline configuration {(PP path only, if newly created)}
- .last-deploy.json — Last deployment record {(PP path only)}
- {solutionName}_{managed|unmanaged}.zip — Solution package {(manual path only)}

**Site activation:** {
  PP path: "Activation status per stage is in .last-deploy.json and each deploy history file."
  Manual path: list each target env and its activation status (Activated / Pending)
}
```

Mark the "Finalize" task as `completed`.

---

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| Generate ALM plan | Generating ALM plan | Gather strategy inputs, build planData, render docs/alm-plan.html |
| Approve ALM plan | Awaiting plan approval | Present inline summary + HTML plan path, get user confirmation |
| Setup solution | Setting up solution | Invoke setup-solution skill (skip if .solution-manifest.json exists) |
| Setup pipeline | Setting up pipeline | Invoke setup-pipeline skill — PP Pipelines path only (skip if .last-pipeline.json exists) |
| Export solution | Exporting solution | Invoke export-solution skill — Manual path only |
| Deploy to {stageName} | Deploying to {stageName} | Invoke deploy-pipeline skill — PP Pipelines path, one task per target stage |
| Activate site in {stageName} | Activating site in {stageName} | Check activation status + invoke activate-site immediately after each stage deploys — one task per target stage |
| Import to {targetEnv} | Importing solution | Switch PAC CLI context, invoke import-solution — Manual path, one task per target |
| Activate site in {targetEnv} | Activating site | Check activation status + invoke activate-site if needed — Manual path, one task per target |
| Finalize | Finalizing | Update HTML plan status, commit, run skill tracking, present summary |

---

## Key Decision Points (Wait for User)

1. **Phase 2, Q1**: Solution setup — confirm existing or include `setup-solution` in plan
2. **Phase 2, Q2**: Promotion strategy — PP Pipelines, Manual, or already set up
3. **Phase 2, Q3–Q7** (PP path): Stage count, host env, approval gates (managed auto-set), Git status
   **Phase 2, Q3–Q7** (Manual path): Target count, target env URLs, export type, checkpoint pause, Git status
4. **Phase 4**: Plan approval — execute, defer, or revise
5. **Phase 6, Manual**: Checkpoint pause after export (if Q6 = Yes)
6. **Phase 7 (delegated)**: Each invoked skill has its own approval gates

## Error Handling

- No `powerpages.config.json`: stop, advise `/power-pages:create-site`
- `pac env list` fails: skip ENV_LIST pre-filling; ask for environment URLs manually
- `render-alm-plan.js` fails (non-zero exit): report error, show planData JSON as fallback, ask user whether to proceed
- Invoked skill fails: report the failure, mark the task as blocked, ask user whether to retry or exit
- Plan approval = option 3 (change something): re-run Phase 2 fully, then regenerate plan — do not carry over stale answers
