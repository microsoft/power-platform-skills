---
name: commit-to-git
description: >-
  Pushes all pending Changes from the Dataverse environment to the bound Azure DevOps
  branch via the CommitToGit OData action. Runs pre-flight validation, gathers a commit
  message, gets explicit consent, commits, polls until pending-changes count reaches zero,
  verifies the CommitId appears in ADO, and offers to open a PR.
  Writes docs/inner-loop/last-commit.json.
  Use when asked: "commit to git", "push my changes to ADO", "commit to azure devops",
  "push to the branch", "commit my canvas app changes", "save to git", "push to git",
  "commit pending changes", "run commit-to-git".
user-invocable: true
argument-hint: "Optional: commit message in quotes"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Commit to Git

Pushes pending Dataverse Changes to the bound Azure DevOps branch via the `CommitToGit` OData action. Runs the 5 pre-flight validators before committing, polls until the environment's pending-changes count drops to zero, verifies the commit SHA appears in ADO, and offers to open a PR.

## Overview

This skill is the "inner-loop save" — the daily action that promotes maker-portal edits from the environment into source control. It pairs with `sync-from-git` (the reverse direction). After this skill completes, the user typically either continues editing (and runs commit-to-git again later) or runs `open-pr` to request review.

`commit-to-git` calls the `validate-pending-changes` validators inline in Phase 3 — you do not need to run that skill first.

> 🛈 **First-commit baseline expectation (HAR-confirmed 2026-06).** The FIRST `CommitToGit` after `connect-solution-to-git` captures the ENTIRE solution as `Create` operations — not just what the maker recently edited. Expect the Changes count to equal the full solution component count (every custom entity drags ~13 standard system columns; pre-existing OOTB components in the solution also appear). Tutorial run on `InternLearning` produced **189 Changes for "Added a new Table"**. This is not a bug — Phase 4 plan render must NOT trigger a "this looks suspicious" warning when the first-commit count is large. See [`references/inner-loop-empirical-findings.md`](../../references/inner-loop-empirical-findings.md) §17.

> 🛈 **Post-conflict-resolve commits are normal (HAR-confirmed 2026-06).** When the user resolves a Conflict with **Keep current changes**, the item moves to pending Changes and lands here. The resulting commit is a flat linear commit on top of the conflict point — there is no special "merge commit" semantic. Tutorial run on `InternLearning` produced commit `5353c0d1` from a Keep-Existing decision on `sri_Task` description. Phase 8 verify should NOT flag the post-resolution commit as anomalous even if its file count is 1. See `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §21.

**References:**
- `${CLAUDE_PLUGIN_ROOT}/references/git-integration-api-patterns.md` §5 (`CommitToGit` returns `CommitToGitResponse { CommitId, Type }`)
- `${CLAUDE_PLUGIN_ROOT}/references/git-integration-api-patterns.md` §9 (17 MB per-file cap)
- `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-error-catalog.md`
- `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §17 (first-commit baseline) + §19 (Changes count >> PR file count is normal) + §21 (post-resolve Keep-Existing commits are normal linear commits)

## Prerequisites

- PAC CLI installed and authenticated
- Azure CLI installed and logged in
- A Git binding already established (run `/power-pages:setup-git-integration` first if needed)
- At least one pending Change in the environment (otherwise the skill exits cleanly)

**Initial request:** $ARGUMENTS

---

## Phase 1 — Prereq + Binding Check

**Goal:** Confirm tooling, auth, binding, and presence of pending Changes before doing any work.

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

   <!-- gate: commit-to-git:1.no-binding | category=intent | cancel-leaves=nothing -->
   > 🚦 **Gate (intent · commit-to-git:1.no-binding):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | No Git binding found for this environment. Set one up first? | Not bound to Git | Run /power-pages:setup-git-integration, Cancel |

3. Count pending Changes:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-pending-changes.js" \
       --envUrl "<envUrl>" --solutionUniqueName "<solutionUniqueName from manifest>"
   ```

   Pass `--solutionUniqueName` whenever the manifest's `bindingType === 'solution'`. The helper queries `sourcecontrolcomponent` filtered by `partitionid` + `iscommitted eq false` — that's the canonical "Changes tab" data (`references/inner-loop-empirical-findings.md` §10).

   If `count === 0`: nothing to commit. Inform the user and suggest `/power-pages:sync-from-git` if Updates are present. (Note: unlike earlier doc revisions, a fresh bind does NOT produce `count === 0` — it produces hundreds of staged Changes that need this skill's first run to actually push. See `references/inner-loop-empirical-findings.md` §3.)

   If `count > 0` AND `.git-integration-manifest.json`'s `boundAt` is within the last **2 hours**, this is the *fresh-bind initial-commit* case. Surface this clarifying note up-front so the user knows what they're about to push:

   > "This is the first commit since `connect-solution-to-git` ran. {count} components are staged as the **real** initial commit (the bind itself only created a placeholder `Readme.md`). After this commit, your ADO repo's `solutions/{gitFolder}/` folder will hold every component in the solution."

**Output:** Binding confirmed, N > 0 pending Changes detected (else clean exit with correct messaging).

---

## Phase 2 — List Pending Changes

**Goal:** Create the task list now that scope is known, and present the pending Changes to the user.

Tasks to create (`TaskCreate`):

1. Run pre-flight validation
2. Render commit plan
3. Gather commit message
4. Final consent before commit
5. Execute `CommitToGit`
6. Poll until pending changes clear
7. Verify CommitId in ADO
8. Final gate + offer to open PR

Steps:

1. Display the pending Changes in a friendly format:

   > **N pending Change(s)**
   > • 2 modified web templates
   > • 1 new web page
   > • …

**Output:** User sees what is about to be committed.

---

## Phase 3 — Pre-flight Validation

**Goal:** Run the same 5 validators that `/power-pages:validate-pending-changes` runs and surface blockers / warnings before any commit attempt.

Steps:

1. Run all 5 validators (inline — same as the `validate-pending-changes` skill Phase 3):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/validate-file-sizes.js"                  --envUrl "<envUrl>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/validate-supported-object-types.js"      --envUrl "<envUrl>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/check-large-canvas-warning.js"           --envUrl "<envUrl>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/check-code-first-binary-duplication.js"  --envUrl "<envUrl>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/validate-dependencies.js"                --envUrl "<envUrl>"
   ```

2. If `blockers.length > 0`:

   <!-- gate: commit-to-git:3.pre-flight-blockers | category=plan | cancel-leaves=nothing -->
   > 🚦 **Gate (plan · commit-to-git:3.pre-flight-blockers):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Pre-flight validation found N blocker(s). The commit would fail. Fix the issues and re-run this skill. | Commit blocked | Show me the blockers, Cancel |

3. If `blockers.length === 0` but `warnings.length > 0`:

   <!-- gate: commit-to-git:3.pre-flight-warnings | category=plan | cancel-leaves=nothing -->
   > 🚦 **Gate (plan · commit-to-git:3.pre-flight-warnings):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Pre-flight found N warning(s) but no blockers. Warnings won't cause a hard failure but may affect env behaviour. Proceed? | Pre-commit warnings | Proceed (Recommended), Show me the warnings first, Cancel |

**Output:** Pre-flight clean (or user has acknowledged warnings).

---

## Phase 4 — Render the Commit Plan

**Goal:** Show the user exactly what will be committed and where, and get explicit plan-approval before collecting a message.

> ⚠️ **Commit-count expectation (read before showing the plan):** `CommitToGit` is strictly 1-call → 1-commit. Whatever the count of pending Changes, this skill will produce **exactly one new commit** on the bound branch. The maker-portal Commit button behaves identically — there is no API or portal mechanism that splits a single user-initiated push into N commits. Other "extra" commits that may appear in the ADO history (a `Creating new project folder solutions/<name>` placeholder from bind time, or a top-level `Added README.md` from repo init) are pre-existing bookkeeping commits, NOT batches of this push. See `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §12.

Steps:

1. Compose and display the plan:

   ```
   Commit plan
     Environment:  <envUrl>
     Branch:       <branch>
     Components:   N changes
       • <objectType>: <name> (<changeType>)
       • …
     Warnings:     <count> (or "none")
     Blockers:     0 ✓
     ADO outcome:  Adds exactly 1 new commit to <branch> (CommitToGit always single-commit)
   ```

   > 💡 **Want multiple commits instead of one?** The supported workflow is to commit *incrementally as you work* — save change-set A in the maker portal → run `/power-pages:commit-to-git` (commit 1) → save change-set B → run `/power-pages:commit-to-git` again (commit 2). Do **not** accumulate changes and try to split at commit time — there is no `ComponentIds` / `BatchSize` parameter on `CommitToGit` and every call pushes every pending row for the bound solution. See `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §12.

2. <!-- gate: commit-to-git:4.plan | category=plan | cancel-leaves=nothing -->
   > 🚦 **Gate (plan · commit-to-git:4.plan):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Will commit N component(s) to `{branch}` as **1 new commit**. Continue? | Commit plan | Yes — proceed to commit message (Recommended), Cancel — let me split into multiple commits instead |

   If the user picks "let me split into multiple commits instead": exit the skill cleanly, print the incremental-commit guidance from the callout above (save subset → run commit-to-git → repeat), and suggest re-running `/power-pages:commit-to-git` after the next save.

**Output:** User has approved the commit scope (or chosen the incremental workflow).

---

## Phase 5 — Gather Commit Message

**Goal:** Collect a meaningful commit message for the audit trail.

`commit-to-git:5.commit-message` (not-a-gate — data-gathering):

Steps:

1. If the user passed an argument when invoking the skill, pre-populate it. Otherwise suggest a default based on the components (e.g. `"Update web templates and add contact-us page"`).
2. Prompt for the commit message via `AskUserQuestion`.
3. Validate: non-empty, ≤ 250 characters. Loop on validation failure.

**Output:** A validated commit message string.

---

## Phase 6 — Final Consent + Execute

**Goal:** Final consent before any Dataverse mutation, then call the `CommitToGit` OData action.

Steps:

1. <!-- gate: commit-to-git:6.consent | category=consent | cancel-leaves=nothing -->
   > 🚦 **Gate (consent · commit-to-git:6.consent):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Final consent — call `CommitToGit` on `{envHost}` with message "{commitMessage}" now? | Final consent | Commit now, Cancel |

2. On **Commit now**:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/commit-to-git.js" \
       --envUrl         "<envUrl>" \
       --commitMessage  "<message>"
   ```

   Pass `--solutionUniqueName "<name>"` only when the binding is solution-scoped (read from `.git-integration-manifest.json`).

   Expected output: `{ ok: true, commitId: "<sha>", type: <int> }`.

**Output:** `commitId` (the ADO commit SHA returned by Dataverse).

---

## Phase 7 — Poll Until Pending Changes = 0

**Goal:** Wait for Dataverse to finish ingesting the commit and clear the Changes tab.

Steps:

1. Poll `list-pending-changes.js` with a 5-second interval, up to 24 attempts (~2 minutes), until `count === 0`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-pending-changes.js" --envUrl "<envUrl>"
   ```

   Show a live counter: `Waiting for Changes to clear… attempt N/24 (count: X remaining)`.

2. If `count > 0` after all attempts: report a polling timeout. The commit may still be processing on the platform side — continue to Phase 8 anyway.

**Output:** Pending-changes count is 0 (or timeout noted).

---

## Phase 8 — Verify CommitId in ADO

**Goal:** Confirm the SHA Dataverse returned actually landed in the target ADO branch, then persist the marker.

Steps:

1. List recent commits from the bound branch:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ado-list-commits.js" \
       --organization "<org>" \
       --project      "<proj>" \
       --repository   "<repo>" \
       --branch       "<branch>" \
       --token        "<adoToken>" \
       --top          5
   ```

   Look for a commit whose `commitId` matches (or starts with) the SHA from Phase 6. If found: ✓ verified. If not found: surface a note — ADO may still be processing; not fatal.

   > 💡 **What you'll see in the ADO history (read this when presenting the verified-commit list to the user):** alongside your **1 new commit** from this run, you will likely see:
   > - A `Creating new project folder solutions/<gitFolder>` commit — created **once** by the original `ConnectToGit` for this solution. NOT a batch of this push.
   > - An `Added README.md` commit at the repo root — created **once** when the repo was first initialized. NOT a batch of this push either.
   >
   > Both are bookkeeping commits from prior bind/init events, not from this `CommitToGit`. Total commits visible after this skill ≈ 2 (placeholder + new) per bound solution, plus 1 repo-init README. See `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §12 for the full perception-trap explanation.

2. Write `docs/inner-loop/last-commit.json`:

   ```json
   {
     "skill":               "commit-to-git",
     "committedAt":         "<ISO>",
     "envUrl":              "<envUrl>",
     "commitId":            "<sha>",
     "commitMessage":       "<msg>",
     "branch":              "<branch>",
     "organization":        "<org>",
     "project":             "<proj>",
     "repository":          "<repo>",
     "componentsCommitted": N,
     "warnings":            [...],
     "status":              "succeeded"
   }
   ```

3. Update `.git-integration-manifest.json` field `lastCommitSha` with `<sha>`.

**Output:** Commit verified in ADO; marker written.

---

## Phase 9 — Final Gate + Offer Open-PR

**Goal:** Final user touchpoint — either route to PR creation or exit cleanly.

Steps:

1. <!-- gate: commit-to-git:9.open-pr | category=final | cancel-leaves=nothing -->
   > 🚦 **Gate (final · commit-to-git:9.open-pr):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Commit `{shortSha}` verified in ADO branch `{branch}`. What next? | Commit complete | Open a PR now (/power-pages:open-pr), Done — exit |

### Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "CommitToGit"`.

**Output:** User routed to next action (open-pr or idle).

---

## Artifacts Written

| File | Location | Purpose |
|---|---|---|
| `last-commit.json` | `docs/inner-loop/` | Skill-run marker; validated by `validate-commit-to-git.js`. |
| `.git-integration-manifest.json` | project root | `lastCommitSha` field updated to the new SHA. |

---

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| Run pre-flight validation | Running pre-flight validation | Inline-invoke the 5 pre-commit validators (file size, supported types, large canvas, PCF duplication, dependencies) |
| Render commit plan | Rendering commit plan | Build plan summary (env / branch / N components / warnings) and gate on user approval |
| Gather commit message | Gathering commit message | Prompt for / validate a commit message (≤ 250 chars, non-empty) |
| Final consent before commit | Awaiting commit consent | Surface the explicit consent gate before any Dataverse mutation |
| Execute `CommitToGit` | Executing CommitToGit | Call `commit-to-git.js` helper; capture the returned `commitId` |
| Poll until pending changes clear | Polling pending changes | Poll `list-pending-changes.js` every 5s until count = 0 (≤ 2 min) |
| Verify CommitId in ADO | Verifying CommitId in ADO | Call `ado-list-commits.js`; confirm the SHA appears in the bound branch |
| Final gate + offer to open PR | Finalising commit | Write `last-commit.json` + update manifest `lastCommitSha`; offer `open-pr` |

---

## Key Decision Points (Wait for User)

1. **Phase 1**: If no Git binding exists → run `setup-git-integration` or cancel (gate `commit-to-git:1.no-binding`).
2. **Phase 3**: If pre-flight finds blockers → must fix and re-run (gate `commit-to-git:3.pre-flight-blockers`).
3. **Phase 3**: If pre-flight finds warnings only → proceed, view details, or cancel (gate `commit-to-git:3.pre-flight-warnings`).
4. **Phase 4**: Approve the commit plan (gate `commit-to-git:4.plan`).
5. **Phase 5**: Commit message (data-gathering, not a gate).
6. **Phase 6**: Final consent before `CommitToGit` action (gate `commit-to-git:6.consent`).
7. **Phase 9**: Open PR now or exit (gate `commit-to-git:9.open-pr`).

---

## Error Handling

- **`CommitToGit` returns 400 with code `0x80040216` ("Shared components are not supported in source control")**: a component in the bound solution also lives in another Git-bound solution. The error names ONE shared component at a time, so you may need to resolve multiple in sequence. Pre-empt this by surfacing the full overlap to the user (intersect `solutioncomponents` of every `solutions?$filter=enabledforsourcecontrolintegration eq true` row with the target solution) and offer to call `${CLAUDE_PLUGIN_ROOT}/scripts/lib/remove-solution-component.js` for each overlapping `(objectid, componenttype)`. See `references/inner-loop-empirical-findings.md` §9 + §11.
- **`CommitToGit` HTTP times out (helper returns `{ error: "Request timed out" }`)**: the server-side commit holds the request open while ADO writes files (4-15 min for the first commit on a large solution). Poll `sourcecontrolcomponents?$filter=partitionid eq <solutionId> and iscommitted eq false&$count=true` every 15 s; when the count reaches 0, the commit succeeded — read the new SHA from `sourcecontrolbranchconfigurations.branchsyncedcommitid`.
- **`CommitToGit` returns 400 with "no changes to commit"**: a race — the user reverted externally between Phase 2 and Phase 6. Report and exit cleanly.
- **`CommitToGit` returns 400 with file-size error**: the 17 MB cap was hit despite Phase 3. Surface the failing component and exit; the user must split or delete the file and re-run.
- **`CommitToGit` returns 401 / 403**: ADO PAT lacks `Code (write)` scope on the bound repo. Surface the remediation from `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-error-catalog.md`.
- **`CommitToGit` returns 5xx**: transient — retry once. If second attempt fails, surface verbatim and stop.
- **Phase 7 polling timeout (count still > 0)**: non-fatal. The commit may still be in flight. Proceed to Phase 8 verification; if ADO has the SHA, the platform just hasn't refreshed the Changes tab yet.
- **Phase 8 SHA not found in ADO**: non-fatal warning. Suggest the user open the maker-portal Connect-to-Git panel to confirm visually; the marker is still written.

---

**Begin with Phase 1: Prereq + Binding Check**
