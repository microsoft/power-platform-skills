---
name: git-pull
description: >
  This skill should be used when the user asks to "pull from git",
  "sync from git", "get latest changes", "pull changes from git",
  "update from source control", or wants to pull the latest changes
  from the connected Git repository into their Power Pages environment.
user-invocable: true
allowed-tools: Read, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: sonnet
---

# Pull Changes from Git

Pull the latest changes from the connected Git repository into a Power Pages environment using the Dataverse `RefreshChangesFromGit` and `PullChangesFromGit` OData actions.

## Core Principles

- **Refresh before pulling** — Always check for available updates before pulling to show the user what will change.
- **Surface conflicts early** — Detect and present conflicts before attempting the pull so the user can make informed decisions.
- **Use TaskCreate/TaskUpdate** — Track all progress throughout all phases.

> **Prerequisites:**
>
> - Environment must already be connected to Git via `/git-connect`
> - PAC CLI authenticated and Azure CLI logged in

**Initial request:** $ARGUMENTS

---

## Phase 1: Verify Prerequisites

**Goal**: Ensure the environment is connected to Git

### Actions

#### 1.1 Create Task List

Create all tasks upfront (see [Progress Tracking](#progress-tracking) table).

#### 1.2 Check Authentication

```powershell
pac auth who
```

Extract the **Environment URL**.

#### 1.3 Verify Azure CLI

```powershell
az account show
```

#### 1.4 Check Git Connection

```powershell
node "${CLAUDE_PLUGIN_ROOT}/skills/git-connect/scripts/check-git-connection.js" --envUrl "<ENV_URL>"
```

- **If `connected` is `false`**: Tell the user to run `/git-connect` first. **STOP.**
- **If `connected` is `true`**: Record solution name and branch. Proceed.

**Output**: Environment authenticated and connected to Git

---

## Phase 2: Check for Updates

**Goal**: Refresh from Git and list available changes

### Actions

#### 2.1 Refresh Changes from Git

Execute the refresh to check for new commits in the remote branch:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" "<ENV_URL>" POST "RefreshChangesFromGit" --body '{"SolutionUniqueName":"<solutionUniqueName>"}'
```

> **Note:** This contacts Azure DevOps/GitHub to check for new commits. May take 10-30 seconds.

#### 2.2 Query Available Updates

Wait 3 seconds after refresh, then run:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/skills/git-pull/scripts/check-available-updates.js" --envUrl "<ENV_URL>"
```

#### 2.3 Display Available Changes

If `availableCount` is 0 and `conflictCount` is 0:

> "Your environment is up to date with Git. No changes to pull."

**STOP.** Suggest `/git-commit` to commit local changes.

If `availableCount` > 0, display:

```
| Component | Type | Status |
|-----------|------|--------|
| Contact Form | Web Page | Updated in Git |
| Auth Config | Site Setting | New in Git |
| ... | ... | ... |

**N components** available to pull from branch **<branchName>**
```

**Output**: Available changes listed (or none found)

---

## Phase 3: Check for Conflicts

**Goal**: Detect and resolve conflicts before pulling

### Actions

#### 3.1 Evaluate Conflicts

From the `check-available-updates.js` output, check `conflictCount`.

**If `conflictCount` is 0**: No conflicts. Proceed to Phase 4.

**If `conflictCount` > 0**: Display conflicting components:

```
**Conflicts detected!** These components have been modified in both your environment and Git:

| Component | Type |
|-----------|------|
| Home Page | Web Page |
| ... | ... |
```

Use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| How would you like to resolve these N conflicts? | Conflicts | Accept Git version (overwrite local changes) (Recommended), Keep local version (skip conflicting components), Cancel pull |

- **Accept Git version**: Proceed to Phase 4. The pull will overwrite local changes for conflicting components.
- **Keep local version**: Note which components to skip. Proceed to Phase 4 with remaining components.
- **Cancel pull**: **STOP.**

**Output**: Conflicts resolved (or none found)

---

## Phase 4: Pull Changes

**Goal**: Execute PullChangesFromGit

### Actions

#### 4.1 Confirm Pull

Use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| Ready to pull N changes from Git into your environment? | Pull | Yes, pull changes (Recommended), Cancel |

**If "Cancel"**: **STOP.**

#### 4.2 Execute PullChangesFromGit

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" "<ENV_URL>" POST "PullChangesFromGit" --body '{"SolutionUniqueName":"<solutionUniqueName>"}'
```

> **Note:** This imports components from Git into the environment. May take 1-5 minutes depending on the number of components. Use a Bash timeout of at least 360 seconds.

#### 4.3 Handle Results

| Status / Error | Action |
|---|---|
| **200/204** | Pull succeeded. Proceed to Phase 5. |
| **"Source Control not enabled"** | Managed Environments issue. Suggest enabling and reconnecting. |
| **"Please wait... Solution components are being processed"** | A previous operation is still running. Tell user to wait and retry. |
| **401** | Token expired. `az login` and retry. |
| Other error | Present error and help troubleshoot. |

**Output**: PullChangesFromGit action executed

---

## Phase 5: Verify & Summary

**Goal**: Confirm the pull succeeded and present a summary

### Actions

#### 5.1 Verify Pull

Wait 5 seconds, then re-query:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/skills/git-pull/scripts/check-available-updates.js" --envUrl "<ENV_URL>"
```

If `availableCount` dropped to 0 (or significantly reduced), the pull succeeded.

#### 5.2 Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions. Use `--skillName "GitPull"`.

#### 5.3 Present Summary

```
Changes pulled from Git!

  Components Pulled:  N
  Conflicts Skipped:  M (if any)
  Branch:             <branchName>
  Repository:         <repositoryUrl>
```

#### 5.4 Suggest Next Steps

- `/deploy-site` — Deploy the pulled changes to make them live
- `/git-commit` — Commit any local changes to Git
- Review the pulled changes in the Power Pages maker portal

**Output**: Pull verified, summary presented

---

## Important Notes

### Throughout All Phases

- **Use TaskCreate/TaskUpdate** to track progress at every phase
- **Ask for user confirmation** before pulling (Phase 4.1)
- **Early exit** if not connected or no available changes

### Key Decision Points (Wait for User)

1. Phase 3.1: How to resolve conflicts (if any)
2. Phase 4.1: Confirm before pulling changes

### Progress Tracking

Before starting Phase 1, create a task list with all phases using `TaskCreate`:

| Task subject | activeForm | Description |
|---|---|---|
| Verify prerequisites | Verifying prerequisites | Check PAC CLI, Azure CLI, Git connection |
| Check for updates | Checking for updates | Refresh from Git, list available changes |
| Check for conflicts | Checking conflicts | Detect conflicting components, resolve if needed |
| Pull changes | Pulling changes | Execute PullChangesFromGit action |
| Verify pull | Verifying pull | Confirm changes applied, record usage, suggest next steps |

Mark each task `in_progress` when starting it and `completed` when done via `TaskUpdate`.

---

**Begin with Phase 1: Verify Prerequisites**
