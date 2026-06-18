# Git Integration API Patterns

OData request body templates for Dataverse Git integration. Used by every helper in `scripts/lib/` that calls a Connect-to-Git endpoint, plus the inner-loop skills that compose them.

> **Auth.** All requests require `Authorization: Bearer <token>` and OData 4.0 headers. See `references/odata-common.md` for the full header set, token refresh cadence, and retry pattern (Azure CLI tokens are refreshed every ~20 mutating calls or ~60 seconds in this repo's helpers).
>
> **Endpoint version.** All Connect-to-Git endpoints live at `/api/data/v9.2/`. Earlier versions don't expose these actions.

---

## 1. `ConnectToGit` — environment binding

**Endpoint:** `POST {envUrl}/api/data/v9.2/ConnectToGit`

**Request body — environment binding (`ConnectionType = 1`):**

```json
{
  "GitFolder": "<folder>",
  "Branch": "<branch>",
  "ConnectionType": 1,
  "GitProvider": 0,
  "Organization": "<adoOrg>",
  "Project": "<adoProject>",
  "Repository": "<adoRepo>"
}
```

**Do NOT send** for env binding: `RootFolder`, `SolutionUniqueName`, `UpstreamBranch`.

**Response:** `204 No Content`. Failures return HTTP 4xx/5xx with a Dataverse error JSON body — see §7.

---

## 2. `ConnectToGit` — first solution binding

**Endpoint:** Same as §1.

**Request body — solution binding (`ConnectionType = 0`):**

```json
{
  "GitFolder": "<folder>",
  "Branch": "<branch>",
  "ConnectionType": 0,
  "GitProvider": 0,
  "Organization": "<adoOrg>",
  "Project": "<adoProject>",
  "Repository": "<adoRepo>",
  "RootFolder": "<rootFolder>",
  "SolutionUniqueName": "<solutionUniqueName>"
}
```

`RootFolder` is the parent folder where all solutions in this env will live (e.g. `solutions/`). Solutions sit at `<rootFolder>/<solutionUniqueName>/`.

---

## 3. `ConnectToGit` — subsequent solution binding

After the first solution-bound `ConnectToGit` succeeds, the connection inherits org/project/repo/rootfolder. Subsequent solutions need only:

```json
{
  "GitFolder": "<folder>",
  "Branch": "<branch>",
  "SolutionUniqueName": "<solutionUniqueName>"
}
```

Helper `connect-solution-to-git.js` detects which case applies by querying existing bindings via `detect-git-binding.js` first.

---

## 4. `DisconnectFromGit`

**Endpoint:** `POST {envUrl}/api/data/v9.2/DisconnectFromGit`

| Operation | Body | Notes |
|---|---|---|
| Disconnect single solution | `{ "SolutionUniqueName": "<name>" }` | Other solutions stay bound |
| Disconnect all solutions OR disconnect environment | `{}` (empty body) | Dataverse infers which from the current binding state |

**Response:** `204 No Content`.

---

## 5. `CommitToGit`

**Endpoint:** `POST {envUrl}/api/data/v9.2/CommitToGit`

**Request body:**

```json
{
  "CommitMessage": "<commit message>",
  "SolutionUniqueName": "<solutionUniqueName>"
}
```

**Return type:** `CommitToGitResponse` complex type — `{ CommitId: string, Type: int }`.

**Response:**

```http
HTTP/1.1 200 OK
Content-Type: application/json
{ "CommitId": "<sha>", "Type": 0 }
```

**Polling.** The platform may stream a series of file batches when the solution is large (see §9). Use `poll-git-operation.js` to:

- Re-poll the binding's pending Changes count until it's 0 (or the original count, on failure).
- Fetch the latest commit on the bound branch via `ado-get-commit.js` and verify `CommitId` matches.

**Idempotency.** Re-issuing `CommitToGit` with 0 pending Changes returns a non-2xx error (no-op). Helpers should pre-check pending count via `list-pending-changes.js`.

---

## 6. `RefreshChangesFromGit`

**Endpoint:** `POST {envUrl}/api/data/v9.2/RefreshChangesFromGit`

**Request body:**

```json
{
  "SolutionUniqueName": "<solutionUniqueName>"
}
```

**Response:** `204 No Content`.

**Semantics.** Queries the bound ADO branch and populates the Updates and Conflicts tabs in Dataverse. Does **not** apply any changes — it's a no-side-effect query/refresh. Always run before `PullChangesFromGit`.

**Polling.** After `RefreshChangesFromGit`, helpers `list-incoming-updates.js` and `list-conflicts.js` are eventually consistent — re-poll for up to ~30 seconds before reporting the counts.

---

## 7. `PullChangesFromGit`

**Endpoint:** `POST {envUrl}/api/data/v9.2/PullChangesFromGit`

**Request body — default:**

```json
{
  "SolutionUniqueName": "<solutionUniqueName>"
}
```

**Request body — hard-delete components that were removed in Git:**

```json
{
  "SolutionUniqueName": "<solutionUniqueName>",
  "AdditionalParameters": {
    "DeleteDeletedComponents": true
  }
}
```

**Response:** `204 No Content`.

> ⚠️ **`DeleteDeletedComponents`** wipes the components from the env outright. The default (false) only removes them from the solution, leaving the env-level rows alive. `sync-from-git` must surface a `consent` gate before flipping this flag — see `approval-gates.md` §6.

**Prerequisite:** Must run `RefreshChangesFromGit` first. If Conflicts > 0, `PullChangesFromGit` will fail — `resolve-conflicts` must run first.

---

## 8. Dataverse error JSON shape

All five actions return errors in the standard OData v4 error envelope:

```json
{
  "error": {
    "code": "0x80060001",
    "message": "<human-readable message>",
    "innererror": {
      "message": "<detailed cause>",
      "type": "<.NET exception type>",
      "stacktrace": "<server stack>"
    }
  }
}
```

Helpers should propagate `code` + `message` to the caller. The `diagnose-git-integration` skill pattern-matches on these codes against `inner-loop-error-catalog.md`.

---

## 9. The 17 MB per-file limit

Per [Microsoft Learn FAQ](https://learn.microsoft.com/power-platform/alm/git-integration/faqs#can-i-commit-large-solutions):

> Azure DevOps enforces a 17 MB limit per individual file during commit. Files are base64-encoded → effective limit ≈ 25 MB raw becomes ~17 MB on-the-wire.
>
> For multi-file solutions, the platform automatically splits commits into batches and squash-merges. **A single file > 17 MB will still fail.**

Detection lives in `validate-file-sizes.js` (pre-flight, before `CommitToGit`). The validator must compute the base64-encoded size, not the raw file size, when comparing against the cap.

---

## 10. HAR-verification status

Every payload in this doc is sourced from public Microsoft Learn pages (Git API reference, action references). Behaviors *not* covered by public docs and that need HAR verification on a real tenant before GA:

- [ ] Polling semantics for `CommitToGit` when commits are split into batches — what status surface confirms "all batches done"?
- [ ] Exact eventual-consistency window for `RefreshChangesFromGit` → Updates tab populated
- [ ] Error code emitted when `PullChangesFromGit` is called with unresolved Conflicts
- [ ] Whether `GitProvider = 1` (GitHub) is GA or preview-flighted
- [ ] Whether `UpstreamBranch` accepts a remote ref (`refs/remotes/...`) or just a branch name

Each unverified item is flagged `// TODO: HAR-verify` in the matching helper.

---

## 11. References

- [ConnectToGit Action](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/connecttogit)
- [DisconnectFromGit Action](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/disconnectfromgit)
- [CommitToGit Action](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/committogit)
- [CommitToGitResponse complex type](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/committogitresponse)
- [RefreshChangesFromGit Action](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/refreshchangesfromgit)
- [PullChangesFromGit Action](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/pullchangesfromgit)
- [PullChangesFromGitParameters complex type](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/pullchangesfromgitparameters)
- [Connect and disconnect by using code](https://learn.microsoft.com/power-platform/alm/git-integration/git-api)
- [Source control operations](https://learn.microsoft.com/power-platform/alm/git-integration/source-control-operations)
