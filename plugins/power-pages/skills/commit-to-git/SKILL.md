---
name: commit-to-git
description: >-
  Pushes all pending Changes from the Dataverse environment to the bound Azure DevOps
  branch via the CommitToGit OData action. Runs pre-flight validation, gathers a commit
  message, gets explicit consent, commits, polls until pending-changes count reaches zero,
  verifies the CommitId appears in ADO, and offers to open a PR.
  Writes docs/inner-loop/last-commit.json.
  Also supports a non-mutating --dry-run mode that runs ONLY the pre-flight validators
  (writes docs/inner-loop/last-validation.json + pre-commit-report.html) and exits before
  any Dataverse mutation — use this when you want to know whether your pending changes
  are commit-ready without actually committing.
  Use when asked: "commit to git", "push my changes to ADO", "commit to azure devops",
  "push to the branch", "commit my canvas app changes", "save to git", "push to git",
  "commit pending changes", "run commit-to-git",
  "validate before commit", "check pending changes", "pre-flight check",
  "will this commit work", "check for issues before pushing to git",
  "dry run", "any blockers before I commit", "validate pending changes".
user-invocable: true
argument-hint: "Optional: commit message in quotes; --dry-run to validate without committing; --dry-run --json for CI stdout; --background to fire-and-forget"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Commit to Git

Pushes pending Dataverse Changes to the bound Azure DevOps branch via the `CommitToGit` OData action. Runs **14 pre-flight validators in parallel** via the `run-prevalidators.js` orchestrator (catches 17 MB file caps, orphan source-control rows, action=3 conflicts, shared components, blocked attachments, …), polls until the environment's pending-changes count drops to zero, verifies the commit SHA appears in ADO, and offers to open a PR.

Two run modes:

- **Real commit (default)** — runs Phases 1–9 end-to-end. Writes `docs/inner-loop/last-commit.json` with the embedded validation findings.
- **Dry run (`$ARGUMENTS` contains `--dry-run`)** — runs Phases 1–3 only, then EXITS before any Dataverse mutation. Writes `docs/inner-loop/last-validation.json` + `pre-commit-report.html` (same artifacts the legacy `/power-pages:validate-pending-changes` skill produced). Use this when you want to know whether your pending changes are commit-ready without committing.

## Overview

This skill is the "inner-loop save" — the daily action that promotes maker-portal edits from the environment into source control. It pairs with `sync-from-git` (the reverse direction). After a real commit, the user typically either continues editing (and runs commit-to-git again later) or runs `open-pr` to request review.

`commit-to-git` runs the pre-flight orchestrator inline in Phase 3 — you do not need to invoke any separate validation skill first.

> 🛈 **First-commit baseline expectation (HAR-confirmed 2026-06).** The FIRST `CommitToGit` after `connect-solution-to-git` captures the ENTIRE solution as `Create` operations — not just what the maker recently edited. Expect the Changes count to equal the full solution component count (every custom entity drags ~13 standard system columns; pre-existing OOTB components in the solution also appear). One tutorial run produced **189 Changes for "Added a new Table"**. This is not a bug — Phase 4 plan render must NOT trigger a "this looks suspicious" warning when the first-commit count is large. See [`references/inner-loop-empirical-findings.md`](../../references/inner-loop-empirical-findings.md) §17.

> 🛈 **Post-conflict-resolve commits are normal (HAR-confirmed 2026-06).** When the user resolves a Conflict with **Keep current changes**, the item moves to pending Changes and lands here. The resulting commit is a flat linear commit on top of the conflict point — there is no special "merge commit" semantic. One tutorial run produced a single-file commit from a Keep-Existing decision on a custom-table description. Phase 8 verify should NOT flag the post-resolution commit as anomalous even if its file count is 1. See `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §21.

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

> 🛈 **Mode detection (do this FIRST, before Phase 1).** If `$ARGUMENTS` contains the token `--dry-run`, set `mode = "dry-run"`. Otherwise `mode = "real-commit"`. Strip `--dry-run` from `$ARGUMENTS` before treating the remainder as a candidate commit message. Surface the detected mode to the user up-front:
> - Dry-run: "Running in dry-run mode — I'll validate your pending changes but will NOT commit."
> - Real-commit: standard behaviour.
>
> The two modes share Phases 1, 2, and 3. Dry-run EXITS after Phase 3's findings are surfaced (skipping Phases 4–9). Real-commit continues through Phase 9 and embeds Phase 3's findings into the eventual `last-commit.json` (no separate `last-validation.json` is written on the real-commit path, per design decision D5).

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

4. **Branch-policy info-note (C-10).** Fetch the bound branch's policies and tell the user when a blocking PR policy is configured — Dataverse's `CommitToGit` bypasses branch policies entirely (it commits via the platform service account, not through a PR), so users sometimes don't realise they're about to push directly to a "protected" branch. This is informational only; it is NOT a blocker for this skill.

   ```bash
   # Step 4a — resolve repo GUID (the policy API only accepts GUIDs, not repo names).
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ado-get-default-branch.js" \
       --organization "<org>" --project "<proj>" --repository "<repo>" \
       --token "<adoToken>"
   # Step 4b — fetch policies for the bound branch.
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ado-get-branch-policies.js" \
       --organization "<org>" --project "<proj>" \
       --repositoryId "<repoGuid from step 4a>" \
       --branch "<branch>" \
       --token "<adoToken>"
   ```

   If `hasBlockingPullRequestPolicy === true`, surface a one-line note like:

   > "ℹ️  Branch `{branch}` has a blocking PR policy (min reviewers / build validation / linked work items). Dataverse `CommitToGit` bypasses branch policies and will commit directly to `{branch}` — that's expected behaviour, not a bug. Use `open-pr` afterwards if you want a reviewed merge to a downstream branch."

   On 404 / 403 / network error: log the error and continue — the policy check is best-effort and must never block the skill.

**Output:** Binding confirmed, N > 0 pending Changes detected (else clean exit with correct messaging). Branch-policy state captured for the user's awareness.

---

## Phase 2 — List Pending Changes

**Goal:** Create the task list now that scope is known, and present the pending Changes to the user.

Tasks to create (`TaskCreate`):

**Real-commit mode (8 tasks):**

1. Run pre-flight validation
2. Render commit plan
3. Gather commit message
4. Final consent before commit
5. Execute `CommitToGit`
6. Poll until pending changes clear
7. Verify CommitId in ADO
8. Final gate + offer to open PR

**Dry-run mode (2 tasks):**

1. Run pre-flight validation
2. Surface findings + exit (no mutation)

Steps:

1. Display the pending Changes in a friendly format:

   > **N pending Change(s)**
   > • 2 modified web templates
   > • 1 new web page
   > • …

   Capture `N` (the pending-changes count) as `pendingChangesCount` — Phase 7's adaptive poll-timeout depends on it.

**Output:** User sees what is about to be committed (real-commit) or validated (dry-run).

---

## Phase 3 — Pre-flight Validation (orchestrator)

**Goal:** Run **all 14 pre-flight validators in parallel** via the `run-prevalidators.js` orchestrator (catches the three CommitToGit killer cases — orphan source-control rows → `0x80040217`, action=3 conflicts → `0x80098015`, shared components → `0x80040216` — plus the legacy 5 validators and 6 others). Capture the findings; in dry-run mode, exit cleanly after surfacing them.

Steps:

1. Persist the pending-changes snapshot to disk so the pure validators can consume it via `--pending-file` (the orchestrator reads `items[]` from this file):

   ```bash
   # The snapshot path is resolved via inner-loop-paths.js key `pendingChangesSnapshot`:
   #   <projectRoot>/docs/inner-loop/pending-changes-snapshot.json
   # Write { "items": [...] } using the list-pending-changes output from Phase 2.
   ```

2. Run all validators in a single orchestrator call (catalog: `validate-file-sizes`, `validate-supported-object-types`, `check-large-canvas-warning`, `check-code-first-binary-duplication`, `validate-dependencies`, `validate-no-orphan-source-control-rows`, `validate-no-action-3-conflicts`, `validate-no-shared-components`, `validate-not-default-solution`, `validate-solution-version-bumped`, `validate-no-iscustomizable-false-rows`, `validate-blocked-attachments`, `validate-publisher-prefix-consistency`, `validate-total-payload-size`):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/run-prevalidators.js" \
        --pending-file "<projectRoot>/docs/inner-loop/pending-changes-snapshot.json" \
        --envUrl "<envUrl>" \
        --solutionUniqueName "<solutionUniqueName from manifest>" \
        --env-friendly-name "<envFriendlyName>" \
        --project-root "<projectRoot>" \
        --format json
   ```

   The orchestrator ALWAYS writes:
   - `docs/inner-loop/last-validation.json` — canonical machine marker (status + blockers + warnings + delta + per-validator timings)
   - `docs/inner-loop/pre-commit-report.html` — human-readable report (delta badge, components-by-type table, IL-NNN hyperlinks, per-validator timings)

   Capture the JSON output as `validationReport = { status, blockers[], warnings[], infos[], delta, validatorTimings, componentsByType, elapsedMs }`.

3. **Dry-run mode early exit.** If `mode === "dry-run"`:

   a. Surface the findings using the same templates as Phase 6 below (blockers table / warnings table / clean summary). Do NOT gate on warnings here — dry-run is read-only so there's nothing to "proceed" to.
   b. Append a metric to `docs/inner-loop/skill-metrics.jsonl` via the shared helper:

      ```bash
      node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/append-skill-metric.js" \
           --project-root "<projectRoot>" \
           --skill "CommitToGit" \
           --json '{"mode":"dry-run","status":"<dry-run-passed|dry-run-warnings|dry-run-blocked>","durationMs":<elapsedMs>,"componentsValidated":<N>,"blockerCount":<#>,"warningCount":<#>}'
      ```

   c. Tell the user:
      - On `status === "passed"`: "Dry-run PASSED — N components are commit-ready. Run `/power-pages:commit-to-git` (without `--dry-run`) to actually commit." Status persisted in `last-validation.json`: `"dry-run-passed"`.
      - On warnings-only: "Dry-run found {warningCount} warning(s) but no blockers — commit would succeed. See `docs/inner-loop/pre-commit-report.html` for details." Status: `"dry-run-warnings"`.
      - On blockers: "Dry-run found {blockerCount} blocker(s) — commit would FAIL. See `docs/inner-loop/pre-commit-report.html` and remediate." Status: `"dry-run-blocked"`.
   d. **Exit cleanly.** Do NOT proceed past Phase 3 in dry-run mode. Skip Phases 4–9 entirely.

4. **Real-commit mode** continues below. Capture `validationReport` for later embedding into `last-commit.json` (Phase 8). The orchestrator already wrote `last-validation.json` — but on the real-commit path that file will be overwritten/superseded by `last-commit.json`'s embedded findings (per design decision D5). The user can still read `pre-commit-report.html` for the pretty version.

5. If `blockers.length > 0`:

   **(C-15) Auto-fix hook — 100%-blocked-attachments scenario.** If EVERY blocker came from the `validate-blocked-attachments` validator AND the user has not already opted out, offer to run the auto-fix in place rather than forcing the user to remediate manually. This narrow gate exists because blocked-attachments is the only blocker class with a deterministic, reversible auto-fix shipped in this plugin (`fix-blocked-attachments.js`). Other blocker classes either require maker-portal action (action=3 conflicts), schema edits (shared components), or platform recovery (orphan rows) and so must not be auto-touched here.

   ```bash
   # Detect the narrow gate: every blocker carries validator === "validate-blocked-attachments"
   ALL_BLOCKED_ATTACHMENTS=$(jq '[.blockers[].validator] | all(. == "validate-blocked-attachments")' docs/inner-loop/last-validation.json)
   ```

   If `ALL_BLOCKED_ATTACHMENTS === true`:

   <!-- gate: commit-to-git:3.auto-fix-blocked-attachments | category=plan | cancel-leaves=nothing -->
   > 🚦 **Gate (plan · commit-to-git:3.auto-fix-blocked-attachments):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Every blocker is a blocked-attachment site setting — I can auto-fix all of them in place via `fix-blocked-attachments.js` and re-run the validators. Proceed? | Auto-fix blocked attachments | Yes — fix and re-validate (Recommended), No — show me the blockers manually |

   On user "Yes": run `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/fix-blocked-attachments.js" --envUrl "<envUrl>"` and re-invoke Phase 3 step 2 (orchestrator). On second pass: if still blocked, surface the original blockers table; auto-fix has done its best.

   Otherwise (mixed blockers, or user declined the auto-fix):

   <!-- gate: commit-to-git:3.pre-flight-blockers | category=plan | cancel-leaves=nothing -->
   > 🚦 **Gate (plan · commit-to-git:3.pre-flight-blockers):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Pre-flight validation found N blocker(s). The commit would fail. Fix the issues and re-run this skill. | Commit blocked | Show me the blockers, Cancel |

6. If `blockers.length === 0` but `warnings.length > 0`:

   <!-- gate: commit-to-git:3.pre-flight-warnings | category=plan | cancel-leaves=nothing -->
   > 🚦 **Gate (plan · commit-to-git:3.pre-flight-warnings):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Pre-flight found N warning(s) but no blockers. Warnings won't cause a hard failure but may affect env behaviour. Proceed? | Pre-commit warnings | Proceed (Recommended), Show me the warnings first, Cancel |

**Output:** Pre-flight clean (or user has acknowledged warnings). Dry-run mode has already exited; only real-commit mode reaches Phase 4.

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

**Goal:** Collect a meaningful commit message for the audit trail. Supports three input modes — inline `$ARGUMENTS`, file path via `--commitMessageFile`, or interactive prompt with an auto-generated body — plus optional Azure Boards work-item linking via `--workItemId`.

`commit-to-git:5.commit-message` (not-a-gate — data-gathering):

Steps:

1. **Mode A — file path.** If `$ARGUMENTS` contains `--commitMessageFile <path>`, pass that flag straight through to the helper. The helper reads the file (UTF-8, normalises `\r\n` → `\n`, strips outer whitespace) and rejects empty-after-trim payloads. Skip the interactive prompt.

2. **Mode B — inline subject.** If `$ARGUMENTS` (after stripping `--dry-run`, `--workItemId`, `--commitMessageFile`) contains a non-flag string, treat it as the subject line and pre-populate the prompt with it.

3. **Mode C — interactive with auto-generated body.** If no subject was supplied, generate a multi-line draft:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/component-type-tally.js" \
        --items-file "<projectRoot>/docs/inner-loop/pending-changes-snapshot.json" \
        --format markdown
   ```

   The tally helper returns a Markdown bulleted breakdown (e.g. `- 4 Entity (3 create, 1 update)`). Compose:

   ```
   <SUBJECT — single line, ≤ 72 chars>

   <auto-generated tally body>
   ```

   Surface the draft via `AskUserQuestion`; let the user accept, edit, or replace.

4. **Optional: `--workItemId <n>`.** If `$ARGUMENTS` contains `--workItemId 1234`, pass it through to the helper. The helper validates that the value is a positive integer (Azure Boards silently drops bogus IDs — we surface them) and appends an `AB#1234` footer on a separate blank line. The append is idempotent — re-running with the same `--workItemId` does NOT double-footer.

5. Validate: non-empty, subject line ≤ 250 characters. Loop on validation failure.

> 🛈 **Tally function — single source of truth.** The same `component-type-tally.js` library is also consumed by `run-prevalidators.js` to populate the dry-run HTML report's "what would be committed" section, so the phrasing in the auto-generated body matches what the user saw in the pre-commit report.

**Output:** A validated commit message string, optionally with an `AB#<n>` footer.

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

**Goal:** Wait for Dataverse to finish ingesting the commit and clear the Changes tab. Adaptive timeout scales with the size of the commit (large commits take longer to ingest); exponential backoff avoids hammering the API on multi-minute waits.

Steps:

1. Compute adaptive poll parameters from `pendingChangesCount` captured in Phase 2:

   ```text
   pollMaxAttempts = clamp( max(40, ceil(N / 10)), 40, 600 )
   pollIntervalMs  = 3000            # 3 s base
   pollBackoff     = "exponential"   # 3 s, 6 s, 12 s, 24 s, capped at 30 s per poll-git-operation.js
   ```

   This guarantees a floor of 40 attempts (small commits still get ≥2 minutes), scales linearly to 600 attempts (~30 min upper bound for very large commits), and uses exponential backoff so a long-running commit doesn't generate hundreds of tight requests.

2. Invoke the helper with the computed parameters:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/commit-to-git.js" \
       --envUrl           "<envUrl>" \
       --token            "<dataverse token>" \
       --solutionUniqueName "<solutionUniqueName from manifest>" \
       --commitMessage    "<message>" \
       --pollIntervalMs   3000 \
       --pollMaxAttempts  <pollMaxAttempts> \
       --pollBackoff      exponential
   ```

   The helper itself runs the polling loop (this is the same helper called in Phase 6) — when present in the same invocation, Phase 6 + Phase 7 are a single helper call returning `{ commitId, type, polled: { attempts, reached, finalValue }, pollWarning? }`.

   Show a live counter: `Waiting for Changes to clear… attempt N/M (count: X remaining)`.

3. If `polled.reached === false` after all attempts: surface `pollWarning` to the user (e.g. "pending-changes count did not drop to 0 after M attempts (~Ts)") — the commit may still be processing on the platform side. Continue to Phase 8 anyway; ADO verification is the authoritative success signal.

4. **(C-14) Third-party-writer detection (best-effort, post-poll).** If `polled.reached === false` AND the warning is going to be surfaced, snapshot the latest 3 commits on the bound branch and compare authors against the platform service account. A non-Dataverse author on the branch tip between this skill's POST and its poll-clear means another writer (a teammate's `commit-to-git`, a CI bot, a maker-portal push from another solution bound to the same branch) raced us — useful context for the user.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ado-list-commits.js" \
        --organization "<org>" --project "<proj>" --repository "<repo>" \
        --branch "<branch>" --token "<adoToken>" --top 3
   ```

   If ANY of the top-3 commits' `author.email` does NOT match the Dataverse platform service account pattern (`admin@PowerPlatform.onmicrosoft.com` or `PowerPortals Runtime` as `author.name`), append a one-line warning to `pollWarning`:

   > "ℹ️  Detected concurrent writer on `{branch}`: commit `{shortSha}` by `{author}` landed during the wait. This is the most common cause of a non-clearing pending-changes count."

   This detection is opportunistic — if the ADO call errors out, log and move on; the third-party-writer warning is informational, not a blocker.

**Output:** Pending-changes count is 0 (or poll-timeout noted with the adaptive `M` reflected in the warning text, plus the optional third-party-writer note).

---

## Phase 8 — Verify CommitId in ADO

**Goal:** Confirm the SHA Dataverse returned actually landed in the target ADO branch, then persist the marker and record the run metric.

Steps:

1. **(C-2) Direct SHA lookup.** Replace the legacy `--top 5` list scan with a single GET against the specific SHA — this is constant-time and tolerates third-party pushes landing on the branch between Phase 6 and Phase 8 (the legacy `--top 5` quietly false-negated if 5+ other writers raced us):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ado-get-commit.js" \
        --organization "<org>" \
        --project      "<proj>" \
        --repository   "<repo>" \
        --commitId     "<sha from Phase 6>" \
        --token        "<adoToken>"
   ```

   - On `found === true`: ✓ verified. Capture `r.url` (the remote web URL) for the user-facing summary.
   - On `statusCode === 404`: ADO may still be processing — re-issue once with a 3-second backoff, then if still not found, surface a non-fatal note ("ADO has not yet replicated commit `{shortSha}` — try the maker-portal Source Control panel to confirm visually"). Continue to step 2.

   > 💡 **What you'll see in the ADO history (read this when presenting the verified-commit list to the user):** alongside your **1 new commit** from this run, you will likely see:
   > - A `Creating new project folder solutions/<gitFolder>` commit — created **once** by the original `ConnectToGit` for this solution. NOT a batch of this push.
   > - An `Added README.md` commit at the repo root — created **once** when the repo was first initialized. NOT a batch of this push either.
   >
   > Both are bookkeeping commits from prior bind/init events, not from this `CommitToGit`. Total commits visible after this skill ≈ 2 (placeholder + new) per bound solution, plus 1 repo-init README. See `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §12 for the full perception-trap explanation.

2. Write `docs/inner-loop/last-commit.json` with Phase 3's `validationReport` embedded inline (per design decision D5 — no standalone `last-validation.json` on the real-commit path):

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
     "status":              "succeeded",
     "validation": {
       "status":            "<passed|warnings>",
       "blockerCount":      0,
       "warningCount":      <#>,
       "infoCount":         <#>,
       "blockers":          [],
       "warnings":          [...],
       "infos":             [...],
       "validatorTimings":  {...},
       "componentsByType":  {...},
       "elapsedMs":         <ms>
     }
   }
   ```

3. Update `.git-integration-manifest.json` field `lastCommitSha` with `<sha>`.

4. Append a run metric to `docs/inner-loop/skill-metrics.jsonl` — one line per real-commit invocation, used by `refresh-inner-loop-plan-data.js` and downstream dashboards:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/append-skill-metric.js" \
        --project-root "<projectRoot>" \
        --skill "CommitToGit" \
        --json '{"mode":"real-commit","status":"succeeded","commitId":"<sha>","durationMs":<helperElapsedMs>,"pollAttempts":<polled.attempts>,"componentsCommitted":<N>,"branch":"<branch>","blockerCount":0,"warningCount":<#>}'
   ```

   The helper auto-injects `ts` (ISO timestamp) and ensures `skill` is exactly `"CommitToGit"` — both real and dry-run runs report under the same skill name (per design decision D3).

**Output:** Commit verified in ADO; marker + metric written.

---

## Phase 9 — Final Gate + Offer Open-PR + Optional Tag

**Goal:** Final user touchpoint — either route to PR creation, tag the new commit, or exit cleanly. Skip the open-PR offer entirely when the bound branch IS the repo default (a PR-to-self has no semantics).

Steps:

1. **(C-3) PR-to-self detection.** Fetch the repo's default branch and compare with the bound branch:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ado-get-default-branch.js" \
        --organization "<org>" --project "<proj>" --repository "<repo>" \
        --token "<adoToken>"
   ```

   - If `defaultBranch === bound branch`: skip the `commit-to-git:9.open-pr` gate entirely. Surface a one-line "✓ Commit `{shortSha}` landed on default branch `{branch}` — no PR needed." and continue to step 3 (tag offer).
   - If the helper errors out (network / 404 / 403): fall through to the gate as before; default-branch detection is best-effort.

2. **Open-PR gate (only when bound ≠ default):**

   <!-- gate: commit-to-git:9.open-pr | category=final | cancel-leaves=nothing -->
   > 🚦 **Gate (final · commit-to-git:9.open-pr):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Commit `{shortSha}` verified in ADO branch `{branch}`. What next? | Commit complete | Open a PR now (/power-pages:open-pr), Tag this commit, Done — exit |

   - If user picks "Open a PR now": chain into `/power-pages:open-pr`.
   - If user picks "Tag this commit": fall through to step 3 (tag offer) with the chosen tag name.
   - If user picks "Done — exit": fall through to step 3 (tag offer) as an opt-in.

3. **(C-13) Optional tag offer.** Whether we skipped the PR gate (PR-to-self) or completed it, offer to tag the new SHA. Tags are useful for release-cuts on `main` and for marking known-good states on feature branches.

   <!-- gate: commit-to-git:9.tag-offer | category=final | cancel-leaves=nothing -->
   > 🚦 **Gate (final · commit-to-git:9.tag-offer):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Tag commit `{shortSha}` with a Git tag in `{repo}`? | Tag this commit | Tag it (you'll be prompted for a name), Skip tagging |

   If the user accepts:

   a. Prompt for a tag name (free-text). Validate client-side via the helper's exported `isValidTagName`:

      - Must start with an alphanumeric (not `-`).
      - May contain `A-Za-z0-9._-/` only.
      - Max length 100 chars.
      - Disallowed: `..`, `@{`, trailing `.lock`.

      If validation fails, re-prompt with the exact reason from the helper.

   b. Create the tag:

      ```bash
      node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ado-create-tag.js" \
           --organization "<org>" --project "<proj>" --repository "<repo>" \
           --name "<tagName>" --commitSha "<full40CharSha>" \
           --token "<adoToken>"
      ```

      - On success: helper returns `{ ok: true, name, tagSha, commitSha, url }`. Write `docs/inner-loop/last-tag.json` with `{ name, tagSha, commitSha, url, taggedAt }`. Surface a confirmation line with the URL.
      - On 409 ("already exists"): helper returns `{ ok: false, error: "Tag … already exists", code: "TAG_EXISTS" }`. Surface the message and offer to pick a different name or skip.
      - On other failures: surface the error verbatim and skip.

### Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "CommitToGit"`.

**Output:** User routed to next action (open-pr, tag, or idle).

---

## Background Mode (`--background`) — C-17

For pipelines and other unattended callers that don't want to block on the (potentially 5–15 min) Phase 7 poll, `commit-to-git.js` accepts a `--background` flag.

**Behaviour:**
- The helper POSTs `CommitToGit` synchronously, captures the returned `commitId`, then:
  - Writes `docs/inner-loop/pending-commit-ticket.json` with `{ skill, commitId, solutionUniqueName, envUrl, startedAt, pollPid, pollIntervalMs, pollMaxAttempts, pollBackoff, status: "background-polling" }`.
  - Spawns a detached child Node process that polls pending-changes with the requested cadence.
  - Returns immediately to the foreground caller with `{ background: true, commitId, pollPid, ticketFile, polled: null }`.
- The detached child writes `docs/inner-loop/last-commit.json` with `{ status: "succeeded" | "poll-timeout", polled, backgroundElapsedMs, ... }` once the count reaches 0 (or the cap is exhausted), then deletes the ticket file.

**When to use:**
- Long-running CI jobs that should fire-and-forget the commit while doing other work.
- Interactive sessions where the user wants to keep typing while the platform writes 500+ components to ADO.

**Invocation example:**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/commit-to-git.js" \
     --envUrl "<envUrl>" --solutionUniqueName "<name>" \
     --commitMessage "feat: ..." \
     --projectRoot "<sessionRoot>" \
     --background
```

**Caller responsibilities:**
- Re-check `last-commit.json` after the workload completes (or poll the ticket file's absence as a "done" signal — when the ticket disappears, `last-commit.json` has been written).
- If the parent process exits before the child finishes, the child still completes — `unref()` ensures it survives parent shutdown. The child uses `stdio: 'ignore'`, `detached: true`, and `windowsHide: true` so it won't pop a console window on Windows.

---

## Dry-run JSON Output (`--dry-run --json`) — C-19

For CI pipelines consuming dry-run findings, the skill's dry-run path forwards `--format json` to the validator orchestrator and additionally streams the resulting JSON to stdout (in addition to the on-disk HTML/JSON markers).

When invoked as `/power-pages:commit-to-git --dry-run --json`:
1. The skill calls `run-prevalidators.js` with `--format json`.
2. The orchestrator's full JSON envelope is captured and written verbatim to stdout (in addition to the HTML+JSON artifacts under `docs/inner-loop/`).
3. The skill EXITS without consuming Dataverse mutations (same as plain `--dry-run`).

Pipelines can then `jq` the stdout for `status`, `blockers[]`, `warnings[]` without parsing the HTML or reading the marker file. The HTML report is still written for the post-pipeline human review.

---

## Artifacts Written

| File | Location | Mode | Purpose |
|---|---|---|---|
| `last-commit.json` | `docs/inner-loop/` | real-commit only | Skill-run marker; validated by `validate-commit-to-git.js`. Embeds the full pre-flight validation report (per design decision D5 — no standalone `last-validation.json` on the real-commit path). |
| `last-validation.json` | `docs/inner-loop/` | dry-run only | Skill-run marker for the dry-run path. Written by `run-prevalidators.js`. Status is `dry-run-passed` / `dry-run-warnings` / `dry-run-blocked`. |
| `pre-commit-report.html` | `docs/inner-loop/` | both | Human-readable validation report (delta badge, components-by-type table, IL-NNN hyperlinks, validator timings). Always written by the orchestrator. |
| `pending-changes-snapshot.json` | `docs/inner-loop/` | both | Transient: materialised `list-pending-changes` output that the parallel validators consume via `--pending-file`. Overwritten each run. |
| `skill-metrics.jsonl` | `docs/inner-loop/` | both | Append-only JSONL telemetry — one line per invocation. Both modes report under `skill: "CommitToGit"` (per design decision D3). |
| `last-tag.json` | `docs/inner-loop/` | real-commit only (opt-in) | Written when the user accepts the Phase 9 tag-offer. Captures `{ name, tagSha, commitSha, url, taggedAt }`. |
| `pending-commit-ticket.json` | `docs/inner-loop/` | `--background` only | Transient: written immediately after the foreground `CommitToGit` POST returns; carries `{ commitId, pollPid, status: "background-polling", ... }`. Deleted by the detached poller when `last-commit.json` is written. |
| `.git-integration-manifest.json` | project root | real-commit only | `lastCommitSha` field updated to the new SHA. |

---

## Progress Tracking Table

Real-commit mode (default — 8 tasks):

| Task subject | activeForm | Description |
|---|---|---|
| Run pre-flight validation | Running pre-flight validation | Invoke `run-prevalidators.js` orchestrator — 14 validators in parallel (file size, supported types, large canvas, PCF duplication, dependencies, orphan rows, action=3 conflicts, shared components, not-default-solution, version-bump, IsCustomizable=false, blocked attachments, publisher-prefix, total payload size) |
| Render commit plan | Rendering commit plan | Build plan summary (env / branch / N components / warnings) and gate on user approval |
| Gather commit message | Gathering commit message | Prompt for / validate a commit message (≤ 250 chars, non-empty) |
| Final consent before commit | Awaiting commit consent | Surface the explicit consent gate before any Dataverse mutation |
| Execute `CommitToGit` | Executing CommitToGit | Call `commit-to-git.js` helper; capture the returned `commitId` |
| Poll until pending changes clear | Polling pending changes | Adaptive: `pollMaxAttempts = clamp(max(40, ceil(N/10)), 40, 600)` with exponential backoff, base 3s, cap 30s |
| Verify CommitId in ADO | Verifying CommitId in ADO | Call `ado-list-commits.js`; confirm the SHA appears in the bound branch; write `last-commit.json` + append `skill-metrics.jsonl` |
| Final gate + offer to open PR | Finalising commit | Update manifest `lastCommitSha`; offer `open-pr` |

Dry-run mode (`--dry-run` — 2 tasks):

| Task subject | activeForm | Description |
|---|---|---|
| Run pre-flight validation | Running pre-flight validation | Invoke `run-prevalidators.js` orchestrator (same 14 validators as real-commit) |
| Surface findings + exit | Surfacing findings | Display blockers / warnings / clean summary; append `skill-metrics.jsonl`; EXIT without mutating Dataverse |

---

## Key Decision Points (Wait for User)

1. **Phase 1**: If no Git binding exists → run `setup-git-integration` or cancel (gate `commit-to-git:1.no-binding`).
2. **Phase 3**: If pre-flight finds blockers → must fix and re-run (gate `commit-to-git:3.pre-flight-blockers`). In dry-run mode this gate is informational only (skill exits after surfacing blockers without offering "Cancel" — there's nothing to cancel).
3. **Phase 3**: If pre-flight finds warnings only → proceed, view details, or cancel (gate `commit-to-git:3.pre-flight-warnings`). In dry-run mode this gate is informational only; dry-run never proceeds past Phase 3.
4. **Phase 4** (real-commit only): Approve the commit plan (gate `commit-to-git:4.plan`).
5. **Phase 5** (real-commit only): Commit message (data-gathering, not a gate).
6. **Phase 6** (real-commit only): Final consent before `CommitToGit` action (gate `commit-to-git:6.consent`).
7. **Phase 9** (real-commit only): Open PR now, tag the commit, or exit (gate `commit-to-git:9.open-pr`).
8. **Phase 9** (real-commit only, opt-in): Tag the new commit with a Git tag (gate `commit-to-git:9.tag-offer`).

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
