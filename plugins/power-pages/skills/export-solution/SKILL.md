---
name: export-solution
description: >-
  Exports a Dataverse solution containing Power Pages site components as a zip file,
  ready for deployment to another environment. Use when asked to: "export solution",
  "download solution", "export managed", "export unmanaged", "package for deployment",
  "create solution zip", "export site package", or "build deployment artifact".
user-invocable: true
argument-hint: "Optional: 'managed' or 'unmanaged' (default: asks)"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_search, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_fetch
model: opus
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# export-solution

Triggers an async Dataverse solution export, polls until complete, downloads the solution zip, and verifies it. Reads `.solution-manifest.json` to identify the solution; falls back to asking the user.

## Prerequisites

- PAC CLI installed and authenticated
- Azure CLI installed and logged in
- Solution exists in the environment (run `setup-solution` first if needed)

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
node "${PLUGIN_ROOT}/scripts/lib/check-alm-plan.js" \
  --projectRoot "." \
  --envUrl "{envUrl from .solution-manifest.json or pac env who, if available}" \
  --token "{token, if Phase 1 already acquired one}" \
  --solutionId "{solutionId from .solution-manifest.json, if available}"
```

The helper returns JSON with `{ exists, deferred, stale, staleness: { reason, detail }, generatedAt, planStatus, ... }`. The freshness check requires env credentials + solutionId; without those the helper does an existence-only check.

**Step 2 — Branch on the result.**

| Result | Behavior |
|---|---|
| `deferred: true` | The user has explicitly deferred ALM for this project (`.alm-deferred` marker present). Pass through silently to Phase 1 — do not nag. |
| `exists: false` | The user hasn't run `plan-alm` yet. See Step 3. |
| `exists: true, stale: false` | Plan is current. Pass through silently to Phase 1. |
| `exists: true, stale: true` (reason: `solution-modified`) | The solution changed after the plan was generated. See Step 4. |

**Step 3 — No plan.** Tell the user:

> "No ALM plan exists for this project. `/power-pages:plan-alm` builds one — it detects the project state, asks about your promotion strategy (PP Pipelines vs Manual export/import), and orchestrates the right skills (including this one) in the right order. Want me to run plan-alm now?"

<!-- gate: export-solution:0.no-plan | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · export-solution:0.no-plan):** Fail-closed entry gate when `check-alm-plan.js` returns `exists:false`. Helper-script-backed.

`AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Run `/power-pages:plan-alm` first? | ALM plan gate | Yes — run /power-pages:plan-alm now (Recommended), Continue without a plan (advanced — I know what I'm doing), Cancel |

- **Yes (Recommended)** → invoke `/power-pages:plan-alm`. It builds the plan and returns — `plan-alm` is a planner and does not deploy. This skill then re-runs the Phase 0 check (now `exists:true`) and proceeds to Phase 1.
- **Continue without a plan** → set `BYPASSED_PLAN_GATE = true` and proceed to Phase 1.
- **Cancel** → exit cleanly.

**Step 4 — Stale plan.** Tell the user:

> "ALM plan exists from `{generatedAt}` but the source solution has been modified since (at `{solution.modifiedon}`). Components may have changed. Re-running `plan-alm` will refresh the analysis and the rendered HTML."

<!-- gate: export-solution:0.stale-plan | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · export-solution:0.stale-plan):** Fail-closed entry gate when `check-alm-plan.js` returns `stale:true`. Helper-script-backed.

`AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Refresh the plan first? | ALM plan freshness | Refresh — re-run /power-pages:plan-alm (Recommended), Continue with the existing plan, Cancel |

- **Refresh (Recommended)** → invoke `/power-pages:plan-alm`. After completion, re-run the Phase 0 helper once to confirm freshness; if still stale, surface the detail and proceed to Phase 1 anyway (don't infinite-loop).
- **Continue** → set `STALE_PLAN_ACK = true` and proceed to Phase 1.
- **Cancel** → exit cleanly.

**Why this gate exists.** Direct invocation of `export-solution` produces a zip without the orchestrator's pre-export completeness check. Users running this skill standalone often miss components that should have been added to the solution (cloud flows, env var values referenced by site settings, sample data references) and ship a zip that imports cleanly into staging but produces a broken site post-deploy. The pre-plan completeness check surfaces those gaps before any zip is built. The gate ensures `plan-alm` either ran (so completeness was verified and the export was scoped to the right solution lineage) or the user explicitly chose to bypass it.

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
   node "${PLUGIN_ROOT}/scripts/lib/verify-alm-prerequisites.js" --require-manifest
   ```
   Capture output as JSON; extract `.envUrl` (store as `envUrl`) and `.token` (store as `token`). If the script exits non-zero, stop and explain what is missing (reference `${PLUGIN_ROOT}/references/dataverse-prerequisites.md`).

### Phase 1.5 — Ground in current ALM documentation

> Reference: `${PLUGIN_ROOT}/references/alm-docs-grounding.md`

Cap this step at ~30 seconds. If MCP search / fetch errors out, log a one-line note and continue — this skill must remain runnable offline.

1. Run `microsoft_docs_search` with the query: `Power Pages solution export managed unmanaged ExportSolutionAsync ALM`.
2. Fetch `https://learn.microsoft.com/en-us/power-platform/alm/solution-concepts-alm` (and at most one sister page on managed vs unmanaged or solution layering) in parallel via `microsoft_docs_fetch`.
3. Extract a one-paragraph summary of what Microsoft Learn currently says about export semantics, managed vs unmanaged implications, and async export polling. Compare against `${PLUGIN_ROOT}/references/solution-api-patterns.md` and flag any divergence in `ExportSolutionAsync` / `DownloadSolutionExportData` signatures.
4. Use the summary to inform Phase 2+ decisions. Do not silently change skill behavior — surface any divergence to the user as a soft warning before Phase 3.

### Phase 2 — Identify Solution

<!-- gate: export-solution:2.identify | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · export-solution:2.identify):** No `.solution-manifest.json` in project root — user must pick or paste a solution unique name before export proceeds. Fires only on the "not found" branch (step 3 below).
>
> **Trigger:** Phase 2 step 1 didn't find a manifest.
> **Why we ask:** Auto-picking the wrong solution exports a managed zip that ships the wrong table/site/flow set to staging.
> **Cancel leaves:** Nothing — no ExportSolutionAsync call yet.

1. Look for `.solution-manifest.json` in project root (use `findProjectRoot` or `glob('**/.solution-manifest.json')`)
2. If found: read `solution.uniqueName`, `solution.solutionId`, `environmentUrl`
   - Verify environment URLs match (warn if different — may be cross-environment export)
3. If not found, use `AskUserQuestion` to pick the solution:
   - Query Dataverse for available unmanaged solutions and present them as options
   - Free-text fallback ("Other") for pasting the unique name directly
4. Confirm solution exists in environment:
   ```
   GET {envUrl}/api/data/v9.2/solutions?$filter=uniquename eq '{solutionName}'&$select=solutionid,uniquename,friendlyname,version,ismanaged
   ```
5. Present solution details and confirm with user.

### Phase 2.5 — Pre-export Completeness Check

Before exporting, run the shared site-inventory helper to detect any components that exist on the site but are not in the solution. Catching this here avoids shipping an incomplete package to staging/prod.

```bash
node "${PLUGIN_ROOT}/scripts/lib/discover-site-components.js" \
  --envUrl "{envUrl}" --token "{token}" \
  --siteId "{websiteRecordId}" \
  --publisherPrefix "{publisherPrefix from .solution-manifest.json}" \
  --solutionId "{solutionId}" \
  --projectRoot "."
```

Parse stdout and evaluate `missing`. **Before doing anything else**, capture the **pre-sync state** so a post-sync re-confirmation gate can show what changed:

```
PRE_SYNC_VERSION = solutionManifest.solution.version   // from .solution-manifest.json read in Phase 2
PRE_SYNC_MISSING = { siteComponents, siteLanguages, cloudFlows, envVarDefinitions, customTables, ... }   // from the discovery stdout above
```

Then:

- **All `missing.*` arrays empty** → report "Solution contents match the site — no gaps detected." Proceed to Phase 3.
- **Any non-empty `missing.*` array** → present a concise summary:
  > "The solution is **missing {N}** component(s) that exist on the site:
  >
  > - **{X}** site components (e.g. {first 3 names}, …)
  > - **{Y}** cloud flows
  > - **{Z}** environment variable definitions with your publisher prefix
  > - **{W}** custom tables"

  <!-- gate: export-solution:2.5.completeness | category=progress | cancel-leaves=nothing -->
  > 🚦 **Gate (progress · export-solution:2.5.completeness):** Source solution incomplete vs live site. Sync first, export as-is (gap recorded), or abort.

  Then ask via `AskUserQuestion`:
  > "How would you like to proceed?
  > 1. **Run `/power-pages:setup-solution` in sync mode now** — adopts missing components, bumps the solution version, then re-confirms with you before exporting (Recommended)
  > 2. **Export as-is** — ship what's currently in the solution; missing components won't travel
  > 3. **Abort** — I want to investigate before exporting"

  - **Option 1 — Sync first, then re-confirm before export:**
    1. Invoke `/power-pages:setup-solution` (auto-detects the existing manifest, enters sync mode, adopts missing components, bumps the version). Wait for completion. setup-solution's final refresh step writes `LAST_SYNC_AT` into `docs/.alm-plan-data.json` so subsequent `check-alm-plan.js` calls do NOT falsely flag the plan as stale just because the sync bumped `solutions.modifiedon` past `GENERATED_AT` — the freshness reference becomes `max(GENERATED_AT, LAST_SYNC_AT)`.
    2. Re-read `.solution-manifest.json` and capture `POST_SYNC_VERSION = solutionManifest.solution.version`.
    3. Re-run the discovery helper. If any `missing.*` remain non-empty, repeat the Phase 2.5 prompt above.
    4. Otherwise compute `NEWLY_ADOPTED` as a per-category set difference between `PRE_SYNC_MISSING` and the second discovery run's `missing.*` (the items that disappeared are what setup-solution just adopted into the solution). Total count = sum of all category lengths.
    <!-- gate: export-solution:2.5.post-sync | category=progress | cancel-leaves=nothing -->
    > 🚦 **Gate (progress · export-solution:2.5.post-sync):** Post-sync re-confirm. Solution version bumped + components adopted — user inspects delta before export proceeds.

    5. **Re-confirm with the user before proceeding to Phase 3** — the solution about to be exported is now different from what the user originally saw when they started the export. Use `AskUserQuestion`:

       > "Sync complete.
       >
       > **{solutionUniqueName}** is now **v{POST_SYNC_VERSION}** (was v{PRE_SYNC_VERSION}) with **{NEWLY_ADOPTED.total} newly-adopted components**:
       > - {first 3-5 names by category — prefer high-signal categories: cloud flows, server logic, env var definitions, then site components}
       > - {if more remain: `+ {N} more across {category list}`}
       >
       > About to export this updated solution to a zip file.
       >
       > Continue with the export?"

       | Question | Header | Options |
       |---|---|---|
       | Continue with the export? | Post-sync approval | Yes — export v{POST_SYNC_VERSION} (Recommended), Pause — I want to review the new solution contents first, Cancel — abort the export |

       - **Yes** → proceed to Phase 3 with the post-sync solution.
       - **Pause** → exit export-solution cleanly with a short note ("Paused after sync. Re-run `/power-pages:export-solution` when you're ready to export v{POST_SYNC_VERSION}.") so the user can inspect the synced manifest / Dataverse state and resume manually. **Do not** write any export artifacts — no export happened. Skip the skill-tracking call too.
       - **Cancel** → stop the skill. Same no-artifact / no-tracking rule applies.
  - **Option 2** — record the gap in the export manifest (see Phase 7 summary) so the user has an audit trail of what was intentionally left out.
  - **Option 3** — stop the skill.

> **Why the post-sync gate exists**: when sync mode runs mid-export, it produces a different solution version than the one the user had in mind when they invoked the skill. Re-confirming after sync gives the user an explicit chance to inspect the version bump and the list of newly-adopted components before the zip is produced and (typically) shipped onward via `import-solution`. The Phase 2.5 trigger is intentional; the post-sync re-confirmation is the safety on top of it. This mirrors the same gate in `deploy-pipeline` Phase 3.5 — same shape, same options, same audit-trail rules — so users see consistent behavior whether they take the PP Pipelines path or the Manual export/import path.

> **Why Phase 2.5 exists in the first place**: historically, components created after `setup-solution` (server logic from `add-server-logic`, flows from `add-cloud-flow`, env vars from `configure-env-variables` / `setup-auth`) were silently left out of the export zip and didn't travel to target environments. The ALM-aware-by-default principle in `AGENTS.md` requires this check at every gate where a solution leaves its source environment.

### Phase 3 — Configure Export

<!-- gate: export-solution:3.export-type | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · export-solution:3.export-type):** Managed vs Unmanaged — irreversible for the produced zip. Managed cannot be edited in target; Unmanaged can. Mismatch with stage strategy ships the wrong artifact downstream.

Invoke `AskUserQuestion` immediately — do NOT describe this choice as chat text. The user must answer live before export proceeds.

| Question | Header | Options |
|---|---|---|
| How would you like to export this solution? **Managed** solutions cannot be edited in the target environment and support clean upgrade/delete cycles — recommended for staging and production. **Unmanaged** solutions can be edited in the target environment — use for dev-to-dev deployments. | Export Type | Managed — for staging/production (Recommended), Unmanaged — for development environments |

Use the answer to set `"Managed": true` or `"Managed": false` in the `ExportSolutionAsync` request body.

<!-- gate: export-solution:3.overwrite | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · export-solution:3.overwrite):** Output directory and overwrite-vs-new-name decision for the produced zip. If an existing zip is detected at the target path, the prompt offers Overwrite / pick new name / cancel.
>
> **Trigger:** Phase 3 after Managed/Unmanaged is picked.
> **Why we ask:** Auto-overwriting replaces a previous export that may have been hand-tested already.
> **Cancel leaves:** Nothing — no zip written.

Also ask via `AskUserQuestion`:
- Output directory (default: current project root)
- If a zip already exists at the resolved output path: *"Overwrite / Pick new name / Cancel"*

### Phase 4 — Trigger Async Export

**Step 4.0 — Bump source solution version (always-on).**

Before exporting, bump the patch segment (4th segment) of the source solution's version. Without this, two consecutive exports without intervening `setup-solution` sync produce zips that carry the **same** version string — and importing the second zip into a target that already has the first installed is unreliable for managed solutions (no clean upgrade path) and depends on `OverwriteUnmanagedCustomizations: true` for unmanaged.

> **Why always-on, not "only when sync mode added components"**: `setup-solution` only bumps when it has new components to add. A user who modifies content of an already-in-solution component (a web template, a site setting value, a web file) and then re-exports must still get a strictly-increasing version label — otherwise the manual export/import path quietly ships stale-version zips. See the `Why this step exists` callout in `setup-solution` Phase 4.

```bash
node "${PLUGIN_ROOT}/scripts/lib/bump-solution-version.js" \
  --envUrl "{envUrl}" \
  --token "{token}" \
  --uniqueName "{solutionUniqueName}" \
  --projectRoot "."
```

Capture output as JSON; store `.previous` as `PRE_EXPORT_VERSION`, `.next` as `EXPORT_VERSION`, and inspect `.manifestUpdated` / `.manifestUpdateReason` to confirm the manifest sync succeeded. Report: "Bumped solution `{solutionUniqueName}` from v{PRE_EXPORT_VERSION} to v{EXPORT_VERSION} for export."

`--projectRoot "."` makes the helper update `.solution-manifest.json`'s `solution.version` (single-solution) or matching `solutions[].version` (multi-solution) field atomically as part of the bump operation — no separate `Edit` step needed. If the manifest doesn't exist or has no matching entry, `manifestUpdated: false` and `manifestUpdateReason` tells you why (`no-manifest`, `no-matching-entry`, etc.); the bump itself still succeeded.

> **If the bump already happened earlier in this session** (e.g. `setup-solution` sync mode ran with adopted components in Phase 2.5 and bumped the version, then handed back here): the helper still runs and bumps again. This is intentional — sync's bump is paired with new components; export's bump is paired with the produced zip. They're independent concerns and double-bumping is cheap (just an extra patch segment). The skill-skipping logic for "the manifest version already matches the live source version" is intentionally NOT added here; it would create a class of "I edited content but no sync was needed and no bump happened, so the export shipped a stale version" failures.

**Step 4.1 — Trigger async export.**

Run `scripts/lib/export-solution-async.js` to POST `ExportSolutionAsync`, poll until terminal state, and return the `AsyncOperationId`:

```bash
node "${PLUGIN_ROOT}/scripts/lib/export-solution-async.js" \
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
node "${PLUGIN_ROOT}/scripts/lib/download-export-data.js" \
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

**Step 7.1 — Write `docs/alm/last-export.json` marker.**

Ensure `docs/alm/` exists, then write the marker so downstream skills (`import-solution` skew advisory, `refresh-alm-plan-data.js` rendering the Manual-path tab, future "modified-since-last-export" gates, audit trail) can reason about what was last shipped from this source.

```bash
node -e "require('fs').mkdirSync('docs/alm',{recursive:true})"
```

Then write `docs/alm/last-export.json`:

```json
{
  "exportedAt": "<ISO timestamp>",
  "solutionUniqueName": "<solutionUniqueName>",
  "solutionId": "<solutionId from .solution-manifest.json or Phase 2 query>",
  "previousVersion": "<PRE_EXPORT_VERSION from Step 4.0>",
  "version": "<EXPORT_VERSION from Step 4.0>",
  "managed": <true|false>,
  "sourceEnvironmentUrl": "<envUrl>",
  "zipPath": "<zipPath>",
  "fileSizeBytes": <fileSizeBytes>,
  "asyncOperationId": "<asyncOperationId>"
}
```

The path is registered in `scripts/lib/alm-paths.js` under the key `lastExport` — programmatic consumers should resolve via `almPath(projectRoot, 'lastExport')` rather than re-inlining the path string. (Skill prose inlines the path verbatim for readability, matching the convention used for `last-deploy.json`, `last-import.json`, and the other ALM markers.)

**Step 7.2 — Display the summary.**

| Item | Value |
|---|---|
| Solution | `{solutionUniqueName}` v`{EXPORT_VERSION}` (was v`{PRE_EXPORT_VERSION}`) |
| Export type | Managed / Unmanaged |
| File | `{zipPath}` |
| File size | `{size} KB` |
| Export job | `{AsyncJobId}` |
| Marker written | `docs/alm/last-export.json` |

**Suggested next steps**:
- Run `/power-pages:import-solution` to deploy this zip to another environment
- Run `/power-pages:setup-pipeline` to automate this process in CI/CD

### Record Skill Usage

> Reference: `${PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "ExportSolution"`.

### Refresh the ALM plan (if one exists)

```bash
node "${PLUGIN_ROOT}/scripts/lib/refresh-alm-plan-data.js" \
  --projectRoot "." \
  --phase export-solution \
  --render
```

Re-renders `docs/alm-plan.html` so any step-status updates the agent made during this skill (`Export solution` → `status-completed`) flow through. When `docs/.alm-plan-data.json` is absent (standalone invocation, not part of an ALM plan), the helper returns `ok:false` as a soft no-op — safe to run unconditionally.

**Point the user at the next step (user-driven sequencing).** The helper's stdout JSON includes `nextStep: { name, skill: string | null } | null`. When non-null, branch on `skill`: when `skill` is non-null, tell the user *"Plan updated. Next in your plan: **{nextStep.name}** → run `{nextStep.skill}` when you're ready."*; when `skill` is `null` (an internal step such as Finalize, no user command), name the step only — *"Plan updated. Next in your plan: **{nextStep.name}**."* — and never print `run null`. (Typically: review the exported zip, then run `/power-pages:import-solution` for the first target.) When `null` or the helper returned `ok:false`, say nothing about a next step. **Never auto-invoke the next skill** — the user drives execution.

## Key Decision Points (Wait for User)

1. **Phase 2**: Solution identification — confirm before triggering export
2. **Phase 2.5**: Completeness-gap prompt (sync-first / export-as-is / abort) when the live site has components missing from the solution
3. **Phase 2.5**: **Post-sync approval gate** — only fires after a mid-export sync (Option 1). Shows the new solution version + newly-adopted components and asks the user to confirm the post-sync solution before exporting the zip. Pause exits cleanly; Cancel aborts.
4. **Phase 3**: Managed vs unmanaged — affects downstream importability (irreversible choice for this export)
5. **Phase 4 Step 4.0**: No user prompt — version bump runs automatically before `ExportSolutionAsync`. The bumped version (`PRE_EXPORT_VERSION → EXPORT_VERSION`) is surfaced in the Phase 7 summary so the user can see what version landed in the zip.

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
| Trigger async export | Triggering async export | Bump source solution version (Step 4.0) via bump-solution-version.js so the zip carries a strictly-increasing version label; POST ExportSolutionAsync, capture AsyncJobId, poll until complete |
| Download solution zip | Downloading solution zip | POST DownloadSolutionExportData, decode base64, write zip to disk |
| Verify export | Verifying export | Confirm zip exists, size > 0, Solution.xml present inside |
| Present summary | Presenting summary | Write docs/alm/last-export.json marker (via alm-paths.js); show zip path, size, type, version bump, and suggested next steps |
