---
name: diagnose-deployment
description: >-
  Surfaces PAC CLI upload errors and Dataverse async operation errors, pattern-matches
  against a known failure catalog, and optionally auto-fixes identified issues. Use when
  asked to: "diagnose deployment", "debug deployment", "deployment failed", "show
  deployment errors", "fix deployment issues", "show upload logs", "why did my deploy fail",
  or "troubleshoot upload".
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
hooks:
  Stop:
    - hooks:
        - type: prompt
          prompt: |
            Check whether the diagnose-deployment skill completed successfully. Return { "ok": true } if ALL of the following are true, otherwise { "ok": false, "reason": "..." }:
            1. PAC CLI and Azure CLI auth were verified (or their absence was reported)
            2. Deployment artifacts were collected (powerpages.config.json, .powerpages-site/ contents)
            3. Upload errors were surfaced (either by re-running pac pages upload-code-site or reading prior output)
            4. Findings were pattern-matched against the deployment error catalog
            5. A summary table was presented showing all findings with severity and fix status
          timeout: 30
---

# diagnose-deployment

Surfaces and pattern-matches deployment errors against a known failure catalog. For each identified error with an available auto-fix, asks explicit user permission before applying any changes. Never auto-applies fixes without confirmation.

## Prerequisites

- Project root with `powerpages.config.json`
- PAC CLI installed (will report if missing)

## Phases

### Phase 1 — Verify Prerequisites and Locate Project

**Create all tasks upfront at the start of this phase.**

Tasks to create:
1. "Verify prerequisites and locate project"
2. "Collect deployment artifacts"
3. "Surface upload errors"
4. "Query solution import status"
5. "Diagnose and categorize findings"
6. "Offer auto-fixes"
7. "Present findings summary"

Steps:
1. Locate project root: search for `powerpages.config.json` in cwd and parent directories
2. Check PAC CLI: `pac --version` (report version or "not installed")
3. Check PAC CLI auth: `pac env who` (report environment URL or "not authenticated")
4. Check Azure CLI: `az account show` (report subscription or "not logged in")

Auth failures are non-blocking — report them as findings, continue collecting other artifacts.

### Phase 2 — Collect Deployment Artifacts

Gather all available context:

1. Read `powerpages.config.json` — extract `siteName`, `websiteRecordId`, `compiledPath`
2. Check `.powerpages-site/` folder exists
3. Glob for manifest files: `.powerpages-site/*-manifest.yml` — list all found, note their environment hostnames
4. Check if `.solution-manifest.json` exists (for solution-related diagnostics)
5. Check if `.last-import.json` exists (for recent import failures)
6. Check build output: confirm `{compiledPath}/` exists and is non-empty

Report: "Found project: `{siteName}`. Artifacts collected."

### Phase 3 — Surface Upload Errors

Re-run `pac pages upload-code-site` in capture mode to get fresh error output:

```bash
pac pages upload-code-site --rootPath "." 2>&1
```

> **Note**: This intentionally triggers the upload to capture any errors. If the upload succeeds cleanly, that is also a valid diagnostic result ("no errors found").

Capture stdout+stderr as a single string. Pass to `scripts/parse-deployment-errors.js`:

```bash
echo "{escaped-output}" | node "${CLAUDE_PLUGIN_ROOT}/scripts/parse-deployment-errors.js"
```

Parse the JSON findings array. If the upload succeeded with no errors, note this and skip to Phase 5 with an empty findings list.

### Phase 4 — Query Solution Import Status

Only run if `.solution-manifest.json` exists.

1. Acquire Azure CLI token for environment URL
2. Check recent async operations (last 24 hours):
   ```
   GET {envUrl}/api/data/v9.2/asyncoperations?$filter=statecode eq 3 and statuscode eq 31 and createdon gt {yesterday}&$select=asyncoperationid,name,message,friendlymessage,statuscode,completedon&$orderby=completedon desc&$top=5
   ```
3. Check recent import jobs:
   ```
   GET {envUrl}/api/data/v9.2/importjobs?$select=solutionname,completedon,progress&$orderby=completedon desc&$top=3
   ```
4. If failed operations found, pass each `message` field through `parse-deployment-errors.js`

Skip gracefully if auth is not available (auth failure in Phase 1).

### Phase 5 — Auto-Diagnose Known Issues

Consolidate all findings from Phases 3 and 4. For each finding, categorize:

- **Error**: Blocks deployment
- **Warning**: May cause issues
- **Info**: Informational

Also add findings for missing artifacts discovered in Phase 2:
- Missing `websiteRecordId` → Error (patternId: `missing-website-record-id`)
- Empty build output → Error (patternId: `empty-build`)
- Multiple environment manifests → Warning (may indicate environment confusion)

Present all findings in a table:

| # | Severity | Type | Issue | Auto-fix? |
|---|---|---|---|---|
| 1 | Error | upload | JavaScript uploads blocked | Yes |
| 2 | Warning | config | Multiple manifest files found | No |

### Phase 6 — Offer Auto-Fixes

For each Error finding with `autoFixAvailable: true`, in order:

1. Explain the issue and proposed fix
2. Ask explicit permission via `AskUserQuestion`:
   > "Issue: {message}
   > Proposed fix: {suggestedFix}
   > Apply this fix? Yes / No / Skip all auto-fixes"

3. If approved, execute the fix:

   **`stale-manifest`**: Delete `*-manifest.yml` file(s) in `.powerpages-site/`
   ```bash
   # Ask which manifest to delete if multiple found, then:
   rm ".powerpages-site/{manifestFile}"
   ```

   **`blocked-js`**: Update `blockedattachments` setting
   ```bash
   # Get current setting first
   pac env list-settings | grep -i blocked
   # Remove .js from the blocked list (preserve other blocked types)
   pac env update-settings --name blockedattachments --value "{updated-value}"
   ```

   **`missing-website-record-id`**: Retrieve and update record ID
   ```bash
   pac pages list
   # Parse output, find matching site by name, then update powerpages.config.json
   ```

   **`auth-expired`**: Guide re-authentication
   ```bash
   pac auth create --environment "{envUrl}"
   az login
   ```

   **`empty-build`**: Run build
   ```bash
   npm run build
   ```

4. After each fix, re-run the relevant check to verify it resolved the issue. Update finding status to "Fixed" or "Manual required".

> **Key Constraint**: Never apply any fix without explicit user permission. Each fix requires a separate confirmation.

### Phase 7 — Present Findings Summary

Display a final summary table of all findings:

| # | Severity | Type | Issue | Status |
|---|---|---|---|---|
| 1 | Error | upload | JS uploads blocked | Fixed |
| 2 | Error | config | Missing websiteRecordId | Manual required |
| 3 | Warning | config | Multiple manifest files | Informational |

**Status values**:
- **Fixed**: Auto-fix was applied and verified
- **Manual required**: No auto-fix available — show manual steps
- **Skipped**: User declined the fix
- **Informational**: Warning/Info, no action needed

If all errors are resolved: suggest retrying deployment with `/power-pages:deploy-site`.

If manual steps remain: list them explicitly with commands or links.

## Key Decision Points (Wait for User)

1. **Phase 6**: Each individual auto-fix requires explicit confirmation before applying
2. **Phase 6**: If user says "Skip all auto-fixes", stop offering fixes and go to summary

## Error Handling

- If `pac pages upload-code-site` produces no output: report "No upload errors detected in current state"
- If Azure CLI token unavailable: skip Phase 4, note in summary
- If `parse-deployment-errors.js` returns no findings: report "No known error patterns detected" and show raw output for manual review

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| Verify prerequisites and locate project | Verifying prerequisites | Check PAC CLI, Azure CLI, locate project root and powerpages.config.json |
| Collect deployment artifacts | Collecting deployment artifacts | Read config, list manifests, check build output, check solution manifest |
| Surface upload errors | Surfacing upload errors | Re-run pac pages upload-code-site in capture mode, parse stdout/stderr |
| Query solution import status | Querying solution import status | Check recent failed async operations and import jobs in Dataverse |
| Diagnose and categorize findings | Diagnosing findings | Pattern-match all errors against deployment-error-catalog, assign severity |
| Offer auto-fixes | Applying auto-fixes | For each fixable error, ask permission and execute fix, verify result |
| Present findings summary | Presenting summary | Show all findings table with severity and fix status, list manual steps |
