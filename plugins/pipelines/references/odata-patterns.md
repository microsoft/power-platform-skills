# OData Patterns Reference

This document describes all OData call patterns used by the Power Platform Pipelines plugin.

## Pipeline Creation Sequence

Creating a full pipeline requires 5 API calls in order:

### 1. Register Source Environment (Development)
```
POST /api/data/v9.2/deploymentenvironments
Content-Type: application/json

{
  "environmentid": "a1b2c3d4-0000-0000-0000-000000000001",
  "environmenttype": 200000000,
  "name": "Contoso Dev"
}
```

**Response:** `204 No Content`
**Headers:** `OData-EntityId: https://org.crm.dynamics.com/api/data/v9.2/deploymentenvironments(11111111-0000-0000-0000-000000000001)`

### 2. Register Target Environment(s)
```
POST /api/data/v9.2/deploymentenvironments
Content-Type: application/json

{
  "environmentid": "a1b2c3d4-0000-0000-0000-000000000002",
  "environmenttype": 200000001,
  "name": "Contoso QA"
}
```

**Response:** `204 No Content`
**Headers:** `OData-EntityId: https://org.crm.dynamics.com/api/data/v9.2/deploymentenvironments(22222222-0000-0000-0000-000000000002)`

### 3. Create Pipeline
```
POST /api/data/v9.2/deploymentpipelines
Content-Type: application/json

{
  "name": "Contoso ALM Pipeline",
  "enableaideploymentnotes": false,
  "statuscode": 1,
  "statecode": 0,
  "deploymenttype": 0
}
```

**Response:** `204 No Content`
**Headers:** `OData-EntityId: https://org.crm.dynamics.com/api/data/v9.2/deploymentpipelines(33333333-0000-0000-0000-000000000003)`

### 4. Associate Source Environment with Pipeline
```
POST /api/data/v9.2/deploymentpipelines(33333333-0000-0000-0000-000000000003)/deploymentpipeline_deploymentenvironment/$ref
Content-Type: application/json

{
  "@odata.id": "https://org.crm.dynamics.com/api/data/v9.2/deploymentenvironments(11111111-0000-0000-0000-000000000001)"
}
```

**Response:** `204 No Content`

### 5. Create Deployment Stage
```
POST /api/data/v9.2/deploymentstages
Content-Type: application/json

{
  "name": "Deploy to QA",
  "DeploymentPipelineId@odata.bind": "/deploymentpipelines(33333333-0000-0000-0000-000000000003)",
  "TargetDeploymentEnvironmentId@odata.bind": "/deploymentenvironments(22222222-0000-0000-0000-000000000002)"
}
```

**Response:** `204 No Content`
**Headers:** `OData-EntityId: https://org.crm.dynamics.com/api/data/v9.2/deploymentstages(44444444-0000-0000-0000-000000000004)`

---

## Deployment Execution Sequence

Deploying a solution through a pipeline stage requires up to 5 calls:

### 1. List Available Pipelines
```
GET /api/data/v9.2/RetrieveDeploymentPipelines(SourceEnvironmentId='a1b2c3d4-0000-0000-0000-000000000001')
Accept: application/json
```

**Response:** `200 OK`
```json
{
  "value": [
    {
      "deploymentpipelineid": "33333333-0000-0000-0000-000000000003",
      "name": "Contoso ALM Pipeline",
      "deploymenttype": 0,
      "statecode": 0,
      "statuscode": 1
    }
  ]
}
```

### 2. Get Pipeline Details
```
GET /api/data/v9.2/RetrieveDeploymentPipelineInfo(
  DeploymentPipelineId=33333333-0000-0000-0000-000000000003,
  SourceEnvironmentId='a1b2c3d4-0000-0000-0000-000000000001',
  ArtifactName='ContosoSolution'
)
Accept: application/json
```

**Response:** `200 OK` — Returns pipeline info with stages and solution details.

### 3. Start Deployment (Create Stage Run)
```
POST /api/data/v9.2/deploymentstageruns
Content-Type: application/json

{
  "artifactname": "ContosoSolution",
  "DevDeploymentEnvironment@odata.bind": "/deploymentenvironments(11111111-0000-0000-0000-000000000001)",
  "DeploymentStageId@odata.bind": "/deploymentstages(44444444-0000-0000-0000-000000000004)",
  "SolutionId@odata.bind": "/solutions(55555555-0000-0000-0000-000000000005)"
}
```

**Response:** `204 No Content`
**Headers:** `OData-EntityId: https://org.crm.dynamics.com/api/data/v9.2/deploymentstageruns(66666666-0000-0000-0000-000000000006)`

### 4. Poll Deployment Status
```
GET /api/data/v9.2/deploymentstageruns(66666666-0000-0000-0000-000000000006)
Accept: application/json
```

**Response:** `200 OK`
```json
{
  "deploymentstagerunid": "66666666-0000-0000-0000-000000000006",
  "artifactname": "ContosoSolution",
  "statuscode": 200000000,
  "createdon": "2025-01-15T10:30:00Z",
  "modifiedon": "2025-01-15T10:31:00Z"
}
```

Repeat until `statuscode` is a terminal value (200000001, 200000002, or 200000003).

### 5. Verify Deployment (Optional)
```
GET /api/data/v9.2/deploymentstageruns(66666666-0000-0000-0000-000000000006)?$select=statuscode,artifactname,createdon,modifiedon
Accept: application/json
```

---

## Query Patterns

### List with Expand
```
GET /api/data/v9.2/deploymentpipelines(<id>)?$expand=deploymentpipeline_deploymentenvironment,deploymentpipeline_deploymentstage
```

### Filter Active Pipelines
```
GET /api/data/v9.2/deploymentpipelines?$filter=statecode eq 0&$select=name,deploymentpipelineid
```

### Recent Stage Runs
```
GET /api/data/v9.2/deploymentstageruns?$orderby=createdon desc&$top=10&$select=deploymentstagerunid,artifactname,statuscode,createdon
```

### WhoAmI (Auth Verification)
```
GET /api/data/v9.2/WhoAmI
```

**Response:** `200 OK`
```json
{
  "UserId": "...",
  "OrganizationId": "...",
  "BusinessUnitId": "..."
}
```

---

## Common Headers

All requests require:
```
Authorization: Bearer <token>
Accept: application/json
OData-MaxVersion: 4.0
OData-Version: 4.0
```

POST/PATCH requests also require:
```
Content-Type: application/json
```

## Extracting Entity IDs from Responses

POST operations that create entities return `204 No Content` with an `OData-EntityId` header:
```
OData-EntityId: https://org.crm.dynamics.com/api/data/v9.2/entityset(guid)
```

Extract the GUID from within the parentheses using this regex:
```
/\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/i
```
