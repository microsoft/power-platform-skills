---
name: revert-branch
description: >-
  Rolls the bound Azure DevOps branch back to a previous commit SHA. This is
  a DESTRUCTIVE, BRANCH-WIDE operation: every other environment bound to this
  branch will be affected, and any work committed after the target SHA is lost
  unless those commits were also pushed to a different branch. Uses a
  TYPED-CONFIRMATION gate (user must type "REVERT BRANCH {sha}") after seeing
  the impact analysis.
  Writes docs/inner-loop/last-branch-revert.json (records old HEAD, target SHA,
  affected envs).
  Use when asked: "revert the branch", "roll back the branch", "reset branch to
  previous commit", "roll back to commit X", "undo bad commit on the branch",
  "git reset --hard the branch in ADO", "branch HEAD is wrong, fix it",
  "run revert-branch".
user-invocable: true
argument-hint: "Optional: target commit SHA to skip the picker"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Revert Branch

Rolls the bound Azure DevOps branch back to a previous commit SHA by force-updating the branch ref in ADO. This is the inner-loop equivalent of `git reset --hard <sha> && git push --force` — destructive and **branch-wide**.

## Overview

Unlike `/power-pages:revert-workspace` (which only affects the local Dataverse env), this skill affects every other environment bound to the same branch. The next time a teammate's env runs `git-sync --pull`, they will pull the older HEAD; if they had local Changes built on top of the now-lost commits, the platform will surface those as Conflicts on the next refresh.

The skill enumerates recent commits, has the user pick a target SHA, shows an impact analysis ("Will affect N other envs bound to this branch"), and then demands a typed-confirmation phrase that includes the target SHA to prevent accidental rollback to the wrong commit.

> 🛈 **Safer alternative — ADO PR-revert (HAR-confirmed 2026-06).** Where this skill performs a destructive force-update (history-rewriting), ADO's *Commits → ⋯ → Revert* creates a **new commit that undoes the bad one** via an auto-generated PR, leaving history intact. One observed run: reverting an in-flight commit produced a revert PR on a `<sha>-revert-from-main` branch, which merged cleanly into `main` as a new commit on top. Recommend that path when (a) the branch is shared with teammates whose envs are bound to it, or (b) the bad commit is older than a few commits back. Use THIS skill only when history-rewrite is genuinely needed (e.g. accidentally committed secrets). Downstream `git-sync --pull` runs will face the [§18 Remove-vs-Delete dialog](../../references/inner-loop-empirical-findings.md#18--pullchangesfromgit-deletion-prompts-pick-remove-from-solution-not-delete-from-environment-for-systemstandard-components-2026-06) — recommend the SOFT path (no `--hard-delete`) for the first reconciliation pull.

**References:**
- `${CLAUDE_PLUGIN_ROOT}/references/git-integration-api-patterns.md` §11 (ADO branch-ref force-update payload + concurrency check)
- `${CLAUDE_PLUGIN_ROOT}/references/conflict-resolution-patterns.md` (downstream teammates may see Conflicts after this skill runs)
- `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §18 (downstream pull deletion-prompt safety)

## Prerequisites

- PAC CLI installed and authenticated
- Azure CLI installed and logged in
- A Git binding already established (run `/power-pages:git-configure` first if needed)
- An ADO PAT with `Code (read & write)` on the target repo (the force-update needs write scope)
- The target commit SHA must exist in the bound branch's history

**Initial request:** $ARGUMENTS

**User-facing voice:** speak plainly. See `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-user-language.md` for the authoring rules — no raw API names, raw JSON, or GUIDs in user chat (except on failure); show progress as sequential `Phase {N} — {plainTitle}` (internal phase numbers stay internal).

---

## Phase 1 — Binding Check

**Goal:** Confirm the env is bound — without a binding there is no branch to revert.

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

   **Manifest reconcile (B3).** Compare the local `.git-integration-manifest.json` against this server truth using `reconcileManifest({ manifest, serverBinding })` from `${CLAUDE_PLUGIN_ROOT}/scripts/lib/reconcile-manifest.js`; see `${CLAUDE_PLUGIN_ROOT}/references/manifest-contract.md` for the full contract.
   <!-- gate: revert-branch:1.manifest-stale | category=intent | cancel-leaves=nothing -->
   > 🚦 **Gate (intent · revert-branch:1.manifest-stale):** When `aligned:false`, surface the divergence and let the user choose from the helper's returned `options` (`overwrite-from-server`, `rebind-old-coords`, `clear-local`) before proceeding; cancellation leaves the manifest untouched.

   If `bound === false`:

   <!-- gate: revert-branch:1.no-binding | category=intent | cancel-leaves=nothing -->
   > 🚦 **Gate (intent · revert-branch:1.no-binding):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | No Git binding found for this environment. Set one up first? | Not bound to Git | Run /power-pages:git-configure, Cancel |

3. Capture binding fields: `organization`, `project`, `repository`, `branch` (the branch to revert), `bindingType`.

**Output:** Confirmed binding; branch coordinates captured.

---

## Phase 2 — List Recent Commits

**Goal:** Pull the recent commit history so the user can pick a sensible rollback target.

Tasks to create (`TaskCreate`):

1. List recent commits
2. User picks target commit SHA
3. Impact analysis (other envs bound to this branch)
4. Render destructive-action plan
5. Typed-consent gate
6. Execute branch force-update
7. Verify branch HEAD now equals target SHA
8. Write `last-branch-revert.json` marker
9. Final gate (notify teammates)

Steps:

1. ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ado-list-commits.js" \
       --organization "<org>" \
       --project      "<proj>" \
       --repository   "<repo>" \
       --branch       "<branch>" \
       --token        "<adoToken>" \
       --top          20
   ```

   Capture the current HEAD (the first commit returned) as `currentSha` — required later by the ADO concurrency check on the ref-update call.

**Output:** Up to 20 recent commits + `currentSha`.

---

## Phase 3 — User Picks Target Commit SHA

**Goal:** Collect the target SHA (must exist in the listed history; must be different from `currentSha`).

Steps:

1. If the user passed a SHA as an argument, validate it appears in the Phase 2 list.

   `revert-branch:3.target-sha` (not-a-gate — data-gathering): present the commit list (most recent first) and ask the user to pick one, OR paste a SHA (a full 40-char SHA or a unique prefix ≥ 7 chars).

2. Validate:
   - The chosen SHA must appear in the Phase 2 list (or in an extended fetch if the user paged further back — extend `--top` up to 200 if needed).
   - The chosen SHA must NOT equal `currentSha` (no-op).
   - Resolve any 7-char prefix to the full 40-char SHA.

**Output:** A validated 40-char `targetSha` distinct from `currentSha`.

---

## Phase 4 — Impact Analysis + Render Destructive-Action Plan

**Goal:** Make the blast radius explicit — how many other envs are bound to this branch and what commits are about to be discarded.

Steps:

1. Query the affected-envs count (best-effort): list Dataverse `gitintegrations` records pointing at the same `organization` / `project` / `repository` / `branch` (excluding the current env). *(// TODO: HAR-verify the exact entity name.)* If the query fails or returns no permission, surface `affectedEnvs: "unknown"` and continue — the warning is still useful.

2. Identify the commits between `targetSha` (exclusive) and `currentSha` (inclusive) from the Phase 2 list — these are the commits being discarded.

3. Compose and display:

   ```
   ⚠️  DESTRUCTIVE — BRANCH-WIDE ROLLBACK

     Branch:        <org>/<proj>/<repo>  branch <branch>
     Current HEAD:  <currentShaShort>   (<currentCommitMessage>)
     Reset to:      <targetShaShort>   (<targetCommitMessage>)
     Will discard:  N commit(s) between these two points:
       • <sha7>  <author>  <message-first-line>
       • …

     Impact:        ~{affectedEnvs} other env(s) bound to this branch will see
                    the older HEAD on their next git-sync pull. Any local
                    Changes built on top of the discarded commits will surface
                    as Conflicts.

     Reverses?      Only if one of the discarded commits is preserved on
                    another branch — push it elsewhere first if you need it.
   ```

**Output:** User sees full blast radius before consent.

---

## Phase 5 — Typed-Consent Gate

**Goal:** Demand a typed phrase that includes the target SHA — accidentally pasting a wrong SHA must not roll back to it.

Steps:

1. <!-- gate: revert-branch:5.typed-consent | category=consent | cancel-leaves=nothing -->
   > 🚦 **Gate (consent · revert-branch:5.typed-consent):** Surface `AskUserQuestion` requiring a typed phrase:

   | Question | Header | Options |
   |---|---|---|
   | This will reset branch `{branch}` to `{targetShaShort}` and discard {N} commit(s). To confirm, type exactly:  `REVERT BRANCH {targetShaShort}`  (anything else cancels and leaves the branch intact). | Typed confirmation required | (free-text input — Other) |

   The expected phrase includes the **short SHA** (first 7 chars). Match exactly, case-sensitive.

2. Validate:
   - Exact match for `REVERT BRANCH <targetShaShort>` → proceed.
   - Anything else → cancel cleanly; surface "Cancelled — branch `{branch}` is unchanged". No auto-retry.

**Output:** Exact typed confirmation including the target SHA received.

---

## Phase 6 — Execute Branch Force-Update

**Goal:** Call the ADO ref-update API with the concurrency-check `oldObjectId === currentSha` to fail closed if a teammate pushed in the meantime.

Steps:

1. ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/revert-branch.js" \
       --organization "<org>" \
       --project      "<proj>" \
       --repository   "<repo>" \
       --branch       "<branch>" \
       --currentSha   "<currentSha>" \
       --targetSha    "<targetSha>" \
       --pat          "<adoPAT>"
   ```

   The helper POSTs to ADO's `_apis/git/repositories/{repo}/refs?api-version=7.0` with `oldObjectId=<currentSha>` so ADO rejects the update if HEAD has moved since Phase 2. This is a concurrency guard — not a safety net.

2. Error handling:
   - **409 / `RefUpdateRejected*`** → a teammate pushed between Phase 2 and Phase 6. Surface this clearly and offer to re-run from Phase 2 to re-pick a target (the original target may no longer be the right one).
   - **403** → the PAT lacks `Code (write)` or branch-protection rules forbid force-pushes. Surface the remediation; do NOT auto-bypass.
   - **5xx** → transient; retry once.

**Output:** Branch ref updated; `previousHeadSha` and new `targetSha` recorded.

---

## Phase 7 — Verify Branch HEAD = Target SHA

**Goal:** Re-list commits and confirm the branch HEAD is now exactly `targetSha`.

Steps:

1. ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ado-list-commits.js" \
       --organization "<org>" \
       --project      "<proj>" \
       --repository   "<repo>" \
       --branch       "<branch>" \
       --token        "<adoToken>" \
       --top          1
   ```

2. The first (and only) commit returned must equal `targetSha`. If it does not, surface the discrepancy and instruct the user to run `/power-pages:diagnose-git-integration`; do NOT write the marker.

**Output:** Branch HEAD verified.

---

## Phase 8 — Write Marker

**Goal:** Persist the audit marker — including the previous HEAD and the affected-envs estimate for accountability.

Steps:

1. Write `docs/inner-loop/last-branch-revert.json`:

   ```json
   {
     "skill":          "revert-branch",
     "revertedAt":     "<ISO>",
     "envUrl":         "<envUrl>",
     "organization":   "<org>",
     "project":        "<proj>",
     "repository":     "<repo>",
     "branch":         "<branch>",
     "previousHeadSha": "<currentSha>",
     "targetSha":      "<targetSha>",
     "discardedCommitCount": N,
     "discardedCommits": [
       { "sha": "...", "author": "...", "messageFirstLine": "..." }
     ],
     "affectedEnvsEstimate": "<number or 'unknown'>",
     "status":         "succeeded"
   }
   ```

   The path is registered in `scripts/lib/inner-loop-paths.js` under the key `lastBranchRevert`.

**Output:** `docs/inner-loop/last-branch-revert.json` written.

---

## Phase 9 — Final Gate (Notify Teammates)

**Goal:** Make sure the user takes the off-platform action — telling their team — before the skill exits.

Steps:

1. <!-- gate: revert-branch:8.final | category=final | cancel-leaves=nothing -->
   > 🚦 **Gate (final · revert-branch:8.final):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Branch `{branch}` reset to `{targetShaShort}`. ~{affectedEnvs} other env(s) are bound to this branch — they need to `/power-pages:git-sync --pull` to pick up the older HEAD. Notify the team? | Branch revert complete — communicate | Done — I'll tell my team to run git-sync --pull, Run /power-pages:git-sync --pull on this env now (it's also affected), Exit |

### Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "RevertBranch"`.

**Output:** User exited with the team-notification responsibility acknowledged.

---

## Artifacts Written

| File | Location | Purpose |
|---|---|---|
| `last-branch-revert.json` | `docs/inner-loop/` | Audit marker: records previous HEAD, target SHA, discarded commits, affected-envs estimate; validated by `validate-revert-branch.js`. |

---

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| List recent commits | Listing recent commits | Call `ado-list-commits.js` (top 20); capture current HEAD as `currentSha` |
| User picks target commit SHA | Awaiting target SHA | Present commits; collect / validate SHA; resolve 7-char prefix to 40-char |
| Impact analysis (other envs) | Computing impact | Query `gitintegrations` for other envs bound to this branch; identify discarded commits |
| Render destructive-action plan | Rendering destructive plan | Print blast radius (discarded commits + affected envs + irreversibility) |
| Typed-consent gate | Awaiting typed consent | Demand exact `REVERT BRANCH {shortSha}` phrase; cancel on any mismatch |
| Execute branch force-update | Executing branch revert | Call `revert-branch.js`; ADO `oldObjectId` concurrency check prevents racing |
| Verify branch HEAD = target SHA | Verifying branch HEAD | Re-list top 1; confirm SHA matches `targetSha` |
| Write `last-branch-revert.json` marker | Writing revert marker | Persist audit marker including previous HEAD + affected-envs estimate |
| Final gate (notify teammates) | Finalising branch revert | Make the team-notification responsibility explicit |

---

## Key Decision Points (Wait for User)

1. **Phase 1**: If no Git binding exists → run `git-configure` or cancel (gate `revert-branch:1.no-binding`).
2. **Phase 3**: Target commit SHA (data-gathering, not a gate); validated against commit history.
3. **Phase 5**: Typed-consent — exact `REVERT BRANCH {shortSha}` to proceed; anything else cancels safely (gate `revert-branch:5.typed-consent`).
4. **Phase 9**: Choose next action — acknowledge team-notification, sync this env, or exit (gate `revert-branch:8.final`).

---

## Error Handling

- **Target SHA = current SHA**: no-op; cancel cleanly with a friendly message.
- **Target SHA not found in commit history**: extend the `ado-list-commits.js` page size (`--top 200`); if still not found, ask the user to provide a longer prefix or paste the full SHA.
- **`revert-branch.js` returns 409 (`RefUpdateRejected*`)**: a teammate pushed between Phase 2 and Phase 6. Re-run from Phase 2 to re-pick a target — the original target may no longer be the right one (the new HEAD's history may differ).
- **`revert-branch.js` returns 403**: ADO PAT lacks `Code (write)` OR the branch has branch-protection rules forbidding force-pushes. Surface remediation; do NOT auto-bypass.
- **`revert-branch.js` returns 5xx**: transient; retry once. If second attempt fails, surface verbatim. The marker is NOT written on failure.
- **Phase 7 reports HEAD ≠ targetSha**: anomaly — the platform accepted the call but the ref did not land. Surface the discrepancy and route to `/power-pages:diagnose-git-integration`; do NOT write the marker.
- **`affectedEnvsEstimate` query fails**: continue with the value `"unknown"`. The skill is still useful even without the count — it surfaces the warning generically.

---

**Begin with Phase 1: Binding Check**
