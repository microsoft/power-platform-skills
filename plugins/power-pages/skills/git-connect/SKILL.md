---
name: git-connect
description: >
  This skill should be used when the user asks to "connect to git",
  "set up source control", "connect environment to git",
  "set up git integration", "link to Azure DevOps", "enable source control",
  or wants to connect their Power Pages environment to a Git repository
  for source control and ALM.
user-invocable: true
argument-hint: Optional solution name or repo URL
allowed-tools: Read, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: opus
hooks:
  Stop:
    - hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/git-connect/scripts/validate-git-connect.js"'
          timeout: 30
        - type: prompt
          prompt: |
            Check whether the git-connect skill completed successfully. Return { "ok": true } if ALL of the following are true, otherwise { "ok": false, "reason": "..." }:
            1. Prerequisites were verified (PAC CLI, Azure CLI, Managed Environment)
            2. A solution was selected for git connection
            3. A repository, branch, and folder were selected via OData virtual entities
            4. The ConnectToGit action was executed successfully
            5. The connection was verified via sourcecontrolconfigurations query
            6. A completion summary was presented with repo, branch, and status
          timeout: 30
---

# Connect Power Pages Environment to Git

Guide the user through connecting a Power Pages solution to a Git repository (Azure DevOps or GitHub) for source control. The action wraps `pac pages git connect`; OData virtual entities are used only for browsing organizations, projects, repositories, and branches in the picker.

> Refer to `${CLAUDE_PLUGIN_ROOT}/references/git-api-patterns.md` for OData fallback patterns and `${CLAUDE_PLUGIN_ROOT}/skills/git-connect/references/error-catalog.md` for error remediation.

## Core Principles

- **Drive PAC CLI for the action** — `pac pages git connect|status|disconnect` are the contract. Skill never POSTs `ConnectToGit` / `DisconnectFromGit` directly.
- **OData only for the picker** — Browsing `gitorganizations` / `gitprojects` / `gitrepositories` / `gitbranches` is the one path PAC doesn't expose, so it stays OData.
- **Cloud-aware URL resolution** — Never hardcode API base URLs. Derive from the Cloud value returned by `pac auth who`.
- **Confirm before mutating** — Always present the full connection parameters and get explicit approval before executing the connect.
- **Use TaskCreate/TaskUpdate** — Track all progress throughout all phases.

> **Prerequisites:**
>
> - PAC CLI installed, authenticated to the target environment, and built with the `verbPAPortalGit` feature flag enabled (the skill probes this in Phase 1).
> - Azure CLI logged in (`az login`).
> - Managed Environments enabled on the target environment (required for Git integration).
> - **An existing Power Platform solution that contains your Power Pages site as a component.** `pac pages git connect` binds a *solution* (not a site directly) to a git branch, so the site components must already live in a solution. If they don't, run `/setup-solution` first — that skill creates the publisher + solution and adds the website (and its language / site-component children) as `solutioncomponents`. Any other path that gets the site into a solution (Maker portal UI, `pac solution add-solution-component`, importing a solution from another env) works equally well.

**Initial request:** $ARGUMENTS

---

## Phase 0 — ALM plan gate

> **`plan-alm` is the front door.** When the user expresses an ALM intent (*promote / ship / deploy / set up CI-CD / move to staging / push to prod*), the orchestrator (`/power-pages:plan-alm`) should run first. This Phase 0 enforces that and is meant to fail closed when there's no plan, not to be a one-time check the user can dismiss forever.

**Skip rule.** If this skill was invoked *as part of an active `plan-alm` orchestration*, skip Phase 0 entirely and proceed to Phase 1. The gate helper exposes this via its `inExecution` block — pass through silently to Phase 1 when:

```
inExecution.status === "active"
```

When `inExecution.status` is anything other than `"active"` (`"not-running"`, `"stale-heartbeat"`, `"no-plan"`), run the Phase 0 gate flow below. Branch on the remaining helper fields:

**Step 1 — Run the gate helper.**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/check-alm-plan.js" --projectRoot "."
```

The helper returns JSON with `{ exists, deferred, stale, staleness: { reason, detail }, generatedAt, planStatus, ... }`.

**Step 2 — Branch on the result.**

| Result | Behavior |
|---|---|
| `deferred: true` | The user has explicitly deferred ALM for this project (`.alm-deferred` marker present). Pass through silently to Phase 1 — do not nag. |
| `exists: false` | The user hasn't run `plan-alm` yet. See Step 3. |
| `exists: true, stale: false` | Plan is current. Pass through silently to Phase 1. |
| `exists: true, stale: true` | Plan exists but is stale. See Step 4. |

**Step 3 — No plan.** Tell the user:

> "No ALM plan exists for this project. `/power-pages:plan-alm` builds one — it detects the project state, asks about your promotion strategy (PP Pipelines vs Manual export/import), and orchestrates the right skills (including git-connect) in the right order. Want me to run plan-alm now?"

<!-- gate: git-connect:0.no-plan | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · git-connect:0.no-plan):** Fail-closed entry gate when `check-alm-plan.js` returns `exists:false`. Helper-script-backed.

`AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Run `/power-pages:plan-alm` first? | ALM plan gate | Yes — run /power-pages:plan-alm now (Recommended), Continue without a plan (advanced — I know what I'm doing), Cancel |

- **Yes (Recommended)** → invoke `/power-pages:plan-alm`. plan-alm's Phase 7 dispatches back into this skill at the appropriate stage.
- **Continue without a plan** → set `BYPASSED_PLAN_GATE = true` and proceed to Phase 1.
- **Cancel** → exit cleanly.

**Step 4 — Stale plan.** Tell the user:

> "ALM plan exists from `{generatedAt}` but the source solution has been modified since. Components may have changed. Re-running `plan-alm` will refresh the analysis and the rendered HTML."

<!-- gate: git-connect:0.stale-plan | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · git-connect:0.stale-plan):** Fail-closed entry gate when `check-alm-plan.js` returns `stale:true`. Helper-script-backed.

`AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Refresh the plan first? | ALM plan freshness | Refresh — re-run /power-pages:plan-alm (Recommended), Continue with the existing plan, Cancel |

- **Refresh (Recommended)** → invoke `/power-pages:plan-alm`. After completion, proceed to Phase 1.
- **Continue** → set `STALE_PLAN_ACK = true` and proceed to Phase 1.
- **Cancel** → exit cleanly.

**Why this gate exists.** Connecting a solution to a Git branch/folder is a permanent binding — once made, the solution's components are constrained to that branch's tracked path. If `plan-alm` would have recommended a multi-solution split, connecting first and splitting later requires `pac pages git disconnect` + reconnect for every component move. The gate ensures the planned solution shape is final before the binding is made, while still leaving an explicit bypass for users who genuinely want a standalone connect.

---

## Phase 1: Verify Prerequisites

**Goal**: Ensure PAC CLI, Azure CLI, and Managed Environments are ready

### Actions

#### 1.1 Create Task List

Create all tasks upfront (see [Progress Tracking](#progress-tracking) table).

#### 1.2 Verify PAC CLI

```powershell
pac help
```

If not installed, instruct: `dotnet tool install --global Microsoft.PowerApps.CLI.Tool`

#### 1.3 Probe the `pac pages git` sub-noun

```powershell
pac pages git --help
```

The sub-noun is gated behind the `verbPAPortalGit` feature flag in PAC CLI. If `pac pages git --help` exits non-zero or reports `Unknown command`, surface this message and **STOP**:

> "This skill needs PAC CLI built with the `verbPAPortalGit` feature flag (the `pac pages git` sub-noun). Update PAC CLI to a version that ships the sub-noun, or use a build with the flag enabled, then rerun `/git-connect`."

When the probe succeeds you should see the five verbs: `connect`, `commit`, `pull`, `status`, `disconnect`.

#### 1.4 Check Authentication

```powershell
pac auth who
```

Extract: **Environment URL**, **Environment ID**, **Cloud** value.

If not authenticated, ask for the environment URL and run `pac auth create --environment "<URL>"`.

#### 1.5 Verify Azure CLI

```powershell
az account show
```

If not logged in, instruct the user to run `az login`.

#### 1.6 Check Existing Connection

Run the connection status script (which queries OData for richer fields than `pac pages git status` exposes):

```powershell
node "${CLAUDE_PLUGIN_ROOT}/skills/git-connect/scripts/check-git-connection.js" --envUrl "<ENV_URL>"
```

Cross-check with PAC CLI for human readability:

```powershell
pac pages git status --environment "<ENV_URL>"
```

Evaluate the JSON result from the helper:

- **If `connected` is `true`**: Show existing connection details (repo, branch, last sync). Use `AskUserQuestion`:

  | Question | Header | Options |
  |----------|--------|---------|
  | Your environment is already connected to Git: **`<repositoryUrl>`** (branch: `<branchName>`). What would you like to do? | Connection | Keep current connection — stop here, Disconnect and reconnect to a different repo |

  - **Keep**: Stop the skill. Suggest `/git-commit` or `/git-pull`.
  - **Disconnect**: Execute disconnect via PAC CLI. Use `solutionUniqueName` from the helper's JSON output (NOT the `solutionId` GUID — `--solutionName` expects the unique-name string):
    ```powershell
    pac pages git disconnect --solutionName "<solutionUniqueName>" --environment "<ENV_URL>"
    ```
    Expect stdout `Disconnected`. Then proceed to Phase 2.

- **If `connected` is `false`**: Proceed to Phase 2.

**Output**: Prerequisites verified, no existing connection (or disconnected)

---

## Phase 2: Select Solution

**Goal**: Identify which Power Platform solution to connect to Git

### Actions

#### 2.1 List Solutions

```powershell
pac solution list
```

Parse the output to extract solution names, unique names, and versions.

#### 2.2 Select Solution

If `$ARGUMENTS` contains a solution name, try to match it from the list.

Otherwise, use `AskUserQuestion` to present the available solutions (up to 4). Recommend any solution that already contains Power Pages site components.

| Question | Header | Options |
|----------|--------|---------|
| Which solution should be connected to Git? | Solution | `<Solution 1>` (Recommended), `<Solution 2>`, `<Solution 3>` |

Record the selected solution's **unique name** for the ConnectToGit call.

#### 2.3 Verify the selected solution contains the site

`pac pages git connect` binds the **solution** to a branch — if the chosen solution doesn't contain the user's Power Pages site components, the connect succeeds but every subsequent `commit` / `pull` is a no-op and silently misleads the user. Guard against this before mutating anything.

Query `solutioncomponents` for any Power Pages component in the selected solution. `componenttype` codes for the `powerpagesite` root vary by environment (commonly `10427`, `10428`, or `10435`), so accept any of them:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" "<ENV_URL>" GET \
  "solutioncomponents?$filter=_solutionid_value eq '<selectedSolutionId>' and (componenttype eq 10427 or componenttype eq 10428 or componenttype eq 10435)&$top=1"
```

If the result is empty, **STOP** and surface this gate before the connect:

<!-- gate: git-connect:2.solution-missing-site | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · git-connect:2.solution-missing-site):** The selected solution doesn't contain any Power Pages site components, so connecting it to Git would produce an empty source-control binding.

`AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| The selected solution doesn't contain any Power Pages site components. What now? | Missing site | Run `/setup-solution` to add the site (Recommended), Pick a different solution, Continue anyway (advanced — I know what I'm doing), Cancel |

- **Run `/setup-solution`** → invoke `/power-pages:setup-solution` to add the site to a solution; on completion, restart Phase 2 with the updated solution list.
- **Pick a different solution** → return to step 2.2.
- **Continue anyway** → set `EMPTY_SOLUTION_ACK = true` and proceed; record this in the completion summary so the user understands the binding is intentionally empty.
- **Cancel** → exit cleanly.

If the user picked the solution via `$ARGUMENTS` (non-interactive) and the check fails, prefer **Cancel** with a clear error message rather than silently proceeding — the user can re-run with a correct solution name.

**Output**: Selected solution unique name (verified to contain Power Pages site components)

---

## Phase 3: Select Repository

**Goal**: Browse Azure DevOps (or GitHub) organizations, projects, repos, and branches via OData virtual entities

### Actions

All OData queries use the shared `dataverse-request.js` script:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" "<ENV_URL>" GET "<apiPath>"
```

#### 3.1 List Organizations

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" "<ENV_URL>" GET "gitorganizations"
```

Parse the JSON response to extract organization names and IDs. Present via `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| Which Git organization? | Organization | `<Org 1>`, `<Org 2>`, `<Org 3>` |

#### 3.2 List Projects

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" "<ENV_URL>" GET "gitprojects?$filter=organizationname eq '<selectedOrgName>'"
```

Present via `AskUserQuestion`.

#### 3.3 List Repositories

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" "<ENV_URL>" GET "gitrepositories?$filter=organizationname eq '<selectedOrgName>' and projectname eq '<selectedProjectName>'"
```

Present via `AskUserQuestion`.

#### 3.4 List or Create Branch

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" "<ENV_URL>" GET "gitbranches?$filter=organizationname eq '<selectedOrgName>' and projectname eq '<selectedProjectName>' and repositoryname eq '<selectedRepoName>'"
```

Present via `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| Which branch? | Branch | `main` (Recommended), `<other branches...>`, Create a new branch |

**If "Create a new branch"**: Ask for the branch name and pick the upstream (typically `main`), then create it. The `gitbranches` virtual entity resolves the repo from the org/project/repo tuple — there's no `gitrepositoryid` navigation property:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" "<ENV_URL>" POST "gitbranches" --body '{"branchname":"<branch-name>","organizationname":"<selectedOrgName>","projectname":"<selectedProjectName>","repositoryname":"<selectedRepoName>","upstreambranchname":"<upstreamBranch>"}'
```

Returns `204 No Content` on success. Verify by re-running the 3.4 GET — the new branch should appear in the list.

#### 3.5 Set Folder Path

The folder path is **required and cannot be `/`** — the server rejects `/` with `The folder name '/' is invalid. Please enter a new name.` PAC CLI also defaults `--folder` to `/` when omitted, so the skill must always pass an explicit value.

Use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| What folder path in the repo should the solution sync to? | Folder | `<solutionUniqueName>` (Recommended), Custom path |

Default to the solution unique name (e.g. `WoodgroveBankSite`) unless the user specifies otherwise. Reject `/` and any value starting with `/` — re-prompt for a valid folder name.

**Output**: Organization, project, repository, branch, and folder path selected

---

## Phase 4: Confirm & Connect

**Goal**: Present the full connection summary and execute ConnectToGit

### Actions

#### 4.1 Confirm Parameters

Present all parameters to the user via `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| Ready to connect to Git with these settings:\n\n- **Solution**: `<solutionName>`\n- **Organization**: `<orgName>`\n- **Project**: `<projectName>`\n- **Repository**: `<repoName>`\n- **Branch**: `<branchName>`\n- **Folder**: `<folderPath>`\n\nProceed? | Connect | Yes, connect to Git (Recommended), Cancel |

**If "Cancel"**: Stop the skill.

#### 4.2 Execute the connect via PAC CLI

```powershell
pac pages git connect `
  --solutionName "<solutionUniqueName>" `
  --organization "<orgName>" `
  --project "<projectName>" `
  --repository "<repoName>" `
  --branch "<branchName>" `
  --folder "<folderPath>" `
  --gitProvider 0 `
  --environment "<ENV_URL>"
```

> **Argument reference** (from PAC CLI `PAPortalGitConnectVerb.cs`):
> - `--solutionName` (string, required) — Power Platform solution unique name to bind.
> - `--organization` (string, required) — ADO org or GitHub org (e.g. "dynamicscrm" or "microsoft").
> - `--project` (string, required) — ADO project (use the same name as `--repository` for GitHub).
> - `--repository` (string, required) — Repo name.
> - `--branch` (string, required) — Branch name (e.g. "main").
> - `--folder` (string, required in practice) — Folder path inside the repo where the solution syncs. PAC's verb defaults to `/` if omitted, but the server rejects `/` with `The folder name '/' is invalid`. The skill always passes an explicit folder (default: the solution unique name) per Phase 3.5.
> - `--gitProvider 0|1` — 0 = Azure DevOps (default), 1 = GitHub.
> - `--environment` (string, optional) — Target env URL when not using the default profile.
> - PAC CLI internally calls the `ConnectToGit` Dataverse action and waits for the initial sync; this can take up to 2 minutes. Use a Bash timeout of at least 180 seconds.

#### 4.3 Handle Results

| Stdout / Exit code | Action |
|---|---|
| Exit 0 with stdout containing the org name and branch (typical phrasing: `Connected to {org}/{project}/{repo}@{branch}`) | Connection initiated. Proceed to Phase 5. Note: the LocString-formatted text may vary across PAC CLI builds; match case-insensitively on `connected` plus the org/repo/branch values you supplied. |
| Stderr contains `Managed Environments not enabled` | Tell user to enable Managed Environments in Power Platform Admin Center, then retry. |
| Stderr contains `CommitInvalidAdoLocation` | The folder path is invalid or the ADO repo location is misconfigured. Walk the user through fixing `--folder`. |
| HTTP 401 underneath | Token expired. Ask user to run `az login` and retry. |
| HTTP 403 underneath | Insufficient permissions. User needs System Administrator role. |
| Other error | Look up the error in `${CLAUDE_PLUGIN_ROOT}/skills/git-connect/references/error-catalog.md`. |

**Output**: ConnectToGit action executed

---

## Phase 5: Verify & Summary

**Goal**: Confirm the connection is established and present next steps

### Actions

#### 5.1 Verify Connection

Wait 5 seconds, then verify with both PAC CLI (human-readable) and the helper script (structured):

```powershell
pac pages git status --environment "<ENV_URL>"
node "${CLAUDE_PLUGIN_ROOT}/skills/git-connect/scripts/check-git-connection.js" --envUrl "<ENV_URL>"
```

Expect `pac pages git status` stdout to contain `Connected to Git source control. Repository: <url>, Branch: <branch>` (case-insensitive match on "connected" + the repo URL is the safest assertion). The helper script JSON should have `"connected": true`.

> **Note:** The initial sync may still be in progress. Solution components are being processed — this can take several minutes. The connection itself is established even if sync hasn't completed.

#### 5.2 Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions. Use `--skillName "GitConnect"`.

#### 5.3 Present Summary

```
Git connection established!

  Solution:    <solutionName>
  Repository:  <orgName>/<projectName>/<repoName>
  Branch:      <branchName>
  Folder:      <folderPath>
  Status:      Connected (initial sync in progress)
```

#### 5.4 Suggest Next Steps

- `/git-commit` — Commit environment changes to Git
- `/git-pull` — Pull latest changes from Git into the environment
- Check the Source Control panel in the Power Pages maker portal to monitor sync progress

**Output**: Connection verified, summary presented, next steps suggested

---

## Important Notes

### Throughout All Phases

- **Use TaskCreate/TaskUpdate** to track progress at every phase
- **Ask for user confirmation** at key decision points (see list below)
- **Present errors clearly** — when a command fails, show the error and explain what went wrong

### Key Decision Points (Wait for User)

1. Phase 1.6: If already connected — keep or disconnect
2. Phase 2.2: Select which solution to connect
3. Phase 2.3: If the chosen solution has no Power Pages site components — run `/setup-solution`, pick a different solution, continue anyway, or cancel
4. Phase 3.1–3.5: Select organization, project, repo, branch, folder (sequential)
5. Phase 4.1: Confirm all connection parameters before executing

### Prerequisites Reminder

- **Managed Environments** must be enabled on the target environment. If `pac pages git connect` fails with a Managed Environments error, direct the user to: Power Platform Admin Center → Environments → Select environment → Enable Managed Environments.
- The environment must have at least one unmanaged solution **containing the Power Pages site components**. If only empty solutions exist, run `/setup-solution` first.

### Limitations (UI parity)

The following Power Pages Studio "Source control" tab actions are NOT covered by this skill or the PAC CLI sub-noun today; users who need them should use the Studio UI:

- **Branch switching** on a connected solution (the picker only chooses the branch at connect time).
- **Commit history view** — no `pac pages git log` verb yet.
- **Individual file diffs** — no per-file diff verb.
- **Cherry-pick / selective commit** — `pac pages git commit` always commits all pending Push rows; you cannot stage a subset.

To **disconnect** an environment from Git, run `pac pages git disconnect --solutionName "<name>" --environment "<url>"` directly. There is no `/git-disconnect` skill in this PR; that is intentionally scoped to a follow-up.

### Progress Tracking

Before starting Phase 1, create a task list with all phases using `TaskCreate`:

| Task subject | activeForm | Description |
|---|---|---|
| Verify prerequisites | Verifying prerequisites | Check PAC CLI, sub-noun feature flag, auth, Azure CLI, existing connection |
| Select solution | Selecting solution | List solutions, user picks which to connect |
| Select repository | Selecting repository | Browse orgs/projects/repos/branches via OData |
| Confirm and connect | Connecting to Git | Present summary, run `pac pages git connect` |
| Verify connection | Verifying connection | Run `pac pages git status`, record usage, suggest next steps |

Mark each task `in_progress` when starting it and `completed` when done via `TaskUpdate`.

---

**Begin with Phase 1: Verify Prerequisites**
