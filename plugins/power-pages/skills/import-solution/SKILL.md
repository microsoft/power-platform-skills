---
name: import-solution
description: >-
  Imports a Dataverse solution zip into a target environment, with optional staged import
  for dependency checking before committing. Use when asked to: "import solution",
  "install solution", "deploy solution zip", "push solution to environment",
  "deploy to staging", "deploy to production", or "install site in new environment".
user-invocable: true
argument-hint: "Optional: path to solution zip file"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
hooks:
  Stop:
    - hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/import-solution/scripts/validate-import.js"'
          timeout: 30
        - type: prompt
          prompt: |
            Check whether the import-solution skill completed successfully. Return { "ok": true } if ALL of the following are true, otherwise { "ok": false, "reason": "..." }:
            1. A valid solution zip file was located and verified to contain Solution.xml
            2. Import options (overwrite, staged vs direct) were confirmed with the user
            3. An async import job was triggered and polled to completion
            4. The solution was verified to exist in the target environment after import
            5. A completion summary was presented showing imported component count (or warnings/errors)
          timeout: 30
---

# import-solution

Imports a solution zip into a target Dataverse environment via `ImportSolutionAsync`. Supports optional staged import via `StageSolution` to check for missing dependencies before committing.

## Prerequisites

- PAC CLI installed and authenticated to the **target** environment
- Azure CLI installed and logged in
- Solution zip file exists on disk (produced by `export-solution`)

## Phases

### Phase 1 — Verify Prerequisites

**Create all tasks upfront at the start of this phase.**

Tasks to create:
1. "Verify prerequisites"
2. "Locate solution file"
3. "Configure import"
4. "Stage solution (dependency check)"
5. "Import solution"
6. "Verify import"
7. "Detect cloud flows"
8. "Present summary"

> **Note**: If the import fails with an `AttachmentBlocked` error, a Phase 5b remediation flow runs inline — no additional task is needed (it continues within the "Import solution" task). The "Detect cloud flows" task is skipped automatically if no Workflows/*.json files are present in the solution zip.

Steps:
1. Run `pac env who` — extract `environmentUrl` (verify this is the **target** environment)
2. Run `az account get-access-token --resource "{environmentUrl}" --query accessToken -o tsv` — capture token
3. Verify API access: `GET {environmentUrl}/api/data/v9.2/WhoAmI`
4. Present target environment URL and ask user to confirm this is correct before proceeding.

> **Important**: Confirm the target environment with the user — importing to the wrong environment can be disruptive.

If any check fails, stop (reference `${CLAUDE_PLUGIN_ROOT}/references/dataverse-prerequisites.md`).

### Phase 2 — Locate Solution File

1. If a zip path was provided as an argument, use it directly
2. Otherwise, search for solution zips: `glob('**/*.zip', { ignore: ['**/node_modules/**'] })`
3. For each found zip, verify it contains `solution.xml`:
   - Use `Bash`: `unzip -l "{zipPath}" 2>/dev/null | grep -qi solution.xml`
4. If multiple valid zips found: ask user to choose via `AskUserQuestion`
5. If no valid zip found: stop and explain — run `export-solution` first or provide the zip path

**Step 5a — Pre-import content inspection** (run after zip is confirmed, before presenting to user):

Inspect the zip to surface post-import manual requirements. Run all checks in sequence:

```bash
# 1. Connection references (require user-binding post-import)
unzip -p "{zipPath}" customizations.xml 2>/dev/null | grep -c '<connectionreference '

# 2. Bots (require republishing in target environment)
unzip -l "{zipPath}" 2>/dev/null | grep -qi "bots/" && echo "found" || echo "none"

# 3. Cloud flows with hardcoded environment URLs (will silently fail in target)
unzip -p "{zipPath}" "Workflows/*.json" 2>/dev/null | grep -o '"organization":\s*"https://[^"]*"' | head -5
```

Build a `postImportWarnings` list from the results:

| Finding | Warning to surface |
|---|---|
| `connectionreference` count > 0 | "⚠️ **Connection references**: This solution includes N connection(s) (e.g. Dataverse connector). After import, you must bind each connection reference to a live connection in the target environment, or cloud flows that depend on them will be disabled." |
| `bots/` folder present | "⚠️ **Copilot Studio bot**: This solution includes a bot. After import, the bot must be republished in the target environment to complete provisioning." |
| Hardcoded org URL found | "⚠️ **Hardcoded environment URL**: The cloud flow contains a hardcoded environment URL (`{foundUrl}`). This will cause the flow to call the source environment after import. Edit the flow in the target environment to update the URL." |

If `postImportWarnings` is non-empty, display all warnings inline (not via `AskUserQuestion`) before presenting the zip details. The user should see these before confirming.

Present the selected zip file details (name, size, path), any pre-import warnings, and confirm with user.

### Phase 3 — Configure Import

Ask user (via `AskUserQuestion`):

> **Key Decision Point**: **Staged vs Direct import**
> - **Staged (Recommended for managed solutions)**: Runs `StageSolution` first to check for missing dependencies. Shows issues before committing the import. Safer — the stage step is fully reversible.
> - **Direct**: Skips staging and imports immediately. Faster but may fail mid-import if dependencies are missing.

Also ask:
- **Overwrite unmanaged customizations?** (default: Yes) — needed when target has customized the same components
- **Publish workflows after import?** (default: Yes)

### Phase 4 — Stage Solution (Conditional)

Only run this phase if the user chose staged import in Phase 3.

Refer to `${CLAUDE_PLUGIN_ROOT}/references/solution-api-patterns.md` Section 5a.

1. Base64-encode the zip file:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/encode-solution-file.js" --zipPath "{zipPath}"
   ```
2. `POST {envUrl}/api/data/v9.2/StageSolution` with `CustomizationFile: {base64}`
3. Parse `StageSolutionResults`:
   - Extract `StageSolutionUploadId` (used in Phase 5 instead of re-encoding the file)
   - Check `MissingDependencies` array
4. If `MissingDependencies` is non-empty:
   - List each missing dependency with its type and name
   - Ask user: "These dependencies are missing in the target environment. Proceed anyway (may fail) or cancel to install dependencies first?"
   - If cancel: stop and advise installing missing dependencies
5. If `MissingDependencies` is empty: report "No missing dependencies found. Ready to import."

### Phase 5 — Import Solution

Refer to `${CLAUDE_PLUGIN_ROOT}/references/solution-api-patterns.md` Section 5b.

1. Prepare request body (always use `CustomizationFile` — `ImportSolutionAsync` does not accept `StageSolutionUploadId`):
   - Encode the zip: `node "${CLAUDE_PLUGIN_ROOT}/scripts/encode-solution-file.js" --zipPath "{zipPath}"`
   - Use `{ CustomizationFile: "{base64}", OverwriteUnmanagedCustomizations: {choice}, PublishWorkflows: {choice} }`

2. `POST {envUrl}/api/data/v9.2/ImportSolutionAsync`
3. Extract `AsyncOperationId` and `ImportJobKey` (note: field is `ImportJobKey`, not `ImportJobId`)
4. Report: "Import job started: `{AsyncOperationId}`. Polling for completion..."

Run `scripts/poll-async-operation.js`:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/poll-async-operation.js" \
  --asyncJobId "{AsyncOperationId}" \
  --envUrl "{envUrl}" \
  --token "{token}" \
  --intervalMs 8000 \
  --maxAttempts 75
```

Handle poll result:
- `Succeeded`: proceed to Phase 6
- `Failed` with `AttachmentBlocked` / error code `-2147188706`: proceed to **Phase 5b** below
- `Failed` (other): show error message, query import job for component-level errors, stop
- `Timeout`: inform user, advise checking admin center

### Phase 5b — Resolve Attachment Restrictions (conditional)

Only run this phase if Phase 5 poll failed with `AttachmentBlocked` (`-2147188706` or message contains `AttachmentBlocked` or `not a valid type`).

#### 5b.1 Identify Blocked Extensions in the Solution Zip

List all files in the zip and extract unique extensions:
```bash
unzip -l "{zipPath}" | awk '{print $4}' | grep '\.' | sed 's/.*\.//' | sort -u
```

Get the current blocked attachments list from the environment:
```bash
pac env list-settings
```

Find the `blockedattachments` row in the output — it contains a semicolon-separated list (e.g., `ade;adp;js;zip;...`).

Compute the **intersection**: which extensions from the solution zip appear in the blocked list. These are the types that need to be unblocked.

#### 5b.2 Explain the Issue

Tell the user:
> "The solution import failed because the target environment blocks certain file types that are included in this solution. The following file extensions in the solution are currently blocked: **`{comma-separated list}`**. This is an environment-level security setting. To import this solution, these restrictions need to be temporarily relaxed."

#### 5b.3 Ask for Permission

Invoke `AskUserQuestion` immediately — do NOT present this as a chat message. The user must answer live before the skill proceeds.

| Question | Header | Options |
|---|---|---|
| The solution contains file types (`{list}`) that are blocked by this environment's attachment security settings. Would you like to remove the block for these specific types so the solution can be imported? | Unblock Attachment Types | Yes, unblock `{list}` for this import (Recommended), No, do not change environment settings |

**If "No"**: Stop and tell the user: "The import cannot proceed while these file types are blocked. To unblock manually: Power Platform Admin Center → Environments → {env} → Settings → Product → Features → Blocked Attachments."

**If "Yes"**: Proceed to 5b.4.

#### 5b.4 Update Blocked Attachments

1. Parse the `blockedattachments` value (semicolon-separated)
2. Remove **only** the extensions identified in 5b.1 — preserve all others
3. Update the setting:
   ```bash
   pac env update-settings --name blockedattachments --value "{updated-list-with-types-removed}"
   ```
4. Confirm the update succeeded.

#### 5b.5 Retry Import

Re-encode the zip and retry `ImportSolutionAsync` (repeat Phase 5 steps 1–4 and poll again).

- If `Succeeded`: proceed to Phase 6
- If failed again with a different error: show the new error message and stop — do not retry further

### Phase 6 — Verify Import

1. Query solution to confirm it exists and version matches:
   ```
   GET {envUrl}/api/data/v9.2/solutions?$filter=uniquename eq '{solutionName}'&$select=solutionid,uniquename,version,ismanaged
   ```

2. Query import job for component results (use `ImportJobKey` from the import response):
   ```
   GET {envUrl}/api/data/v9.2/importjobs({ImportJobKey})?$select=solutionname,completedon,progress,data
   ```
   - Parse the `data` XML field for per-component results (look for `result="failure"` entries)
   - Count: imported successfully / warnings / failures

3. Write `.last-import.json` marker to project root:
   ```json
   {
     "importedAt": "<ISO timestamp>",
     "solutionName": "<name>",
     "version": "<version>",
     "targetEnvironment": "<envUrl>",
     "asyncOperationId": "<id>",
     "importJobId": "<ImportJobKey value>",
     "componentResults": { "success": N, "warning": N, "failure": N }
   }
   ```

### Phase 6b — Set Environment Variable Values (if any)

After a successful import, env var **definitions** travel in the solution but their **values do not**. The target environment will have the definition records but blank values until explicitly set.

Query the target environment for any env var definitions from this solution:
```
GET {envUrl}/api/data/v9.2/environmentvariabledefinitions?$filter=introducedversion ne null&$select=schemaname,displayname,type,defaultvalue,environmentvariabledefinitionid
```

Filter to only those whose `schemaname` starts with the publisher prefix (from `.solution-manifest.json`), or cross-reference with `solutioncomponents` if available.

For each definition found, check if a value already exists in the target:
```
GET {envUrl}/api/data/v9.2/environmentvariablevalues?$filter=_environmentvariabledefinitionid_value eq '{id}'&$select=value
```

**If any definitions have no existing value**, present them to the user via `AskUserQuestion`:

> "The imported solution contains **{N} environment variable(s)** with no value set in this environment. Enter the target value for each (leave blank to skip and use the default):
>
> 1. `{schemaname}` ({displayname}) — default: `{defaultvalue ?? 'none'}`
> 2. ..."

For each value the user provides, POST an `environmentvariablevalue` record:
```
POST {envUrl}/api/data/v9.2/environmentvariablevalues
{
  "schemaname": "{schemaname}",
  "value": "{userValue}",
  "EnvironmentVariableDefinitionId@odata.bind": "/environmentvariabledefinitions({id})"
}
```

> **Note on Secret type (type 100000003):** Secret values are stored encrypted. The POST behaves the same but the value will be masked in the UI. The user should provide the actual secret value for the target environment (e.g. the OAuth client secret for the production tenant's app registration — different from the dev value).

If the user skips all values: inform them the site may not function correctly until values are set, and provide the direct Power Platform URL to set them manually:
`https://{targetEnvHost}/main.aspx?appid=...&etn=environmentvariabledefinition`

### Phase 6c — Detect Cloud Flows (if any)

After import succeeds, check whether the solution contains cloud flow JSON files. Use the zip path located in Phase 2.

```bash
unzip -l "{zipPath}" | grep -i "^.*Workflows/.*\.json"
```

If no matching files are found, skip this phase entirely.

If cloud flow files are found:
1. Extract the flow name from each path (pattern: `Workflows/FlowName-GUID.json` — strip the path prefix and GUID suffix to get the display name)
2. Inform the user:

   > "This solution contains **{N} cloud flow(s)**. Cloud flows must be registered with the Power Pages site in the target environment after import."
   >
   > Flows detected:
   > - `{FlowName1}`
   > - `{FlowName2}`
   > ...
   >
   > To register: **Power Pages Management** → target environment → Edit site → **Set up** → **Cloud flows** → register each flow listed above.
   >
   > Direct link: `https://make.powerpages.microsoft.com/`

3. Invoke `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Have you registered the cloud flow(s) listed above with the Power Pages site in `{targetEnvUrl}`? | Cloud Flow Registration | Flows registered — continue, I'll register them later |

4. Record the user's response as `cloudFlowStatus`: `"Registered"` or `"Pending registration"`. This status is shown in the Phase 7 summary row — either answer allows the skill to continue.

### Phase 6d — Check Site Activation (if Power Pages solution)

Only run this phase if the solution contains Power Pages website components (componentType `10374`):

```
GET {envUrl}/api/data/v9.2/solutioncomponents?$filter=_solutionid_value eq '{solutionId}' and componenttype eq 10374&$select=objectid
```

If no componentType 10374 records found, skip this phase entirely.

If found, run the shared activation status check (PAC CLI is already authenticated to the target environment):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-activation-status.js" --projectRoot "."
```

Evaluate the result:

- **`activated: true`**: Store `siteUrl` for the Phase 7 summary. No further action needed.
- **`activated: false`**: Ask the user via `AskUserQuestion`:

  | Question | Header | Options |
  |---|---|---|
  | The Power Pages site was imported but is not yet activated (provisioned) in `{envUrl}`. Activate it now to make it publicly accessible. | Activate Site | Yes, activate now (Recommended), No, I'll activate later |

  - **If "Yes"**: Invoke `/power-pages:activate-site`. The activate-site skill will handle subdomain selection, confirmation, and provisioning.
  - **If "No"**: Note in the Phase 7 summary that activation is pending and remind the user to run `/power-pages:activate-site` when ready.

- **`error` present**: Skip silently — do not block the summary. Note in Phase 7 that activation status could not be determined.

### Phase 7 — Present Summary

Display a summary table:

| Item | Value |
|---|---|
| Solution | `{solutionName}` v`{version}` |
| Target environment | `{envUrl}` |
| Managed | Yes / No |
| Components imported | N success, N warning, N failure |
| Env var values set | N of N |
| Cloud flows | `{cloudFlowStatus}` (Registered / Pending registration / Not applicable) |
| Site activation | Activated at `{siteUrl}` / Pending / Not applicable |
| Import job | `{importJobId}` |

## Key Decision Points (Wait for User)

1. **Phase 1**: Confirm target environment — import is not easily undoable for managed solutions
2. **Phase 2**: Select zip file if multiple found
3. **Phase 3**: Staged vs direct import; overwrite customizations
4. **Phase 4**: Proceed despite missing dependencies
5. **Phase 5b**: Consent to unblock attachment types — never modify environment settings without explicit approval
6. **Phase 6b**: Env var values — always prompted if solution contains env var definitions with no existing value in the target; Secret type definitions require the user's target-environment-specific secret value
7. **Phase 6c**: Cloud flow registration — non-blocking; user may register later; status recorded in summary
8. **Phase 6d**: Site activation — only if Power Pages website components present and site not yet activated

## Error Handling

- Component-level import failures: report in summary, do not block overall completion
- If import async operation fails with `AttachmentBlocked` (-2147188706): run Phase 5b remediation flow (identify blocked types, get consent, unblock, retry)
- If import async operation fails with other error: show `friendlyMessage` from async operation record, stop
- Never attempt rollback — report what succeeded and what failed
- Never modify environment settings (`blockedattachments`) without explicit user approval

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| Verify prerequisites | Verifying prerequisites | Confirm PAC CLI auth, acquire token, verify target environment with user |
| Locate solution file | Locating solution file | Find and validate solution zip, confirm Solution.xml present |
| Configure import | Configuring import | Ask: staged vs direct, overwrite customizations, publish workflows |
| Stage solution (dependency check) | Staging solution | Run StageSolution to check for missing dependencies before committing |
| Import solution | Importing solution | POST ImportSolutionAsync, poll until complete; if AttachmentBlocked: identify blocked types, get user consent, unblock via pac env update-settings, retry |
| Verify import | Verifying import | Confirm solution version in target, parse component results, write .last-import.json |
| Detect cloud flows | Detecting cloud flows | List Workflows/*.json entries in zip; if found, prompt user to register flows with Power Pages site; record status (Registered / Pending registration) |
| Check site activation | Checking site activation | If solution has componentType 10374: run check-activation-status.js; if not activated, ask user and invoke /power-pages:activate-site |
| Present summary | Presenting summary | Show component counts (success/warning/failure), cloud flow registration status, site activation status, env var values set |
