# Pipeline Entities Reference

This document describes all Dataverse entities used by the Power Platform Pipelines plugin.
Source: `CRM.Client.PowerAppsExtensions/AppDeployment/solutions/AppDeploymentMetadata/Solution/Entities`

## Entity Relationship Diagram

```
deploymentpipeline (1)
  ├──► (N) deploymentstage
  │         ├──► (1) deploymentenvironment [target]
  │         └──► (1) deploymentstage [previousdeploymentstageid — sequential ordering]
  ├──► (N) deploymentenvironment [source, via M:N association]
  └ ... deploymentstagerun references stage + source env:
        deploymentstagerun ──► deploymentstage
        deploymentstagerun ──► deploymentenvironment [dev source]
        deploymentstagerun (1) ──► (N) deploymentstagerunstatus [sub-operations]
```

## Entities

### deploymentenvironment

Represents an environment registered for use in pipelines.

| Field | Type | Description |
|---|---|---|
| `deploymentenvironmentid` | GUID | Primary key (auto-generated) |
| `environmentid` | String | The BAP environment GUID |
| `environmenttype` | OptionSet | Development or Target (see below) |
| `name` | String | Display name |
| `validationstatus` | OptionSet | Pending / Success / Failed |
| `statecode` | Int | `0` = Active |
| `statuscode` | Int | `1` = Active |

### deploymentpipeline

Represents a deployment pipeline definition.

| Field | Type | Description |
|---|---|---|
| `deploymentpipelineid` | GUID | Primary key (auto-generated) |
| `name` | String | Pipeline display name |
| `deploymenttype` | OptionSet | Standard / Source Control / ADO Pipeline |
| `enableaideploymentnotes` | Boolean | Enable AI-generated deployment notes |
| `enableredeployment` | Boolean | Allow redeployment of same version |
| `statecode` | Int | `0` = Active, `1` = Inactive |
| `statuscode` | Int | `1` = Active, `2` = Inactive |

**Relationships:**
- `deploymentpipeline_deploymentenvironment` — M:N association to source environments
- `deploymentpipeline_deploymentstage` — 1:N to stages

### deploymentstage

Represents a stage within a pipeline (e.g., QA, Production).

| Field | Type | Description |
|---|---|---|
| `deploymentstageid` | GUID | Primary key (auto-generated) |
| `name` | String | Stage display name |
| `description` | String | Optional stage description |
| `deploymentpipelineid` | Lookup | FK → `deploymentpipeline` |
| `targetdeploymentenvironmentid` | Lookup | FK → `deploymentenvironment` |
| `previousdeploymentstageid` | Lookup | FK → `deploymentstage` (sequential ordering) |
| `delegateddeploymenttype` | OptionSet | Stage Owner (1) or Service Principal (2) |
| `ispreexportstep` | Boolean | Has pre-export validation step |
| `ispreredeploymentstep` | Boolean | Has pre-deployment step |
| `predeploymentstepstatus` | OptionSet | Pending(10) / Completed(20) / Failed(30) |

**OData Bind Syntax (for create):**
```json
{
  "name": "QA",
  "deploymentpipelineid@odata.bind": "/deploymentpipelines(<pipelineId>)",
  "targetdeploymentenvironmentid@odata.bind": "/deploymentenvironments(<envId>)"
}
```

**Note:** Stages are always sequential. `previousdeploymentstageid` creates a chain — Stage N must complete before Stage N+1 can run.

### deploymentstagerun

Represents a single deployment execution through a stage. **61 attributes** — the most complex entity.

| Field | Type | Description |
|---|---|---|
| `deploymentstagerunid` | GUID | Primary key (auto-generated) |
| `artifactname` | String | Solution unique name being deployed |
| `solutionid` | GUID | Solution identifier |
| `deploymentstageid` | Lookup | FK → `deploymentstage` |
| `devdeploymentenvironment` | Lookup | FK → `deploymentenvironment` (source) |
| `stagerunstatus` | OptionSet | **Primary status** — see Stage Run Status below |
| `approvalstatus` | OptionSet | Pending(10) / Approved(20) / Rejected(30) |
| `predeploymentstepstatus` | OptionSet | Pending(10) / Completed(20) / Failed(30) |
| `postdeploymentstepstatus` | OptionSet | Notified(10) |
| `deploymentsettingsjson` | String | Environment variables + connection references (JSON) |
| `statecode` | Int | `0` = Active, `1` = Inactive |
| `statuscode` | Int | `1` = Active, `2` = Inactive |

**OData Bind Syntax (for create):**
```json
{
  "artifactname": "MySolution",
  "devdeploymentenvironment@odata.bind": "/deploymentenvironments(<devEnvId>)",
  "deploymentstageid@odata.bind": "/deploymentstages(<stageId>)",
  "solutionid": "<solution-guid>"
}
```

**DeploymentSettingsJson Schema:**
```json
{
  "EnvironmentVariables": [
    { "SchemaName": "new_envtest", "Value": "some-value" },
    { "SchemaName": "new_con1", "Value": "<GUID>" }
  ],
  "ConnectionReferences": [
    {
      "LogicalName": "new_sharedonedriveforbusiness_c0706",
      "ConnectionId": "99aa58f2bc534043a36e3ec3e5398c72",
      "ConnectorId": "/providers/Microsoft.PowerApps/apis/shared-office365..."
    }
  ]
}
```

### deploymentstagerunstatus

Sub-operation tracking within a stage run. Uses global option sets.

| Field | Type | Description |
|---|---|---|
| `deploymentstagerunstatusid` | GUID | Primary key |
| `operation` | Global OptionSet | None(200000200), Validate(200000201), Deploy(200000202), PreDeploy(200000203) |
| `operationstatus` | Global OptionSet | NotStarted→Succeeded/Failed/Canceled |
| `suboperation` | Global OptionSet | Pre Validation → Deployment Complete (10 values) |

---

## Option Set Values (Complete)

### Environment Type (`environmenttype`)
| Value | Label |
|---|---|
| `200000000` | Development (source) |
| `200000001` | Target |

### Environment Validation Status (`validationstatus`)
| Value | Label |
|---|---|
| `200000000` | Pending |
| `200000001` | Success |
| `200000002` | Failed |

### Deployment Type (`deploymenttype`)
| Value | Label |
|---|---|
| `0` | Standard |
| `1` | Source Control |
| `2` | ADO Pipeline |

### Delegated Deployment Type (`delegateddeploymenttype`)
| Value | Label |
|---|---|
| `1` | Stage Owner |
| `2` | Service Principal |

### 🔥 Stage Run Status (`stagerunstatus` on `deploymentstagerun`)
| Value | Label | Terminal? |
|---|---|---|
| `200000000` | NotStarted | No |
| `200000001` | Started | No |
| `200000002` | Succeeded | ✅ Yes |
| `200000003` | Failed | ✅ Yes |
| `200000004` | Canceled | ✅ Yes |
| `200000005` | Scheduled | No |
| `200000006` | Validating | No |
| `200000007` | Validation Succeeded | No |
| `200000008` | Pre-Deploy In Progress | No |
| `200000009` | Pre-Deploy Succeeded | No |
| `200000010` | Deploying | No |

### Approval Status (`approvalstatus`)
| Value | Label |
|---|---|
| `10` | Pending |
| `20` | Approved |
| `30` | Rejected |

### Pre-Deployment Step Status (`predeploymentstepstatus`)
| Value | Label |
|---|---|
| `10` | Pending |
| `20` | Completed |
| `30` | Failed |

### Post-Deployment Step Status (`postdeploymentstepstatus`)
| Value | Label |
|---|---|
| `10` | Notified |

### Global: Deployment Operation (`deploymentoperation`)
| Value | Label |
|---|---|
| `200000200` | None |
| `200000201` | Validate |
| `200000202` | Deploy |
| `200000203` | PreDeploy |

### Global: Deployment Operation Status (`deploymentoperationstatus`)
| Value | Label |
|---|---|
| `200000000` | NotStarted |
| `200000001` | Started |
| `200000002` | Succeeded |
| `200000003` | Failed |
| `200000004` | Pending |
| `200000005` | Scheduled |
| `200000006` | Canceled |

### Global: Deployment Sub-Operation (`deploymentsuboperation`)
| Value | Label |
|---|---|
| `200000100` | None |
| `200000101` | Pre Validation |
| `200000102` | Exporting Solution |
| `200000103` | Pre Deployment Step |
| `200000104` | Importing Solution |
| `200000105` | Customization Publishing |
| `200000106` | Deployment Complete |
| `200000107` | Copy Environment |
| `200000108` | Waiting on Pre-Export |
| `200000109` | Executing Pre-Export |

---

## Deployment Lifecycle Flow

```
NotStarted (200000000)
  → Started (200000001)
    → Validating (200000006)
      → Validation Succeeded (200000007)
        → [Approval Gate if configured: Pending(10) → Approved(20) / Rejected(30)]
          → Pre-Deploy In Progress (200000008)
            → Pre-Deploy Succeeded (200000009)
              → Deploying (200000010)
                → Succeeded (200000002) ✅
                → Failed (200000003) ❌
  → Scheduled (200000005) [for scheduled deployments]
  → Canceled (200000004) ❌ [can happen at any point]
```

---

## API Functions

### RetrieveDeploymentPipelines
```
GET /api/data/v9.2/RetrieveDeploymentPipelines(SourceEnvironmentId='<guid>')
```
Returns pipelines available from a given source environment.

### RetrieveDeploymentPipelineInfo
```
GET /api/data/v9.2/RetrieveDeploymentPipelineInfo(
  DeploymentPipelineId=<guid>,
  SourceEnvironmentId='<guid>',
  ArtifactName='<solutionName>'
)
```
Returns detailed pipeline information including stages and solution artifacts.

### ValidatePackageAsync
```
POST /api/data/v9.2/ValidatePackageAsync
Body: { "StageRunId": "<stagerun-guid>" }
```
Triggers validation of a solution package before deployment.

---

## Cross-Region Deployment

**Setting**: `CrossRegionDeploymentEnabled`
- Type: Boolean, default `false`
- Scope: Organization (per pipeline host environment)
- Hidden from UI by default
- When enabled: pipelines in that host env can deploy across Azure regions
