---
name: import-solution
description: >-
  Imports a Dataverse solution zip into a target environment, with optional staged import
  for dependency checking before committing. Use when asked to: "import solution",
  "install solution", "deploy solution zip", "push solution to environment",
  "deploy to staging", "deploy to production", or "install site in new environment".
user-invocable: true
argument-hint: "Optional: path to solution zip file"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_search, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_fetch
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# import-solution

Imports a solution zip into a target Dataverse environment via `ImportSolutionAsync`. Supports optional staged import via `StageSolution` to check for missing dependencies before committing.

## Prerequisites

- PAC CLI installed and authenticated to the **target** environment
- Azure CLI installed and logged in
- Solution zip file exists on disk (produced by `export-solution`)

## Phases

### Phase 0 — ALM plan gate

> **`plan-alm` is the front door.** When the user expresses an ALM intent (*promote / ship / deploy / set up CI-CD / move to staging / push to prod*), the orchestrator (`/power-pages:plan-alm`) should run first. This Phase 0 enforces that and is meant to fail closed when there's no plan, not to be a one-time check the user can dismiss forever.

**Skip rule.** If this skill was invoked *as part of an active `plan-alm` orchestration*, skip Phase 0 entirely and proceed to Phase 1. The gate helper exposes this via its `inExecution` block — pass through silently to Phase 1 when:

```
inExecution.status === "active"
```

The helper computes this from `docs/.alm-plan-data.json` — `PLAN_STATUS === "In Execution"` AND `LAST_INVOCATION_AT` within the last 60 minutes. `check-alm-plan.js` refreshes `LAST_INVOCATION_AT` automatically on every invocation that finds the plan in execution, so each in-chain skill keeps the chain alive for the next one — even multi-hour deploys (deploy-pipeline alone can take 60 min per stage) survive the window without the chain incorrectly de-classifying. Stalled chains (no heartbeat for > 60 min) reclassify as `stale-heartbeat` and Phase 0 gates fire normally so an abandoned plan doesn't silently bypass user confirmation.

When `inExecution.status` is anything other than `"active"` (`"not-running"`, `"stale-heartbeat"`, `"no-plan"`), run the Phase 0 gate flow below. Branch on the remaining helper fields:

**Step 1 — Run the gate helper.**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/check-alm-plan.js" --projectRoot "."
```

The helper returns JSON with `{ exists, deferred, stale, staleness: { reason, detail }, generatedAt, planStatus, ... }`. Pass `--envUrl`, `--token`, `--solutionId` once Phase 1 has acquired them if you also want a freshness check; otherwise the helper does an existence-only check, which is sufficient for the gate decision below.

**Step 2 — Branch on the result.**

| Result | Behavior |
|---|---|
| `deferred: true` | The user has explicitly deferred ALM for this project (`.alm-deferred` marker present). Pass through silently to Phase 1 — do not nag. |
| `exists: false` | The user hasn't run `plan-alm` yet. See Step 3. |
| `exists: true, stale: false` | Plan is current. Pass through silently to Phase 1. |
| `exists: true, stale: true` (reason: `solution-modified`) | The solution changed after the plan was generated. See Step 4. |

**Step 3 — No plan.** Tell the user:

> "No ALM plan exists for this project. `/power-pages:plan-alm` builds one — it detects the project state, asks about your promotion strategy (PP Pipelines vs Manual export/import), and orchestrates the right skills (including this one) in the right order. Want me to run plan-alm now?"

<!-- gate: import-solution:0.no-plan | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · import-solution:0.no-plan):** Fail-closed entry gate when `check-alm-plan.js` returns `exists:false`. Helper-script-backed.

`AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Run `/power-pages:plan-alm` first? | ALM plan gate | Yes — run /power-pages:plan-alm now (Recommended), Continue without a plan (advanced — I know what I'm doing), Cancel |

- **Yes (Recommended)** → invoke `/power-pages:plan-alm`. It builds the plan and returns — `plan-alm` is a planner and does not deploy. This skill then re-runs the Phase 0 check (now `exists:true`) and proceeds to Phase 1.
- **Continue without a plan** → set `BYPASSED_PLAN_GATE = true` and proceed to Phase 1.
- **Cancel** → exit cleanly.

**Step 4 — Stale plan.** Tell the user:

> "ALM plan exists from `{generatedAt}` but the source solution has been modified since (at `{solution.modifiedon}`). Components may have changed. Re-running `plan-alm` will refresh the analysis and the rendered HTML."

<!-- gate: import-solution:0.stale-plan | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · import-solution:0.stale-plan):** Fail-closed entry gate when `check-alm-plan.js` returns `stale:true`. Helper-script-backed.

`AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Refresh the plan first? | ALM plan freshness | Refresh — re-run /power-pages:plan-alm (Recommended), Continue with the existing plan, Cancel |

- **Refresh (Recommended)** → invoke `/power-pages:plan-alm`. After completion, re-run the Phase 0 helper once to confirm freshness; if still stale, surface the detail and proceed to Phase 1 anyway (don't infinite-loop).
- **Continue** → set `STALE_PLAN_ACK = true` and proceed to Phase 1.
- **Cancel** → exit cleanly.

**Why this gate exists.** Direct invocation of `import-solution` deploys a zip into a target environment without the orchestrator's deployment-strategy selection or post-import validation steps. Users running this skill standalone often skip the staged-import dependency check, miss env var override values for the target environment, and have no plan-tracked record of which environment received which artifact version. The gate ensures `plan-alm` either ran (so the strategy was selected, per-stage values were captured in `deployment-settings.json`, and the deployment is reproducible) or the user explicitly chose to bypass it.

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

### Phase 1.5 — Ground in current ALM documentation

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/alm-docs-grounding.md`

Cap this step at ~30 seconds. If MCP search / fetch errors out, log a one-line note and continue — this skill must remain runnable offline.

1. Run `microsoft_docs_search` with the query: `Power Pages solution import staging missing dependencies ImportSolutionAsync ALM`.
2. Fetch `https://learn.microsoft.com/en-us/power-platform/alm/solution-concepts-alm` (and at most one sister page on staged imports or dependency handling) in parallel via `microsoft_docs_fetch`.
3. Extract a one-paragraph summary of what Microsoft Learn currently says about staging vs direct import, dependency resolution, and component-level error handling. Compare against `${CLAUDE_PLUGIN_ROOT}/references/solution-api-patterns.md` and flag any divergence in `ImportSolutionAsync` / `StageSolution` signatures.
4. Use the summary to inform Phase 2+ decisions. Do not silently change skill behavior — surface any divergence to the user as a soft warning before Phase 4 (the actual import).

### Phase 2 — Locate Solution File

1. If a zip path was provided as an argument, use it directly
2. Otherwise, search for solution zips: `glob('**/*.zip', { ignore: ['**/node_modules/**'] })`
3. For each found zip, verify it contains `solution.xml`:
   - Use `Bash`: `unzip -l "{zipPath}" 2>/dev/null | grep -qi solution.xml`
4. If multiple valid zips found, ask user to choose:

   <!-- gate: import-solution:2.multiple-zips | category=plan | cancel-leaves=nothing -->
   > 🚦 **Gate (plan · import-solution:2.multiple-zips):** More than one valid solution zip was discovered under the project root. User picks which one to import. Cancel exits before any target-env interaction.

   Use `AskUserQuestion` with one option per valid zip — show filename + size + modified date so the user can identify the right one (most-recent export is usually the intended target).
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

**Step 3.0 — Version-skew advisory (read-only check before any prompt).**

Before asking the user about staged/direct import, query the target environment for the solution unique name carried in the zip and compare the installed version against the zip's version. The goal is to surface "you're about to import the same version that's already installed" before the user clicks through — this is the most common silent-failure pattern for the manual export/import path, because the source-side bump is what produces an unambiguously promotable artifact.

1. **Extract the zip's `uniqueName` + `version`** from `solution.xml` inside the zip:
   ```bash
   unzip -p "{zipPath}" solution.xml 2>/dev/null | head -50
   ```
   Parse `<UniqueName>` and `<Version>` from the XML. Store as `ZIP_SOLUTION_NAME` and `ZIP_SOLUTION_VERSION`.

2. **Query the target for the installed solution**:
   ```
   GET {envUrl}/api/data/v9.2/solutions?$filter=uniquename eq '{ZIP_SOLUTION_NAME}'&$select=solutionid,uniquename,version,ismanaged
   ```
   Store the result as `INSTALLED` (or `null` if the filter returns an empty `value` array).

3. **Compare versions via the shared helper, then branch on the result.**

   **Precondition — skip this entire step when `INSTALLED` is `null`.** That's the first-time-install case: there's nothing on the target to compare against. Do NOT call the helper with `null` substituted into `'{INSTALLED.version}'` — it would throw "version is required" and leave the agent without a branch. Jump straight to the staged/direct prompt below and treat the import as a fresh install.

   Otherwise (`INSTALLED` is non-null), compare versions:

   Critical: **do not compare version strings with raw `>` / `<` / `===`** — Dataverse versions are 4-segment integer tuples (`1.0.0.9` vs `1.0.0.10`) and lexical comparison reports `1.0.0.10` as **lower than** `1.0.0.9`, flipping the skew gate on the 10th deploy of the day. Use the canonical helper instead:

   ```bash
   node -e "console.log(require('${CLAUDE_PLUGIN_ROOT}/scripts/lib/bump-solution-version').compareVersions('{ZIP_SOLUTION_VERSION}', '{INSTALLED.version}'))"
   ```

   The helper returns `-1` when ZIP < INSTALLED, `0` when equal, `1` when ZIP > INSTALLED. Same segment-wise integer rules as `bumpPatchSegment` (pad-with-zero, max-4-segments, reject non-integer). Capture stdout, trim, and store the integer as `VERSION_CMP`. If the helper throws (malformed version on either side), surface the stderr to the user and stop — the version comparison is a precondition for safe import.

   | `INSTALLED` | `VERSION_CMP` | Behavior |
   |---|---|---|
   | `null` | (helper not called — see precondition above) | First-time install. Continue silently to the staged/direct prompt below. |
   | not null | `1` (zip is strictly greater) | Normal upgrade. Report: *"Target has v{INSTALLED.version} installed; this zip is v{ZIP_SOLUTION_VERSION}. Importing will upgrade."* |
   | not null | `0` (zip equals installed) | **Surface the warning below** (same-version skew — applies to both managed and unmanaged). |
   | not null | `-1` (zip is strictly less) | **Surface the warning below** (downgrade — applies to both managed and unmanaged). |

   <!-- gate: import-solution:3.0.version-skew | category=consent | cancel-leaves=nothing -->
   > 🚦 **Gate (consent · import-solution:3.0.version-skew):** Zip version is equal-to or lower-than the installed solution's version on the target. Importing produces unpredictable upgrade semantics; the source `export-solution` is supposed to bump the version on every export. Re-export with bumped version, force the import anyway, or cancel.

   **Warning prompt** — `AskUserQuestion`:

   > "The target environment already has **`{ZIP_SOLUTION_NAME}` v`{INSTALLED.version}`** installed ({INSTALLED.ismanaged ? 'managed' : 'unmanaged'}). The zip you are about to import carries version `{ZIP_SOLUTION_VERSION}`.
   >
   > Importing the same or a lower version is unreliable:
   > - **Managed**: no upgrade lineage; the platform may apply or reject the import depending on internal heuristics.
   > - **Unmanaged**: behavior depends entirely on `OverwriteUnmanagedCustomizations: true`, and any in-target edits that happen to match the zip's component IDs get silently overwritten without a version change to point to.
   >
   > `/power-pages:export-solution` always bumps the source version before producing a zip (since 2026-05-25). If this zip was produced before that change, re-exporting will give you a clean, strictly-greater version.
   >
   > How would you like to proceed?"
   >
   > | Question | Header | Options |
   > |---|---|---|
   > | What to do? | Version skew | Re-export with a bumped version (Recommended — invokes /power-pages:export-solution), Import anyway (proceed at your own risk), Cancel |

   - **Re-export**: invoke `/power-pages:export-solution`. After it completes, restart this skill from Phase 2 with the freshly-produced zip.
   - **Import anyway**: set `SKEW_ACK = true` and proceed to the staged/direct prompt below. Record the acknowledged skew in `docs/alm/last-import.json` under `versionSkew: { zipVersion, installedVersion, isManaged, acknowledged: true }` for the audit trail.
   - **Cancel**: stop the skill cleanly. No target-env writes happened in Step 3.0 — it was read-only.

4. **If the comparison is the normal upgrade case** (or the zip's solution isn't installed yet), continue silently — do not present a prompt, just record the version delta in the eventual `docs/alm/last-import.json` for the summary.

<!-- gate: import-solution:3.config | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · import-solution:3.config):** Staged vs Direct import, overwrite options. Cancel exits before any target-env mutation.

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

<!-- gate: import-solution:5b.blocked-attachments | category=consent | cancel-leaves=attachment-block-modified -->
> 🚦 **Gate (consent · import-solution:5b.blocked-attachments):** Reactive `AttachmentBlocked` remediation — modify env-level `blockedattachments` setting (tenant-wide impact). Reversible from PPAC. **Fires fresh on every skill invocation that hits the failure.** When `plan-alm` Manual path orchestrates multi-target imports (Staging then Production), it invokes `import-solution` **once per target** — if both targets block the same extensions, the gate fires once per target (each is a separate skill invocation against a separate env). Consent for Staging does NOT cover Production.

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

3. Ensure `docs/alm/` exists, then write `docs/alm/last-import.json` marker (`node -e "require('fs').mkdirSync('docs/alm',{recursive:true})"`):
   ```json
   {
     "importedAt": "<ISO timestamp>",
     "solutionName": "<name>",
     "version": "<version>",
     "targetEnvironment": "<envUrl>",
     "asyncOperationId": "<id>",
     "importJobId": "<ImportJobKey value>",
     "status": "<Succeeded|Failed|Partial>",
     "componentResults": { "success": N, "warning": N, "failure": N },
     "versionSkew": null
   }
   ```

   The `status` field drives `refresh-alm-plan-data.js`'s step-sync (`completed` vs `failed`) for the rendered ALM plan's per-stage checklist. Set it to:
   - `Succeeded` when the import job's `statecode` is 3 (Succeeded) AND component-results show `failure === 0`.
   - `Partial` when `statecode` is 3 but `componentResults.failure > 0` (the solution landed but some components didn't import — usually managed-property conflicts or dependency gaps).
   - `Failed` when `statecode` is 4 (Failed) OR the import never reached terminal state OR all components failed. Without this field, every import shows `completed` in the rendered plan regardless of actual outcome.

   **If the user acknowledged a same-version or downgrade import in Step 3.0** (`SKEW_ACK = true`), set `versionSkew` to:
   ```json
   { "zipVersion": "<ZIP_SOLUTION_VERSION>", "installedVersion": "<INSTALLED.version>", "isManaged": <bool>, "acknowledged": true }
   ```
   Otherwise leave `versionSkew: null`.

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

<!-- gate: import-solution:6b.env-vars | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · import-solution:6b.env-vars):** Imported env var definitions need per-target values. User supplies values or skips (uses default). Without values, runtime reads default which may be dev-only.

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

> **Note on Secret type (type 100000005):** Secret values are stored encrypted. The POST behaves the same but the value will be masked in the UI. The user should provide the actual secret value for the target environment (e.g. the OAuth client secret for the production tenant's app registration — different from the dev value).

If the user skips all values: inform them the site may not function correctly until values are set, and provide the direct Power Platform URL to set them manually:
`https://{targetEnvHost}/main.aspx?appid=...&etn=environmentvariabledefinition`

**6b.verify — Confirm values landed.** After the per-variable POSTs complete, verify each `environmentvariablevalues` record actually exists on the target. The shared helper `scripts/lib/verify-env-var-values.js` does this read-only check and returns a structured JSON result per schema (`landed` / `missing-value-record` / `missing-definition` / `value-mismatch` / `query-error`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/verify-env-var-values.js" \
  --envUrl "{targetEnvUrl}" \
  --schemaNames "{comma-separated schema names that the user supplied values for}"
```

Capture stdout as JSON. If `summary.missing > 0` or `summary.error > 0`, surface a single warning to the user with the affected schema names — but do not block the import summary, the import itself succeeded. The same helper is used at deploy time (deploy-pipeline Phase 7.6.5) and at configure time (configure-env-variables Phase 7); centralizing the check keeps the user-visible message consistent across skills.

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

   <!-- gate: import-solution:6c.cloud-flow-register | category=plan | cancel-leaves=nothing -->
   > 🚦 **Gate (plan · import-solution:6c.cloud-flow-register):** Cloud flows in imported solution need manual registration in target env. Acknowledge / defer.

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

<!-- gate: import-solution:6d.activate | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · import-solution:6d.activate):** Site imported but not activated in target env. Offer to invoke activate-site now or defer.

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

### Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "ImportSolution"`.

### Refresh the ALM plan (if one exists)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/refresh-alm-plan-data.js" \
  --projectRoot "." \
  --phase import-solution \
  --stageName "{targetLabel}" \
  --render
```

`{targetLabel}` is the Manual-path target stage (e.g. `Staging`, `Production`) the just-completed import was for — the user states it, or it is derivable from the target env URL. The helper reads `docs/alm/last-import.json`, captures the import outcome (status, version, component count, component failures) into `planData.manualImports[targetLabel]`, and re-renders `docs/alm-plan.html` so the matching `Import to {targetLabel}` checklist step shows an `IMPORTED` / `FAILED` badge with version + component count inline. Subsequent imports to OTHER targets each get their own entry — the renderer surfaces a per-target history rather than overwriting on each call.

If `--stageName` is omitted the helper falls back to matching `docs/alm/last-import.json`'s `targetEnvironment` URL against `planData.stages[].envUrl`. When the match fails (rare — usually a stage-label/env-URL mismatch in planData), the import is captured under a synthetic key so it isn't silently lost; pass `--stageName` explicitly to keep the rendered plan clean. When `docs/.alm-plan-data.json` is absent, the helper returns `ok:false` as a soft no-op.

**Point the user at the next step (user-driven sequencing).** The helper's stdout JSON includes `nextStep: { name, skill: string | null } | null`. When non-null, branch on `skill`: when `skill` is non-null, tell the user *"Plan updated. Next in your plan: **{nextStep.name}** → run `{nextStep.skill}` when you're ready."*; when `skill` is `null` (an internal step such as Finalize, no user command), name the step only — *"Plan updated. Next in your plan: **{nextStep.name}**."* — and never print `run null`. (Typically: import to the next target, or activate the site in this target.) When `null` or the helper returned `ok:false`, say nothing about a next step. **Never auto-invoke the next skill** — the user drives execution.

## Key Decision Points (Wait for User)

1. **Phase 1**: Confirm target environment — import is not easily undoable for managed solutions
2. **Phase 2**: Select zip file if multiple found
3. **Phase 3 Step 3.0**: **Version-skew advisory** — only fires when the target already has the solution installed AND the zip's version is `≤` the installed version. Offers re-export with bumped version (Recommended), import-anyway (acknowledged in `last-import.json`), or cancel. Read-only check; cancelling here makes no target-env writes.
4. **Phase 3**: Staged vs direct import; overwrite customizations
5. **Phase 4**: Proceed despite missing dependencies
6. **Phase 5b**: Consent to unblock attachment types — never modify environment settings without explicit approval
7. **Phase 6b**: Env var values — always prompted if solution contains env var definitions with no existing value in the target; Secret type definitions require the user's target-environment-specific secret value
8. **Phase 6c**: Cloud flow registration — non-blocking; user may register later; status recorded in summary
9. **Phase 6d**: Site activation — only if Power Pages website components present and site not yet activated

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
| Configure import | Configuring import | Step 3.0: extract zip uniqueName+version from solution.xml, query target's installed version, surface a version-skew advisory if zip version ≤ installed (offer re-export / import-anyway / cancel); then ask: staged vs direct, overwrite customizations, publish workflows |
| Stage solution (dependency check) | Staging solution | Run StageSolution to check for missing dependencies before committing |
| Import solution | Importing solution | POST ImportSolutionAsync, poll until complete; if AttachmentBlocked: identify blocked types, get user consent, unblock via pac env update-settings, retry |
| Verify import | Verifying import | Confirm solution version in target, parse component results, write docs/alm/last-import.json |
| Detect cloud flows | Detecting cloud flows | List Workflows/*.json entries in zip; if found, prompt user to register flows with Power Pages site; record status (Registered / Pending registration) |
| Check site activation | Checking site activation | If solution has componentType 10374: run check-activation-status.js; if not activated, ask user and invoke /power-pages:activate-site |
| Present summary | Presenting summary | Show component counts (success/warning/failure), cloud flow registration status, site activation status, env var values set |
