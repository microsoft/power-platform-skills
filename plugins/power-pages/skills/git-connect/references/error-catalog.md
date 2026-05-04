# Git Connect Error Catalog

Known failure patterns when connecting a Power Pages environment to Git via `pac pages git connect`. Used by the `git-connect` skill to pattern-match errors and surface actionable remediation.

Each entry: error pattern, root cause, severity, whether the skill can auto-recover, and the fix procedure.

---

## Pattern 1: `pac pages git` sub-noun not found

**Error pattern** (PAC CLI stdout/stderr):
```
Unknown command 'git'
Available commands: ...
'pac pages git' is not a recognized command.
```

**Root cause**: PAC CLI build does not have the `verbPAPortalGit` feature flag enabled, or the user is on a PAC CLI version that predates the sub-noun.

**Severity**: Error (blocks the skill).

**Auto-recovery**: No — the user must update PAC CLI or use a build with the flag.

**Fix procedure**:
1. Tell the user: "Update PAC CLI to a version that ships the `pac pages git` sub-noun. Until the sub-noun is in stable PAC CLI, use a build of PAC CLI with the `verbPAPortalGit` feature flag enabled."
2. Pointer to the prerequisite note in `plugins/power-pages/README.md`.
3. Stop the skill cleanly.

---

## Pattern 2: Managed Environments not enabled

**Error pattern** (PAC CLI stderr):
```
Managed Environments not enabled
Source Control not enabled
HTTP 400 with body containing "managed environment"
```

**Root cause**: Native Git integration requires Managed Environments to be enabled on the target environment. Without it, `ConnectToGit` fails with HTTP 400.

**Severity**: Error.

**Auto-recovery**: No — Managed Environments must be enabled by an admin via the Power Platform Admin Center.

**Fix procedure**:
1. Tell the user: "Native Git requires Managed Environments. Open Power Platform Admin Center → Environments → select your environment → Settings → Managed Environments → Enable."
2. Once enabled, retry `/git-connect`.

---

## Pattern 3: Invalid ADO folder location (`CommitInvalidAdoLocation`)

**Error pattern**:
```
CommitInvalidAdoLocation
Invalid Azure DevOps repository location
The folder path is invalid for the configured repository
```

**Root cause**: The combination of organization / project / repository / branch / folder doesn't resolve to a valid location in ADO. Typical causes: the ADO repo doesn't have the named branch; the user typed `/MyFolder` but the repo only has `MyFolder/` at root; the user lacks ADO project read permissions.

**Severity**: Error.

**Auto-recovery**: No — the user must correct the connect parameters.

**Fix procedure**:
1. Re-list `gitorganizations` / `gitprojects` / `gitrepositories` / `gitbranches` and walk the user back through the picker (Phase 3 of the skill).
2. If the folder path looks suspicious (leading slash, embedded spaces), confirm the exact path in the ADO repo.
3. Retry `pac pages git connect` after correction.

---

## Pattern 4: Insufficient permissions (HTTP 403)

**Error pattern**:
```
HTTP 403
Privilege not found
The user does not have permission
```

**Root cause**: The signed-in user is not a System Administrator on the target environment, or lacks ADO project read access.

**Severity**: Error.

**Auto-recovery**: No.

**Fix procedure**:
1. Tell the user: "Connecting Git requires System Administrator on the Power Pages environment, plus at least Read access on the target ADO project."
2. Suggest contacting the env admin or ADO project owner.
3. Once granted, retry `/git-connect`.

---

## Pattern 5: Auth token expired (HTTP 401)

**Error pattern**:
```
HTTP 401
Unauthorized
The access token has expired
```

**Root cause**: Azure CLI access token is older than its lifetime, or the user's PAC CLI auth profile has expired.

**Severity**: Error.

**Auto-recovery**: Yes — re-auth and retry.

**Fix procedure**:
1. Run `az login`.
2. Run `pac auth who` to confirm the active profile is for the right environment.
3. Retry `pac pages git connect`.

---

## Pattern 6: Source Control processing already in progress (`SourceControlProcessingInProgress`)

**Error pattern**:
```
SourceControlProcessingInProgress
A previous source control operation is still running
Please wait... Solution components are being processed
```

**Root cause**: A prior `ConnectToGit` / `CommitToGit` / `PullChangesFromGit` async op is still running for the same solution.

**Severity**: Warning (transient).

**Auto-recovery**: Yes — wait and retry.

**Fix procedure**:
1. Inform the user: "A prior source control op is still finishing. Waiting 60 seconds, then retrying."
2. Sleep 60 seconds.
3. Retry once. If it fails again, tell the user to wait several minutes (initial syncs can take 5+ minutes for large solutions) and rerun `/git-connect` later.
