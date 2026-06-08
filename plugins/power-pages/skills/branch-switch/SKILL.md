---
name: branch-switch
description: >-
  Re-binds the Dataverse environment to a different Azure DevOps branch.
  Wraps DisconnectFromGit + ConnectToGit because the platform allows only
  one branch at a time. Hard-stops when the workspace is dirty (Changes /
  Updates / Conflicts > 0) to prevent silent data loss across branches.
  Writes docs/inner-loop/last-branch-switch.json (records both old & new
  branch for audit).
  Use when asked: "switch branch", "change git branch", "rebind to a different branch",
  "move my env to another branch", "switch to feature branch", "change which
  branch my env is bound to", "run branch-switch".
user-invocable: true
argument-hint: "Optional: target branch name to skip the prompt"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Branch Switch

Re-binds the Dataverse environment to a different Azure DevOps branch by calling `DisconnectFromGit` followed by `ConnectToGit` against the new branch. The platform only allows one bound branch at a time, so there is no atomic "change branch" action — this skill wraps the two-step disconnect/reconnect with a workspace-clean hard stop in front of it.

## Overview

Switching branches with a dirty workspace would silently drop the pending Changes / unresolved Updates / unresolved Conflicts — the disconnect side of the operation discards in-flight state for the old branch, and the new branch has no record of it. This skill HARD-STOPS on a dirty workspace and routes the user to `commit-to-git` / `sync-from-git` / `revert-workspace` first.

Org / project / repo / folder are inherited from the existing binding — only the branch name changes. Internally the skill uses the `switch-branch.js` helper which performs the disconnect + reconnect atomically (in helper-script terms) and returns the new binding fields.

> 🛈 **Maker-portal parity (HAR-confirmed 2026-06).** The Power Pages / Power Apps Git-connection side panel has **no branch dropdown** — even in the UI the operation is **Disconnect → Connect-to-Git → re-enter every field**. There is no "edit binding" affordance. This skill is the API-side equivalent of that two-step UI workflow, plus the workspace-clean precondition the UI does NOT enforce. See [`references/inner-loop-empirical-findings.md`](../../references/inner-loop-empirical-findings.md) §14.

> 🛈 **Recovery from "deleted source branch" red banner (HAR-confirmed 2026-06).** When the bound branch is deleted (e.g. ADO PR completion with auto-delete-source-branch ticked), the maker portal Source control page surfaces a red banner: *"The connected organization, project, repository, or branch does not exist or you do not have access to it."* This skill is the recovery path — re-point the binding at the merge target (typically `main`). The workspace-clean precondition does NOT apply here because the source branch is gone (there is nothing to lose); Phase 2 should short-circuit the dirty-workspace hard stop when `detect-git-binding.js` reports an orphaned binding (binding fields present but ADO branch lookup 404s). See [`references/inner-loop-empirical-findings.md`](../../references/inner-loop-empirical-findings.md) §15.

**References:**
- `${CLAUDE_PLUGIN_ROOT}/references/git-integration-api-patterns.md` §1-§3 (`ConnectToGit`) + §4 (`DisconnectFromGit`)
- `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-flow.md` §3 (state classification — Dirty / Stale / Conflicted are all unsafe for switch)
- `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §14 (maker-portal has no branch dropdown) + §15 (deleted-branch recovery)

## Prerequisites

- PAC CLI installed and authenticated
- Azure CLI installed and logged in
- A Git binding already established (run `/power-pages:setup-git-integration` first if needed)
- Workspace must be Clean (0 Changes, 0 Updates, 0 Conflicts) — Phase 2 enforces this
- The target ADO branch must exist (Phase 3 validates this)

**Initial request:** $ARGUMENTS

---

## Phase 1 — Binding Check

**Goal:** Confirm the environment is currently bound to a Git repository — switching is only meaningful from an existing bind.

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

   <!-- gate: branch-switch:1.no-binding | category=intent | cancel-leaves=nothing -->
   > 🚦 **Gate (intent · branch-switch:1.no-binding):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | No Git binding found for this environment. Set one up first? | Not bound to Git | Run /power-pages:setup-git-integration, Cancel |

3. Record the current binding fields — `organization`, `project`, `repository`, `branch` (this is the `oldBranch`), `gitFolder`, `bindingType` — they're inherited unchanged by the switch.

**Output:** Confirmed binding; `oldBranch` + inherited fields captured.

---

## Phase 2 — Workspace-Clean Hard Gate

**Goal:** HARD-STOP when the workspace is not Clean. A dirty workspace switch would silently drop in-flight state across branches.

Tasks to create (`TaskCreate`):

1. Verify workspace is clean
2. Gather target branch
3. Render switch plan
4. Final consent before switch
5. Execute disconnect + reconnect
6. Verify binding now points to target branch
7. Update `.git-integration-manifest.json` + write marker
8. Final gate + suggest sync-from-git

Steps:

1. Enumerate the three lists in parallel:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-pending-changes.js"   --envUrl "<envUrl>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-incoming-updates.js"  --envUrl "<envUrl>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-conflicts.js"         --envUrl "<envUrl>"
   ```

2. If any of the three counts is > 0, the workspace is dirty:

   <!-- gate: branch-switch:2.workspace-dirty | category=intent | cancel-leaves=nothing -->
   > 🚦 **Gate (intent · branch-switch:2.workspace-dirty):** **HARD STOP.** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Branch switch requires a CLEAN workspace, but found Changes={C}, Updates={U}, Conflicts={X}. Switching now would silently drop this in-flight state. Resolve first: | Workspace not clean | Run /power-pages:commit-to-git (push my Changes), Run /power-pages:sync-from-git (pull incoming Updates), Run /power-pages:revert-workspace (discard my Changes), Run /power-pages:resolve-conflicts (resolve Conflicts first), Cancel |

   Do NOT proceed past Phase 2 unless all three counts are 0.

**Output:** Workspace confirmed Clean.

---

## Phase 3 — Gather Target Branch

**Goal:** Collect the new branch name and confirm it exists in ADO.

Steps:

1. If the user passed a branch as an argument, pre-populate it. Otherwise prompt:

   `branch-switch:3.target-branch` (not-a-gate — data-gathering): ask for the target branch name. Strip any leading `refs/heads/`.

2. Validate the target is different from `oldBranch`. If identical, exit cleanly with a friendly message.

3. Confirm the branch exists in the bound ADO repository. Re-use `verify-repo-initialized.js`-style discovery against the new branch, or list `refs/heads/*` via the ADO REST API. If the branch does not exist, surface the gap and offer to:
   - Create it (push an empty / initial commit), OR
   - Choose a different existing branch, OR
   - Cancel.

**Output:** A validated `newBranch` that exists in ADO and differs from `oldBranch`.

---

## Phase 4 — Render the Switch Plan

**Goal:** Show the user exactly what will happen and get plan-approval before consent.

Steps:

1. Compose and display:

   ```
   Branch switch plan
     Environment: <envUrl>
     Binding:     <org>/<proj>/<repo>  folder <folder>  (bindingType: <env|solution>)
     From:        branch <oldBranch>
     To:          branch <newBranch>
     Workspace:   Clean ✓ (0 Changes, 0 Updates, 0 Conflicts)
     Reverses?    Yes — run /power-pages:branch-switch again with the original branch name.
   ```

2. <!-- gate: branch-switch:4.plan | category=plan | cancel-leaves=nothing -->
   > 🚦 **Gate (plan · branch-switch:4.plan):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Will disconnect from `{oldBranch}` and reconnect to `{newBranch}`. Continue? | Branch switch plan | Yes — proceed to consent (Recommended), Change the target branch, Cancel |

**Output:** Switch plan approved.

---

## Phase 5 — Final Consent + Execute

**Goal:** Final consent before any Dataverse mutation, then perform the disconnect + reconnect via `switch-branch.js`.

Steps:

1. <!-- gate: branch-switch:5.consent | category=consent | cancel-leaves=nothing -->
   > 🚦 **Gate (consent · branch-switch:5.consent):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Final consent — disconnect from `{oldBranch}` and reconnect to `{newBranch}` on `{envHost}` now? | Final consent | Switch now, Cancel |

2. On **Switch now**:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/switch-branch.js" \
       --envUrl    "<envUrl>" \
       --newBranch "<newBranch>"
   ```

   The helper inherits `organization` / `project` / `repository` / `gitFolder` from the existing binding — no need to pass them. It performs `DisconnectFromGit` followed by `ConnectToGit` against `<newBranch>`.

3. Error handling:
   - `error` after disconnect succeeds but reconnect fails → the env is now **Disconnected**. Surface this clearly and instruct the user to run `/power-pages:setup-git-integration` (or re-run this skill with the original branch) to restore a binding.
   - `error` on disconnect itself → no state change; safe to retry or cancel.

**Output:** `switch-branch.js` returned success; env is now bound to `<newBranch>`.

---

## Phase 6 — Verify Binding Points to Target Branch

**Goal:** Re-query Dataverse to confirm the new bind landed and capture canonical field values.

Steps:

1. ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/detect-git-binding.js" --envUrl "<envUrl>"
   ```

   Expected: `bound === true`, `branch === <newBranch>` (or the canonical `refs/heads/<newBranch>`), all other fields unchanged.

2. If `branch` does NOT match the target, the reconnect step did not take effect. Surface the discrepancy and instruct the user to run `/power-pages:diagnose-git-integration`.

**Output:** Round-trip verified; canonical `branch` value captured.

---

## Phase 7 — Update Manifest + Write Marker

**Goal:** Update the load-bearing manifest with the new branch + record an audit marker capturing both old and new branch.

Steps:

1. Update `.git-integration-manifest.json` (project root):
   - Set `branch` to the canonical new branch value from Phase 6.
   - Update `lastVerifiedAt` to the current ISO timestamp.
   - Leave `lastCommitSha` unchanged (a switch does not produce a new commit).

2. Write `docs/inner-loop/last-branch-switch.json`:

   ```json
   {
     "skill":        "branch-switch",
     "switchedAt":   "<ISO>",
     "envUrl":       "<envUrl>",
     "organization": "<org>",
     "project":      "<proj>",
     "repository":   "<repo>",
     "oldBranch":    "<oldBranch>",
     "newBranch":    "<newBranch>",
     "bindingType":  "environment|solution",
     "status":       "succeeded"
   }
   ```

   The path is registered in `scripts/lib/inner-loop-paths.js` under the key `lastBranchSwitch`.

**Output:** Manifest updated; `docs/inner-loop/last-branch-switch.json` written.

---

## Phase 8 — Final Gate + Suggest Sync-from-Git

**Goal:** Route the user to `sync-from-git` so the env picks up the new branch's content.

Steps:

1. <!-- gate: branch-switch:9.final | category=final | cancel-leaves=nothing -->
   > 🚦 **Gate (final · branch-switch:9.final):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Switched from `{oldBranch}` to `{newBranch}`. Pull the new branch's content into the env now? | Branch switch complete | Run /power-pages:sync-from-git now (Recommended — env is currently the OLD branch's content), Skip — I'll do it later, Exit |

### Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "BranchSwitch"`.

**Output:** User routed to `sync-from-git` or exit.

---

## Artifacts Written

| File | Location | Purpose |
|---|---|---|
| `last-branch-switch.json` | `docs/inner-loop/` | Audit marker (records both `oldBranch` and `newBranch`); validated by `validate-branch-switch.js`. |
| `.git-integration-manifest.json` | project root | `branch` + `lastVerifiedAt` fields updated. |

---

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| Verify workspace is clean | Verifying workspace clean | Run the three `list-*` helpers; HARD-STOP if any count > 0 |
| Gather target branch | Gathering target branch | Collect new branch name; strip `refs/heads/`; confirm it exists in ADO |
| Render switch plan | Rendering switch plan | Build plan summary (old → new branch on same org/project/repo/folder) and gate on user approval |
| Final consent before switch | Awaiting switch consent | Surface explicit consent gate before any Dataverse mutation |
| Execute disconnect + reconnect | Executing branch switch | Call `switch-branch.js` (DisconnectFromGit + ConnectToGit against new branch) |
| Verify binding now points to target branch | Verifying binding | Re-query `detect-git-binding.js`; confirm `branch === <newBranch>` |
| Update `.git-integration-manifest.json` + write marker | Writing branch-switch marker | Update manifest `branch` field; persist `docs/inner-loop/last-branch-switch.json` |
| Final gate + suggest sync-from-git | Finalising branch switch | Route the user to `sync-from-git` (env content is still the OLD branch) |

---

## Key Decision Points (Wait for User)

1. **Phase 1**: If no Git binding exists → run `setup-git-integration` or cancel (gate `branch-switch:1.no-binding`).
2. **Phase 2**: Workspace dirty → HARD STOP; route to `commit-to-git` / `sync-from-git` / `revert-workspace` / `resolve-conflicts` / cancel (gate `branch-switch:2.workspace-dirty`).
3. **Phase 3**: Target branch name (data-gathering, not a gate). Branch-existence check is conversational; create / pick-different / cancel.
4. **Phase 4**: Approve the switch plan (gate `branch-switch:4.plan`).
5. **Phase 5**: Final consent before `DisconnectFromGit` + `ConnectToGit` (gate `branch-switch:5.consent`).
6. **Phase 8**: Run `sync-from-git` now, skip, or exit (gate `branch-switch:9.final`).

---

## Error Handling

- **Workspace dirty** (Changes / Updates / Conflicts > 0): hard stop — no `DisconnectFromGit` is attempted; the workspace is left untouched.
- **Target branch does not exist in ADO**: offer to create it, pick a different existing branch, or cancel. Do NOT auto-create — branch creation is opinionated (initial commit content).
- **`DisconnectFromGit` succeeds but `ConnectToGit` fails**: the env is now Disconnected. This is a recoverable Broken state — surface it clearly with the original binding fields so the user can run `/power-pages:setup-git-integration` (or re-run this skill with the original branch) to restore.
- **`DisconnectFromGit` itself fails** (4xx / 5xx): no state change; safe to retry or cancel.
- **Phase 6 reports `branch !== <newBranch>`**: surface the discrepancy and route to `/power-pages:diagnose-git-integration`; do NOT update the manifest.
- **Manifest update fails after a successful switch**: surface the error AND the canonical new binding fields so the user can update the manifest manually.

---

**Begin with Phase 1: Binding Check**
