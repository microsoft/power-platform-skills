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

6. Report to user:
   ```
   Found: **{siteName}** on `{devEnvUrl}`.
   Solution: {✓ already set up ({solutionUniqueName}) / ✗ not yet}.
   Pipeline: {✓ already set up ({pipelineName}) / ✗ not yet}.
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

### PP Pipelines Path — Q3 through Q8

**Q3:** Ask via `AskUserQuestion`:
> "How many deployment stages do you need?"

Options:
1. Dev → Staging (2 environments)
2. Dev → Staging → Production (3 environments, Recommended)
3. Dev → Production only
4. Custom — I'll describe it

If option 4: accept free-text description and build a stage list from the response.

Store stages as `PP_STAGES` (array of `{ label, envUrl }`). Dev is always the source.

**Q4 (auto-detect + confirm — host environment):**

Run silently using `discover-pipelines-host.js`:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/discover-pipelines-host.js" \
  --envUrl "{DEV_ENV_URL}" --token "{DEV_TOKEN}" --userId "{userId}"
```

- **If auto-detected:** Ask via `AskUserQuestion`:
  > "Use detected Pipelines host environment `{HOST_ENV_URL}`?"
  Options: 1. Yes, use this / 2. Enter a different URL

- **If not detected:** Ask for free-text input. Pre-fill from `.last-pipeline.json` if present.

Store as `HOST_ENV_URL`.

**Q5:** Ask via `AskUserQuestion`:
> "Should deployments require approval before each stage?"

Options:
1. Required before each stage (Recommended for production)
2. Staging auto-approve, production requires approval
3. No approval gates — deploy automatically

Store as `PP_APPROVAL_MODE`.

**Q6:** Ask via `AskUserQuestion`:
> "How should the solution be exported for production?"

Options:
1. Managed — cannot be edited in target (Recommended)
2. Unmanaged — can be edited in target

Store as `EXPORT_TYPE` (`managed` or `unmanaged`).

**Q7 (auto-detect, no question):** Check `.solution-manifest.json` for `envVarDefinitions` or components with `componenttype 380`. If found, set `HAS_ENV_VARS = true` — note in plan that `deploy-pipeline` will prompt for per-stage env var values.

**Q8:** Ask via `AskUserQuestion`:
> "Do you use Git source control for this site?" (informational only — no automation)

Options:
1. Yes — we use Git
2. No — not using source control
3. Not yet

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

**Q7 (auto-detect, no question):** Same as PP Pipelines Q7 — check for env var definitions.

**Q8:** Same as PP Pipelines Q8 — Git source control status.

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
| 5 | Deploy via pipeline | Deploying via pipeline | Invoke deploy-pipeline skill |
| 6 | Finalize | Finalizing | Update HTML status, commit, run skill tracking |

**For Manual path**, create:

| # | Subject | activeForm | Description |
|---|---------|-----------|-------------|
| 1 | Generate ALM plan | Generating ALM plan | Build planData, render docs/alm-plan.html |
| 2 | Approve ALM plan | Awaiting plan approval | Present inline summary, get user confirmation |
| 3 | Setup solution | Setting up solution | Invoke setup-solution skill (conditional) |
| 4 | Export solution | Exporting solution | Invoke export-solution skill |
| 5..N | Import to {targetLabel} | Importing solution | Switch PAC CLI context, invoke import-solution (one task per target) |
| N+1 | Finalize | Finalizing | Update HTML status, commit, run skill tracking |

If `SOLUTION_DONE = true`, add `(will skip — already set up)` to the setup-solution task description.
If `PIPELINE_DONE = true` (PP path), add `(will skip — already set up)` to the setup-pipeline task description.

Mark task 1 ("Generate ALM plan") as `in_progress`.

### Build planData

Build a `planData` object with all gathered strategy inputs:

```json
{
  "SITE_NAME": "{siteName}",
  "GENERATED_AT": "{ISO timestamp}",
  "STRATEGY": "pp-pipelines | manual",
  "EXPORT_TYPE": "managed | unmanaged",
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
    { "name": "Deploy via pipeline", "status": "pending", "skip": false }
  ],
  "risks": [
    { "type": "info", "message": "..." }
  ]
}
```

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

Mark the "Deploy via pipeline" task as `in_progress`. Update HTML checklist step to `status-in-progress`.

Invoke the skill:
```
/power-pages:deploy-pipeline
```

After completion: mark task as `completed`. Update HTML checklist step to `status-completed`.

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
- {solutionName}_{managed|unmanaged}.zip — Solution package {(manual path only)}
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
| Deploy via pipeline | Deploying via pipeline | Invoke deploy-pipeline skill — PP Pipelines path |
| Import to {targetEnv} | Importing solution | Switch PAC CLI context, invoke import-solution — Manual path, one task per target |
| Finalize | Finalizing | Update HTML plan status, commit, run skill tracking, present summary |

---

## Key Decision Points (Wait for User)

1. **Phase 2, Q1**: Solution setup — confirm existing or include `setup-solution` in plan
2. **Phase 2, Q2**: Promotion strategy — PP Pipelines, Manual, or already set up
3. **Phase 2, Q3–Q8**: Stage count, target environments, host env, approval gates, export type, checkpoint pause, Git status
4. **Phase 4**: Plan approval — execute, defer, or revise
5. **Phase 6, Manual**: Checkpoint pause after export (if Q6 = Yes)
6. **Phase 7 (delegated)**: Each invoked skill has its own approval gates

## Error Handling

- No `powerpages.config.json`: stop, advise `/power-pages:create-site`
- `pac env list` fails: skip ENV_LIST pre-filling; ask for environment URLs manually
- `render-alm-plan.js` fails (non-zero exit): report error, show planData JSON as fallback, ask user whether to proceed
- Invoked skill fails: report the failure, mark the task as blocked, ask user whether to retry or exit
- Plan approval = option 3 (change something): re-run Phase 2 fully, then regenerate plan — do not carry over stale answers
