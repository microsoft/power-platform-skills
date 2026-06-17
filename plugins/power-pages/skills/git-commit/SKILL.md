---
name: git-commit
description: >
  This skill should be used when the user asks to "commit to git",
  "push changes to git", "save to source control", "commit site changes",
  "sync to git", or wants to commit their Power Pages environment changes
  to the connected Git repository.
user-invocable: true
argument-hint: Optional commit message
allowed-tools: Read, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: opus
hooks:
  Stop:
    - hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/git-commit/scripts/validate-git-commit.js"'
          timeout: 30
        - type: prompt
          prompt: |
            Check whether the git-commit skill completed successfully. Return { "ok": true } if ALL of the following are true, otherwise { "ok": false, "reason": "..." }:
            1. The environment was verified as connected to Git
            2. Pending changes were queried and displayed to the user
            3. A commit message was determined (auto-generated or user-provided)
            4. The CommitToGit action was executed successfully
            5. Post-commit verification showed no remaining pending changes (or reduced count)
            6. A completion summary was presented with commit message, component count, and branch
          timeout: 30
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Commit Power Pages Changes to Git

Commit pending changes from a Power Pages environment to the connected Git repository. The action wraps `pac pages git commit`; OData is used only for the helper script that lists pending components.

> Refer to `${CLAUDE_PLUGIN_ROOT}/references/git-api-patterns.md` for OData fallback patterns and `${CLAUDE_PLUGIN_ROOT}/skills/git-commit/references/error-catalog.md` for error remediation.

## Core Principles

- **Drive PAC CLI for the action** — `pac pages git commit` is the contract. Skill never POSTs `CommitToGit` directly.
- **Check before committing** — Always verify the Git connection exists and show pending changes before committing.
- **Smart commit messages** — Auto-generate a descriptive commit message from the pending components, but let the user customize it.
- **Use TaskCreate/TaskUpdate** — Track all progress throughout all phases.

> **Prerequisites:**
>
> - Environment must already be connected to Git via `/git-connect`.
> - PAC CLI built with the `verbPAPortalGit` feature flag enabled (skill probes this in Phase 1).
> - PAC CLI authenticated and Azure CLI logged in.

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

> "No ALM plan exists for this project. `/power-pages:plan-alm` builds one — it detects the project state, asks about your promotion strategy (PP Pipelines vs Manual export/import), and orchestrates the right skills (including git-commit) in the right order. Want me to run plan-alm now?"

<!-- gate: git-commit:0.no-plan | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · git-commit:0.no-plan):** Fail-closed entry gate when `check-alm-plan.js` returns `exists:false`. Helper-script-backed.

`AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Run `/power-pages:plan-alm` first? | ALM plan gate | Yes — run /power-pages:plan-alm now (Recommended), Continue without a plan (advanced — I know what I'm doing), Cancel |

- **Yes (Recommended)** → invoke `/power-pages:plan-alm`. plan-alm's Phase 7 dispatches back into this skill at the appropriate stage.
- **Continue without a plan** → set `BYPASSED_PLAN_GATE = true` and proceed to Phase 1.
- **Cancel** → exit cleanly.

**Step 4 — Stale plan.** Tell the user:

> "ALM plan exists from `{generatedAt}` but the source solution has been modified since. Components may have changed. Re-running `plan-alm` will refresh the analysis and the rendered HTML."

<!-- gate: git-commit:0.stale-plan | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · git-commit:0.stale-plan):** Fail-closed entry gate when `check-alm-plan.js` returns `stale:true`. Helper-script-backed.

`AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Refresh the plan first? | ALM plan freshness | Refresh — re-run /power-pages:plan-alm (Recommended), Continue with the existing plan, Cancel |

- **Refresh (Recommended)** → invoke `/power-pages:plan-alm`. After completion, proceed to Phase 1.
- **Continue** → set `STALE_PLAN_ACK = true` and proceed to Phase 1.
- **Cancel** → exit cleanly.

**Why this gate exists.** Each commit pushes a snapshot to the connected upstream branch. If the planned solution split changed after the last commit (e.g., a component was moved to a different solution), committing without refreshing the plan can push components to the wrong branch, leak unintended components, or commit a half-baked split. The gate ensures the next commit reflects the current plan's intent.

---

## Phase 1: Verify Prerequisites

**Goal**: Ensure the environment is connected to Git and ready to commit

### Actions

#### 1.1 Create Task List

Create all tasks upfront (see [Progress Tracking](#progress-tracking) table).

#### 1.2 Probe the `pac pages git` sub-noun

```powershell
pac pages git --help
```

The sub-noun is gated behind the `verbPAPortalGit` feature flag in PAC CLI. If the help command exits non-zero or reports `Unknown command`, surface this and **STOP**:

> "This skill needs PAC CLI built with the `verbPAPortalGit` feature flag (the `pac pages git` sub-noun). Update PAC CLI to a version that ships the sub-noun, or use a build with the flag enabled, then rerun `/git-commit`."

#### 1.3 Check Authentication

```powershell
pac auth who
```

Extract the **Environment URL**. If not authenticated, follow the standard auth flow.

#### 1.4 Verify Azure CLI

```powershell
az account show
```

If not logged in, instruct: `az login`.

#### 1.5 Check Git Connection

```powershell
node "${CLAUDE_PLUGIN_ROOT}/skills/git-connect/scripts/check-git-connection.js" --envUrl "<ENV_URL>"
```

- **If `connected` is `false`**: Tell the user: "This environment is not connected to Git. Run `/git-connect` first to set up source control." **STOP.**
- **If `connected` is `true`**: Record `solutionUniqueName` (the value to pass as `--solutionName` to PAC CLI in Phase 4) and `branchName` from the helper's JSON output. Proceed.

**Output**: Environment authenticated and connected to Git

---

## Phase 2: Check Pending Changes

**Goal**: Query and display uncommitted changes

### Actions

#### 2.1 Query Pending Changes

```powershell
node "${CLAUDE_PLUGIN_ROOT}/skills/git-commit/scripts/check-pending-changes.js" --envUrl "<ENV_URL>"
```

#### 2.2 Display Changes

Parse the JSON output. If `pendingCount` is 0:

> "Everything is up to date with Git. No pending changes to commit."

**STOP.** Suggest `/git-pull` to check for incoming changes.

If `pendingCount` > 0, display:

```
| Component | Type | Action |
|-----------|------|--------|
| Home Page | Web Page | Modified |
| Auth Settings | Site Setting | Added |
| ... | ... | ... |

**N components** ready to commit to branch **<branchName>**
```

**Output**: Pending changes listed (or none found)

---

## Phase 3: Get Commit Message

**Goal**: Determine the commit message — from argument, auto-generated, or user-provided

### Actions

#### 3.1 Determine Commit Message

**If `$ARGUMENTS` contains text** (and it looks like a commit message, not a command): Use it directly as the commit message. Skip to Phase 4.

**Otherwise**, auto-generate a suggested message based on the pending components. Examples:

- "Update Home Page, add Contact Form settings"
- "Modify site authentication configuration"
- "Add web roles and table permissions"

Present via `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| Commit message for these N changes? | Message | `<auto-generated suggestion>` (Recommended), Write my own message |

**If "Write my own message"**: The user provides their message via "Other" free text.

**Output**: Commit message determined

---

## Phase 4: Commit to Git

**Goal**: Execute the CommitToGit OData action

### Actions

#### 4.1 Execute the commit via PAC CLI

```powershell
pac pages git commit `
  --solutionName "<solutionUniqueName>" `
  --message "<commitMessage>" `
  --environment "<ENV_URL>"
```

> **Argument reference** (from PAC CLI `PAPortalGitCommitVerb.cs`):
> - `--solutionName` (string, required) — Solution to commit.
> - `--message` (string, required) — Commit message.
> - `--environment` (string, optional) — Target env URL when not using the default profile.
> - PAC CLI internally calls the `CommitToGit` Dataverse action. Allow up to 60 seconds — use a Bash timeout of at least 120 seconds.

#### 4.2 Handle Results

| Stdout / Stderr (case-insensitive substring match) | Action |
|---|---|
| Exit 0 with `committed` (typically phrased as `Successfully committed` or `Changes committed`) | Commit succeeded. Proceed to Phase 5. |
| Exit 0 with `No pending` (PAC CLI's wording for "nothing to commit") | The CLI detected no pending changes. Skip Phase 5 verification and tell the user nothing was committed. |
| `Source Control not enabled` | Managed Environments may not be enabled, or the connection was lost. Suggest `/git-connect`. |
| `items requested do not exist` | Components are still being processed from a previous sync. Tell user to wait a few minutes and retry. |
| `Solution components are being processed` | Initial sync still in progress. Tell user to wait and retry. |
| `0x80040216` or `SourceControlComponent` empty / null reference | The known empty-components NRE: tracking thinks there are zero pending Push rows. Run the helper script again to confirm `pendingCount=0`; suggest the user make a small change and retry. See `error-catalog.md`. |
| HTTP 401 underneath | Token expired. Run `az login` and retry. |
| Other error | Look up the error in `${CLAUDE_PLUGIN_ROOT}/skills/git-commit/references/error-catalog.md`. |

**Output**: CommitToGit action executed

---

## Phase 5: Verify & Summary

**Goal**: Confirm the commit succeeded and present a summary

### Actions

#### 5.1 Verify Commit

Wait 5 seconds, then verify with both PAC CLI and the helper script:

```powershell
pac pages git status --environment "<ENV_URL>"
node "${CLAUDE_PLUGIN_ROOT}/skills/git-commit/scripts/check-pending-changes.js" --envUrl "<ENV_URL>"
```

`pac pages git status` should NOT print a `pending change(s) to commit` line (the verb omits the line when count is 0). Helper script `pendingCount` should be 0 (or significantly reduced).

If pending changes remain, warn the user that some components may not have been committed (possibly still processing).

#### 5.2 Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions. Use `--skillName "GitCommit"`.

#### 5.3 Present Summary

```
Changes committed to Git!

  Commit Message:  <commitMessage>
  Components:      N committed
  Branch:          <branchName>
  Repository:      <repositoryUrl>
```

#### 5.4 Suggest Next Steps

- `/git-pull` — Pull others' changes from Git
- `/export-solution` — Export solution for environment promotion
- Check the commit in your Git repository to verify the files

**Output**: Commit verified, summary presented

---

## Important Notes

### Throughout All Phases

- **Use TaskCreate/TaskUpdate** to track progress at every phase
- **Ask for user confirmation** at key decision points
- **Early exit** if not connected or no pending changes — don't proceed unnecessarily

### Key Decision Points (Wait for User)

1. Phase 3.1: Accept auto-generated commit message or write their own

### Limitations (UI parity)

The following Power Pages Studio "Source control" tab actions are NOT covered by this skill today:

- **Cherry-pick / selective commit** — `pac pages git commit` always commits all pending Push rows; you cannot stage a subset.
- **Amend last commit** — no amend verb. To "fix" a wrong commit message, push another commit on top.
- **View commit history** — no `pac pages git log` verb. Use ADO/GitHub web UI for repo-side history.

### Progress Tracking

Before starting Phase 1, create a task list with all phases using `TaskCreate`:

| Task subject | activeForm | Description |
|---|---|---|
| Verify prerequisites | Verifying prerequisites | Check PAC CLI, sub-noun feature flag, Azure CLI, Git connection |
| Check pending changes | Checking changes | Query sourcecontrolcomponents for uncommitted changes |
| Get commit message | Getting commit message | Auto-generate or get from user |
| Commit to Git | Committing changes | Run `pac pages git commit` |
| Verify commit | Verifying commit | Run `pac pages git status`, record usage, suggest next steps |

Mark each task `in_progress` when starting it and `completed` when done via `TaskUpdate`.

---

**Begin with Phase 1: Verify Prerequisites**
