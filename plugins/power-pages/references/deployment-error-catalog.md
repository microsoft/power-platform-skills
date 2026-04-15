# Deployment Error Catalog

Known failure patterns for Power Pages deployments. Used by the `diagnose-deployment` skill to pattern-match errors and propose auto-fixes.

Each entry includes: error pattern, root cause, severity, whether an auto-fix is available, and the fix procedure.

---

## Pattern 1: Stale Environment Manifest

**Error pattern** (in PAC CLI stderr or stdout):
```
Error: The manifest file is out of date
Manifest mismatch detected for environment
Upload failed: manifest version conflict
```

**Root cause**: The `<environment-host>-manifest.yml` file in `.powerpages-site/` was created for a different environment or is from an old upload cycle. PAC CLI rejects uploads when the local manifest doesn't match the target environment's current state.

**Severity**: Error

**Auto-fix available**: Yes

**Fix procedure**:
1. Locate the stale manifest: `glob('.powerpages-site/*-manifest.yml')`
2. **Ask explicit user permission**: "The manifest file `{filename}` is stale. Delete it so PAC CLI can regenerate it on next upload? This is safe — the file is regenerated automatically."
3. If approved: delete the manifest file (`fs.unlinkSync`)
4. Retry `pac pages upload-code-site --rootPath "<PROJECT_ROOT>"`
5. Verify upload succeeded (exit code 0)

---

## Pattern 2: Blocked JavaScript Attachments

**Error pattern** (in PAC CLI stderr):
```
Error: JavaScript attachment is blocked
Upload failed: .js files are not allowed
Blocked file type: .js
The following files could not be uploaded: *.js
```

**Root cause**: The Dataverse environment has `.js` files in the blocked attachments setting (`blockedattachments`). Power Pages upload requires this setting to allow JS files.

**Severity**: Error

**Auto-fix available**: Yes

**Fix procedure**:
1. Retrieve current blocked attachments: `pac env update-settings --name blockedattachments --value ""` OR query current value first via `pac env list-settings`
2. **Ask explicit user permission**: "JavaScript files are blocked in your environment. Update the `blockedattachments` setting to allow JS uploads? This modifies an environment-level security setting."
3. If approved:
   - Get current setting: `pac env list-settings --name blockedattachments`
   - Remove `.js` from the comma-separated list (preserve other blocked types)
   - Apply: `pac env update-settings --name blockedattachments --value "{updated-list}"`
4. Retry upload
5. Verify upload succeeded

**Note**: If the user declines, document this as a manual step: navigate to Power Platform Admin Center → Environments → Settings → Product → Features → Blocked Attachments.

---

## Pattern 3: Missing websiteRecordId

**Error pattern** (in `powerpages.config.json` or PAC CLI):
```
websiteRecordId is missing or empty
Error: No website record ID found
Upload failed: cannot identify target website
```

**Root cause**: `powerpages.config.json` does not have a `websiteRecordId` field, or it is empty/null. This happens when the site was never activated, or the config was corrupted.

**Severity**: Error

**Auto-fix available**: Partial (can retrieve record ID from PAC CLI, cannot auto-activate)

**Fix procedure**:
1. Run `pac pages list` to list available website records
2. Parse output to find matching `websiteRecordId` by site name
3. **Ask explicit user permission**: "Found website record `{id}` for `{siteName}`. Update `powerpages.config.json` with this record ID?"
4. If approved: update `powerpages.config.json` with the correct `websiteRecordId`
5. If no matching record found: the site needs activation first — suggest running `/power-pages:activate-site`

---

## Pattern 4: Authentication Expired

**Error pattern** (in PAC CLI stderr or az CLI):
```
Error: Authentication token expired
AADSTS70011: The provided request must include a 'scope' input parameter
Unauthorized: 401
Please run 'pac auth create' to authenticate
```

**Root cause**: PAC CLI auth token or Azure CLI session has expired. Tokens typically expire after 60–90 minutes.

**Severity**: Error

**Auto-fix available**: Yes (guided re-auth)

**Fix procedure**:
1. Check PAC CLI auth: `pac auth who`
2. Check Azure CLI auth: `az account show`
3. If PAC CLI expired: `pac auth create --environment {envUrl}`
4. If Azure CLI expired: `az login`
5. After re-auth, verify: `pac env who` should show environment URL
6. Retry the original operation

---

## Pattern 5: Missing Web Files / Empty Upload

**Error pattern** (in PAC CLI stdout):
```
No files to upload
Upload complete: 0 files uploaded
Build output directory not found
Warning: dist/ directory is empty
```

**Root cause**: The site was not built before uploading, or the build output directory (`dist/`) is empty or missing. PAC CLI uploads from the `compiledPath` in `powerpages.config.json`.

**Severity**: Error

**Auto-fix available**: Yes

**Fix procedure**:
1. Read `compiledPath` from `powerpages.config.json`
2. Check if the build output directory exists and is non-empty
3. **Ask explicit user permission**: "The build output at `{compiledPath}` is empty or missing. Run `npm run build` to build the site first?"
4. If approved: run `npm run build` in the project root
5. Verify build output directory now contains files
6. Retry upload

---

## Pattern 6: Solution Import Missing Dependencies

**Error pattern** (in async operation message or importjob data):
```
MissingDependency
Cannot import solution: missing required component
Dependency not found: {componentId}
Solution requires {componentType} {componentId} which is not present
```

**Root cause**: The solution being imported depends on components (tables, choices, plugins) that don't exist in the target environment. Common when importing to a clean environment without the full base solution stack.

**Severity**: Error

**Auto-fix available**: No (manual)

**Informational guidance**:
- Export the dependency solution from the source environment
- Import the dependency solution first into the target
- Then retry importing the main solution
- Alternatively, use `StageSolution` before import to identify missing dependencies upfront

---

## Pattern 7: Solution Export Timeout

**Error pattern** (from `poll-async-operation.js` or asyncoperations):
```
Export operation still running after timeout
AsyncOperation status: InProgress (timeout exceeded)
statecode: 0 after maximum polling attempts
```

**Root cause**: Large solutions can take longer than the default polling timeout. The operation is still running in Dataverse — it has not failed.

**Severity**: Warning

**Auto-fix available**: No (informational)

**Informational guidance**:
- The export is still in progress in Dataverse
- Wait 5–10 minutes and retry the export skill, which will re-poll
- Check the async operation status directly: `GET {envUrl}/api/data/v9.2/asyncoperations({asyncJobId})?$select=statecode,statuscode`
- If `statecode=3, statuscode=30` (Succeeded), the export completed — retry the download step

---

## Pattern 8: PAC CLI Not Installed

**Error pattern** (when running pac commands):
```
pac: command not found
'pac' is not recognized as an internal or external command
Error: pac CLI is not installed
```

**Root cause**: Power Platform CLI is not installed or not in PATH.

**Severity**: Error

**Auto-fix available**: No (installation required)

**Informational guidance**:
- Install PAC CLI: `dotnet tool install --global Microsoft.PowerApps.CLI.Tool`
- Or download from: https://aka.ms/PowerAppsCLI
- After installation, verify: `pac --version`
- If using VS Code: install the Power Platform Tools extension

---

## Pattern 9: Environment Mismatch

**Error pattern** (in PAC CLI stdout or manifest comparison):
```
Warning: Uploading to a different environment than the manifest was created for
Environment URL mismatch
Target environment does not match manifest environment
```

**Root cause**: The authenticated PAC CLI environment differs from the `environmentUrl` in `.solution-manifest.json` or the manifest file was created for a different environment.

**Severity**: Warning

**Auto-fix available**: Partial (confirm and switch environments)

**Fix procedure**:
1. Display current PAC CLI environment: `pac env who`
2. Display manifest environment: read `environmentUrl` from `.solution-manifest.json`
3. **Ask user**: "You appear to be deploying to a different environment than the solution was created for. Continue with current environment `{currentEnv}` or switch to `{manifestEnv}`?"
4. If switch: `pac org select --environment {manifestEnv}`
5. Verify after switch: `pac env who`

---

## Pattern 10: Duplicate Solution Component

**Error pattern** (from AddSolutionComponent):
```
Component already exists in solution
Duplicate component: {componentId}
The component {componentId} of type {componentType} is already part of the solution
```

**Root cause**: The component was already added to the solution in a previous run. This is not a fatal error.

**Severity**: Info (not an error)

**Auto-fix available**: N/A (skip and continue)

**Handling**: Log as informational, skip the duplicate add, continue with remaining components.

---

## Error Severity Reference

| Severity | Meaning | Action |
|---|---|---|
| **Error** | Blocks deployment, must be resolved | Present auto-fix if available, else document manual steps |
| **Warning** | Deployment may succeed but with issues | Present to user, offer guidance |
| **Info** | Informational, not blocking | Display in summary table only |

---

## Pattern 11: Solution Import Blocked by Attachment Restrictions

**Error pattern** (in async operation `message` / `friendlyMessage`):
```
AttachmentBlocked
The attachment is either not a valid type or is too large. It cannot be uploaded or downloaded.
ErrorCode: -2147188706 / 80043e09
Plugin: Microsoft.Crm.ObjectModel.FileStoreService
Method: InitializeFileBlocksUpload
```

**Root cause**: The target environment's `blockedattachments` setting includes file types present inside the solution zip (e.g., `.zip`, `.js`, `.css`, `.png`). When `ImportSolutionAsync` processes web file components, it tries to store them as file attachments — and the environment-level blocklist rejects them. This commonly affects environments where security policy blocks broad sets of file types.

**Severity**: Error

**Auto-fix available**: Yes (with explicit user permission)

**Fix procedure**:
1. Retrieve the current blocked attachments list:
   ```bash
   pac env list-settings --name blockedattachments
   ```
2. Identify which file types in the solution are on the blocklist (common culprits: `.zip`, `.js`, `.css`)
3. **Ask explicit user permission**: "The environment blocks certain file types required by this solution. Remove the blocking for `{types}` from the `blockedattachments` setting? This modifies an environment-level security setting and affects all users."
4. If approved — remove the specific types from the comma-separated list and apply:
   ```bash
   pac env update-settings --name blockedattachments --value "{updated-list-without-blocked-types}"
   ```
5. Retry `ImportSolutionAsync`
6. After successful import, optionally restore the blocked types if the customer wants them re-blocked (they'll need to manage the web files differently going forward)

**Note**: If the user declines, document as a manual step: Power Platform Admin Center → Environments → {env} → Settings → Product → Features → Blocked Attachments.

---

## Pattern 12: Site Broken After Pipeline Deploy — Missing Web API Site Settings

**Error pattern** (observed in browser, not a PAC CLI error):
```
Web API calls return 404 or 403 in target environment
Webapi/{table}/enabled site setting not found
Site functions but data operations all fail silently
```

**Root cause**: The solution was packaged without `Webapi/*` site settings. By default, many ALM workflows warn against including all site settings (due to OAuth secrets) and users exclude all site settings. But `Webapi/*/enabled` and `Webapi/*/fields` are not secrets — they must be present in the target environment for Web API calls to work. Without them, Power Pages silently denies all Web API requests.

**Severity**: Error

**Auto-fix available**: Yes

**Fix procedure**:
1. Query the source environment for all `Webapi/*` site settings:
   ```
   GET {srcEnvUrl}/api/data/v9.2/mspp_sitesettings?$filter=startswith(mspp_name,'Webapi/') and _mspp_websiteid_value eq {websiteRecordId}&$select=mspp_name,mspp_value
   ```
2. For each missing setting in the target environment, create it:
   ```
   POST {targetEnvUrl}/api/data/v9.2/mspp_sitesettings
   { "mspp_name": "Webapi/crd50_invoice/enabled", "mspp_value": "true", "mspp_websiteid@odata.bind": "/powerpagesites({websiteRecordId})" }
   ```
3. Alternatively, re-run `setup-solution` and include the `Webapi/*` category when asked about site settings.

**Prevention**: The `setup-solution` skill should ALWAYS include `Webapi/*` site settings by default — these are required for any code site that uses the Web API.

---

## Pattern 13: Site Broken After Pipeline Deploy — Missing Dataverse Tables

**Error pattern** (observed in browser console or Web API calls):
```
Resource not found for the segment '{table}'
Entity '{logicalName}' does not exist in target environment
404 on GET /_api/{logicalName}
```

**Root cause**: The solution was created without adding the underlying Dataverse table definitions (ComponentType=1 entities). Without them, the tables don't exist in the target environment after import. Web API calls referencing those tables return 404.

**Severity**: Error

**Auto-fix available**: Partial (must re-export and re-import solution with tables)

**Fix procedure**:
1. Identify missing tables: compare `EntityDefinitions` in source vs target for tables used by the site
2. Re-run `setup-solution` on the source environment, ensuring all custom tables from `.datamodel-manifest.json` are added to the solution (ComponentType=1)
3. Re-export and re-deploy the solution with tables included

**Prevention**: The `setup-solution` skill reads `.datamodel-manifest.json` and automatically adds all custom tables as root solution components.

---

## Pattern 14: Web API Returns 403 — Table Permissions Not in Solution

**Error pattern** (from Web API response body):
```
{ "error": { "code": "90040901", "message": "..." } }
403 Forbidden on POST/PATCH /_api/{table}
Authenticated users cannot create/read records
```

**Root cause**: Table Permissions (`adx_entitypermission` records, powerpagecomponenttype=18) were not added to the solution, so they weren't deployed to the target environment. The target site has no table permissions → all Web API calls are denied.

**Severity**: Error

**Auto-fix available**: Yes (if table permissions exist in source env)

**Fix procedure**:
1. Query source env for table permissions for this site:
   ```
   GET {srcEnvUrl}/api/data/v9.2/powerpagecomponents?$filter=_powerpagesiteid_value eq {websiteRecordId} and powerpagecomponenttype eq 18&$select=powerpagecomponentid,name
   ```
2. For each permission missing in target, add it to the solution and re-deploy.
3. Or re-run `setup-solution` — table permissions (type 18) are included by default.

**Prevention**: Table Permissions are standard `powerpagecomponents` and are included by default in `setup-solution` Phase 5. Verify they were not accidentally excluded when the solution was created.
