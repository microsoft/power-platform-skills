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
1. Run `pac env who` — extract `environmentUrl`, `organizationId` (shown to user for confirmation)
2. Run `verify-alm-prerequisites.js` to confirm PAC CLI auth, acquire a token, and verify API access:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/verify-alm-prerequisites.js" --envUrl "{environmentUrl}"
   ```
   Capture output as JSON; extract `.envUrl` (store as `envUrl`) and `.token` (store as `token`). If the script exits non-zero, stop and explain what is missing (reference `${CLAUDE_PLUGIN_ROOT}/references/dataverse-prerequisites.md`).
3. Locate `powerpages.config.json` — read `siteName` and `websiteRecordId`
4. Confirm `.powerpages-site/` folder exists (required to find component records)
5. **Check for ALM plan context** — look for `.alm-plan-context.json` in the project root:
   - If found, ask via `AskUserQuestion`:
     > "An ALM plan was previously generated for this site. It includes a pre-classified list of site settings (keepAsIs, promoteToEnvVar, authNoValue, excluded). Would you like to use those choices, or re-discover and re-classify everything now?"
   - Options: **"Use pre-loaded choices from plan"** / **"Re-discover and re-classify"**
   - If user chooses pre-loaded: read `.alm-plan-context.json`, store the `siteSettings` object as `preloadedSettings`. When Step 5.3 is reached, **skip the query and classification logic** — use `preloadedSettings` directly.
   - If user chooses re-discover: proceed normally (Steps 5.3–5.4 query Dataverse and reclassify).

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
   (No dedicated script for publishers — query the OData endpoint directly.)
2. Check solution existence using `verify-solution-exists.js`:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/verify-solution-exists.js" \
     --envUrl "{envUrl}" \
     --uniqueName "{solutionUniqueName}" \
     --token "{token}"
   ```
   Capture output as JSON; check `.found` (boolean). If `found`, also read `.solutionId`, `.version`, and `.isManaged` for display.

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

2. **Create solution** (if not existing) using `create-solution.js`:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/create-solution.js" \
     --envUrl "{envUrl}" \
     --token "{token}" \
     --uniqueName "{solutionUniqueName}" \
     --friendlyName "{solutionFriendlyName}" \
     --version "{version}" \
     --publisherId "{publisherId}" \
     --description "Power Pages solution for {siteName}"
   ```
   Capture output as JSON; extract `.solutionId` (store as `solutionId`). On failure (non-zero exit or `created: false`): report error, stop.

3. Report: "Publisher `{name}` and solution `{name}` are ready."

### Phase 5 — Add Site Components

Refer to `${CLAUDE_PLUGIN_ROOT}/references/solution-api-patterns.md` for `AddSolutionComponent` body templates and `powerpagecomponents` discovery patterns.

#### Step 5.1 — Discover Component Types Dynamically

**Do not hardcode component type numbers.** Component type codes are environment-specific metadata and vary across tenants. Always resolve them at runtime using `discover-component-types.js`.

Run `discover-component-types.js` with the website record ID plus one sample powerpagecomponent ID and one site language ID (obtained from the preliminary discovery queries in Step 5.2 below — run those first if not yet available):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/discover-component-types.js" \
  --envUrl "{envUrl}" \
  --token "{token}" \
  --websiteRecordId "{websiteRecordId}" \
  --powerpageComponentId "{anyPowerpageComponentId}" \
  --siteLanguageId "{siteLanguageId}"
```
Capture output as JSON; extract `.websiteComponentType` (store as `websiteComponentType`), `.subComponentType` (store as `subComponentType`), and `.siteLanguageComponentType` (store as `siteLanguageComponentType`). Site language has its own distinct componenttype (~10375) — it is NOT included by `AddRequiredComponents: true` on the website and must be added explicitly.

If the script reports the website record is not yet in any solution, stop and inform the user that the site must be deployed (via `/power-pages:deploy-site`) before it can be solutionized. If `subComponentType` is absent (no sub-components indexed yet), proceed anyway — you will discover all component IDs in Step 5.2.

#### Step 5.2 — Discover All Components

Run six discovery queries in parallel:

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

**E. Cloud Flow link components (powerpagecomponenttype 33) — runtime field introspection:**

Query the `powerpagecomponent` records that link this site to Cloud Flows:
```
GET {envUrl}/api/data/v9.2/powerpagecomponents
  ?$filter=_powerpagesiteid_value eq '{websiteRecordId}' and powerpagecomponenttype eq 33
  &$select=powerpagecomponentid,name
```

If results are returned, fetch the first record **without** a `$select` to discover the workflow lookup field:
```
GET {envUrl}/api/data/v9.2/powerpagecomponents({firstComponentId})
```
Scan the response JSON for `_*_value` keys with non-null GUIDs that do not equal `websiteRecordId`. The remaining key is the workflow lookup field (e.g., `_adx_workflow_value`). Re-query all type-33 components with that field in `$select` to collect all backing `workflowId` GUIDs. Then resolve each workflow name and status:
```
GET {envUrl}/api/data/v9.2/workflows({workflowId})?$select=name,workflowid,statecode
```
Also discover the workflow's component type (for `AddSolutionComponent`):
```
GET {envUrl}/api/data/v9.2/solutioncomponents?$filter=objectid eq '{workflowId}'&$select=componenttype&$top=1
```
Store as `workflowComponentType`. If the query returns empty (flow not yet in any solution), note it — the backing flow record still exists and can be added.

If type-33 query returns no records, store `cloudFlows = []` and skip.

**F. Bot Consumer link components (powerpagecomponenttype 27) — runtime field introspection:**

Same pattern as Query E. Query type-27 `powerpagecomponent` records, discover the bot lookup field via introspection on the first record, collect bot GUIDs, resolve bot names via:
```
GET {envUrl}/api/data/v9.2/bots({botId})?$select=name,botid,statecode
```
And discover bot component type via `solutioncomponents`. Store as `botComponents`. If no type-27 records exist, store `botComponents = []` and skip.

#### Step 5.3 — Categorize Site Settings

**If `preloadedSettings` is available** (user chose "Use pre-loaded choices from plan" in Phase 1 Step 5), skip the classification below — use `preloadedSettings.keepAsIs`, `preloadedSettings.promoteToEnvVar`, `preloadedSettings.authNoValue`, and `preloadedSettings.excluded` directly.

**Otherwise**, classify each discovered Site Setting (powerpagecomponenttype=9) using this three-tier logic:

| Tier | Condition | Bucket | Handling |
|---|---|---|---|
| 1 — Credential secrets | Name matches `/ConsumerKey\|ConsumerSecret\|ClientId\|ClientSecret\|AppSecret\|AppKey\|ApiKey\|Password/i` | `excluded` | **Never** add to solution |
| 2a — Auth config with value | `Authentication/` or `AzureAD/` prefix AND NOT credential AND has a value | `promoteToEnvVar` | Present to user for review — may differ per environment |
| 2b — Auth config, no value | `Authentication/` or `AzureAD/` prefix AND NOT credential AND value is null/empty | `authNoValue` | Add to solution as-is with a note |
| 3 — All other settings | Does not match above | `keepAsIs` | Include in solution unchanged |

**Note on `authNoValue` settings**: These are auth configuration settings where no value has been set in the dev environment. They will be added to the solution as-is. After deploying to each target environment, the correct value should be configured there. Present these in a warning note box during the manifest review (Step 5.5).

#### Step 5.4 — Handle Auth Settings: Promote to Env Var?

Before presenting the final manifest, handle the three non-keepAsIs categories:

**A. `promoteToEnvVar` settings (auth config with values):**

Ask via `AskUserQuestion` with `multiSelect: true`, listing each `promoteToEnvVar` setting by name + current value:

> "These authentication configuration settings have values set in your dev environment. If any of them should have **different values per environment** (e.g., feature flags, login modes, AzureAD tenant settings), promote them to environment variables — they'll be tracked in the solution and injected per stage at deploy time. Leave others as plain site settings."

- One option per setting (e.g. `Authentication/Registration/LocalLoginEnabled = true`)
- Plus options: **"Promote all of them to env vars"** and **"Keep all as plain site settings"**

For each setting the user selects to promote:
1. Create an `environmentvariabledefinition` using `create-env-var-definition.js`:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/create-env-var-definition.js" \
     --envUrl "{envUrl}" \
     --token "{token}" \
     --schemaName "{prefix}_{sanitizedSettingName}" \
     --displayName "{friendlyName}" \
     --type 100000000
   ```
   Use type `100000000` (String) for auth config settings (not Secret — these are feature flags, not credentials). Schema name: replace `/` with `_`, lowercase, prefix with publisher prefix (e.g. `ids_authentication_registration_localloginenabled`). Capture output as JSON; extract `.definitionId` and `.schemaName`.
2. Record the `definitionId` for inclusion in the components list (Step 5.6, `ComponentType: 380`).
3. **Link the site setting to the env var** using `link-site-setting-to-env-var.js`:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/link-site-setting-to-env-var.js" \
     --envUrl "{envUrl}" \
     --token "{token}" \
     --siteSettingId "{settingId}" \
     --definitionId "{definitionId}" \
     --schemaName "{schemaName}"
   ```
   Check `.ok` and `.verified` are both `true`.

Settings the user chose NOT to promote move from `promoteToEnvVar` into `keepAsIs` — they will be included in the solution as plain site settings.

**B. `authNoValue` settings (auth config, no dev value):**

No user decision required. These are automatically included in the solution as-is. At Step 5.5, display them in a warning box:
> "The following auth settings have no value set in your dev environment. They will be added to the solution as-is. After deploying to each target environment, verify or set the correct value there."

**C. `excluded` settings (credential secrets):**

These are never added to the solution. At Step 5.5, display them in a neutral note box:
> "The following OAuth credential secrets are excluded from the solution and must be configured manually in each target environment after deployment."

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

CLOUD FLOWS ({N} linked via powerpagecomponent type 33)
  ✓ Invoice Approval Flow   (workflowId: {guid}, Active)
  ~ Draft Flow              (workflowId: {guid}, Inactive — excluded by default)

BOT CONSUMERS ({N} linked via powerpagecomponent type 27)
  ✓ Support Bot             (botId: {guid}, Active)

DATAVERSE TABLES (schema only — no data)
  ✓ crd50_invoice (Invoice)
  ...

ENV VAR DEFINITIONS (componenttype 380)
  ✓ ids_auth_openauth_microsoft_clientsecret (Secret)
  ...

Total to add: ~{N} components
```

If `cloudFlows` is non-empty, use `AskUserQuestion` with `multiSelect: true`:
- Option: "Include all N active cloud flows (Recommended)"
- One option per flow: `{name} ({workflowId})`
- Option: "Exclude all cloud flows"

Default: include active flows, exclude inactive ones. **If a flow is already in a different solution**, warn the user: *"This flow is in solution X — adding it here will move it."*

If `botComponents` is non-empty, use `AskUserQuestion` with `multiSelect: true` (same pattern).

If both are empty, skip and display `(None discovered)`.

After presenting the manifest summary, add a free-text escape hatch:
> "If you know of cloud flows or bots that should be in this solution but are not shown above, paste their GUIDs here (comma-separated). Leave blank to continue."

Ask via `AskUserQuestion`:
> "Does this look right? You can proceed, or tell me which categories or tables to exclude."

Options: "Proceed with this selection" / "I want to change something"

Wait for explicit confirmation before Step 5.6.

#### Step 5.6 — Add All Confirmed Components

Build a JSON array of all components to add, then call `scripts/lib/add-components-to-solution.js` to perform the bulk operation with token refresh and idempotency handling built in.

The components array should be built in this order:

1. **Website record** — `{ componentId: websiteRecordId, componentType: websiteComponentType, addRequired: true, description: "Website: {siteName}" }`
2. **Site language records** — one entry per language with `siteLanguageComponentType` (NOT auto-included by `AddRequiredComponents`)
3. **All confirmed powerpagecomponent groups** — one entry per component using `subComponentType`
   - Table Permissions (type 18) are standard powerpagecomponents — include by default
   - Exclude OAuth secret site settings that were not converted to env vars
4. **Env var definitions** (for converted OAuth secrets) — `{ componentType: 380 }`
5. **Dataverse tables** — `{ componentType: 1, componentId: MetadataId }`
6. **Confirmed cloud flows** (from Step 5.5) — `{ componentId: workflowId, componentType: workflowComponentType }` (uses runtime-discovered type)
7. **Confirmed bot components** — `{ componentId: botId, componentType: botComponentType }` (uses runtime-discovered type)

Write the array to a temp file (e.g., `C:/Users/{user}/AppData/Local/Temp/components-to-add.json`), then run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/add-components-to-solution.js" \
  --envUrl "{envUrl}" \
  --componentsFile "C:/Users/{user}/AppData/Local/Temp/components-to-add.json" \
  --solutionUniqueName "{solutionUniqueName}"
```

The script handles token refresh every 20 calls, treats "already in solution" as success, and outputs a JSON summary `{ total, success, skipped, failed, failures }`. Delete the temp file after completion.

### Phase 6 — Verify and Write Manifest

1. Verify components: `GET {envUrl}/api/data/v9.2/solutioncomponents?$filter=_solutionid_value eq '{solutionId}'&$select=objectid,componenttype`
2. Count components by type, confirm the website record (using `websiteComponentType`) is present

3. Write `.solution-manifest.json` to project root (alongside `powerpages.config.json`):
   - See manifest format in `${CLAUDE_PLUGIN_ROOT}/references/solution-api-patterns.md` Section 7
   - If cloud flows were confirmed, include a `cloudFlows` array: `[{ "workflowId": "...", "name": "...", "status": "active|inactive" }]`
   - If bot components were confirmed, include a `botComponents` array: `[{ "botId": "...", "name": "..." }]`
   - Omit these arrays entirely if no flows/bots were discovered or confirmed (absence = not tracked; `[]` = tracked but none selected)

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

**If any auth settings were promoted to env vars**, confirm that each site setting was automatically linked. Show a brief confirmation:

```
Auth settings promoted to environment variables:
  ✓ Authentication/Registration/LocalLoginEnabled → ids_authentication_registration_localloginenabled
  ✓ Authentication/Registration/AzureADLoginEnabled → ids_authentication_registration_azureadloginenabled
```

Note: Per-environment values must still be set via `configure-env-variables` or the Power Pages Management UI.

**If any `authNoValue` settings were included**, show a reminder:
```
Auth settings included without a dev value (configure in each target env after deploy):
  ⚠ Authentication/OpenAuth/Facebook/AppId
  ⚠ Authentication/Registration/LoginButtonAuthenticationType
```

**Ask what the user wants to do next** via `AskUserQuestion`:

> "How would you like to deploy this solution to other environments?"

Options:
1. **"Use Power Platform Pipelines (Recommended)"** — sets up a pipeline in the PP Pipelines host environment; supports staged deployments, approval gates, and env var overrides per stage.
2. **"Export and import manually"** — exports the solution as a zip and imports it directly to a target environment. Simpler for one-off deployments.
3. **"I'll decide later"** — shows next step suggestions and exits.

If the user selects **option 1**, immediately invoke `/power-pages:setup-pipeline`.
If the user selects **option 2**, immediately invoke `/power-pages:export-solution`.
If the user selects **option 3**, show:
- Run `/power-pages:setup-pipeline` for automated staged deployments
- Run `/power-pages:export-solution` to export a zip for manual import
- Run `/power-pages:configure-env-variables` if environment-specific values need to be set per stage

## Key Decision Points (Wait for User)

1. **Phase 2**: Publisher prefix confirmation — permanent, cannot be changed
2. **Phase 3**: Reuse vs create confirmation — before any writes
3. **Phase 1, Step 5**: ALM plan context — use pre-loaded site settings classification from plan-alm, or re-discover and reclassify
4. **Phase 5, Step 5.4**: Auth settings with values — multi-select which to promote to env vars vs keep as plain site settings (excluded credential secrets are never shown)
5. **Phase 5, Step 5.5**: Full manifest review — user sees everything (website, site language, all component categories, tables, env var definitions, authNoValue warnings) and confirms or adjusts before any components are written
5. **Phase 7**: Next step — PP Pipelines (recommended) vs export/import manually vs decide later

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
| Add site components to solution | Adding site components | Discover website/language/powerpagecomponents/tables/cloud flows (type 33)/bot consumers (type 27) via runtime field introspection; split site settings by category; present full manifest including CLOUD FLOWS and BOT CONSUMERS sections with active/inactive status; get user confirmation; call add-components-to-solution.js for website, site language(s), all confirmed components, tables (ComponentType=1), confirmed cloud flows, and confirmed bot components |
| Verify and write manifest | Verifying solution and writing manifest | Confirm components in solution, write .solution-manifest.json, commit |
| Present summary | Presenting summary | Show solution details, component count, and next steps |
