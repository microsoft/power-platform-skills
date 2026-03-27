---
name: list-pipelines
description: >-
  This skill should be used when the user asks to "list pipelines",
  "show my pipelines", "what pipelines exist", "show deployment pipelines",
  or wants to see available Power Platform deployment pipelines.
user-invocable: true
allowed-tools: Read, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: sonnet
---

# List Pipelines Skill

List all Power Platform deployment pipelines available from a source environment.

## Workflow

### Phase 1: Verify Prerequisites

Create a task: "Verify prerequisites"

1. Run `pac auth who` to verify PAC CLI authentication.
2. Run `az account show` to verify Azure CLI authentication.
3. Run the Dataverse access check:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-dataverse-access.js"
   ```
4. If any check fails, stop and tell the user what to fix.

Update task to completed.

### Phase 2: Discover Environment

Create a task: "Discover source environment"

1. Run `pac env who` to get the current environment URL and ID.
2. Extract the source environment ID from the output.
3. If the environment ID cannot be determined, ask the user to provide it or select from `pac env list`.

Update task to completed.

### Phase 3: List Pipelines

Create a task: "List pipelines"

Run the list pipelines script:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/list-pipelines.js" \
  --envUrl "<envUrl>" \
  --sourceEnvId "<sourceEnvId>"
```

Parse the JSON output and format as a table:

| # | Pipeline Name | Pipeline ID | Associated to Source |
|---|---|---|---|
| 1 | `<name>` | `<id>` | Yes / No |

> **Note:** For stage details, use `/create-pipeline` or query the pipeline directly.

If no pipelines are found, inform the user and suggest `/create-pipeline`.

Update task to completed.

### Phase 4: Summary

Present the pipelines in a clear table format. For each pipeline, show:
- Name and ID
- Whether the pipeline is associated to the source environment

**Next Steps:**
- Use `/deploy-solution <solution-name>` to deploy through a pipeline
- Use `/create-pipeline` to create a new pipeline
- Use `/configure-stages` to modify stages on an existing pipeline
- Use `/pipeline-status` to check a deployment run

---

## Progress Tracking

| Phase | Task | Status |
|---|---|---|
| 1 | Verify prerequisites | ⬜ |
| 2 | Discover source environment | ⬜ |
| 3 | List pipelines | ⬜ |
| 4 | Summary | ⬜ |

## Key Decision Points

1. **Environment selection** — If the user has multiple auth profiles, they may need to specify which environment to query.
2. **No pipelines found** — Direct the user to `/create-pipeline` to set up their first pipeline.
