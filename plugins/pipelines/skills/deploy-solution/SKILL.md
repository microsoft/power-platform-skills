---
name: deploy-solution
description: >-
  This skill should be used when the user asks to "deploy a solution",
  "run the pipeline", "promote solution", "deploy to QA", "deploy to production",
  "push solution to next stage", or wants to deploy a Dataverse solution
  through a Power Platform deployment pipeline.
user-invocable: true
argument-hint: Optional solution name and target stage
allowed-tools: Read, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: sonnet
---

# Deploy Solution Skill

Deploy a Dataverse solution through a Power Platform deployment pipeline to a target stage.

## Workflow

### Phase 1: Verify Prerequisites

Create a task: "Verify prerequisites"

1. Run `pac auth who` to verify PAC CLI authentication.
2. Run `az account show` to verify Azure CLI authentication.
3. Run the Dataverse access check:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-dataverse-access.js"
   ```

Update task to completed.

### Phase 2: Discover Pipeline

Create a task: "Discover available pipelines"

1. Get the current environment URL and ID from `pac env who`.
2. List available pipelines:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/list-pipelines.js" \
     --envUrl "<envUrl>" \
     --sourceEnvId "<sourceEnvId>"
   ```
3. If the user provided a pipeline name in their request, match it. Otherwise, present the list and let the user select via `AskUserQuestion`.

Update task to completed.

### Phase 3: Get Pipeline Details

Create a task: "Get pipeline details"

Run the pipeline info script to get stages and solution details:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/get-pipeline-info.js" \
  --envUrl "<envUrl>" \
  --pipelineId "<pipelineId>" \
  --sourceEnvId "<sourceEnvId>" \
  --artifactName "<solutionName>"
```

Extract:
- Available stages and their target environments
- Solution information (ID, version)
- Previous deployment history if available

Update task to completed.

### Phase 4: Select Stage & Confirm

Create a task: "Select stage and confirm deployment"

1. Present the available stages:

   | # | Stage | Target Environment | Last Deployed |
   |---|---|---|---|
   | 1 | QA | `<qa-env>` | `<date>` or Never |
   | 2 | Production | `<prod-env>` | `<date>` or Never |

2. If the user specified a target stage in their request, match it. Otherwise, ask via `AskUserQuestion`.

3. Present the deployment plan:

   | Setting | Value |
   |---|---|
   | Solution | `<solution-name>` |
   | Pipeline | `<pipeline-name>` |
   | Stage | `<stage-name>` |
   | Target Environment | `<target-env>` |
   | Deployment Type | Standard (Managed) |

4. Ask for confirmation via `AskUserQuestion`: "Ready to deploy? This will export, package, and import the solution as managed. (yes/no)"

Update task to completed.

### Phase 5: Create Stage Run & Validate

Create a task: "Create stage run and validate"

Step 1 — Create the deployment stage run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/start-deployment.js" \
  --envUrl "<envUrl>" \
  --artifactName "<solutionName>" \
  --devEnvId "<devEnvRegistrationId>" \
  --stageId "<stageId>" \
  --solutionId "<solutionId>"
```

Capture the `stageRunId` from the output.

Step 2 — Trigger package validation:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-deployment.js" \
  --envUrl "<envUrl>" \
  --stageRunId "<stageRunId>"
```

Step 3 — Poll until validation completes:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-deployment-status.js" \
  --envUrl "<envUrl>" \
  --stageRunId "<stageRunId>" \
  --poll \
  --waitFor validation \
  --interval 20 \
  --maxWait 300
```

Wait for `stagerunstatus` to reach:
- `200000007` (Validation Succeeded) → proceed to Phase 6
- `200000003` (Failed) → show error and stop

Update task to completed.

### Phase 6: Configure & Deploy

Create a task: "Configure settings and deploy"

Step 1 (if solution has env vars or connection refs) — Update deployment settings:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/update-deployment-settings.js" \
  --envUrl "<envUrl>" \
  --stageRunId "<stageRunId>" \
  --settings '{"EnvironmentVariables":[...],"ConnectionReferences":[...]}'
```

> The LLM should prompt the user for environment variable values and connection IDs based on what the solution requires. Present each variable/connection and ask the user for the target environment value.

Step 2 — Trigger the actual deployment:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/deploy-package.js" \
  --envUrl "<envUrl>" \
  --stageRunId "<stageRunId>" \
  --notes "Deployed via Pipelines skill"
```

Update task to completed.

### Phase 7: Monitor Deployment

Create a task: "Monitor deployment"

Poll the deployment status:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-deployment-status.js" \
  --envUrl "<envUrl>" \
  --stageRunId "<stageRunId>" \
  --poll \
  --interval 10 \
  --maxWait 600
```

Report progress updates to the user as the deployment progresses through:
NotStarted → Started → Deploying → Succeeded/Failed

If the deployment takes too long, let the user know and suggest checking again with `/pipeline-status`.

Update task to completed.

### Phase 8: Summary

Present the final deployment result:

| Detail | Value |
|---|---|
| Solution | `<solution-name>` |
| Pipeline | `<pipeline-name>` |
| Stage | `<stage-name>` |
| Target Environment | `<target-env>` |
| Status | ✅ Succeeded / ❌ Failed |
| Duration | `<elapsed-time>` |
| Stage Run ID | `<stageRunId>` |

If the deployment **succeeded**:
- Confirm the solution is now available in the target environment.
- Suggest deploying to the next stage if there is one.

If the deployment **failed**:
- Show the error message from the stage run.
- Refer to `references/troubleshooting.md` for common issues.
- Suggest checking `/pipeline-status <stageRunId>` for more details.

**Next Steps:**
- Use `/pipeline-status` to re-check deployment status
- Use `/deploy-solution` to deploy to the next stage
- Use `/list-pipelines` to see all pipelines

---

## Progress Tracking

| Phase | Task | Status |
|---|---|---|
| 1 | Verify prerequisites | ⬜ |
| 2 | Discover available pipelines | ⬜ |
| 3 | Get pipeline details | ⬜ |
| 4 | Select stage and confirm | ⬜ |
| 5 | Create stage run & validate | ⬜ |
| 6 | Configure settings & deploy | ⬜ |
| 7 | Monitor deployment | ⬜ |
| 8 | Summary | ⬜ |

## Key Decision Points

1. **Pipeline selection** — If multiple pipelines exist, user must select one.
2. **Stage selection** — User must confirm the target stage.
3. **Deployment confirmation** — Always ask before starting a deployment (it modifies the target environment).
4. **Timeout handling** — If polling times out (maxWait exceeded), the deployment may still be running. Tell the user they can check again with `/pipeline-status`.
5. **Failure handling** — On failure, show the error and suggest remediation. Do not retry automatically.
