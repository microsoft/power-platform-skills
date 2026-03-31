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
            2. The user confirmed they linked the site setting to the env var via Power Pages Management UI
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

**Important API constraint**: The site setting → env var link (`mspp_environmentvariable` lookup) is NOT directly writable via OData API — the Power Pages server intentionally restricts this. This one step must be done via the Power Pages Management app UI. All other steps are fully automated.

## Prerequisites

- PAC CLI authenticated: `pac auth who`
- Azure CLI token available: `az account get-access-token`
- `.solution-manifest.json` exists in the project root (run `setup-solution` first)
- Power Pages site deployed to dev environment (`.powerpages-site/` folder exists)
- Power Pages Management app accessible (make.powerapps.com → your dev environment → Apps → Power Pages Management)

## Phase 1 — Discover Existing State

Read project context and query Dataverse to understand what's already configured.

**1.1 Read project files:**
```bash
cat .solution-manifest.json          # get solutionUniqueName, environmentUrl, publisher.prefix
cat .last-pipeline.json              # get hostEnvUrl, stages[].name
ls .powerpages-site/site-settings/   # list all site setting YAML files
```

**1.2 Acquire token for dev environment:**
```bash
DEV_ENV_URL=$(cat .solution-manifest.json | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');console.log(JSON.parse(d).environmentUrl)")
TOKEN=$(az account get-access-token --resource "$DEV_ENV_URL" --query accessToken -o tsv)
```

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

**3.1 Check if it already exists:**
```
GET {devEnvUrl}/api/data/v9.2/environmentvariabledefinitions?$filter=schemaname eq '{schemaName}'&$select=schemaname,environmentvariabledefinitionid
```

**3.2 Create if it doesn't exist:**
```
POST {devEnvUrl}/api/data/v9.2/environmentvariabledefinitions
Content-Type: application/json

{
  "schemaname": "ids_LocalLoginEnabled",
  "displayname": "IdeaSphere Local Login Enabled",
  "description": "Controls whether local login is enabled. true in dev, false in staging/prod.",
  "type": 100000000,
  "defaultvalue": "true"
}
```

Type values:
- `100000000` = String (use for all site settings — runtime resolves as string)
- `100000005` = Secret (for credentials — value stored in Azure Key Vault or encrypted)

Response: **HTTP 204** — extract GUID from `OData-EntityId` header.

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

## Phase 4 — Guide UI Linking Step

> **This step requires the Power Pages Management app.** The site setting → env var link cannot be set via OData API — it is handled by Power Pages' internal form save logic.

For each site setting to link, display step-by-step instructions:

---
**Action required in Power Pages Management:**

1. Open [Power Pages Management](https://make.powerapps.com) → select your **dev environment** → **Apps** → **Power Pages Management**
2. In the left nav, click **Site Settings**
3. Search for: `Authentication/Registration/LocalLoginEnabled`
4. Click on the record to open it
5. Change the **Source** field from `Static Value` to `Environment Variable`
6. In the **Environment Variable** lookup, type `ids_Local` and select **IdeaSphere Local Login Enabled**
7. Click **Save & Close**
8. Repeat for any other settings listed above

---

Ask via `AskUserQuestion`:
> "Have you completed the UI linking in Power Pages Management for all site settings listed above?
> 1. Yes — I've linked all settings, continue
> 2. I need more time — show the instructions again
> 3. Skip this setting — keep it as static"

**After user confirms:** Verify via OData that the link was applied:
```
GET {devEnvUrl}/api/data/v9.2/mspp_sitesettings?$filter=mspp_name eq 'Authentication/Registration/LocalLoginEnabled' and _mspp_websiteid_value eq {WEBSITE_ID}&$select=mspp_name,mspp_source,_mspp_environmentvariable_value
```

Expected: `mspp_source = 1` and `_mspp_environmentvariable_value = {envVarDefId}`.

If verification fails (source still 0), show the error and ask the user to retry.

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
| Phase 4 | Confirm UI linking completed | Yes / Need more time / Skip |
| Phase 7 | Review commit and next steps | Proceed / Adjust |

## Task Progress Table

| Task subject | activeForm | Description |
|---|---|---|
| Discover existing state | Discovering existing state | Read manifests, query Dataverse for existing env vars and already-linked site settings, list candidates |
| Plan environment variables | Planning environment variables | Ask user which site settings to back, collect schema names, types, dev and per-stage values |
| Create env var definitions | Creating env var definitions | POST environmentvariabledefinitions + environmentvariablevalues for each planned env var |
| Guide UI linking | Guiding UI linking step | Display Power Pages Management instructions; verify link via OData after user confirms |
| Add env vars to solution | Adding env vars to solution | AddSolutionComponent (type 380) for each env var definition |
| Generate deployment-settings.json | Generating deployment settings | Write deployment-settings.json with per-stage env var values |
| Verify and commit | Verifying and committing | Sync YAML, verify solution components, commit, present summary |
