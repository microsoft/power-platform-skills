# Inner-Loop Empirical Findings

A field-test log of where Dataverse Git integration **does not match** the published Microsoft Learn docs or the assumptions baked into earlier versions of the inner-loop skills. Updated when a skill run surfaces a new platform behavior worth codifying.

> Every entry below is **HAR-confirmed against at least one live tenant** as of the date in the heading. Older items may have been corrected on the platform side — re-verify before relying on them in new skills.

---

## §1 — Managed Environments is NOT enforced for solution-level binding (2026-06)

**Microsoft Learn says** ([Dataverse Git integration setup → Prerequisites](https://learn.microsoft.com/power-platform/alm/git-integration/connecting-to-git)):
> *"Dataverse Git integration is a feature of Managed Environments. Development and target environments must be enabled as Managed Environments."*

**Empirical reality** (tenant `sri-alm-dev-1`, env `2a89d6ac-0927-e77c-8939-aa99158dd11b`):
- BAP `governanceConfiguration.protectionLevel` = `"Basic"` (i.e. Managed Env is OFF).
- Two solutions in that env are nonetheless **successfully Git-bound** via `ConnectionType=0` (solution binding): `InternLearning` and `RetailOS`.
- `solutions.enabledforsourcecontrolintegration = true` on both; `solutions.sourcecontrolsyncstatus = 3` (Synced).
- The initial-sync async plugin (`SourceControlInitialSyncPlugin`) ran to completion on both.

**Action:**
- Skills must **warn** when Managed Env is off, not **block**. Soft-gate language: *"Microsoft Learn lists Managed Env as required; empirically solution-binding works without it on some tenants. Proceed at your own risk."*
- Env-level binding (`ConnectionType=1`) was **not** tested without Managed Env. The harder enforcement may apply there — treat env-binding as still requiring Managed Env until proven otherwise.

---

## §2 — `gitintegrations` entity does not exist on every tenant (2026-06)

**Earlier assumption** (`scripts/lib/detect-git-binding.js`): query `GET /api/data/v9.2/gitintegrations` to find binding state.

**Empirical reality** (`sri-alm-dev-1`):
- `GET /gitintegrations` returns 404 with `"Resource not found for the segment 'gitintegrations'"`.
- The binding lives in **two other entities** instead:
  - `sourcecontrolconfigurations` (one row per env) — holds `organizationname`, `projectname`, `repositoryname`, `gitprovider`.
  - `sourcecontrolbranchconfigurations` (one row per (solution-folder, branch) tuple) — holds `branchname`, `rootfolderpath`, `branchsyncedcommitid`, `upstreambranchsyncedcommitid`, `statuscode`.
- Per-solution sync state is on the `solutions` entity itself: `enabledforsourcecontrolintegration` (bool), `sourcecontrolsyncstatus` (int).

**`sourcecontrolsyncstatus` value mapping** (HAR-observed):
| Value | Meaning |
|---|---|
| `0` | Not yet started |
| `1` | In progress (initial sync running) |
| `3` | Synced (env and branch are in sync) |

**Action:**
- Helpers must accept either the `gitintegrations` schema (if the tenant has it) **or** fall back to `sourcecontrolconfigurations` + `sourcecontrolbranchconfigurations` + the `solutions` columns. See `detect-git-binding.js` for the fallback chain.
- Do NOT treat a `404` on `gitintegrations` as `bound: false`. Re-probe via the fallback entities first.

---

## §3 — Connect-to-Git ONLY seeds a folder placeholder; first content commit is the user's job (2026-06, CORRECTED)

> ⚠️ **This section was wrong in an earlier revision.** The earlier claim was that `ConnectToGit`'s async op auto-commits every component. That is FALSE. Re-verified by inspecting the ADO repo after a fresh bind: only a `Readme.md` placeholder lands at the folder root.

**Empirical reality** (HAR-confirmed against tenant `sri-alm-dev-1`):

1. `POST /ConnectToGit` (`ConnectionType=0`) creates the folder `<rootFolder>/<gitFolder>/` in the ADO repo and writes a single auto-Readme commit, e.g.:
   ```
   commit f6e486ab157ac61f98a76f9825d2466fcdee214b
   message "Creating new project folder solutions/RetailOS PowerPortals Runtime"
   files   solutions/RetailOS/Readme.md  ← only file
   ```
2. `SourceControlInitialSyncPlugin` then enumerates every solution component into the `sourcecontrolcomponent` Dataverse entity, all with `iscommitted=false` and `action=Push`. For RetailOS this was **385 rows** (161 direct solutioncomponents + dependencies pulled in by the source-control plugin).
3. `sourcecontrolsyncstatus` flips to `3` (Synced) and `branchsyncedcommitid == upstreambranchsyncedcommitid == <Readme placeholder SHA>`. **Both columns track the inbound/upstream pointer only** — they do NOT reflect outbound pending pushes.
4. The user must then **explicitly call `POST /CommitToGit`** to push the staged components. In our run that produced commit `d8e10f26…` ~4.5 min after the call (the action holds the HTTP request open while ADO writes 344 file commits).

**How to actually know if you have pending pushes:** count rows in `sourcecontrolcomponent` where `partitionid == <solutionId>` and `iscommitted == false`. See §10.

**Action (rewrites the obsolete guidance):**
- `connect-solution-to-git` / `setup-git-integration` Phase 8 must:
  - Wait for `sourcecontrolsyncstatus` to reach `3` (initial component staging done).
  - Count `sourcecontrolcomponents` with `iscommitted=false` → that's the post-bind pending-push count.
  - Tell the user: *"Folder seeded with SHA `<placeholder>`. N components are now staged as pending Changes. Next step: `/power-pages:commit-to-git` to push them as the real initial commit."*
  - Print the full ADO URL with `&path=/<rootFolder>/<gitFolder>` so they can see the (initially empty) folder.
- `commit-to-git` must treat *"fresh bind with staged components"* as the normal first-run case, not as an edge case. Phase 1's "nothing to commit" exit must only fire when `iscommitted=false` count is actually 0.

---

## §4 — `ConnectToGit` exceeds the default HTTP-helper timeout (2026-06)

**Symptom:** `connect-solution-to-git.js` returned `{ error: "Request timed out" }` even though the binding succeeded server-side.

**Root cause:** Dataverse holds the `POST /ConnectToGit` HTTP request open while the initial-sync plugin runs (5-15 min for non-trivial solutions). The helper's `makeRequest` enforces a ~120s HTTP timeout — fires long before the platform responds, but Dataverse still completes the operation.

**Action:**
- The Connect-to-Git helpers (`connect-to-git.js`, `connect-solution-to-git.js`) must, on HTTP-timeout error, **automatically re-query** `solutions.enabledforsourcecontrolintegration` for the target solution. If `true`, treat as success and return `{ bound: true, isAsyncStillSyncing: true, ... }`. If `false`, the timeout was a real failure.
- SKILL.md instructions for these phases must warn the user up-front that the call may visibly time out and that auto-verification will run.

---

## §5 — `ConnectToGit` does not require an ADO PAT in the request (2026-06)

**Earlier prereq:** "An ADO PAT with `Code (read & write)` scope on the target repo".

**Empirical reality:**
- `POST /api/data/v9.2/ConnectToGit` uses your **Entra (Dataverse) bearer token only**. ADO is authenticated via the tenant-level OAuth grant set up out-of-band on first use (the maker portal walks you through this once per tenant).
- A PAT is only needed by the **pre-check helpers** (`verify-repo-initialized.js`, `verify-ado-permissions.js`, `ado-list-commits.js`) that hit `dev.azure.com` directly.

**Action:**
- Soften the PAT prereq: *"Optional — only needed to enable repo-init / permission pre-checks. ConnectToGit itself uses your tenant Entra grant."*
- Make `verify-repo-initialized` an **optional** pre-check, not a hard gate. When the user has no PAT, skip it and trust the bind to surface a clear error if the repo is empty.

---

## §6 — BAP API quirks for Managed-Env detection (2026-06)

**Wrong URL** (used by older `verify-managed-env.js`): `https://api.powerplatform.com/environments/{id}?api-version=2022-03-01-preview` → 404 `RouteNotFound`.

**Correct URL:** `https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments/{id}?api-version=2023-06-01` — returns `properties.governanceConfiguration.protectionLevel`.

**Valid api-versions** (per BAP error response, 2026-06): `2016-02-01`, `2016-11-01`, `2018-01-01`, `2018-10-01`, `2019-05-01`, `2019-10-01`, `2020-04-01`, `2020-05-01`, `2020-06-01`, `2020-08-01`, `2020-09-01`, `2020-10-01`, `2021-03-01`, `2021-04-01`, `2021-07-01`, `2022-05-01`, **`2023-06-01`**, `2024-05-01`.

**Action:** `verify-managed-env.js` updated to use `api.bap.microsoft.com/...admin/environments/{id}?api-version=2023-06-01`.

---

## §7 — Initial sync writes to a sub-folder, not repo root (2026-06)

**Symptom:** "After Connect-to-Git completed I only see README.md in my repo (1 commit)."

**Cause:** Connect-to-Git writes the initial commit into `<rootFolder>/<gitFolder>/` (e.g. `solutions/RetailOS/`), not the repo root. ADO's default file-tree view shows the root — users miss the new folder unless they navigate to it or look at the commit history.

**Action:** Setup skills' final summary must print the **fully-qualified ADO browse URL with the `&path=` parameter** pre-filled, plus a one-liner "ADO's default Files view shows the repo root; click into `solutions/<gitFolder>/` to see your components."

---

## §8 — `sourcecontrolbranchconfigurations` tracks INBOUND sync only (2026-06, CORRECTED)

> ⚠️ **Earlier revision claimed** the two commit-ID columns reflect Dirty/Clean. That is only half right.

When multiple solutions are bound (or env-bound on top of solution-bound), there is **one row per (solution-folder, branch) tuple** in `sourcecontrolbranchconfigurations`. There may also be a "root" row (with `rootfolderpath` set to the chosen `RootFolder`, e.g. `solutions`).

**The two commit-ID columns:**
- `upstreambranchsyncedcommitid` — last ADO commit Dataverse has **pulled IN** from upstream (refreshed by `RefreshChangesFromGit`).
- `branchsyncedcommitid` — last commit that has been **reconciled** into the env's source-control state. After a Connect-to-Git, this matches `upstreambranchsyncedcommitid` and points at the auto-created folder placeholder.

These columns say nothing about **outbound pending pushes**. After Connect-to-Git they will both equal the placeholder SHA even though 385 components are sitting in `sourcecontrolcomponent` with `iscommitted=false` waiting for their first `CommitToGit`.

**Correct Dirty/Clean derivation:**
| State | Rule |
|---|---|
| Clean | `sourcecontrolcomponent` row count where `partitionid=<solutionId>` AND `iscommitted=false` == 0 |
| Dirty (outbound) | same query but count > 0 |
| Stale (incoming) | `upstreambranchsyncedcommitid` differs from the ADO branch tip (requires ADO PAT to check) |
| Conflicted | `sourcecontroloperationstatus` shows a failed op, or commit-to-git returns the shared-component error from §9 |

**Action:** `list-pending-changes.js` MUST query `sourcecontrolcomponents` (see §10), not `gitcommitfiles` and not the branch-config columns. The branch-config columns are useful only for the inbound/stale direction.

---

## §9 — Shared-component overlap errors at COMMIT time, not at CONNECT time (2026-06)

**Microsoft Learn warning:** *"Source control requires each component to belong to a single solution in solution scope."*

**Empirical reality:**
- `ConnectToGit` (`ConnectionType=0`) **does NOT validate** that the solution's components are exclusive at bind time. The bind succeeds, the folder is seeded, and `sourcecontrolsyncstatus` reaches `3` (Synced) even with shared overlaps.
- The error surfaces only when the user runs the first `CommitToGit`. Example payload:
  ```json
  {
    "error": {
      "code": "0x80040216",
      "message": "Shared components are not supported in source control. The connectionreference 'Microsoft Dataverse InternLearning-79ad0' is included in multiple solutions that are connected to source control (InternLearning, RetailOS). Source control requires each component to belong to a single solution in solution scope. Remove this component from one of the solutions before committing your changes."
    }
  }
  ```
- The error names ONE shared component at a time. If there are N shared components, the user must remove N-1 of them and retry, each retry surfacing the next one — UNLESS the skill pre-computes the full intersection and removes them in one pass.

**Action (must be added to `connect-solution-to-git` Phase 4 — BEFORE the bind):**
1. Enumerate already-Git-bound solutions on the env (`solutions?$filter=enabledforsourcecontrolintegration eq true`).
2. For each, query `solutioncomponents` and intersect by `(objectid, componenttype)` with the target solution.
3. If intersections exist, surface them with names + types and require the user to either:
   - Remove from one side via `RemoveSolutionComponent` (see §11), OR
   - Disconnect the other solution from Git, OR
   - Cancel.
4. Only proceed with `ConnectToGit` once the intersection is empty.

(Doing this catches the error during the cheap pre-flight instead of after the 5-min commit timeout.)

---

## §10 — Pending Changes live in `sourcecontrolcomponent`, NOT `gitcommitfiles` (2026-06)

**Earlier `list-pending-changes.js`:** queried `GET /gitcommitfiles` → 404 with hint *"entity name may differ on this org version"* — and then returned `count: 0`, which is wildly wrong.

**Empirical reality:** The canonical source of truth for pending Changes is the `sourcecontrolcomponent` entity. Each row represents one tracked component:

| Field | Meaning |
|---|---|
| `partitionid` | The `solutionid` the row is associated with (filter by this to scope per-solution). |
| `iscommitted` | `false` = pending push to ADO; `true` = already committed in a prior `CommitToGit`. |
| `action` | `1` = Push, `2` = Delete, `0` = None (typically idle / already committed). |
| `componenttypename` | Human-readable type ("Web Page", "Web Template", "Entity", "Solution", etc.). |
| `componentpath` | The path the component will/did land at, e.g. `/powerpagesites/RetailOS/website.yml`. |
| `componentdisplayname` | The name shown in the maker portal Changes tab. |
| `solutioncomponentstate` | `0`=Create, `1`=Update, `2`=Delete. |

**Canonical "pending Changes count" query:**
```http
GET /api/data/v9.2/sourcecontrolcomponents
   ?$filter=partitionid eq <solutionid> and iscommitted eq false
   &$count=true
   &$top=1
   Prefer: odata.include-annotations="*"
```
The `@odata.count` field is the number of pending Changes the maker portal will show.

**Related entities:**
- `sourcecontrolcomponentpayload` — the serialized YAML for each component (1:1 with `sourcecontrolcomponent`).
- `stagedsourcecontrolcomponent` — appears to be empty at rest on our test tenant; likely a transient staging table used during the CommitToGit transaction. Not useful for the pending-count query.
- `sourcecontroloperationstatus` — long-running operation status (empty after async ops complete). For the running operation, query `asyncoperations` filtered by `name startswith 'Microsoft.Dynamics.SourceControlIntegration.Plugins.SourceControl'`.

**Action:** Rewrite `list-pending-changes.js` to query `sourcecontrolcomponents` with the filter above. The helper must accept either `--solutionId` (preferred) or `--solutionUniqueName` (resolved to id via `solutions?$filter=uniquename eq '<n>'&$select=solutionid`).

---

## §11 — `RemoveSolutionComponent` OData action has a payload-shape quirk (2026-06)

**Microsoft Learn** documents the parameters as `ComponentId` (Guid), `ComponentType` (int), `SolutionUniqueName` (string).

**Empirical reality:** the OData metadata for the action declares its first parameter as `SolutionComponent` of type `mscrm.solutioncomponent` (an entity reference) — NOT a `ComponentId` Guid. But the server-side processor expects a `ComponentId` field. Reconciling that requires a non-obvious payload shape:

```json
{
  "SolutionComponent": {
    "@odata.type":         "Microsoft.Dynamics.CRM.solutioncomponent",
    "solutioncomponentid": "<objectId>",   // ← yes, the entity's objectid goes in solutioncomponentid
    "objectid":            "<objectId>",
    "componenttype":       <componentType>
  },
  "ComponentType":      <componentType>,
  "SolutionUniqueName": "<sourceSolutionUniqueName>"
}
```

Variants that **fail**:
- Top-level `ComponentId` field (`The parameter 'ComponentId' in the request payload is not a valid parameter for the operation 'RemoveSolutionComponent'.`)
- `SolutionComponent: { @odata.id: solutioncomponents(<scid>) }` where `<scid>` is the actual `solutioncomponentid` (`Cannot find solution component Entity <scid> in solution <solutionid>.` — server reads the navigation GUID AS ComponentId, but the SOAP request handler wants the *objectid*, not the row id).
- Omitting the inline `solutioncomponentid` (`Required field 'ComponentId' is missing for RequestName='RemoveSolutionComponent'`).

Direct `DELETE /solutioncomponents(<id>)` is also rejected: `The 'Delete' method does not support entities of type 'solutioncomponent'.`

**Action:** Provide a `remove-solution-component.js` helper that implements the working payload shape. Skill authors should never have to discover this themselves.

---

## §12 — `CommitToGit` is strictly 1-call → 1-commit; "batches" users perceive are bind-time bookkeeping commits (2026-06)

**Common user misperception:** *"When I committed manually via the maker portal I got 3 commits in batches, but when the skill called the API I only got 1 commit. Make the skill batch like the portal does."*

**Empirical reality** (HAR-confirmed against tenant `sri-alm-dev-1` / repo `srijan-pp-alm`):

1. The OData metadata for `CommitToGit` has exactly two parameters: `CommitMessage` (`Edm.String`) and `SolutionUniqueName` (`Edm.String`). There is **NO** `ComponentIds`, `BatchSize`, `Strategy`, or `MaxComponentsPerCommit` parameter. The maker portal has no privileged batching API — it calls the same action.

2. `CommitToGitResponse` returns a single `CommitId`. One call → one commit, always. We confirmed this on both paths:
   - **Manual portal commit on InternLearning** (user clicked Commit in maker portal): produced commit `38f63cf0` with `Add=48, Edit=0, Delete=0` — **one commit, 48 files**.
   - **Programmatic API commit on RetailOS** (skill called `commit-to-git.js`): produced commit `d8e10f26` with `Add=387, Edit=0, Delete=0` — **one commit, 387 files**.

3. What users misread as "3 batches" is actually the **3 separate bookkeeping commits** the Git-integration pipeline creates over a binding's lifetime:

   | # | Source | When | Example commit |
   |---|---|---|---|
   | 1 | Repo-init pipeline | When ConnectToGit creates the repo (or first writes to it) | `ffb28685 — "Added README.md"` |
   | 2 | `ConnectToGit` async-op | When a solution is bound — one such commit per bound solution | `738e8e4c — "Creating new project folder solutions/InternLearning"` |
   | 3 | First `CommitToGit` | When the user pushes their staged components | `38f63cf0 — "import Intern Learning solution (...)"` |

   Commits #1 and #2 are platform-generated placeholders. Only commit #3 contains the user's content — and it is exactly **one** commit, regardless of how many files / components are in the staging set.

**Action (must be added to every skill that creates or surfaces a commit so users don't misread their own history):**

- `commit-to-git` Phase 4 (plan) must explicitly say: *"This will produce exactly **1 new commit** on `<branch>`. Power Platform's CommitToGit always creates a single commit regardless of file count."*
- `commit-to-git` Phase 8 (verify) must explain the ADO commit-list context: *"Your new commit appears alongside the bind-time placeholder (`Creating new project folder …`) and any repo-init commits (`Added README.md`). Those pre-existed — they are NOT batches of your push."*
- `setup-git-integration` and `connect-solution-to-git` Phase 8 already disclose the placeholder commit; they additionally should note: *"Your next `commit-to-git` will add one more commit on top of this placeholder."*
- `commit-to-git` Phase 4 must surface the **"want multiple commits?"** workflow: *"To split work into multiple commits, commit incrementally as you edit (save → commit, save → commit). Do NOT batch all changes and then try to split — there is no API for that, and the platform won't fake-split a single push."*

**Do NOT** implement client-side batching in `commit-to-git.js` that calls `CommitToGit` multiple times with the same staged set. There is no way to scope a `CommitToGit` call to a subset of pending changes — every call pushes ALL `iscommitted=false` rows for the bound solution, so a "loop with subset selection" pattern is impossible. Repeated calls with no intervening changes will return a "no changes to commit" 400 on attempt #2.

---

## §13 — Multi-solution-bound envs need `boundSolutions[]` enumeration (2026-06)

**Earlier `detect-git-binding.js` (env-scope call):** when called without `--solutionUniqueName` on an env that has 2+ Git-bound solutions, the helper:
- Picked one branch row arbitrarily (whichever `sourcecontrolbranchconfigurations` returned first).
- Skipped the per-solution `solutions` lookup (it's gated on `--solutionUniqueName` being non-null).
- Skipped the per-solution `sourcecontrolcomponents` count (same gating).
- Returned `cleanState: "Unknown"` and `pendingChangesCount: null` with no signal that the env actually had multiple bindings.

**Empirical reality (env `org5ba33a19.crm.dynamics.com`):** the env had `InternLearning` and `RetailOS` both bound to the same ADO repo (`GitIntegration22/srijan-pp-alm/srijan-pp-alm` / branch `main`) under sibling folders `solutions/InternLearning` and `solutions/RetailOS`. Each is tracked as a separate row in `sourcecontrolbranchconfigurations`; pending Changes are scoped per-`partitionid` in `sourcecontrolcomponents`. There is no env-wide aggregate column on either entity.

**Action (taken in `detect-git-binding.js`):**
1. After resolving the (arbitrary) primary branch row, ALWAYS query `solutions?$filter=enabledforsourcecontrolintegration eq true` to enumerate every bound solution on the env.
2. For each, count pending Changes via `sourcecontrolcomponents?$filter=partitionid eq <id> and iscommitted eq false&$count=true&$top=1`.
3. Populate two new response fields:
   - `boundSolutions: [{ uniqueName, solutionId, pendingChangesCount, sourceControlSyncStatus }]`
   - `multipleSolutionsBound: <bool>`
4. When `--solutionUniqueName` is omitted, set the top-level `pendingChangesCount` to the **SUM across all bound solutions** so `cleanState` is meaningful at env scope (Clean iff every bound solution is Clean).

**Live verification:**
```json
{
  "pendingChangesCount": 3,
  "cleanState": "Dirty",
  "boundSolutions": [
    { "uniqueName": "RetailOS",       "pendingChangesCount": 0, "sourceControlSyncStatus": 3 },
    { "uniqueName": "InternLearning", "pendingChangesCount": 3, "sourceControlSyncStatus": 3 }
  ],
  "multipleSolutionsBound": true
}
```
RetailOS is clean (post-commit); InternLearning has 3 pending Changes — exactly what the maker portal shows. The env-wide `cleanState` correctly reports `Dirty` because at least one bound solution has pending pushes.

**Orchestrator consequence (`plan-inner-loop` Phase 2 + Phase 5):** when `multipleSolutionsBound === true`, the plan render MUST iterate `boundSolutions[]` and show per-solution Clean/Dirty rather than a single env-wide row. Phase 6's recommendation gate similarly needs to ask which solution to act on before dispatching `commit-to-git` / `sync-from-git` (those skills require `--solutionUniqueName` to scope correctly).

---

## §14 — Maker-portal "switch branch" requires Disconnect → Connect-to-Git (no in-place branch picker) (2026-06)

**Common user expectation:** *"I'll just change the branch dropdown on the Git connection panel like a normal Git client."*

**Empirical reality** (Power Pages maker portal at `make.powerpages.microsoft.com/.../sourcecontrol`, tenant `sri-alm-dev-1`, 2026-06):
- The **Git connection** side panel exposes the current binding fields (Organization / Project / Repository / Branch / Git folder) as **read-only labels** plus a single **Disconnect solution from Git** button.
- There is **no branch dropdown, no "edit binding" affordance, and no "switch branch" action** anywhere in the maker portal UI.
- To work on a different branch, the user must (a) click **Disconnect**, then (b) click **Connect to Git** in the top toolbar and re-enter Organization / Project / Repository / **new branch** / Folder from scratch.
- This is exactly what `switch-branch.js` does under the hood (`DisconnectFromGit` → `ConnectToGit` against the new branch), so the API helper is the single source of truth for the two-step pattern.

**Action:**
- `branch-switch` SKILL.md Overview must call this out for users who fall back to the manual UI path: *"Even in the maker portal the operation is two API calls. This skill wraps both with a workspace-clean precondition so you don't silently lose in-flight Changes between disconnect and reconnect — the UI does NOT enforce that precondition."*
- `connect-solution-to-git` and `setup-git-integration` SKILL.md should remind the user post-bind: *"To switch this solution to a different branch later, run `/power-pages:branch-switch` (or in the UI: Disconnect from Git → Connect to Git → pick the new branch)."*
- Do **NOT** add a "branch dropdown" affordance request to the maker-portal team in skill error messages — the UI deliberately treats branch as bind-time-immutable and the API mirrors that.

---

## §15 — Auto-delete source branch in ADO PR completion leaves the bound env on a deleted ref (2026-06)

**Common ADO PR workflow:** in the *Complete pull request* dialog, ☑ *"Delete `feature/<name>` after merging"* is **ticked by default** for non-default branches.

**Empirical reality** (tenant `sri-alm-dev-1`, solution `InternLearning` bound to `feature/demo-edit`, 2026-06):
- After completing PR #3 (`feature/demo-edit` → `main`) with the auto-delete checkbox ticked, the maker portal **Source control** page for the solution surfaces a red error banner: *"The connected organization, project, repository, or branch does not exist or you do not have access to it. Please check your permissions and the existence of the location in Git and refresh the page. If it has been deleted, disconnect and reconnect to a valid location."*
- The error is sticky — **Refresh**, **Check for updates**, and **Commit** all fail until the binding is re-pointed at an existing branch.
- The only recovery path is **Git connection → Disconnect solution from Git → Connect to Git → pick the merge target** (typically `main`). The solution's local environment state is preserved across the reconnect because `DisconnectFromGit` does not touch Dataverse rows, only `sourcecontrolconfigurations` / `sourcecontrolbranchconfigurations` linkage.

**Action:**
- `open-pr` Phase 9 final gate must surface a post-merge advisory when the source branch is the bound branch: *"After the PR merges, the env will be bound to a deleted branch and the Source control page will surface a red 'branch does not exist' banner. Run `/power-pages:branch-switch` to retarget to `<targetBranch>` BEFORE clicking Complete in ADO, or immediately after."*
- `branch-switch` Error Handling must add a "recovery from deleted-branch banner" path: if `detect-git-binding.js` returns the binding fields but the ADO branch lookup 404s, classify as **Broken (orphaned binding)** and route the user to re-bind to a valid branch — the workspace-clean precondition does NOT apply here because the source branch is gone (there is nothing to lose).
- `plan-inner-loop` Phase 2 already flags `Broken` state; the message should include this specific failure mode in its example list.

---

## §16 — Azure DevOps PR completion offers 4 merge types, not 1 (2026-06)

**Earlier `open-pr` SKILL.md wording:** *"Click Complete merge"* — implicitly assumes a single default merge strategy.

**Empirical reality** (ADO PR completion dialog at `https://dev.azure.com/<org>/<proj>/_git/<repo>/pullrequest/<id>`, 2026-06):

| Merge type | Resulting history | When to recommend |
|---|---|---|
| **Merge (no fast-forward)** *(ADO default)* | Nonlinear; preserves every source commit + adds a merge commit | Default; safest for multi-maker PRs where commit-by-commit history matters for audit / blame |
| **Squash commit** | Linear; collapses every source commit into a single commit on the target | Single-maker feature PRs where the in-progress commit history is noise (most common for solo Power Pages inner-loop work) |
| **Rebase and fast-forward** | Linear; replays source commits onto the target tip | When the source branch is a clean linear sequence and you want a flat target history (rare for Power Platform — `CommitToGit` commits often touch hundreds of files and rebases are diff-heavy) |
| **Semi-linear merge** | Rebases source commits onto target then creates a two-parent merge | Trunk-based shops that want both linear history per-PR and an explicit merge-commit marker |

**Action:**
- `open-pr` Phase 9 final gate (the open-in-browser handoff) must surface the 4-option vocabulary in its advisory: *"In the ADO Complete dialog you'll see four merge types. For solo Power Pages PRs, **Squash commit** keeps `main` clean; for multi-maker PRs, **Merge (no fast forward)** preserves per-commit attribution. Other two options are rare for solution-shaped diffs."*
- Do NOT hardcode a single merge type in the open-pr skill — the choice belongs to the maker at completion time. ADO's branch-policy "automatic merge requirements" is the right enforcement surface, not the inner-loop skill.

---

## §17 — First `CommitToGit` after Connect captures the ENTIRE solution as "Create" operations (2026-06)

**Common user surprise:** *"I only added one new table, but the maker portal shows 189 Changes ready to commit. Did I break something?"*

**Empirical reality** (tutorial run on `InternLearning` solution, 2026-06):
- Before the first `CommitToGit` call, every solution component (custom entities + their auto-attached standard system columns + any pre-existing pulled-in OOTB items like Account ribbon diffs / saved queries / views) is enumerated in `sourcecontrolcomponent` with `iscommitted = false`.
- The user's tutorial solution contained one custom `sri_Task` entity, but the **Changes** count was **189** because the solution also referenced ~40 standard Account-related saved queries / system attributes that had been added to it pre-Git, plus the system columns Dataverse auto-attaches to every custom table (CreatedOn, ModifiedBy, OwnerId, statuscode, … — ~13 per table).
- This is not a bug — it's the inevitable consequence of the first commit being a **baseline snapshot** of "what's in the solution today" rather than "what the user just edited".

**Action:**
- `commit-to-git` Phase 1.5 (the "first commit since connect" disclosure at line 89) must explicitly set expectations: *"This is the FIRST commit since `connect-solution-to-git`. Expect the Changes count to equal the FULL solution component count, NOT just what you recently edited. Every custom entity drags ~13 standard system columns; pre-existing OOTB components in the solution also appear. Subsequent commits will only show real edits."*
- `commit-to-git` Phase 4 plan render must NOT trigger a "this looks suspicious, are you sure?" warning when the first-commit count is large — that would be a false alarm.
- The PR diff in ADO (when the user later runs `open-pr`) will likely show FAR fewer changed files than the Changes count — see §19.

---

## §18 — `PullChangesFromGit` deletion prompts: pick "Remove from solution", not "Delete from environment", for system/standard components (2026-06)

**Maker-portal dialog wording** (when the incoming Updates set contains delete operations, e.g. after the ADO branch was reverted to remove items from the solution):
> *"Remove or delete items? Some items in this solution have a Git operation of **Remove or delete**. If you choose to remove them, they'll still exist in the environment. If you choose to delete them, they'll be deleted from this environment altogether."*
>
> Buttons: **Remove from solution** / **Delete from environment** / **Cancel**

**Empirical reality** (tutorial run on `InternLearning`, 2026-06):
- After the `Added a new Table` commit was reverted via ADO PR-revert, the pull surfaced 189 "Remove or delete" items — every component the original commit had added.
- The vast majority were **standard OOTB Account columns / saved queries** (CreatedBy, Address1_Country, OwnerId, OOTB views, ribbon diffs). Clicking **Delete from environment** on those would have **physically deleted standard Dataverse rows** from the org — irrecoverable without a re-provision.
- The safe choice in nearly every revert/cleanup scenario is **Remove from solution** — it de-scopes the items from THIS solution but leaves them in Dataverse, intact and usable by other solutions or default views.
- **Delete from environment** is only appropriate when the items being removed are **custom-prefixed components owned by this solution** and the maker has explicitly decided the entity itself should be retired.

**Action:**
- `sync-from-git` Phase 5 hard-delete consent gate (`sync-from-git:5.hard-delete`) is the API parallel of this UI dialog. The skill message must explicitly warn: *"`DeleteDeletedComponents: true` is the Dataverse-API equivalent of the maker portal's 'Delete from environment' button. If any of the incoming deletions are standard OOTB components (CreatedOn / OwnerId / statuscode / OOTB saved queries / ribbon diffs), choosing hard-delete will physically remove them from Dataverse — irrecoverable without re-provision. Almost every revert/cleanup scenario should choose No here (the API equivalent of 'Remove from solution')."*
- The skill should pre-scan the pending deletions list and surface a hard-stop if any item's `displayname` matches the OOTB column / view / ribbon-diff pattern — even with explicit user consent, an OOTB-touching hard-delete is a footgun that warrants a typed-confirmation gate (similar to `revert-branch`'s typed-confirmation pattern).
- `revert-branch` SKILL.md Overview should cross-reference §18: after this skill reverts the branch, downstream envs running `sync-from-git` will face this exact dialog — the recommendation is to use the soft path (no `--hard-delete`) for the first reconciliation pull.

---

## §19 — Maker-portal "Changes" count is upper-bound; the resulting `CommitToGit` Git diff is often much smaller (2026-06)

**Common user surprise:** *"I committed 44 Changes, then opened a PR — but the PR's Files tab shows only 1 changed file. Where did my other 43 go?"*

**Empirical reality** (tutorial run on `InternLearning`, `feature/demo-edit` branch, 2026-06):
- 44 items showed in the maker-portal **Changes** tab after switching the bound branch (the env had components that the new branch's Git folder didn't know about).
- The user clicked Commit; the action returned a single new commit SHA on `feature/demo-edit`.
- ADO **Branches** correctly reported `feature/demo-edit` as **1 ahead, 0 behind** of `main`.
- When the PR was opened (`feature/demo-edit` → `main`), the **Files** tab showed only **1 changed file** (`publisher.yml`, −146 / +1 lines) and the **Commits** tab showed the single commit.
- The other 43 "Changes" did not generate file-level diffs — when serialized to YAML they were bit-identical to whatever `main` already had on disk (e.g. standard system columns that are deterministic given the table they hang off of, or items whose Git-folder content matched the env's hash but whose `sourcecontrolcomponent` row was still flagged `iscommitted=false` due to a state-tracking mismatch).

**Action:**
- `commit-to-git` Phase 8 (verify CommitId in ADO) must NOT report a warning when the new commit's file count is `<<` the pre-commit Changes count — that is normal, not a partial-commit failure. The current Phase 8 already only checks that the SHA exists; do not add a file-count cross-check.
- `open-pr` Phase 1 nothing-to-PR short-circuit must continue to use **commit count** (`sourceBranch ahead of targetBranch`) rather than file-diff count to gate the "nothing to PR" path — a 1-commit / 0-file PR is still a valid (empty-effect) PR and the platform allows it.
- `open-pr` Phase 5 plan render should surface this caveat in the description preamble when the count delta is large: *"This PR contains N commit(s) representing M maker-portal Changes; the actual file diff may be smaller — environment-side dedupe is normal and not a partial-commit bug."*

---

## §20 — Conflicts don't double-count in Changes / Updates tabs (2026-06)

**Common user perception:** *"If sri_Task is conflicted, I'd expect to see Changes (1) AND Updates (1) AND Conflicts (1) — once for each side that touched it."*

**Empirical reality** (tutorial run on `InternLearning`, 2026-06):
- After `Check for updates` detected that both env and `main` had modified `entity.yml` line 19 (description), the **Source control** tabs read **Changes (0)**, **Updates (0)**, **Conflicts (1)** — the same `sri_Task` row.
- The three tabs are **mutually exclusive per component**: an item is in exactly ONE of `{Changes, Updates, Conflicts, in-sync}` at any given moment.
- The platform suppresses the Changes / Updates entries for conflicted items because acting on them via `Commit` or `Pull` would silently lose one side's edit; forcing the user through `resolve-conflicts` first is the design intent.
- After resolution, the item moves back to whichever tab matches the chosen strategy (Changes for `Keep current`, Updates for `Accept incoming`) — see §21.

**Action:**
- `plan-inner-loop` Phase 2 state-summary render must NOT sum `changesCount + updatesCount + conflictsCount` when displaying "pending work" — that would double-count nothing today but creates the wrong mental model for the user.
- `resolve-conflicts` Phase 1 binding-check assertion should treat `conflicts.count` as the authoritative N for the skill's scope; do NOT additionally check `changes.count == 0 && updates.count == 0` as a precondition (those will already be 0 for the same items by platform design).
- Per-solution status renders in `detect-git-binding.js` should label the counts as `pending(env) | pending(git) | conflicted` rather than implying additivity.

---

## §21 — Conflict resolution decides the winner but does NOT push/pull on its own (2026-06)

**Common user perception:** *"I clicked Keep current changes and the banner says 'Resolved 1 conflict.' I'm done — main is now updated, right?"*

**Empirical reality** (tutorial run on `InternLearning`, 2026-06):
- Clicking **Keep current changes** on a `sri_Task` conflict produced banner *"Resolved 1 conflict(s) by keeping current changes in this environment"* and moved the item from `Conflicts (1)` → `Changes (1)`.
- ADO `main` was **unchanged at this point** — the env value had won locally, but no commit had landed.
- A subsequent **Commit** action on the now-pending Change pushed the env value to `main` as commit `5353c0d1`. Only after this commit did `entity.yml` line 19 show the env value on the remote.
- The symmetric path: **Accept incoming changes** moves the item to `Updates (1)` and requires a subsequent **Pull** (the `PullChangesFromGit` action) to actually write the git value into the env.
- The eventual commit/pull is a **normal** commit/pull on top of the conflict point — no special "merge commit" semantics, no two-parent ancestry; just a flat linear commit recording the winning value.

**Action:**
- `resolve-conflicts` Phase 7 hand-back message must explicitly state the remaining work, not declare overall success: *"Resolved M conflicts. **Resolution alone does NOT push to git or pull to env.** Items resolved with Keep-Existing have moved to pending Changes — run `/power-pages:commit-to-git` to push them. Items resolved with Accept-Incoming have moved to pending Updates — run `/power-pages:sync-from-git` to pull them."*
- The `last-conflict-resolution.json` marker should include `pendingCommit: N` and `pendingPull: M` counts (sourced from `list-conflicts.js` re-query) so downstream skills can route automatically.
- `sync-from-git` Phase 4 (post-resolve-conflicts return path) must check both counts after the resolve sub-skill returns: if any Changes were created by Keep-Existing decisions, surface a follow-up prompt offering `commit-to-git` BEFORE proceeding with the pull half.

---

## §22 — Only `Check for updates` runs the full env-vs-git-tip diff that surfaces conflicts (2026-06)

**Common user perception:** *"Refresh updates the page — surely it also re-checks for conflicts."*

**Empirical reality** (tutorial run on `InternLearning`, 2026-06):
- After editing the env-side description AND committing a different value to `main` directly in ADO, clicking the maker-portal **Refresh** button kept the state at `Changes (1) / Updates (0) / Conflicts (0)` — the env-side pending change was visible but the incoming git edit was NOT.
- Only after clicking **Check for updates** did the page re-evaluate and produce `Changes (0) / Updates (0) / Conflicts (1)`.
- The two buttons map to different APIs:
  - **Refresh** ≈ re-queries `sourcecontrolcomponent` rows for env-side state. Cheap. Does not touch git.
  - **Check for updates** ≈ calls `RefreshChangesFromGit` action → fetches git tip → recomputes the full Changes / Updates / Conflicts triad.
- Conflicts will NEVER appear from a plain Refresh, no matter how many times you click it. This trips up users who edit one side and expect conflicts to "pop up" on the next page refresh.

**Action:**
- `sync-from-git` Phase 2 must call `RefreshChangesFromGit` (or equivalent helper) BEFORE asserting `conflicts.count` — relying on a stale env-side view would miss conflicts entirely.
- `resolve-conflicts` Phase 1 binding-check must run a fresh `RefreshChangesFromGit` before `list-conflicts.js`; if the skill is called directly without `sync-from-git` having just run, the conflict roster may be stale.
- User-facing error messages from `commit-to-git` and `sync-from-git` that mention "conflicts detected" should hint *"Run `Check for updates` (or `/power-pages:sync-from-git`) — Refresh alone does not detect cross-side conflicts."*

---

## §23 — Maker-portal "Keep current" / "Accept incoming" buttons require explicit row selection (2026-06)

**Common user expectation:** *"There's only one conflict — I'll just click Keep current."*

**Empirical reality** (Power Pages maker portal Source control → Conflicts tab, 2026-06):
- Both toolbar actions **Keep current changes** and **Accept incoming changes** appear **greyed out** until at least one conflict row is selected (either by clicking the row, ticking the row checkbox, or opening the row's ⋮ kebab menu).
- Multi-select (Shift+click / Ctrl+click) is supported and lets the maker apply the same strategy to a subset — e.g. Keep current on 3 specific rows while leaving 5 others for individual decisions.
- There is **no "Select all" toolbar button** on the Conflicts tab; selecting all rows requires manual click-through. For > 5 conflicts this becomes the gate that pushes users toward the skill-based bundled prompt (`resolve-conflicts` Phase 4 `> 3 conflicts` branch).

**Action:**
- `resolve-conflicts` skill operates via OData and bypasses this UI gate entirely — but its in-chat messages should NOT instruct users to "click Keep current in the maker portal" as a fallback without also saying *"select the conflicted row(s) first; the buttons stay disabled until you do."*
- `plan-inner-loop` advisory list for the **Conflicted** state should mention this UX so users who fall back to manual resolution don't get stuck staring at greyed buttons.
- This is purely a UX observation; no skill-level API call is affected.
