---
name: deploy-pipeline
description: >-
  Triggers a Power Platform Pipeline deployment run for a Power Pages solution.
  Selects a target stage, validates the package, optionally configures deployment
  settings (environment variables, connection references), then deploys and polls
  for completion. Use when asked to: "deploy pipeline", "run pipeline",
  "trigger deployment", "deploy to staging", "deploy to production",
  "run power platform pipeline", "deploy solution via pipeline",
  "promote solution", "push to staging", "push to production".
user-invocable: true
argument-hint: "Optional: stage name or environment label (e.g. 'staging', 'production') to skip stage selection"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_search, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_fetch
model: opus
---

# deploy-pipeline

Triggers a **Power Platform Pipeline** deployment run. Reads the existing pipeline configuration from `docs/alm/last-pipeline.json`, selects a target stage, validates the solution package, and deploys it to the target environment.

> **Prerequisite**: Run `/power-pages:setup-pipeline` first to create the pipeline configuration.

> Refer to `${CLAUDE_PLUGIN_ROOT}/references/cicd-pipeline-patterns.md` for all HAR-confirmed API patterns used in this skill.

## Prerequisites

> **Important**: The source (dev) environment must have a Power Platform Pipelines host environment configured. This is set in Power Platform Admin Center (Environments → select env → Pipelines) or via the tenant-level `DefaultCustomPipelinesHostEnvForTenant` setting. Without this configuration, `pac pipeline deploy` will fail. The `setup-pipeline` skill creates the pipeline definition in the host; this admin step connects the dev environment to that host.

- `docs/alm/last-pipeline.json` exists (created by `setup-pipeline`)
- `.solution-manifest.json` exists
- Azure CLI logged in (`az account show` succeeds)
- PAC CLI logged in (`pac env who` succeeds)

## Phases

### Phase 0 — ALM plan gate

> **`plan-alm` is the front door.** When the user expresses an ALM intent (*promote / ship / deploy / move to staging / push to prod / release this version*), the orchestrator (`/power-pages:plan-alm`) should run first. Direct invocation of `deploy-pipeline` bypasses the orchestrator's pre-plan completeness check, env-var resolution per stage, activation steps, and validation runs. This gate makes that bypass explicit.

**Skip rule.** If this skill was invoked *by* `plan-alm` (the orchestrator passes `INVOKED_BY_PLAN_ALM = true` in its execution context), skip Phase 0 entirely and proceed to Phase 1. Detect this via either:
- An environment variable / arg flag set by the orchestrator, or
- The presence of `docs/.alm-plan-data.json` with `PLAN_STATUS === "In Execution"` AND a recent (`< 5min`) timestamp on the file.

**Step 1 — Run the gate helper.**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/check-alm-plan.js" \
  --projectRoot "." \
  --envUrl "{devEnvUrl}" \
  --token "{token}" \
  --solutionId "{solutionId from .solution-manifest.json, if available}"
```

The helper returns JSON with `{ exists, stale, staleness: { reason, detail }, generatedAt, planStatus, ... }`. The freshness check requires env credentials + solutionId; without those the helper does an existence-only check.

**Step 2 — Branch on the result.**

| Result | Behavior |
|---|---|
| `deferred: true` | The user has explicitly deferred ALM for this project (`.alm-deferred` marker present). Pass through silently to Phase 1 — do not nag. |
| `exists: false` | The user hasn't run `plan-alm` yet. See Step 3. |
| `exists: true, stale: false` | Plan is current. Pass through silently to Phase 1. |
| `exists: true, stale: true` (reason: `solution-modified`) | The solution changed after the plan was generated. See Step 4. |

**Step 3 — No plan.** Tell the user:

> "No ALM plan exists for this project. `/power-pages:plan-alm` builds one — it detects the project state, asks about your promotion strategy, and orchestrates this skill in the right order alongside setup-solution / setup-pipeline / activate-site / test-site. Want me to run plan-alm now?"

<!-- gate: deploy-pipeline:0.no-plan | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · deploy-pipeline:0.no-plan):** Fail-closed entry gate when `check-alm-plan.js` returns `exists:false`. Helper-script-backed.

`AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Run `/power-pages:plan-alm` first? | ALM plan gate | Yes — run /power-pages:plan-alm now (Recommended), Continue without a plan (advanced — I just want to deploy), Cancel |

- **Yes (Recommended)** → invoke `/power-pages:plan-alm`. plan-alm's Phase 7 dispatches back into this skill at the appropriate stage.
- **Continue without a plan** → set `BYPASSED_PLAN_GATE = true` and proceed to Phase 1. The deploy will still work, but env-var per-stage values, activation, and post-deploy validation aren't orchestrated.
- **Cancel** → exit cleanly.

**Step 4 — Stale plan.** Tell the user:

> "ALM plan exists from `{generatedAt}` but the source solution has been modified since (at `{solution.modifiedon}`). The plan's component count, size analysis, and split decisions may be outdated. Re-running `plan-alm` will refresh the analysis."

<!-- gate: deploy-pipeline:0.stale-plan | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · deploy-pipeline:0.stale-plan):** Fail-closed entry gate when `check-alm-plan.js` returns `stale:true`. Helper-script-backed.

`AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Refresh the plan first? | ALM plan freshness | Refresh — re-run /power-pages:plan-alm (Recommended), Continue with the existing plan, Cancel |

- **Refresh (Recommended)** → invoke `/power-pages:plan-alm`. After completion, re-run the Phase 0 helper once to confirm freshness; if still stale, surface the detail and proceed to Phase 1 anyway (don't infinite-loop).
- **Continue** → set `STALE_PLAN_ACK = true` and proceed to Phase 1.
- **Cancel** → exit cleanly.

**Relationship to Phase 3.5 (pre-deploy completeness check).** Phase 3.5 (later in this skill) catches solution gaps right before deploy. Phase 0 catches the *bigger* miss: the user who never ran the orchestrator at all and is about to push a half-baked deploy through. The two are complementary.

### Phase 1 — Verify Prerequisites

**Create all tasks upfront at the start of this phase.**

Tasks to create:
1. "Verify prerequisites"
2. "Select target stage"
3. "Resolve pipeline info"
4. "Validate package"
5. "Configure deployment settings"
6. "Deploy and monitor"
7. "Write deployment record"

Steps:

1. Run `verify-alm-prerequisites.js` to confirm PAC CLI auth, acquire a token, and verify API access:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/verify-alm-prerequisites.js" --require-manifest
   ```
   Capture output as JSON; extract `.envUrl` (store as `devEnvUrl`) and `.token` (store as `DEV_TOKEN`). If the script exits non-zero, stop and surface the error — it will indicate whether `az login`, `pac auth`, or WhoAmI failed.

2. Run `detect-project-context.js` to read project config and solution manifest:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/detect-project-context.js"
   ```
   Capture output as JSON; extract `.solutionManifest` (store as `solutionManifest`), `.siteName` (store as `siteName`), and `.websiteRecordId`. If `solutionManifest` is null, continue — the manifest is not strictly required at this step (solution info will come from `docs/alm/last-pipeline.json`).

3. Locate `docs/alm/last-pipeline.json` — if not found, stop and advise running `/power-pages:setup-pipeline` first.

   **Manifest version check:**
   - If `schemaVersion === 3`, set `MULTI_RUN_MODE = true` and store `deploymentOrder[]` as `DEPLOYMENT_ORDER`. There is a **single pipeline** with a single set of stages; multi-solution is expressed via N stage runs against the same stage, one per solution in `order`. This is the current recommended layout.
   - If `schemaVersion === 2` (legacy), set `MULTI_PIPELINE_MODE = true` and store `pipelines[]` as `PIPELINES_LIST`. The skill falls back to the older "loop over N separate `deploymentpipelines` records" behavior. Advise the user to re-run `setup-pipeline` to migrate to v3.
   - Otherwise read `pipelineId`, `pipelineName`, `hostEnvUrl`, `sourceDeploymentEnvironmentId`, `solutionName`, `stages[]` (single-solution mode — existing behavior).

   **In `MULTI_RUN_MODE`**, resolve `solutionName` + `solutionId` per iteration of `DEPLOYMENT_ORDER`. Entries where `status === "skipped-empty"` (typically the `{Prefix}_Future` buffer) are short-circuited — no stage run is created for them. The single `pipelineId` / `hostEnvUrl` / `sourceDeploymentEnvironmentId` apply to every run.

   **In `MULTI_PIPELINE_MODE`** (legacy v2), resolve `solutionName` per pipeline in the loop (not globally). All pipelines share the same `hostEnvUrl` and `sourceDeploymentEnvironmentId`.

4. Acquire host environment token:
   ```bash
   az account get-access-token --resource "{hostEnvOrigin}" --query accessToken -o tsv 2>/dev/null
   ```
   Where `hostEnvOrigin` = scheme + host of `hostEnvUrl`. Store as `HOST_TOKEN`. If acquisition fails, stop with instructions to check Azure CLI auth.

5. If `solutionManifest` is available, read `solutionManifest.solution.solutionId` and `solutionManifest.solution.uniqueName` from the detected context. Otherwise, use `solutionName` from `docs/alm/last-pipeline.json`.

6. Report: "Pipeline: `{pipelineName}`. Solution: `{solutionName}`. Available stages: `{stage names}`."

### Phase 1.5 — Ground in current Pipelines deployment documentation

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/alm-docs-grounding.md`

Cap this step at ~30 seconds. If MCP search / fetch errors out, log a one-line note and continue — this skill must remain runnable offline.

1. Run `microsoft_docs_search` with the query: `Power Platform Pipelines stage run validation ValidatePackageAsync DeployPackageAsync approval`.
2. Fetch `https://learn.microsoft.com/en-us/power-platform/alm/pipelines` (and at most one sister page on stage runs, validation, or approval gates) in parallel via `microsoft_docs_fetch`.
3. Extract a one-paragraph summary of what Microsoft Learn currently says about stage-run lifecycle, validation outcomes, approval-gate workflow, and `deploymentsettingsjson` overrides. Compare against `${CLAUDE_PLUGIN_ROOT}/references/cicd-pipeline-patterns.md` and flag any divergence (new status codes, changed `stagerunstatus` terminal values, new approval-gate API).
4. Use the summary to inform Phase 2+ decisions. Do not silently change skill behavior — surface any divergence to the user as a soft warning before Phase 4 (Create Stage Run + Validate Package).

### Phase 2 — Select Target Stage

If the user passed a stage name or environment label as an argument (e.g., `staging`), match it against stages in `docs/alm/last-pipeline.json` and skip this question.

<!-- gate: deploy-pipeline:2.stage | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · deploy-pipeline:2.stage):** Pick target stage — Staging / Production / etc. Wrong stage selection here is the biggest single failure mode of this skill.

Otherwise, ask via `AskUserQuestion`:

> "Which environment do you want to deploy to?
> {numbered list of stages from docs/alm/last-pipeline.json, e.g.:
> 1. Deploy to Staging → {stagingEnvUrl}
> 2. Deploy to Production → {prodEnvUrl}}"

Store selected stage as `SELECTED_STAGE` (with `stageId`, `name`, `targetDeploymentEnvironmentId`, `targetEnvironmentUrl`).

**In `MULTI_RUN_MODE` (v3 — recommended):** The selected stage is looked up once from the single `stages[]` array. The skill then **loops over `DEPLOYMENT_ORDER`** in `order`, creating one stage run per solution against the same `stageId`:
1. For each entry in `DEPLOYMENT_ORDER` where `status !== "skipped-empty"`: resolve its `solutionUniqueName` + `solutionId`, set `ARTIFACT_SOLUTION_NAME` / `ARTIFACT_SOLUTION_ID`, then run Phases 3–6 (resolve info → validate → configure → **fire Phase 6.0 consent gate** → deploy → poll) against the same pipeline.
2. If any iteration fails (validation or deployment), halt the loop and report **which solution** failed and which had already landed.
3. Write one `docs/alm/last-deploy.json` at the end summarizing all runs for the selected stage. Record per-solution `status` (`Succeeded` / `Failed` / `NotAttempted` / `SkippedEmpty`) plus the shared `pipelineId`.

> **⚠ Per-iteration gate firing — non-negotiable.** Inside the loop, the **full Phase 3 → 3.5 → 4 → 5 → 6.0 → 6.1 → 6.2 → 7 sequence runs for each solution.** Do NOT batch validation across solutions, do NOT batch the Phase 6.0 consent gate, and do NOT treat any upstream answer (Phase 2 stage selection, `--stage` argument, the previous iteration's "Deploy now") as covering subsequent iterations. The Phase 6.0 gate fires `N` times for `N` non-skipped solutions in `DEPLOYMENT_ORDER`. If you find yourself proceeding from iteration 1's success directly to iteration 2's `DeployPackageAsync` without a fresh Phase 6.0 prompt, you have skipped the gate.

**In `MULTI_PIPELINE_MODE` (v2 — legacy):** The selected stage label (e.g., "Staging") is matched against each pipeline's `stages[]` — each pipeline has its own `stageId` for the same target environment. All subsequent phases (validate, deploy, poll) are looped over `PIPELINES_LIST` in `order`:
1. Loop iteration i: use `pipelines[i].stageId` where stage label matches `SELECTED_STAGE.name`, `pipelines[i].solutionName`, etc.
2. If any iteration fails (validation or deployment), halt the loop and report which pipeline failed and which were already deployed.
3. Write one `docs/alm/last-deploy.json` at the end summarizing all pipeline runs for this stage. Record per-pipeline `status` (`Succeeded` / `Failed` / `NotAttempted`) so a retry can tell which ones still need to run.

> **⚠ Per-iteration gate firing also applies here.** Same rule as MULTI_RUN_MODE: each pipeline in the loop gets its own Phase 4 / 5 / 6.0 / 6.1 / 6.2 sequence. The Phase 6.0 consent gate fires once per pipeline. Do NOT batch.

> **Partial-deploy risk.** When the loop halts (e.g., `Core` succeeded, `WebAssets` failed), the target environment is left in a mixed state — there is no automatic rollback of solutions that already imported. The per-solution (v3) or per-pipeline (v2) `status` in `docs/alm/last-deploy.json` is the source of truth for what landed. When the user re-runs `deploy-pipeline` after fixing the failure, the loop iterates all entries again from the start; rely on the solution-import idempotency (same version = no-op) rather than skipping. Warn the user of this before starting a multi-solution deploy to production.

Check `docs/alm/last-deploy.json` — if the last deployment to this stage failed, warn the user:
> "The last deployment to `{stageName}` had status: **Failed**. Would you like to retry? 1. Yes, retry / 2. No, cancel"

### Phase 2.5 — Pre-flight: target env blocked-attachments check

Power Pages code-site solutions almost always contain `.js` bundle chunks (Vite/Rollup output) as `Web File` components. If the target env's `blockedattachments` setting includes `.js`, `ImportSolutionAsync` will reject every web-file write — typically 50-75 minutes into an import for sites with thousands of bundle chunks (real-world: a Content solution failed at 3,909 rejected `.js` files on Staging after the same issue had already been fixed on Dev). The reactive Phase 7.6 handler will detect this and offer unblock-and-retry, but the user has already burned an hour. This pre-flight catches it in 10 seconds.

**Skip rule.** This check is for Power Pages projects only. Skip when `powerpages.config.json` has no `websiteRecordId` (non-Power-Pages ALM run — pure data-model solution, etc.). Skip when the user's plan/manifest indicates no solution being deployed has `Web File` componentType (rare in code-site projects but possible for back-end-only solutions).

**Detection signal.** In MULTI_RUN_MODE / MULTI_PIPELINE_MODE: read `.solution-manifest.json` and check whether any entry in `solutions[]` has `componentTypes` including `"Web File"`. In single-solution mode: assume `true` for any Power Pages project (the umbrella solution carries web files).

**Steps:**

1. Switch PAC CLI context to the **target** environment so `fix-blocked-attachments.js` queries the right env:
   ```bash
   pac env select --environment "{SELECTED_STAGE.targetEnvironmentUrl}"
   ```

2. Run the helper in dry-run mode to detect the current state:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/fix-blocked-attachments.js" \
     --envUrl "{SELECTED_STAGE.targetEnvironmentUrl}" \
     --extensions js,css \
     --dry-run
   ```

3. Capture the output as JSON. Inspect `wasBlocked[]`:

   - **`wasBlocked: []`** → target env doesn't block the relevant extensions. Switch PAC CLI back to source (`pac env select --environment "{sourceEnvUrl}"`) and proceed to Phase 3. No prompt, no noise.

   <!-- gate: deploy-pipeline:2.5.blocked-attachments | category=consent | cancel-leaves=attachment-block-modified -->
   > 🚦 **Gate (consent · deploy-pipeline:2.5.blocked-attachments):** Pre-flight — modify target env's `blockedattachments` security setting (tenant-wide impact). Reversible from PPAC. Skipping costs 50–75 min of wasted import.

   - **`wasBlocked: ["js"]` or includes other media-relevant extensions** → the deployment WILL fail mid-import. Prompt the user immediately via `AskUserQuestion` (do NOT bury this in chat — it MUST gate Phase 3 progression):

     > **Pre-flight detected an issue.** The target environment **`{targetEnvName}`** currently blocks file types that this solution needs: **`{wasBlocked.join(', ')}`**. Power Pages code sites ship `.js` bundle chunks as web files — if you proceed without unblocking, the deployment will run for ~50-75 minutes and then fail (the failure is recoverable via Phase 7.6's retry path, but the wasted time is not). The block can be removed in 10 seconds.
     >
     > **Note**: this modifies an environment-level security setting that affects all users of `{targetEnvName}`. Reversible from PPAC → Environments → `{targetEnvName}` → Settings → Product → Features → Blocked Attachments.

     | Question | Header | Options |
     |---|---|---|
     | Allow removing the block on `{wasBlocked.join(', ')}` for the `{targetEnvName}` environment so the deployment can proceed? | Unblock attachments | Yes — unblock these types and continue, No — proceed anyway (Phase 7.6 will catch the failure after deploy and prompt again), Cancel deploy |

4. Branch on the answer:

   - **Yes — unblock and continue**: invoke `fix-blocked-attachments.js` **without** `--dry-run` (same `--extensions`). Read the result and confirm `changed: true` + `removed[]` is non-empty. Switch PAC CLI back to source (`pac env select --environment "{sourceEnvUrl}"`). Proceed to Phase 3. Record the unblock action in the eventual `docs/alm/last-deploy.json` `preflightActions[]` block so the deploy summary has an audit trail.

   - **No — proceed anyway**: leave the setting unchanged. Switch PAC CLI back to source. Proceed to Phase 3. Tell the user clearly: *"Continuing without unblocking. If the deployment fails on `AttachmentBlocked`, Phase 7.6 will offer the same unblock prompt — but you'll have spent ~50-75 minutes getting there."*

   - **Cancel deploy**: stop cleanly. Do not modify any environment setting. Do not create the stage run. Tell the user how to re-invoke when ready.

5. **Always** switch PAC CLI back to the source environment before exiting this phase. Subsequent phases assume PAC points at the source unless they explicitly switch to the target.

> **Why pre-flight + reactive both exist.** The reactive Phase 7.6 handler stays in place because (a) the pre-flight only inspects the env-level `blockedattachments` setting — there are other rare blocked-attachment causes (per-table file column attachment policies) that only surface during the actual import; (b) the env's blocklist could change between pre-flight and import (rare but possible if another admin edits it concurrently); (c) backward compatibility with existing flows where the user invoked `deploy-pipeline` directly and skipped Phase 2.5 via legacy SKILL.md. The two paths are complementary, not redundant.

### Phase 3 — Resolve Pipeline Info

Call `RetrieveDeploymentPipelineInfo` to get the authoritative source environment ID and available solution artifacts:

```
GET {hostEnvUrl}/api/data/v9.1/RetrieveDeploymentPipelineInfo(DeploymentPipelineId={pipelineId},SourceEnvironmentId='{BAP_SOURCE_ENV_ID}',ArtifactName='{solutionName}')
Authorization: Bearer {HOST_TOKEN}
OData-MaxVersion: 4.0
OData-Version: 4.0
Accept: application/json
```

Where `BAP_SOURCE_ENV_ID` = the BAP GUID of the dev environment (from `pac env list`, stored in `docs/alm/last-pipeline.json` or available from `pac env who`).

Extract:
- `SourceDeploymentEnvironmentId` — use as the `devdeploymentenvironment` binding in the stage run. Store as `sourceDeploymentEnvironmentId`.
- `StageRunsDetails[].DeploymentStage` — confirms available stages and their IDs
- `EnableAIDeploymentNotes` — store as `AI_NOTES_ENABLED` (bool)

Use `solutionId` from `.solution-manifest.json` as `ARTIFACT_SOLUTION_ID` and `uniqueName` as `ARTIFACT_SOLUTION_NAME`.

> **If `RetrieveDeploymentPipelineInfo` returns 404** (older Pipelines package): use the navigation property to find the source deployment environment:
> ```
> GET {hostEnvUrl}/api/data/v9.1/deploymentpipelines({pipelineId})/deploymentpipeline_deploymentenvironment?$select=deploymentenvironmentid,name,environmenttype
> ```
> Filter for `environmenttype = 200000000` to get the source record. Use `deploymentenvironmentid` as the `sourceDeploymentEnvironmentId`. For the artifact/solution list, use `sourceDeploymentEnvironmentId` from `docs/alm/last-pipeline.json` and `solutionName` from `.solution-manifest.json` as fallbacks. Set a flag `VALIDATE_PACKAGE_UNAVAILABLE = true` to skip Phase 4.2–4.3 and use the PAC CLI path in Phase 6.

### Phase 3.5 — Pre-deploy Completeness Check

A pipeline's `ValidatePackageAsync` confirms the solution zip is importable on the target, but it does **not** tell you whether the solution zip itself covers every component that exists on the source site. Components added after `setup-solution` last ran (server logic, cloud flows, bots, env vars, etc.) can be silently left behind.

Run the shared site-inventory helper against the **source (dev) environment**:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/discover-site-components.js" \
  --envUrl "{devEnvUrl}" --token "{DEV_TOKEN}" \
  --siteId "{websiteRecordId from .solution-manifest.json}" \
  --publisherPrefix "{publisherPrefix from .solution-manifest.json}" \
  --solutionId "{solutionId from .solution-manifest.json}"
```

Parse stdout and evaluate `missing.*`. **Before doing anything else**, capture the **pre-sync state** so a post-sync re-confirmation gate can show what changed:

```
PRE_SYNC_VERSION = solutionManifest.solution.version   // from .solution-manifest.json read in Phase 1
PRE_SYNC_MISSING = { siteComponents, siteLanguages, cloudFlows, envVarDefinitions, customTables, ... }   // from the discovery stdout above
```

Then:

- **All `missing.*` empty** → proceed to Phase 4.
<!-- gate: deploy-pipeline:3.5.completeness | category=progress | cancel-leaves=nothing -->
> 🚦 **Gate (progress · deploy-pipeline:3.5.completeness):** Source solution incomplete vs live site. Sync first, deploy anyway (gap ships), or cancel.

- **Any non-empty** → report a short summary ("Solution is missing {N} components"). Ask via `AskUserQuestion`:
  > "The source solution appears incomplete relative to the live site. What would you like to do?
  > 1. **Run `/power-pages:setup-solution` now** (sync mode) — adopts missing components and bumps the version, then re-confirm with you before deploying (Recommended)
  > 2. **Deploy anyway** — the missing components will not reach the target
  > 3. **Cancel** — I'll investigate first"

  - **Option 1 — Sync first, then re-confirm before deploy:**
    1. Invoke `/power-pages:setup-solution` (auto-detects the existing manifest, enters sync mode, adopts missing components, bumps the version). Wait for completion.
    2. Re-read `.solution-manifest.json` and capture `POST_SYNC_VERSION = solutionManifest.solution.version`.
    3. Re-run the discovery helper. If any `missing.*` remain non-empty, repeat the Phase 3.5 prompt above.
    4. Otherwise compute `NEWLY_ADOPTED` as a per-category set difference between `PRE_SYNC_MISSING` and the second discovery run's `missing.*` (the items that disappeared are what setup-solution just adopted into the solution). Total count = sum of all category lengths.
    <!-- gate: deploy-pipeline:3.5.post-sync | category=progress | cancel-leaves=nothing -->
    > 🚦 **Gate (progress · deploy-pipeline:3.5.post-sync):** Post-sync re-confirm. Solution version bumped + components adopted — user inspects delta before deploy proceeds.

    5. **Re-confirm with the user before proceeding to Phase 4** — the solution about to ship is now different from what the user originally saw when they started the deploy. Use `AskUserQuestion`:

       > "Sync complete.
       >
       > **{solutionUniqueName}** is now **v{POST_SYNC_VERSION}** (was v{PRE_SYNC_VERSION}) with **{NEWLY_ADOPTED.total} newly-adopted components**:
       > - {first 3-5 names by category — prefer high-signal categories: cloud flows, server logic, env var definitions, then site components}
       > - {if more remain: `+ {N} more across {category list}`}
       >
       > About to deploy this updated solution to **{SELECTED_STAGE.name}** ({targetEnvUrl}).
       >
       > Continue with the deployment?"

       | Question | Header | Options |
       |---|---|---|
       | Continue with the deployment? | Post-sync approval | Yes — deploy v{POST_SYNC_VERSION} to {SELECTED_STAGE.name} (Recommended), Pause — I want to review the new solution contents first, Cancel — abort the deploy |

       - **Yes** → proceed to Phase 4 with the post-sync solution.
       - **Pause** → exit deploy-pipeline cleanly with a short note ("Paused after sync. Re-run `/power-pages:deploy-pipeline` when you're ready to ship v{POST_SYNC_VERSION} to {SELECTED_STAGE.name}.") so the user can inspect the synced manifest / Dataverse state and resume manually. **Do not** write `docs/alm/last-deploy.json` — no deployment happened. Skip the skill-tracking call too.
       - **Cancel** → stop the skill. Same no-marker / no-tracking rule applies.
  - **Option 2** — record the deliberate gap in `docs/alm/last-deploy.json` under a `knownGaps` field so the audit trail is preserved.
  - **Option 3** — stop.

> **Why the post-sync gate exists**: this skill is the gate that *promotes a solution to staging or production* — the moment of staging promotion is the last place to catch surprises. When sync mode runs mid-deploy, it produces a different solution version than the one the user had in mind when they invoked the skill. Re-confirming after sync gives the user an explicit chance to inspect the version bump and the list of newly-adopted components before they reach the target environment. The Phase 3.5 trigger is intentional; the post-sync re-confirmation is the safety on top of it. Same principle applies when this skill is invoked from `plan-alm` orchestration — `plan-alm`'s plan approval (Phase 4) covers the pre-sync state; this gate covers the delta introduced by mid-deploy sync.

> **Why Phase 3.5 exists in the first place**: the ALM-aware-by-default rule in `AGENTS.md` requires the completeness check at every gate where a solution leaves its source environment.

### Phase 4 — Create Stage Run + Validate Package

Use Node.js `https` module for all Dataverse calls (curl has encoding issues on Windows).

**4.1 Create stage run** using `create-stage-run.js`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/create-stage-run.js" \
  --hostEnvUrl "{hostEnvUrl}" \
  --token "{HOST_TOKEN}" \
  --pipelineId "{pipelineId}" \
  --stageId "{SELECTED_STAGE.stageId}" \
  --sourceDeploymentEnvironmentId "{sourceDeploymentEnvironmentId}" \
  --solutionId "{ARTIFACT_SOLUTION_ID}" \
  --artifactName "{ARTIFACT_SOLUTION_NAME}"
```

Capture stdout as JSON: `const result = JSON.parse(output)`. Extract `result.stageRunId` and store as `STAGE_RUN_ID`.

If the script exits non-zero, surface the error — likely a pipeline configuration issue (400) or a conflict (409). Both include the Dataverse error body in the message.

> **Note on field bindings**: The script uses the v9.2 API and `msdyn_` prefixed nav properties (`msdyn_pipelineid@odata.bind`, `msdyn_stageid@odata.bind`, `msdyn_sourceenvironmentid@odata.bind`). These are the HAR-confirmed names for the current Pipelines package. Older package versions used different field names (e.g., `deploymentstageid`); the script handles both 201 (JSON body) and 204 (OData-EntityId header) response codes.

Store as `STAGE_RUN_ID`.

**4.2 Trigger package validation** (returns **204** — not 200):

```
POST {hostEnvUrl}/api/data/v9.0/ValidatePackageAsync
Content-Type: application/json
Authorization: Bearer {HOST_TOKEN}

{"StageRunId": "{STAGE_RUN_ID}"}
```

Treat HTTP 204 as success.

> **If `ValidatePackageAsync` returns 404**: this Pipelines package version doesn't support the direct OData validation API. Set `VALIDATE_PACKAGE_UNAVAILABLE = true`. Skip Phase 4.2–4.3 and proceed directly to Phase 5 (deployment settings), then use the `pac pipeline deploy` CLI fallback in Phase 6.

**4.3 Poll validation** using `poll-validation-status.js`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/poll-validation-status.js" \
  --hostEnvUrl "{hostEnvUrl}" \
  --token "{HOST_TOKEN}" \
  --stageRunId "{STAGE_RUN_ID}" \
  --intervalMs 5000 \
  --maxAttempts 36
```

Capture stdout as JSON: `const result = JSON.parse(output)`. On non-zero exit, the error message will include validation failure details or a timeout message.

The script polls `msdyn_operation` on the stage run record. While it equals `200000201` the validation is still in progress; once it changes the script checks `msdyn_stagerunstatus` — if `200000003` (Failed) it throws with `msdyn_validationresults`; otherwise it returns `{ stageRunId, validationResults, stageRunStatus }`.

Terminal validation values:
- `stageRunStatus 200000007` (Validation Succeeded) → proceed to Phase 5
- Script throws on `200000003` (Failed) — stop, display the `validationresults` from the error message
- Script throws on timeout — stop with the message

> **Important**: `validationresults` is a **double-encoded JSON string** — call `JSON.parse()` on it twice to get the object. The object has shape: `{ ValidationStatus, SolutionValidationResults: [{ SolutionValidationResultType, Message, ErrorCode }], SolutionDetails, MissingDependencies }`.

Surface any `SolutionValidationResults` entries to the user as warnings. Pay special attention to:
- `ErrorCode: -2147188672` — managed/unmanaged conflict: "The solution is already installed as unmanaged but this package is managed." The user must uninstall the existing solution from the target environment first, then retry.
- Missing connection references or environment variable gaps

<!-- gate: deploy-pipeline:4.pending-approval | category=pause | cancel-leaves=external-state-pending -->
> 🚦 **Gate (pause · deploy-pipeline:4.pending-approval):** External wait — PP Pipelines `stagerunstatus=200000005` (Pending Approval). User must approve in PPAC. Cancel leaves the run pending on the host. **In MULTI_RUN_MODE / MULTI_PIPELINE_MODE this gate fires per loop iteration that hits Pending Approval — not once per skill invocation.**

If `stageRunStatus = 200000005` (Pending Approval): inform the user they need to approve in Power Platform (`make.powerapps.com` → Solutions → Pipelines → find this run → Approve). Ask via `AskUserQuestion`: "Have you approved the validation? 1. Yes, continue / 2. No, cancel"

**4.4 Fetch AI-generated deployment notes** (if `AI_NOTES_ENABLED = true`):

```
GET {hostEnvUrl}/api/data/v9.0/deploymentstageruns({STAGE_RUN_ID})?$select=aigenerateddeploymentnotes,deploymentstagerunid
Authorization: Bearer {HOST_TOKEN}
```

Store `aigenerateddeploymentnotes` as `AI_DEPLOY_NOTES`.

### Phase 5 — Configure Deployment Settings

**5.0a Check for deployment-settings.json:**

Check if `deployment-settings.json` exists in the project root:

- **If it exists**: Read it and show a summary of configured stages and env var counts. Say: "Found existing `deployment-settings.json` with {N} stages configured." (Count top-level keys as stage names; count `EnvironmentVariables` entries per stage.)
- **If it does NOT exist AND there are env var definitions in the solution manifest** (from `solutionManifest.envVars[]` if available, or from the query in 5.1): Generate a template file and inform the user. Template structure:
  ```json
  {
    "{stageName}": {
      "EnvironmentVariables": [
        { "SchemaName": "{envVarSchemaName}", "Value": "" }
      ],
      "ConnectionReferences": []
    }
  }
  ```
  Use the stage name from `SELECTED_STAGE.name` and env var schema names from `.solution-manifest.json` (if available) or from the 5.1 query. Write to `deployment-settings.json` at the project root. Say: "Generated `deployment-settings.json` template. Fill in values before deploying, or provide them now when prompted."

  > **Note**: If env vars are not yet known at this point (5.0a runs before 5.1), generate the template file after 5.1 completes and the env vars are discovered — then inform the user before continuing to the prompt in 5.1.

- **If it does NOT exist AND there are no env vars in the solution**: Note "No env var overrides needed" and skip.

**5.0b Surface the file path:**

Always display the resolved path `{projectRoot}/deployment-settings.json` so the user knows where to find it, whether it was just created or already existed.

**5.1 Discover env var definitions in the solution and resolve per-stage values:**

Query the solution components in the **source environment** to find all env var definitions (componenttype 380):
```
GET {sourceEnvUrl}/api/data/v9.2/solutioncomponents?$filter=_solutionid_value eq '{solutionId}' and componenttype eq 380&$select=objectid
Authorization: Bearer {SOURCE_TOKEN}
```

For each `objectid`, fetch the schema name:
```
GET {sourceEnvUrl}/api/data/v9.2/environmentvariabledefinitions({objectid})?$select=schemaname,displayname,type,defaultvalue
```

This gives you `SOLUTION_ENV_VARS` — the list of env vars that will travel to the target.

**Read `deployment-settings.json`** (if it exists in the project root) and look up the selected stage name to get pre-configured values:
```js
const stageSettings = deploymentSettings?.stages?.[selectedStageName] || {};
const preconfigured = stageSettings.EnvironmentVariables || []; // [{ SchemaName, Value }]
```

**Identify unconfigured env vars** — those in `SOLUTION_ENV_VARS` that have no entry in `preconfigured`:
```js
const unconfigured = SOLUTION_ENV_VARS.filter(v =>
  !preconfigured.find(p => p.SchemaName === v.schemaname)
);
```

<!-- gate: deploy-pipeline:5.env-vars | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · deploy-pipeline:5.env-vars):** Unconfigured env vars per stage — user supplies values or skips (uses default). Without values, runtime reads default which may be dev-only. **In MULTI_RUN_MODE / MULTI_PIPELINE_MODE this gate fires per loop iteration that has unconfigured env vars — values supplied for iteration 1 do NOT carry to iteration 2.**

**If there are unconfigured env vars**, present them to the user via `AskUserQuestion`:

> "This solution has **{N} environment variable(s)** with no value configured for **{stageName}**. Enter the value for each (leave blank to use the default, or skip if not applicable):
>
> 1. `{schemaname}` ({displayname}) — default: `{defaultvalue ?? 'none'}`
> 2. ..."

Collect responses and merge with `preconfigured` to form the final `ENV_VAR_OVERRIDES` array. Offer to save the values back to `deployment-settings.json` for future runs:

> "Save these values to `deployment-settings.json` for future deployments to {stageName}?
> 1. Yes — save for next time
> 2. No — use once only"

If Yes: write/update `deployment-settings.json` with the collected values under `stages.{stageName}.EnvironmentVariables`.

**If all env vars are pre-configured** (or there are none): skip the prompt, use `preconfigured` directly.

**5.2 PATCH stage run with artifact version, deployment notes, and environment variables** (always run):

First, determine the current solution version in the **source (dev) environment** — this must match exactly:
```
GET {sourceEnvUrl}/api/data/v9.0/solutions?$filter=uniquename eq '{SOLUTION_NAME}'&$select=version
Authorization: Bearer {SOURCE_TOKEN}
```
Use the returned `version` as `artifactdevcurrentversion`. Do NOT use the version from `.solution-manifest.json` — that may be stale.

For `artifactversion`, increment the patch number of the source version (e.g., `1.0.0.2` → `1.0.0.3`). This must be strictly greater than the version already deployed in the target stage. If deploying to the same stage multiple times, check `docs/alm/last-deploy.json` for the last `artifactVersion` and use a higher value.

Then PATCH (include `deploymentsettingsjson` only if `ENV_VAR_OVERRIDES` is non-empty):

```
PATCH {hostEnvUrl}/api/data/v9.0/deploymentstageruns({STAGE_RUN_ID})
Content-Type: application/json
Authorization: Bearer {HOST_TOKEN}

{
  "artifactdevcurrentversion": "{current version from source env — must match exactly}",
  "artifactversion": "{new version — must be > current version in target stage}",
  "deploymentnotes": "{AI_DEPLOY_NOTES if available, otherwise a brief description of what is being deployed}",
  "deploymentsettingsjson": "{JSON.stringify({ EnvironmentVariables: ENV_VAR_OVERRIDES, ConnectionReferences: [] })}"
}
```

The `deploymentsettingsjson` value must be a **JSON-encoded string** (double-serialized):
```js
const deploymentsettingsjson = JSON.stringify({
  EnvironmentVariables: ENV_VAR_OVERRIDES,
  ConnectionReferences: stageSettings.ConnectionReferences || [],
});
```

If `ENV_VAR_OVERRIDES` is empty and there are no connection references, omit `deploymentsettingsjson` entirely.

Response is HTTP 204. If the PATCH fails with a version conflict error, check both version values and retry.

> **Caveat — `deploymentsettingsjson` does NOT always write `environmentvariablevalues` records on the target post-deploy.** Observed live: a Power Pages site with env var definitions that are **not yet linked to an `mspp_sitesetting`** record can complete a successful deploy with a populated `deploymentsettingsjson`, and the target environment's `environmentvariablevalues` table still ends up empty for those entries. The Power Platform Pipelines handler appears to write values only for definitions that have an existing site-setting binding (or another consumer the platform recognizes). This may be a platform bug or by-design pending a separate Power Pages Management UI step. If you ship Secret env vars or any other type that the user expects to land in the target before `setup-auth`/`configure-env-variables` runs there, **verify in Phase 7 below that `environmentvariablevalues` records exist on the target after the deploy completes**, and surface a clear prompt if they don't. Workaround: invoke `configure-env-variables` (or run `link-site-setting-to-env-var.js` per definition) on the target after the deploy to create the values explicitly. Track this in the next PR if it becomes a recurring blocker.

### Phase 6 — Deploy and Monitor

<!-- gate: deploy-pipeline:6.0.final-consent | category=final | cancel-leaves=validated-stage-run -->
> 🚦 **Gate (final · deploy-pipeline:6.0.final-consent):** Last-call before **each** `DeployPackageAsync` / `pac pipeline deploy` call. Validation already passed. Non-transactional import — partial failure leaves whatever already imported on the target.
>
> **⚠ Fires PER LOOP ITERATION in MULTI_RUN_MODE / MULTI_PIPELINE_MODE.** Three solutions in `deploymentOrder` → three Phase 6.0 prompts (one before each iteration's `DeployPackageAsync`). The upstream Phase 2 stage selection — whether via interactive `AskUserQuestion` or via the `--stage` argument — covers only **stage choice**, NOT individual deploy authorization. **Never batch the deploy loop.** Skipping the per-iteration prompt and proceeding straight from Phase 5 → Phase 6.1 for solutions 2..N is the documented strategy violation this gate exists to prevent.

**6.0 Final deploy consent gate.** Before kicking off **each** deployment — whether via `DeployPackageAsync` (6.1) or the `pac pipeline deploy` PAC CLI fallback, and whether this is the first solution or the Nth in MULTI_RUN_MODE — confirm with the user explicitly. The earlier gates (Phase 2 stage pick, Phase 2.5 unblock, Phase 3.5 completeness, Phase 5 env var values) each cover their own decision, but none of them is a per-iteration "ready to ship this one?" prompt and the deploy itself is not transactional — partial failures leave whatever has already imported on the target. This gate makes **every** production-promotion moment explicit. Use `AskUserQuestion`:

> "Ready to deploy `{ARTIFACT_SOLUTION_NAME}` (v`{newVersion}`) to **`{SELECTED_STAGE.name}`** (`{targetEnvUrl}`)?
>
> This will run for ~3–60 minutes depending on solution size. The import is **not** transactional — if it fails partway, whatever already imported stays on the target and a manual cleanup (or re-deploy with a higher artifact version) is required to recover. `docs/alm/last-deploy.json` is written regardless of outcome.
>
> 1. **Deploy now** — POST `DeployPackageAsync` (or run `pac pipeline deploy` for the CLI fallback) and poll until terminal
> 2. **Cancel** — leave the stage run in its current state (validated but not deployed); re-run `/power-pages:deploy-pipeline` later when ready"

Branch on the answer:

- **Deploy now** → proceed to 6.1 below (or the PAC CLI fallback box).
- **Cancel** → stop cleanly. Do NOT call `DeployPackageAsync` or `pac pipeline deploy`. Tell the user: *"Cancelled. The stage run `{STAGE_RUN_ID}` is validated but not deployed. Re-invoke `/power-pages:deploy-pipeline` to resume. If the source solution version changes before you re-invoke, the stage run's `artifactversion` field will need a fresh PATCH (Phase 5.2) before deploying — re-running the skill handles that automatically."* Do not write a `docs/alm/last-deploy.json` on cancel — there's no deploy outcome to record.

For Production targets specifically, treat this gate as the single most important prompt in the skill — the cancellation cost (stage run already validated) is small compared to a wrong-stage import.

> **If `ValidatePackageAsync` was unavailable (`VALIDATE_PACKAGE_UNAVAILABLE = true`)**: use the PAC CLI as the primary deployment mechanism instead of 6.1. The same Phase 6.0 consent gate above gates this path too — do not run `pac pipeline deploy` until the user has answered "Deploy now":
>
> Ask user for `currentVersion` (pre-fill from `.solution-manifest.json` `solution.version` if available) and `newVersion` (suggest incrementing the patch number, e.g. `1.0.0.0` → `1.0.0.1`).
>
> ```bash
> pac pipeline deploy \
>   --environment "{devEnvUrl}" \
>   --solutionName "{ARTIFACT_SOLUTION_NAME}" \
>   --stageId "{SELECTED_STAGE.stageId}" \
>   --currentVersion "{currentSolutionVersion}" \
>   --newVersion "{newVersion}" \
>   --wait
> ```
>
> If the CLI returns "Resource not found for the segment 'deploymentenvironments'": the dev environment is not connected to a Pipelines host. Advise the user to configure the host in Power Platform Admin Center (Environments → select env → Pipelines), then retry.
>
> If CLI succeeds: parse the output for stage run status, write `docs/alm/last-deploy.json` with `status: "Succeeded"` (or the parsed status), and skip the `DeployPackageAsync` call and polling in 6.1–6.2.

**6.1 Trigger deployment** (skip if `VALIDATE_PACKAGE_UNAVAILABLE = true` — use PAC CLI path above). Only run after the Phase 6.0 consent gate returned "Deploy now":

```
POST {hostEnvUrl}/api/data/v9.0/DeployPackageAsync
Content-Type: application/json
Authorization: Bearer {HOST_TOKEN}

{"StageRunId": "{STAGE_RUN_ID}"}
```

> **Note**: `DeployPackageAsync` also returns 404 on older Pipelines package versions. If this occurs, use the `pac pipeline deploy` CLI path above.

**6.2 Poll stagerunstatus until terminal** using `poll-deployment-status.js`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/poll-deployment-status.js" \
  --hostEnvUrl "{hostEnvUrl}" \
  --token "{HOST_TOKEN}" \
  --stageRunId "{STAGE_RUN_ID}" \
  --intervalMs 8000 \
  --maxAttempts 75
```

Capture stdout as JSON: `const result = JSON.parse(output)`.

The script polls `msdyn_stagerunstatus` until a terminal state:
- `result.status === 'Succeeded'` → proceed to Phase 7
- `result.status === 'Awaiting'` → approval gate (see below); do NOT treat as error
- Script throws on `200000003` (Failed) or `200000004` (Canceled) — error message includes `msdyn_errordetails`
- Script throws on timeout after ~10 minutes

`suboperation` field (not polled by the script but visible in Power Platform) shows progress detail:
- `200000100` = None (starting/finishing)
- `200000105` = Deploying Artifact (actively installing solution)

<!-- gate: deploy-pipeline:6.pending-approval | category=pause | cancel-leaves=external-state-pending -->
> 🚦 **Gate (pause · deploy-pipeline:6.pending-approval):** External wait — PP Pipelines `stagerunstatus=200000005` mid-deploy. User approves in PPAC. Cancel here PATCHes `iscanceled: true` on the run. **In MULTI_RUN_MODE / MULTI_PIPELINE_MODE this gate fires per loop iteration that hits Pending Approval.**

**Approval gate handling**: If `result.status === 'Awaiting'` (`msdyn_stagerunstatus = 200000005`):
- Inform user: "This deployment is waiting for approval. Please approve it in Power Platform: `make.powerapps.com` → Solutions → Pipelines → find deployment for `{STAGE_RUN_ID}` → Approve."
- Ask via `AskUserQuestion`: "Have you approved the deployment? 1. Yes, I approved it — continue polling / 2. Cancel deployment"
- If Yes: re-run `poll-deployment-status.js` to continue polling.
- If Cancel: PATCH the stage run to cancel it:
  ```
  PATCH {hostEnvUrl}/api/data/v9.0/deploymentstageruns({STAGE_RUN_ID})
  {"iscanceled": true}
  ```
  Then record status as "Canceled".

**Token refresh**: After every 10 poll cycles (~80 seconds), refresh `HOST_TOKEN` via `az account get-access-token` and pass the updated token in a fresh `poll-deployment-status.js` invocation with reduced `--maxAttempts`.

Report deployment progress updates as polling continues.

### Phase 7 — Write Deployment Record and Summary

**7.1 Determine final status string:**
- `200000002` → `"Succeeded"`
- `200000003` → `"Failed"`
- `200000004` → `"Canceled"`
- `200000005` → `"PendingApproval"` (if user cancelled waiting)
- Poll timeout → `"Unknown"`

**7.2 Post-deployment warnings** (only if deployment **Succeeded**):

Using `solutionManifest` captured in Phase 1 from `detect-project-context.js`, check for components that require manual follow-up in the target environment.

**Connection reference warning** — if `solutionManifest.cloudFlows` is present and non-empty:

> **⚠️ Connection references may need binding**
> This solution includes cloud flow(s). If those flows use connection references (e.g. Dataverse, SharePoint), they must be bound to live connections in the target environment or the flows will remain disabled.
>
> To bind: Power Automate → target environment → each flow → Edit → bind connections.

If `solutionManifest.cloudFlows` is absent or empty, skip this warning entirely.

**Bot republish warning** — if `solutionManifest.botComponents` is present and non-empty:

> **⚠️ Bot republish required**
> This solution includes a Copilot Studio bot. After deployment, the bot must be republished in the target environment to complete provisioning.
>
> To republish: Power Pages Management → target environment → Edit site → Copilot → republish.

If `solutionManifest.botComponents` is absent or empty, skip this warning entirely.

These warnings are informational only — do not block the summary or use `AskUserQuestion`.

**7.3 Write `docs/alm/last-deploy.json`** (create the `docs/alm/` directory first if missing — `node -e "require('fs').mkdirSync('docs/alm',{recursive:true})"`):

```json
{
  "pipelineId": "{pipelineId}",
  "pipelineName": "{pipelineName}",
  "stageId": "{SELECTED_STAGE.stageId}",
  "stageRunId": "{STAGE_RUN_ID}",
  "stageName": "{SELECTED_STAGE.name}",
  "solutionName": "{ARTIFACT_SOLUTION_NAME}",
  "solutionId": "{ARTIFACT_SOLUTION_ID}",
  "status": "{final status string}",
  "deployedAt": "{ISO timestamp}",
  "hostEnvUrl": "{hostEnvUrl}",
  "targetEnvironmentUrl": "{SELECTED_STAGE.targetEnvironmentUrl}",
  "artifactVersion": "{artifactVersion from Phase 5.2 PATCH}",
  "deployHistoryFile": "docs/deploy-history/{YYYY-MM-DD}-{stageName}-{artifactVersion}.html",
  "activationStatus": null,
  "siteUrl": null
}
```

`activationStatus` and `siteUrl` start as `null` and are patched at the end of Phase 7.7 once the activation outcome is known.

Where `{YYYY-MM-DD}` is the date portion of `deployedAt` and `{stageName}` is the stage name with spaces replaced by hyphens (lowercased), e.g. `2026-04-06-staging-1.0.0.3.md`.

**7.4 Write deployment history entry (HTML):**

Compute the history filename: `{YYYY-MM-DD}-{stageName}-{artifactVersion}.html` (same derivation as `docs/alm/last-deploy.json`'s `deployHistoryFile` field — replace spaces with hyphens, lowercase stage name).

Create `docs/deploy-history/` if it does not already exist:
```bash
mkdir -p docs/deploy-history
```

Read the template at `${CLAUDE_PLUGIN_ROOT}/skills/deploy-pipeline/assets/deploy-history-template.html` and replace the following `__PLACEHOLDER__` tokens:

**Overview tab:**

| Placeholder | Value |
|---|---|
| `__SOLUTION_FRIENDLY_NAME__` | Solution friendly name (from `.solution-manifest.json`) or `{solutionUniqueName}` |
| `__SOLUTION_NAME__` | `{ARTIFACT_SOLUTION_NAME}` |
| `__STAGE_NAME__` | `{SELECTED_STAGE.name}` |
| `__TARGET_ENV_URL__` | `{SELECTED_STAGE.targetEnvironmentUrl}` |
| `__STAGE_RUN_ID__` | `{STAGE_RUN_ID}` |
| `__PIPELINE_NAME__` | `{pipelineName}` |
| `__DEPLOYED_AT__` | `{deployedAt ISO string}` |
| `__ARTIFACT_VERSION__` | `{artifactVersion from Phase 5.2}` |
| `__PREV_ARTIFACT_VERSION__` | `{artifactDevCurrentVersion}` — the version that was in dev before this deploy |
| `__STATUS_CLASS__` | `succeeded` / `failed` / `pending-approval` |
| `__STATUS_ICON__` | `✓` for Succeeded, `✗` for Failed, `⏳` for PendingApproval |
| `__STATUS_LABEL__` | `Succeeded` / `Failed` / `Pending Approval` |
| `__ACTIVATION_SECTION__` | Initially `''` — replaced in Phase 7.7 once activation outcome is known |

**Solution tab** — read `.solution-manifest.json` to build these sections:

| Placeholder | Value |
|---|---|
| `__SOLUTION_META_ROWS__` | `<tr>` rows for: Friendly Name, Unique Name, Version (new → previous), Type (Managed/Unmanaged), Publisher, Total Components. Source: manifest + `validationResults.SolutionDetails` from Phase 6. |
| `__VALIDATION_SECTION__` | If validation passed: `<div class="note-box succeeded"><span class="validation-badge passed">✓ Validation Passed</span> — No missing dependencies.</div>`. If failed or deps present: `<div class="note-box warning">` listing each missing dependency name. |
| `__SOLUTION_CONTENTS_SECTION__` | Build from `.solution-manifest.json`: a `<div class="contents-grid">` with two `<div class="contents-card">` blocks — **Dataverse Tables** (as `<span class="table-chip">` per table) and **Bot Components** (comma-separated names). Below the grid, add a `<div class="note-box neutral">` with: `{totalAdded} components added to solution` (from `components.totalAdded`). If manifest is unavailable, show a neutral note. |

**Config & Notes tab:**

| Placeholder | Value |
|---|---|
| `__ENV_VARS_SECTION__` | If `ENV_VAR_OVERRIDES` was non-empty: a `<div class="card"><h3>Environment Variable Overrides</h3>` table with schema name + override value columns. Otherwise: `<div class="note-box neutral">No environment variable overrides applied.</div>` |
| `__DEPLOYMENT_NOTES_SECTION__` | If `AI_DEPLOY_NOTES` is available: `<div class="card"><h3>AI Deployment Notes</h3><p>…</p></div>`. Otherwise: `''` |
| `__POST_DEPLOY_WARNINGS__` | One `<div class="note-box warning">` per post-deploy warning (connection refs, bot republish). Empty string if none. |

Write the rendered HTML to `docs/deploy-history/{filename}.html`.

Then add to the staging area:
```bash
git add docs/alm/last-deploy.json docs/deploy-history/{filename}.html
git commit -m "Deploy {solutionUniqueName} v{artifactVersion} to {stageName} ({status})"
```

If git is not initialized in the project root (i.e., `git rev-parse --git-dir` fails), skip the commit silently.

**7.5 Record skill usage:**

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "DeployPipeline"`.

**7.5b Refresh the ALM plan (if one exists):**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/refresh-alm-plan-data.js" \
  --projectRoot "." \
  --phase deploy-pipeline \
  --render
```

The helper reads the `docs/alm/last-deploy.json` you just wrote, ingests it into `planData.pipelineMeta.lastDeploy`, drops any pre-deploy "host not yet provisioned" risks, and re-renders `docs/alm-plan.html` so the Pipelines tab shows the actual run state (status, version, component count, activation, site URL). When `docs/.alm-plan-data.json` is absent (the skill was invoked standalone, not via plan-alm), the helper returns `ok:false` as a soft no-op — safe to run unconditionally.

This step is what makes the rendered plan stay current after a direct `/power-pages:deploy-pipeline` invocation. plan-alm Phase 7 also runs the same refresh as belt-and-suspenders; running it twice is idempotent (same input → same output).

**7.6 Present summary:**

If **Succeeded**:
```
✓ Deployment succeeded

  Solution:     {solutionName}
  Stage:        {stageName}
  Target:       {targetEnvironmentUrl}
  Completed at: {deployedAt}
  Stage run ID: {STAGE_RUN_ID}
  Site URL:     {siteUrl from 7.7, or "— activation pending" if not yet activated, or "— checking…" before 7.7 runs}
```

If **Failed**:
```
✗ Deployment failed

  Stage run ID: {STAGE_RUN_ID}
  Status:       Failed

  To investigate: open Power Platform make.powerapps.com → Solutions → Pipelines
  and find the failed run for details on what caused the failure.
```

**7.6.1 Diagnose the failure.** Before asking the user what to do, query the stage run record for error details so we can offer a targeted remediation prompt:

```
GET {hostEnvUrl}/api/data/v9.1/deploymentstageruns({STAGE_RUN_ID})?$select=errordetails,validationresults,stagerunstatus
Authorization: Bearer {HOST_TOKEN}
```

Parse `errordetails` and `validationresults` as JSON / text. Check for these patterns (case-insensitive):

| Pattern in error text | Diagnosis | Remediation prompt |
|---|---|---|
| `AttachmentBlocked` OR `-2147188706` OR `not a valid type` OR `\.js.*blocked` | **Blocked attachments** — the target env's `blockedattachments` setting rejects file types in the solution | See 7.6.2 below |
| `MissingDependency` OR `Missing dependency` | Missing solution dependencies in target | Surface the dependencies; recommend the user install them and retry |
| (anything else) | Unknown failure | Fall through to the generic retry/exit prompt |

**7.6.2 Blocked-attachment remediation (gated).** Only run when the diagnostic in 7.6.1 matched the blocked-attachment pattern. **Never modify the env's `blockedattachments` setting without an explicit AskUserQuestion gate.** This is a tenant-wide security setting; auto-modifying it would silently weaken security posture across other apps in the same env.

1. Switch PAC CLI to the **target** environment so the helper queries the right env's settings, then identify which file types are blocked. By default the helper checks `js`; pass `--extensions` if the error mentions other types (e.g. `js,css`):
   ```bash
   pac env select --environment "{TARGET_ENV_URL}"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/fix-blocked-attachments.js" \
     --envUrl "{TARGET_ENV_URL}" \
     --extensions js \
     --dry-run
   ```
   Read the output JSON. The fields you care about: `wasBlocked[]` (the extensions currently blocked on the env that were on your `--extensions` list — these are what would be removed) and `unchanged[]` (extensions you asked to remove that aren't actually blocked, no-op).

   If `wasBlocked` is empty, the failure is **not** caused by a blocked attachment on this list — fall back to 7.6.3's generic retry prompt and surface the raw error text from `errordetails`.

2. Tell the user explicitly:
   > "The deployment failed because the target environment **`{targetEnvName}`** blocks file types that this solution needs: **`{wasBlocked.join(', ')}`**. This is an environment-level security setting that affects all users of that env. To proceed, the block needs to be removed for these specific types. The change is reversible from the Power Platform Admin Center → Environments → `{targetEnvName}` → Settings → Product → Features → Blocked Attachments."

<!-- gate: deploy-pipeline:7.6.2.blocked-attachments | category=consent | cancel-leaves=attachment-block-modified -->
> 🚦 **Gate (consent · deploy-pipeline:7.6.2.blocked-attachments):** Reactive `AttachmentBlocked` remediation — modify env-level `blockedattachments` setting (tenant-wide impact). Reversible from PPAC. **Fires PER FAILURE that matches the AttachmentBlocked pattern.** In MULTI_RUN_MODE this is rare — Phase 2.5 pre-flight typically catches the block before the loop starts — but if iteration N still fails with `AttachmentBlocked` after a successful Phase 2.5, the gate fires again for that failure. Each failure is its own consent decision (different solution, possibly different blocked extensions). Do NOT carry consent across failures.

3. Invoke `AskUserQuestion` (do NOT bury this in chat — the user must answer before any change happens):

   | Question | Header | Options |
   |---|---|---|
   | Allow removing the block on `{wasBlocked.join(', ')}` for the `{targetEnvName}` environment so the deployment can retry? This modifies a tenant-level security setting. | Unblock attachments | Yes — unblock these types and retry, No — leave settings unchanged (I'll investigate manually), Cancel |

4. Branch on the answer:
   - **Yes — unblock and retry**: invoke `fix-blocked-attachments.js` **without** `--dry-run` (with the same `--extensions`), then call `RetryFailedDeploymentAsync` and resume polling from Phase 6.2. Surface the change in the deploy summary so the user has a clear audit record. Switch PAC CLI back to the source env after the retry resolves so subsequent skill steps run against the source by default.
   - **No / Cancel**: stop with a remediation pointer:
     > "To unblock manually: open Power Platform Admin Center → Environments → **`{targetEnvName}`** → Settings → Product → Features → **Blocked Attachments** → remove `{blockedTypesPresent.join(', ')}` → Save. Then re-run `/power-pages:deploy-pipeline`."

**7.6.3 Generic retry/exit prompt** (when 7.6.1 didn't match a known pattern, or the user declined the targeted remediation):

<!-- gate: deploy-pipeline:7.6.3.retry-exit | category=plan | cancel-leaves=validated-stage-run -->
> 🚦 **Gate (plan · deploy-pipeline:7.6.3.retry-exit):** Failed deploy with no known pattern matched — call RetryFailedDeploymentAsync or exit for manual investigation.

Ask via `AskUserQuestion`:
> "The deployment failed. What would you like to do?
> 1. **Retry** — call `RetryFailedDeploymentAsync` to retry the same stage run
> 2. **Exit** — I'll investigate manually"

If **Retry**: call:
```
POST {hostEnvUrl}/api/data/v9.1/RetryFailedDeploymentAsync
Content-Type: application/json
Authorization: Bearer {HOST_TOKEN}

{"StageRunId": "{STAGE_RUN_ID}"}
```
Then resume polling from Phase 6.2.

If **Exit**: stop and present the failure summary above.

**7.6.5 Verify `environmentvariablevalues` landed on the target** (only if deployment **Succeeded** AND `ENV_VAR_OVERRIDES` was non-empty AND `deploymentsettingsjson` was PATCHed in Phase 5.2):

Even when the stage run reports success, the Power Platform Pipelines handler does not always write `environmentvariablevalues` records for every env var definition in `deploymentsettingsjson` — definitions that aren't bound to an `mspp_sitesetting` (or another consumer the platform recognizes) can land as zero-value on the target. See the caveat note above Phase 6 for the live evidence. This step closes the gap.

For each `SchemaName` in `ENV_VAR_OVERRIDES`:

1. Look up the definition GUID on the target:
   ```
   GET {targetEnvUrl}/api/data/v9.2/environmentvariabledefinitions?$filter=schemaname eq '{schemaName}'&$select=environmentvariabledefinitionid
   ```
2. Query for a current value record:
   ```
   GET {targetEnvUrl}/api/data/v9.2/environmentvariablevalues?$filter=_environmentvariabledefinitionid_value eq '{definitionId}'&$select=value
   ```
3. If `value.length === 0` for ANY of the entries that should have landed:
   - Log a structured warning into `docs/alm/last-deploy.json` under a new `envVarLandingWarnings[]` array — one entry per missed schemaName.
   - Surface to the user via the deploy summary: *"`{N}` environment variable values from `deploymentsettingsjson` did not land on `{targetEnvName}`. Most likely cause: the definition isn't yet linked to a site setting on the target. Run `/power-pages:configure-env-variables` against `{targetEnvName}` to create the missing values, then re-deploy or set values via Power Platform Admin Center."*
4. If `value.length >= 1` for all entries: deploy is fully landed; no warning.

This check uses target-env credentials — PAC CLI is still pointing at the source from the prior phases, so temporarily switch (`pac env select --environment "{targetEnvUrl}"`) then switch back at the end of 7.6.5 so subsequent phases run against the source env by default.

**7.7 Check site activation** (only if deployment **Succeeded** and this is a Power Pages project):

> **Trigger rule (updated 2026-04-22):** run this check whenever the source project's `powerpages.config.json` has a `websiteRecordId` — i.e. this project is a Power Pages site project. The earlier rule ("only if the solution we just deployed contains a website componentType 10374") misses a real-world case: the site may pre-exist on the target and the solution we deployed may only contain tables/flows/bots. A Power Pages project's post-deploy is always incomplete if its site isn't activated on the target, regardless of which specific solution was shipped this time.

Read `websiteRecordId` from `powerpages.config.json`. If the field is absent, skip the rest of 7.7 (this is a non-Power-Pages ALM run — e.g. a pure data-model solution).

Optional secondary check: query the source solution for a website componentType `10374` only to **log** whether the site was included in this specific solution — informational, not gating:
```
GET {sourceEnvUrl}/api/data/v9.2/solutioncomponents?$filter=_solutionid_value eq '{solutionId}' and componenttype eq 10374&$select=objectid
Authorization: Bearer {SOURCE_TOKEN}
```

If found, temporarily switch PAC CLI to the target environment so `check-activation-status.js` queries the correct env:
```bash
pac env select --environment "{SELECTED_STAGE.targetEnvironmentUrl}"
```

Run the activation check:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-activation-status.js" --projectRoot "."
```

Then switch PAC CLI back to the source (dev) environment regardless of the result:
```bash
pac env select --environment "{sourceEnvUrl}"
```

Evaluate the result and take action based on the outcome. In all cases, **after the outcome is resolved**, update `docs/alm/last-deploy.json` and the deploy history file (described below).

- **`activated: true`**: Site is already live. Set `ACTIVATION_OUTCOME = { status: "Activated", siteUrl: "{result.websiteUrl}" }`.

<!-- gate: deploy-pipeline:7.7.activate | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · deploy-pipeline:7.7.activate):** Site deployed to target but not activated. Offer to invoke activate-site or defer.

- **`activated: false`**: Ask the user via `AskUserQuestion`:

  | Question | Header | Options |
  |---|---|---|
  | The Power Pages site was deployed to `{SELECTED_STAGE.targetEnvironmentUrl}` but is not yet activated (provisioned). Activate it now to make it publicly accessible. | Activate Site | Yes, activate now (Recommended), No, I'll activate later |

  - **If "Yes"**: Invoke `/power-pages:activate-site`. The activate-site skill handles subdomain selection, confirmation, and provisioning. After it completes, set `ACTIVATION_OUTCOME = { status: "Activated", siteUrl: "{site URL from activate-site}" }`.
  - **If "No"**: Set `ACTIVATION_OUTCOME = { status: "Pending", siteUrl: null }`.

- **`error` present**: Set `ACTIVATION_OUTCOME = null` — skip the update steps below silently.

**After activation outcome is resolved**, patch `docs/alm/last-deploy.json` (in-place `Edit`) with the actual values:
- `"activationStatus": "{ACTIVATION_OUTCOME.status}"` (or keep `null` if `ACTIVATION_OUTCOME` is null)
- `"siteUrl": "{ACTIVATION_OUTCOME.siteUrl}"` (or keep `null`)

Then update the deploy history HTML file (in-place `Edit`) — replace `__ACTIVATION_SECTION__` with the appropriate HTML:

- **`status: "Activated"`**:
  ```html
  <div class="card">
    <h2>Site Activation</h2>
    <table><tbody>
      <tr><td class="label-col">Status</td><td style="color:var(--succeeded);font-weight:600;">✓ Activated</td></tr>
      <tr><td class="label-col">Site URL</td><td><a href="__SITE_URL__" style="color:var(--accent);">__SITE_URL__</a></td></tr>
    </tbody></table>
  </div>
  ```
  (Replace `__SITE_URL__` with `ACTIVATION_OUTCOME.siteUrl`)

- **`status: "Pending"`**:
  ```html
  <div class="note-box neutral">
    <strong>Site activation pending.</strong> The solution was deployed but the site has not yet been provisioned in this environment. Run <code>/power-pages:activate-site</code> (with PAC CLI authenticated to the target environment) to activate it.
  </div>
  ```

If `ACTIVATION_OUTCOME` is null (error during check), leave the `__ACTIVATION_SECTION__` placeholder as an empty string (strip it from the file).

**7.8 Detect and guide cloud flow registration** (only if deployment **Succeeded**):

Query the solution components on the **host environment** for cloud flows (componenttype 29 = Workflow):

```
GET {hostEnvUrl}/api/data/v9.2/solutioncomponents?$filter=solutionid eq '{ARTIFACT_SOLUTION_ID}' and componenttype eq 29&$select=objectid,componenttype
Authorization: Bearer {HOST_TOKEN}
```

- **If no results**: Skip this step entirely — the solution contains no cloud flows.

- **If results found**:
  1. Count the flows: store `N` = number of results.
  2. For each `objectid`, attempt to resolve the flow name by querying `workflows({objectid})?$select=name` on the host environment. If any query fails or returns no name, fall back to displaying the raw object ID.
  3. Inform the user:

     > "The solution contains **{N} cloud flow(s)**. After deployment, cloud flows must be registered with the Power Pages site in the target environment to function correctly.
     >
     > Flows detected:
     > {bulleted list of flow names or IDs}
     >
     > To register: open [Power Pages](https://make.powerpages.microsoft.com/) → select the **target environment** → open your site → **Set up** → **Cloud flows** → register each flow listed above."

  <!-- gate: deploy-pipeline:7.cloud-flow-register | category=plan | cancel-leaves=nothing -->
  > 🚦 **Gate (plan · deploy-pipeline:7.cloud-flow-register):** Cloud flows in deployed solution need manual registration in target env. Acknowledge or defer (non-blocking).

  4. Ask via `AskUserQuestion`:

     | Question | Header | Options |
     |---|---|---|
     | Have you registered the cloud flow(s) in the target environment? | Cloud Flow Registration | Flows registered — continue, I'll register them later |

  5. **Non-blocking**: regardless of the answer, continue with the summary step (Phase 7.6). Record the cloud flow registration status in the summary table:
     - Answer "Flows registered — continue" → show **Registered** in summary
     - Answer "I'll register them later" → show **Pending registration** in summary

  > **Note**: Skipped or deferred registration does not indicate a failed deployment. It only affects live site functionality for pages that call registered flows.

## Key Decision Points (Wait for User)

1. **Phase 2**: Target stage selection (which environment to deploy to)
2. **Phase 2**: Retry confirmation if last deploy to this stage failed
3. **Phase 2.5**: Pre-flight blocked-attachments unblock (`Yes — unblock / No — proceed anyway / Cancel deploy`). Only fires when the target env's `blockedattachments` setting blocks extensions the solution needs (typically `.js` for code sites). Modifies a tenant-wide security setting; explicit consent required.
4. **Phase 3.5**: Completeness-gap prompt (sync-first / deploy-anyway / cancel) when the live site has components missing from the solution
5. **Phase 3.5**: **Post-sync approval gate** — only fires after a mid-deploy sync (Option 1). Shows the new solution version + newly-adopted components and asks the user to confirm the post-sync solution before promoting to the target stage. Pause exits cleanly; Cancel aborts.
6. **Phase 4**: Validation approval gate — if Pending Approval, wait for user to approve
7. **Phase 5**: `deployment-settings.json` surfaced upfront (5.0a: show summary or generate template; 5.0b: display file path). Env var values — always shown if the solution contains env var definitions with no pre-configured value for the selected stage; offer to save values for future runs
8. **Phase 6.0**: **Final deploy consent gate** — `Deploy now / Cancel`. Fires immediately before `DeployPackageAsync` (or the `pac pipeline deploy` fallback). Makes the production-promotion moment explicit; without it, Phase 5 → Phase 6.1 could fire without a final confirmation when validation passes cleanly. Treat as the single most important prompt for Production targets.
9. **Phase 6**: Deployment approval gate — if Pending Approval mid-deploy, wait for user to approve
10. **Phase 7.6.2**: Reactive blocked-attachments unblock (`Yes — unblock and retry / No — leave settings unchanged / Cancel`). Only fires when the deploy failed with `AttachmentBlocked` and pre-flight (Phase 2.5) was skipped or declined. Same security-setting consent as Phase 2.5.
11. **Phase 7.7**: Site activation — only if deployment Succeeded, Power Pages website components present, and site not yet activated in the target. Result (`activationStatus`, `siteUrl`) is written back to `docs/alm/last-deploy.json` and the deploy history HTML.
12. **Phase 7.8**: Cloud flow registration — only if deployment Succeeded and solution contains cloud flow components (componenttype 29); non-blocking regardless of user answer

## Error Handling

- No `docs/alm/last-pipeline.json`: stop, advise `/power-pages:setup-pipeline`
- Host environment token fails: stop with `az login` instructions
- `RetrieveDeploymentPipelineInfo` fails: use `sourceDeploymentEnvironmentId` from `docs/alm/last-pipeline.json` as fallback; warn that artifact list could not be retrieved and ask user to confirm solution
- Stage run creation fails (4xx): report full error body — likely a pipeline configuration issue
- `ValidatePackageAsync` fails: report error — usually means the solution is not ready to deploy
- Validation `stagerunstatus = 200000003` (Failed): stop with validation details — user must resolve issues before retrying (new stage run required)
- Deployment `stagerunstatus = 200000003` (Failed): offer retry via `RetryFailedDeploymentAsync` (`POST /api/data/v9.1/RetryFailedDeploymentAsync {"StageRunId": "..."}`) before stopping
- `DeployPackageAsync` call fails: report error and stop
- Poll timeout (max attempts reached): stop with "Deployment is taking longer than expected. Check status in Power Platform."

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| Verify prerequisites | Verifying prerequisites | Run verify-alm-prerequisites.js (--require-manifest) for PAC/az/WhoAmI; run detect-project-context.js for solutionManifest/siteName; read docs/alm/last-pipeline.json for pipelineId/stages; acquire host env token |
| Select target stage | Selecting target stage | Show available stages from docs/alm/last-pipeline.json; ask user to select target; warn if last deploy to this stage failed |
| Resolve pipeline info | Resolving pipeline info | Call RetrieveDeploymentPipelineInfo (v9.1) to get SourceDeploymentEnvironmentId and DeployableArtifacts; match solution |
| Validate package | Validating package | POST deploymentstageruns (→ 201 or 204+header); POST ValidatePackageAsync top-level action (204); poll stagerunstatus until not 200000006; JSON.parse validationresults twice; fetch aigenerateddeploymentnotes; PATCH artifactversion + deploymentnotes + deploymentsettingsjson (from deployment-settings.json) |
| Configure deployment settings | Configuring deployment settings | Check/display deployment-settings.json (5.0a: read or generate template; 5.0b: surface path); query solution for env var definitions (componenttype 380); diff against deployment-settings.json for selected stage; prompt user for any unconfigured values; offer to save back to deployment-settings.json; PATCH deploymentsettingsjson on stage run |
| Deploy and monitor | Deploying and monitoring | POST DeployPackageAsync top-level action (204); poll via filter GET (10s) until stagerunstatus terminal; handle approval gates (cancel via PATCH iscanceled=true); offer RetryFailedDeploymentAsync on failure; refresh token every 10 cycles |
| Write deployment record | Writing deployment record | Write docs/alm/last-deploy.json (with artifactVersion + deployHistoryFile fields); write docs/deploy-history/{date}-{stage}-{version}.md; git add + commit history file; run skill tracking; if Succeeded: show connection reference warning (if solutionManifest.cloudFlows non-empty) and bot republish warning (if solutionManifest.botComponents non-empty); present summary; if Succeeded and Power Pages components present: switch PAC to target, run check-activation-status.js, switch back, ask user to activate if not yet provisioned; if Succeeded and cloud flow components present (componenttype 29): query solutioncomponents, resolve flow names, inform user, ask AskUserQuestion (non-blocking), note registration status in summary |
