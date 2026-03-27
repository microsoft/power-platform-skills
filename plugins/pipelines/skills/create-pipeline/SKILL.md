---
name: create-pipeline
description: >-
  This skill should be used when the user asks to "create a pipeline",
  "set up a deployment pipeline", "scaffold pipeline", "create ALM pipeline",
  "configure deployment pipeline", or wants to create a Power Platform
  deployment pipeline for promoting solutions across environments.
user-invocable: true
argument-hint: Optional pipeline name and environment details
allowed-tools: Read, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: sonnet
---

# Create Pipeline Skill

Create a Power Platform deployment pipeline with source and target environments, including all stages.

## Workflow

### Phase 1: Verify Prerequisites

Create a task: "Verify prerequisites"

1. Run `pac auth who` to verify PAC CLI authentication.
2. Run `az account show` to verify Azure CLI authentication.
3. Run the Dataverse access check:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-dataverse-access.js" --envUrl "<envUrl>"
   ```
4. If any check fails, stop and tell the user what to fix (see `references/troubleshooting.md`).

Update task to completed.

### Phase 2: Discover Environments

Create a task: "Discover environments"

1. Get the current environment from `pac env who` output — this is the **pipeline host** environment.
2. Ask the user (via `AskUserQuestion`):
   - What is the **source (development)** environment URL or ID?
   - What are the **target** environment(s) (QA, Staging, Production)?
   - What should the pipeline be named?
3. If the user is unsure, run `pac env list` to show available environments and let them pick.
4. Check if a pipeline with the requested name already exists:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" \
     "<envUrl>" GET \
     "deploymentpipelines?$filter=name eq '<pipeline-name>'"
   ```
   If a pipeline with this name exists, inform the user and ask:
   - Use the existing pipeline
   - Choose a different name
   - Delete the existing one and recreate

Update task to completed.

### Phase 3: Plan Pipeline

Create a task: "Plan pipeline configuration"

Present the pipeline configuration in a table:

| Setting | Value |
|---|---|
| Pipeline Name | `<name>` |
| Host Environment | `<host-env-url>` (where pipeline config is stored) |
| Source Environment (Dev) | `<source-env-url>` (where solution is developed) |
| Target Environment(s) | `<target-1>`, `<target-2>`, ... (where solution deploys as managed) |
| Stages | `<stage-1-name>` → `<target-1>`, `<stage-2-name>` → `<target-2>`, ... |
| AI Deployment Notes | Enabled (default) |

> **Note:** Pipelines require 3 environments: a **host** (where pipeline configuration entities live), a **dev/source** (where the solution is authored), and one or more **targets** (where the solution deploys as managed). The host environment is often the same as the dev environment in simple setups.

Ask the user to confirm via `AskUserQuestion`: "Does this pipeline configuration look correct? (yes/no)"

If the user says no, go back to Phase 2 to collect corrected information.

Update task to completed.

### Phase 4: Create Pipeline Resources

Create tasks for each sub-step:

#### 4a. Register Source Environment
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/register-environment.js" \
  --envUrl "<hostEnvUrl>" \
  --environmentId "<sourceEnvGuid>" \
  --name "<source-env-name>" \
  --type development
```
Save the returned `environmentId` for later use.

#### 4b. Register Target Environment(s)
For **each** target environment:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/register-environment.js" \
  --envUrl "<hostEnvUrl>" \
  --environmentId "<targetEnvGuid>" \
  --name "<target-env-name>" \
  --type target
```
Save each returned `environmentId`.

#### 4c. Create Pipeline
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-pipeline.js" \
  --envUrl "<hostEnvUrl>" \
  --name "<pipeline-name>" \
  [--enableAI]
```
Save the returned `pipelineId`.

#### 4d. Associate Source Environment
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/associate-environment.js" \
  --envUrl "<hostEnvUrl>" \
  --pipelineId "<pipelineId>" \
  --environmentId "<sourceEnvRegistrationId>"
```

#### 4e. Create Stages
For **each** target environment/stage:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-stage.js" \
  --envUrl "<hostEnvUrl>" \
  --pipelineId "<pipelineId>" \
  --name "<stage-name>" \
  --targetEnvId "<targetEnvRegistrationId>" \
  --description "<optional-description>"
```

Update each sub-task as it completes.

### Phase 5: Verify

Create a task: "Verify pipeline creation"

Query the created pipeline to confirm all entities exist:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" \
  "<hostEnvUrl>" GET \
  "deploymentpipelines(<pipelineId>)?$expand=deploymentpipeline_deploymentenvironment,deploymentpipeline_deploymentstage"
```

Validate that:
- The pipeline record exists with the correct name
- The source environment is associated
- All stages are present with correct target environments

Update task to completed.

### Phase 6: Summary

Present the final pipeline configuration:

| Resource | ID | Name | Details |
|---|---|---|---|
| Pipeline | `<id>` | `<name>` | Active, Standard deployment |
| Source Env | `<id>` | `<name>` | Development |
| Target Env 1 | `<id>` | `<name>` | Target |
| Stage 1 | `<id>` | `<name>` | → Target Env 1 |

**Next Steps:**
- Use `/list-pipelines` to view all pipelines
- Use `/deploy-solution` to deploy a solution through this pipeline
- Use `/configure-stages` to add more stages

---

## Progress Tracking

| Phase | Task | Status |
|---|---|---|
| 1 | Verify prerequisites | ⬜ |
| 2 | Discover environments | ⬜ |
| 3 | Plan pipeline configuration | ⬜ |
| 4a | Register source environment | ⬜ |
| 4b | Register target environment(s) | ⬜ |
| 4c | Create pipeline | ⬜ |
| 4d | Associate source environment | ⬜ |
| 4e | Create stage(s) | ⬜ |
| 5 | Verify pipeline creation | ⬜ |
| 6 | Summary | ⬜ |

## Key Decision Points

1. **Environment selection** — The user must confirm source and target environments before any resources are created.
2. **Pipeline name** — Must be unique within the host environment.
3. **AI deployment notes** — Optional feature; ask user if they want it enabled.
4. **Stage ordering** — Stages are created in the order the user specifies; confirm the promotion order.
5. **Error recovery** — If a step fails mid-creation, report what was created and what failed. The user can retry with `/configure-stages`.
