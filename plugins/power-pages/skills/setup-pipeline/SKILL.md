---
name: setup-pipeline
description: >-
  Sets up a Power Platform Pipeline for automated Power Pages deployments.
  Power Platform Pipelines is Microsoft's native CI/CD tool built into the
  Power Platform — no external infrastructure required.
  Use when asked to: "set up ci/cd", "create pipeline", "setup pipeline",
  "set up power platform pipelines", "create power pipelines",
  "automate deployments", "set up automated deployment",
  "create deployment pipeline", "use power pipelines".
  Also handles: "set up github actions" or "set up azure devops pipeline"
  (shows coming-soon guidance for those platforms).
user-invocable: true
argument-hint: "Optional: 'power-platform', 'github', or 'ado' to skip platform selection"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_search, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_fetch
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# setup-pipeline

Sets up a **Power Platform Pipeline** for automated Power Pages solution deployments. Creates the pipeline configuration directly in Dataverse using the PP Pipelines OData API — no YAML files, no external CI/CD infrastructure needed.

GitHub Actions and Azure DevOps Pipeline options are shown in the platform menu as **coming soon**.

> Refer to `${CLAUDE_PLUGIN_ROOT}/references/cicd-pipeline-patterns.md` for all HAR-confirmed API patterns used in this skill.

## Prerequisites

- `powerpages.config.json` exists in the project root
- `.solution-manifest.json` exists (solution must be created first via `setup-solution`)
- Azure CLI logged in (`az account show` succeeds)
- PAC CLI logged in (`pac env who` succeeds)
- A Power Platform environment with Pipelines package installed (the "host" environment)

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
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/check-alm-plan.js" \
  --projectRoot "." \
  --envUrl "{devEnvUrl}" \
  --token "{token}" \
  --solutionId "{solutionId from .solution-manifest.json, if available}"
```

The helper returns JSON with `{ exists, stale, staleness: { reason, detail }, generatedAt, planStatus, ... }`. The freshness check requires env credentials + solutionId; without those the helper does an existence-only check.

**Step 2 — Branch on the result.**

| Result | Behavior |
|---|---|
| `deferred: true` | The user has explicitly deferred ALM for this project (`.alm-deferred` marker present). Pass through silently to Phase 1 — do not nag. |
| `exists: false` | The user hasn't run `plan-alm` yet. See Step 3. |
| `exists: true, stale: false` | Plan is current. Pass through silently to Phase 1. |
| `exists: true, stale: true` (reason: `solution-modified`) | The solution changed after the plan was generated. See Step 4. |

**Step 3 — No plan.** Tell the user:

> "No ALM plan exists for this project. `/power-pages:plan-alm` builds one — it detects the project state, asks about your promotion strategy (PP Pipelines vs Manual export/import), and orchestrates the right skills (including this one) in the right order. Want me to run plan-alm now?"

<!-- gate: setup-pipeline:0.no-plan | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · setup-pipeline:0.no-plan):** Fail-closed entry gate when `check-alm-plan.js` returns `exists:false`. Helper-script-backed.

`AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Run `/power-pages:plan-alm` first? | ALM plan gate | Yes — run /power-pages:plan-alm now (Recommended), Continue without a plan (advanced — I know what I'm doing), Cancel |

- **Yes (Recommended)** → invoke `/power-pages:plan-alm`. It builds the plan and returns — `plan-alm` is a planner and does not deploy. This skill then re-runs the Phase 0 check (now `exists:true`) and proceeds to Phase 1.
- **Continue without a plan** → set `BYPASSED_PLAN_GATE = true` and proceed to Phase 1.
- **Cancel** → exit cleanly.

**Step 4 — Stale plan.** Tell the user:

> "ALM plan exists from `{generatedAt}` but the source solution has been modified since (at `{solution.modifiedon}`). Components may have changed. Re-running `plan-alm` will refresh the analysis and the rendered HTML."

<!-- gate: setup-pipeline:0.stale-plan | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · setup-pipeline:0.stale-plan):** Fail-closed entry gate when `check-alm-plan.js` returns `stale:true`. Helper-script-backed.

`AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Refresh the plan first? | ALM plan freshness | Refresh — re-run /power-pages:plan-alm (Recommended), Continue with the existing plan, Cancel |

- **Refresh (Recommended)** → invoke `/power-pages:plan-alm`. After completion, re-run the Phase 0 helper once to confirm freshness; if still stale, surface the detail and proceed to Phase 1 anyway (don't infinite-loop).
- **Continue** → set `STALE_PLAN_ACK = true` and proceed to Phase 1.
- **Cancel** → exit cleanly.

**Why this gate exists.** Direct invocation of this skill bypasses the orchestrator's pre-deploy completeness check, host-resolution decision, deployment-strategy selection, and rendered HTML plan. Users who run `setup-pipeline` directly often miss components that should have been added to the solution, miss the asset advisory for large web files, or build a pipeline against the wrong host environment. The gate ensures `plan-alm` either ran (so all of those decisions are surfaced and recorded) or the user explicitly chose to bypass it.

### Phase 1 — Detect Project Context

**Create all tasks upfront at the start of this phase.**

Tasks to create:
1. "Detect project context"
2. "Select CI/CD platform"
3. "Confirm pipeline configuration"
4. "Run preflight checks"
5. "Create deployment environments"
6. "Create pipeline and stages"
7. "Verify and write artifacts"

Steps:

1. Read project context using `detect-project-context.js`:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/detect-project-context.js"
   ```
   Capture output as JSON; extract `.siteName` (store as `siteName`), `.websiteRecordId`, `.environmentUrl` (store as `devEnvUrl`), and `.solutionManifest` (store as `solutionManifest`). If `siteName` is absent (no `powerpages.config.json`), stop and advise running `/power-pages:create-site` first. If `solutionManifest` is null (no `.solution-manifest.json`), stop and advise running `/power-pages:setup-solution` first.

   **Manifest version check:**
   - If `solutionManifest.schemaVersion === 2` (multi-solution layout), set `MULTI_SOLUTION_MODE = true` and store `solutionManifest.solutions[]` as `SOLUTIONS_LIST`. See Phase 6b — a SINGLE pipeline ships all solutions through per-solution stage runs (the pre-v1.3.x "one pipeline per solution" layout was reverted because it cluttered the Pipelines UI).
   - If `schemaVersion` is absent or `1` (single solution), read `solutionManifest.solution.uniqueName` and `solutionManifest.solution.solutionId`. One pipeline will be created (existing flow).

2. Run `verify-alm-prerequisites.js` to confirm PAC CLI auth, acquire a token, and verify API access:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/verify-alm-prerequisites.js" --envUrl "{devEnvUrl}"
   ```
   Capture output as JSON; extract `.envUrl` (use to confirm `devEnvUrl`) and `.token` (store as `DEV_TOKEN`).

3. Run silently:
   ```bash
   pac env list --output json 2>/dev/null
   ```
   Store output as `ENV_LIST`.

4. **Resolve the Pipelines host via `ensure-pipelines-host-detect.js`** (the same flow `/power-pages:ensure-pipelines-host` runs internally — it reads any cached `docs/alm/last-host-check.json`, then walks the resolution order: org-setting binding → BAP env GET → tenant default custom host → tenant-wide enumeration. Read-only; never prompts the user):

   ```bash
   BAP_TOKEN=$(az account get-access-token --resource "https://service.powerapps.com/" --query accessToken -o tsv)
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ensure-pipelines-host-detect.js" \
     --envUrl "{devEnvUrl}" \
     --token "{DEV_TOKEN}" \
     --userId "{userId}" \
     --bapToken "{BAP_TOKEN}" \
     --projectRoot "."
   ```

   Capture stdout as JSON: `const hostResult = JSON.parse(output)`. Read `hostResult.resolutionStatus`, `hostResult.finalHostEnvUrl`, `hostResult.ready`.

   Branch on `resolutionStatus`:

   - **`AvailableUsingPlatformHost` / `AvailableUsingCustomHost` / `AvailableUsingCustomHostByAdminDefault`** — host is already established and `ready: true`. Store `HOST_ENV_URL = hostResult.finalHostEnvUrl` and continue. Phase 3 confirms with the user.
   - **`AvailableUnboundCustomHost` / `MultipleUnboundCustomHosts` / `PlatformHostExistsUnbound` / `NoHost`** — no host bound to the dev env. **Delegate to `/power-pages:ensure-pipelines-host`** so the user can reuse an existing host or provision a new Custom Host (`D365_ProjectHost` template). Tell the user: *"No Pipelines host bound to `{devEnvUrl}`. Invoking `/power-pages:ensure-pipelines-host` to set one up — it will run a tenant-wide search for existing hosts and offer to provision a new Custom Host if none are found."* After the sub-skill completes, re-read `docs/alm/last-host-check.json`; capture `HOST_ENV_URL = finalHostEnvUrl` only if the new marker has `ready: true`. If the user cancelled the sub-skill, stop this skill — no pipeline can be created without a host.
   - **`CannotRedirect`** — stop with the specific tenant-misconfiguration error from `hostResult.warnings[0]`. Tell the user: *"This tenant's `DefaultCustomPipelinesHostEnvForTenant` setting and the source env's `ProjectHostEnvironmentId` org setting disagree — only a Power Platform admin can resolve."*
   - **`OrgSettingStale`** — stop and surface the warning: *"`ProjectHostEnvironmentId` on `{devEnvUrl}` points at a host env that is no longer visible (deleted, disabled, or you lack access). Clear the org setting via PPAC or contact the env owner."*
   - **`PermissionDenied`** — stop and surface the warning: *"Caller lacks BAP read access on the env `{devEnvUrl}` is bound to. Contact the host env owner for at least `Deployment Pipeline User` access."*

   > **Why this replaces the old `discover-pipelines-host.js` call:** that helper only checked the tenant-level `DefaultCustomPipelinesHostEnvForTenant` setting (one of four resolution signals). `ensure-pipelines-host-detect.js` walks the full resolution order the Power Apps UI uses (mirrors `ProjectHostProvider.tsx`), so we agree with the UI in every case — including the previously-undetected `AvailableUnboundCustomHost` case where a Custom Host exists in the tenant but the source env hasn't been bound yet. See `references/cicd-pipeline-patterns.md` for the full state matrix.

5. Check for existing `docs/alm/last-pipeline.json`. If found, read its contents.

6. Report findings: "Project: `{siteName}`. Solution: `{uniqueName}`. Dev env: `{devEnvUrl}`. Host env: `{HOST_ENV_URL ?? 'pending — will be ensured next'}` ({hostResult.resolutionStatus}). Existing pipeline: found/not found."

<!-- gate: setup-pipeline:1.existing-pipeline | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · setup-pipeline:1.existing-pipeline):** Existing `docs/alm/last-pipeline.json` found — overwrite, review first, or cancel. No Dataverse write yet.

**If an existing `docs/alm/last-pipeline.json` is found**, ask via `AskUserQuestion`:

> "A pipeline configuration already exists for `{pipelineName}` (created {createdAt}). How would you like to proceed?
> 1. Overwrite — create a new pipeline, replacing the marker
> 2. Review existing setup first, then decide
> 3. Cancel"

- If **Review**: display the existing `docs/alm/last-pipeline.json` contents, then ask again with the same 3 options.
- If **Cancel**: stop the skill and inform the user no changes were made.
- If **Overwrite**: proceed.

### Phase 1.5 — Ground in current Pipelines documentation

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/alm-docs-grounding.md`

Cap this step at ~30 seconds. If MCP search / fetch errors out, log a one-line note and continue — this skill must remain runnable offline.

1. Run `microsoft_docs_search` with the query: `Power Platform Pipelines setup OData API host environment deploymentenvironments`.
2. Fetch `https://learn.microsoft.com/en-us/power-platform/alm/pipelines` (and at most one sister page on host setup or pipeline creation) in parallel via `microsoft_docs_fetch`.
3. Extract a one-paragraph summary of what Microsoft Learn currently says about Pipelines host resolution, `deploymentenvironments` / `deploymentpipelines` / `deploymentstages` schema, and pipeline lifecycle. Compare against `${CLAUDE_PLUGIN_ROOT}/references/cicd-pipeline-patterns.md` and flag any divergence (new fields, deprecated APIs, changed validation status codes).
4. Use the summary to inform Phase 2+ decisions. Do not silently change skill behavior — surface any divergence to the user as a soft warning before Phase 5 (Register Environments with the Pipelines Host).

### Phase 2 — Select CI/CD Platform

<!-- gate: setup-pipeline:2.platform | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · setup-pipeline:2.platform):** Pick CI/CD platform — PP Pipelines (full) vs GitHub Actions / ADO (coming soon stubs).

Ask user via `AskUserQuestion`:

> "Which CI/CD platform do you want to use?
> 1. **Power Platform Pipelines** — Microsoft's native deployment pipeline. No external infrastructure needed. (Recommended)
> 2. **GitHub Actions** — Coming soon
> 3. **Azure DevOps Pipeline** — Coming soon"

If the user passed `power-platform`, `github`, or `ado` as an argument, skip this question and use the provided value.

Store the selection as `PLATFORM`.

**If `github` or `ado` selected** → display the [Coming Soon path](#coming-soon-path) and stop.

---

## Power Platform Pipelines Path

### Phase 3 — Confirm Pipeline Configuration

Before asking any questions, assemble what was auto-detected:

| Setting | Auto-detected value |
|---|---|
| Site name | `{siteName}` from `powerpages.config.json` |
| Solution unique name | `{uniqueName}` from `.solution-manifest.json` |
| Dev environment URL | `{devEnvUrl}` from `pac env who` |
| Host environment URL | `{HOST_ENV_URL}` from `ensure-pipelines-host-detect.js` (resolved in Phase 1 step 4) |
| BAP environment ID (dev) | From `pac env list` |

<!-- gate: setup-pipeline:3.config | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · setup-pipeline:3.config):** Confirm auto-detected pipeline configuration — pipeline name, host env, target envs. Cancel exits before any Dataverse write to the host.

Ask user via `AskUserQuestion` with pre-filled values:

> "I've gathered the following pipeline configuration. Please confirm or correct:
>
> - **Pipeline name**: `{siteName} Pipeline` (can change)
> - **Source (Dev) environment**: `{devEnvUrl}`
> - **Host environment** (where Pipelines is installed): `{HOST_ENV_URL}` *(resolved in Phase 1 — should always be present at this point; `ensure-pipelines-host` would have stopped the skill otherwise)*
> - **Solution to deploy**: `{uniqueName}`
> - **Target environments**: How many? (Dev → Staging / Dev → Staging → Production)"

Collect from user:
- `PIPELINE_NAME` (default: `{siteName} Pipeline`)
- `HOST_ENV_URL` (confirm — already resolved in Phase 1; user can override only if they want to point at a different host they administer, in which case re-run `/power-pages:ensure-pipelines-host` first to validate it)
- Target environment count and URLs (`STAGING_ENV_URL`, `PROD_ENV_URL` if applicable)
- BAP environment IDs for each target (from `pac env list` — pre-fill if found, otherwise ask)

Store `HOST_TOKEN` by running:
```bash
az account get-access-token --resource "{hostEnvOrigin}" --query accessToken -o tsv
```

Present a final confirmation summary and ask user to approve before proceeding.

### Phase 4 — Preflight Checks

Use Node.js `https` module for all Dataverse calls (curl has encoding issues on Windows).

**4.1 Verify host environment has Pipelines installed:**
```
GET {hostEnvUrl}/api/data/v9.1/deploymentpipelines?$top=0
Authorization: Bearer {HOST_TOKEN}
```
If response is 404 or returns an "unknown entity" error, stop and inform the user: "The selected host environment does not have Power Platform Pipelines installed. Please select a different environment or install the Pipelines package."

**4.2 Verify solution exists in dev environment** using `verify-solution-exists.js`:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/verify-solution-exists.js" \
  --envUrl "{devEnvUrl}" \
  --uniqueName "{uniqueName}" \
  --token "{DEV_TOKEN}"
```
Capture output as JSON; check `.found`. If `false`: warn the user — the solution must be exported from dev before it can be deployed.

**4.3 Check for existing pipeline with same name:**
```
GET {hostEnvUrl}/api/data/v9.1/deploymentpipelines?$filter=name eq '{PIPELINE_NAME}'&$select=deploymentpipelineid&$top=1
Authorization: Bearer {HOST_TOKEN}
```

<!-- gate: setup-pipeline:4.3.name-conflict | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · setup-pipeline:4.3.name-conflict):** A pipeline with the same name already exists in the host env. Pick: reuse the existing pipeline ID, or create a new one with a different name. Auto-reusing risks attaching to a pipeline owned by someone else; auto-overwriting loses their stage history.
>
> **Trigger:** Phase 4.3 query returned a hit.
> **Why we ask:** Either a foreign pipeline gets its stages overwritten, or a duplicate pipeline gets created that pollutes the host env's pipeline list.
> **Cancel leaves:** Nothing — no Dataverse write yet.

If found: ask via `AskUserQuestion` whether to use the existing pipeline ID or create a new one with a different name.

**4.4 Check `blockedattachments` on source + all target envs:**

Power Pages code sites include `.js` files in their compiled output. If `.js` is in the env's `blockedattachments` setting, `pac pages upload-code-site` (on the source) and `deploy-pipeline` (on targets) will both fail with `AttachmentBlocked`. Run this on the **source env** and on **every target env**:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/fix-blocked-attachments.js" \
  --envUrl "{envUrl}" \
  --extensions js \
  --dry-run
```

If `wasBlocked` is non-empty for any env, inform the user:
> "`.js` files are blocked in `{envUrl}`. This will cause upload/deployment failures for Power Pages code sites. Remove the block? This modifies an environment-level security setting."

<!-- gate: setup-pipeline:4.4.blocked-attachments | category=consent | cancel-leaves=attachment-block-modified -->
> 🚦 **Gate (consent · setup-pipeline:4.4.blocked-attachments):** Modify env-level `blockedattachments` security setting (tenant-wide impact). Affects all users of the env, not just this skill. Reversible from PPAC. **Fires PER ENV that has blocks.** Phase 4.4 checks source + every target env; if M envs out of N have `.js` (or other media extensions) on the blocklist, the gate fires M times — once per env. Each env has its own security setting and its own group of affected makers. Yes for source does NOT cover staging; yes for staging does NOT cover production. **Do NOT batch consent across envs.**

Ask via `AskUserQuestion`: 1. Yes, remove block (recommended) / 2. Skip (I'll fix manually).

If approved, re-run **without** `--dry-run` to apply the change. If the user declines, record it as a warning — they'll need to fix it manually before deployment succeeds.

Report preflight results. If any critical check failed, stop with clear instructions. If warnings only, ask user to confirm before proceeding.

### Phase 5 — Register Environments with the Pipelines Host

Register each environment (source + targets) with the Pipelines host by creating a `deploymentenvironments` row in the host's Dataverse. This is a **metadata-only registration** — the row is a pointer to an existing BAP environment, not a provisioning call. The environments themselves must already exist in BAP. The host validates that the referenced env is reachable and the caller has the right access (`validationstatus` flips Pending → Succeeded). Process source env first, then targets.

Use `create-deployment-environment.js` for each environment (dev source + each target):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/create-deployment-environment.js" \
  --hostEnvUrl "{HOST_ENV_URL}" \
  --token "{HOST_TOKEN}" \
  --name "{siteName} {label}" \
  --bapEnvId "{BAP_ENV_GUID}" \
  --environmentType 200000000 \
  [--environmentUrl "{environmentUrl}"]
```

Required args (per `scripts/lib/create-deployment-environment.js`):
- `--bapEnvId` — the **BAP environment GUID** for the env being added. Resolve via `pac env list` (column `Environment ID`) or `pac env who` for the current source env. NOT the org/Dataverse URL.
- `--environmentType` — `200000000` for the dev/source env, `200000001` for each target env.
- `--environmentUrl` is optional and only echoed back into the output marker; it is not posted to Dataverse.

Capture stdout as JSON: `const envResult = JSON.parse(output)`.
Store `envResult.deploymentEnvironmentId` as `SOURCE_DEPLOYMENT_ENV_ID` (for the dev source env) or append to `TARGET_DEPLOYMENT_ENV_IDs` (for each target). Also retain the `bapEnvId` value used for each call — Phase 5a's force-link auto-fix needs it if creation lands in a Failed state.

> **Note**: The script POSTs to `deploymentenvironments` with **unprefixed** fields (`name`, `environmentid`, `environmenttype`), extracts the `deploymentenvironmentid` GUID from the `OData-EntityId` header, then polls `validationstatus` every 3 seconds (max 20 attempts) until status `200000001` (Succeeded) or `200000002` (Failed). On failure the script writes the error details to stderr and exits 1 — stop and report the error to the user. (The earlier `msdyn_`-prefixed field shape and `192350001`/`192350002` status codes were from an early-preview HAR; the shipped Pipelines schema rejects `msdyn_`-prefixed properties and uses the `2000000XX` codes.)

On failure: stop with the error — deployment environment creation is mandatory.

#### 5a — Detect "already associated with another pipelines host" (Pattern 15)

If the script's stderr (case-insensitively) contains any of these substrings, the BAP env is currently stamped to a different Pipelines host:

- `already associated with another pipelines host`
- `associated with another pipelines host`
- `environment is already linked to a different host`
- `environment is already bound to`
- `linked to another host`
- `claimed by another host`

Match all of these case-insensitively (`String.prototype.toLowerCase()` before `.includes()`) so backend wording drift between Pipelines package versions doesn't silently break detection. If none match but the script exited with the underlying Dataverse error code `0x80048d18` (or a wrapped `errormessage` containing that hex code), treat it as the same pattern — that's the stable signal even when the message wording shifts.

<!-- gate: setup-pipeline:5a.pattern-15 | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · setup-pipeline:5a.pattern-15):** Target env stamped to a different Pipelines host. Offer force-link as documented auto-fix — DESTRUCTIVE: previous host loses pipeline access for this env. Cancel here exits setup-pipeline cleanly. **Fires PER ENV that triggers Pattern 15.** Phase 5 loops over source + each target env when registering with the host; if two target envs both turn out to be stamped to different hosts, this gate fires twice — once per env. Do NOT batch the consent across envs; the destructive blast radius is per-env (each env carries its own previous-host stamp and its own group of makers losing access).

This is **Pattern 15** in `${CLAUDE_PLUGIN_ROOT}/references/deployment-error-catalog.md`. Do NOT silently retry. Surface the raw `errormessage` to the user verbatim and offer the documented auto-fix via `AskUserQuestion`:

```
question: "<envLabel> is already linked to a different Pipelines host. The /power-pages:force-link-environment skill can take over the association (DESTRUCTIVE to the previous host — makers there lose pipeline access for this env). Run it now?"
header: "Force Link?"
options:
  - "Run /power-pages:force-link-environment now (Recommended)" — auto-fix per the deployment error catalog
  - "Cancel setup-pipeline" — investigate the previous host first
```

Important guardrails:
- **Never invoke** `/power-pages:force-link-environment` without explicit user consent through this prompt — the action is reversible only by performing Force Link again from the previous host.
- If the user picks "Run …", invoke `/power-pages:force-link-environment` with `--host <HOST_ENV_URL>` and `--dev-env <bapEnvId>` (the BAP env GUID captured for this env in Phase 5 — see the "Also retain the `bapEnvId` value" note above) so the sub-skill skips its own host/env prompts.
- When that sub-skill returns success, **re-attempt just the failing environment by re-running `create-deployment-environment.js` with the same args** — do NOT restart Phase 5 wholesale. The create script is idempotent: it short-circuits via `findExistingByBapId` for envs already created (they return `reused: true`), and the previously-failing env will now resolve to Succeeded because the host stamp has moved.
- If the user picks "Cancel", stop the pipeline setup and recommend `/power-pages:ensure-pipelines-host detect-only` to inspect the current host bindings before retrying.

For any other create-deployment-environment failure, fall through to the generic "stop with the error" path above.

Report progress for each environment as validation completes.

### Phase 6 — Create Pipeline, Associate Source, Create Stages

Use `create-deployment-pipeline.js` to create the pipeline, associate the source environment, and create all stage records in one call:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/create-deployment-pipeline.js" \
  --hostEnvUrl "{HOST_ENV_URL}" \
  --token "{HOST_TOKEN}" \
  --pipelineName "{PIPELINE_NAME}" \
  --description "Power Pages deployment pipeline for {siteName}" \
  --sourceDeploymentEnvironmentId "{SOURCE_DEPLOYMENT_ENV_ID}" \
  --stagesJson '[{"name":"Deploy to {targetLabel}","targetDeploymentEnvironmentId":"{TARGET_DEPLOYMENT_ENV_ID}","order":1}]'
```
Capture stdout as JSON: `const pipelineResult = JSON.parse(output)`.
Extract:
- `pipelineResult.pipelineId` → store as `PIPELINE_ID`
- `pipelineResult.stages` → array of `{ stageId, name, targetDeploymentEnvironmentId }`

> **What the script does internally** (uses the **unprefixed** field schema — the earlier `msdyn_`-prefixed body was rejected by the shipped Pipelines schema; see the comment block at the top of `create-deployment-pipeline.js` for the full migration map):
> 1. POSTs `{ name, description }` to `deploymentpipelines` (v9.1) — extracts `deploymentpipelineid` from `OData-EntityId` header
> 2. POSTs a relative-path `@odata.id` body to `deploymentpipelines({pipelineId})/deploymentpipeline_deploymentenvironment/$ref` to associate the source environment (HAR-confirmed — no leading `/` or full URL)
> 3. For each stage: POSTs `{ name, deploymentpipelineid@odata.bind, targetdeploymentenvironmentid@odata.bind }` to `deploymentstages` — extracts `deploymentstagesid` from `OData-EntityId` header

On failure: the script writes the error to stderr and exits 1 — stop and report the error to the user.

### Phase 6b — Multi-solution deploymentOrder (only if `MULTI_SOLUTION_MODE = true`)

> **Design note (updated v1.3.x):** A single Power Platform Pipeline can deploy
> multiple solutions through separate stage runs — each run just specifies a
> different `artifactname` + `solutionid` on the same `deploymentstages` record.
> Creating one pipeline per solution was wasteful and cluttered the Pipelines
> UI. **We now create ONE pipeline + one stage per target env, and record the
> per-solution deployment order in `docs/alm/last-pipeline.json`**. `deploy-pipeline`
> then loops over the order, creating a stage run per solution against the same
> stage.

When the manifest is `schemaVersion: 2`, do **not** call `create-deployment-pipeline.js` multiple times. Instead:

1. Call `create-deployment-pipeline.js` **once** with:
   - `pipelineName = "{siteName}-Pipeline"` (e.g. `IdeaSphere-Pipeline`).
   - `description` listing the solutions that will deploy through it (e.g. `"Deploys IdeaSphere_Core → IdeaSphere_WebAssets → IdeaSphere_Future in order"`).
   - One `deploymentstages` record per target environment (not per solution).
2. Build the `deploymentOrder` array from `SOLUTIONS_LIST` sorted by `order`. Each entry has `{ solutionUniqueName, solutionId, order }`. Skip entries where `isFutureBuffer: true` AND `components.length === 0` — an empty Future solution has nothing to deploy; it's created by `setup-solution` but does not participate in the deployment loop until it has content. Keep it in the order array with `status: "SkippedEmpty"` so the renderer can show the intent.
3. Collect the single `pipelineId` and its `stages[]`. Persist `deploymentOrder` to `docs/alm/last-pipeline.json` (see Phase 7).

### Phase 7 — Verify, Write Artifacts, Commit

**7.1 Verify pipeline was created:**
```
GET {hostEnvUrl}/api/data/v9.1/deploymentpipelines({PIPELINE_ID})?$select=name,statecode
Authorization: Bearer {HOST_TOKEN}
```

Confirm `statecode = 0` (Active). If the query fails, report as "verification inconclusive — pipeline may still be valid".

**7.2 Write `docs/alm/last-pipeline.json`** (create the `docs/alm/` directory first if missing — `node -e "require('fs').mkdirSync('docs/alm',{recursive:true})"`):

```json
{
  "pipelineId": "{PIPELINE_ID}",
  "pipelineName": "{PIPELINE_NAME}",
  "hostEnvUrl": "{HOST_ENV_URL}",
  "sourceDeploymentEnvironmentId": "{SOURCE_DEPLOYMENT_ENV_ID}",
  "sourceEnvironmentUrl": "{devEnvUrl}",
  "solutionName": "{uniqueName}",
  "createdAt": "{ISO timestamp}",
  "stages": [
    {
      "stageId": "{deploymentstagesid}",
      "name": "Deploy to {targetLabel}",
      "rank": 1,
      "targetDeploymentEnvironmentId": "{TARGET_DEPLOYMENT_ENV_ID}",
      "targetEnvironmentUrl": "{targetEnvUrl}"
    }
  ]
}
```

**Multi-solution marker (manifest v2):** When `MULTI_SOLUTION_MODE = true`, `docs/alm/last-pipeline.json` uses `schemaVersion: 3` with a **single** pipeline and a `deploymentOrder[]` describing which solutions deploy through it, in what order:

```json
{
  "schemaVersion": 3,
  "pipelineId": "...",
  "pipelineName": "IdeaSphere-Pipeline",
  "hostEnvUrl": "{HOST_ENV_URL}",
  "sourceDeploymentEnvironmentId": "{SOURCE_DEPLOYMENT_ENV_ID}",
  "sourceEnvironmentUrl": "{devEnvUrl}",
  "createdAt": "{ISO timestamp}",
  "stages": [
    {
      "stageId": "...",
      "name": "Deploy to Staging",
      "rank": 1,
      "targetDeploymentEnvironmentId": "...",
      "targetEnvironmentUrl": "https://staging.crm.dynamics.com"
    }
  ],
  "deploymentOrder": [
    { "solutionUniqueName": "IdeaSphere_Core", "solutionId": "...", "order": 1 },
    { "solutionUniqueName": "IdeaSphere_WebAssets", "solutionId": "...", "order": 2 },
    { "solutionUniqueName": "IdeaSphere_Future", "solutionId": "...", "order": 3, "status": "SkippedEmpty", "isFutureBuffer": true }
  ]
}
```

<!-- gate: setup-pipeline:6b.v2-migration | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · setup-pipeline:6b.v2-migration):** v2 `pipelines[]` manifest detected on re-run. Pick: migrate to v3 (delete the N-1 extra pipelines and collapse to one) or keep the legacy layout.
>
> **Trigger:** Re-running setup-pipeline on a project whose `docs/alm/last-pipeline.json` is `schemaVersion: 2`.
> **Why we ask:** Auto-migrating deletes Dataverse pipeline records — destructive against host env state, irreversible without re-running setup-pipeline.
> **Cancel leaves:** Nothing — no pipeline records deleted yet.

> **Migration note:** Earlier versions of this skill used `schemaVersion: 2` with a `pipelines[]` array (one Dataverse pipeline record per solution). Projects pinned to v2 continue to work with the old `deploy-pipeline` MULTI_PIPELINE_MODE path; the v3 format should be used for all new setups. When re-running `setup-pipeline` on a v2 project, ask via `AskUserQuestion` whether to migrate (delete the N-1 extra pipelines and collapse to a single one) or keep the legacy layout.

**7.3 Write (or re-render) `docs/pipeline-setup.md`** (create `docs/` directory if needed).

Contents:
1. **Pipeline Created** — name, host env URL, pipeline ID
2. **Environments configured** — source + each target with their deployment environment IDs
3. **Solutions in deployment order** (multi-solution mode only) — for each entry in `solutionManifest.solutions[]`, list `{uniqueName, version, componentCount}`. Read `componentCount` from each entry's `components.length` if the manifest tracks it, otherwise from a live Dataverse query (`solutioncomponents?$filter=_solutionid_value eq '{solutionId}' and componenttype ne 380&$count=true`) — DO NOT hard-code or carry forward a stale count from a prior invocation.
4. **How to trigger a deployment** — Run `/power-pages:deploy-pipeline` or open Power Platform make.powerapps.com → Solutions → Pipelines
5. **Approval gates** (if applicable) — How to configure in Power Platform Admin Center
6. **Troubleshooting** — Common validation errors and how to resolve them

> **Sync-mode re-render**: when `setup-pipeline` is invoked on a project where `docs/alm/last-pipeline.json` ALREADY exists (re-run after `configure-env-variables`, `setup-solution` sync, or a follow-up env-var addition that bumped component counts), regenerate this file in full from current Dataverse state — do not patch in place. Validated failure: a Citizens portal `pipeline-setup.md` showed Foundation = 13 components while Dataverse had 15 after `configure-env-variables` added 2 env var definitions to that solution; the markdown never updated. The simplest safe behavior is "always re-render in Phase 7.3", because the operation reads current state directly and the file has no user-editable sections worth preserving.

**7.4 Commit:**
```bash
git add docs/alm/last-pipeline.json docs/pipeline-setup.md
git commit -m "Add Power Platform Pipeline configuration for {siteName}"
```

**7.5 Record skill usage:**

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "SetupPipeline"`.

**7.5b Refresh the ALM plan (if one exists):**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/refresh-alm-plan-data.js" \
  --projectRoot "." \
  --phase setup-pipeline \
  --render
```

The helper reads `docs/alm/last-host-check.json` + `docs/alm/last-pipeline.json`, refreshes `planData.hostResolution` and `planData.pipelineMeta`, drops pre-setup "no host detected" risks, and re-renders `docs/alm-plan.html`. When `docs/.alm-plan-data.json` is absent (standalone invocation, not part of an ALM plan), the helper returns `ok:false` as a soft no-op — safe to run unconditionally.

**Point the user at the next step (user-driven sequencing).** The helper's stdout JSON includes `nextStep: { name, skill: string | null } | null`. When non-null, branch on `skill`: when `skill` is non-null, tell the user *"Plan updated. Next in your plan: **{nextStep.name}** → run `{nextStep.skill}` when you're ready."*; when `skill` is `null` (an internal step such as Finalize, no user command), name the step only — *"Plan updated. Next in your plan: **{nextStep.name}**."* — and never print `run null`. When `null` (all steps done) or the helper returned `ok:false` (no plan), say nothing about a next step. **Never auto-invoke the next skill** — the user drives execution.

**7.6 Present summary:**

| Resource | ID / URL |
|---|---|
| Pipeline | `{PIPELINE_NAME}` (`{PIPELINE_ID}`) |
| Host environment | `{HOST_ENV_URL}` |
| Source deployment env | `{SOURCE_DEPLOYMENT_ENV_ID}` |
| Stage: {name} | `{stageId}` → `{targetEnvUrl}` |

**Files written:**
- `docs/alm/last-pipeline.json` — pipeline configuration marker
- `docs/pipeline-setup.md` — setup documentation

**Next step:**
> Run `/power-pages:deploy-pipeline` to trigger your first deployment run.

---

## Coming Soon Path

**If GitHub Actions or Azure DevOps was selected:**

Inform the user:

> "GitHub Actions and Azure DevOps Pipeline support are coming soon for this skill.
>
> **For now, you have two options:**
> 1. Use **Power Platform Pipelines** — select option 1 to set up Microsoft's native deployment pipeline (recommended)
> 2. Exit — I'll set up GitHub Actions / Azure DevOps manually using the documentation"

<!-- gate: setup-pipeline:coming-soon.exit | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · setup-pipeline:coming-soon.exit):** User selected GitHub/ADO (coming-soon stubs) — offer to switch back to PP Pipelines or exit cleanly.

Ask via `AskUserQuestion`:
1. Switch to Power Platform Pipelines — go back to Phase 2
2. Exit — I'll set up manually

If GitHub/ADO passed as argument: display above message and exit gracefully.

---

## Key Decision Points (Wait for User)

0. **Phase 1**: Existing pipeline file — overwrite, review, or cancel (only if `docs/alm/last-pipeline.json` found)
1. **Phase 2**: Platform selection (Power Platform Pipelines / GitHub coming soon / ADO coming soon)
2. **Phase 3**: Confirm pipeline configuration — pipeline name, host env URL, target environments
3. **Phase 4**: Preflight warnings — proceed or cancel
4. **Phase 3**: Parameter confirmation before pipeline creation

## Error Handling

- No `powerpages.config.json`: stop, advise `/power-pages:create-site`
- No `.solution-manifest.json`: stop, advise `/power-pages:setup-solution`
- `RetrieveSetting` returns empty: ask user for host environment URL manually
- Deployment environment `statecode = 1` with non-null `errormessage` (validation failed): stop with error details
- Pipeline `$ref` call fails: stop — this association is required before stages can be created
- Stage creation fails: record failure, continue with remaining stages — partial success is valid

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| Detect project context | Detecting project context | Read powerpages.config.json and .solution-manifest.json; run pac env who and pac env list; call RetrieveSetting to find host env; check for existing docs/alm/last-pipeline.json |
| Select CI/CD platform | Selecting CI/CD platform | Ask user: Power Platform Pipelines (full) or GitHub/ADO (coming soon) |
| Confirm pipeline configuration | Confirming pipeline configuration | Pre-fill pipeline name, source env, host env, solution name from auto-detected values; ask for target environments; get user confirmation |
| Run preflight checks | Running preflight checks | Verify host env has Pipelines installed; verify solution exists in dev env; check for pipeline name conflict |
| Create deployment environments | Creating deployment environments | POST deploymentenvironments for source + each target; poll validationstatus for each until Succeeded |
| Create pipeline and stages | Creating pipeline and stages | POST deploymentpipelines; $ref associate source env; POST deploymentstages for each target (linked via previousdeploymentstageid) |
| Verify and write artifacts | Verifying and writing artifacts | Query pipeline to confirm active; write docs/alm/last-pipeline.json; write docs/pipeline-setup.md; commit; present summary with next steps |
