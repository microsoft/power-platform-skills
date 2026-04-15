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

For **site language records**, query using the site language ID:
```
GET {envUrl}/api/data/v9.2/solutioncomponents?$filter=objectid eq '{siteLanguageId}'&$select=componenttype&$top=1
```
Store result as `siteLanguageComponentType`. Site language has its own distinct componenttype (~10375) — it is NOT included by `AddRequiredComponents: true` on the website and must be added explicitly.

If the website record query returns an empty `value` array, the site has not been added to any solution yet — stop and inform the user that the site must be deployed (via `/power-pages:deploy-site`) before it can be solutionized. If the sub-component query returns empty, proceed anyway — you will discover all component IDs in Step 5.2.

#### Step 5.2 — Discover All Components

Run four discovery queries in parallel:

**A. Component type labels** (for display names):
```
GET {envUrl}/api/data/v9.2/GlobalOptionSetDefinitions(Name='powerpagecomponenttype')
```
Build a `typeLabel` map: `{ [Value]: Label.UserLocalizedLabel.Label }`. Fall back to the static table in `${CLAUDE_PLUGIN_ROOT}/references/solution-api-patterns.md` Section 3b if this fails.

**B. All Power Pages sub-components for this site**:
```
GET {envUrl}/api/data/v9.2/powerpagecomponents
  ?$filter=_powerpagesiteid_value eq '{websiteRecordId}'
  &$select=powerpagecomponentid,name,powerpagecomponenttype
  &$orderby=powerpagecomponenttype
```
Follow `@odata.nextLink` pagination. Group by `powerpagecomponenttype` using `typeLabel` for display names.

**C. Site language records**:
```
GET {envUrl}/api/data/v9.2/powerpagesitelanguages?$filter=_powerpagesiteid_value eq '{websiteRecordId}'&$select=powerpagesitelanguageid,languagecode,displayname
```
Store all language IDs.

**D. Dataverse tables** — always discover from the environment, don't rely on a manifest file alone:

1. Read `.datamodel-manifest.json` if present (for the known list of tables created by `setup-datamodel`)
2. **Also** query the environment directly for all custom unmanaged tables, filtering by the publisher prefix:
```
GET {envUrl}/api/data/v9.2/EntityDefinitions?$select=LogicalName,MetadataId,IsManaged,IsCustomEntity
```
Filter client-side: `IsCustomEntity === true && IsManaged === false`. Group by publisher prefix (characters before first `_`). Present only tables whose prefix matches the site publisher — or if no prefix match, present all custom unmanaged tables and let the user decide.

> **Important note on tables**: Dataverse solutions carry **schema only** — entity definitions, columns, relationships, forms, and views. Table **data/records** do NOT travel with the solution. If the target environment needs seed/reference data, that requires a separate data migration step.

#### Step 5.3 — Categorize Site Settings

Site Settings (powerpagecomponenttype=9) have distinct security profiles. Split them before presenting:

| Category | Name pattern | Default |
|---|---|---|
| Web API settings | `Webapi/*` | **Include** — required for Web API to work in target env |
| Feature flags | `CodeSite/*`, `Search/*`, `Site/*`, `Profile/*`, `Header/*`, `Footer/*`, `ThemeFeature`, `HTTP/*`, `SiteCopilot/*`, `CustomerSupport/*`, `KnowledgeManagement/*`, `MultiLanguage/*`, `OnlineDomains` | **Include** — safe |
| Auth config (non-secret) | `Authentication/Registration/*`, `Authentication/OpenIdConnect/*/Caption`, `Authentication/LoginThrottling/*`, `Authentication/LoginTrackingEnabled`, `Authentication/OpenIdConnect/*/RebrandDisclaimerEnabled` | **Include** — safe |
| OAuth secrets | Any setting whose name contains `Secret`, `ClientSecret`, `AppSecret`, `ConsumerSecret`, `AppId`, `ConsumerKey` (social provider credentials) | **Exclude by default** |

#### Step 5.4 — OAuth Secrets: Convert to Environment Variables?

Before presenting the final manifest, handle the excluded OAuth secrets. These settings won't travel in the solution — but the user can choose to convert any or all of them to environment variables instead, so they are tracked in the solution schema and injected per environment at deploy time.

**Ask via `AskUserQuestion` with `multiSelect: true`**, listing each excluded OAuth secret by name:

> "These OAuth secret site settings will be excluded from the solution. Select any you'd like to convert to environment variables instead (env var definitions will be added to the solution; you'll link each one via the Power Pages Management UI after). Leave all unselected to just exclude them."

- One option per secret (e.g. `Authentication/OpenAuth/Microsoft/ClientSecret`)
- Plus options: **"Convert all of them"** and **"Exclude all (don't convert any)"**

For each secret the user selects to convert:
1. Create an `environmentvariabledefinition` via OData POST:
   ```
   POST {envUrl}/api/data/v9.2/environmentvariabledefinitions
   { "schemaname": "{prefix}_{sanitizedSettingName}", "displayname": "{friendlyName}", "type": 100000003, "defaultvalue": "" }
   ```
   Use type `100000003` (Secret) so the value is stored encrypted. Schema name: take the setting name, replace `/` with `_`, lowercase, prefix with publisher prefix (e.g. `ids_auth_openauth_microsoft_clientsecret`).
2. Add the env var definition to the solution (`ComponentType: 380`).
3. **Link the site setting to the env var via OData PATCH** (HAR-confirmed pattern — no UI step required):
   ```
   PATCH {envUrl}/api/data/v9.0/mspp_sitesettings({settingId})
   Headers: if-match: *, clienthost: Browser, x-ms-app-name: mspp_PowerPageManagement
   Body: {
     "mspp_envvar_schema": "{schemaName}",
     "EnvironmentValue@odata.bind": "/environmentvariabledefinitions({definitionId})",
     "EnvironmentValue@OData.Community.Display.V1.FormattedValue": "{schemaName}",
     "mspp_source": 1
   }
   ```
   **Critical:** Must use v9.0 (not v9.2). Navigation property is `EnvironmentValue` (not `mspp_environmentvariable`). Must include `if-match: *` and `clienthost: Browser` headers — omitting them causes 400.
4. Verify the link: GET the site setting and confirm `mspp_source === 1` and `_mspp_environmentvariable_value` matches the definition ID.
5. Record each created env var definition ID and setting ID in the manifest.

OAuth secrets the user chose NOT to convert remain excluded — they are simply not added to the solution.

#### Step 5.5 — Present Full Manifest and Get User Confirmation

**This is the key decision point.** Build a full manifest of everything that will be added and present it to the user before writing anything.

If custom tables were discovered, ask via `AskUserQuestion` with `multiSelect: true` **before** showing the final manifest:
- First option: **"Include all N tables (Recommended)"** — pre-selected default
- Then one option per table: `{logicalName} ({DisplayName})`
- Last option: **"Exclude all tables"**

Present as a structured summary:

```
Here is everything that will be added to solution "{solutionName}":

WEBSITE & LANGUAGE
  ✓ Website record: {siteName}
  ✓ Site language(s): English (en-US)

SITE COMPONENTS ({total} components across {K} types)
  ✓ Publishing States (2)
  ✓ Web Pages (10)
  ✓ Web Files (90)         — compiled JS/CSS/HTML assets
  ✓ Page Templates (5)
  ✓ Web Templates (13)
  ✓ Content Snippets (11)
  ✓ Web Roles (2)
  ✓ Website Access (6)
  ✓ Table Permissions (13) — required for Web API authorization in target env
  ✓ Site Markers (5)
  ✓ Webpage Rules (2)

SITE SETTINGS (64 included)
  ✓ Web API settings (14):   Webapi/crd50_invoice/enabled, ...
  ✓ Feature flags (32):      CodeSite/Enabled, Search/Enabled, ...
  ✓ Auth config (18):        Authentication/Registration/LocalLoginEnabled, ...
  ~ OAuth as env vars (3):   ids_auth_openauth_microsoft_clientsecret, ... [ENV VAR]
  ✗ OAuth excluded (5):      Authentication/OpenAuth/Facebook/AppSecret, ... [EXCLUDED]

DATAVERSE TABLES (schema only — no data)
  ✓ crd50_invoice (Invoice)
  ...

ENV VAR DEFINITIONS (componenttype 380)
  ✓ ids_auth_openauth_microsoft_clientsecret (Secret)
  ...

Total to add: ~{N} components
```

Ask via `AskUserQuestion`:
> "Does this look right? You can proceed, or tell me which categories or tables to exclude."

Options: "Proceed with this selection" / "I want to change something"

Wait for explicit confirmation before Step 5.6.

#### Step 5.6 — Add All Confirmed Components

1. **Website record** — `AddSolutionComponent` with `websiteComponentType`, `AddRequiredComponents: true`
2. **Site language records** — `AddSolutionComponent` for each with `siteLanguageComponentType` (NOT auto-included by AddRequiredComponents)
3. **All confirmed powerpagecomponent groups** — for each group, call `AddSolutionComponent` per component using `subComponentType`
   - Table Permissions (type 18) are standard powerpagecomponents — include by default
   - Exclude OAuth secret site settings that were not converted to env vars
4. **Env var definitions** (for converted OAuth secrets) — `AddSolutionComponent` with `ComponentType: 380`
5. **Dataverse tables** — `AddSolutionComponent` with `ComponentType: 1` and entity `MetadataId`
6. Refresh token every ~20 calls
7. Track: success / skipped-duplicate / failed
8. Running progress: "Added 45 of 120 components..."

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
| Env var definitions added | N (if any OAuth secrets converted) |
| Manifest written | `.solution-manifest.json` |

**If any OAuth secrets were converted to env vars**, confirm that each site setting was automatically linked (source=1, envvar ID set). Show a brief confirmation:

```
OAuth secrets linked to environment variables:
  ✓ Authentication/OpenAuth/Microsoft/ClientSecret → ids_auth_openauth_microsoft_clientsecret
  ✓ Authentication/OpenAuth/Twitter/ConsumerSecret → ids_auth_openauth_twitter_consumersecret
```

Note: Secret values themselves must still be set per environment (in Power Pages Management or via `configure-env-variables`).

**Ask how the user wants to deploy this solution** via `AskUserQuestion`:

> "Your solution is ready. How would you like to deploy it to other environments?"

Options:
1. **"Use Power Platform Pipelines (Recommended)"** — sets up a pipeline in the PP Pipelines host environment; supports staged deployments, approval gates, and env var overrides per stage. Run `/power-pages:setup-pipeline` next.
2. **"Export and import manually"** — exports the solution as a zip and imports it directly to a target environment. Simpler for one-off deployments. Run `/power-pages:export-solution` next.
3. **"I'll decide later"** — shows next step suggestions and exits.

If the user selects **option 1**, immediately invoke `/power-pages:setup-pipeline`.
If the user selects **option 2**, immediately invoke `/power-pages:export-solution`.
If the user selects **option 3**, show:
- Run `/power-pages:setup-pipeline` for automated staged deployments (recommended)
- Run `/power-pages:export-solution` to export a zip for manual import
- Run `/power-pages:configure-env-variables` if environment-specific values need to be set per stage

## Key Decision Points (Wait for User)

1. **Phase 2**: Publisher prefix confirmation — permanent, cannot be changed
2. **Phase 3**: Reuse vs create confirmation — before any writes
3. **Phase 5, Step 5.4**: OAuth secrets — multi-select which (if any) to convert to env vars vs exclude entirely
4. **Phase 5, Step 5.5**: Full manifest review — user sees everything (website, site language, all component categories, tables, env var definitions) and confirms or adjusts before any components are written
5. **Phase 7**: Deployment path — PP Pipelines (recommended) vs export/import manually vs decide later

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
| Add site components to solution | Adding site components | Discover website/language/powerpagecomponents/tables, split site settings by category, present full manifest for user confirmation, then call AddSolutionComponent for website, site language(s), all confirmed components, and tables (ComponentType=1) |
| Verify and write manifest | Verifying solution and writing manifest | Confirm components in solution, write .solution-manifest.json, commit |
| Present summary | Presenting summary | Show solution details, component count, and next steps |
