# Git Pull Error Catalog

Known failure patterns when pulling Git changes via `pac pages git pull`. Used by the `git-pull` skill to pattern-match errors and surface actionable remediation.

---

## Pattern 1: `{n} conflicts detected` (CLI guard)

**Error pattern** (PAC CLI stdout, exit 0):
```
3 conflicts detected
WARNING: Pull aborted because conflicts exist
```

**Root cause**: `pac pages git pull` was invoked without `--autoResolve`, but the refresh step found components in conflict state (`action eq 3`). The CLI deliberately stops so the caller can choose a strategy.

**Severity**: Info (CLI is doing the right thing).

**Auto-recovery**: Yes — re-run with `--autoResolve` if user accepts Git version.

**Fix procedure**:
1. Re-run Phase 3 of the skill (conflict resolution prompt).
2. If user picks "Accept Git version", invoke `pac pages git pull --autoResolve --solutionName <name> --environment <url>`.
3. If user picks "Keep local version", recommend they manually resolve the conflicts in the Studio Source Control tab first, then retry.

---

## Pattern 2: Component still in conflict (`SourceControlComponentInConflictError`)

**Error pattern**:
```
SourceControlComponentInConflictError
Component <name> is in conflict state and requires manual resolution
```

**Root cause**: Even with `--autoResolve`, some component types (e.g. business process flows, certain plugin metadata) require manual conflict resolution in the Studio. The server refuses to auto-pick a winner.

**Severity**: Error.

**Auto-recovery**: No — needs Studio intervention.

**Fix procedure**:
1. Tell the user: "Component `{name}` cannot be auto-resolved. Open the Studio Source Control tab, navigate to Conflicts, and pick a winner manually. Then re-run `/git-pull`."
2. List the offending component name(s) from the error response.

---

## Pattern 3: Hash mismatch during sync (`SolutionComponentsProcessingHashFailure`)

**Error pattern**:
```
SolutionComponentsProcessingHashFailure
Git hash mismatch during sync
The component hash does not match the expected value
```

**Root cause**: The component's git hash and last-sync hash diverged in an unexpected way — usually because someone pushed to the same branch from a different environment between our refresh and our pull.

**Severity**: Error.

**Auto-recovery**: Yes — refresh and retry.

**Fix procedure**:
1. Run `pac pages git status` to refresh state.
2. Re-run the helper script to see if `availableCount` changed.
3. Retry `pac pages git pull` once more. If it still fails, recommend the user wait 60 seconds and try again.

---

## Pattern 4: Source Control not enabled on the env

**Error pattern**: same as `git-commit` pattern 3.

**Root cause / fix**: see `${CLAUDE_PLUGIN_ROOT}/skills/git-commit/references/error-catalog.md` Pattern 3.

---

## Pattern 5: Source Control processing in progress

**Error pattern**: same as `git-connect` pattern 6.

**Root cause / fix**: see `${CLAUDE_PLUGIN_ROOT}/skills/git-connect/references/error-catalog.md` Pattern 6.

---

## Pattern 6: Auth token expired (HTTP 401)

**Error pattern**: same as `git-connect` pattern 5.

**Root cause / fix**: see `${CLAUDE_PLUGIN_ROOT}/skills/git-connect/references/error-catalog.md` Pattern 5.
