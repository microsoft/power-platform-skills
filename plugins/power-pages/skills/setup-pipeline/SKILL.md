---
name: setup-pipeline
description: >-
  Sets up a Power Platform Pipeline for automated Power Pages deployments.
  Power Platform Pipelines is Microsoft's native CI/CD tool built into the
  Power Platform — no external infrastructure required.
  Use when asked to: "set up ci/cd", "create pipeline", "setup pipeline",
  "set up power platform pipelines", "create power pipelines",
  "automate deployments", "set up automated deployment",
  "create deployment pipeline", "use power pipelines".
  Also handles: "set up github actions" or "set up azure devops pipeline"
  (shows coming-soon guidance for those platforms).
user-invocable: true
argument-hint: "Optional: 'power-platform', 'github', or 'ado' to skip platform selection"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
hooks:
  Stop:
    - hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/setup-pipeline/scripts/validate-pipeline.js"'
          timeout: 30
        - type: prompt
          prompt: |
            Check whether the setup-pipeline skill completed successfully. Return { "ok": true } if ALL of the following are true, otherwise { "ok": false, "reason": "..." }:
            1. The CI/CD platform was selected by the user
            2. For Power Platform Pipelines: .last-pipeline.json was written with pipelineId, hostEnvUrl, sourceDeploymentEnvironmentId, and non-empty stages array
            3. For Power Platform Pipelines: docs/pipeline-setup.md was written
            4. A completion summary was presented listing all created resources and next steps
          timeout: 30
---

# setup-pipeline

Sets up a **Power Platform Pipeline** for automated Power Pages solution deployments. Creates the pipeline configuration directly in Dataverse using the PP Pipelines OData API — no YAML files, no external CI/CD infrastructure needed.

GitHub Actions and Azure DevOps Pipeline options are shown in the platform menu as **coming soon**.

> Refer to `${CLAUDE_PLUGIN_ROOT}/references/cicd-pipeline-patterns.md` for all HAR-confirmed API patterns used in this skill.

## Prerequisites

- `powerpages.config.json` exists in the project root
- `.solution-manifest.json` exists (solution must be created first via `setup-solution`)
- Azure CLI logged in (`az account show` succeeds)
- PAC CLI logged in (`pac env who` succeeds)
- A Power Platform environment with Pipelines package installed (the "host" environment)

## Phases

### Phase 1 — Detect Project Context

**Create all tasks upfront at the start of this phase.**

Tasks to create:
1. "Detect project context"
2. "Select CI/CD platform"
3. "Confirm pipeline configuration"
4. "Run preflight checks"
5. "Create deployment environments"
6. "Create pipeline and stages"
7. "Verify and write artifacts"

Steps:

1. Locate `powerpages.config.json` — read `siteName` and `compiledPath`. If not found, stop and advise running `/power-pages:create-site` first.

2. Locate `.solution-manifest.json` — read `solution.uniqueName`, `solution.solutionId`, and `devEnvironmentUrl`. If not found, stop and advise running `/power-pages:setup-solution` first.

3. Run silently:
   ```bash
   pac env who --output json 2>/dev/null
   pac env list --output json 2>/dev/null
   ```
   Store `devEnvUrl` from `pac env who` (or use `devEnvironmentUrl` from `.solution-manifest.json`). Store `pac env list` output as `ENV_LIST`.

4. Acquire a token for the dev environment silently:
   ```bash
   az account get-access-token --resource "{devEnvOrigin}" --query accessToken -o tsv 2>/dev/null
   ```
   Where `devEnvOrigin` = scheme + host of `devEnvUrl`. Store as `DEV_TOKEN`.

5. Call `RetrieveSetting` on the dev env to find the tenant's Pipelines host environment:
   ```
   GET {devEnvUrl}/api/data/v9.2/RetrieveSetting(SettingName='DefaultCustomPipelinesHostEnvForTenant')
   Authorization: Bearer {DEV_TOKEN}
   OData-MaxVersion: 4.0
   OData-Version: 4.0
   Accept: application/json
   ```
   Store result as `HOST_ENV_GUID`. If null/empty, no default host is configured — will need to ask user.

6. Cross-reference `HOST_ENV_GUID` with `ENV_LIST` to find the host environment URL. Match on `EnvironmentId` field. Store as `HOST_ENV_URL`.

   If no match found: set `HOST_ENV_URL = null` (will ask user in Phase 3).

7. Check for existing `.last-pipeline.json` in the project root. If found, read its contents.

8. Report findings: "Project: `{siteName}`. Solution: `{uniqueName}`. Dev env: `{devEnvUrl}`. Host env: `{HOST_ENV_URL ?? 'not auto-detected'}`. Existing pipeline: found/not found."

**If an existing `.last-pipeline.json` is found**, ask via `AskUserQuestion`:

> "A pipeline configuration already exists for `{pipelineName}` (created {createdAt}). How would you like to proceed?
> 1. Overwrite — create a new pipeline, replacing the marker
> 2. Review existing setup first, then decide
> 3. Cancel"

- If **Review**: display the existing `.last-pipeline.json` contents, then ask again with the same 3 options.
- If **Cancel**: stop the skill and inform the user no changes were made.
- If **Overwrite**: proceed.

### Phase 2 — Select CI/CD Platform

Ask user via `AskUserQuestion`:

> "Which CI/CD platform do you want to use?
> 1. **Power Platform Pipelines** — Microsoft's native deployment pipeline. No external infrastructure needed. (Recommended)
> 2. **GitHub Actions** — Coming soon
> 3. **Azure DevOps Pipeline** — Coming soon"

If the user passed `power-platform`, `github`, or `ado` as an argument, skip this question and use the provided value.

Store the selection as `PLATFORM`.

**If `github` or `ado` selected** → display the [Coming Soon path](#coming-soon-path) and stop.

---

## Power Platform Pipelines Path

### Phase 3 — Confirm Pipeline Configuration

Before asking any questions, assemble what was auto-detected:

| Setting | Auto-detected value |
|---|---|
| Site name | `{siteName}` from `powerpages.config.json` |
| Solution unique name | `{uniqueName}` from `.solution-manifest.json` |
| Dev environment URL | `{devEnvUrl}` from `pac env who` |
| Host environment URL | `{HOST_ENV_URL}` from `RetrieveSetting` (if found) |
| BAP environment ID (dev) | From `pac env list` |

Ask user via `AskUserQuestion` with pre-filled values:

> "I've gathered the following pipeline configuration. Please confirm or correct:
>
> - **Pipeline name**: `{siteName} Pipeline` (can change)
> - **Source (Dev) environment**: `{devEnvUrl}`
> - **Host environment** (where Pipelines is installed): `{HOST_ENV_URL ?? "NOT DETECTED — please provide"}`
> - **Solution to deploy**: `{uniqueName}`
> - **Target environments**: How many? (Dev → Staging / Dev → Staging → Production)"

Collect from user:
- `PIPELINE_NAME` (default: `{siteName} Pipeline`)
- `HOST_ENV_URL` (confirm if auto-detected; ask if not)
- Target environment count and URLs (`STAGING_ENV_URL`, `PROD_ENV_URL` if applicable)
- BAP environment IDs for each target (from `pac env list` — pre-fill if found, otherwise ask)

Store `HOST_TOKEN` by running:
```bash
az account get-access-token --resource "{hostEnvOrigin}" --query accessToken -o tsv
```

Present a final confirmation summary and ask user to approve before proceeding.

### Phase 4 — Preflight Checks

Use Node.js `https` module for all Dataverse calls (curl has encoding issues on Windows).

**4.1 Verify host environment has Pipelines installed:**
```
GET {hostEnvUrl}/api/data/v9.1/deploymentpipelines?$top=0
Authorization: Bearer {HOST_TOKEN}
```
If response is 404 or returns an "unknown entity" error, stop and inform the user: "The selected host environment does not have Power Platform Pipelines installed. Please select a different environment or install the Pipelines package."

**4.2 Verify solution exists in dev environment:**
```
GET {devEnvUrl}/api/data/v9.1/solutions?$filter=uniquename eq '{uniqueName}'&$select=solutionid&$top=1
Authorization: Bearer {DEV_TOKEN}
```
If not found: warn the user. The solution must be exported from dev before it can be deployed.

**4.3 Check for existing pipeline with same name:**
```
GET {hostEnvUrl}/api/data/v9.1/deploymentpipelines?$filter=name eq '{PIPELINE_NAME}'&$select=deploymentpipelineid&$top=1
Authorization: Bearer {HOST_TOKEN}
```
If found: ask via `AskUserQuestion` whether to use the existing pipeline ID or create a new one with a different name.

Report preflight results. If any critical check failed, stop with clear instructions. If warnings only, ask user to confirm before proceeding.

### Phase 5 — Create Deployment Environments

Create Dataverse `deploymentenvironment` records for each environment. Process source env first, then targets.

**For each environment** (dev source + each target):

**5.1 Create deployment environment record:**
```
POST {hostEnvUrl}/api/data/v9.0/deploymentenvironments
Content-Type: application/json
Authorization: Bearer {HOST_TOKEN}

{
  "name": "{siteName} {label}",
  "environmentid": "{BAP-environment-GUID}",
  "environmenttype": 200000000
}
```

> **Note**: Use `environmenttype: 200000000` for the source dev environment, `environmenttype: 200000001` for target environments. The `environmenturl` field does not exist on this entity.

Extract `deploymentenvironmentid` from the `OData-EntityId` response header (parse the GUID from the URL). Store as `SOURCE_DEPLOYMENT_ENV_ID` (for dev) or `TARGET_DEPLOYMENT_ENV_IDs[n]` (for targets).

On failure: stop with the error — deployment environment creation is mandatory.

**5.2 Poll validationstatus:**
```
GET {hostEnvUrl}/api/data/v9.1/deploymentenvironments({id})?$select=validationstatus
Authorization: Bearer {HOST_TOKEN}
```

Poll until `validationstatus = 200000001` AND `statecode = 0` (Active). If `statecode = 1` with a non-null `errormessage`: the environment validation failed — report the error and stop.

> **Polling details**: Poll every 2 seconds, max 30 attempts (~1 minute). `validationstatus = 200000000` = Pending (keep polling). `validationstatus = 200000001` = Succeeded (terminal ✓). Failure = `statecode = 1` (Inactive) with non-null `errormessage`.

Poll every 3 seconds, max 20 attempts. All creates (deploymentenvironments, deploymentpipelines, deploymentstages) return **204**. Parse the created record ID from the `OData-EntityId` response header. If still not validated after max attempts: warn user and ask whether to continue or cancel.

Report progress for each environment as validation completes.

### Phase 6 — Create Pipeline, Associate Source, Create Stages

**6.1 Create pipeline record:**
```
POST {hostEnvUrl}/api/data/v9.0/deploymentpipelines
Content-Type: application/json
Authorization: Bearer {HOST_TOKEN}

{
  "name": "{PIPELINE_NAME}",
  "description": "Power Pages deployment pipeline for {siteName}"
}
```

Extract `deploymentpipelineid` from `OData-EntityId` response header. Store as `PIPELINE_ID`.

**6.2 Associate source environment via $ref:**

> **IMPORTANT (HAR-confirmed)**: Use relative path format for `@odata.id` — do NOT use the full https URL.

```
POST {hostEnvUrl}/api/data/v9.0/deploymentpipelines({PIPELINE_ID})/deploymentpipeline_deploymentenvironment/$ref
Content-Type: application/json
Authorization: Bearer {HOST_TOKEN}

{
  "@odata.context": "{hostEnvUrl}/api/data/v9.0/$metadata#$ref",
  "@odata.id": "deploymentenvironments({SOURCE_DEPLOYMENT_ENV_ID})"
}
```

Response is **204** (not 200 as originally assumed) — treat any 2xx as success.

**6.3 Create deployment stages:**

For each target environment, in deployment order:

```
POST {hostEnvUrl}/api/data/v9.0/deploymentstages
Content-Type: application/json
Authorization: Bearer {HOST_TOKEN}

{
  "name": "Deploy to {targetLabel}",
  "deploymentpipelineid@odata.bind": "/deploymentpipelines({PIPELINE_ID})",
  "targetdeploymentenvironmentid@odata.bind": "/deploymentenvironments({TARGET_DEPLOYMENT_ENV_ID})",
  "previousdeploymentstageid@odata.bind": "/deploymentstages({previousStageId})"
}
```

> **Note**: The `rank` field does not exist on `deploymentstage`. For ordering multiple stages, use `"previousdeploymentstageid@odata.bind"` to reference the prior stage ID (omit this field for the first stage).

```
```

Extract `deploymentstagesid` from `OData-EntityId` response header. Collect all stage IDs and names.

### Phase 7 — Verify, Write Artifacts, Commit

**7.1 Verify pipeline was created:**
```
GET {hostEnvUrl}/api/data/v9.1/deploymentpipelines({PIPELINE_ID})?$select=name,statecode
Authorization: Bearer {HOST_TOKEN}
```

Confirm `statecode = 0` (Active). If the query fails, report as "verification inconclusive — pipeline may still be valid".

**7.2 Write `.last-pipeline.json`** to the project root:

```json
{
  "pipelineId": "{PIPELINE_ID}",
  "pipelineName": "{PIPELINE_NAME}",
  "hostEnvUrl": "{HOST_ENV_URL}",
  "sourceDeploymentEnvironmentId": "{SOURCE_DEPLOYMENT_ENV_ID}",
  "sourceEnvironmentUrl": "{devEnvUrl}",
  "solutionName": "{uniqueName}",
  "createdAt": "{ISO timestamp}",
  "stages": [
    {
      "stageId": "{deploymentstagesid}",
      "name": "Deploy to {targetLabel}",
      "rank": 1,
      "targetDeploymentEnvironmentId": "{TARGET_DEPLOYMENT_ENV_ID}",
      "targetEnvironmentUrl": "{targetEnvUrl}"
    }
  ]
}
```

**7.3 Write `docs/pipeline-setup.md`** (create `docs/` directory if needed):

Contents:
1. **Pipeline Created** — name, host env URL, pipeline ID
2. **Environments configured** — source + each target with their deployment environment IDs
3. **How to trigger a deployment** — Run `/power-pages:deploy-pipeline` or open Power Platform make.powerapps.com → Solutions → Pipelines
4. **Approval gates** (if applicable) — How to configure in Power Platform Admin Center
5. **Troubleshooting** — Common validation errors and how to resolve them

**7.4 Commit:**
```bash
git add .last-pipeline.json docs/pipeline-setup.md
git commit -m "Add Power Platform Pipeline configuration for {siteName}"
```

**7.5 Run skill tracking silently:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/update-skill-tracking.js" \
  --projectRoot "." \
  --skillName "SetupPipeline" \
  --authoringTool "ClaudeCode"
```

**7.6 Present summary:**

| Resource | ID / URL |
|---|---|
| Pipeline | `{PIPELINE_NAME}` (`{PIPELINE_ID}`) |
| Host environment | `{HOST_ENV_URL}` |
| Source deployment env | `{SOURCE_DEPLOYMENT_ENV_ID}` |
| Stage: {name} | `{stageId}` → `{targetEnvUrl}` |

**Files written:**
- `.last-pipeline.json` — pipeline configuration marker
- `docs/pipeline-setup.md` — setup documentation

**Next step:**
> Run `/power-pages:deploy-pipeline` to trigger your first deployment run.

---

## Coming Soon Path

**If GitHub Actions or Azure DevOps was selected:**

Inform the user:

> "GitHub Actions and Azure DevOps Pipeline support are coming soon for this skill.
>
> **For now, you have two options:**
> 1. Use **Power Platform Pipelines** — select option 1 to set up Microsoft's native deployment pipeline (recommended)
> 2. Exit — I'll set up GitHub Actions / Azure DevOps manually using the documentation"

Ask via `AskUserQuestion`:
1. Switch to Power Platform Pipelines — go back to Phase 2
2. Exit — I'll set up manually

If GitHub/ADO passed as argument: display above message and exit gracefully.

---

## Key Decision Points (Wait for User)

0. **Phase 1**: Existing pipeline file — overwrite, review, or cancel (only if `.last-pipeline.json` found)
1. **Phase 2**: Platform selection (Power Platform Pipelines / GitHub coming soon / ADO coming soon)
2. **Phase 3**: Confirm pipeline configuration — pipeline name, host env URL, target environments
3. **Phase 4**: Preflight warnings — proceed or cancel
4. **Phase 3**: Parameter confirmation before pipeline creation

## Error Handling

- No `powerpages.config.json`: stop, advise `/power-pages:create-site`
- No `.solution-manifest.json`: stop, advise `/power-pages:setup-solution`
- `RetrieveSetting` returns empty: ask user for host environment URL manually
- Deployment environment `statecode = 1` with non-null `errormessage` (validation failed): stop with error details
- Pipeline `$ref` call fails: stop — this association is required before stages can be created
- Stage creation fails: record failure, continue with remaining stages — partial success is valid

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| Detect project context | Detecting project context | Read powerpages.config.json and .solution-manifest.json; run pac env who and pac env list; call RetrieveSetting to find host env; check for existing .last-pipeline.json |
| Select CI/CD platform | Selecting CI/CD platform | Ask user: Power Platform Pipelines (full) or GitHub/ADO (coming soon) |
| Confirm pipeline configuration | Confirming pipeline configuration | Pre-fill pipeline name, source env, host env, solution name from auto-detected values; ask for target environments; get user confirmation |
| Run preflight checks | Running preflight checks | Verify host env has Pipelines installed; verify solution exists in dev env; check for pipeline name conflict |
| Create deployment environments | Creating deployment environments | POST deploymentenvironments for source + each target; poll validationstatus for each until Succeeded |
| Create pipeline and stages | Creating pipeline and stages | POST deploymentpipelines; $ref associate source env; POST deploymentstages for each target (linked via previousdeploymentstageid) |
| Verify and write artifacts | Verifying and writing artifacts | Query pipeline to confirm active; write .last-pipeline.json; write docs/pipeline-setup.md; commit; present summary with next steps |
