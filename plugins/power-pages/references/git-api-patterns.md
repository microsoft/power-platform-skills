# Git Integration API Patterns

OData request body templates for Dataverse Native Git integration operations. Used by `git-connect`, `git-commit`, and `git-pull` skills.

> **Auth**: All requests require `Authorization: Bearer <token>` and `OData-Version: 4.0` headers. See `references/odata-common.md` for full header set and retry patterns.

---

## 1. Check Git Connection

**Endpoint**: `GET {envUrl}/api/data/v9.2/sourcecontrolconfigurations?$top=10`

**Success response**: `200 OK` with JSON body containing an array of source control configurations.

**Key fields**:
- `repositoryurl`: Full URL of the connected Git repository.
- `branchname`: Branch the solution is connected to.
- `status`: Connection status (active, disconnected, etc.).
- `modifiedon`: Last modified timestamp.
- `_solutionid_value`: GUID of the connected solution (lookup field).

**Example response shape**:
```json
{
  "@odata.context": "...",
  "value": [
    {
      "repositoryurl": "https://dev.azure.com/org/project/_git/repo",
      "branchname": "main",
      "status": 1,
      "modifiedon": "2026-01-15T10:30:00Z",
      "_solutionid_value": "00000000-0000-0000-0000-000000000000"
    }
  ]
}
```

---

## 2. List Git Organizations

**Endpoint**: `GET {envUrl}/api/data/v9.2/gitorganizations`

**Success response**: `200 OK` with array of organizations the environment has access to.

**Key fields**:
- Organization name and ID.

> **Note**: This is a virtual entity. Do not use `$select` — it often fails on virtual entities. Fetch all columns and filter client-side.

---

## 3. List Git Projects

**Endpoint**: `GET {envUrl}/api/data/v9.2/gitprojects?$filter=organizationname eq '{orgName}'`

**Key fields**:
- `organizationname`: Filter by organization name (string, NOT a GUID).
- `projectname`: Name of the project.

> **Important**: The `$filter` uses the string name `organizationname`, not an ID or GUID.

---

## 4. List Git Repositories

**Endpoint**: `GET {envUrl}/api/data/v9.2/gitrepositories?$filter=organizationname eq '{orgName}' and projectname eq '{projectName}'`

**Key fields**:
- `organizationname`: String name of the organization.
- `projectname`: String name of the project.
- `repositoryname`: Name of the repository.

---

## 5. List Git Branches

**Endpoint**: `GET {envUrl}/api/data/v9.2/gitbranches?$filter=organizationname eq '{orgName}' and projectname eq '{projectName}' and repositoryname eq '{repoName}'`

**Key fields**:
- `organizationname`: String name of the organization.
- `projectname`: String name of the project.
- `repositoryname`: String name of the repository.
- `branchname`: Name of the branch.

---

## 6. ConnectToGit

**Endpoint**: `POST {envUrl}/api/data/v9.2/ConnectToGit`

**Request body**:
```json
{
  "SolutionUniqueName": "ContosoSite",
  "Organization": "myorg",
  "Project": "myproject",
  "Repository": "myrepo",
  "Branch": "main",
  "GitFolder": "/",
  "GitProvider": 0,
  "ConnectionType": 0
}
```

**Key fields**:
- `SolutionUniqueName`: The unique name of the solution to connect.
- `Organization`: String NAME of the ADO organization (not a GUID).
- `Project`: String NAME of the ADO project (not a GUID).
- `Repository`: String NAME of the repository (not a GUID).
- `Branch`: Branch name to connect to (e.g., `"main"`).
- `GitFolder`: Folder path within the repo. Use `"/"` for root.
- `GitProvider`: `0` = Azure DevOps, `1` = GitHub.
- `ConnectionType`: `0` = standard connection.

**Success response**: `204 No Content`.

> **Timing**: This operation may take up to **2 minutes** to complete. The environment contacts the Git provider, validates access, and performs initial sync.

---

## 7. CommitToGit

**Endpoint**: `POST {envUrl}/api/data/v9.2/CommitToGit`

**Request body**:
```json
{
  "SolutionUniqueName": "ContosoSite",
  "CommitMessage": "Updated site settings and web templates"
}
```

**Key fields**:
- `SolutionUniqueName`: The unique name of the connected solution.
- `CommitMessage`: Commit message describing the changes.

**Success response**: `204 No Content`.

> **Timing**: This operation may take up to **60 seconds**. The environment serializes pending changes and pushes a commit to the connected branch.

---

## 8. RefreshChangesFromGit

**Endpoint**: `POST {envUrl}/api/data/v9.2/RefreshChangesFromGit`

**Request body**:
```json
{
  "SolutionUniqueName": "ContosoSite"
}
```

**Key fields**:
- `SolutionUniqueName`: The unique name of the connected solution.

**Success response**: `204 No Content`.

> **Timing**: Takes **10-30 seconds**. Contacts the Git provider (ADO/GitHub) to check for new commits on the connected branch. Does NOT import changes — use `PullChangesFromGit` after refreshing.

---

## 9. PullChangesFromGit

**Endpoint**: `POST {envUrl}/api/data/v9.2/PullChangesFromGit`

**Request body**:
```json
{
  "SolutionUniqueName": "ContosoSite"
}
```

**Key fields**:
- `SolutionUniqueName`: The unique name of the connected solution.

**Success response**: `204 No Content`.

> **Timing**: This operation may take **1-5 minutes**. Imports components from Git into the environment. Run `RefreshChangesFromGit` first to detect available updates.

---

## 10. DisconnectFromGit

**Endpoint**: `POST {envUrl}/api/data/v9.2/DisconnectFromGit`

**Request body**:
```json
{
  "SolutionUniqueName": "ContosoSite"
}
```

**Key fields**:
- `SolutionUniqueName`: The unique name of the solution to disconnect.

**Success response**: `204 No Content`.

---

## 11. Query Pending Changes (for Commit)

**Endpoint**: `GET {envUrl}/api/data/v9.2/sourcecontrolcomponents?$filter=action eq 1`

**Key fields**:
- `name`: Display name of the component.
- `componenttype`: Type of the component (web page, site setting, etc.).
- `action`: `1` = pending commit (local changes not yet pushed to Git).

**Use case**: Call before `CommitToGit` to show the user which components have local changes that will be included in the commit.

---

## 12. Query Available Updates (for Pull)

**Endpoint**: `GET {envUrl}/api/data/v9.2/sourcecontrolcomponents?$filter=action eq 2`

**Key fields**:
- `name`: Display name of the component.
- `componenttype`: Type of the component.
- `action`: `2` = available from Git (remote changes not yet pulled into the environment).

**Use case**: Call after `RefreshChangesFromGit` to show the user which components have updates available from Git before running `PullChangesFromGit`.

**Check for conflicts**: Components may have conflicting states (both local changes and remote changes). Query for components that appear in both `action eq 1` and `action eq 2` results to detect conflicts before committing or pulling.

---

## Known Gotchas

1. **Virtual entity filters use string names, NOT GUIDs.** The `gitorganizations`, `gitprojects`, `gitrepositories`, and `gitbranches` entities filter on `organizationname`, `projectname`, `repositoryname` — all string values. Passing GUIDs will return empty results with no error.

2. **ConnectToGit uses string names for Organization/Project/Repository params, NOT GUIDs.** Despite other Dataverse APIs often using GUIDs, the `ConnectToGit` action expects the display names as strings.

3. **`$select` often does not work on virtual entities.** Omit `$select` when querying `gitorganizations`, `gitprojects`, `gitrepositories`, and `gitbranches`. Fetch all columns and filter client-side.

4. **Template literal `$` in backtick strings causes `$select`/`$filter` to disappear.** In JavaScript, `` `${envUrl}/api/data/v9.2/entities?$filter=...` `` will interpret `$filter` as a template variable (undefined). Use string concatenation instead: `envUrl + "/api/data/v9.2/entities?$filter=..."`.

5. **WSL Node.js cannot reach crm.dynamics.com over VPN.** WSL networking does not route through the Windows VPN adapter. Use Windows Node.js (`/mnt/c/Program Files/nodejs/node.exe`) for all Dataverse API calls.
