---
name: setup-solution
description: >-
  Creates a Dataverse publisher and solution, then adds Power Pages site components to
  the solution for ALM and deployment management. Use when asked to: "create solution",
  "set up solution", "add to solution", "package site into solution", "create publisher",
  "solutionize my site", or "set up ALM for my site".
user-invocable: true
argument-hint: "Optional: solution unique name (e.g., 'ContosoSite')"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
hooks:
  Stop:
    - hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/setup-solution/scripts/validate-solution.js"'
          timeout: 30
        - type: prompt
          prompt: |
            Check whether the setup-solution skill completed successfully. Return { "ok": true } if ALL of the following are true, otherwise { "ok": false, "reason": "..." }:
            1. A Dataverse publisher was verified or created (publisherId captured)
            2. A Dataverse solution was verified or created (solutionId captured)
            3. The Power Pages website component was added to the solution (component type discovered dynamically, not hardcoded)
            4. A .solution-manifest.json file was written to the project root
            5. A completion summary was presented showing solution details and component count
          timeout: 30
---

# setup-solution

Creates a Dataverse publisher and solution, then adds Power Pages site components. Writes `.solution-manifest.json` for use by `export-solution`, `import-solution`, and `setup-pipeline` skills.

## Prerequisites

- PAC CLI installed and authenticated (`pac env who` returns an environment URL)
- Azure CLI installed and logged in (`az account show` succeeds)
- `powerpages.config.json` exists in the project root (site must be deployed at least once so `.powerpages-site/` exists with component records)

## Phases

### Phase 1 — Verify Prerequisites

**Create all tasks upfront at the start of this phase.**

Tasks to create:
1. "Verify prerequisites"
2. "Gather solution configuration"
3. "Check existing publishers and solutions"
4. "Create publisher and solution"
5. "Add site components to solution"
6. "Verify and write manifest"
7. "Present summary"

Steps:
1. Run `pac env who` — extract `environmentUrl`, `organizationId`
2. Run `az account get-access-token --resource "{environmentUrl}" --query accessToken -o tsv` — capture token
3. Verify API access: `GET {environmentUrl}/api/data/v9.2/WhoAmI` — confirm 200 response
4. Locate `powerpages.config.json` — read `siteName` and `websiteRecordId`
5. Confirm `.powerpages-site/` folder exists (required to find component records)

If any check fails, stop and explain what is missing (reference `${CLAUDE_PLUGIN_ROOT}/references/dataverse-prerequisites.md`).

### Phase 2 — Gather Solution Configuration

Ask user (via `AskUserQuestion`) for:

1. **Publisher unique name** (e.g., `contoso`) — lowercase letters/numbers only, no spaces. **Explain this is permanent and cannot be changed.**
2. **Publisher friendly name** (e.g., `Contoso`) — display name
3. **Publisher prefix** (e.g., `con`) — 2–8 lowercase letters, prefixed to all components. **Explain this is permanent and cannot be changed.**
4. **Solution unique name** (e.g., `ContosoSite`) — letters/numbers/underscores, no spaces
5. **Solution friendly name** (e.g., `Contoso Site`) — display name
6. **Solution version** (default: `1.0.0.0`) — must be `major.minor.build.revision` format

Present a confirmation summary of all values and wait for user approval before proceeding.

> **Key Decision Point**: Publisher prefix and publisher unique name are **irreversible** — pause and explicitly confirm with the user before proceeding.

### Phase 3 — Check Existing State

Before creating anything, check if publisher and solution already exist:

1. Query publisher: `GET {envUrl}/api/data/v9.2/publishers?$filter=uniquename eq '{publisherUniqueName}'&$select=publisherid,uniquename,customizationprefix`
2. Query solution: `GET {envUrl}/api/data/v9.2/solutions?$filter=uniquename eq '{solutionUniqueName}'&$select=solutionid,uniquename,version,ismanaged`

Report findings to user:
- If publisher exists: "Found existing publisher `{name}` (prefix: `{prefix}`). Will reuse it."
- If solution exists: "Found existing solution `{name}` version `{version}`. Will reuse it and add components."
- If neither exists: "Will create new publisher and solution."

Wait for user confirmation before proceeding.

### Phase 4 — Create Publisher and Solution

Refer to `${CLAUDE_PLUGIN_ROOT}/references/solution-api-patterns.md` for exact request body templates.

1. **Create publisher** (if not existing):
   - `POST {envUrl}/api/data/v9.2/publishers` with publisher body
   - Extract `publisherId` from `OData-EntityId` response header
   - On failure: report error, stop (do not proceed to solution creation)

2. **Create solution** (if not existing):
   - `POST {envUrl}/api/data/v9.2/solutions` with solution body linking to publisher
   - Extract `solutionId` from `OData-EntityId` response header
   - On failure: report error, stop

3. Report: "Publisher `{name}` and solution `{name}` are ready."

### Phase 5 — Add Site Components

Refer to `${CLAUDE_PLUGIN_ROOT}/references/solution-api-patterns.md` for `AddSolutionComponent` body templates and `powerpagecomponents` discovery patterns.

#### Step 5.1 — Discover Component Types Dynamically

**Do not hardcode component type numbers.** Component type codes are environment-specific metadata and vary across tenants. Always resolve them at runtime by querying `solutioncomponents` for a known objectId and reading back the `componenttype` field.

For the **website record**, query:
```
GET {envUrl}/api/data/v9.2/solutioncomponents?$filter=objectid eq '{websiteRecordId}'&$select=componenttype&$top=1
```
Store result as `websiteComponentType`.

For **all sub-components** (web pages, web files, web roles, site settings, templates, etc.), query using any one `powerpagecomponentid` from the site:
```
GET {envUrl}/api/data/v9.2/solutioncomponents?$filter=objectid eq '{anyPowerpageComponentId}'&$select=componenttype&$top=1
```
Store result as `subComponentType`.

If the website record query returns an empty `value` array, the site has not been added to any solution yet — stop and inform the user that the site must be deployed (via `/power-pages:deploy-site`) before it can be solutionized. If the sub-component query returns empty, proceed anyway — you will discover all component IDs in Step 5.2.

#### Step 5.2 — Fetch Component Type Labels and All Site Components

**First**, resolve current component type labels from the environment's metadata — this ensures the label map is always up to date regardless of new types Microsoft adds:
```
GET {envUrl}/api/data/v9.2/GlobalOptionSetDefinitions(Name='powerpagecomponenttype')
```
From the response, build a `typeLabel` map: `{ [Value]: Label.UserLocalizedLabel.Label }` for every entry in `Options`. If this query fails or returns an unexpected structure, fall back to the static table in `${CLAUDE_PLUGIN_ROOT}/references/solution-api-patterns.md` Section 3b.

**Then**, query all Power Pages sub-components for this site:
```
GET {envUrl}/api/data/v9.2/powerpagecomponents
  ?$filter=_powerpagesiteid_value eq '{websiteRecordId}'
  &$select=powerpagecomponentid,name,powerpagecomponenttype
  &$orderby=powerpagecomponenttype
```

Follow `@odata.nextLink` pagination until all pages are fetched. Group results by `powerpagecomponenttype`, count per group, and use `typeLabel[type]` for display. For any type not found in `typeLabel`, display it as `Unknown (N)`.

#### Step 5.3 — User Selection: Which Categories to Include

Present the grouped summary and ask the user which categories to include. All non-sensitive types are pre-selected (default: include). Site Settings (type 9) require explicit opt-in due to security risk.

Example output format:
```
Found {N} Power Pages components across {K} categories:
  ✓ Publishing States (2), Web Pages (10), Web Files (8), Weblink Sets (2),
    Weblinks (2), Page Templates (4), Content Snippets (11), Web Templates (13),
    Webpage Rules (2), Web Roles (3), Website Access (2), Site Markers (5)
  ⚠ Site Settings (49) — may include OAuth secrets (ClientSecret, AppSecret, etc.)
    Recommended: EXCLUDE from solution to avoid moving credentials across environments.
```

Ask via `AskUserQuestion`: "Include Site Settings in the solution?" — Options: "Yes, include them" / "No, exclude them (Recommended)"

Default: **exclude** site settings.

#### Step 5.4 — Add All Selected Components

1. **Website record** — call `AddSolutionComponent` with `websiteComponentType` and `AddRequiredComponents: true`
2. **All selected sub-components** — for each `powerpagecomponenttype` group the user selected, call `AddSolutionComponent` for every component in that group using `subComponentType`
3. Refresh token every ~20 calls to avoid expiration
4. Track results per component: success / skipped-duplicate / failed
5. Present running progress (e.g., "Added 45 of 98 components...")

### Phase 6 — Verify and Write Manifest

1. Verify components: `GET {envUrl}/api/data/v9.2/solutioncomponents?$filter=_solutionid_value eq '{solutionId}'&$select=objectid,componenttype`
2. Count components by type, confirm the website record (using `websiteComponentType`) is present

3. Write `.solution-manifest.json` to project root (alongside `powerpages.config.json`):
   - See manifest format in `${CLAUDE_PLUGIN_ROOT}/references/solution-api-patterns.md` Section 7

4. Commit: `git add .solution-manifest.json && git commit -m "Add solution manifest for ALM"`

### Phase 7 — Present Summary

Display a summary table:

| Item | Value |
|---|---|
| Publisher | `{friendlyName}` (`{uniqueName}`, prefix: `{prefix}`) |
| Solution | `{friendlyName}` (`{uniqueName}`, v`{version}`) |
| Solution ID | `{solutionId}` |
| Components added | N |
| Manifest written | `.solution-manifest.json` |

**Suggested next steps**:
- Run `/power-pages:export-solution` to package the solution for deployment
- Run `/power-pages:setup-pipeline` to create a CI/CD pipeline

## Key Decision Points (Wait for User)

1. **Phase 2**: Publisher prefix confirmation — permanent, cannot be changed
2. **Phase 3**: Reuse vs create confirmation — before any writes
3. **Phase 5, Step 5.3**: Whether to include Site Settings (type 9) — default is exclude due to OAuth secrets

## Error Handling

- If publisher creation fails with "duplicate" error: re-query and use existing publisher
- If solution creation fails with "duplicate" error: re-query and use existing solution
- If `AddSolutionComponent` returns "already in solution": treat as success (idempotent)
- Never attempt rollback on failure — report what succeeded and what failed

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| Verify prerequisites | Verifying prerequisites | Confirm PAC CLI auth, acquire Azure CLI token, verify API access, locate powerpages.config.json |
| Gather solution configuration | Gathering solution configuration | Collect publisher name, prefix, solution name, version from user — confirm irreversible choices |
| Check existing publishers and solutions | Checking existing state | Query Dataverse for existing publisher and solution to avoid duplicate creation |
| Create publisher and solution | Creating publisher and solution | POST publisher and solution to Dataverse OData API, capture IDs |
| Add site components to solution | Adding site components | Discover all powerpagecomponents, present grouped summary, ask about site settings, call AddSolutionComponent for website record and all selected sub-components |
| Verify and write manifest | Verifying solution and writing manifest | Confirm components in solution, write .solution-manifest.json, commit |
| Present summary | Presenting summary | Show solution details, component count, and next steps |
