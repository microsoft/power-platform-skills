---
name: git-pull
description: >
  This skill should be used when the user asks to "pull from git",
  "sync from git", "get latest changes", "pull changes from git",
  "update from source control", or wants to pull the latest changes
  from the connected Git repository into their Power Pages environment.
user-invocable: true
allowed-tools: Read, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: opus
hooks:
  Stop:
    - hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/git-pull/scripts/validate-git-pull.js"'
          timeout: 30
        - type: prompt
          prompt: |
            Check whether the git-pull skill completed successfully. Return { "ok": true } if ALL of the following are true, otherwise { "ok": false, "reason": "..." }:
            1. The environment was verified as connected to Git
            2. RefreshChangesFromGit was executed to check for updates
            3. Available changes were queried and displayed to the user
            4. Conflicts were checked and resolved (if any)
            5. The PullChangesFromGit action was executed successfully
            6. Post-pull verification showed no remaining available updates (or reduced count)
            7. A completion summary was presented with component count, branch, and status
          timeout: 30
---

# Pull Changes from Git

Pull the latest changes from the connected Git repository into a Power Pages environment. The action wraps `pac pages git pull`, which internally drives `RefreshChangesFromGit` then `PullChangesFromGit` against Dataverse. OData is used only for the helper that lists available components and conflicts.

> Refer to `${CLAUDE_PLUGIN_ROOT}/references/git-api-patterns.md` for OData fallback patterns and `${CLAUDE_PLUGIN_ROOT}/skills/git-pull/references/error-catalog.md` for error remediation.

## Core Principles

- **Drive PAC CLI for the action** — `pac pages git pull` (and `--autoResolve` when needed) is the contract.
- **Refresh before pulling** — Always check for available updates before pulling to show the user what will change.
- **Surface conflicts early** — Detect and present conflicts before attempting the pull so the user can make informed decisions.
- **Use TaskCreate/TaskUpdate** — Track all progress throughout all phases.

> **Prerequisites:**
>
> - Environment must already be connected to Git via `/git-connect`.
> - PAC CLI built with the `verbPAPortalGit` feature flag enabled (skill probes this in Phase 1).
> - PAC CLI authenticated and Azure CLI logged in.

**Initial request:** $ARGUMENTS

---

## Phase 1: Verify Prerequisites

**Goal**: Ensure the environment is connected to Git

### Actions

#### 1.1 Create Task List

Create all tasks upfront (see [Progress Tracking](#progress-tracking) table).

#### 1.2 Probe the `pac pages git` sub-noun

```powershell
pac pages git --help
```

If the help command exits non-zero or reports `Unknown command`, surface this and **STOP**:

> "This skill needs PAC CLI built with the `verbPAPortalGit` feature flag (the `pac pages git` sub-noun). Update PAC CLI to a version that ships the sub-noun, or use a build with the flag enabled, then rerun `/git-pull`."

#### 1.3 Check Authentication

```powershell
pac auth who
```

Extract the **Environment URL**.

#### 1.4 Verify Azure CLI

```powershell
az account show
```

#### 1.5 Check Git Connection

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

#### 2.1 Refresh status via PAC CLI

`pac pages git status` triggers a refresh against the remote (PAC CLI internally calls `RefreshChangesFromGit`) and prints the resulting state.

```powershell
pac pages git status --environment "<ENV_URL>"
```

> **Note:** This contacts Azure DevOps/GitHub to check for new commits. May take 10–30 seconds.

#### 2.2 Query Available Updates (structured)

Then run the helper script for the per-component breakdown the user table needs:

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

#### 4.2 Execute the pull via PAC CLI

If the user accepted "Accept Git version" in Phase 3 (or there are no conflicts), include `--autoResolve` so PAC CLI bypasses the conflict early-return guard. If the user picked "Keep local version", omit `--autoResolve` so PAC aborts cleanly when conflicts exist (the user can rerun later).

```powershell
pac pages git pull `
  --solutionName "<solutionUniqueName>" `
  --autoResolve `
  --environment "<ENV_URL>"
```

> **Argument reference** (from PAC CLI `PAPortalGitPullVerb.cs`):
> - `--solutionName` (string, required) — Solution to pull into.
> - `--autoResolve` (switch) — Bypasses the CLI conflict guard and calls `PullChangesFromGit` even when conflicts exist. Server still drives the merge.
> - `--environment` (string, optional) — Target env URL.
> - PAC CLI internally drives `RefreshChangesFromGit` then `PullChangesFromGit`. Allow 1–5 minutes; use a Bash timeout of at least 360 seconds.

#### 4.3 Handle Results

| Stdout / Stderr (case-insensitive substring match) | Action |
|---|---|
| Exit 0 with `pulled` (typically phrased as `Successfully pulled` or `Changes pulled`) | Pull succeeded. Proceed to Phase 5. |
| Exit 0 with WARNING containing `conflict` (without `--autoResolve`) | PAC CLI aborted because conflicts exist. Re-run Phase 3 with the user; either accept Git version (re-run with `--autoResolve`) or have them manually resolve in Studio first. |
| `Source Control not enabled` | Managed Environments issue. Suggest enabling and reconnecting. |
| `Solution components are being processed` | A previous operation is still running. Tell user to wait and retry. |
| `SourceControlProcessingInProgress` | An async git op is already running for this solution. Wait and retry. |
| HTTP 401 underneath | Token expired. `az login` and retry. |
| Other error | Look up the error in `${CLAUDE_PLUGIN_ROOT}/skills/git-pull/references/error-catalog.md`. |

**Output**: PullChangesFromGit action executed

---

## Phase 5: Verify & Summary

**Goal**: Confirm the pull succeeded and present a summary

### Actions

#### 5.1 Verify Pull

Wait 5 seconds, then verify with both PAC CLI and the helper script:

```powershell
pac pages git status --environment "<ENV_URL>"
node "${CLAUDE_PLUGIN_ROOT}/skills/git-pull/scripts/check-available-updates.js" --envUrl "<ENV_URL>"
```

`pac pages git status` should NOT print an `available update(s) to pull` line (the verb omits the line when count is 0). Helper script `availableCount` should be 0 (or significantly reduced).

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

### Limitations (UI parity)

The following Power Pages Studio "Source control" tab actions are NOT covered by this skill today:

- **Per-component conflict resolution** — `pac pages git pull --autoResolve` accepts incoming for ALL conflicting components; you cannot pick "accept incoming for component X, keep local for Y" via the CLI. Use the Studio UI's Conflicts tab if you need that granularity.
- **Pulling a specific commit hash** — only the latest of the connected branch is pulled.
- **Branch switching at pull time** — the branch is fixed at `/git-connect` time.

### Progress Tracking

Before starting Phase 1, create a task list with all phases using `TaskCreate`:

| Task subject | activeForm | Description |
|---|---|---|
| Verify prerequisites | Verifying prerequisites | Check PAC CLI, sub-noun feature flag, Azure CLI, Git connection |
| Check for updates | Checking for updates | Run `pac pages git status` (refreshes), list available changes |
| Check for conflicts | Checking conflicts | Detect conflicting components, resolve if needed |
| Pull changes | Pulling changes | Run `pac pages git pull` (with `--autoResolve` if user accepted incoming) |
| Verify pull | Verifying pull | Run `pac pages git status`, record usage, suggest next steps |

Mark each task `in_progress` when starting it and `completed` when done via `TaskUpdate`.

---

**Begin with Phase 1: Verify Prerequisites**
