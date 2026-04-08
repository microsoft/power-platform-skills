---
name: configure-env-variables
description: >-
  Configures environment variables for Power Pages site settings to support ALM across environments.
  Creates environment variable definitions in Dataverse, guides the user through linking site settings
  to those variables via the Power Pages Management app, adds the variables to the solution, and
  generates a deployment-settings.json file with per-stage override values.
  Use when asked to: "configure environment variables", "add env vars", "set up deployment variables",
  "make site settings environment-specific", "configure ALM variables", "set up env-specific settings",
  "add deployment settings", "configure per-environment settings".
user-invocable: true
argument-hint: "Optional: site setting name or env var schema name to pre-select"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
hooks:
  Stop:
    - hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/configure-env-variables/scripts/validate-env-variables.js"'
          timeout: 30
        - type: prompt
          prompt: |
            Check whether the configure-env-variables skill completed successfully. Return { "ok": true } if ALL of the following are true, otherwise { "ok": false, "reason": "..." }:
            1. At least one environment variable definition was created or confirmed in Dataverse
            2. Each selected site setting was linked to its env var definition via link-site-setting-to-env-var.js (verified: ok and verified both true)
            3. The env var was added to the solution via AddSolutionComponent
            4. deployment-settings.json was written with at least one stage's EnvironmentVariables entry
            5. A completion summary was presented
          timeout: 30
---

# configure-env-variables

Creates and links Dataverse environment variables to Power Pages site settings, enabling different configuration values per deployment environment (dev vs staging vs prod). Generates `deployment-settings.json` for use by `deploy-pipeline`.

## Background

Power Pages site settings can be backed by environment variables (GA March 2025, enhanced data model only). When linked:
- The site setting's `mspp_source` changes from `0` (static) to `1` (environment variable)
- The runtime reads the env var value for the current environment instead of the static `mspp_value`
- During pipeline deployment, target-environment values are injected via `deploymentsettingsjson`

**API note**: The site setting → env var link is set via a HAR-confirmed OData PATCH pattern (v9.0, `EnvironmentValue` nav property, `if-match: *` and `clienthost: Browser` headers required). This is handled by `scripts/lib/link-site-setting-to-env-var.js`. All steps are fully automated.

## Prerequisites

- PAC CLI authenticated: `pac auth who`
- Azure CLI token available: `az account get-access-token`
- `.solution-manifest.json` exists in the project root (run `setup-solution` first)
- Power Pages site deployed to dev environment (`.powerpages-site/` folder exists)

## Phase 1 — Discover Existing State

Read project context and query Dataverse to understand what's already configured.

**1.1 Read project files:**
```bash
cat .solution-manifest.json          # get solutionUniqueName, environmentUrl, publisher.prefix
cat .last-pipeline.json              # get hostEnvUrl, stages[].name
ls .powerpages-site/site-settings/   # list all site setting YAML files
```

**1.2 Acquire token and verify prerequisites:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/verify-alm-prerequisites.js" \
  --envUrl "{devEnvUrl}" \
  --require-manifest
```
Capture output as JSON; extract `.envUrl` (store as `devEnvUrl`) and `.token` (store as `TOKEN`).

**1.3 Query existing env vars in the environment:**
```
GET {devEnvUrl}/api/data/v9.2/environmentvariabledefinitions?$select=schemaname,displayname,type,defaultvalue,environmentvariabledefinitionid&$orderby=schemaname
```

**1.4 Query site settings that already have env vars linked (`mspp_source = 1`):**
```
GET {devEnvUrl}/api/data/v9.2/mspp_sitesettings?$filter=mspp_source eq 1 and _mspp_websiteid_value eq {WEBSITE_ID}&$select=mspp_name,mspp_source,_mspp_environmentvariable_value,mspp_envvar_schema
```

Get `WEBSITE_ID` from `.powerpages-site/website.yml` → `id` field.

**1.5 Parse site setting YAML files** to list all settings and their current source:
- Files with `source: 1` are already env-var-backed
- Files with `source: 0` or no source field are static

Present a summary table to the user:
```
Current site settings (static):   48
Already env-var-backed:             3
Existing env var definitions:       2
```

## Phase 2 — Select Site Settings and Plan Env Vars

Ask the user which site settings should be backed by environment variables. Present the list of static site settings as candidates. Recommend settings that are likely to vary per environment:

**Common candidates:**
- `Authentication/OpenIdConnect/AzureAD/ClientId` — Entra ID app registration differs per env
- `Authentication/OpenAuth/Microsoft/ClientId` — OAuth app ID
- `Authentication/OpenAuth/Microsoft/ClientSecret` — OAuth secret (use Secret type)
- `Authentication/Registration/LocalLoginEnabled` — may differ in dev vs prod
- Any `Authentication/Registration/OpenRegistrationEnabled` — open sign-up policy
- Custom site settings the user has added

Ask via `AskUserQuestion`:
> "Which site settings should be backed by environment variables? I'll create an env var for each and guide you through linking them.
>
> Here are the candidates (enter numbers, comma-separated):
> 1. Authentication/Registration/LocalLoginEnabled (currently: true)
> 2. Authentication/OpenIdConnect/AzureAD/ClientId (currently: empty)
> 3. [other settings...]
> N. I'll type my own setting names"

For each selected setting, ask for:
1. **Env var schema name** (suggest `{publisherPrefix}_{CamelCaseName}`, e.g. `ids_LocalLoginEnabled`)
2. **Display name** (human-readable)
3. **Type**: String (default), Boolean, Number, Secret
4. **Dev/source value** (default = current `mspp_value` from YAML)
5. **Per-stage values** — for each stage in `.last-pipeline.json`, what should the value be?

Example:
```
Setting: Authentication/Registration/LocalLoginEnabled
  Schema name: ids_LocalLoginEnabled
  Display name: IdeaSphere Local Login Enabled
  Type: String (site settings always resolve as strings)
  Dev value: true
  Staging value: false
  Production value: false
```

## Phase 3 — Create Environment Variable Definitions

For each planned env var:

**3.1 Check and create if needed** using `create-env-var-definition.js` (the script checks for an existing definition by `schemaName` before posting):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/create-env-var-definition.js" \
  --envUrl "{devEnvUrl}" \
  --token "{TOKEN}" \
  --schemaName "{schemaName}" \
  --displayName "{displayName}" \
  --type {typeCode} \
  --defaultValue "{devValue}"
```

Type codes:
- `100000000` = String (use for all site settings — runtime resolves as string)
- `100000005` = Secret (for credentials — value stored in Azure Key Vault or encrypted)

Capture output as JSON; extract `.definitionId` (store as `envVarDefId`) and check `.created` (true = newly created, false = already existed). If already existed, confirm the existing definition matches expectations before proceeding.

**3.3 Create the current-environment value** (the live dev value, separate from defaultvalue):
```
POST {devEnvUrl}/api/data/v9.2/environmentvariablevalues
Content-Type: application/json

{
  "EnvironmentVariableDefinitionId@odata.bind": "/environmentvariabledefinitions({envVarDefId})",
  "value": "true"
}
```

Response: **HTTP 204**.

Track created env var IDs: `{ schemaName, envVarDefId, siteSettingName, devValue, stageValues: { stageName: value } }`.

## Phase 4 — Link Site Settings to Env Vars

For each site setting to link, run `link-site-setting-to-env-var.js` (HAR-confirmed PATCH via v9.0 API — no UI step required):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/link-site-setting-to-env-var.js" \
  --envUrl "{devEnvUrl}" \
  --token "{TOKEN}" \
  --siteSettingId "{siteSettingId}" \
  --definitionId "{envVarDefId}" \
  --schemaName "{schemaName}"
```
Capture output as JSON; check `.ok` and `.verified` are both `true`. The script applies the PATCH with the required `if-match: *` and `clienthost: Browser` headers and then verifies `mspp_source === 1` and `_mspp_environmentvariable_value` matches the definition ID.

If `.ok` is `false` or `.verified` is `false`, report the error and ask the user:
> "Linking `{settingName}` to env var `{schemaName}` failed. How would you like to proceed?
> 1. Retry
> 2. Skip this setting — keep it as static
> 3. Cancel"

## Phase 5 — Add Env Vars to Solution

For each env var definition, add it to the solution:

```
POST {devEnvUrl}/api/data/v9.2/AddSolutionComponent
Content-Type: application/json

{
  "ComponentId": "{envVarDefId}",
  "ComponentType": 380,
  "SolutionUniqueName": "IdeaSphereSolution",
  "AddRequiredComponents": false,
  "DoNotIncludeSubcomponents": false
}
```

Response: **HTTP 200** with `{ "id": "..." }`.

> **Note**: Do NOT add `environmentvariablevalues` records to the solution — those are environment-specific and must stay local to each environment. Only the definition (type 380) goes in the solution.

Verify the env var appears in solution components:
```
GET {devEnvUrl}/api/data/v9.2/solutioncomponents?$filter=_solutionid_value eq {solutionId} and componenttype eq 380&$select=objectid
```

## Phase 6 — Generate deployment-settings.json

Write `deployment-settings.json` to the project root. This file stores per-stage environment variable override values and is read by `deploy-pipeline`.

```json
{
  "$schema": "https://schemas.microsoft.com/power-platform/deployment-settings/2024",
  "description": "Per-stage environment variable values for IdeaSphereSolution pipeline deployments. Commit this file. Do not store secrets here — use Secret type env vars backed by Key Vault instead.",
  "stages": {
    "Deploy to Staging": {
      "EnvironmentVariables": [
        {
          "SchemaName": "ids_LocalLoginEnabled",
          "Value": "false"
        }
      ],
      "ConnectionReferences": []
    }
  }
}
```

Stage names must match exactly the `stages[].name` values in `.last-pipeline.json`.

For Secret-type env vars: write `"Value": ""` and add a comment instructing the user to populate via Azure Key Vault or pipeline secrets — never store raw secrets in this file.

## Phase 7 — Verify and Commit

**7.1 Sync site settings YAML** — run `pac pages upload-code-site` to push the updated site settings (with `source: 1` now visible in Dataverse) back to the YAML:
```bash
pac pages upload-code-site --rootPath "." --environment {devEnvUrl}
```

After upload, check the updated YAML file — it should now contain `source: 1` and reference the env var schema name.

**7.2 Verify solution contains env var:**
```
GET {devEnvUrl}/api/data/v9.2/solutioncomponents?$filter=_solutionid_value eq {solutionId} and componenttype eq 380
```

**7.3 Commit:**
```bash
git add .powerpages-site/site-settings/ deployment-settings.json
git commit -m "Configure env vars: {list of schema names} — link {setting names} to env vars for ALM"
```

**7.4 Present summary:**

```
✅ Environment variables configured

Env vars created/confirmed:
  ids_LocalLoginEnabled → Authentication/Registration/LocalLoginEnabled
    Dev value: true
    Staging: false

Added to solution: IdeaSphereSolution (1 env var component)

deployment-settings.json written with:
  Stage "Deploy to Staging": ids_LocalLoginEnabled = false

Next steps:
  1. Run /power-pages:export-solution to export the updated solution
  2. Run /power-pages:deploy-pipeline — it will automatically read deployment-settings.json
     and inject the env var values during deployment
  3. After deployment, verify in staging: the Sign In button should be hidden
     (Authentication/Registration/LocalLoginEnabled = false)
```

## Key Decision Points (Wait for User)

| Phase | Decision | Options |
|---|---|---|
| Phase 2 | Which site settings to back with env vars | Select from list |
| Phase 2 | Env var schema names, types, per-stage values | Enter for each |
| Phase 4 | Retry / skip / cancel on link failure | Retry / Skip / Cancel |
| Phase 7 | Review commit and next steps | Proceed / Adjust |

## Task Progress Table

| Task subject | activeForm | Description |
|---|---|---|
| Discover existing state | Discovering existing state | Read manifests, query Dataverse for existing env vars and already-linked site settings, list candidates |
| Plan environment variables | Planning environment variables | Ask user which site settings to back, collect schema names, types, dev and per-stage values |
| Create env var definitions | Creating env var definitions | POST environmentvariabledefinitions + environmentvariablevalues for each planned env var |
| Link site settings to env vars | Linking site settings | Run link-site-setting-to-env-var.js for each setting; verify .ok and .verified from output |
| Add env vars to solution | Adding env vars to solution | AddSolutionComponent (type 380) for each env var definition |
| Generate deployment-settings.json | Generating deployment settings | Write deployment-settings.json with per-stage env var values |
| Verify and commit | Verifying and committing | Sync YAML, verify solution components, commit, present summary |
