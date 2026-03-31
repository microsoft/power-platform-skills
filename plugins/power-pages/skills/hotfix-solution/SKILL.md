---
name: hotfix-solution
description: >-
  Finds Power Pages components modified in a recent time window, packages them
  into a Dataverse solution, exports it, and imports it to a target environment.
  Use when asked to: "hotfix solution", "deploy recent changes", "sync modified
  components", "ship delta", "deploy what changed in the last X hours",
  "incremental deploy", "push recent updates", or "deploy changes from today".
user-invocable: true
argument-hint: "Optional: time window (e.g., '2h', '30m', '4h') — default: asks"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
hooks:
  Stop:
    - hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/hotfix-solution/scripts/validate-hotfix.js"'
          timeout: 30
        - type: prompt
          prompt: |
            Check whether the hotfix-solution skill completed successfully. Return { "ok": true } if ALL of the following are true, otherwise { "ok": false, "reason": "..." }:
            1. Modified components were discovered and confirmed with the user before proceeding
            2. A hotfix solution was created in the source environment with those components
            3. The solution was exported as a zip file (managed or unmanaged)
            4. The solution was imported to the target environment and polling completed with Succeeded
            5. A summary was presented showing solution name, component count, and target environment
          timeout: 30
---

# hotfix-solution

Queries Dataverse for Power Pages components modified in a user-specified time window, packages them into a timestamped hotfix solution, exports it, and imports it to a target environment. Designed for rapid incremental deployments — only ships what changed.

## Prerequisites

- PAC CLI installed and authenticated to the **source** environment
- Azure CLI installed and logged in
- `.solution-manifest.json` exists in project root (run `setup-solution` first)

## Phases

### Phase 1 — Verify Prerequisites

**Create all tasks upfront at the start of this phase.**

Tasks to create:
1. "Verify prerequisites"
2. "Discover modified components"
3. "Review and confirm components"
4. "Create hotfix solution"
5. "Export solution"
6. "Import to target environment"
7. "Verify and summarize"

Steps:
1. Run `pac env who` — extract `environmentUrl` (source environment)
2. Run `az account get-access-token --resource "{environmentUrl}" --query accessToken -o tsv` — capture token
3. Verify API access: `GET {environmentUrl}/api/data/v9.2/WhoAmI`
4. Read `.solution-manifest.json` from project root — extract:
   - `solution.uniqueName` (used as base for hotfix solution name)
   - `publisher.publisherId` (reused for hotfix solution)
   - `components[0].componentId` (websiteRecordId — used to scope the component query)
   - `environmentUrl` (warn if it differs from current PAC CLI environment)

If any check fails, stop and explain (reference `${CLAUDE_PLUGIN_ROOT}/references/dataverse-prerequisites.md`).

### Phase 2 — Discover Modified Components

#### 2.1 Ask Time Window

Invoke `AskUserQuestion` immediately — do NOT describe this as chat text:

| Question | Header | Options |
|---|---|---|
| How far back should we look for modified components? | Time Window | Last 30 minutes, Last 1 hour, Last 2 hours (Recommended), Last 4 hours, Last 8 hours, Last 24 hours |

Compute the cutoff timestamp: `new Date(Date.now() - <windowMs>).toISOString()`

#### 2.2 Query Modified Components

```
GET {envUrl}/api/data/v9.2/powerpagecomponents
  ?$filter=_powerpagesiteid_value eq '{websiteRecordId}' and modifiedon ge {cutoffTimestamp}
  &$select=powerpagecomponentid,name,powerpagecomponenttype,modifiedon
  &$orderby=modifiedon desc
```

Follow `@odata.nextLink` to paginate through all pages.

If no components found: inform the user "No components were modified in this time window." and stop (suggest widening the window).

#### 2.3 Resolve Component Type Labels

Fetch the `powerpagecomponenttype` option set to map integer values to human-readable labels:
```
GET {envUrl}/api/data/v9.2/GlobalOptionSetDefinitions(Name='powerpagecomponenttype')
```

Build a map `{ [Value]: Label }` and group results by type. Fall back to the reference table in `${CLAUDE_PLUGIN_ROOT}/references/solution-api-patterns.md` Section 3b if the metadata query fails.

### Phase 3 — Review and Confirm Components

Present a grouped summary:

```
Found N component(s) modified since {cutoffTimestamp}:

  Web Page (2):
    - Home Page
    - About Page

  Content Snippet (1):
    - ids/Footer/AboutText

  Site Setting (3):  ← SENSITIVE: may contain secrets
    - Authentication/...
    - ...
```

> **Security warning**: If any **Site Settings** (type 9) are in the list, warn the user: "Site Settings can contain OAuth secrets and other sensitive values. Including them will deploy those values to the target environment."

Invoke `AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Proceed with deploying these N component(s) to the target environment? | Confirm Components | Yes, deploy all N components, No, cancel |

**If "No"**: Stop cleanly.

### Phase 4 — Create Hotfix Solution

#### 4.1 Generate Solution Name

```
{baseSolutionUniqueName}Hotfix{YYYYMMDDHHmm}
```

Where `baseSolutionUniqueName` comes from `.solution-manifest.json` `solution.uniqueName` and `YYYYMMDDHHmm` is the current UTC timestamp.

#### 4.2 Create Solution

Refer to `${CLAUDE_PLUGIN_ROOT}/references/solution-api-patterns.md` Section 2.

```json
POST {envUrl}/api/data/v9.2/solutions
{
  "uniquename": "{hotfixSolutionName}",
  "friendlyname": "{baseSolutionFriendlyName} Hotfix {YYYYMMDDHHmm}",
  "version": "1.0.0.0",
  "description": "Hotfix: {N} component(s) modified since {cutoffTimestamp}",
  "publisherid@odata.bind": "/publishers({publisherId})"
}
```

Extract `solutionId` from `OData-EntityId` response header.

#### 4.3 Discover Component Type

Refer to `${CLAUDE_PLUGIN_ROOT}/references/solution-api-patterns.md` Section 3.

```
GET {envUrl}/api/data/v9.2/solutioncomponents
  ?$filter=objectid eq '{anyModifiedComponentId}'
  &$select=componenttype&$top=1
```

If not found (new component not yet indexed), fall back: query any known sub-component from the base solution to get the shared `componenttype` value.

#### 4.4 Add Components

For each modified component, call `AddSolutionComponent`:
```json
{
  "ComponentId": "{powerpagecomponentid}",
  "ComponentType": "{discoveredComponentType}",
  "SolutionUniqueName": "{hotfixSolutionName}",
  "AddRequiredComponents": false,
  "DoNotIncludeSubcomponents": false,
  "IncludedComponentSettingsValues": null
}
```

Track success/failure per component. Report any failures but continue with remaining components.

### Phase 5 — Export Solution

Refer to `${CLAUDE_PLUGIN_ROOT}/references/solution-api-patterns.md` Section 4a and 4b.

#### 5.1 Ask Export Type

Invoke `AskUserQuestion` immediately:

| Question | Header | Options |
|---|---|---|
| How would you like to export this hotfix? **Managed** solutions cannot be edited in the target and support clean upgrade/delete cycles — recommended for staging and production. **Unmanaged** solutions can be edited in the target — use for dev environments. | Export Type | Managed — for staging/production (Recommended), Unmanaged — for development environments |

#### 5.2 Trigger Export

```json
POST {envUrl}/api/data/v9.2/ExportSolutionAsync
{
  "SolutionName": "{hotfixSolutionName}",
  "Managed": true/false,
  ...all other flags false
}
```

Poll via `scripts/poll-async-operation.js`:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/poll-async-operation.js" \
  --asyncJobId "{AsyncOperationId}" \
  --envUrl "{envUrl}" \
  --intervalMs 5000 \
  --maxAttempts 60
```

#### 5.3 Download and Write Zip

```json
POST {envUrl}/api/data/v9.2/DownloadSolutionExportData
{ "ExportJobId": "{ExportJobId}" }
```

Decode `ExportSolutionFile` from base64 and write to project root:
- File name: `{hotfixSolutionName}_{managed|unmanaged}.zip`

Record `exportedAt` timestamp.

### Phase 6 — Import to Target Environment

#### 6.1 Ask Target Environment

Invoke `AskUserQuestion` immediately:

| Question | Header | Options |
|---|---|---|
| Which environment should this hotfix be imported into? | Target Environment | Current environment ({currentEnvUrl}), Different environment — I'll provide the URL |

If "Different environment": ask for the URL via a follow-up `AskUserQuestion`.

Acquire a token for the target environment URL.

#### 6.2 Stage (Dependency Check)

```json
POST {targetEnvUrl}/api/data/v9.2/StageSolution
{ "CustomizationFile": "{base64EncodedZip}" }
```

Use `scripts/encode-solution-file.js` to encode the zip.

If `MissingDependencies` is non-empty: list them and ask user to confirm proceeding.

#### 6.3 Import

```json
POST {targetEnvUrl}/api/data/v9.2/ImportSolutionAsync
{
  "CustomizationFile": "{base64EncodedZip}",
  "OverwriteUnmanagedCustomizations": true,
  "PublishWorkflows": true,
  "ConvertToManaged": false,
  "SkipProductUpdateDependencies": false,
  "HoldingSolution": false
}
```

Poll via `scripts/poll-async-operation.js` with `--intervalMs 8000 --maxAttempts 75`.

#### 6.4 Handle AttachmentBlocked Failure

If the poll returns `Failed` with `AttachmentBlocked` error code `-2147188706`:

**6.4.1 Identify Blocked Extensions**

List all file extensions in the zip:
```bash
unzip -l "{zipPath}" | awk '{print $4}' | grep '\.' | sed 's/.*\.//' | sort -u
```

Get the current blocked list: `pac env list-settings` (use target env — switch PAC CLI temporarily if needed).

Compute the intersection of zip extensions and blocked list.

**6.4.2 Ask Permission**

Invoke `AskUserQuestion` immediately — do NOT describe this as chat text:

| Question | Header | Options |
|---|---|---|
| The import failed because the target environment blocks file types (`{list}`) that are in this solution. Remove the block for these specific types so the hotfix can be imported? | Unblock Attachment Types | Yes, unblock `{list}` (Recommended), No, do not change environment settings |

**If "No"**: Stop with manual fix instructions.

**If "Yes"**: Remove only the specific extensions from `blockedattachments` via `pac env update-settings`, then retry import (repeat 6.3).

### Phase 7 — Verify and Summarize

1. Query target env to confirm solution exists:
   ```
   GET {targetEnvUrl}/api/data/v9.2/solutions?$filter=uniquename eq '{hotfixSolutionName}'&$select=solutionid,uniquename,version,ismanaged
   ```

2. Write `.last-hotfix.json` to project root:
   ```json
   {
     "exportedAt": "<ISO timestamp>",
     "importedAt": "<ISO timestamp>",
     "solutionName": "<hotfixSolutionName>",
     "baseSolution": "<baseSolutionUniqueName>",
     "sourceEnvironment": "<srcEnvUrl>",
     "targetEnvironment": "<targetEnvUrl>",
     "timeWindow": "<e.g., 2h>",
     "componentCount": N,
     "managed": true/false,
     "components": [
       { "id": "<guid>", "name": "<name>", "type": N }
     ]
   }
   ```

3. Display summary:

| Item | Value |
|---|---|
| Hotfix solution | `{hotfixSolutionName}` |
| Based on | `{baseSolutionUniqueName}` |
| Time window | Last `{window}` |
| Components deployed | N |
| Export type | Managed / Unmanaged |
| Target environment | `{targetEnvUrl}` |

**Suggested next steps**:
- Run `/power-pages:import-solution` to deploy the full base solution to a new environment
- Run `/power-pages:setup-pipeline` to automate hotfix deployments in CI/CD

## Key Decision Points (Wait for User)

1. **Phase 2**: Time window — scopes which components are included
2. **Phase 3**: Confirm component list — especially if Site Settings (type 9) are included
3. **Phase 5**: Managed vs unmanaged export
4. **Phase 6**: Target environment URL
5. **Phase 6.4**: Consent to unblock attachment types — never modify environment settings without explicit approval

## Error Handling

- If no components found in time window: stop and suggest widening the window
- If `AddSolutionComponent` fails for some components: report and continue with the rest; if all fail, stop before export
- If export fails: report error, stop
- If import fails with `AttachmentBlocked` (-2147188706): run Phase 6.4 remediation flow
- If import fails with other error: show `friendlyMessage`, stop
- Never attempt rollback

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| Verify prerequisites | Verifying prerequisites | Confirm PAC CLI auth, acquire Azure CLI token, verify API access, read .solution-manifest.json |
| Discover modified components | Discovering modified components | Ask time window, query powerpagecomponents by modifiedon, group by type |
| Review and confirm components | Reviewing components | Present grouped component list with security warnings, get user confirmation |
| Create hotfix solution | Creating hotfix solution | Create timestamped solution, discover componenttype, add all modified components |
| Export solution | Exporting solution | Ask managed/unmanaged, ExportSolutionAsync, poll, download and write zip |
| Import to target environment | Importing to target | Ask target env, stage (dependency check), ImportSolutionAsync, poll, handle AttachmentBlocked if needed |
| Verify and summarize | Verifying and summarizing | Confirm solution in target, write .last-hotfix.json, display summary |
