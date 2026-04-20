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
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
hooks:
  Stop:
    - hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/deploy-pipeline/scripts/validate-deploy-pipeline.js"'
          timeout: 30
        - type: prompt
          prompt: |
            Check whether the deploy-pipeline skill completed successfully. Return { "ok": true } if ALL of the following are true, otherwise { "ok": false, "reason": "..." }:
            1. .last-pipeline.json was read and pipelineId, hostEnvUrl, stages were available
            2. A target stage was selected by the user
            3. ValidatePackageAsync was called and validation completed (operation changed away from 200000201)
            4. DeployPackageAsync was called and deployment reached a terminal stagerunstatus (not still in-progress)
            5. .last-deploy.json was written with pipelineId, stageRunId, solutionName, status, and deployedAt
            6. A summary was presented with deployment outcome
          timeout: 30
---

# deploy-pipeline

Triggers a **Power Platform Pipeline** deployment run. Reads the existing pipeline configuration from `.last-pipeline.json`, selects a target stage, validates the solution package, and deploys it to the target environment.

> **Prerequisite**: Run `/power-pages:setup-pipeline` first to create the pipeline configuration.

> Refer to `${CLAUDE_PLUGIN_ROOT}/references/cicd-pipeline-patterns.md` for all HAR-confirmed API patterns used in this skill.

## Prerequisites

> **Important**: The source (dev) environment must have a Power Platform Pipelines host environment configured. This is set in Power Platform Admin Center (Environments → select env → Pipelines) or via the tenant-level `DefaultCustomPipelinesHostEnvForTenant` setting. Without this configuration, `pac pipeline deploy` will fail. The `setup-pipeline` skill creates the pipeline definition in the host; this admin step connects the dev environment to that host.

- `.last-pipeline.json` exists in the project root (created by `setup-pipeline`)
- `.solution-manifest.json` exists
- Azure CLI logged in (`az account show` succeeds)
- PAC CLI logged in (`pac env who` succeeds)

## Phases

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
   Capture output as JSON; extract `.solutionManifest` (store as `solutionManifest`), `.siteName` (store as `siteName`), and `.websiteRecordId`. If `solutionManifest` is null, continue — the manifest is not strictly required at this step (solution info will come from `.last-pipeline.json`).

3. Locate `.last-pipeline.json` in the project root — if not found, stop and advise running `/power-pages:setup-pipeline` first.

   **Manifest version check:**
   - If `schemaVersion === 2`, set `MULTI_PIPELINE_MODE = true` and store `pipelines[]` as `PIPELINES_LIST`. The skill will deploy all pipelines for the selected target stage, in `order`, one after the other (Core → WebAssets, etc.). A failure on any pipeline halts the chain for that stage.
   - Otherwise read `pipelineId`, `pipelineName`, `hostEnvUrl`, `sourceDeploymentEnvironmentId`, `solutionName`, `stages[]` (single-pipeline mode — existing behavior).

   **In `MULTI_PIPELINE_MODE`**, resolve `solutionName` per pipeline in the loop (not globally). All pipelines share the same `hostEnvUrl` and `sourceDeploymentEnvironmentId`.

4. Acquire host environment token:
   ```bash
   az account get-access-token --resource "{hostEnvOrigin}" --query accessToken -o tsv 2>/dev/null
   ```
   Where `hostEnvOrigin` = scheme + host of `hostEnvUrl`. Store as `HOST_TOKEN`. If acquisition fails, stop with instructions to check Azure CLI auth.

5. If `solutionManifest` is available, read `solutionManifest.solution.solutionId` and `solutionManifest.solution.uniqueName` from the detected context. Otherwise, use `solutionName` from `.last-pipeline.json`.

6. Report: "Pipeline: `{pipelineName}`. Solution: `{solutionName}`. Available stages: `{stage names}`."

### Phase 2 — Select Target Stage

If the user passed a stage name or environment label as an argument (e.g., `staging`), match it against stages in `.last-pipeline.json` and skip this question.

Otherwise, ask via `AskUserQuestion`:

> "Which environment do you want to deploy to?
> {numbered list of stages from .last-pipeline.json, e.g.:
> 1. Deploy to Staging → {stagingEnvUrl}
> 2. Deploy to Production → {prodEnvUrl}}"

Store selected stage as `SELECTED_STAGE` (with `stageId`, `name`, `targetDeploymentEnvironmentId`, `targetEnvironmentUrl`).

**In `MULTI_PIPELINE_MODE`:** The selected stage label (e.g., "Staging") is matched against each pipeline's `stages[]` — each pipeline has its own `stageId` for the same target environment. All subsequent phases (validate, deploy, poll) are looped over `PIPELINES_LIST` in `order`:
1. Loop iteration i: use `pipelines[i].stageId` where stage label matches `SELECTED_STAGE.name`, `pipelines[i].solutionName`, etc.
2. If any iteration fails (validation or deployment), halt the loop and report which pipeline failed and which were already deployed.
3. Write one `.last-deploy.json` at the end summarizing all pipeline runs for this stage. Record per-pipeline `status` (`Succeeded` / `Failed` / `NotAttempted`) so a retry can tell which ones still need to run.

> **Partial-deploy risk.** When the loop halts (e.g., `Core` succeeded, `WebAssets` failed), the target environment is left in a mixed state — there is no automatic rollback of solutions that already imported. The per-pipeline `status` in `.last-deploy.json` is the source of truth for what landed. When the user re-runs `deploy-pipeline` after fixing the failure, the loop iterates all pipelines again from the start; rely on the solution-import idempotency (same version = no-op) rather than skipping. Warn the user of this before starting a multi-pipeline deploy to production.

Check `.last-deploy.json` — if the last deployment to this stage failed, warn the user:
> "The last deployment to `{stageName}` had status: **Failed**. Would you like to retry? 1. Yes, retry / 2. No, cancel"

### Phase 3 — Resolve Pipeline Info

Call `RetrieveDeploymentPipelineInfo` to get the authoritative source environment ID and available solution artifacts:

```
GET {hostEnvUrl}/api/data/v9.1/RetrieveDeploymentPipelineInfo(DeploymentPipelineId={pipelineId},SourceEnvironmentId='{BAP_SOURCE_ENV_ID}',ArtifactName='{solutionName}')
Authorization: Bearer {HOST_TOKEN}
OData-MaxVersion: 4.0
OData-Version: 4.0
Accept: application/json
```

Where `BAP_SOURCE_ENV_ID` = the BAP GUID of the dev environment (from `pac env list`, stored in `.last-pipeline.json` or available from `pac env who`).

Extract:
- `SourceDeploymentEnvironmentId` — use as the `devdeploymentenvironment` binding in the stage run. Store as `sourceDeploymentEnvironmentId`.
- `StageRunsDetails[].DeploymentStage` — confirms available stages and their IDs
- `EnableAIDeploymentNotes` — store as `AI_NOTES_ENABLED` (bool)

Use `solutionId` from `.solution-manifest.json` as `ARTIFACT_SOLUTION_ID` and `uniqueName` as `ARTIFACT_SOLUTION_NAME`.

> **If `RetrieveDeploymentPipelineInfo` returns 404** (older Pipelines package): use the navigation property to find the source deployment environment:
> ```
> GET {hostEnvUrl}/api/data/v9.1/deploymentpipelines({pipelineId})/deploymentpipeline_deploymentenvironment?$select=deploymentenvironmentid,name,environmenttype
> ```
> Filter for `environmenttype = 200000000` to get the source record. Use `deploymentenvironmentid` as the `sourceDeploymentEnvironmentId`. For the artifact/solution list, use `sourceDeploymentEnvironmentId` from `.last-pipeline.json` and `solutionName` from `.solution-manifest.json` as fallbacks. Set a flag `VALIDATE_PACKAGE_UNAVAILABLE = true` to skip Phase 4.2–4.3 and use the PAC CLI path in Phase 6.

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

For `artifactversion`, increment the patch number of the source version (e.g., `1.0.0.2` → `1.0.0.3`). This must be strictly greater than the version already deployed in the target stage. If deploying to the same stage multiple times, check `.last-deploy.json` for the last `artifactVersion` and use a higher value.

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

### Phase 6 — Deploy and Monitor

> **If `ValidatePackageAsync` was unavailable (`VALIDATE_PACKAGE_UNAVAILABLE = true`)**: use the PAC CLI as the primary deployment mechanism instead of 6.1:
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
> If CLI succeeds: parse the output for stage run status, write `.last-deploy.json` with `status: "Succeeded"` (or the parsed status), and skip the `DeployPackageAsync` call and polling in 6.1–6.2.

**6.1 Trigger deployment** (skip if `VALIDATE_PACKAGE_UNAVAILABLE = true` — use PAC CLI path above):

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

**7.3 Write `.last-deploy.json`** to the project root:

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

Compute the history filename: `{YYYY-MM-DD}-{stageName}-{artifactVersion}.html` (same derivation as `.last-deploy.json`'s `deployHistoryFile` field — replace spaces with hyphens, lowercase stage name).

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
git add .last-deploy.json docs/deploy-history/{filename}.html
git commit -m "Deploy {solutionUniqueName} v{artifactVersion} to {stageName} ({status})"
```

If git is not initialized in the project root (i.e., `git rev-parse --git-dir` fails), skip the commit silently.

**7.5 Run skill tracking silently:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/update-skill-tracking.js" \
  --projectRoot "." \
  --skillName "DeployPipeline" \
  --authoringTool "ClaudeCode"
```

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

**7.7 Check site activation** (only if deployment **Succeeded** and solution has Power Pages components):

Query the source environment to check whether the solution contains a website component (componentType `10374`):
```
GET {sourceEnvUrl}/api/data/v9.2/solutioncomponents?$filter=_solutionid_value eq '{solutionId}' and componenttype eq 10374&$select=objectid
Authorization: Bearer {SOURCE_TOKEN}
```

If no results, skip the rest of 7.7.

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

Evaluate the result and take action based on the outcome. In all cases, **after the outcome is resolved**, update `.last-deploy.json` and the deploy history file (described below).

- **`activated: true`**: Site is already live. Set `ACTIVATION_OUTCOME = { status: "Activated", siteUrl: "{result.websiteUrl}" }`.

- **`activated: false`**: Ask the user via `AskUserQuestion`:

  | Question | Header | Options |
  |---|---|---|
  | The Power Pages site was deployed to `{SELECTED_STAGE.targetEnvironmentUrl}` but is not yet activated (provisioned). Activate it now to make it publicly accessible. | Activate Site | Yes, activate now (Recommended), No, I'll activate later |

  - **If "Yes"**: Invoke `/power-pages:activate-site`. The activate-site skill handles subdomain selection, confirmation, and provisioning. After it completes, set `ACTIVATION_OUTCOME = { status: "Activated", siteUrl: "{site URL from activate-site}" }`.
  - **If "No"**: Set `ACTIVATION_OUTCOME = { status: "Pending", siteUrl: null }`.

- **`error` present**: Set `ACTIVATION_OUTCOME = null` — skip the update steps below silently.

**After activation outcome is resolved**, patch `.last-deploy.json` (in-place `Edit`) with the actual values:
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
3. **Phase 4**: Validation approval gate — if Pending Approval, wait for user to approve
4. **Phase 5**: `deployment-settings.json` surfaced upfront (5.0a: show summary or generate template; 5.0b: display file path). Env var values — always shown if the solution contains env var definitions with no pre-configured value for the selected stage; offer to save values for future runs
5. **Phase 6**: Deployment approval gate — if Pending Approval, wait for user to approve
6. **Phase 7.7**: Site activation — only if deployment Succeeded, Power Pages website components present, and site not yet activated in the target. Result (`activationStatus`, `siteUrl`) is written back to `.last-deploy.json` and the deploy history HTML.
7. **Phase 7.8**: Cloud flow registration — only if deployment Succeeded and solution contains cloud flow components (componenttype 29); non-blocking regardless of user answer

## Error Handling

- No `.last-pipeline.json`: stop, advise `/power-pages:setup-pipeline`
- Host environment token fails: stop with `az login` instructions
- `RetrieveDeploymentPipelineInfo` fails: use `sourceDeploymentEnvironmentId` from `.last-pipeline.json` as fallback; warn that artifact list could not be retrieved and ask user to confirm solution
- Stage run creation fails (4xx): report full error body — likely a pipeline configuration issue
- `ValidatePackageAsync` fails: report error — usually means the solution is not ready to deploy
- Validation `stagerunstatus = 200000003` (Failed): stop with validation details — user must resolve issues before retrying (new stage run required)
- Deployment `stagerunstatus = 200000003` (Failed): offer retry via `RetryFailedDeploymentAsync` (`POST /api/data/v9.1/RetryFailedDeploymentAsync {"StageRunId": "..."}`) before stopping
- `DeployPackageAsync` call fails: report error and stop
- Poll timeout (max attempts reached): stop with "Deployment is taking longer than expected. Check status in Power Platform."

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| Verify prerequisites | Verifying prerequisites | Run verify-alm-prerequisites.js (--require-manifest) for PAC/az/WhoAmI; run detect-project-context.js for solutionManifest/siteName; read .last-pipeline.json for pipelineId/stages; acquire host env token |
| Select target stage | Selecting target stage | Show available stages from .last-pipeline.json; ask user to select target; warn if last deploy to this stage failed |
| Resolve pipeline info | Resolving pipeline info | Call RetrieveDeploymentPipelineInfo (v9.1) to get SourceDeploymentEnvironmentId and DeployableArtifacts; match solution |
| Validate package | Validating package | POST deploymentstageruns (→ 201 or 204+header); POST ValidatePackageAsync top-level action (204); poll stagerunstatus until not 200000006; JSON.parse validationresults twice; fetch aigenerateddeploymentnotes; PATCH artifactversion + deploymentnotes + deploymentsettingsjson (from deployment-settings.json) |
| Configure deployment settings | Configuring deployment settings | Check/display deployment-settings.json (5.0a: read or generate template; 5.0b: surface path); query solution for env var definitions (componenttype 380); diff against deployment-settings.json for selected stage; prompt user for any unconfigured values; offer to save back to deployment-settings.json; PATCH deploymentsettingsjson on stage run |
| Deploy and monitor | Deploying and monitoring | POST DeployPackageAsync top-level action (204); poll via filter GET (10s) until stagerunstatus terminal; handle approval gates (cancel via PATCH iscanceled=true); offer RetryFailedDeploymentAsync on failure; refresh token every 10 cycles |
| Write deployment record | Writing deployment record | Write .last-deploy.json (with artifactVersion + deployHistoryFile fields); write docs/deploy-history/{date}-{stage}-{version}.md; git add + commit history file; run skill tracking; if Succeeded: show connection reference warning (if solutionManifest.cloudFlows non-empty) and bot republish warning (if solutionManifest.botComponents non-empty); present summary; if Succeeded and Power Pages components present: switch PAC to target, run check-activation-status.js, switch back, ask user to activate if not yet provisioned; if Succeeded and cloud flow components present (componenttype 29): query solutioncomponents, resolve flow names, inform user, ask AskUserQuestion (non-blocking), note registration status in summary |
