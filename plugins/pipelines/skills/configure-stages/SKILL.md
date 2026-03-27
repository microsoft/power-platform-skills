---
name: configure-stages
description: >-
  This skill should be used when the user asks to "add a stage",
  "modify pipeline stages", "add QA stage", "configure stages",
  "add production stage", or wants to add or modify stages in an
  existing Power Platform deployment pipeline.
user-invocable: true
argument-hint: Optional pipeline name and stage details
allowed-tools: Read, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: sonnet
---

# Configure Stages Skill

Add or modify stages in an existing Power Platform deployment pipeline.

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

### Phase 2: List Pipelines

Create a task: "List existing pipelines and stages"

1. Get the current environment URL and ID from `pac env who`.
2. List available pipelines:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/list-pipelines.js" \
     --envUrl "<envUrl>" \
     --sourceEnvId "<sourceEnvId>"
   ```
3. For the selected pipeline, query its current stages:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" \
     "<envUrl>" GET \
     "deploymentpipelines(<pipelineId>)?$expand=deploymentpipeline_deploymentstage($select=name,deploymentstageid)"
   ```
4. Present the current pipeline configuration:

   | Pipeline | Stages |
   |---|---|
   | `<pipeline-name>` | Stage 1: QA → `<qa-env>`, Stage 2: Prod → `<prod-env>` |

Update task to completed.

### Phase 3: Plan Changes

Create a task: "Plan stage modifications"

1. Ask the user (via `AskUserQuestion`) what changes they want:
   - Add a new stage? (e.g., "Add a Staging stage between QA and Prod")
   - Which target environment should the new stage deploy to?
2. If the target environment needs to be registered, note that.
3. Present the planned changes:

   | Action | Stage Name | Target Environment |
   |---|---|---|
   | Add | Staging | `<staging-env>` |

4. Ask the user to confirm.

Update task to completed.

### Phase 4: Execute

Create tasks for each operation:

#### 4a. Register New Target Environments (if needed)
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/register-environment.js" \
  --envUrl "<envUrl>" \
  --environmentId "<newTargetEnvGuid>" \
  --name "<target-env-name>" \
  --type target
```

#### 4b. Create New Stages
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-stage.js" \
  --envUrl "<envUrl>" \
  --pipelineId "<pipelineId>" \
  --name "<stage-name>" \
  --targetEnvId "<targetEnvRegistrationId>" \
  --description "<description>"
```

Update each sub-task as it completes.

### Phase 5: Verify

Create a task: "Verify stage configuration"

Query the updated pipeline:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" \
  "<envUrl>" GET \
  "deploymentpipelines(<pipelineId>)?$expand=deploymentpipeline_deploymentstage($select=name,deploymentstageid)"
```

Confirm the new stages appear in the pipeline configuration.

Update task to completed.

### Phase 6: Summary

Present the updated pipeline configuration:

| Stage | Name | Target Environment | Status |
|---|---|---|---|
| 1 | QA | `<qa-env>` | Existing |
| 2 | Staging | `<staging-env>` | ✅ New |
| 3 | Production | `<prod-env>` | Existing |

**Next Steps:**
- Use `/deploy-solution` to deploy through the updated pipeline
- Use `/list-pipelines` to verify all pipelines
- Use `/pipeline-status` to check deployment runs

---

## Progress Tracking

| Phase | Task | Status |
|---|---|---|
| 1 | Verify prerequisites | ⬜ |
| 2 | List existing pipelines and stages | ⬜ |
| 3 | Plan stage modifications | ⬜ |
| 4a | Register new target environments | ⬜ |
| 4b | Create new stages | ⬜ |
| 5 | Verify stage configuration | ⬜ |
| 6 | Summary | ⬜ |

## Key Decision Points

1. **Pipeline selection** — If multiple pipelines exist, the user must select which one to modify.
2. **Stage ordering** — Confirm the intended promotion order with the user.
3. **Environment registration** — New target environments must be registered before creating stages that reference them.
4. **Confirmation** — Always confirm planned changes before executing.
