# Update Reference — Pull / Sync Flow

Follow this reference when the `git-sync` dispatcher routes a Stale state (Updates > 0) or the pull half of Mixed/Both.

## Scope and invariants

- This is the pull-side flow only: ADO branch → Dataverse environment.
- The dispatcher owns state classification, binding discovery, and conflict routing. This reference assumes the dispatcher has already identified `<envUrl>`, `<solutionUniqueName>`, `<organization>`, `<project>`, `<repository>`, `<branch>`, `<envHost>`, `<projectRoot>`, and the user's arguments.
- Use deterministic helpers under `${CLAUDE_PLUGIN_ROOT}/scripts/lib/`. Do not inline Dataverse or ADO REST calls when a helper exists.
- `RefreshChangesFromGit` is read-only and must run before any incoming preview, conflict check, or pull.
- Conflicts must be cleared before pull. This reference does not duplicate the conflict gate; it returns control to the dispatcher when conflicts are present.
- The user-facing `--hard-delete` request maps to the helper's `DeleteDeletedComponents` behavior. Only pass the low-level deletion flag after the hard-delete consent gate approves it.
- The plan gate and final consent gate always fire before `PullChangesFromGit`.

## Step 1 — Refresh incoming state

**Goal:** Fetch the bound ADO branch tip and populate the maker-portal Updates and Conflicts tabs without mutating the environment.

1. Call `RefreshChangesFromGit` through the helper:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/refresh-changes-from-git.js" --envUrl "<envUrl>" --solutionUniqueName "<solutionUniqueName>" --waitForPopulation 10
   ```

   The underlying OData action returns `204 No Content`; no response body is success. This read-only step is what makes the incoming preview possible.

2. Query the refreshed tabs:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-incoming-updates.js" --envUrl "<envUrl>" --solutionUniqueName "<solutionUniqueName>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-conflicts.js" --envUrl "<envUrl>" --solutionUniqueName "<solutionUniqueName>"
   ```

3. Preserve the refreshed `updates` list for the plan and hard-delete scan.

## Step 2 — Conflict check

**Goal:** Stop before pull if the refresh surfaced conflicts.

1. If `conflicts.count > 0`, stop this reference and return control to the `git-sync` dispatcher. The dispatcher must route to the conflict flow first.
2. After conflicts are cleared, the dispatcher should re-enter this reference from Step 1 so the Updates preview is fresh.
3. If `conflicts.count === 0` and `updates.count === 0`, there is nothing to pull. Write `last-sync.json` with `status: "already-up-to-date"` and skip to Step 7 trace/summary handling.

## Step 3 — Render the sync plan

**Goal:** Show exactly what will be pulled before any mutation.

Render a concise plan from `list-incoming-updates.js` output:

```text
Sync plan
  Environment:  <envHost>
  Solution:     <solutionUniqueName>
  Branch:       <branch>
  Incoming:     <updatesCount> update(s)
    • <objectType>: <displayName> (<changeType>)
    • ...
  Conflicts:    0
  Hard-delete:  requested | disabled
```

Call out deletion-like rows (`delete`, `remove`, or "Remove or delete") separately because they determine whether the hard-delete gate is relevant.

<!-- gate: git-sync:update.plan | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · git-sync:update.plan):** Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Will pull `{updatesCount}` update(s) from `{branch}` into `{envHost}` for solution `{solutionUniqueName}`. Continue? | Sync plan | Yes — proceed to consent (Recommended), Cancel |
>
> Cancellation leaves nothing mutated; only the read-only refresh and preview have run.

## Step 4 — Hard-delete gate

**Goal:** Protect the destructive `DeleteDeletedComponents` path.

1. Compute `deletionCount` from the incoming Updates list.
2. If `deletionCount === 0`, keep hard-delete disabled; do not pass any deletion flag.
3. If the user did not request `--hard-delete`, keep hard-delete disabled. This is the safe default and is equivalent to the maker-portal **Remove from solution** path.
4. If `deletionCount > 0` and the user requested `--hard-delete`, fire the gate below. The default answer is **No**.

<!-- gate: git-sync:update.hard-delete | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · git-sync:update.hard-delete):** Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | `{deletionCount}` incoming deletion(s) detected and `--hard-delete` was requested. `DeleteDeletedComponents: true` is the Dataverse API equivalent of the maker portal's **Delete from environment** button. It can permanently delete Dataverse components; if any deletion touches OOTB components such as CreatedOn, OwnerId, statuscode, OOTB saved queries, or ribbon diffs, recovery may require re-provisioning. Confirm hard-delete? | Destructive action — hard delete | No — pull without hard-delete (Recommended), Yes — permanently delete from environment |
>
> Choosing **No** leaves the pull non-destructive. Choosing **Yes** is the only path that enables `DeleteDeletedComponents`.

See `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §18. Almost every revert or cleanup scenario should choose the safe default: pull without hard-delete.

## Step 5 — Final consent and execute

**Goal:** Get immediate pre-mutation consent, then call `PullChangesFromGit`.

<!-- gate: git-sync:update.consent | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · git-sync:update.consent):** Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Final consent — call `PullChangesFromGit` on `{envHost}` now? | Final consent | Pull now, Cancel |
>
> Cancellation leaves the environment unchanged.

On **Pull now**, execute:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/pull-changes-from-git.js" --envUrl "<envUrl>" --solutionUniqueName "<solutionUniqueName>"
```

If and only if Step 4 approved hard-delete, append the helper flag:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/pull-changes-from-git.js" --envUrl "<envUrl>" --solutionUniqueName "<solutionUniqueName>" --deleteDeletedComponents
```

The helper calls `PullChangesFromGit` with `AdditionalParameters.DeleteDeletedComponents = true` only for the second form. The underlying OData action returns `204 No Content`; large pulls can take 30 seconds to 3 minutes.

## Step 6 — Poll Updates to zero

**Goal:** Wait for Dataverse to finish applying incoming updates.

1. Prefer the polling result returned by `pull-changes-from-git.js` when present.
2. Regardless of helper polling, run a final Updates read:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-incoming-updates.js" --envUrl "<envUrl>" --solutionUniqueName "<solutionUniqueName>"
   ```

3. If Updates remain, poll every 5 seconds up to 36 attempts, until `count === 0`. Report progress as:

   ```text
   Waiting for Updates to apply... attempt <n>/36 (count: <remaining> remaining)
   ```

4. A timeout is a warning, not proof that the platform failed. The pull may still be processing; surface the residual Updates list and continue to verification with a non-success status if parity does not verify.

## Step 7 — Verify parity, write marker, and write trace

**Goal:** Prove the environment's inbound pointer matches the ADO branch head, then persist the run record.

1. Re-read the binding:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/detect-git-binding.js" --envUrl "<envUrl>" --solutionUniqueName "<solutionUniqueName>"
   ```

2. Get an ADO token without printing it:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/get-ado-token.js" --writeToFile "docs/inner-loop/.ado-token"
   ```

3. Read the ADO branch head:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ado-list-commits.js" --organization "<organization>" --project "<project>" --repository "<repository>" --branch "<branch>" --top 1 --tokenFile "docs/inner-loop/.ado-token"
   ```

4. Verify `binding.branchSyncedCommitId == commits[0].commitId` case-insensitively. A successful pull must also have `updates.count === 0`.
5. Resolve the marker path through `${CLAUDE_PLUGIN_ROOT}/scripts/lib/inner-loop-paths.js` with key `lastSync`; do not inline the path in code. Write `last-sync.json`:

   ```json
   {
     "skill": "git-sync",
     "mode": "pull",
     "syncedAt": "<ISO>",
     "envUrl": "<envUrl>",
     "solutionUniqueName": "<solutionUniqueName>",
     "branch": "<branch>",
     "organization": "<organization>",
     "project": "<project>",
     "repository": "<repository>",
     "updatesApplied": 0,
     "hardDeleteEnabled": false,
     "conflictsFound": 0,
     "branchSyncedCommitId": "<sha>",
     "adoHeadCommitId": "<sha>",
     "parityVerified": true,
     "status": "succeeded"
   }
   ```

   Use `status: "already-up-to-date"` for the Step 2 no-op path. Use `status: "failed"` if Updates remain, the ADO head cannot be read, or parity does not verify; include a concise `failureReason`.

6. Write a per-run trace through `${CLAUDE_PLUGIN_ROOT}/scripts/lib/write-run-trace.js`. Include structured, pre-redacted fields only: `skill: "git-sync"`, `mode: "pull"`, phase timings, gate decisions, helper names and exit codes, mutation result, final counts, `branchSyncedCommitId`, `adoHeadCommitId`, `status`, and marker version. Never include raw helper stdout, Dataverse tokens, or ADO tokens.

## Error handling

- `RefreshChangesFromGit` returns 4xx: the bound ADO branch may be unreachable, deleted, or unauthorized. Surface the helper error verbatim and exit without mutation.
- Conflicts appear after refresh: return to the dispatcher; conflicts must clear before pull.
- `PullChangesFromGit` returns 400/409 with conflict text: state drifted between plan and execution. Re-run from Step 1 and let the dispatcher classify the new state.
- Poll timeout with remaining Updates: surface the residual list and mark verification failed unless a later parity check succeeds.
- Hard-delete was approved but deletions remain: the platform may have rejected one or more deletes because of dependencies. Surface the residual deletion rows and recommend manual reconciliation.

## Artifacts

| Artifact | Path helper | Purpose |
|---|---|---|
| `last-sync.json` | `innerLoopPath(<projectRoot>, "lastSync")` | Machine-readable pull marker for `git-sync` and inner-loop plan refresh. |
| Per-run trace | `write-run-trace.js` | Append-only structured trace of gates, helper calls, mutation, and verification. |

## Gate IDs used

- `git-sync:update.plan`
- `git-sync:update.hard-delete`
- `git-sync:update.consent`
