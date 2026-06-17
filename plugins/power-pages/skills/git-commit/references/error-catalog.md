# Git Commit Error Catalog

Known failure patterns when committing Power Pages changes via `pac pages git commit`. Used by the `git-commit` skill to pattern-match errors and surface actionable remediation.

---

## Pattern 1: Empty source-control components list (`0x80040216` NRE)

**Error pattern**:
```
0x80040216
Object reference not set to an instance of an object
NullReferenceException in SourceControlComponentService
```

**Root cause**: `CommitToGit` server code dereferences `sourceControlComponents` without checking it has any rows. When tracking sees zero pending Push components (typically the very first commit on a fresh BYOC site, before any change is staged), the action fails with an unhelpful NRE rather than a friendly "nothing to commit" message. Validated 2026-04-20 against Arca; see `~/scratch/commit_to_git_test.py` for the repro.

**Severity**: Error (looks scary; actually means "nothing to commit").

**Auto-recovery**: Partial — the skill can show a friendlier message.

**Fix procedure**:
1. Re-run the helper script: `node skills/git-commit/scripts/check-pending-changes.js --envUrl <ENV_URL>`. If `pendingCount` is 0, surface: "Nothing to commit yet — make a change in the Studio (e.g. edit a page or site setting), then re-run `/git-commit`."
2. If `pendingCount` > 0 but `pac pages git commit` still throws this error, it's a real server bug — capture the response body and file an ICM under the Power Pages SCI team.

---

## Pattern 2: Solution components still processing

**Error pattern**:
```
items requested do not exist
Please wait... Solution components are being processed
SolutionComponentsProcessingHashFailure
```

**Root cause**: The initial git sync (kicked off by `/git-connect`) has not finished yet. Component tracking rows are mid-flight; CommitToGit can't pick them up.

**Severity**: Warning (transient).

**Auto-recovery**: Yes — wait and retry.

**Fix procedure**:
1. Tell the user: "Initial git sync isn't done yet. Components are still being indexed. Waiting 60 seconds, then retrying."
2. Sleep 60 seconds.
3. Retry once. If still failing, recommend rerunning `/git-commit` in 5 minutes.

---

## Pattern 3: Source Control not enabled on the env

**Error pattern**:
```
Source Control not enabled
Solution is not connected to git
```

**Root cause**: The Git connection was disconnected (manually or by a failed earlier op) or Managed Environments was disabled.

**Severity**: Error.

**Auto-recovery**: No — must reconnect.

**Fix procedure**:
1. Tell the user: "This solution is no longer connected to Git. Run `/git-connect` to set it up again, then retry `/git-commit`."
2. Optional: run `pac pages git status` for a clean confirmation.

---

## Pattern 4: Conflict on push (`SourceControlComponentResolveConflictError`)

**Error pattern**:
```
SourceControlComponentResolveConflictError
Component is in conflict state
A push was attempted with unresolved conflicts
```

**Root cause**: There are unresolved conflicts (`action eq 3` rows) — the user has local changes AND there are incoming changes from Git that touch the same components. CommitToGit refuses until the conflict is resolved.

**Severity**: Error.

**Auto-recovery**: No — needs user decision.

**Fix procedure**:
1. Tell the user: "Conflicts exist between your local changes and what's in Git. Run `/git-pull` to resolve incoming first (you can choose to accept Git's version or keep yours), then retry `/git-commit`."
2. Optionally show the conflicting components from the helper script.

---

## Pattern 5: Auth token expired (HTTP 401)

**Error pattern**: same as `git-connect` pattern 5.

**Root cause / fix**: see `${CLAUDE_PLUGIN_ROOT}/skills/git-connect/references/error-catalog.md` Pattern 5.

---

## Pattern 6: Source Control processing in progress

**Error pattern**: same as `git-connect` pattern 6.

**Root cause / fix**: see `${CLAUDE_PLUGIN_ROOT}/skills/git-connect/references/error-catalog.md` Pattern 6.
