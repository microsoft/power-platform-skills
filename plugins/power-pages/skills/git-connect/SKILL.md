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

Guide the user through connecting a Power Pages solution to a Git repository (Azure DevOps or GitHub) for source control. Uses the Dataverse Native Git integration OData actions.

> Refer to `${CLAUDE_PLUGIN_ROOT}/references/git-api-patterns.md` for all OData API patterns used in this skill.

## Core Principles

- **Cloud-aware URL resolution** — Never hardcode API base URLs. Derive from the Cloud value returned by `pac auth who`.
- **Confirm before mutating** — Always present the full connection parameters and get explicit approval before executing ConnectToGit.
- **Use TaskCreate/TaskUpdate** — Track all progress throughout all phases.

> **Prerequisites:**
>
> - PAC CLI installed and authenticated to the target environment
> - Azure CLI logged in (`az login`)
> - Managed Environments enabled on the target environment (required for Git integration)
> - At least one Power Platform solution in the environment

**Initial request:** $ARGUMENTS

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

#### 1.3 Check Authentication

```powershell
pac auth who
```

Extract: **Environment URL**, **Environment ID**, **Cloud** value.

If not authenticated, ask for the environment URL and run `pac auth create --environment "<URL>"`.

#### 1.4 Verify Azure CLI

```powershell
az account show
```

If not logged in, instruct the user to run `az login`.

#### 1.5 Check Existing Connection

Run the connection status script:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/skills/git-connect/scripts/check-git-connection.js" --envUrl "<ENV_URL>"
```

Evaluate the JSON result:

- **If `connected` is `true`**: Show existing connection details (repo, branch, last sync). Use `AskUserQuestion`:

  | Question | Header | Options |
  |----------|--------|---------|
  | Your environment is already connected to Git: **`<repositoryUrl>`** (branch: `<branchName>`). What would you like to do? | Connection | Keep current connection — stop here, Disconnect and reconnect to a different repo |

  - **Keep**: Stop the skill. Suggest `/git-commit` or `/git-pull`.
  - **Disconnect**: Execute disconnect via `dataverse-request.js`:
    ```powershell
    node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" "<ENV_URL>" POST "DisconnectFromGit" --body '{"SolutionUniqueName":"<name>"}'
    ```
    Then proceed to Phase 2.

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

Otherwise, use `AskUserQuestion` to present the available solutions (up to 4). If a Power Pages website solution is identifiable (contains website components), recommend it.

| Question | Header | Options |
|----------|--------|---------|
| Which solution should be connected to Git? | Solution | `<Solution 1>` (Recommended), `<Solution 2>`, `<Solution 3>` |

Record the selected solution's **unique name** for the ConnectToGit call.

**Output**: Selected solution unique name

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

**If "Create a new branch"**: Ask for the branch name, then create it:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" "<ENV_URL>" POST "gitbranches" --body '{"name":"<branch-name>","gitrepositoryid":"<repoId>"}'
```

#### 3.5 Set Folder Path

Use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| What folder path in the repo should the solution sync to? | Folder | Root (`/`) (Recommended), Custom path |

Default to `/` unless the user specifies otherwise.

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

#### 4.2 Execute ConnectToGit

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" "<ENV_URL>" POST "ConnectToGit" --body '{"SolutionUniqueName":"<uniqueName>","Organization":"<orgName>","Project":"<projectName>","Repository":"<repoName>","Branch":"<branchName>","GitFolder":"<folderPath>","GitProvider":0,"ConnectionType":0}'
```

> **Parameter reference** (from OData metadata):
> - `Organization` (string) — ADO org name (e.g., "dynamicscrm")
> - `Project` (string) — ADO project name (e.g., "OneCRM")
> - `Repository` (string) — Repo name (e.g., "CDS")
> - `Branch` (string, required) — Branch name (e.g., "main")
> - `GitFolder` (string, required) — Folder path in repo (e.g., "/")
> - `SolutionUniqueName` (string) — Solution to connect
> - `GitProvider` (int) — 0 = Azure DevOps, 1 = GitHub
> - `ConnectionType` (int) — 0 = standard

> **Note:** This may take up to 2 minutes. The initial sync starts automatically after connection. Use a Bash timeout of at least 180 seconds.

#### 4.3 Handle Results

| Status | Action |
|--------|--------|
| **200/204** | Connection initiated. Proceed to Phase 5. |
| **400 — "Managed Environments not enabled"** | Tell user to enable Managed Environments in Power Platform Admin Center, then retry. |
| **400 — "failed to complete"** | May need Managed Environments. Suggest enabling and retrying. |
| **401** | Token expired. Ask user to run `az login` and retry. |
| **403** | Insufficient permissions. User needs System Administrator role. |
| Other error | Present error and help troubleshoot. |

**Output**: ConnectToGit action executed

---

## Phase 5: Verify & Summary

**Goal**: Confirm the connection is established and present next steps

### Actions

#### 5.1 Verify Connection

Wait 5 seconds, then re-run the connection check:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/skills/git-connect/scripts/check-git-connection.js" --envUrl "<ENV_URL>"
```

Confirm `connected` is `true`.

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

1. Phase 1.5: If already connected — keep or disconnect
2. Phase 2.2: Select which solution to connect
3. Phase 3.1–3.5: Select organization, project, repo, branch, folder (sequential)
4. Phase 4.1: Confirm all connection parameters before executing

### Prerequisites Reminder

- **Managed Environments** must be enabled on the target environment. If ConnectToGit fails with a Managed Environments error, direct the user to: Power Platform Admin Center → Environments → Select environment → Enable Managed Environments.
- The environment must have at least one unmanaged solution.

### Progress Tracking

Before starting Phase 1, create a task list with all phases using `TaskCreate`:

| Task subject | activeForm | Description |
|---|---|---|
| Verify prerequisites | Verifying prerequisites | Check PAC CLI, auth, Azure CLI, existing connection |
| Select solution | Selecting solution | List solutions, user picks which to connect |
| Select repository | Selecting repository | Browse orgs/projects/repos/branches via OData |
| Confirm and connect | Connecting to Git | Present summary, execute ConnectToGit action |
| Verify connection | Verifying connection | Check status, record usage, suggest next steps |

Mark each task `in_progress` when starting it and `completed` when done via `TaskUpdate`.

---

**Begin with Phase 1: Verify Prerequisites**
