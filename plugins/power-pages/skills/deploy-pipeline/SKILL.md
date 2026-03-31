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

1. Locate `.last-pipeline.json` — if not found, stop and advise running `/power-pages:setup-pipeline` first.

   Read: `pipelineId`, `pipelineName`, `hostEnvUrl`, `sourceDeploymentEnvironmentId`, `solutionName`, and `stages[]`.

2. Locate `.solution-manifest.json` — read `solution.solutionId`, `solution.uniqueName`. If not found, continue using `solutionName` from `.last-pipeline.json`.

3. Run `az account show -o json 2>/dev/null` — if it fails, stop and advise the user to run `az login` first.

4. Acquire host environment token:
   ```bash
   az account get-access-token --resource "{hostEnvOrigin}" --query accessToken -o tsv 2>/dev/null
   ```
   Where `hostEnvOrigin` = scheme + host of `hostEnvUrl`. Store as `HOST_TOKEN`. If acquisition fails, stop with instructions to check Azure CLI auth.

5. Report: "Pipeline: `{pipelineName}`. Solution: `{solutionName}`. Available stages: `{stage names}`."

### Phase 2 — Select Target Stage

If the user passed a stage name or environment label as an argument (e.g., `staging`), match it against stages in `.last-pipeline.json` and skip this question.

Otherwise, ask via `AskUserQuestion`:

> "Which environment do you want to deploy to?
> {numbered list of stages from .last-pipeline.json, e.g.:
> 1. Deploy to Staging → {stagingEnvUrl}
> 2. Deploy to Production → {prodEnvUrl}}"

Store selected stage as `SELECTED_STAGE` (with `stageId`, `name`, `targetDeploymentEnvironmentId`, `targetEnvironmentUrl`).

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

**4.1 Create stage run** (note `$select` query param — required to return the ID):

```
POST {hostEnvUrl}/api/data/v9.0/deploymentstageruns?$select=deploymentstagerunid
Content-Type: application/json
Authorization: Bearer {HOST_TOKEN}

{
  "deploymentstageid@odata.bind": "/deploymentstages({SELECTED_STAGE.stageId})",
  "devdeploymentenvironment@odata.bind": "/deploymentenvironments({sourceDeploymentEnvironmentId})",
  "artifactname": "{ARTIFACT_SOLUTION_NAME}",
  "solutionid": "{ARTIFACT_SOLUTION_ID}",
  "makerainoteslanguagecode": "en-US"
}
```

> **Note**: `deploymentstageid` is the correct binding name (not `stageid`). `devdeploymentenvironment` binds to the source deployment environment record (not `artifactid`). `artifactname` is required — provide the solution unique name string.

```
```

Response is **HTTP 201** (newer Pipelines package) or **HTTP 204** (older package) depending on host version.
- **201**: JSON body contains `deploymentstagerunid` — extract directly.
- **204**: Extract from `OData-EntityId` response header — parse the GUID from `deploymentstageruns({GUID})`.

```js
// Fallback for 204 response
const entityId = res.headers['odata-entityid'] || '';
const m = entityId.match(/deploymentstageruns\(([^)]+)\)/);
stageRunId = m ? m[1] : null;
```

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

**4.3 Poll validation** — poll using single-entity GET, check `stagerunstatus`:

```
GET {hostEnvUrl}/api/data/v9.0/deploymentstageruns({STAGE_RUN_ID})?$select=deploymentstagerunid,stagerunstatus,errormessage,operation,operationdetails,operationstatus,scheduledtime,targetenvironmentid,validationresults,artifactname,deploymentsettingsjson
Authorization: Bearer {HOST_TOKEN}
```

Poll every 20 seconds, max 30 attempts. In-progress while `stagerunstatus = 200000006` (Validating).

Terminal validation values:
- `200000007` (Validation Succeeded) → proceed to Phase 5
- `200000003` (Failed) → stop, display `validationresults` error details
- `200000004` (Canceled) → stop

> **Important**: `validationresults` is a **double-encoded JSON string** — call `JSON.parse()` on it twice (or once after `JSON.parse()` of the OData response body) to get the object. The object has shape: `{ ValidationStatus, SolutionValidationResults: [{ SolutionValidationResultType, Message, ErrorCode }], SolutionDetails, MissingDependencies }`.

Surface any `SolutionValidationResults` entries to the user as warnings. Pay special attention to:
- `ErrorCode: -2147188672` — managed/unmanaged conflict: "The solution is already installed as unmanaged but this package is managed." The user must uninstall the existing solution from the target environment first, then retry.
- Missing connection references or environment variable gaps

If `stagerunstatus = 200000005` (Pending Approval): inform the user they need to approve in Power Platform (`make.powerapps.com` → Solutions → Pipelines → find this run → Approve). Ask via `AskUserQuestion`: "Have you approved the validation? 1. Yes, continue / 2. No, cancel"

**4.4 Fetch AI-generated deployment notes** (if `AI_NOTES_ENABLED = true`):

```
GET {hostEnvUrl}/api/data/v9.0/deploymentstageruns({STAGE_RUN_ID})?$select=aigenerateddeploymentnotes,deploymentstagerunid
Authorization: Bearer {HOST_TOKEN}
```

Store `aigenerateddeploymentnotes` as `AI_DEPLOY_NOTES`.

### Phase 5 — Configure Deployment Settings (Optional)

If `validationresults` surfaced missing connection references or environment variables, or if the user requests configuration:

Ask via `AskUserQuestion`:
> "Do you want to configure deployment settings (environment variables, connection references) for this deployment?
> 1. Yes — I need to configure settings
> 2. No — use defaults"

**If Yes**: Ask the user to provide values for each missing item. Then PATCH the stage run:

```
PATCH {hostEnvUrl}/api/data/v9.0/deploymentstageruns({STAGE_RUN_ID})
Content-Type: application/json
Authorization: Bearer {HOST_TOKEN}

{
  "deploymentsettingsjson": "{...JSON-serialized string...}"
}
```

The `deploymentsettingsjson` field must be a **JSON-serialized string** (stringify the settings object before sending):

```json
{
  "EnvironmentVariables": [
    { "SchemaName": "prefix_VarName", "Value": "target-value" }
  ],
  "ConnectionReferences": [
    { "LogicalName": "prefix_ConnRefName", "ConnectionId": "target-connection-id" }
  ]
}
```

**If No** (or no issues surfaced): skip this phase.

**5.2 PATCH stage run with artifact version, deployment notes, and environment variables** (always run):

First, determine the current solution version in the **source (dev) environment** — this must match exactly:
```
GET {sourceEnvUrl}/api/data/v9.0/solutions?$filter=uniquename eq '{SOLUTION_NAME}'&$select=version
Authorization: Bearer {SOURCE_TOKEN}
```
Use the returned `version` as `artifactdevcurrentversion`. Do NOT use the version from `.solution-manifest.json` — that may be stale.

For `artifactversion`, increment the patch number of the source version (e.g., `1.0.0.2` → `1.0.0.3`). This must be strictly greater than the version already deployed in the target stage. If deploying to the same stage multiple times, check `.last-deploy.json` for the last `artifactVersion` and use a higher value.

**Read `deployment-settings.json`** (if it exists in the project root):
```bash
cat deployment-settings.json
```

Look up the selected stage name (e.g. `"Deploy to Staging"`) in `stages` — extract its `EnvironmentVariables` array. If the file doesn't exist or the stage has no env vars, use an empty array.

Then PATCH (include `deploymentsettingsjson` only if there are env vars or connection references to set):

```
PATCH {hostEnvUrl}/api/data/v9.0/deploymentstageruns({STAGE_RUN_ID})
Content-Type: application/json
Authorization: Bearer {HOST_TOKEN}

{
  "artifactdevcurrentversion": "{current version from source env — must match exactly}",
  "artifactversion": "{new version — must be > current version in target stage}",
  "deploymentnotes": "{AI_DEPLOY_NOTES if available, otherwise a brief description of what is being deployed}",
  "deploymentsettingsjson": "{JSON.stringify({ EnvironmentVariables: [...], ConnectionReferences: [...] })}"
}
```

The `deploymentsettingsjson` value must be a **JSON-encoded string** (double-serialized). Build it from `deployment-settings.json`:
```js
const stageSettings = deploymentSettings?.stages?.[selectedStageName] || {};
const deploymentsettingsjson = JSON.stringify({
  EnvironmentVariables: stageSettings.EnvironmentVariables || [],
  ConnectionReferences: stageSettings.ConnectionReferences || [],
});
```

If there are no env vars and no connection references, omit `deploymentsettingsjson` from the PATCH body entirely.

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

**6.2 Poll stagerunstatus until terminal** — use filter GET pattern during deploy:

```
GET {hostEnvUrl}/api/data/v9.0/deploymentstageruns?$filter=(deploymentstagerunid eq {STAGE_RUN_ID})&$select=_deploymentstageid_value,deploymentstagerunid,stagerunstatus,operation,operationstatus,suboperation,artifactname
Authorization: Bearer {HOST_TOKEN}
```

Poll every 10 seconds, max 60 attempts (~10 min total). In-progress while `stagerunstatus = 200000010` (Deploying).

`suboperation` field shows progress detail:
- `200000100` = None (starting/finishing)
- `200000105` = Deploying Artifact (actively installing solution)

Terminal values:
- `200000002` (Succeeded) ✓
- `200000003` (Failed) ✗
- `200000004` (Canceled) ✗

**Approval gate handling**: If `stagerunstatus = 200000005` (Pending Approval):
- Inform user: "This deployment is waiting for approval. Please approve it in Power Platform: `make.powerapps.com` → Solutions → Pipelines → find deployment for `{STAGE_RUN_ID}` → Approve."
- Ask via `AskUserQuestion`: "Have you approved the deployment? 1. Yes, I approved it — continue polling / 2. Cancel deployment"
- If Yes: continue polling.
- If Cancel: PATCH the stage run to cancel it:
  ```
  PATCH {hostEnvUrl}/api/data/v9.0/deploymentstageruns({STAGE_RUN_ID})
  {"iscanceled": true}
  ```
  Then record status as "Canceled".

**Token refresh**: After every 10 poll cycles (~100 seconds), refresh `HOST_TOKEN` via `az account get-access-token`.

Report deployment progress updates as polling continues.

### Phase 7 — Write Deployment Record and Summary

**7.1 Determine final status string:**
- `200000002` → `"Succeeded"`
- `200000003` → `"Failed"`
- `200000004` → `"Canceled"`
- `200000005` → `"PendingApproval"` (if user cancelled waiting)
- Poll timeout → `"Unknown"`

**7.2 Write `.last-deploy.json`** to the project root:

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
  "targetEnvironmentUrl": "{SELECTED_STAGE.targetEnvironmentUrl}"
}
```

**7.3 Run skill tracking silently:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/update-skill-tracking.js" \
  --projectRoot "." \
  --skillName "DeployPipeline" \
  --authoringTool "ClaudeCode"
```

**7.4 Present summary:**

If **Succeeded**:
```
✓ Deployment succeeded

  Solution:     {solutionName}
  Stage:        {stageName}
  Target:       {targetEnvironmentUrl}
  Completed at: {deployedAt}
  Stage run ID: {STAGE_RUN_ID}
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

## Key Decision Points (Wait for User)

1. **Phase 2**: Target stage selection (which environment to deploy to)
2. **Phase 2**: Retry confirmation if last deploy to this stage failed
3. **Phase 4**: Validation approval gate — if Pending Approval, wait for user to approve
4. **Phase 5**: Configure deployment settings — yes or no
5. **Phase 6**: Deployment approval gate — if Pending Approval, wait for user to approve

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
| Verify prerequisites | Verifying prerequisites | Read .last-pipeline.json for pipelineId/stages; read .solution-manifest.json; verify az login; acquire host env token |
| Select target stage | Selecting target stage | Show available stages from .last-pipeline.json; ask user to select target; warn if last deploy to this stage failed |
| Resolve pipeline info | Resolving pipeline info | Call RetrieveDeploymentPipelineInfo (v9.1) to get SourceDeploymentEnvironmentId and DeployableArtifacts; match solution |
| Validate package | Validating package | POST deploymentstageruns (→ 201 or 204+header); POST ValidatePackageAsync top-level action (204); poll stagerunstatus until not 200000006; JSON.parse validationresults twice; fetch aigenerateddeploymentnotes; PATCH artifactversion + deploymentnotes + deploymentsettingsjson (from deployment-settings.json) |
| Configure deployment settings | Configuring deployment settings | Optionally PATCH deploymentsettingsjson on stage run with env var overrides and connection reference mappings from deployment-settings.json |
| Deploy and monitor | Deploying and monitoring | POST DeployPackageAsync top-level action (204); poll via filter GET (10s) until stagerunstatus terminal; handle approval gates (cancel via PATCH iscanceled=true); offer RetryFailedDeploymentAsync on failure; refresh token every 10 cycles |
| Write deployment record | Writing deployment record | Write .last-deploy.json with status and IDs; present success or failure summary with troubleshooting link |
