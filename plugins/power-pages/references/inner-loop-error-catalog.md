# Inner-Loop Error Catalog

Known failure patterns for Dataverse Git integration (Connect-to-Git). Used by the `diagnose-git-integration` skill to pattern-match symptoms against root causes and propose auto-fixes.

Each pattern includes: detection signal, root cause, severity, whether an auto-fix is available, and the fix procedure.

> **Naming convention.** Patterns are numbered `IL-001`, `IL-002`, … (inner-loop). They live alongside (not inside) `deployment-error-catalog.md`'s deployment patterns (`Pattern 1`, `Pattern 2`, …).

---

## Pattern IL-001: Managed Environments disabled

**Detection signal:**

- `RetrieveCurrentOrganization` returns the env, but the Solutions page in the maker portal shows no "Connect to Git" button.
- API call returns: `Source Control Integration is not enabled for this environment.`

**Root cause:** Managed Environments is OFF on the env. Git integration is gated on it.

**Severity:** Error (hard-stop)

**Auto-fix available:** No (admin-only operation in Power Platform Admin Center)

**Fix procedure:**

1. Surface URL: `https://admin.powerplatform.microsoft.com/environments/{envId}/manage`
2. Tell the user: *"Enable Managed Environments → re-run the skill."*
3. Cite `git-integration-prerequisites.md` §1.

---

## Pattern IL-002: BYOK-encrypted environment

**Detection signal:**

- API returns: `Source Control Integration is not enabled for this environment.` AND
- `organization` row has a non-null `customerencryptionkey...` column (legacy BYOK scheme).

**Root cause:** Env is using the deprecated BYOK encryption scheme that's incompatible with Git integration.

**Severity:** Error (hard-stop)

**Auto-fix available:** No

**Fix procedure:** Document for the user that BYOK envs cannot connect to Git, and suggest migrating to Microsoft-managed encryption keys (out-of-scope migration; admin only).

---

## Pattern IL-003: ADO repo not initialized

**Detection signal:**

- `ConnectToGit` returns: `Failed to retrieve default branch` (often ~30 minutes into the call as the platform retries).
- `verify-repo-initialized.js` returns `{ initialized: false, defaultBranch: null }`.

**Root cause:** The ADO repo exists but has no commits yet, so it has no default branch.

**Severity:** Error (hard-stop)

**Auto-fix available:** Yes

**Fix procedure:**

1. Detect with `verify-repo-initialized.js` **before** calling `ConnectToGit`.
2. **Ask explicit user permission:** *"The ADO repo `{org}/{project}/{repo}` is empty. Initialize it now with a single README commit on `{branch}` so `ConnectToGit` can bind cleanly?"* (consent gate, two options: Initialize now / Cancel.)
3. If approved: invoke `scripts/lib/init-ado-repo.js --organization <o> --project <p> --repository <r> --branch <b> --token <adoToken>`. The helper GETs the repo metadata first and returns `alreadyInitialized:true` (no-op) when `defaultBranch` is already set — safe to retry. Otherwise it POSTs to `/_apis/git/repositories/{repoId}/pushes?api-version=7.1` with `oldObjectId` set to 40 zeros (ADO empty-repo marker) and a default README body. On 403 it surfaces an actionable "your account lacks Contribute" hint; on 404 it surfaces a "repository not found" hint.
4. The helper is idempotent — no explicit re-verification step is needed. Continue to Phase 3 of `setup-git-integration`.

---

## Pattern IL-004: Caller lacks System Administrator role

**Detection signal:**

- `ConnectToGit` / `DisconnectFromGit` returns HTTP 403 with: `User does not have permission to manage source control integration.`

**Root cause:** Caller is not a System Administrator in the dev env.

**Severity:** Error

**Auto-fix available:** No (cannot self-elevate)

**Fix procedure:** Surface env admin URL; tell the user to ask their env admin to grant System Administrator role. Continue with the manual UI workflow as fallback documentation.

---

## Pattern IL-005: ADO permission missing

**Detection signal:**

- `CommitToGit` returns: `Permission denied while pushing to repository.`
- ADO repo permission check returns `Contribute = false` for the calling identity.

**Root cause:** The Dataverse → ADO connection's identity (or, when applicable, the user's Entra-issued bearer token used for ADO pre-checks) lacks Contribute on the repo. Note: `setup-git-integration` no longer collects a PAT — it acquires an Entra OAuth token via `get-ado-token.js`. A 403 from any ADO REST call (including `init-ado-repo.js`'s push) means the calling identity does not hold Contribute, regardless of which auth shape (PAT or Bearer JWT) was used.

**Severity:** Error

**Auto-fix available:** No (ADO admin only — only the project admin can grant Contributors group write access)

**Fix procedure:** Surface ADO repo permission URL: `https://dev.azure.com/{org}/{project}/_settings/repositories?_a=permissions&repo={repoId}`. Tell the user (or the project admin) to add the calling identity to the Contributors security group on the target repo, then re-run the skill. `init-ado-repo.js` surfaces this exact remediation in its `hint` field on 403.

---

## Pattern IL-006: File > 17 MB cap

**Detection signal:**

- `CommitToGit` fails mid-commit: `One or more files exceed the maximum size limit of 17 MB after base64 encoding.`
- `validate-file-sizes.js` reports one or more files > 17 MB encoded.

**Root cause:** ADO enforces a 17 MB per-file commit cap (base64-encoded). Large Canvas apps, PCF bundles, plug-in assemblies, big media files trip it.

**Severity:** Error (hard-stop — commit cannot proceed)

**Auto-fix available:** Partial (we can identify the file; can't shrink it for the user)

**Fix procedure:**

1. Run `validate-file-sizes.js` as a pre-flight in the `commit-to-git --dry-run` mode.
2. For each over-size file, surface: *"`{filename}` is {sizeMB} MB after base64 encoding (cap is 17 MB). Options: (a) move it to web files outside the solution; (b) split the component (Canvas app → smaller libraries; PCF bundle → split); (c) reduce media; (d) remove unused resources."*
3. Block commit until resolved.

---

## Pattern IL-007: Unsupported legacy object type

**Detection signal:**

- Object view in the maker portal shows an error icon next to one or more components.
- `list-pending-changes.js` flags components with `supported: false`.

**Root cause:** Some legacy Dataverse object types are not supported by Git integration (per Microsoft Learn FAQ).

**Severity:** Warning (commit can proceed for other components; flagged ones won't be committed)

**Auto-fix available:** No

**Fix procedure:** Show the user which components are skipped and why. Suggest removing the unsupported components from the solution, or accept that they will not be version-controlled.

---

## Pattern IL-008: Default Solution cannot be Git-bound

**Detection signal:**

- User invokes `setup-git-integration` or `connect-solution-to-git` targeting `Default` or `Common Data Service Default Solution`.
- API rejects with: `Default solutions cannot be connected to Git source control.`

**Root cause:** Platform restriction. Documented in `binding-strategy.md` §5.

**Severity:** Error (hard-stop)

**Auto-fix available:** Partial — we can redirect to `/power-pages:setup-solution`

**Fix procedure:** Surface: *"`{solutionName}` is the default solution; Git integration won't track it. Run `/power-pages:setup-solution` to create a custom solution, move your components into it, then re-run this skill."*

---

## Pattern IL-009: Shared object across differently-bound solutions

**Detection signal:**

- `AddSolutionComponent` (or any add-to-solution call) returns: `Component already exists in a Git-bound solution with a different binding configuration.`

**Root cause:** In solution binding, the same component cannot be in two solutions bound to different repos/branches/folders.

**Severity:** Error (hard-stop on the add)

**Auto-fix available:** No

**Fix procedure:** Cite `binding-strategy.md` §6. Suggest: (a) consolidate the two solutions onto one branch/repo, (b) switch to environment binding, or (c) leave the component in one solution and consume via dependency.

---

## Pattern IL-010: Conflicts > 0 blocks Pull

**Detection signal:**

- `PullChangesFromGit` returns: `Cannot pull changes while conflicts exist. Resolve conflicts first.`
- `list-conflicts.js` reports `conflicts > 0`.

**Root cause:** Platform requires zero conflicts before allowing a pull.

**Severity:** Error (hard-stop on pull)

**Auto-fix available:** Partial — we can dispatch `resolve-conflicts`

**Fix procedure:** `sync-from-git` already handles this by branching to `resolve-conflicts` mid-flow. If `diagnose-git-integration` catches this standalone, dispatch `resolve-conflicts` after user confirms.

---

## Pattern IL-011: Stale binding metadata

**Detection signal:**

- `detect-git-binding.js` returns a binding record, but `RefreshChangesFromGit` returns: `Repository or branch no longer exists` or `Branch was deleted in the upstream repository.`

**Root cause:** The ADO branch was deleted/renamed/permission-revoked after the Connect operation; Dataverse still holds the stale binding pointer.

**Severity:** Error

**Auto-fix available:** Partial — we can offer `DisconnectFromGit` + re-bind

**Fix procedure:**

1. Confirm via `verify-repo-initialized.js --branch <bound branch>` — returns `{ exists: false }`.
2. **Ask explicit user permission:** *"The branch `{branch}` no longer exists in the bound repo. Disconnect this env's stale binding and prompt you to re-bind to a current branch? This does not delete any local components."*
3. If approved: `disconnect-from-git.js` + suggest `setup-git-integration` again.

---

## Pattern IL-012: `pac pages upload-code-site` race with pending changes

**Detection signal:**

- User runs `pac pages upload-code-site` while there are already pending Changes in the bound solution.
- After upload completes, `list-pending-changes.js` reports a mix of the PAC-uploaded web files **and** the user's earlier edits, with no clear separation.

**Root cause:** PAC CLI uploads land directly in the solution's mspp_webfile rows; they become indistinguishable from manual changes in the Source-control tab. The user may be surprised that their "I'll just upload to test it" landed in their pending commit.

**Severity:** Warning (not a failure, but a workflow surprise)

**Auto-fix available:** No (this is a workflow change, not a bug)

**Fix procedure:** Cite `pac-pages-vs-git-integration.md` for the recommended workflow:

1. Commit (or revert) pending Changes **before** running `pac pages upload-code-site`.
2. Or accept that the next commit will bundle both. Use `commit-to-git --dry-run` to see the full list and decide.

---

## Pattern IL-013: Cross-tenant or cross-geo without consent

**Detection signal:**

- `ConnectToGit` returns: `Cross-tenant Git integration is not supported.` (cross-tenant) OR
- The maker portal Connect dialog shows an inline cross-geo consent panel that has not been accepted (cross-geo).

**Root cause:** Microsoft does not support cross-tenant; cross-geo requires explicit consent in the UI flow.

**Severity:** Error (cross-tenant); Warning (cross-geo)

**Auto-fix available:** No

**Fix procedure:**

- **Cross-tenant:** Hard-stop; document that user's ADO org and Dataverse env must align tenants.
- **Cross-geo:** Surface the consent banner URL; tell the user to run the Connect flow once in the UI to accept the consent, then re-run the skill.

---

## Pattern IL-014: SourceControl plugin internal bug — `PullChangesFromGit` fails on solutions containing `powerpagecomponent` records (type 10429)

**Detection signal:**

- `PullChangesFromGit` (or `PullChangesFromGitAsync`, or the Maker Portal "Pull" button) returns HTTP 400 with error code `0x80072033` and message: `The Entity powerpagecomponent is missing primary key powerpagecomponentid.`
- The same env can `PullChangesFromGit` other git-bound solutions successfully (HTTP 204), as long as those solutions contain NO components of `componenttype = 10429`. The failure scopes to solutions whose `solutioncomponents` table contains at least one row with `componenttype = 10429`.
- Both the sync (`PullChangesFromGit`, immediate 400) and async (`PullChangesFromGitAsync`, ~120-180s before 400) variants fail with the same error code and message. The async variant doing pre-work first proves the validator runs after some pull setup, not just at request parse time.
- All of the following INDEPENDENTLY confirm the error message itself is misleading and the entity is structurally fine — use these as ruling-OUT signals:
  - `GET {envUrl}/api/data/v9.2/EntityDefinitions(LogicalName='powerpagecomponent')` returns `PrimaryIdAttribute: "powerpagecomponentid"`, `EntitySetName: "powerpagecomponents"`, `ObjectTypeCode: 10429`. The primary key IS defined.
  - `GET {envUrl}/api/data/v9.2/EntityDefinitions(LogicalName='powerpagecomponent')/Attributes?$filter=IsPrimaryId eq true` returns exactly one attribute named `powerpagecomponentid`.
  - `GET {envUrl}/api/data/v9.2/powerpagecomponents?$top=1` returns 200 with a real record including the `powerpagecomponentid` field. Records are accessible.
  - `PreValidateGitComponents` on the same solution returns HTTP 200 with empty `ValidationMessages` — the platform's own pre-validator sees nothing wrong.
  - `PublishAllXml` returns 204 but the pull still fails after — it's not a stale metadata cache.
- `CommitToGit`, `RefreshChangesFromGit`, `ValidateSourceControlConnection`, `branch-switch`, `commit-to-git --dry-run`, and conflict-detection all work on the same solution. The failure is isolated to the pull mutation.

**Root cause:** A bug in the Dataverse SourceControl plugin's pull-direction handler. When the handler enumerates the solution's components and encounters one of type `10429` (`powerpagecomponent`), an internal metadata-resolver call returns a result that fails the "primary key column is present" assertion, even though the public metadata API contradicts that conclusion. This is platform-internal and not user-fixable at the OData layer. Likely root location is the plugin's compiled-metadata cache or a SQL view (different from the publicly exposed `EntityDefinitions` endpoint) that it reads first. **The previous IL-014 hypothesis — that the entity was misregistered with `IsCustomEntity=true` — is incorrect.** `IsCustomEntity=true` is the normal state for ALL Power Pages entities on tenants installed via the modern provisioning path (verified against `mspp_contentsnippet` which is undeniably Microsoft-managed).

**Severity:** Error (hard-stop on pull for any solution containing `powerpagecomponent` records — which includes essentially every real Power Pages site solution)

**Auto-fix available:** No (the API does not expose a workaround flag; requires either a platform-side patch from Microsoft or one of the ALM workarounds below)

**Fix procedure:**

1. **Confirm the diagnosis** with these three probes — they must all match for IL-014 to apply:
   ```bash
   # a) Does the failing solution contain type-10429 components?
   curl -s -H "Authorization: Bearer <dvToken>" \
     "<envUrl>/api/data/v9.2/solutioncomponents?\$select=objectid&\$filter=_solutionid_value eq <solutionId> and componenttype eq 10429&\$count=true&\$top=1"
   # Expect "@odata.count" > 0

   # b) Is the entity metadata internally consistent?
   curl -s -H "Authorization: Bearer <dvToken>" \
     "<envUrl>/api/data/v9.2/EntityDefinitions(LogicalName='powerpagecomponent')?\$select=PrimaryIdAttribute,EntitySetName,ObjectTypeCode"
   # Expect PrimaryIdAttribute="powerpagecomponentid", EntitySetName="powerpagecomponents", ObjectTypeCode=10429

   # c) Does pull on an empty-componenttype solution succeed?
   curl -s -X POST -H "Authorization: Bearer <dvToken>" -H "Content-Type: application/json" \
     -d '{"SolutionUniqueName":"<otherBoundSolutionWithNoType10429>"}' \
     "<envUrl>/api/data/v9.2/PullChangesFromGit"
   # Expect HTTP 204
   ```
2. **Workarounds (apply ONE):**
   - **Preferred — Use traditional ALM for the pull direction.** From the source env, run `/power-pages:export-solution`. Move the zip to the target env. Run `/power-pages:import-solution`. This entirely sidesteps `PullChangesFromGit`. Git integration's commit direction (`/power-pages:commit-to-git`) still works for snapshotting changes to ADO; only the cross-env pull is replaced.
   - **Use Maker Portal Source Control "Update from Git" per-component.** Some component types succeed under the portal's per-component path. Open `https://make.powerapps.com/environments/{envId}/solutions/{solutionId}/source-control?tab=Updates`, select non-type-10429 components individually, and click Update. Type-10429 rows will still fail one at a time.
   - **Split the solution.** Move type-10429 components into a separate unbound solution (e.g., `<solutionUniqueName>_SitePages`) and leave only non-type-10429 components (forms, views, web roles) in the git-bound `<solutionUniqueName>`. The git-bound half then pulls cleanly. The unbound half must be deployed via export/import.
3. **Permanent fix:** Open a Microsoft Support ticket. Include:
   - Env URL and env ID.
   - The full `0x80072033` error response (both sync and async variants).
   - The metadata snapshots from step 1.
   - A note that `PublishAllXml`, `RefreshChangesFromGit`, and disconnecting+reconnecting to git all do NOT clear the condition.
   - The histogram of failing-solution component types (the count of `componenttype = 10429` rows is the critical signal).
   - Tag the ticket as "Power Platform Pipelines / Git Integration / SourceControl plugin metadata resolver".
4. **Until resolved:** instruct the user to remove `PullChangesFromGit` from their inner-loop workflow on this env for any solution containing `powerpagecomponent` records. The commit-to-git half of the loop (`/power-pages:commit-to-git`, `/power-pages:open-pr`, `/power-pages:branch-switch`) still works — use those to snapshot dev changes to ADO. For pulling changes INTO this env, use `/power-pages:import-solution` with a zip exported from the source env instead.

---

## Pattern IL-015: `ResolveGitConflict` OData action absent on tenant

**Detection signal:**

- `resolve-conflict-keep.js` or `resolve-conflict-accept.js` returns HTTP 404 with: `Resource not found for the segment 'ResolveGitConflict'.`
- `GET {envUrl}/api/data/v9.2/$metadata` (or the cheaper probe `GET {envUrl}/api/data/v9.2/ResolveGitConflict` → 404) confirms the action is not registered.
- The catalogued Git actions on the affected tenant include only: `CommitToGit`, `ConnectToGit`, `DisconnectFromGit`, `ExportSolutionFromGit(Async)`, `PreValidateGitComponents`, `PullChangesFromGit(Async)`, `RefreshChangesFromGit`, `ValidateSourceControlConnection` — `ResolveGitConflict` is missing.

**Root cause:** The programmatic conflict-resolution API has not been released on this tenant's platform version. The Maker Portal Conflicts tab uses a private/internal endpoint that is not exposed via OData. Until the public action ships, conflict resolution is portal-only.

**Severity:** Warning (the skill cannot apply resolutions programmatically; users must use the portal — but the orchestration still works)

**Auto-fix available:** Partial — the `resolve-conflicts` skill can detect the API absence, render the conflict list and HTML diff, and walk the user through a Maker Portal manual workflow.

**Fix procedure:**

1. Detect once at the start of `resolve-conflicts` Phase 5 with a probe call (or check `$metadata`). Cache the absence in `.git-integration-manifest.json` under `tenantCapabilities.resolveGitConflictAvailable: false` so subsequent runs short-circuit immediately.
2. Surface a Maker Portal deep-link: `https://make.powerapps.com/environments/{envId}/solutions/{solutionId}/source-control?tab=Conflicts`. Tell the user "Click each row → choose Keep or Accept → click Save."
3. For each conflict, walk through in chat: `Conflict {i}/{N}: {objectType} {name}. Open the portal, resolve it, then reply 'done' or 'kept-env' / 'accepted-incoming' so I can record your decision.`
4. After the user reports completion, re-check by calling `PreValidateGitComponents` and looking at the response — if no `0x80098015` is surfaced, conflicts are cleared. (Do NOT rely solely on `list-conflicts.js` if pattern IL-016 also applies.)
5. Write `last-conflict-resolution.json` with `status: "manual-resolution-required"`, `resolvedVia: "maker-portal"`, and a `decisions[]` array of what the user reported.
6. Long term: a future skill release should retry the API probe on every run so the fallback is dropped automatically once the tenant gets the action.

---

## Pattern IL-016: `gitupdatefiles` / `gitconflictfiles` entities 404 → false-negative `list-*` helpers

**Detection signal:**

- `GET {envUrl}/api/data/v9.2/gitupdatefiles` and/or `gitconflictfiles` returns 404 with: `Resource not found for the segment '...'`.
- `list-incoming-updates.js` and `list-conflicts.js` return `{ count: 0, items: [], hint: '... 404 ...' }` even though the Maker Portal Updates and Conflicts tabs show non-zero counts for the same env.
- Symptom for the user: `sync-from-git` Phase 3 says "Nothing to pull" right after a teammate pushed a commit; `resolve-conflicts` Phase 2 says "0 conflicts" while `CommitToGit` returns `0x80098015` (conflict-blocked).

**Root cause:** The entities that back the Updates and Conflicts tabs are not exposed under those names on this tenant version. The portal reads them via a private/internal endpoint. The `list-*` helpers were authored from public-API guesses (`gitupdatefiles`, `gitconflictfiles`) that hold on some tenants but not all. Result: the skill silently under-reports incoming work.

**Severity:** Warning (false negative — skill thinks env is clean when it isn't)

**Auto-fix available:** Partial — fall back to surrogate signals.

**Fix procedure:**

1. Detect once per skill run by probing both entities at start. Cache absence in `.git-integration-manifest.json` under `tenantCapabilities.gitUpdateFilesAvailable: false` and `gitConflictFilesAvailable: false`.
2. For incoming updates (Updates-tab surrogate): query `sourcecontrolbranchconfigurations` for the bound `(solution, branch)` tuple and read `upstreambranchsyncedcommitid`. Compare against the ADO branch tip via `ado-list-commits.js`. If git tip > synced commit, treat as `count = <commits-ahead>` and surface the commit list as the incoming work.
3. For conflicts (Conflicts-tab surrogate): call `PreValidateGitComponents`. Inspect `ValidationMessages`. If empty, also try a dry-run `CommitToGit` — if it returns `0x80098015`, treat conflicts as detected even though `list-conflicts.js` reports 0. The maker portal Conflicts tab remains the authoritative reading.
4. In any skill that consumes these helpers, surface a one-line warning: `⚠ list-incoming-updates fell back to commit-SHA diff (gitupdatefiles unavailable on this tenant). Open the Maker Portal for the authoritative view.`
5. Long term: once a HAR confirms the correct entity name on tenants that don't expose `gitupdatefiles`, update the helpers to query the correct entity and remove the fallback path.

---

## Pattern IL-017: `CommitToGit` returns HTTP 400 but commit landed (false-failure)

**Detection signal:**

- `CommitToGit` returns HTTP 400 with `0x80040216 "An unexpected error occurred"` (generic) — but NOT `0x80098015` (conflict-blocked) and NOT `0x80072033` (schema bug from pattern IL-014).
- Re-query of `sourcecontrolcomponent?$filter=iscommitted eq false and _solutionid_value eq <solutionId>` 5–10 seconds later shows the pending count dropped to 0.
- `ado-list-commits.js --branch <bound branch>` shows a new commit since the manifest's `lastCommitSha`.
- The commit message in ADO matches the message passed in the `CommitToGit` body.

**Root cause:** Race condition in the platform's commit pipeline — the HTTP response stream returns a generic error before the SourceControl plugin's commit task fully completes asynchronously. The commit still succeeds. The client interprets the 400 as a hard failure when the work has actually landed.

**Severity:** Warning (false failure report; user re-runs `commit-to-git` and gets a confusing "nothing to commit" the second time because the first run succeeded silently)

**Auto-fix available:** Yes — re-check pending count + ADO commit list on any non-conflict, non-schema 4xx response.

**Fix procedure:**

1. In `commit-to-git.js`, on any non-2xx response, branch on the error code:
   - `0x80098015` (conflicts) → surface IL-010 fix path.
   - `0x80072033` (schema bug) → surface IL-014 fix path.
   - `0x80040216` or any other generic 400 → enter recovery probe.
2. Recovery probe: wait 5 seconds, then call both:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-pending-changes.js" --envUrl <url> --solutionUniqueName <name>
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ado-list-commits.js"     --org <org> --project <proj> --repo <repo> --branch <branch> --top 1
   ```
3. Decision matrix:
   - `pendingCount == 0` AND ADO has a new commit since `lastCommitSha` AND commit message matches → treat as success. Update the marker with `recoveredFrom: "http-400-but-commit-landed"`, `commitId: <new SHA>`, `status: "succeeded"`.
   - `pendingCount > 0` → surface the original 400 error as a real failure and exit non-zero.
4. Add a one-line caveat to the user output when recovery fires: `ℹ CommitToGit returned a transient 400 but the commit landed in ADO ({sha}). Treating as success.`
5. The same recovery probe pattern applies to `ConnectToGit` and `DisconnectFromGit`, both of which can hold the HTTP connection long enough to surface generic 5xx/timeouts despite succeeding server-side — see `inner-loop-empirical-findings.md` §4.

---

## Pattern IL-018: Maker Portal `Pull` button fails with `404 Item with Id <guid> no longer exists` (stale `sourcecontrolcomponentpayload` cache)

**Detection signal:**

- The Maker Portal **Source control → Pull** button (URL pattern: `https://make.powerpages.microsoft.com/environments/{envId}/solutions/{solutionId}/sourcecontrol`) returns a red banner: `The HTTP status code of the response was not expected (404). Status: 404 Response: {"error":{"message":"Item with Id <guid> no longer exists."}}`.
- The Updates tab still shows a pending count (e.g., 107 updates) even though the Pull won't complete.
- The reported `<guid>` is **NOT** present in:
  - ADO repo file contents (grep the cloned `solutions/{solutionName}/` tree — zero hits).
  - ADO repo file names / paths.
  - Any user-queryable Dataverse entity (`powerpagecomponents(<guid>)`, `powerpagesites(<guid>)`, `solutioncomponents?$filter=objectid eq <guid>`, `sourcecontrolcomponents?$filter=componentid eq <guid>` all return 404 or empty).
- Direct GET on `sourcecontrolcomponentpayloads(<guid>)` and `stagedsourcecontrolcomponents(<guid>)` returns HTTP 400 with: `initiatingPluginExecutionContext.InitiatingPluginInfoProvider is null. Restricted API is not called by Microsoft publisher plugin.` These are platform-internal entities only mutable by Microsoft publisher plugins — confirming the GUID lives in a cache table that can't be queried or repaired by the user.
- `RefreshChangesFromGit` returns 204 (succeeds) but does NOT clear the broken payload reference.
- `PublishAllXml` does NOT clear it.
- The API-direction equivalent (`PullChangesFromGit`) on the same solution may report a different error (e.g., IL-014's `0x80072033 powerpagecomponent missing primary key`) because the API and portal pull paths take different code routes through the cache.

**Root cause:** A stale row in the internal `sourcecontrolcomponentpayload` (or `stagedsourcecontrolcomponent`) cache. The platform's source-control engine keeps a per-env index that maps `componentid` → `payloadid` → file path. When a record is deleted env-side after being snapshotted, or when an interrupted pull / failed commit leaves an orphan payload row, the next Pull attempt walks the cache, dereferences the orphan payload, and surfaces `Item with Id <guid> no longer exists` from the cache's GET-then-mutate flow. The orphan is server-internal — no user-facing entity or git file references it, which is why every external probe (ADO grep, Dataverse query) comes up empty.

**Severity:** Error (hard-stop on Maker Portal Pull; the user cannot apply incoming git changes)

**Auto-fix available:** Partial — disconnect-then-reconnect to Git wipes and rebuilds the cache from current ADO HEAD + env state. Safe IFF the env has zero uncommitted push-direction changes (action=1). If the env does have uncommitted local changes, commit them first or accept the loss.

**Fix procedure:**

1. **Confirm the diagnosis** with these four probes — all four must match for IL-018:
   ```bash
   # a) Identify whether the orphan GUID exists in any user-visible entity (expect all 404/empty)
   for tbl in powerpagecomponents powerpagesites powerpagesitelanguages; do
     curl -s -H "Authorization: Bearer <dvToken>" "<envUrl>/api/data/v9.2/${tbl}(<orphanGuid>)" | head -c 200
   done

   # b) Confirm the orphan is in a restricted internal table (expect HTTP 400 0x80040216)
   curl -s -H "Authorization: Bearer <dvToken>" "<envUrl>/api/data/v9.2/sourcecontrolcomponentpayloads(<orphanGuid>)"

   # c) Confirm the orphan is NOT in ADO repo contents (clone then grep — expect 0 hits)
   git clone --depth 1 "<adoCloneUrl>" /tmp/repo
   grep -r "<orphanGuid>" /tmp/repo/solutions/<solutionName>/

   # d) Quantify env-side data at risk for the reset (count rows where action=1 (push))
   curl -s -H "Authorization: Bearer <dvToken>" \
     "<envUrl>/api/data/v9.2/sourcecontrolcomponents?\$count=true&\$filter=action eq 1 and iscommitted eq false&\$top=1"
   # Expect "@odata.count" = 0 for the safe reset path. If > 0, see step 3.
   ```
2. **Disconnect-and-reconnect (if push count == 0):**
   - In Maker Portal: **Source control → Git connection → Disconnect** → confirm.
   - Wait ~30 seconds for the cache wipe to propagate.
   - Click **Connect to Git** → reselect the same organization / project / repo / branch / root folder path → click **Save**. The portal will run the OAuth consent + initial sync (creates one tracking commit via `SourceControlInitialSyncPlugin`).
   - Try **Pull** again. The fresh cache should resolve cleanly.
3. **Disconnect-and-reconnect (if push count > 0):**
   - Commit env-side changes FIRST via `/power-pages:commit-to-git` (the commit half of the loop is independent of the pull half — it usually works).
   - If commit-to-git is also blocked (e.g., by IL-010 conflicts), fall through to step 4.
4. **Bypass git pull entirely (always-safe fallback):**
   - From the source env, run `/power-pages:export-solution` to get a managed/unmanaged zip.
   - On the affected env, run `/power-pages:import-solution` with that zip.
   - This entirely sidesteps the broken cache. Same workaround applies to IL-014.
5. **Permanent fix:** Open a Microsoft Support ticket. Include the four probe outputs from step 1, the env URL, the env ID, and a note that `RefreshChangesFromGit`, `PublishAllXml`, and `PullChangesFromGit` all fail to clear the cache without disconnect/reconnect. Tag the ticket as "Power Platform Pipelines / Git Integration / sourcecontrolcomponentpayload cache corruption".

**Relationship to other patterns:** IL-014 and IL-018 are both pull-direction failures on the same broken pull pipeline. IL-014 surfaces inside the API path (`PullChangesFromGit` → `0x80072033 missing primary key`); IL-018 surfaces inside the portal path (Maker Portal Pull button → `404 Item with Id <guid> no longer exists`). On a given env, either or both may fire — the catalog entries are independent because the workarounds and detection signals differ. Both share the same final fallback (export-solution + import-solution).

---

## Pattern IL-019: Orphan `sourcecontrolcomponent` rows (null payload FK) → `CommitToGit` `0x80040217 No record value found for sourcecontrolcomponentpayload`

**Detection signal:**

- `CommitToGit` returns HTTP 400 with `0x80040217 "No record value found for Entity: sourcecontrolcomponentpayload, EntityId: <guid>, FileAttribute: componentpayload"`.
- The server **stops at the first orphan** — fixing one surfaces the next on the next attempt, which makes interactive recovery a multi-round whack-a-mole.
- Authoritative probe (server-side truth, used by `validate-no-orphan-source-control-rows.js`):
  ```bash
  curl -s -H "Authorization: Bearer <dvToken>" \
    "<envUrl>/api/data/v9.2/sourcecontrolcomponents?\$filter=_sourcecontrolcomponentpayloadid_value%20eq%20null%20and%20iscommitted%20eq%20false&\$select=sourcecontrolcomponentid,componenttype,componentpath,action&\$count=true&\$top=200"
  # @odata.count > 0 ⇒ IL-019 applies; every returned row is a blocker.
  ```
  Schema note (verified 2026-06 against sri-alm-dev-1 via `EntityDefinitions(LogicalName='sourcecontrolcomponent')/Attributes`): the entity has **no `_objectid_value` column** — the underlying component reference lives in the plain `componentid` Uniqueidentifier attribute. The payload FK is `sourcecontrolcomponentpayloadid` (Lookup), queried in OData as `_sourcecontrolcomponentpayloadid_value`. Earlier hypotheses that targeted `_objectid_value eq null` were incorrect for this entity's schema.
- `PreValidateGitComponents` does NOT detect this (returns `IsValid:true` even with orphans present). Likewise `ValidateSourceControlConnection`.

**Root cause:** The `sourcecontrolcomponent` row's payload FK (`sourcecontrolcomponentpayloadid`) is null, so when the commit pipeline reads the row and tries to follow the lookup to fetch the encoded `componentpayload` blob, the indirection terminates at NULL and the server raises `0x80040217 No record value found ... FileAttribute: componentpayload`. The whole commit batch aborts at the first such row.

**Severity:** Error (hard-stop on CommitToGit; the user cannot commit until every orphan is cleared)

**Auto-fix available:** Partial — direct API DELETE on the orphan rows is blocked by `0x80040216` ("Restricted API is not called by Microsoft publisher plugin") because `sourcecontrolcomponentpayload` is a platform-internal entity. The supported clearance path is the Maker Portal Source Control panel **Discard** action.

**Fix procedure:**

1. **Enumerate every orphan** via `validate-no-orphan-source-control-rows.js` (run as part of `/power-pages:commit-to-git --dry-run`). The output names every row's `sourcecontrolcomponentid` plus `componentpath` for context. This is faster than letting `CommitToGit` surface them one at a time.
2. **In Maker Portal → Source control → Changes**: for each row reported, click **Discard**. Confirm. The portal call hits a privileged plugin path the public OData layer can't reach.
3. **Optional belt-and-suspenders:** call `RefreshChangesFromGit` after the last Discard, then re-run `validate-no-orphan-source-control-rows.js` to confirm `@odata.count == 0`. (Note: `RefreshChangesFromGit` alone does NOT clear orphans — it only re-syncs the Updates side.)
4. **Retry `CommitToGit`.** A successful pre-flight validator pass is necessary but not sufficient; a parallel IL-010 (conflicts) or IL-009 (shared components) can still block. Run the full `/power-pages:commit-to-git --dry-run` skill end-to-end.
5. **If Discard fails** (rare; happens when the orphan row's solution itself is mid-disconnect): fall back to `Disconnect from Git → Connect to Git` to wipe the source-control workspace and start fresh. Note that this drops all pending push-direction changes, so commit them first if possible.

**Relationship to other patterns:** IL-019 (orphan push rows blocking commit) and IL-018 (orphan payload cache blocking pull) are sibling cache-orphan failures on the same source-control plugin. IL-019 surfaces on the push path (commit); IL-018 surfaces on the pull path. Distinct queries / fixes; do not conflate.

---

## Schema for new entries

When adding a new pattern, follow the same shape:

```markdown
## Pattern IL-NNN: <short name>

**Detection signal:** ...
**Root cause:** ...
**Severity:** Error | Warning | Info
**Auto-fix available:** Yes | No | Partial
**Fix procedure:**
1. ...
```

Then add the pattern ID to `scripts/parse-deployment-errors.js`'s pattern table (or the inner-loop equivalent if a separate parser exists) so `diagnose-git-integration` picks it up.

---

## References

- [Git integration FAQs](https://learn.microsoft.com/power-platform/alm/git-integration/faqs)
- [Source control operations](https://learn.microsoft.com/power-platform/alm/git-integration/source-control-operations)
- [Connect/Disconnect API reference](https://learn.microsoft.com/power-platform/alm/git-integration/git-api)
- This repo: `references/deployment-error-catalog.md` (sister catalog for the outer loop)
