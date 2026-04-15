---
name: export-solution
description: >-
  Exports a Dataverse solution containing Power Pages site components as a zip file,
  ready for deployment to another environment. Use when asked to: "export solution",
  "download solution", "export managed", "export unmanaged", "package for deployment",
  "create solution zip", "export site package", or "build deployment artifact".
user-invocable: true
argument-hint: "Optional: 'managed' or 'unmanaged' (default: asks)"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
hooks:
  Stop:
    - hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/export-solution/scripts/validate-export.js"'
          timeout: 30
        - type: prompt
          prompt: |
            Check whether the export-solution skill completed successfully. Return { "ok": true } if ALL of the following are true, otherwise { "ok": false, "reason": "..." }:
            1. The solution was identified (by name) in the target Dataverse environment
            2. The export type (managed or unmanaged) was confirmed with the user
            3. An async export job was triggered and polled to completion
            4. The solution zip file was downloaded and written to disk
            5. The zip file was verified to contain Solution.xml
            6. A completion summary was presented with the zip path and size
          timeout: 30
---

# export-solution

Triggers an async Dataverse solution export, polls until complete, downloads the solution zip, and verifies it. Reads `.solution-manifest.json` to identify the solution; falls back to asking the user.

## Prerequisites

- PAC CLI installed and authenticated
- Azure CLI installed and logged in
- Solution exists in the environment (run `setup-solution` first if needed)

## Phases

### Phase 1 — Verify Prerequisites

**Create all tasks upfront at the start of this phase.**

Tasks to create:
1. "Verify prerequisites"
2. "Identify solution"
3. "Configure export"
4. "Trigger async export"
5. "Download solution zip"
6. "Verify export"
7. "Present summary"

Steps:
1. Run `pac env who` — extract `environmentUrl`
2. Run `az account get-access-token --resource "{environmentUrl}" --query accessToken -o tsv` — capture token
3. Verify API access: `GET {environmentUrl}/api/data/v9.2/WhoAmI`

If any check fails, stop and explain (reference `${CLAUDE_PLUGIN_ROOT}/references/dataverse-prerequisites.md`).

### Phase 2 — Identify Solution

1. Look for `.solution-manifest.json` in project root (use `findProjectRoot` or `glob('**/.solution-manifest.json')`)
2. If found: read `solution.uniqueName`, `solution.solutionId`, `environmentUrl`
   - Verify environment URLs match (warn if different — may be cross-environment export)
3. If not found: ask user for solution unique name via `AskUserQuestion`
4. Confirm solution exists in environment:
   ```
   GET {envUrl}/api/data/v9.2/solutions?$filter=uniquename eq '{solutionName}'&$select=solutionid,uniquename,friendlyname,version,ismanaged
   ```
5. Present solution details and confirm with user.

### Phase 3 — Configure Export

Invoke `AskUserQuestion` immediately — do NOT describe this choice as chat text. The user must answer live before export proceeds.

| Question | Header | Options |
|---|---|---|
| How would you like to export this solution? **Managed** solutions cannot be edited in the target environment and support clean upgrade/delete cycles — recommended for staging and production. **Unmanaged** solutions can be edited in the target environment — use for dev-to-dev deployments. | Export Type | Managed — for staging/production (Recommended), Unmanaged — for development environments |

Use the answer to set `"Managed": true` or `"Managed": false` in the `ExportSolutionAsync` request body.

Also ask (separate `AskUserQuestion`):
- Output directory (default: current project root)

### Phase 4 — Trigger Async Export

Refer to `${CLAUDE_PLUGIN_ROOT}/references/solution-api-patterns.md` Section 4a.

1. `POST {envUrl}/api/data/v9.2/ExportSolutionAsync` with solution name and managed flag
2. Parse response to extract `AsyncOperationId` and `ExportJobId`
3. Report: "Export job started: `{AsyncOperationId}`. Polling for completion..."

Run `scripts/poll-async-operation.js`:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/poll-async-operation.js" \
  --asyncJobId "{AsyncOperationId}" \
  --envUrl "{envUrl}" \
  --token "{token}" \
  --intervalMs 5000 \
  --maxAttempts 60
```

Handle poll result:
- `Succeeded`: proceed to Phase 5
- `Failed`: report the error message, stop
- `Timeout`: inform user the export is still running, advise checking admin center

### Phase 5 — Download Solution Zip

Refer to `${CLAUDE_PLUGIN_ROOT}/references/solution-api-patterns.md` Section 4b.

1. `POST {envUrl}/api/data/v9.2/DownloadSolutionExportData` with `ExportJobId`
2. Parse response to extract `ExportSolutionFile` (base64-encoded zip)
3. Decode base64 and write to disk:
   - File name: `{SolutionUniqueName}_{managed|unmanaged}.zip`
   - Location: output directory configured in Phase 3
4. Report: "Downloading solution zip..."

> **Note**: For very large solutions, the base64 string may be large. Use Node.js `Buffer.from(encoded, 'base64')` to decode, then `fs.writeFileSync` to write.

### Phase 6 — Verify Export

1. Confirm zip file exists on disk: check `fs.existsSync(zipPath)`
2. Confirm file size > 1000 bytes
3. Verify `Solution.xml` is inside the zip:
   - Run `unzip -l "{zipPath}" | grep -i solution.xml` or read zip TOC via Node.js (use `Bash` with unzip)
   - If solution.xml not found: report error — the zip may be corrupt or the download was truncated

### Phase 7 — Present Summary

Display a summary:

| Item | Value |
|---|---|
| Solution | `{solutionName}` v`{version}` |
| Export type | Managed / Unmanaged |
| File | `{zipPath}` |
| File size | `{size} KB` |
| Export job | `{AsyncJobId}` |

**Suggested next steps**:
- Run `/power-pages:import-solution` to deploy this zip to another environment
- Run `/power-pages:setup-pipeline` to automate this process in CI/CD

## Key Decision Points (Wait for User)

1. **Phase 2**: Solution identification — confirm before triggering export
2. **Phase 3**: Managed vs unmanaged — affects downstream importability (irreversible choice for this export)

## Error Handling

- If export job fails: show `message` and `friendlyMessage` from the async operation
- If download returns empty `ExportSolutionFile`: report error, suggest re-exporting
- Never retry automatically — report failure and let user decide

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| Verify prerequisites | Verifying prerequisites | Confirm PAC CLI auth, acquire Azure CLI token, verify API access |
| Identify solution | Identifying solution | Read .solution-manifest.json or ask user, confirm solution exists in environment |
| Configure export | Configuring export | Ask user: managed vs unmanaged, output directory |
| Trigger async export | Triggering async export | POST ExportSolutionAsync, capture AsyncJobId, poll until complete |
| Download solution zip | Downloading solution zip | POST DownloadSolutionExportData, decode base64, write zip to disk |
| Verify export | Verifying export | Confirm zip exists, size > 0, Solution.xml present inside |
| Present summary | Presenting summary | Show zip path, size, type, and suggested next steps |
