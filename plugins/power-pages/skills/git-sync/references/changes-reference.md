# Changes Reference — Commit Flow

Follow this reference when the `git-sync` dispatcher routes a Dirty state (`Changes > 0`) or the commit half of Mixed/Both.

## Scope and invariants

- This is the commit-side flow only: Dataverse environment → bound Azure DevOps branch through `CommitToGit`.
- The dispatcher owns top-level state detection, no-binding handling, stale-manifest handling, conflict-first routing, Mixed ordering, and final follow-ups. This reference assumes the dispatcher has identified `<envUrl>`, `<envHost>`, `<solutionUniqueName>`, `<organization>`, `<project>`, `<repository>`, `<branch>`, `<projectRoot>`, ADO auth, Dataverse auth, and the user's arguments.
- Use deterministic helpers under `${CLAUDE_PLUGIN_ROOT}/scripts/lib/`. Do not inline Dataverse or ADO REST calls when a helper exists.
- Use `${CLAUDE_PLUGIN_ROOT}/scripts/lib/inner-loop-paths.js` for inner-loop marker paths. Do not hardcode marker paths in scripts.
- `CommitToGit` always creates exactly one commit for all pending Changes in the selected solution. There is no supported API parameter for splitting one pending set into multiple commits.
- First commits after a fresh solution binding can legitimately contain the full solution component set. A large Changes count is not suspicious by itself.
- Post-conflict **Keep current changes** resolutions land back in Changes and should be committed by this flow. A one-file post-resolution commit is normal.
- Do not add approval-gate IDs in this reference beyond the five IDs listed at the end.

## Modes and argument parsing

Parse the dispatcher arguments before Step 1:

| Flag / input | Effect |
|---|---|
| `--dry-run` | Run Steps 1–2 only, write `last-validation.json` and `pre-commit-report.html`, and exit before any Dataverse mutation. |
| `--dry-run --json` | Same as `--dry-run`, plus stream the validator JSON envelope to stdout for CI. |
| `--background` | Run validation, plan, message, and consent; call `commit-to-git.js --background`; write `pending-commit-ticket.json`; return before foreground polling/verification. |
| `--commitMessageFile <path>` | Recommended message path. Pass through to `commit-to-git.js`; it reads UTF-8, normalizes line endings, trims outer whitespace, and rejects empty content. |
| Inline non-flag text | Treat as the commit subject line after removing recognized flags. |
| `--workItemId <number>` | Pass through to `commit-to-git.js`; the helper validates and appends an `AB#<number>` footer idempotently. |

Dry-run mode never fires plan/consent gates and never runs the blocked-attachments auto-fix because both would lead toward mutation. It surfaces findings and exits.

## Step 1 — List pending Changes

**Goal:** Materialize the authoritative maker-portal Changes tab for the selected solution.

1. List pending Changes with the paginated helper:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-pending-changes.js" --envUrl "<envUrl>" --solutionUniqueName "<solutionUniqueName>" --top 5000 --max-items 100000
   ```

   The helper auto-follows `@odata.nextLink`. Read all three top-level fields:

   | Field | Required handling |
   |---|---|
   | `count` | Total pending Changes. This is the source of truth for the commit size and poll budget. |
   | `items` | Materialized rows used by the plan and validators. Expected to be complete when `truncated === false`. |
   | `truncated` | If `true`, the snapshot is incomplete. Re-run with a higher `--max-items` before validation; never validate or commit from a partial snapshot. |

2. If `count === 0`, stop this reference and hand back to the dispatcher for re-detection. There is nothing to commit.
3. Persist the full helper output to `innerLoopPath(projectRoot, 'pendingChangesSnapshot')`, which resolves to `docs/inner-loop/pending-changes-snapshot.json`. The file must contain at least `{ "count": <n>, "items": [...], "truncated": false }`.
4. Render a concise Changes summary. If useful, call the git-sync readability helper to split real config from compiled bundle churn:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/classify-change-set.js" --items-file "<pendingChangesSnapshotPath>"
   ```

   Never hide config changes. It is safe to collapse bundle churn in the summary as long as the plan states the total `count`.
5. Capture `pendingChangesCount = count` for poll-budget calculation and marker writing.
6. Best-effort branch-policy note: fetch the repo GUID/default-branch metadata with `${CLAUDE_PLUGIN_ROOT}/scripts/lib/ado-get-default-branch.js`, then fetch branch policies with `${CLAUDE_PLUGIN_ROOT}/scripts/lib/ado-get-branch-policies.js`. If blocking PR policies exist on `<branch>`, tell the user that Dataverse `CommitToGit` commits directly to the branch through the platform service identity and bypasses PR policies. Policy lookup failures are informational; never block on them.

**Output:** A complete, non-truncated pending Changes snapshot and `pendingChangesCount > 0`.

## Step 2 — Pre-flight validation

**Goal:** Run the 14-validator pre-flight orchestrator and stop before mutation if the commit would fail.

1. Invoke the orchestrator against the snapshot:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/run-prevalidators.js" --pending-file "<pendingChangesSnapshotPath>" --envUrl "<envUrl>" --solutionUniqueName "<solutionUniqueName>" --env-friendly-name "<envFriendlyName>" --project-root "<projectRoot>" --format json
   ```

2. `run-prevalidators.js` runs these 14 validators in parallel:

   | Validator | Primary purpose |
   |---|---|
   | `validate-file-sizes` | Blocks files that exceed platform file-size caps. |
   | `validate-supported-object-types` | Blocks unsupported source-control component types. |
   | `check-large-canvas-warning` | Warns about large canvas/app payload patterns. |
   | `check-code-first-binary-duplication` | Warns about duplicate code-first binary churn. |
   | `validate-dependencies` | Surfaces missing dependency risks. |
   | `validate-no-orphan-source-control-rows` | Catches orphan source-control rows before `0x80040217`. |
   | `validate-no-action-3-conflicts` | Catches action=3 conflict rows before `0x80098015`. |
   | `validate-no-shared-components` | Catches shared components before `0x80040216`. |
   | `validate-not-default-solution` | Blocks unsafe Default-solution commits. |
   | `validate-solution-version-bumped` | Warns/blocks when solution version discipline is missing. |
   | `validate-no-iscustomizable-false-rows` | Catches non-customizable rows that cannot round-trip safely. |
   | `validate-blocked-attachments` | Detects `.js` / `.css` blocked-attachment settings. |
   | `validate-publisher-prefix-consistency` | Detects publisher-prefix drift. |
   | `validate-total-payload-size` | Warns/blocks oversized aggregate payloads. |

3. The orchestrator always writes:

   | Artifact | Inner-loop key | Contract |
   |---|---|---|
   | `last-validation.json` | `lastValidation` | Machine-readable validator report consumed by dry-run CI surfaces, plan-alm Phase 0, and the merged commit validator. Do not rename or move it. |
   | `pre-commit-report.html` | `preCommitReportHtml` | Human-readable report with delta, findings, component type tally, links, and validator timings. |

4. Capture `validationReport = report` from the JSON output. The expected fields include `status`, `blockers[]`, `warnings[]`, `infos[]`, `delta`, `validatorTimings`, `componentsByType`, and `elapsedMs`.
5. If `--dry-run` is active:
   - Surface blockers / warnings / clean summary from `validationReport`.
   - Preserve the dry-run marker contract by normalizing `last-validation.json.status`: `passed` → `dry-run-passed`, `warnings` → `dry-run-warnings`, and `blocked` → `dry-run-blocked`. Keep the rest of the report intact.
   - If `--json` is also active, write the same JSON envelope to stdout for CI after the status normalization so CI sees the contract shape.
   - Append a metric through `${CLAUDE_PLUGIN_ROOT}/scripts/lib/append-skill-metric.js` with `skill: "CommitToGit"`, mode `dry-run`, validator status, component count, blocker count, warning count, and duration.
   - Exit this reference immediately. Do not auto-fix, plan, collect a message, ask for consent, or call `CommitToGit`.

### Real-commit validation gates

6. If `blockers.length > 0`, first check whether every blocker came from `validate-blocked-attachments`. This is the only deterministic in-place auto-fix in this flow.

<!-- gate: git-sync:changes.auto-fix-blocked-attachments | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · git-sync:changes.auto-fix-blocked-attachments):** Fires only when every blocker is from `validate-blocked-attachments` and this is not dry-run mode. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Every pre-flight blocker is a blocked-attachment site setting. I can auto-fix all blocked `.js` / `.css` entries in place with `fix-blocked-attachments.js` and then re-run all validators. Proceed? | Auto-fix blocked attachments | Yes — fix and re-validate (Recommended), No — show me the blockers manually |
>
> Choosing **Yes** calls `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/fix-blocked-attachments.js" --envUrl "<envUrl>"`, then re-runs Step 2 from the orchestrator call. Choosing **No** falls through to the blockers gate. Cancellation leaves no commit and no auto-fix.

7. If blockers remain after any auto-fix attempt, or blockers are mixed/non-fixable, stop at the blockers gate.

<!-- gate: git-sync:changes.pre-flight-blockers | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · git-sync:changes.pre-flight-blockers):** Fires when real-commit pre-flight validation found one or more blockers. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Pre-flight validation found `{blockerCount}` blocker(s). The commit would fail. Fix the issues and re-run `git-sync`. | Commit blocked | Show me the blockers, Cancel |
>
> After showing blockers, exit without calling `CommitToGit`. Cancellation leaves no Dataverse commit.

8. If `blockers.length === 0` and `warnings.length > 0`, fire the warnings gate.

<!-- gate: git-sync:changes.pre-flight-warnings | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · git-sync:changes.pre-flight-warnings):** Fires when real-commit pre-flight validation found warnings but no blockers. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Pre-flight validation found `{warningCount}` warning(s) but no blockers. Warnings will not hard-fail the commit, but they may affect environment behavior. Proceed? | Pre-commit warnings | Proceed (Recommended), Show me the warnings first, Cancel |
>
> **Proceed** continues to the commit plan. **Show me the warnings first** displays the warning table and then asks again. Cancellation leaves no Dataverse commit.

**Output:** Dry-run has exited, or real-commit mode has no blockers and warnings are acknowledged.

## Step 3 — Render the commit plan

**Goal:** Show exactly what will be committed and obtain plan approval before collecting a message.

1. Render a concise plan from the pending snapshot and validation report:

   ```text
   Commit plan
     Environment:  <envHost>
     Solution:     <solutionUniqueName>
     Branch:       <branch>
     Components:   <pendingChangesCount> change(s)
       • <componentType>: <componentName> (<changeType>)
       • ...
     Bundle churn: <churnCount> collapsed build-output file(s), if any
     Warnings:     <warningCount> (or none)
     Blockers:     0
     ADO outcome:  exactly 1 new commit on <branch>
   ```

2. Include the incremental-commit guidance when the user asks about multiple commits: to get multiple commits, the maker must save a subset, run `git-sync`/commit, save the next subset, and run again. `CommitToGit` cannot split the current pending set.

<!-- gate: git-sync:changes.plan | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · git-sync:changes.plan):** Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Will commit `{pendingChangesCount}` component(s) from `{envHost}` solution `{solutionUniqueName}` to `{branch}` as exactly **1 new commit**. Continue? | Commit plan | Yes — proceed to commit message (Recommended), Cancel — let me split into multiple commits instead |
>
> If the user chooses to split, exit cleanly and repeat the incremental-commit guidance. Cancellation leaves no Dataverse commit.

**Output:** The user approved the commit scope.

## Step 4 — Gather commit message

**Goal:** Produce a non-empty commit message with a useful audit trail. This is data gathering, not an Approval Gate.

1. **Mode A — `--commitMessageFile <path>` (recommended):** pass the file path through to `commit-to-git.js`. Prefer this mode for multi-line messages and for Windows callers because it avoids shell quoting issues.
2. **Mode B — inline subject:** if the remaining non-flag argument text is non-empty, use it as the subject line.
3. **Mode C — interactive draft:** if no message was supplied, generate a body from the pending snapshot:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/component-type-tally.js" --items-file "<pendingChangesSnapshotPath>" --format markdown
   ```

   Draft this shape, then let the user accept, edit, or replace it:

   ```text
   <SUBJECT - single line>

   <component-type tally body>
   ```

4. Validate the final message: non-empty after trim; subject line length at most 250 characters.
5. If `--workItemId <number>` was supplied, pass it to `commit-to-git.js`; do not manually append the footer. The helper handles validation and idempotency.
6. For generated/interactively edited messages, write a transient UTF-8 commit-message file under the inner-loop artifact directory and pass it as `--commitMessageFile`. Delete it after the helper returns when possible.

**Output:** A validated commit message source: either `<commitMessageFile>` or a simple inline `<commitMessage>`.

## Step 5 — Final consent and execute `CommitToGit`

**Goal:** Obtain immediate pre-mutation consent, then call the kept lib helper.

<!-- gate: git-sync:changes.consent | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · git-sync:changes.consent):** Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Final consent — call `CommitToGit` on `{envHost}` for solution `{solutionUniqueName}` with message `{commitSubject}` now? | Final consent | Commit now, Cancel |
>
> Cancellation leaves no Dataverse commit.

On **Commit now**, call the helper at `${CLAUDE_PLUGIN_ROOT}/scripts/lib/commit-to-git.js`. Foreground mode should let the reference own the explicit post-commit poll in Step 6, so use `--skipPoll` unless the dispatcher intentionally delegates polling to the helper:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/commit-to-git.js" --envUrl "<envUrl>" --solutionUniqueName "<solutionUniqueName>" --commitMessageFile "<commitMessageFile>" --skipPoll
```

If using a simple single-line message and no file, the helper also accepts:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/commit-to-git.js" --envUrl "<envUrl>" --solutionUniqueName "<solutionUniqueName>" --commitMessage "<commitMessage>" --skipPoll
```

Background mode uses the same helper with `--background` and must include `--projectRoot` so the ticket lands under the intended inner-loop directory:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/commit-to-git.js" --envUrl "<envUrl>" --solutionUniqueName "<solutionUniqueName>" --commitMessageFile "<commitMessageFile>" --projectRoot "<projectRoot>" --background
```

Append `--workItemId "<workItemId>"` to the helper command only when the user supplied a work item ID. Expected success shape includes `committed: true`, `commitId`, `type`, `solutionUniqueName`, optional `solutionAutoResolved`, and `calledAt`. The platform requires `SolutionUniqueName` in the request body for both solution-bound and environment-bound contexts; if multiple env-bound solutions have pending Changes, the dispatcher must select one before entering this reference.

**Output:** `commitId` captured for verification and marker writing, or background ticket created.

## Step 6 — Poll pending Changes to zero

**Goal:** Wait until the Changes tab clears for the committed solution.

1. Skip this step in `--background` mode. The helper writes `pending-commit-ticket.json`, spawns the detached poller, and returns immediately. The child writes `last-commit.json` when pending Changes reach zero or the poll times out.
2. Compute an adaptive poll budget from `pendingChangesCount`: floor approximately 2 minutes, scale upward for large commits, and cap at approximately 30 minutes.
3. Use `${CLAUDE_PLUGIN_ROOT}/scripts/lib/poll-pending-changes.js` as the read-side poll helper and require `finalCount === 0` for success:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/poll-pending-changes.js" --envUrl "<envUrl>" --solutionUniqueName "<solutionUniqueName>" --interval 3000 --stable-reads 2 --max-ms "<pollBudgetMs>"
   ```

4. Treat `stable: true` with `finalCount: 0` as cleared. If the helper reports `finalCount > 0`, `stable: false`, `timedOut: true`, or an error, surface a non-fatal `pollWarning` and continue to Step 7. The commit SHA is the authoritative success signal.
5. While waiting, report progress as:

   ```text
   Waiting for Changes to clear... count: <remaining> remaining
   ```

6. **C-14 third-party-writer detection:** if the poll did not clear and you will surface a warning, inspect the latest three ADO commits:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ado-list-commits.js" --organization "<organization>" --project "<project>" --repository "<repository>" --branch "<branch>" --top 3 --token "<adoToken>"
   ```

   Classify a commit as platform-authored when `author.name === "PowerPortals Runtime"`. That exact name is the durable signal for Dataverse Git integration. If any top-three commit is clearly not platform-authored, append this context to the poll warning:

   ```text
   Detected a concurrent writer on <branch>: commit <shortSha> by <author> landed during the wait. This can keep the pending Changes count from clearing promptly.
   ```

   Bias toward under-warning. If author fields are missing or ambiguous, suppress the third-party-writer note. ADO lookup failures do not block the flow.

**Output:** Pending Changes are cleared, or a non-fatal poll warning is captured.

## Step 7 — Verify `CommitId` in ADO

**Goal:** Confirm the SHA returned by Dataverse exists in the target Azure DevOps repository.

1. Use direct SHA lookup (C-2). Do not replace this with a top-N commit scan.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ado-get-commit.js" --organization "<organization>" --project "<project>" --repository "<repository>" --commitId "<commitId>" --token "<adoToken>"
   ```

2. On `found === true`, capture `url`/`remoteUrl`, author metadata, and the full SHA for the summary and marker.
3. On `statusCode === 404`, wait 3 seconds and retry once. If still missing, surface a non-fatal note that ADO may not have replicated the SHA yet; continue to marker writing with `adoVerified: false`.
4. On other ADO failures, surface the helper error and continue with `adoVerified: false`. Do not retry indefinitely.
5. When presenting ADO history, remind the user that prior bind/init bookkeeping commits such as `Creating new project folder solutions/<folder>` or `Added README.md` are not extra commits from this run.

**Output:** ADO verification result captured.

## Step 8 — Write marker, manifest update, metric, and per-run trace

**Goal:** Persist the run so validators, the dispatcher, and future inner-loop checks have a machine-readable record.

1. Resolve the marker path through `${CLAUDE_PLUGIN_ROOT}/scripts/lib/inner-loop-paths.js` with key `lastCommit`; do not inline the path in code. Write `last-commit.json` with the validation report embedded:

   ```json
   {
     "skill": "git-sync",
     "mode": "commit",
     "committedAt": "<ISO>",
     "envUrl": "<envUrl>",
     "solutionUniqueName": "<solutionUniqueName>",
     "commitId": "<sha>",
     "commitMessage": "<message>",
     "branch": "<branch>",
     "organization": "<organization>",
     "project": "<project>",
     "repository": "<repository>",
     "componentsCommitted": 123,
     "poll": {
       "cleared": true,
       "warning": null
     },
     "ado": {
       "verified": true,
       "url": "<adoCommitUrl>"
     },
     "warnings": [],
     "validation": {
       "status": "passed",
       "blockerCount": 0,
       "warningCount": 0,
       "infoCount": 0,
       "blockers": [],
       "warnings": [],
       "infos": [],
       "validatorTimings": {},
       "componentsByType": {},
       "elapsedMs": 0
     },
     "status": "succeeded"
   }
   ```

   Replace the example `123` with `pendingChangesCount`. Keep `status: "succeeded"` only when `CommitToGit` returned a `commitId`; poll or ADO verification warnings should be represented in `poll` / `ado`, not by dropping the marker.
2. Update `.git-integration-manifest.json` field `lastCommitSha` with `<commitId>` when the manifest exists and parses cleanly. Preserve all other fields.
3. Append a real-commit metric through `${CLAUDE_PLUGIN_ROOT}/scripts/lib/append-skill-metric.js` with `skill: "CommitToGit"`, mode `real-commit`, status, commit ID, duration, poll attempts/samples when available, components committed, branch, blocker count, and warning count.
4. Write a per-run trace through `${CLAUDE_PLUGIN_ROOT}/scripts/lib/write-run-trace.js`. Include structured, pre-redacted fields only: `skill: "git-sync"`, `mode: "commit"`, phase timings, gate decisions, helper names and exit codes, mutation result, final counts, `commitId`, ADO verification status, poll warning, final status, and marker version. Never include raw helper stdout, Dataverse tokens, ADO tokens, or commit-message secrets.
5. In `--background` mode, the foreground output is the ticket from `commit-to-git.js`: `pending-commit-ticket.json` at `innerLoopPath(projectRoot, 'pendingCommitTicket')`. The detached child writes `last-commit.json` with `status: "succeeded"` or `status: "poll-timeout"` and deletes the ticket when done. The dispatcher or CI caller should check the marker after the ticket disappears.

**Output:** `last-commit.json` and the per-run trace are written for foreground success; background writes a ticket immediately and marker later.

## Step 9 — Hand back to the dispatcher

**Goal:** Let `git-sync` finish the outer cycle.

1. Re-detect the three counts if the dispatcher needs post-commit routing for Mixed/Both.
2. Return `commitId`, `shortSha`, ADO verification URL if available, poll warning if any, and marker path to the dispatcher.
3. Do not offer PR creation or tags here. The dispatcher's final gate handles open-pr and optional tag follow-ups after this reference completes.

**Output:** Commit flow is complete and control returns to `git-sync`.

## Mode contracts

| Mode | Steps run | Mutates Dataverse? | Required artifacts / stdout |
|---|---|---|---|
| Default real commit | 1–9 | Yes, at Step 5 after consent | `last-commit.json` via `lastCommit`, per-run trace, `skill-metrics.jsonl`, embedded validation report |
| `--dry-run` | 1–2 only | No | `last-validation.json` via `lastValidation`, `pre-commit-report.html`, dry-run metric |
| `--dry-run --json` | 1–2 only | No | Same as `--dry-run`, plus the validator JSON envelope on stdout for CI |
| `--background` | 1–5 foreground, Step 6 in detached child | Yes, at Step 5 after consent | `pending-commit-ticket.json` immediately, then `last-commit.json` from the child when polling finishes |

The `last-validation.json` dry-run contract is a CI and orchestration surface. Keep it under `docs/inner-loop/`, keep the `lastValidation` key, normalize statuses to `dry-run-passed` / `dry-run-warnings` / `dry-run-blocked`, and do not delete or replace it with a different marker name.

## Error handling

| Condition | Handling |
|---|---|
| `list-pending-changes.js` returns `truncated: true` | Re-run with higher `--max-items`; if still truncated, stop before validation and report that a partial snapshot would create false negatives. |
| Pre-flight blockers | Do not commit. Use the blockers gate and exit after showing remediation. |
| All blockers are blocked attachments | Offer the auto-fix gate in real-commit mode only; re-run all validators after the fix. |
| `CommitToGit` returns `0x80040216` shared-components error | Pre-flight should catch this. Surface the shared-component remediation from `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-error-catalog.md`; do not retry blindly. |
| `CommitToGit` returns orphan-row or action=3 conflict errors | Pre-flight should catch these. Surface the validator finding and stop. |
| `CommitToGit` returns no-changes | Treat as a race: state changed between listing and consent. Hand back to dispatcher for re-detection. |
| `CommitToGit` returns file-size error | Surface the offending component; user must split/delete/remediate and re-run. |
| `CommitToGit` returns 401/403 | ADO authorization or Dataverse auth failed. Surface the helper error and the relevant inner-loop error-catalog remediation. |
| `CommitToGit` returns 5xx | Retry once. If the second attempt fails, stop and surface the error. |
| Poll timeout but ADO direct SHA lookup succeeds | Mark commit succeeded with a poll warning. The platform may still be refreshing the Changes tab. |
| Direct SHA lookup fails after retry | Write marker with `ado.verified: false`, include the warning, and suggest checking the maker-portal Source Control panel or ADO later. |

## Artifacts written

| Artifact | Inner-loop key / helper | Mode | Purpose |
|---|---|---|---|
| `last-commit.json` | `innerLoopPath(<projectRoot>, 'lastCommit')` | real commit / background child | Machine-readable commit marker for validators, dispatcher, and inner-loop plan refresh. |
| `last-validation.json` | `innerLoopPath(<projectRoot>, 'lastValidation')` | dry-run and validator orchestrator | Machine-readable pre-flight report; CI contract. |
| `pre-commit-report.html` | `innerLoopPath(<projectRoot>, 'preCommitReportHtml')` | dry-run and real commit pre-flight | Human-readable validator report. |
| `pending-changes-snapshot.json` | `innerLoopPath(<projectRoot>, 'pendingChangesSnapshot')` | all modes | Complete paginated Changes snapshot consumed by validators and plan rendering. |
| `skill-metrics.jsonl` | `innerLoopPath(<projectRoot>, 'skillMetricsJsonl')` | dry-run and real commit | Append-only run metrics via `append-skill-metric.js`. |
| `pending-commit-ticket.json` | `innerLoopPath(<projectRoot>, 'pendingCommitTicket')` | `--background` only | Foreground ticket for detached poller. |
| Per-run trace | `${CLAUDE_PLUGIN_ROOT}/scripts/lib/write-run-trace.js` | real commit / background as available | Append-only structured trace of gates, helper calls, mutation, verification, and final state. |
| `docs/inner-loop/.git-integration-manifest.json` | local-only manifest under auto-gitignored `docs/inner-loop/` | real commit | Update `lastCommitSha` after a successful commit ID is returned. |

## Gate IDs used

- `git-sync:changes.auto-fix-blocked-attachments`
- `git-sync:changes.pre-flight-blockers`
- `git-sync:changes.pre-flight-warnings`
- `git-sync:changes.plan`
- `git-sync:changes.consent`
