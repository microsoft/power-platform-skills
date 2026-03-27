---
name: pipeline-status
description: >-
  This skill should be used when the user asks to "check deployment status",
  "how is my deployment going", "pipeline run status", "check stage run",
  or wants to check the status of a Power Platform deployment pipeline run.
user-invocable: true
argument-hint: Optional stage run ID
allowed-tools: Read, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList
model: sonnet
---

# Pipeline Status Skill

Check the status of a Power Platform deployment pipeline stage run.

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

### Phase 2: Get Stage Run

Create a task: "Get stage run information"

1. If the user provided a stage run ID in their request, use it directly.
2. If no stage run ID was provided, query recent stage runs:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" \
     "<envUrl>" GET \
     "deploymentstageruns?$orderby=createdon desc&$top=10&$select=deploymentstagerunid,artifactname,statuscode,createdon,modifiedon"
   ```
3. Present recent runs in a table and let the user identify which one to check.

Update task to completed.

### Phase 3: Check Status

Create a task: "Check deployment status"

Run the status check:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-deployment-status.js" \
  --envUrl "<envUrl>" \
  --stageRunId "<stageRunId>"
```

Parse the result and display the current status.

Update task to completed.

### Phase 4: Summary

Present the status information:

| Detail | Value |
|---|---|
| Stage Run ID | `<stageRunId>` |
| Solution | `<artifactName>` |
| Status | 🔵 Running / ✅ Succeeded / ❌ Failed / ⭕ Not Started / 🚫 Canceled |
| Started | `<createdon>` |
| Last Updated | `<modifiedon>` |

If still running:
- Suggest waiting and checking again with `/pipeline-status <stageRunId>`.

If failed:
- Show error details if available.
- Refer to `references/troubleshooting.md` for common failure reasons.

**Next Steps:**
- Use `/deploy-solution` to start a new deployment
- Use `/list-pipelines` to view all pipelines

---

## Progress Tracking

| Phase | Task | Status |
|---|---|---|
| 1 | Verify prerequisites | ⬜ |
| 2 | Get stage run information | ⬜ |
| 3 | Check deployment status | ⬜ |
| 4 | Summary | ⬜ |

## Key Decision Points

1. **Stage run identification** — If the user doesn't provide an ID, show recent runs and let them pick.
2. **Polling** — For the single-check skill, do not poll by default. Show current status and let the user re-invoke if needed.
