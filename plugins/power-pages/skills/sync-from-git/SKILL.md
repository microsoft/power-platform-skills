---
name: sync-from-git
description: >-
  Pulls incoming Updates from the bound Azure DevOps branch into the Dataverse environment
  via RefreshChangesFromGit + PullChangesFromGit. Detects conflicts before pulling and
  dispatches to resolve-conflicts when needed. Supports the optional hard-delete flag
  (DeleteDeletedComponents) with an explicit destructive-action gate. Writes
  docs/inner-loop/last-sync.json.
  Use when asked: "sync from git", "pull from ADO", "get latest changes", "refresh from branch",
  "pull updates from azure devops", "my environment is stale", "get changes from ADO",
  "sync my env", "run sync-from-git".
user-invocable: true
argument-hint: "Optional: '--hard-delete' to enable DeleteDeletedComponents"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Sync from Git

Pulls incoming Updates from the bound Azure DevOps branch into the Dataverse environment. First calls `RefreshChangesFromGit` (which populates the Updates + Conflicts tabs), then resolves any conflicts (dispatching `/power-pages:resolve-conflicts` if needed), then calls `PullChangesFromGit` with an optional hard-delete flag, and finally verifies the Updates count drops to zero.

## Overview

This skill is the reverse of `commit-to-git` — pull a teammate's work or a CI/CD pipeline output into the dev environment. The two-step `Refresh → Pull` pattern is mandated by the platform: `RefreshChangesFromGit` is a read-only query that populates the maker-portal tabs without mutating state, and `PullChangesFromGit` is the mutation that actually applies the updates. Conflicts are detected between these two steps, so this skill auto-dispatches to `/power-pages:resolve-conflicts` when needed and only then issues the pull.

The `DeleteDeletedComponents: true` flag turns the pull into a destructive operation — it removes env components that were deleted in the branch. The skill gates on it explicitly.

> 🛈 **`DeleteDeletedComponents` = "Delete from environment" UI button (HAR-confirmed 2026-06).** The maker-portal dialog *"Remove or delete items?"* shows two buttons — **Remove from solution** (safe; de-scopes from this solution, items stay in Dataverse) and **Delete from environment** (destructive; physically removes from Dataverse). The `--hard-delete` flag is the API equivalent of the second button. Almost every revert/cleanup scenario should default to NO (`Remove from solution`) — choosing hard-delete on standard OOTB components (CreatedOn / OwnerId / OOTB saved queries / ribbon diffs) is **irrecoverable without re-provision**. Phase 5's hard-delete consent gate is non-negotiable. See [`references/inner-loop-empirical-findings.md`](../../references/inner-loop-empirical-findings.md) §18.

> 🛈 **`RefreshChangesFromGit` is the only API that surfaces conflicts (HAR-confirmed 2026-06).** Maker portal **Refresh** ≠ **Check for updates**: Refresh only re-queries env-side state, while Check for updates triggers `RefreshChangesFromGit` which fetches git tip and recomputes the full Changes / Updates / Conflicts triad. Phase 2 of this skill correctly calls Refresh BEFORE conditionally dispatching to `resolve-conflicts` — keep that order. See `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §22.

> 🛈 **Post-resolve return path may create new pending work (HAR-confirmed 2026-06).** When `resolve-conflicts` returns, items resolved with `Keep-Existing` have moved to pending **Changes** (not Updates) — those still need `commit-to-git` to reach `main`. Items resolved with `Accept-Incoming` are the ones this skill's `PullChangesFromGit` will materialise. Phase 4 must inspect both counts after the sub-skill returns and offer the user a `commit-to-git` follow-up before proceeding with the pull half. See `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §21.

**References:**
- `${CLAUDE_PLUGIN_ROOT}/references/git-integration-api-patterns.md` §6 (`RefreshChangesFromGit` — 204 No Content)
- `${CLAUDE_PLUGIN_ROOT}/references/git-integration-api-patterns.md` §7 (`PullChangesFromGit` — 204 No Content, `DeleteDeletedComponents` flag)
- `${CLAUDE_PLUGIN_ROOT}/references/conflict-resolution-patterns.md`
- `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-flow.md` §3 (Stale / Mixed / Conflicted state classification)
- `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §18 (Remove-from-solution vs Delete-from-environment safety rule)
- `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §21 (Post-resolve Keep-Existing creates pending Changes; commit-to-git still required)
- `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §22 (`RefreshChangesFromGit` is the only API that surfaces conflicts; plain Refresh does not)

## Prerequisites

- PAC CLI installed and authenticated
- Azure CLI installed and logged in
- A Git binding already established (run `/power-pages:setup-git-integration` first if needed)

**Initial request:** $ARGUMENTS

---

## Phase 1 — Binding Check

**Goal:** Confirm the environment is bound to a Git repository — without a binding there is nothing to sync.

**Do NOT create tasks yet.** Use natural-language progress reporting only during this phase.

Steps:

1. Verify PAC CLI auth and acquire an env-scoped token:

   ```bash
   pac env who --json
   az account get-access-token --resource <envUrl> --query expiresOn -o tsv
   ```

2. Check the Git binding state:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/detect-git-binding.js" --envUrl "<envUrl>"
   ```

   If `bound === false`:

   <!-- gate: sync-from-git:1.no-binding | category=intent | cancel-leaves=nothing -->
   > 🚦 **Gate (intent · sync-from-git:1.no-binding):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | No Git binding found for this environment. Set one up first? | Not bound to Git | Run /power-pages:setup-git-integration, Cancel |

**Output:** Confirmed binding to org/project/repo/branch.

---

## Phase 2 — Refresh Changes from Git

**Goal:** Query the bound branch and populate the Updates + Conflicts tabs without mutating env state.

Tasks to create (`TaskCreate`):

1. Refresh changes from ADO
2. Check for conflicts
3. Render sync plan
4. Final consent + execute `PullChangesFromGit`
5. Poll until updates clear
6. Verify + write `last-sync.json` marker
7. Final gate

Steps:

1. Call `RefreshChangesFromGit`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/refresh-changes-from-git.js" --envUrl "<envUrl>"
   ```

   Returns 204 No Content. Wait ~3 seconds for the platform to populate the tabs.

2. Query the resulting state:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-incoming-updates.js" --envUrl "<envUrl>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-conflicts.js"        --envUrl "<envUrl>"
   ```

**Output:** Updates count + Conflicts count populated.

---

## Phase 3 — Conflict Check

**Goal:** Decide whether to dispatch to `resolve-conflicts`, short-circuit (no updates), or continue to pull.

Steps:

1. If `conflicts.count > 0`:

   <!-- gate: sync-from-git:3.conflicts-detected | category=plan | cancel-leaves=nothing -->
   > 🚦 **Gate (plan · sync-from-git:3.conflicts-detected):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | `RefreshChangesFromGit` found N conflict(s). Conflicts must be resolved before pulling. | Conflicts detected | Run /power-pages:resolve-conflicts now (Recommended), Cancel — I'll resolve manually |

   - **resolve-conflicts** → dispatch `/power-pages:resolve-conflicts`. After it returns, re-run `list-conflicts.js` to confirm count = 0, then continue to Phase 4.
   - **Cancel** → exit cleanly; the user can re-run `sync-from-git` later.

2. If `conflicts.count === 0` and `updates.count === 0`: nothing to pull. Write `last-sync.json` with `status: "already-up-to-date"` and exit cleanly.

**Output:** Conflicts cleared (or skill terminates if already up-to-date / user cancelled).

---

## Phase 4 — Render Sync Plan

**Goal:** Show the user exactly what will be pulled and get plan-approval before any mutation.

Steps:

1. Display the incoming updates in a friendly format:

   ```
   Sync plan
     Environment:  <envUrl>
     Branch:       <branch>
     Incoming:     N update(s)
       • <objectType>: <name> (<changeType>)
       • …
     Conflicts:    0 ✓
     Hard-delete:  <enabled | disabled>
   ```

2. <!-- gate: sync-from-git:4.plan | category=plan | cancel-leaves=nothing -->
   > 🚦 **Gate (plan · sync-from-git:4.plan):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Will pull N update(s) from `{branch}` into `{envHost}`. Continue? | Sync plan | Yes — proceed (Recommended), Cancel |

**Output:** User has approved the sync scope.

---

## Phase 5 — Consent Gate(s) + Execute

**Goal:** Collect final consent (with destructive-action sub-gate when applicable) and call `PullChangesFromGit`.

### 5a — Hard-delete consent (conditional)

Steps:

1. Check whether any incoming updates are deletions (changeType = delete / remove). If yes **and** the user passed `--hard-delete` (or argument `hard-delete`):

   <!-- gate: sync-from-git:5.hard-delete | category=consent | cancel-leaves=nothing -->
   > 🚦 **Gate (consent · sync-from-git:5.hard-delete):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | N deletion(s) detected in incoming updates. `DeleteDeletedComponents: true` will PERMANENTLY delete those components from the env. This cannot be undone without a re-import. Confirm? | Destructive action — hard delete | Yes, permanently delete them, No — pull without hard-delete |

### 5b — Final pull consent

Steps:

1. <!-- gate: sync-from-git:5.consent | category=consent | cancel-leaves=nothing -->
   > 🚦 **Gate (consent · sync-from-git:5.consent):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Final consent — call `PullChangesFromGit` on `{envHost}` now? | Final consent | Pull now, Cancel |

2. On **Pull now**:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/pull-changes-from-git.js" \
       --envUrl "<envUrl>" \
       [--deleteDeletedComponents]
   ```

   Pass `--deleteDeletedComponents` only when the user confirmed in Step 5a.

   Returns 204 No Content. A `PullChangesFromGit` operation can take 30 sec – 3 min for large change sets — display a progress message.

**Output:** `PullChangesFromGit` accepted; mutation is in-flight.

---

## Phase 6 — Poll Until Updates Clear

**Goal:** Wait for Dataverse to finish applying the updates and clear the Updates tab.

Steps:

1. Poll `list-incoming-updates.js` with a 5-second interval, up to 36 attempts (~3 minutes), until `count === 0`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-incoming-updates.js" --envUrl "<envUrl>"
   ```

   Show a live counter: `Waiting for Updates to apply… attempt N/36 (count: X remaining)`.

2. Timeout is non-fatal — the pull may still be running on the platform side.

**Output:** Updates count is 0 (or timeout noted).

---

## Phase 7 — Verify + Write Marker

**Goal:** Final verification + persist the machine-readable marker.

Steps:

1. Run `list-incoming-updates.js` once more and confirm `count === 0`. If not zero, surface a warning (not a blocker).

2. Write `docs/inner-loop/last-sync.json`:

   ```json
   {
     "skill":             "sync-from-git",
     "syncedAt":          "<ISO>",
     "envUrl":            "<envUrl>",
     "branch":            "<branch>",
     "organization":      "<org>",
     "project":           "<proj>",
     "repository":        "<repo>",
     "updatesApplied":    N,
     "hardDeleteEnabled": false,
     "conflictsFound":    0,
     "status":            "succeeded" | "already-up-to-date"
   }
   ```

   The path is registered in `scripts/lib/inner-loop-paths.js` under the key `lastSync`.

**Output:** Verification complete; `docs/inner-loop/last-sync.json` written.

---

## Phase 8 — Final Gate + Skill Tracking

**Goal:** Route the user to the appropriate next action and record skill usage.

Steps:

1. <!-- gate: sync-from-git:8.final | category=final | cancel-leaves=nothing -->
   > 🚦 **Gate (final · sync-from-git:8.final):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Sync complete — N update(s) applied from `{branch}`. What next? | Done | Run /power-pages:validate-pending-changes (check my env before next commit), Run /power-pages:commit-to-git (I have pending changes too), Exit |

### Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "SyncFromGit"`.

**Output:** User routed to next action.

---

## Artifacts Written

| File | Location | Purpose |
|---|---|---|
| `last-sync.json` | `docs/inner-loop/` | Skill-run marker; validated by `validate-sync-from-git.js`. |

---

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| Refresh changes from ADO | Refreshing from ADO | Call `refresh-changes-from-git.js` to populate Updates + Conflicts tabs |
| Check for conflicts | Checking for conflicts | Run `list-conflicts.js`; dispatch `/power-pages:resolve-conflicts` if count > 0 |
| Render sync plan | Rendering sync plan | Build plan summary and gate on user approval |
| Final consent + execute `PullChangesFromGit` | Pulling from ADO | Surface consent gate(s); call `pull-changes-from-git.js` with optional hard-delete |
| Poll until updates clear | Polling updates | Poll `list-incoming-updates.js` every 5s until count = 0 (≤ 3 min) |
| Verify + write `last-sync.json` marker | Writing sync marker | Persist `docs/inner-loop/last-sync.json` with status + counts |
| Final gate | Finalising sync | Offer follow-up actions (`validate-pending-changes` / `commit-to-git` / exit) |

---

## Key Decision Points (Wait for User)

1. **Phase 1**: If no Git binding exists → run `setup-git-integration` or cancel (gate `sync-from-git:1.no-binding`).
2. **Phase 3**: If conflicts detected → dispatch `resolve-conflicts` or cancel (gate `sync-from-git:3.conflicts-detected`).
3. **Phase 4**: Approve the sync plan (gate `sync-from-git:4.plan`).
4. **Phase 5a** (conditional): Confirm `DeleteDeletedComponents: true` is destructive (gate `sync-from-git:5.hard-delete`).
5. **Phase 5b**: Final consent before `PullChangesFromGit` (gate `sync-from-git:5.consent`).
6. **Phase 8**: Choose next action — validate, commit, or exit (gate `sync-from-git:8.final`).

---

## Error Handling

- **`RefreshChangesFromGit` returns 4xx**: ADO branch unreachable (PAT expired, branch deleted, repo deleted). Surface the platform error verbatim and exit.
- **`RefreshChangesFromGit` returns 204 but `list-incoming-updates.js` returns `count: 0` even though a teammate just pushed** (pattern IL-016): the `gitupdatefiles` entity is not exposed on this tenant. Fall back to `sourcecontrolbranchconfigurations.upstreambranchsyncedcommitid` vs the ADO branch tip — if the SHAs differ, treat as "incoming updates exist" and proceed. See `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-error-catalog.md` Pattern IL-016.
- **`PullChangesFromGit` returns 400 with `0x80072033 — The Entity powerpagecomponent is missing primary key powerpagecomponentid`** (pattern IL-014): this env has `powerpagecomponent` mis-published as a custom entity. The pull cannot proceed via API — dispatch `/power-pages:diagnose-git-integration` and tell the user a Microsoft Support ticket is required. Commits and conflict-resolution still work; only the pull half is blocked.
- **`PullChangesFromGit` returns 409 / 400 with conflict text**: state drifted between Phase 3 and Phase 5 (another user committed). Re-run from Phase 2.
- **`CommitToGit` returned 400 in a previous step but the commit may have landed** (pattern IL-017): if the user reports the previous commit run as failed but ADO shows a matching new commit, treat that as a false-failure and update the manifest before proceeding. See `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-error-catalog.md` Pattern IL-017.
- **Pull timeout (Phase 6) but tabs still show updates**: non-fatal — instruct the user to check the maker-portal Connect-to-Git panel and re-run if needed.
- **Hard-delete chosen but Phase 6 reports remaining updates**: the platform may have rejected one or more deletions due to dependency holds. Surface the residual list; suggest the user reconcile manually.

---

**Begin with Phase 1: Binding Check**
