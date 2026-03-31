# Solution API Patterns

OData request body templates for Dataverse solution lifecycle operations. Used by `setup-solution`, `export-solution`, and `import-solution` skills.

> **Auth**: All requests require `Authorization: Bearer <token>` and `OData-Version: 4.0` headers. See `references/odata-common.md` for full header set and retry patterns.

---

## 1. Create Publisher

**Endpoint**: `POST {envUrl}/api/data/v9.2/publishers`

**Request body**:
```json
{
  "uniquename": "contoso",
  "friendlyname": "Contoso",
  "customizationprefix": "con",
  "customizationoptionvalueprefix": 10000
}
```

**Key fields**:
- `uniquename`: Lowercase letters/numbers only, no spaces. Cannot be changed after creation.
- `customizationprefix`: 2–8 lowercase letters. Used as prefix for all components (e.g., `con_WebsiteName`). **Irreversible.**
- `customizationoptionvalueprefix`: Integer 10000–99999. Prefix for option set values.

**Success response**: `204 No Content` with `OData-EntityId` header containing the publisher URL (extract GUID for `publisherid`).

**Check existing** (before creating):
```
GET {envUrl}/api/data/v9.2/publishers?$filter=uniquename eq '{uniquename}'&$select=publisherid,uniquename,customizationprefix
```

---

## 2. Create Solution

**Endpoint**: `POST {envUrl}/api/data/v9.2/solutions`

**Request body**:
```json
{
  "uniquename": "ContosoSite",
  "friendlyname": "Contoso Site",
  "version": "1.0.0.0",
  "description": "Power Pages site components for Contoso",
  "publisherid@odata.bind": "/publishers({publisherId})"
}
```

**Key fields**:
- `uniquename`: Letters, numbers, underscores only. Cannot be changed after creation.
- `version`: Must be in `major.minor.build.revision` format.
- `publisher_solution@odata.bind`: Links to the publisher by `publisherid` GUID.

**Success response**: `204 No Content` with `OData-EntityId` header. Extract `solutionid` GUID from URL.

**Check existing**:
```
GET {envUrl}/api/data/v9.2/solutions?$filter=uniquename eq '{uniquename}'&$select=solutionid,uniquename,version,ismanaged
```

---

## 3. Add Solution Component

**Endpoint**: `POST {envUrl}/api/data/v9.2/AddSolutionComponent`

**Request body**:
```json
{
  "ComponentId": "{componentGuid}",
  "ComponentType": "{discoveredComponentType}",
  "SolutionUniqueName": "ContosoSite",
  "AddRequiredComponents": false,
  "DoNotIncludeSubcomponents": false,
  "IncludedComponentSettingsValues": null
}
```

Where `{discoveredComponentType}` is the integer value returned by the discovery query above for this component's objectId.

**Component types for Power Pages**:

> **IMPORTANT — Never hardcode component type numbers.** Component type codes are environment-specific metadata and vary across tenants and environments. Always resolve them at runtime using the discovery query below before calling `AddSolutionComponent`.

**Discover the component type for any objectId**:
```
GET {envUrl}/api/data/v9.2/solutioncomponents?$filter=objectid eq '{knownObjectId}'&$select=componenttype&$top=1
```

Run this query **twice**: once for `websiteRecordId` (captures `websiteComponentType`) and once for any `powerpagecomponentid` from the site (captures `subComponentType`). All Power Pages sub-components — web pages, web files, web roles, site settings, templates, etc. — share a **single `componenttype` value** in `solutioncomponents`. Only the top-level site record uses a different componenttype.

**Known approximate values** (for reference only — do not hardcode):
| Type | Approximate ComponentType | Notes |
|---|---|---|
| Website (PowerPages site) | ~10374 | Resolve via discovery query using `websiteRecordId` |
| All sub-components (web pages, web files, web roles, site settings, templates, etc.) | ~10373 | One shared componenttype for ALL powerpagecomponents — resolve via discovery query using any `powerpagecomponentid` |

**Add the Website component first** with `AddRequiredComponents: true`. Then add all sub-components individually using `subComponentType` — the `AddRequiredComponents: true` flag does NOT automatically cascade all 100+ sub-components; each must be added explicitly.

**Success response**: `200 OK` with empty body or component details.

**Verify components added**:
```
GET {envUrl}/api/data/v9.2/solutioncomponents?$filter=_solutionid_value eq '{solutionId}'&$select=objectid,componenttype&$orderby=componenttype
```

---

## 3b. Discover All Power Pages Sub-Components (powerpagecomponents)

The `AddRequiredComponents: true` flag on the website record does **not** cascade all sub-components (web pages, web files, site settings, templates, etc.) into the solution. Each sub-component must be added individually. Use the `powerpagecomponents` entity to enumerate all of them.

**Endpoint**:
```
GET {envUrl}/api/data/v9.2/powerpagecomponents
  ?$filter=_powerpagesiteid_value eq '{websiteRecordId}'
  &$select=powerpagecomponentid,name,powerpagecomponenttype
  &$orderby=powerpagecomponenttype
```

**Pagination**: Follow `@odata.nextLink` in each response until the link is absent (all pages fetched).

**Resolve component type labels dynamically** before grouping — never rely on a hardcoded table as the primary source:

```
GET {envUrl}/api/data/v9.2/GlobalOptionSetDefinitions(Name='powerpagecomponenttype')
```

Response shape:
```json
{
  "Options": [
    { "Value": 1, "Label": { "UserLocalizedLabel": { "Label": "Publishing State" } } },
    { "Value": 2, "Label": { "UserLocalizedLabel": { "Label": "Web Page" } } }
  ]
}
```

Build a map `{ [Value]: Label.UserLocalizedLabel.Label }` and use it when displaying grouped results. For any type value not in the map, display as `Unknown (N)`. This query is always current — no code changes needed when Microsoft adds new component types.

**Fallback table** (used only if the metadata query fails — values current as of 2026-03, source: Microsoft Learn `powerpagecomponent` entity reference):

**Group by `powerpagecomponenttype`** for the user-facing summary:

| powerpagecomponenttype | Label | Sensitive? |
|---|---|---|
| 1 | Publishing State | No |
| 2 | Web Page | No |
| 3 | Web File | No |
| 4 | Web Link Set | No |
| 5 | Web Link | No |
| 6 | Page Template | No |
| 7 | Content Snippet | No |
| 8 | Web Template | No |
| 9 | Site Setting | **YES** |
| 10 | Web Page Access Control Rule | No |
| 11 | Web Role | No |
| 12 | Website Access | No |
| 13 | Site Marker | No |
| 15 | Basic Form | No |
| 16 | Basic Form Metadata | No |
| 17 | List | No |
| 18 | Table Permission | No |
| 19 | Advanced Form | No |
| 20 | Advanced Form Step | No |
| 21 | Advanced Form Metadata | No |
| 24 | Poll Placement | No |
| 26 | Ad Placement | No |
| 27 | Bot Consumer | No |
| 28 | Column Permission Profile | No |
| 29 | Column Permission | No |
| 30 | Redirect | No |
| 31 | Publishing State Transition Rule | No |
| 32 | Shortcut | No |
| 33 | Cloud Flow | No |
| 34 | UX Component | No |
| 35 | Server Logic | No |

> **Security warning — Type 9 (Site Settings)**: Site Settings can include OAuth provider secrets such as `Authentication/OpenAuth/Facebook/AppSecret`, `Authentication/OpenAuth/Microsoft/ClientSecret`, etc. Including these in a solution that is exported and deployed to other environments moves sensitive credentials across tenants. **Default: exclude site settings.** Ask the user explicitly before including them.

**After fetching**, present a grouped summary and ask the user which categories to include. Then call `AddSolutionComponent` for each component in the selected categories, using the `subComponentType` discovered in Step 5.1.

---

## 4. Export Solution (Async)

Export is a two-step process: trigger async export, then download the result.

### Step 4a: Trigger Export

**Endpoint**: `POST {envUrl}/api/data/v9.2/ExportSolutionAsync`

**Request body**:
```json
{
  "SolutionName": "ContosoSite",
  "Managed": false,
  "TargetVersion": "",
  "ExportAutoNumberingSettings": false,
  "ExportCalendarSettings": false,
  "ExportCustomizationSettings": false,
  "ExportEmailTrackingSettings": false,
  "ExportGeneralSettings": false,
  "ExportIsvConfig": false,
  "ExportMarketingSettings": false,
  "ExportOutlookSynchronizationSettings": false,
  "ExportRelationshipRoles": false,
  "ExportSales": false
}
```

- Set `"Managed": true` to export as a managed solution (cannot be further customized in target environment — recommended for production deployments).
- Set `"Managed": false` for unmanaged (can be edited in target environment — use for development/staging).

**Success response**: `200 OK` with JSON body:
```json
{
  "@odata.context": "...",
  "AsyncOperationId": "00000000-0000-0000-0000-000000000000",
  "ExportJobId": "00000000-0000-0000-0000-000000000000"
}
```

Capture `AsyncOperationId` and pass to `scripts/poll-async-operation.js` as `--asyncJobId`.

### Step 4b: Download Export Result

**Endpoint**: `POST {envUrl}/api/data/v9.2/DownloadSolutionExportData`

**Request body**:
```json
{
  "ExportJobId": "{exportJobId}"
}
```

**Success response**: `200 OK` with JSON body:
```json
{
  "@odata.context": "...",
  "ExportSolutionFile": "<base64-encoded zip content>"
}
```

Decode `ExportSolutionFile` from base64 and write to disk as `{SolutionName}_{managed|unmanaged}.zip`.

**Verify zip**: Confirm `Solution.xml` exists inside the zip (use `unzip -l` or read zip TOC). File size should be > 1000 bytes.

---

## 5. Import Solution (Async)

Import is optionally a two-step process: optionally stage first (dependency check), then import.

### Step 5a: Stage Solution (Optional but recommended for managed)

**Endpoint**: `POST {envUrl}/api/data/v9.2/StageSolution`

**Request body**:
```json
{
  "CustomizationFile": "<base64-encoded zip content>"
}
```

Use `scripts/encode-solution-file.js` to base64-encode the zip file.

**Success response**: `200 OK` with JSON body:
```json
{
  "@odata.context": "...",
  "StageSolutionResults": {
    "StageSolutionStatus": "Completed",
    "StageSolutionUploadId": "00000000-0000-0000-0000-000000000000",
    "SolutionDetails": {
      "SolutionUniqueName": "ContosoSite",
      "SolutionFriendlyName": "Contoso Site",
      "SolutionVersion": "1.0.0.0",
      "IsManaged": false
    },
    "MissingDependencies": []
  }
}
```

If `MissingDependencies` is non-empty, present each missing dependency to the user before proceeding. Staging does NOT commit the import — it is purely a validation step.

### Step 5b: Import Solution

**Endpoint**: `POST {envUrl}/api/data/v9.2/ImportSolutionAsync`

**Request body (direct import)**:
```json
{
  "CustomizationFile": "<base64-encoded zip content>",
  "OverwriteUnmanagedCustomizations": true,
  "PublishWorkflows": true,
  "ConvertToManaged": false,
  "SkipProductUpdateDependencies": false,
  "HoldingSolution": false
}
```

> **Important**: `ImportSolutionAsync` does **not** accept `StageSolutionUploadId`. After a successful `StageSolution` (dependency check), you must still use `CustomizationFile` (re-encoded zip) when calling `ImportSolutionAsync`. The staging step is purely for pre-flight dependency validation — it does not alter the import call.

**Request body (always use CustomizationFile)**:
```json
{
  "CustomizationFile": "<base64-encoded zip content>",
  "OverwriteUnmanagedCustomizations": true,
  "PublishWorkflows": true,
  "ConvertToManaged": false,
  "SkipProductUpdateDependencies": false,
  "HoldingSolution": false
}
```

- `OverwriteUnmanagedCustomizations: true`: Required when importing over existing customizations in target.
- `PublishWorkflows: true`: Activates workflows after import.
- `HoldingSolution: true`: Performs a staged upgrade (for upgrading managed solutions with delete operations).

**Success response**: `200 OK` with JSON body:
```json
{
  "@odata.context": "...",
  "AsyncOperationId": "00000000-0000-0000-0000-000000000000",
  "ImportJobKey": "00000000-0000-0000-0000-000000000000"
}
```

Pass `AsyncOperationId` (as `asyncJobId`) to `scripts/poll-async-operation.js`.

> **Note**: The response field is `ImportJobKey` (not `ImportJobId`). Use this value to query the import job for component-level results after polling completes.

**Check import result after completion**:
```
GET {envUrl}/api/data/v9.2/importjobs({ImportJobKey})?$select=solutionname,completedon,progress,data
```

The `data` field is XML containing `<importexportxml>` with per-component import results. Parse for `result="success"` vs `result="failure"`.

---

## 6. Query Async Operation Status

See `scripts/poll-async-operation.js` for the reusable poller.

**Manual status check**:
```
GET {envUrl}/api/data/v9.2/asyncoperations({asyncJobId})?$select=statecode,statuscode,message,friendlymessage
```

**Status codes**:
| statecode | statuscode | Meaning |
|---|---|---|
| 0 | 0 | Ready |
| 0 | 20 | In Progress |
| 0 | 30 | Pausing |
| 0 | 40 | Canceling |
| 1 | 10 | Waiting for Resources |
| 3 | 30 | Succeeded |
| 3 | 31 | Failed |
| 3 | 32 | Canceled |

Poll until `statecode === 3` (terminal). Check `statuscode === 30` for success, `statuscode === 31/32` for failure.

---

## 7. Solution Manifest Format

Written by `setup-solution`, read by `export-solution`, `import-solution`, and `setup-pipeline`.

**File**: `.solution-manifest.json` (project root, alongside `powerpages.config.json`)

```json
{
  "schemaVersion": "1.0",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "environmentUrl": "https://contoso.crm.dynamics.com",
  "publisher": {
    "uniqueName": "contoso",
    "friendlyName": "Contoso",
    "prefix": "con",
    "publisherId": "00000000-0000-0000-0000-000000000000"
  },
  "solution": {
    "uniqueName": "ContosoSite",
    "friendlyName": "Contoso Site",
    "version": "1.0.0.0",
    "solutionId": "00000000-0000-0000-0000-000000000000"
  },
  "components": [
    {
      "componentType": 61,
      "componentId": "00000000-0000-0000-0000-000000000000",
      "description": "Website: My Contoso Site"
    }
  ]
}
```
