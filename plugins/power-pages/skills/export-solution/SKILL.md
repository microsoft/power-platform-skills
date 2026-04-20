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
1. Run `verify-alm-prerequisites.js` with `--require-manifest` to confirm PAC CLI auth, acquire a token, verify API access, and validate that `.solution-manifest.json` exists:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/verify-alm-prerequisites.js" --require-manifest
   ```
   Capture output as JSON; extract `.envUrl` (store as `envUrl`) and `.token` (store as `token`). If the script exits non-zero, stop and explain what is missing (reference `${CLAUDE_PLUGIN_ROOT}/references/dataverse-prerequisites.md`).

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

### Phase 2.5 — Pre-export Completeness Check

Before exporting, run the shared site-inventory helper to detect any components that exist on the site but are not in the solution. Catching this here avoids shipping an incomplete package to staging/prod.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/discover-site-components.js" \
  --envUrl "{envUrl}" --token "{token}" \
  --siteId "{websiteRecordId}" \
  --publisherPrefix "{publisherPrefix from .solution-manifest.json}" \
  --solutionId "{solutionId}"
```

Parse stdout and evaluate `missing`:

- **All `missing.*` arrays empty** → report "Solution contents match the site — no gaps detected." Proceed to Phase 3.
- **Any non-empty `missing.*` array** → present a concise summary:
  > "The solution is **missing {N}** component(s) that exist on the site:
  >
  > - **{X}** site components (e.g. {first 3 names}, …)
  > - **{Y}** cloud flows
  > - **{Z}** environment variable definitions with your publisher prefix
  > - **{W}** custom tables"

  Then ask via `AskUserQuestion`:
  > "How would you like to proceed?
  > 1. **Run `/power-pages:setup-solution` in sync mode now** — adopts missing components, bumps the solution version, then resumes this export (Recommended)
  > 2. **Export as-is** — ship what's currently in the solution; missing components won't travel
  > 3. **Abort** — I want to investigate before exporting"

  - Option 1: invoke `/power-pages:setup-solution` (auto-detects the existing manifest and enters sync mode). After it completes successfully, re-run the discovery helper to confirm `missing.*` are now empty and continue with Phase 3.
  - Option 2: record the gap in the export manifest (see Phase 7 summary) so the user has an audit trail of what was intentionally left out.
  - Option 3: stop the skill.

> **Why this exists**: historically, components created after `setup-solution` (server logic from `add-server-logic`, flows from `add-cloud-flow`, env vars from `configure-env-variables` / `setup-auth`) were silently left out of the export zip and didn't travel to target environments. The ALM-aware-by-default principle in `AGENTS.md` requires this check at every export gate.

### Phase 3 — Configure Export

Invoke `AskUserQuestion` immediately — do NOT describe this choice as chat text. The user must answer live before export proceeds.

| Question | Header | Options |
|---|---|---|
| How would you like to export this solution? **Managed** solutions cannot be edited in the target environment and support clean upgrade/delete cycles — recommended for staging and production. **Unmanaged** solutions can be edited in the target environment — use for dev-to-dev deployments. | Export Type | Managed — for staging/production (Recommended), Unmanaged — for development environments |

Use the answer to set `"Managed": true` or `"Managed": false` in the `ExportSolutionAsync` request body.

Also ask (separate `AskUserQuestion`):
- Output directory (default: current project root)

### Phase 4 — Trigger Async Export

Run `scripts/lib/export-solution-async.js` to POST `ExportSolutionAsync`, poll until terminal state, and return the `AsyncOperationId`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/export-solution-async.js" \
  --envUrl "{envUrl}" \
  --token "{token}" \
  --solutionName "{solutionUniqueName}" \
  --managed {true|false}
```

Capture stdout as JSON; extract `.asyncOperationId` (store as `asyncOperationId`).

Report: "Export job started. Polling for completion..."

Handle script exit code:
- Exit 0: job succeeded — proceed to Phase 5 with `asyncOperationId`
- Exit 1: stderr contains the failure message — report it and stop
- Timeout / polling exhausted: inform user the export is still running, advise checking admin center

### Phase 5 — Download Solution Zip

Run `scripts/lib/download-export-data.js` to POST `DownloadSolutionExportData`, decode the base64 zip, and write it to disk:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/download-export-data.js" \
  --envUrl "{envUrl}" \
  --token "{token}" \
  --asyncOperationId "{asyncOperationId}" \
  --outputPath "{outputDir}/{SolutionUniqueName}_{managed|unmanaged}.zip"
```

Capture stdout as JSON; extract `.zipPath` (store as `zipPath`) and `.fileSizeBytes`.

Report: "Downloading solution zip..."

Handle script exit code:
- Exit 0: zip written — proceed to Phase 6 with `zipPath` and `fileSizeBytes`
- Exit 1: stderr contains the failure message — report it and stop

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
