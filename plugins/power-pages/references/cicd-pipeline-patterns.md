# CI/CD Pipeline Patterns

Reference patterns for generating CI/CD pipelines for Power Pages deployments. Used by the `setup-pipeline` skill.

---

## Service Principal Authentication (PAC CLI)

Both ADO and GitHub Actions pipelines authenticate PAC CLI using a service principal (app registration).

### Prerequisites (manual steps — cannot be automated)
1. Create an app registration in Entra ID (Azure AD)
2. Add the app as a **System Administrator** or **Power Pages Site Owner** in each target environment (Power Platform Admin Center → Environments → Settings → Users → App Users)
3. Store credentials as secrets in ADO or GitHub

### PAC CLI Auth Command

```bash
pac auth create \
  --applicationId "$APP_ID" \
  --clientSecret "$CLIENT_SECRET" \
  --tenant "$TENANT_ID" \
  --environment "$ENV_URL" \
  --name "pipeline-auth"
```

For certificate-based auth (more secure, recommended for production):
```bash
pac auth create \
  --applicationId "$APP_ID" \
  --certificateThumbprint "$CERT_THUMBPRINT" \
  --tenant "$TENANT_ID" \
  --environment "$ENV_URL"
```

### Power Pages Upload Step

```bash
pac pages upload-code-site --rootPath "."
```

This command uploads the compiled site from the `compiledPath` defined in `powerpages.config.json`. Always run `npm run build` before this step.

---

## Azure DevOps Pipeline (azure-pipelines.yml)

### Full ADO Pipeline Template

```yaml
# azure-pipelines.yml
# Power Pages CI/CD Pipeline
# Requires pipeline variables: APP_ID, CLIENT_SECRET, TENANT_ID
# Requires environment-specific variables: DEV_ENV_URL, STAGING_ENV_URL, PROD_ENV_URL

trigger:
  branches:
    include:
      - main
      - release/*

pr:
  branches:
    include:
      - main

variables:
  nodeVersion: '20.x'
  # Solution export/import variables (uncomment if using solution-based deployment)
  # SOLUTION_NAME: 'ContosoSite'

stages:

  # ─── Build ────────────────────────────────────────────────────────────────
  - stage: Build
    displayName: 'Build'
    jobs:
      - job: BuildSite
        displayName: 'Build Power Pages Site'
        pool:
          vmImage: 'ubuntu-latest'
        steps:
          - task: NodeTool@0
            inputs:
              versionSpec: '$(nodeVersion)'
            displayName: 'Install Node.js'

          - script: npm ci
            displayName: 'Install dependencies'

          - script: npm run build
            displayName: 'Build site'

          - task: PublishPipelineArtifact@1
            inputs:
              targetPath: 'dist'
              artifact: 'site-build'
            displayName: 'Publish build artifact'

  # ─── Deploy to Dev ─────────────────────────────────────────────────────────
  - stage: DeployDev
    displayName: 'Deploy to Dev'
    dependsOn: Build
    condition: succeeded()
    jobs:
      - deployment: DeployToDev
        displayName: 'Deploy to Dev Environment'
        environment: 'dev'
        pool:
          vmImage: 'ubuntu-latest'
        strategy:
          runOnce:
            deploy:
              steps:
                - task: DownloadPipelineArtifact@2
                  inputs:
                    artifact: 'site-build'
                    path: 'dist'

                - script: |
                    dotnet tool install --global Microsoft.PowerApps.CLI.Tool 2>/dev/null || true
                    pac auth create \
                      --applicationId "$(APP_ID)" \
                      --clientSecret "$(CLIENT_SECRET)" \
                      --tenant "$(TENANT_ID)" \
                      --environment "$(DEV_ENV_URL)"
                    pac pages upload-code-site --rootPath "."
                  displayName: 'Deploy to Dev'
                  env:
                    APP_ID: $(APP_ID)
                    CLIENT_SECRET: $(CLIENT_SECRET)
                    TENANT_ID: $(TENANT_ID)
                    DEV_ENV_URL: $(DEV_ENV_URL)

  # ─── Deploy to Staging ─────────────────────────────────────────────────────
  - stage: DeployStaging
    displayName: 'Deploy to Staging'
    dependsOn: DeployDev
    condition: and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/main'))
    jobs:
      - deployment: DeployToStaging
        displayName: 'Deploy to Staging Environment'
        environment: 'staging'
        # Add an approval check in ADO: Environments → staging → Approvals and checks
        pool:
          vmImage: 'ubuntu-latest'
        strategy:
          runOnce:
            deploy:
              steps:
                - task: DownloadPipelineArtifact@2
                  inputs:
                    artifact: 'site-build'
                    path: 'dist'

                - script: |
                    dotnet tool install --global Microsoft.PowerApps.CLI.Tool 2>/dev/null || true
                    pac auth create \
                      --applicationId "$(APP_ID)" \
                      --clientSecret "$(CLIENT_SECRET)" \
                      --tenant "$(TENANT_ID)" \
                      --environment "$(STAGING_ENV_URL)"
                    pac pages upload-code-site --rootPath "."
                  displayName: 'Deploy to Staging'
                  env:
                    APP_ID: $(APP_ID)
                    CLIENT_SECRET: $(CLIENT_SECRET)
                    TENANT_ID: $(TENANT_ID)
                    STAGING_ENV_URL: $(STAGING_ENV_URL)

  # ─── Deploy to Production ──────────────────────────────────────────────────
  - stage: DeployProd
    displayName: 'Deploy to Production'
    dependsOn: DeployStaging
    condition: and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/main'))
    jobs:
      - deployment: DeployToProduction
        displayName: 'Deploy to Production Environment'
        environment: 'production'
        # Add an approval check in ADO: Environments → production → Approvals and checks
        pool:
          vmImage: 'ubuntu-latest'
        strategy:
          runOnce:
            deploy:
              steps:
                - task: DownloadPipelineArtifact@2
                  inputs:
                    artifact: 'site-build'
                    path: 'dist'

                - script: |
                    dotnet tool install --global Microsoft.PowerApps.CLI.Tool 2>/dev/null || true
                    pac auth create \
                      --applicationId "$(APP_ID)" \
                      --clientSecret "$(CLIENT_SECRET)" \
                      --tenant "$(TENANT_ID)" \
                      --environment "$(PROD_ENV_URL)"
                    pac pages upload-code-site --rootPath "."
                  displayName: 'Deploy to Production'
                  env:
                    APP_ID: $(APP_ID)
                    CLIENT_SECRET: $(CLIENT_SECRET)
                    TENANT_ID: $(TENANT_ID)
                    PROD_ENV_URL: $(PROD_ENV_URL)

# ─── Solution Export/Import (uncomment to enable solution-based deployment) ──
# Add these stages between Build and DeployDev if using Dataverse solutions:
#
#   - stage: ExportSolution
#     dependsOn: Build
#     jobs:
#       - job: ExportSolution
#         steps:
#           - script: |
#               pac auth create --applicationId "$(APP_ID)" --clientSecret "$(CLIENT_SECRET)" --tenant "$(TENANT_ID)" --environment "$(DEV_ENV_URL)"
#               pac solution export --name "$(SOLUTION_NAME)" --path ./solutions --async
#             displayName: 'Export solution from Dev'
#           - task: PublishPipelineArtifact@1
#             inputs:
#               targetPath: 'solutions'
#               artifact: 'solution'
#
#   - stage: ImportSolution
#     dependsOn: ExportSolution
#     jobs:
#       - job: ImportSolution
#         steps:
#           - task: DownloadPipelineArtifact@2
#             inputs:
#               artifact: 'solution'
#               path: 'solutions'
#           - script: |
#               pac auth create --applicationId "$(APP_ID)" --clientSecret "$(CLIENT_SECRET)" --tenant "$(TENANT_ID)" --environment "$(STAGING_ENV_URL)"
#               pac solution import --path ./solutions/$(SOLUTION_NAME).zip --async
#             displayName: 'Import solution to Staging'
```

### ADO Pipeline Variables Setup

Set these as secret pipeline variables in ADO (Pipelines → Library → Variable Groups, or per-pipeline Variables):

| Variable | Description | Secret? |
|---|---|---|
| `APP_ID` | Service principal Application (client) ID | Yes |
| `CLIENT_SECRET` | Service principal client secret | Yes |
| `TENANT_ID` | Azure AD tenant ID | No |
| `DEV_ENV_URL` | Dev environment URL (e.g., `https://contoso-dev.crm.dynamics.com`) | No |
| `STAGING_ENV_URL` | Staging environment URL | No |
| `PROD_ENV_URL` | Production environment URL | No |

### ADO Manual Steps Required

> **IMPORTANT**: These steps cannot be automated from Claude and must be done manually in the ADO portal:

1. **Create service connection** (optional but recommended): ADO Project → Project Settings → Service Connections → New service connection → Azure Resource Manager
2. **Add approval gates**: ADO → Pipelines → Environments → `staging` → Approvals and checks → Add approval → specify approvers
3. **Add approval gates for production**: same for `production` environment
4. **Grant pipeline permission to agent pool**: ADO → Project Settings → Agent Pools → select pool → Security → grant pipeline access
5. **Grant pipeline permission to environments**: ADO → Pipelines → Environments → select environment → Security → grant pipeline access

---

## GitHub Actions Workflow (.github/workflows/deploy.yml)

### Full GitHub Actions Template

```yaml
# .github/workflows/deploy.yml
# Power Pages CI/CD Workflow
# Requires repository secrets: APP_ID, CLIENT_SECRET, TENANT_ID
# Requires environment secrets: DEV_ENV_URL, STAGING_ENV_URL, PROD_ENV_URL

name: Deploy Power Pages Site

on:
  push:
    branches: [main, 'release/**']
  pull_request:
    branches: [main]
  workflow_dispatch:

env:
  NODE_VERSION: '20.x'
  # SOLUTION_NAME: 'ContosoSite'  # Uncomment if using solution-based deployment

jobs:

  # ─── Build ────────────────────────────────────────────────────────────────
  build:
    name: Build Site
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build site
        run: npm run build

      - name: Upload build artifact
        uses: actions/upload-artifact@v4
        with:
          name: site-build
          path: dist/
          retention-days: 5

  # ─── Deploy to Dev ─────────────────────────────────────────────────────────
  deploy-dev:
    name: Deploy to Dev
    runs-on: ubuntu-latest
    needs: build
    environment: dev
    if: github.event_name != 'pull_request'
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Download build artifact
        uses: actions/download-artifact@v4
        with:
          name: site-build
          path: dist/

      - name: Install PAC CLI
        run: dotnet tool install --global Microsoft.PowerApps.CLI.Tool

      - name: Authenticate PAC CLI
        run: |
          pac auth create \
            --applicationId "${{ secrets.APP_ID }}" \
            --clientSecret "${{ secrets.CLIENT_SECRET }}" \
            --tenant "${{ secrets.TENANT_ID }}" \
            --environment "${{ vars.DEV_ENV_URL }}"

      - name: Deploy to Dev
        run: pac pages upload-code-site --rootPath "."

  # ─── Deploy to Staging ─────────────────────────────────────────────────────
  deploy-staging:
    name: Deploy to Staging
    runs-on: ubuntu-latest
    needs: deploy-dev
    environment: staging
    # GitHub environment protection rules handle approvals
    # Configure at: Settings → Environments → staging → Protection rules
    if: github.ref == 'refs/heads/main'
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Download build artifact
        uses: actions/download-artifact@v4
        with:
          name: site-build
          path: dist/

      - name: Install PAC CLI
        run: dotnet tool install --global Microsoft.PowerApps.CLI.Tool

      - name: Authenticate PAC CLI
        run: |
          pac auth create \
            --applicationId "${{ secrets.APP_ID }}" \
            --clientSecret "${{ secrets.CLIENT_SECRET }}" \
            --tenant "${{ secrets.TENANT_ID }}" \
            --environment "${{ vars.STAGING_ENV_URL }}"

      - name: Deploy to Staging
        run: pac pages upload-code-site --rootPath "."

  # ─── Deploy to Production ──────────────────────────────────────────────────
  deploy-prod:
    name: Deploy to Production
    runs-on: ubuntu-latest
    needs: deploy-staging
    environment: production
    # GitHub environment protection rules handle approvals
    # Configure at: Settings → Environments → production → Protection rules
    if: github.ref == 'refs/heads/main'
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Download build artifact
        uses: actions/download-artifact@v4
        with:
          name: site-build
          path: dist/

      - name: Install PAC CLI
        run: dotnet tool install --global Microsoft.PowerApps.CLI.Tool

      - name: Authenticate PAC CLI
        run: |
          pac auth create \
            --applicationId "${{ secrets.APP_ID }}" \
            --clientSecret "${{ secrets.CLIENT_SECRET }}" \
            --tenant "${{ secrets.TENANT_ID }}" \
            --environment "${{ vars.PROD_ENV_URL }}"

      - name: Deploy to Production
        run: pac pages upload-code-site --rootPath "."

# ─── Solution Export/Import (uncomment to enable solution-based deployment) ──
# Add these jobs between build and deploy-dev if using Dataverse solutions:
#
#  export-solution:
#    needs: build
#    runs-on: ubuntu-latest
#    steps:
#      - uses: actions/checkout@v4
#      - run: dotnet tool install --global Microsoft.PowerApps.CLI.Tool
#      - run: |
#          pac auth create --applicationId "${{ secrets.APP_ID }}" --clientSecret "${{ secrets.CLIENT_SECRET }}" --tenant "${{ secrets.TENANT_ID }}" --environment "${{ vars.DEV_ENV_URL }}"
#          mkdir -p solutions
#          pac solution export --name "${{ env.SOLUTION_NAME }}" --path ./solutions --async
#      - uses: actions/upload-artifact@v4
#        with:
#          name: solution
#          path: solutions/
#
#  import-solution:
#    needs: export-solution
#    runs-on: ubuntu-latest
#    environment: staging
#    steps:
#      - uses: actions/download-artifact@v4
#        with: { name: solution, path: solutions/ }
#      - run: dotnet tool install --global Microsoft.PowerApps.CLI.Tool
#      - run: |
#          pac auth create --applicationId "${{ secrets.APP_ID }}" --clientSecret "${{ secrets.CLIENT_SECRET }}" --tenant "${{ secrets.TENANT_ID }}" --environment "${{ vars.STAGING_ENV_URL }}"
#          pac solution import --path "./solutions/${{ env.SOLUTION_NAME }}.zip" --async
```

### GitHub Actions Secrets & Variables Setup

**Repository Secrets** (Settings → Secrets and variables → Actions → Secrets):

| Secret | Description |
|---|---|
| `APP_ID` | Service principal Application (client) ID |
| `CLIENT_SECRET` | Service principal client secret |
| `TENANT_ID` | Azure AD tenant ID |

**Environment Variables** (Settings → Environments → {env name} → Environment variables):

| Variable | Dev | Staging | Prod |
|---|---|---|---|
| `DEV_ENV_URL` | `https://contoso-dev.crm.dynamics.com` | — | — |
| `STAGING_ENV_URL` | — | `https://contoso-staging.crm.dynamics.com` | — |
| `PROD_ENV_URL` | — | — | `https://contoso.crm.dynamics.com` |

### GitHub Actions Manual Steps Required

> **IMPORTANT**: These steps cannot be automated and must be done in GitHub:

1. **Create environments**: Settings → Environments → New environment (create `dev`, `staging`, `production`)
2. **Add protection rules for staging**: Settings → Environments → staging → Protection rules → Required reviewers → add approvers
3. **Add protection rules for production**: same for `production`
4. **Add secrets**: Settings → Secrets and variables → Actions → New repository secret (for APP_ID, CLIENT_SECRET, TENANT_ID)
5. **Add environment variables**: Settings → Environments → {env} → Add environment variable (for ENV_URL per environment)

---

## Power Platform Pipelines — API Patterns

HAR-confirmed patterns for creating and running Power Platform Pipelines via the Dataverse OData API. Used by the `setup-pipeline` (PP Pipelines path) and `deploy-pipeline` skills.

All API calls target the **host environment** URL — never the source or target environment URLs. Auth token is obtained via `az account get-access-token --resource {hostEnvOrigin} --query accessToken -o tsv`.

### API Version Matrix

| Operation | API Version |
|---|---|
| Create/update records, Action calls | `v9.0` |
| List queries, `RetrieveDeploymentPipelineInfo` | `v9.1` |
| `RetrieveSetting` | `v9.2` |

### Host Environment Discovery

Call `RetrieveSetting` from the **dev environment** to find the tenant's configured Pipelines host:

```
GET {devEnvUrl}/api/data/v9.2/RetrieveSetting(SettingName='DefaultCustomPipelinesHostEnvForTenant')
Authorization: Bearer {devEnvToken}
OData-MaxVersion: 4.0
OData-Version: 4.0
Accept: application/json
```

Returns `{ "SettingValue": "{BAP-environment-GUID}" }` or empty/null if no default is configured.

Cross-reference the GUID with `pac env list` output to find the host environment URL:

```bash
pac env list --output json 2>/dev/null
```

Match on `EnvironmentId` field. If no match, probe each environment from `pac env list` with:

```
GET {envUrl}/api/data/v9.1/deploymentpipelines?$top=0
```

Environments that return 200 (not 404) have the Pipelines package installed.

### Get BAP Environment ID

The `deploymentenvironments` entity requires the **BAP environment ID** (a GUID), not the Dataverse organization ID. Get it from `pac env list` output field `EnvironmentId`, or from `pac env who` output. This is different from the Dataverse `organizationid`.

### Pipeline Setup — 5-Step Flow

#### Step 1 — Create Deployment Environment Records

Create one record per environment (source dev + each target):

```
POST {hostUrl}/api/data/v9.0/deploymentenvironments
Content-Type: application/json
Authorization: Bearer {hostEnvToken}

{
  "name": "{siteName} Development",
  "environmentid": "{BAP-environment-GUID}",
  "environmenttype": 200000000
}
```

> **`environmenttype` values**: `200000000` = source/development, `200000001` = target. This field is required — omitting it causes a 400 error.

> **Response**: Most creates (deploymentenvironments, deploymentpipelines, deploymentstages) return **204** — parse the created record ID from the `OData-EntityId` response header. `deploymentstageruns` POST returns **201** (newer host package — ID in JSON body) or **204** (older package — ID in `OData-EntityId` header). Always implement both paths: try body first, fall back to header.

#### Step 2 — Poll validationstatus

After creating each `deploymentenvironment`, poll until validation completes:

```
GET {hostUrl}/api/data/v9.1/deploymentenvironments({id})?$select=validationstatus
```

Poll until `validationstatus = 200000001` AND `statecode = 0` (Active/succeeded). If `statecode = 1` with a non-null `errormessage`: the environment validation failed — report the error and do not continue.

Poll every 3 seconds, max 20 attempts.

#### Step 3 — Create Pipeline Record

```
POST {hostUrl}/api/data/v9.0/deploymentpipelines
Content-Type: application/json

{
  "name": "{pipeline name}",
  "description": "Power Pages deployment pipeline for {siteName}"
}
```

Extract `deploymentpipelineid` from `OData-EntityId` response header.

#### Step 4 — Associate Source Environment via $ref

Link the source deployment environment to the pipeline. **Use relative path format — not full URL** (HAR-confirmed):

```
POST {hostUrl}/api/data/v9.0/deploymentpipelines({pipelineId})/deploymentpipeline_deploymentenvironment/$ref
Content-Type: application/json

{
  "@odata.context": "{hostUrl}/api/data/v9.0/$metadata#$ref",
  "@odata.id": "deploymentenvironments({sourceDeploymentEnvironmentId})"
}
```

> **Note**: Response is **204** (not 200 with entity body as the HAR initially suggested). Treat any 2xx as success.

> **Note**: `@odata.id` uses a relative path (no leading `/`). Do NOT use the full `https://...` URL — the portal sends the relative form and the API accepts it.

#### Step 5 — Create Deployment Stages

Create one stage per target environment, in deployment order:

```
POST {hostUrl}/api/data/v9.0/deploymentstages
Content-Type: application/json

{
  "name": "Deploy to {targetName}",
  "deploymentpipelineid@odata.bind": "/deploymentpipelines({pipelineId})",
  "targetdeploymentenvironmentid@odata.bind": "/deploymentenvironments({targetDeploymentEnvironmentId})"
}
```

> **Note**: The `rank` field does not exist on `deploymentstage`. For multi-stage ordering, use `"previousdeploymentstageid@odata.bind": "/deploymentstages({previousStageId})"` to link stages in a chain (similar to a linked list).

```
```

Extract `deploymentstagesid` from `OData-EntityId` response header.

### Deployment Flow — 4-Step Flow

#### Step 1 — Resolve Pipeline Info

Before creating a stage run, call `RetrieveDeploymentPipelineInfo` to get the source environment ID and available artifacts:

```
GET {hostUrl}/api/data/v9.1/RetrieveDeploymentPipelineInfo(DeploymentPipelineId={pipelineId},SourceEnvironmentId='{BAP_SOURCE_ENV_ID}',ArtifactName='{solutionName}')
Authorization: Bearer {hostEnvToken}
```

Where `BAP_SOURCE_ENV_ID` is the BAP GUID of the dev environment (from `pac env list` `EnvironmentId` field, or `pac env who`).

Returns: `SourceDeploymentEnvironmentId`, `StageRunsDetails[]`, `EnableAIDeploymentNotes`, `EnableRedeployment`, `DeploymentType`.

Use `SourceDeploymentEnvironmentId` as the `devdeploymentenvironment` binding in the stage run. Use `solutionId` from `.solution-manifest.json` as the artifact solution ID.

> **Version note**: This function may not exist in older Pipelines package versions (returns 404). Fallback: query the `deploymentpipeline_deploymentenvironment` navigation property to get the source environment ID:
>
> ```
> GET {hostUrl}/api/data/v9.1/deploymentpipelines({pipelineId})/deploymentpipeline_deploymentenvironment?$select=deploymentenvironmentid,name,environmenttype
> ```
>
> Filter for `environmenttype = 200000000` to get the source deployment environment record. Use `deploymentenvironmentid` as the `sourceDeploymentEnvironmentId`.

#### Step 2 — Create Stage Run + Validate

Create the stage run (note the `$select` on the URL — required to get the ID back):

```
POST {hostUrl}/api/data/v9.0/deploymentstageruns?$select=deploymentstagerunid
Content-Type: application/json

{
  "deploymentstageid@odata.bind": "/deploymentstages({stageId})",
  "devdeploymentenvironment@odata.bind": "/deploymentenvironments({sourceDeploymentEnvironmentId})",
  "artifactname": "{solutionUniqueName}",
  "solutionid": "{solutionId}",
  "makerainoteslanguagecode": "en-US"
}
```

> **Note**: `deploymentstageid` is the correct lookup binding name (not `stageid`). `devdeploymentenvironment` is the correct navigation property for the source deployment environment (not `artifactid`). `artifactname` is required — provide the solution unique name string. `solutionid` is **required** (not optional). Use the GUID from `RetrieveDeploymentPipelineInfo`.

Then trigger validation — `ValidatePackageAsync` is a **top-level action** (not bound to the entity):

```
POST {hostUrl}/api/data/v9.0/ValidatePackageAsync
Content-Type: application/json
Authorization: Bearer {HOST_TOKEN}

{"StageRunId": "{STAGE_RUN_ID}"}
```

Returns **204** when available. Returns **404** on older Pipelines package versions → fall back to `pac pipeline deploy` (see [pac pipeline deploy CLI (Fallback / Alternative)](#pac-pipeline-deploy-cli-fallback--alternative) below).

> **Version note**: `ValidatePackageAsync` and `DeployPackageAsync` custom actions may not exist in older Pipelines package versions. If these return 404, use the `pac pipeline deploy` CLI as the deployment mechanism instead.

Poll until validation completes — use single-entity GET, check `stagerunstatus`:

```
GET {hostUrl}/api/data/v9.0/deploymentstageruns({stageRunId})?$select=deploymentstagerunid,stagerunstatus,errormessage,operation,operationdetails,operationstatus,scheduledtime,targetenvironmentid,validationresults,artifactname,deploymentsettingsjson
```

`stagerunstatus` values during validation:
- `200000006` = **Validating** — in-progress, keep polling
- `200000007` = **Validation Succeeded** — terminal success, proceed to next step
- `200000003` = **Failed** — terminal failure, stop and display error
- `200000004` = **Canceled** — terminal, stop
- `200000005` = **Pending Approval** — pause and inform user to approve in Power Platform make.powerapps.com portal, then re-poll after user confirms

`operation` field reference values:
| Value | Label |
|---|---|
| 200000200 | None (not started) |
| 200000201 | Validate |
| 200000202 | Deploy |

> **Important**: `validationresults` is a **double-encoded JSON string** — call `JSON.parse()` on it twice (or once after `JSON.parse()` of the OData response body) to get the object. The object has shape: `{ ValidationStatus, SolutionValidationResults: [{ SolutionValidationResultType, Message, ErrorCode }], SolutionDetails, MissingDependencies }`.

Surface any `SolutionValidationResults` entries to the user as warnings. Known error codes:
- `ErrorCode: -2147188672` — managed/unmanaged conflict: "The solution is already installed as unmanaged but this package is managed." The user must uninstall the existing solution from the target environment before retrying.

**Fetch AI-generated deployment notes** (if `EnableAIDeploymentNotes = true` from `RetrieveDeploymentPipelineInfo`):

```
GET {hostUrl}/api/data/v9.0/deploymentstageruns({stageRunId})?$select=aigenerateddeploymentnotes,deploymentstagerunid
```

Store the value as `AI_DEPLOY_NOTES`.

#### Step 3 — Optional: Configure Deployment Settings

If the solution contains environment variables or connection references that need target-environment values, PATCH the stage run between Validate and Deploy:

```
PATCH {hostUrl}/api/data/v9.0/deploymentstageruns({stageRunId})
Content-Type: application/json

{
  "deploymentsettingsjson": "{...JSON string with env var overrides and connection ref mappings...}"
}
```

The `deploymentsettingsjson` value is a **JSON-serialized string** (not a nested object). Structure:
```json
{
  "EnvironmentVariables": [
    { "SchemaName": "prefix_VarName", "Value": "target-value" }
  ],
  "ConnectionReferences": [
    { "LogicalName": "prefix_ConnRefName", "ConnectionId": "target-connection-id" }
  ]
}
```

#### Step 3b — PATCH stage run before deploy (always run)

Before calling `DeployPackageAsync`, PATCH the stage run with version info and deployment notes:

```
PATCH {hostUrl}/api/data/v9.0/deploymentstageruns({stageRunId})
Content-Type: application/json

{
  "artifactdevcurrentversion": "{current version in source env — query GET solutions?$filter=uniquename eq '...'&$select=version}",
  "artifactversion": "{new version — must be strictly > version already deployed in target stage}",
  "deploymentnotes": "{AI_DEPLOY_NOTES if available, otherwise a brief description of what is being deployed}"
}
```

Returns HTTP 204.

> **Version accuracy is critical**: `artifactdevcurrentversion` must match the live `version` field of the solution in the source environment (query it — do not use stale values from `.solution-manifest.json`). `artifactversion` must be strictly greater than the version already in the target stage — check `.last-deploy.json` for the last deployed version and increment from there.

#### Step 4 — Deploy + Poll

Trigger deployment — `DeployPackageAsync` is a **top-level action** (not bound to the entity):

```
POST {hostUrl}/api/data/v9.0/DeployPackageAsync
Content-Type: application/json

{"StageRunId": "{STAGE_RUN_ID}"}
```

Returns HTTP 204.

Poll `stagerunstatus` until terminal — use filter GET pattern during deployment:

```
GET {hostUrl}/api/data/v9.0/deploymentstageruns?$filter=(deploymentstagerunid eq {stageRunId})&$select=_deploymentstageid_value,deploymentstagerunid,stagerunstatus,operation,operationstatus,suboperation,artifactname
```

`stagerunstatus` values during deployment:
- `200000010` = **Deploying** — in-progress, keep polling (every 10 seconds, max 120 attempts)
- `200000002` = **Succeeded** — terminal success
- `200000003` = **Failed** — terminal failure
- `200000004` = **Canceled** — terminal
- `200000005` = **Pending Approval** — pause and inform user to approve in Power Platform make.powerapps.com portal, then re-poll after user confirms

`suboperation` field values during deploy:
| Value | Label |
|---|---|
| 200000100 | None (starting/finishing) |
| 200000105 | Deploying Artifact (actively installing solution) |

If `stagerunstatus = 200000005` (Pending Approval): pause and inform user to approve in Power Platform make.powerapps.com portal, then re-poll after user confirms.

### Retry Failed Deployment

```
POST {hostEnvUrl}/api/data/v9.1/RetryFailedDeploymentAsync
Content-Type: application/json
Authorization: Bearer {HOST_TOKEN}

{"StageRunId": "{STAGE_RUN_ID}"}
→ HTTP 204
```

Call this instead of creating a new stage run when retrying a failed deployment. Then resume polling `stagerunstatus` as in the deploy phase.

### Cancel a Stage Run

```
PATCH {hostEnvUrl}/api/data/v9.0/deploymentstageruns({STAGE_RUN_ID})
Content-Type: application/json
Authorization: Bearer {HOST_TOKEN}

{"iscanceled": true}
→ HTTP 204
```

### Environment Validation Polling (setup-pipeline)

Poll every **2 seconds**, max 30 attempts (~1 minute):
- `validationstatus = 200000000` → Pending, keep polling
- `validationstatus = 200000001` → Succeeded ✓
- `statecode = 1` with non-null `errormessage` → Failed ✗

### Scheduled Deployment

Add `scheduledtime` to the stage run POST body for a scheduled future deployment:
```json
{
  "deploymentstageid@odata.bind": "...",
  "devdeploymentenvironment@odata.bind": "...",
  "artifactname": "...",
  "solutionid": "...",
  "scheduledtime": "2026-04-01T10:00:00Z"
}
```

### Redeployment (re-deploy an older artifact)

```json
{
  "deploymentstageid@odata.bind": "...",
  "devdeploymentenvironment@odata.bind": "...",
  "artifactname": "...",
  "artifactid@odata.bind": "/deploymentartifacts({artifactId})",
  "isredeployment": true
}
```

Fetch prior successful deployments to show as redeployment options:
```
GET {hostEnvUrl}/api/data/v9.1/deploymentstageruns
  ?$filter=((stagerunstatus eq 200000002))
  &$orderby=starttime desc
  &$select=artifactname,artifactversion,deploymentstagerunid,_artifactid_value,...
```

### Solution Artifact Download

```
GET {hostEnvUrl}/api/data/v9.0/deploymentartifacts({artifactId})/artifactfile/$value         → managed zip
GET {hostEnvUrl}/api/data/v9.0/deploymentartifacts({artifactId})/artifactfileunmanaged/$value → unmanaged zip
```

### Platform Host Provisioning (BAP API)

The platform host is auto-provisioned on demand via the BAP RP API (not the Dataverse OData API):
```
POST {BapRpEndpoint}/getOrCreate?api-version=2021-04-01
Content-Type: application/json

{
  "properties": {
    "environmentSku": "Platform",
    "linkedEnvironmentMetadata": {
      "templates": ["D365_1stPartyAdminApps"]
    }
  }
}
```
Returns 202 with `location` and `retry-after` headers. Poll `location` until `provisioningState` = "Succeeded".
`DefaultCustomPipelinesHostEnvForTenant` defaults to `''` (empty string) when using platform host — treat any falsy/empty value as "platform host in use."

### pac pipeline deploy CLI (Fallback / Alternative)

When `ValidatePackageAsync` / `DeployPackageAsync` are unavailable (older Pipelines package), or when the deployment environment is configured via Power Platform Admin Center, use the PAC CLI:

```bash
pac pipeline deploy \
  --environment "{devEnvUrl}" \
  --solutionName "{solutionUniqueName}" \
  --stageId "{deploymentstagesid}" \
  --currentVersion "{currentVersion}" \
  --newVersion "{newVersion}" \
  --wait
```

**Prerequisites for CLI deployment**:
- The dev environment must have a PP Pipelines host configured (via Power Platform Admin Center or `DefaultCustomPipelinesHostEnvForTenant` tenant setting). Without this, the CLI returns "Resource not found for the segment 'deploymentenvironments'".
- `--currentVersion` and `--newVersion` must be valid semver strings (e.g., `1.0.0.0`, `1.0.0.1`).

### .last-pipeline.json Format

Written by `setup-pipeline` (PP Pipelines path) after successful pipeline creation:

```json
{
  "pipelineId": "{deploymentpipelineid}",
  "pipelineName": "{pipeline name}",
  "hostEnvUrl": "{hostEnvUrl}",
  "sourceDeploymentEnvironmentId": "{sourceDeploymentEnvironmentId}",
  "sourceEnvironmentUrl": "{devEnvUrl}",
  "solutionName": "{solutionUniqueName}",
  "createdAt": "{ISO timestamp}",
  "stages": [
    {
      "stageId": "{deploymentstagesid}",
      "name": "Deploy to Staging",
      "rank": 1,
      "targetDeploymentEnvironmentId": "{targetDeploymentEnvironmentId}",
      "targetEnvironmentUrl": "{stagingEnvUrl}"
    }
  ]
}
```

### .last-deploy.json Format

Written by `deploy-pipeline` after each deployment run:

```json
{
  "pipelineId": "{deploymentpipelineid}",
  "stageId": "{deploymentstagesid}",
  "stageRunId": "{deploymentstagerunid}",
  "stageName": "Deploy to Staging",
  "solutionName": "{solutionUniqueName}",
  "solutionId": "{solutionId}",
  "status": "Succeeded",
  "deployedAt": "{ISO timestamp}",
  "hostEnvUrl": "{hostEnvUrl}"
}
```
